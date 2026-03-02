import { type Bot, InlineKeyboard } from 'grammy';
import type { StatusData } from '../types/monitoring.js';
import { escapeHtml } from '../utils/text.js';

/**
 * StatusMessage manages a pinned status message per session topic,
 * updated in place via editMessageText with debouncing.
 *
 * Debounces updates to a minimum 3-second interval to avoid
 * Telegram API rate limits on editMessageText. Detects identical
 * content to skip unnecessary API calls.
 */
export class StatusMessage {
  private bot: Bot;
  private chatId: number;
  private threadId: number;

  private messageId: number = 0;
  private pendingData: StatusData | null = null;
  private lastSentText: string = '';
  private lastUpdateTime: number = 0;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private activeKeyboard: InlineKeyboard | undefined = undefined;

  /** Minimum milliseconds between editMessageText calls */
  private static readonly MIN_UPDATE_INTERVAL_MS = 3000;

  constructor(bot: Bot, chatId: number, threadId: number) {
    this.bot = bot;
    this.chatId = chatId;
    this.threadId = threadId;
  }

  /**
   * Send the initial status message to the topic and pin it.
   * Returns the message ID of the created status message.
   *
   * Pin failure is non-fatal (bot may lack pin rights).
   */
  async initialize(): Promise<number> {
    const initialData: StatusData = {
      contextPercent: 0,
      currentTool: 'Starting...',
      sessionDuration: '0m',
      toolCallCount: 0,
      filesChanged: 0,
      status: 'active',
    };

    const text = formatStatus(initialData);

    const msg = await this.bot.api.sendMessage(this.chatId, text, {
      message_thread_id: this.threadId,
    });
    this.messageId = msg.message_id;
    this.lastSentText = text;
    this.lastUpdateTime = Date.now();

    // Pin the message silently -- non-fatal if bot lacks pin rights
    try {
      await this.bot.api.pinChatMessage(this.chatId, this.messageId, {
        disable_notification: true,
      });
    } catch (err) {
      console.warn(
        'StatusMessage: failed to pin status message:',
        err instanceof Error ? err.message : err,
      );
    }

    return this.messageId;
  }

  /**
   * Request a status update with new data.
   *
   * If enough time has elapsed since the last update (>= 3 seconds),
   * flushes immediately. Otherwise, schedules a flush when the interval
   * elapses. Only one pending timer exists at a time.
   */
  requestUpdate(data: StatusData): void {
    this.pendingData = data;

    const elapsed = Date.now() - this.lastUpdateTime;
    if (elapsed >= StatusMessage.MIN_UPDATE_INTERVAL_MS) {
      void this.flush();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(
        () => void this.flush(),
        StatusMessage.MIN_UPDATE_INTERVAL_MS - elapsed,
      );
    }
  }

  /**
   * Set or clear the reply markup (inline keyboard) on the status message.
   * Used for the Stop button when a permission mode is active.
   */
  setKeyboard(keyboard: InlineKeyboard | undefined): void {
    this.activeKeyboard = keyboard;
    // Trigger an immediate flush if we have pending data, or force a re-send
    if (this.pendingData) {
      void this.flush();
    } else if (this.messageId && this.lastSentText) {
      // No pending text change, but need to update the reply_markup
      void this.bot.api.editMessageReplyMarkup(this.chatId, this.messageId, {
        reply_markup: keyboard ?? { inline_keyboard: [] },
      }).catch(err => {
        console.warn('StatusMessage: failed to update reply markup:', err instanceof Error ? err.message : err);
      });
    }
  }

  /**
   * Flush the pending status data to Telegram.
   *
   * Skips the API call if the formatted text is identical to the last
   * sent text (avoids "message is not modified" errors).
   * Catches and ignores "message is not modified" errors defensively.
   */
  private async flush(): Promise<void> {
    if (!this.pendingData || !this.messageId) return;

    const data = this.pendingData;
    this.pendingData = null;
    this.lastUpdateTime = Date.now();

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    const text = formatStatus(data);

    // Skip API call if content hasn't changed
    if (text === this.lastSentText) return;

    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: this.activeKeyboard ?? undefined,
      });
      this.lastSentText = text;
    } catch (err) {
      // Ignore "message is not modified" errors
      if (err instanceof Error && err.message.includes('message is not modified')) {
        return;
      }
      console.warn(
        'StatusMessage: failed to update status:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Update the forum topic name/description with a compact status string.
   * Topic names are limited to 128 characters by the Telegram API.
   * Failure is non-fatal.
   */
  async updateTopicDescription(description: string): Promise<void> {
    const truncated = description.length > 128
      ? description.slice(0, 125) + '...'
      : description;

    try {
      await this.bot.api.editForumTopic(this.chatId, this.threadId, {
        name: truncated,
      });
    } catch (err) {
      console.warn(
        'StatusMessage: failed to update topic description:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Clean up: clear any pending timer and send a final "Session ended" update.
   * The final update is best-effort (fire-and-forget).
   */
  destroy(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    // Send final "session ended" status, best-effort
    if (this.messageId) {
      const finalData: StatusData = {
        contextPercent: this.pendingData?.contextPercent ?? 0,
        currentTool: '-',
        sessionDuration: this.pendingData?.sessionDuration ?? '-',
        toolCallCount: this.pendingData?.toolCallCount ?? 0,
        filesChanged: this.pendingData?.filesChanged ?? 0,
        status: 'closed',
      };
      const text = formatStatus(finalData);
      if (text !== this.lastSentText) {
        void this.bot.api
          .editMessageText(this.chatId, this.messageId, text)
          .catch(() => {
            // Best-effort: ignore errors during shutdown
          });
      }
    }

    this.pendingData = null;
    this.activeKeyboard = undefined;
  }
}

/**
 * Format status data into a compact emoji status block for the pinned message.
 *
 * Format:
 *   🟢 Ctx: 45%
 *   🔧 Tool: Read
 *   ⏱️ 1h 30m | 42 calls | 8 files
 */
function formatStatus(data: StatusData): string {
  const statusEmoji =
    data.status === 'active'
      ? '\u{1F7E2}'   // green circle
      : data.status === 'idle'
        ? '\u{1F7E1}'  // yellow circle
        : '\u{1F534}';  // red circle

  return [
    `${statusEmoji} Ctx: ${data.contextPercent}%`,
    `\u{1F527} Tool: ${escapeHtml(data.currentTool)}`,
    `\u{23F1}\u{FE0F} ${escapeHtml(data.sessionDuration)} | ${data.toolCallCount} calls | ${data.filesChanged} files`,
  ].join('\n');
}
