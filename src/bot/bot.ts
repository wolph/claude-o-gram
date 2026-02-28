import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppConfig } from '../types/config.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { VerbosityTier } from '../types/monitoring.js';
import type { ApprovalManager } from '../control/approval-manager.js';
import type { TextInputManager } from '../control/input-manager.js';
import {
  formatApprovalResult,
  formatApprovalExpired,
} from './formatter.js';

/** Bot context type alias for use across the bot module */
export type BotContext = Context;

/**
 * Create and configure the grammY bot instance with plugins.
 *
 * Layer 1 rate limiting (per research Pattern 3):
 * - auto-retry: transparently handles 429 flood wait responses
 * - transformer-throttler: Bottleneck-based queue for API request throttling
 * - Default HTML parse mode set via API transformer
 *
 * Does NOT call bot.start() -- that happens in the entry point.
 */
export async function createBot(
  config: AppConfig,
  sessionStore: SessionStore,
  approvalManager: ApprovalManager,
  inputManager: TextInputManager,
): Promise<Bot<BotContext>> {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  // Layer 1 rate limiting: grammY API-level protection
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  bot.api.config.use(apiThrottler());

  // Set default parse_mode to HTML via API transformer
  // @grammyjs/parse-mode v2 no longer exports a parseMode transformer,
  // so we implement a simple one that injects parse_mode into all applicable API calls.
  bot.api.config.use((prev, method, payload, signal) => {
    const htmlMethods = new Set([
      'sendMessage',
      'editMessageText',
      'sendPhoto',
      'sendVideo',
      'sendAnimation',
      'sendDocument',
      'sendAudio',
      'sendVoice',
    ]);
    if (htmlMethods.has(method)) {
      const p = payload as Record<string, unknown>;
      if (!p.parse_mode) {
        p.parse_mode = 'HTML';
      }
    }
    return prev(method, payload, signal);
  });

  // Register /status command handler
  bot.command('status', async (ctx) => {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const uptimeStr =
      hours > 0
        ? `${hours}h ${minutes}m ${seconds}s`
        : minutes > 0
          ? `${minutes}m ${seconds}s`
          : `${seconds}s`;

    const activeCount = sessionStore.getActiveSessions().length;

    await ctx.reply(
      `<b>Bot Status</b>\n\n` +
        `Uptime: <code>${uptimeStr}</code>\n` +
        `Active sessions: <code>${activeCount}</code>`,
    );
  });

  // Register verbosity commands (per-session override via Telegram)
  bot.command('verbose', async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return;
    sessionStore.updateVerbosity(session.sessionId, 'verbose');
    await ctx.reply('Verbosity set to <b>verbose</b> -- showing all tool calls');
  });

  bot.command('normal', async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return;
    sessionStore.updateVerbosity(session.sessionId, 'normal');
    await ctx.reply('Verbosity set to <b>normal</b> -- hiding Read/Glob/Grep calls');
  });

  bot.command('quiet', async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return;
    sessionStore.updateVerbosity(session.sessionId, 'minimal');
    await ctx.reply('Verbosity set to <b>quiet</b> -- showing edits and bash only');
  });

  // --- Phase 3: Approval callback query handlers ---

  // Handle Approve button taps
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const toolUseId = ctx.match[1];
    const pending = approvalManager.decide(toolUseId, 'allow');
    if (pending) {
      await ctx.answerCallbackQuery(); // Dismiss loading spinner
      const who = ctx.from?.username
        ? `@${ctx.from.username}`
        : ctx.from?.first_name || 'User';
      const originalText = ctx.callbackQuery.message?.text || '';
      const updatedText = formatApprovalResult('allow', who, originalText);
      try {
        await ctx.editMessageText(updatedText, {
          parse_mode: 'HTML',
          reply_markup: undefined, // Remove inline keyboard
        });
      } catch (err) {
        // Ignore "message is not modified" errors
        if (!(err instanceof Error && err.message.includes('message is not modified'))) {
          console.warn('Failed to edit approval message:', err instanceof Error ? err.message : err);
        }
      }
    } else {
      // Approval already resolved (timeout or duplicate tap) — show alert
      await ctx.answerCallbackQuery({
        text: 'This approval has already expired.',
        show_alert: true,
      });
    }
  });

  // Handle Deny button taps
  bot.callbackQuery(/^deny:(.+)$/, async (ctx) => {
    const toolUseId = ctx.match[1];
    const pending = approvalManager.decide(toolUseId, 'deny');
    if (pending) {
      await ctx.answerCallbackQuery(); // Dismiss loading spinner
      const who = ctx.from?.username
        ? `@${ctx.from.username}`
        : ctx.from?.first_name || 'User';
      const originalText = ctx.callbackQuery.message?.text || '';
      const updatedText = formatApprovalResult('deny', who, originalText);
      try {
        await ctx.editMessageText(updatedText, {
          parse_mode: 'HTML',
          reply_markup: undefined,
        });
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('message is not modified'))) {
          console.warn('Failed to edit approval message:', err instanceof Error ? err.message : err);
        }
      }
    } else {
      // Approval already resolved (timeout or duplicate tap) — show alert
      await ctx.answerCallbackQuery({
        text: 'This approval has already expired.',
        show_alert: true,
      });
    }
  });

  // --- Phase 3: Text input handler ---

  // Listen for text messages in forum topics.
  // When user replies in a session topic, feed text to Claude Code via TextInputManager.
  bot.on('message:text', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (!threadId) return; // Not in a forum topic

    // Find session for this topic
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return; // Not a managed session topic
    if (session.status !== 'active') return; // Session is closed

    // Skip bot commands (handled by command handlers above)
    if (ctx.message.text.startsWith('/')) return;

    const text = ctx.message.text;
    const result = inputManager.send(session.tmuxPane, session.sessionId, text);

    switch (result) {
      case 'sent':
        await ctx.reply('\u2705 Input sent', {
          message_thread_id: threadId,
          reply_to_message_id: ctx.message.message_id,
        });
        break;
      case 'queued': {
        const queueSize = inputManager.queueSize(session.sessionId);
        if (!session.tmuxPane) {
          await ctx.reply(
            `\u{1F4E5} Input queued (${queueSize} pending) \u2014 delivery requires Claude Code to be running in tmux`,
            { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
          );
        } else {
          await ctx.reply(
            `\u{1F4E5} Input queued (${queueSize} pending) \u2014 will deliver when possible`,
            { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
          );
        }
        break;
      }
      case 'failed':
        await ctx.reply(
          '\u274C Failed to send input. Check bot logs for details.',
          { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
        );
        break;
    }
  });

  return bot;
}

/**
 * Create an InlineKeyboard with Approve and Deny buttons.
 * callback_data format: "approve:{toolUseId}" / "deny:{toolUseId}"
 * tool_use_id is a UUID (36 chars), prefix is 8 chars = 44 bytes total (within 64 byte limit).
 */
export function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u2705 Approve', `approve:${toolUseId}`)
    .text('\u274C Deny', `deny:${toolUseId}`);
}
