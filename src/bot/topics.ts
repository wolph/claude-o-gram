import { Bot, InputFile, InlineKeyboard } from 'grammy';
import type { BotContext } from './bot.js';
import { STATUS_EMOJIS } from '../monitoring/topic-status.js';

/**
 * Forum topic lifecycle management for Telegram supergroups.
 *
 * Handles creating, closing, reopening, renaming topics,
 * sending messages and file attachments to specific topics.
 * Status emoji prefixes are managed by TopicStatusManager (Phase 9).
 */
export class TopicManager {
  private bot: Bot<BotContext>;
  private chatId: number;

  constructor(bot: Bot<BotContext>, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /**
   * Create a new forum topic.
   * Status emoji prefix is set by TopicStatusManager after creation.
   * @returns The message_thread_id for the created topic.
   */
  async createTopic(name: string): Promise<number> {
    try {
      const topic = await this.bot.api.createForumTopic(
        this.chatId,
        name,
      );
      return topic.message_thread_id;
    } catch (error) {
      console.error('Failed to create forum topic:', error);
      throw error;
    }
  }

  /** Delete a forum topic permanently. Best-effort: logs errors. */
  async deleteTopic(threadId: number): Promise<boolean> {
    try {
      await this.bot.api.deleteForumTopic(this.chatId, threadId);
      return true;
    } catch (err) {
      console.warn('Failed to delete forum topic:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Close a topic with done status emoji.
   * Uses shared STATUS_EMOJIS.done constant for the checkmark prefix.
   * Best-effort: logs errors but does not throw.
   */
  async closeTopic(threadId: number, topicName: string): Promise<void> {
    try {
      await this.bot.api.editForumTopic(this.chatId, threadId, {
        name: STATUS_EMOJIS.done + ' ' + topicName + ' (done)',
      });
      await this.bot.api.closeForumTopic(this.chatId, threadId);
    } catch (error) {
      console.error('Failed to close forum topic:', error);
    }
  }

  /**
   * Reopen a closed topic.
   * Status emoji is set by TopicStatusManager after reopen.
   */
  async reopenTopic(threadId: number, _topicName: string): Promise<void> {
    await this.bot.api.reopenForumTopic(this.chatId, threadId);
  }

  /**
   * Rename a topic (e.g., when user runs /rename in Claude Code).
   * Sets plain name without emoji -- TopicStatusManager handles the prefix.
   */
  async renameTopic(threadId: number, newName: string): Promise<void> {
    await this.bot.api.editForumTopic(this.chatId, threadId, {
      name: newName,
    });
  }

  /**
   * Send an HTML-formatted message to a specific topic.
   * If the message exceeds 4096 chars, it is truncated to 4000 with a suffix.
   * parse_mode is set globally by the parseMode plugin.
   */
  async sendMessage(threadId: number, html: string, notify = false): Promise<void> {
    let text = html;
    if (text.length > 4096) {
      text = text.slice(0, 4000) + '\n... (truncated)';
    }
    await this.bot.api.sendMessage(this.chatId, text, {
      message_thread_id: threadId,
      disable_notification: !notify,
    });
  }

  /**
   * Send a file attachment to a specific topic.
   * Used for long outputs that exceed Telegram's 4096 char limit (UX-02).
   */
  async sendDocument(
    threadId: number,
    content: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    const buffer = Buffer.from(content, 'utf-8');
    await this.bot.api.sendDocument(
      this.chatId,
      new InputFile(buffer, filename),
      {
        message_thread_id: threadId,
        caption: caption || '',
        parse_mode: 'HTML',
        disable_notification: true,
      },
    );
  }

  /**
   * Send an HTML-formatted message to a specific topic and return the message_id.
   * Unlike sendMessage (which returns void), this is used when the caller needs
   * the message ID (e.g., for status message creation and pinning).
   */
  async sendMessageRaw(threadId: number, html: string): Promise<number> {
    let text = html;
    if (text.length > 4096) {
      text = text.slice(0, 4000) + '\n... (truncated)';
    }
    const msg = await this.bot.api.sendMessage(this.chatId, text, {
      message_thread_id: threadId,
      disable_notification: true,
    });
    return msg.message_id;
  }

  /**
   * Send an HTML message with an InlineKeyboard to a specific topic.
   * Returns the message_id for cache keying (e.g., expand/collapse buttons).
   */
  async sendMessageWithKeyboard(
    threadId: number,
    html: string,
    keyboard: InlineKeyboard,
  ): Promise<number> {
    let text = html;
    if (text.length > 4096) {
      text = text.slice(0, 4000) + '\n... (truncated)';
    }
    const msg = await this.bot.api.sendMessage(this.chatId, text, {
      message_thread_id: threadId,
      disable_notification: true,
      reply_markup: keyboard,
    });
    return msg.message_id;
  }

  /**
   * Unpin a specific message in the chat.
   * Non-fatal: logs warning on failure.
   */
  async unpinMessage(messageId: number): Promise<void> {
    try {
      await this.bot.api.unpinChatMessage(this.chatId, messageId);
    } catch (err) {
      console.warn('Failed to unpin message:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Edit an existing message in place.
   * Silently ignores "message is not modified" errors (Pitfall 2).
   */
  async editMessage(messageId: number, html: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(this.chatId, messageId, html);
    } catch (err) {
      // Ignore "message is not modified" errors (Pitfall 2)
      if (err instanceof Error && err.message.includes('message is not modified')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Pin a message in the chat. Non-fatal: bot may lack pin rights (Pitfall 5).
   */
  async pinMessage(messageId: number): Promise<void> {
    try {
      await this.bot.api.pinChatMessage(this.chatId, messageId, {
        disable_notification: true,
      });
    } catch (err) {
      // Non-fatal: bot may lack pin rights (Pitfall 5)
      console.warn('Failed to pin message:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Edit a forum topic's name. Topic name limited to 128 chars.
   * Non-fatal on error.
   */
  async editTopicName(threadId: number, name: string): Promise<void> {
    try {
      // Topic name limited to 128 chars
      const truncated = name.length > 128 ? name.slice(0, 128) : name;
      await this.bot.api.editForumTopic(this.chatId, threadId, { name: truncated });
    } catch (err) {
      console.warn('Failed to edit topic name:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Post a bot restart notification to an active topic.
   * Used when the bot reconnects after a restart.
   */
  async sendBotRestartNotice(threadId: number): Promise<void> {
    await this.sendMessage(
      threadId,
      '\u{1F504} <b>Bot reconnected</b>',
    );
  }
}
