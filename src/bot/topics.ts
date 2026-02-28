import { Bot, InputFile } from 'grammy';
import type { BotContext } from './bot.js';

/**
 * Forum topic lifecycle management for Telegram supergroups.
 *
 * Handles creating, closing, reopening, renaming topics,
 * sending messages and file attachments to specific topics.
 * Uses status emojis per user decisions.
 */
export class TopicManager {
  private bot: Bot<BotContext>;
  private chatId: number;

  constructor(bot: Bot<BotContext>, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /**
   * Create a new forum topic with active status emoji.
   * @returns The message_thread_id for the created topic.
   */
  async createTopic(name: string): Promise<number> {
    try {
      const topic = await this.bot.api.createForumTopic(
        this.chatId,
        '\u{1F7E2} ' + name,
      );
      return topic.message_thread_id;
    } catch (error) {
      console.error('Failed to create forum topic:', error);
      throw error;
    }
  }

  /**
   * Close a topic with done status emoji.
   * Best-effort: logs errors but does not throw.
   */
  async closeTopic(threadId: number, topicName: string): Promise<void> {
    try {
      await this.bot.api.editForumTopic(this.chatId, threadId, {
        name: '\u2705 ' + topicName + ' (done)',
      });
      await this.bot.api.closeForumTopic(this.chatId, threadId);
    } catch (error) {
      console.error('Failed to close forum topic:', error);
    }
  }

  /**
   * Reopen a closed topic and restore active status emoji.
   * Used when a session resumes.
   */
  async reopenTopic(threadId: number, topicName: string): Promise<void> {
    await this.bot.api.reopenForumTopic(this.chatId, threadId);
    await this.bot.api.editForumTopic(this.chatId, threadId, {
      name: '\u{1F7E2} ' + topicName,
    });
  }

  /**
   * Rename a topic (e.g., when user runs /rename in Claude Code).
   * Preserves the active status emoji prefix.
   */
  async renameTopic(threadId: number, newName: string): Promise<void> {
    await this.bot.api.editForumTopic(this.chatId, threadId, {
      name: '\u{1F7E2} ' + newName,
    });
  }

  /**
   * Send an HTML-formatted message to a specific topic.
   * If the message exceeds 4096 chars, it is truncated to 4000 with a suffix.
   * parse_mode is set globally by the parseMode plugin.
   */
  async sendMessage(threadId: number, html: string): Promise<void> {
    let text = html;
    if (text.length > 4096) {
      text = text.slice(0, 4000) + '\n... (truncated)';
    }
    await this.bot.api.sendMessage(this.chatId, text, {
      message_thread_id: threadId,
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
      },
    );
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
