import { type Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot/bot.js';
import type { RuntimeSettings } from './runtime-settings.js';

/**
 * Format the settings message text showing current setting values.
 * Uses emoji indicators for visual clarity (green/red circles).
 */
export function formatSettingsMessage(subagentVisible: boolean, defaultMode: string): string {
  const saStatus = subagentVisible ? '\u{1F7E2} Visible' : '\u{1F534} Hidden';
  const modeLabels: Record<string, string> = {
    'manual': 'Manual',
    'safe-only': 'Safe Only',
    'accept-all': 'Accept All',
    'until-done': 'Until Done',
  };
  return [
    '<b>\u2699\uFE0F Settings</b>',
    '',
    `Sub-agents: ${saStatus}`,
    `Default permission mode: ${modeLabels[defaultMode] || 'Manual'}`,
  ].join('\n');
}

/**
 * Build the inline keyboard for the settings message.
 * Sub-agent toggle on first row, permission mode buttons on second row.
 * Active mode is highlighted with a bullet marker.
 */
export function buildSettingsKeyboard(subagentVisible: boolean, defaultMode: string): InlineKeyboard {
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

  constructor(bot: Bot<BotContext>, chatId: number, runtimeSettings: RuntimeSettings) {
    this.bot = bot;
    this.chatId = chatId;
    this.runtimeSettings = runtimeSettings;
  }

  /**
   * Initialize the settings topic: create or reopen, send or edit the
   * settings message, pin it. Returns the threadId of the settings topic.
   *
   * Called at bot startup BEFORE bot.start().
   */
  async init(): Promise<number> {
    let threadId = this.runtimeSettings.settingsTopicId;

    // Try to reopen existing topic
    if (threadId > 0) {
      try {
        await this.bot.api.reopenForumTopic(this.chatId, threadId);
      } catch (err) {
        // Topic may have been deleted -- fall through to create new
        console.warn('Settings topic reopen failed, creating new:', err instanceof Error ? err.message : err);
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
    const text = formatSettingsMessage(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
    );
    const keyboard = buildSettingsKeyboard(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
    );

    let messageId = this.runtimeSettings.settingsMessageId;
    if (messageId > 0) {
      // Try to edit existing message
      try {
        await this.bot.api.editMessageText(this.chatId, messageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch {
        // Message may have been deleted -- send new
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
   * Refresh the settings message in-place after a toggle.
   * Edits both the text content and the inline keyboard.
   */
  async refresh(): Promise<void> {
    const messageId = this.runtimeSettings.settingsMessageId;
    if (messageId === 0) return;

    const text = formatSettingsMessage(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
    );
    const keyboard = buildSettingsKeyboard(
      this.runtimeSettings.subagentOutput,
      this.runtimeSettings.defaultPermissionMode,
    );

    try {
      await this.bot.api.editMessageText(this.chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to refresh settings message:', err instanceof Error ? err.message : err);
      }
    }
  }
}
