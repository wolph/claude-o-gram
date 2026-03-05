import { type Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot/bot.js';
import type { RuntimeSettings } from './runtime-settings.js';

/**
 * Format the settings message text showing current setting values.
 * Uses emoji indicators for visual clarity (green/red circles).
 */
export function formatSettingsMessage(subagentVisible: boolean, defaultMode: string, inactiveCount = 0): string {
  const saStatus = subagentVisible ? '\u{1F7E2} Visible' : '\u{1F534} Hidden';
  const modeLabels: Record<string, string> = {
    'manual': 'Manual',
    'safe-only': 'Safe Only',
    'accept-all': 'Accept All',
    'until-done': 'Until Done',
  };
  const lines = [
    '<b>\u2699\uFE0F Settings</b>',
    '',
    `Sub-agents: ${saStatus}`,
    `Default permission mode: ${modeLabels[defaultMode] || 'Manual'}`,
  ];
  if (inactiveCount > 0) {
    lines.push(`Inactive topics: ${inactiveCount}`);
  }
  return lines.join('\n');
}

/**
 * Build the inline keyboard for the settings message.
 * Sub-agent toggle on first row, permission mode buttons on second row.
 * Active mode is highlighted with a bullet marker.
 */
export function buildSettingsKeyboard(subagentVisible: boolean, defaultMode: string, inactiveCount = 0): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Sub-agent visibility toggle
  kb.text(
    subagentVisible ? '\u{1F7E2} Sub-agents: Visible' : '\u{1F534} Sub-agents: Hidden',
    'set_sa:toggle',
  );
  kb.row();
  // Permission mode buttons -- highlight the active one with a bullet marker
  const modes: Array<{ label: string; value: string }> = [
    { label: 'Manual', value: 'manual' },
    { label: 'Safe Only', value: 'safe-only' },
    { label: 'Accept All', value: 'accept-all' },
    { label: 'Until Done', value: 'until-done' },
  ];
  for (const m of modes) {
    const isActive = m.value === defaultMode;
    kb.text(isActive ? `\u25CF ${m.label}` : m.label, `set_pm:${m.value}`);
  }
  // Inactive topics cleanup button (only when there are inactive topics)
  if (inactiveCount > 0) {
    kb.row();
    kb.text(`\u{1F5D1} Remove ${inactiveCount} inactive topic${inactiveCount === 1 ? '' : 's'}`, 'set_rm:inactive');
  }
  // Bulk cleanup button for orphaned approval buttons
  kb.row();
  kb.text('\u{1F9F9} Clean old approval buttons', 'set_rm:buttons');
  return kb;
}

/**
 * Manages the Settings topic lifecycle in Telegram.
 *
 * Creates or reopens the settings topic at startup, sends and pins the
 * settings message with inline keyboard, and refreshes the message
 * when settings are toggled.
 */
export class SettingsTopic {
  private bot: Bot<BotContext>;
  private chatId: number;
  private runtimeSettings: RuntimeSettings;
  private getInactiveCount: () => number;
  private lastText = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static DEBOUNCE_MS = 300;

  constructor(bot: Bot<BotContext>, chatId: number, runtimeSettings: RuntimeSettings, getInactiveCount: () => number = () => 0) {
    this.bot = bot;
    this.chatId = chatId;
    this.runtimeSettings = runtimeSettings;
    this.getInactiveCount = getInactiveCount;
  }

  /**
   * Initialize the settings topic: create or reopen, send or edit the
   * settings message, pin it. Returns the threadId of the settings topic.
   *
   * Called at bot startup BEFORE bot.start().
   */
  async init(): Promise<number> {
    let threadId = this.runtimeSettings.settingsTopicId;

    // Try to reopen existing topic (with retry for transient errors)
    if (threadId > 0) {
      let shouldRecreate = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.bot.api.reopenForumTopic(this.chatId, threadId);
          break; // Success
        } catch (err) {
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          if (msg.includes('not modified') || msg.includes('not_modified')) {
            break; // Already open — fine
          }
          if (msg.includes('not found') || msg.includes('not_found')) {
            shouldRecreate = true;
            break; // Permanent: topic is gone
          }
          // Transient error — retry once
          if (attempt === 1) {
            console.warn('Settings topic reopen failed after retry, assuming still valid:', msg);
          }
        }
      }
      if (shouldRecreate) {
        threadId = 0;
      }
    }

    // Create new topic if needed
    if (threadId === 0) {
      const topic = await this.bot.api.createForumTopic(this.chatId, '\u2699\uFE0F Settings');
      threadId = topic.message_thread_id;
      this.runtimeSettings.settingsTopicId = threadId;
      this.runtimeSettings.settingsMessageId = 0; // Reset message ID for new topic
    }

    // Send or update the settings message
    const inactiveCount = this.getInactiveCount();
    const text = formatSettingsMessage(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
      inactiveCount,
    );
    const keyboard = buildSettingsKeyboard(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
      inactiveCount,
    );

    let messageId = this.runtimeSettings.settingsMessageId;
    if (messageId > 0) {
      // Try to edit existing message
      try {
        await this.bot.api.editMessageText(this.chatId, messageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        this.lastText = text;
      } catch {
        // Message may have been deleted or is in a different topic — try to clean it up
        try {
          await this.bot.api.deleteMessage(this.chatId, messageId);
        } catch {
          // Already gone — fine
        }
        messageId = 0;
      }
    }

    if (messageId === 0) {
      // Send new settings message
      const msg = await this.bot.api.sendMessage(this.chatId, text, {
        message_thread_id: threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      messageId = msg.message_id;
      this.runtimeSettings.settingsMessageId = messageId;
      this.lastText = text;

      // Pin the settings message silently
      try {
        await this.bot.api.pinChatMessage(this.chatId, messageId, {
          disable_notification: true,
        });
      } catch (err) {
        console.warn('Failed to pin settings message:', err instanceof Error ? err.message : err);
      }
    }

    return threadId;
  }

  /**
   * Debounced refresh: collapses rapid successive calls into one API edit.
   * Use this from callback handlers instead of refresh() directly.
   */
  requestRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, SettingsTopic.DEBOUNCE_MS);
  }

  /**
   * Refresh the settings message in-place after a toggle.
   * Skips the API call if the text hasn't changed (dedup).
   */
  async refresh(): Promise<void> {
    const messageId = this.runtimeSettings.settingsMessageId;
    if (messageId === 0) return;

    const inactiveCount = this.getInactiveCount();
    const text = formatSettingsMessage(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
      inactiveCount,
    );

    // Skip if text hasn't changed (keyboard is derived from the same values)
    if (text === this.lastText) return;

    const keyboard = buildSettingsKeyboard(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
      inactiveCount,
    );

    try {
      await this.bot.api.editMessageText(this.chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      this.lastText = text;
    } catch (err) {
      if (err instanceof Error && err.message.includes('message is not modified')) {
        this.lastText = text; // Sync cache
      } else {
        console.warn('Failed to refresh settings message:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** Cancel pending debounce timer on shutdown */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
