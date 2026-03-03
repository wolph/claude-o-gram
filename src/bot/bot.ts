import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppConfig } from '../types/config.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { VerbosityTier } from '../types/monitoring.js';
import type { ApprovalManager } from '../control/approval-manager.js';
import type { InputRouter } from '../input/input-router.js';
import type { CommandRegistry } from './command-registry.js';
import type { PermissionModeManager } from '../control/permission-modes.js';
import {
  formatApprovalResult,
} from './formatter.js';
import { expandCache, cacheKey, buildExpandedHtml } from './expand-cache.js';
import type { RuntimeSettings } from '../settings/runtime-settings.js';

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
  inputRouter: InputRouter,
  commandRegistry: CommandRegistry,
  _permissionModeManager: PermissionModeManager,
  runtimeSettings: RuntimeSettings,
  onCleanupInactiveTopics?: () => Promise<number>,
  refreshSettings?: () => void,
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

  // --- Approval callback query handlers ---
  // NON-BLOCKING: Telegram buttons send keystrokes via tmux as a convenience.
  // Claude Code shows its local permission dialog; these buttons are shortcuts.

  // Handle Approve button taps — send "y" via tmux to approve locally
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const toolUseId = ctx.match[1];
    const pending = approvalManager.resolvePending(toolUseId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.', show_alert: true });
      // Clean up orphaned buttons — strip keyboard (don't modify text to avoid HTML issues)
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Best-effort: message may already be edited or too old
      }
      return;
    }

    // Check if tmux input is available
    const method = inputRouter.getMethod(pending.sessionId);
    if (method !== 'tmux') {
      // Can't send keystroke — tell user to approve locally
      // Put the pending back so PostToolUse can resolve it
      approvalManager.trackPending(toolUseId, pending.sessionId, pending.threadId, pending.messageId, pending.toolName, pending.originalHtml);
      await ctx.answerCallbackQuery({ text: 'No tmux pane — approve from your terminal', show_alert: true });
      return;
    }

    // Send "y" keystroke to approve in the local terminal
    const result = await inputRouter.send(pending.sessionId, 'y');
    if (result.status !== 'sent') {
      approvalManager.trackPending(toolUseId, pending.sessionId, pending.threadId, pending.messageId, pending.toolName, pending.originalHtml);
      await ctx.answerCallbackQuery({ text: `Failed: ${result.error}`, show_alert: true });
      return;
    }

    console.log(`[PERM] User approved ${toolUseId} via Telegram (tmux keystroke)`);
    await ctx.answerCallbackQuery();
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'User';
    const updatedText = formatApprovalResult('allow', who, pending.originalHtml);
    try {
      await ctx.editMessageText(updatedText, { parse_mode: 'HTML', reply_markup: undefined });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit approval message:', err instanceof Error ? err.message : err);
      }
    }
  });

  // Handle Deny button taps — send "n" via tmux to deny locally
  bot.callbackQuery(/^deny:(.+)$/, async (ctx) => {
    const toolUseId = ctx.match[1];
    const pending = approvalManager.resolvePending(toolUseId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.', show_alert: true });
      // Clean up orphaned buttons — strip keyboard (don't modify text to avoid HTML issues)
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Best-effort: message may already be edited or too old
      }
      return;
    }

    const method = inputRouter.getMethod(pending.sessionId);
    if (method !== 'tmux') {
      approvalManager.trackPending(toolUseId, pending.sessionId, pending.threadId, pending.messageId, pending.toolName, pending.originalHtml);
      await ctx.answerCallbackQuery({ text: 'No tmux pane — deny from your terminal', show_alert: true });
      return;
    }

    const result = await inputRouter.send(pending.sessionId, 'n');
    if (result.status !== 'sent') {
      approvalManager.trackPending(toolUseId, pending.sessionId, pending.threadId, pending.messageId, pending.toolName, pending.originalHtml);
      await ctx.answerCallbackQuery({ text: `Failed: ${result.error}`, show_alert: true });
      return;
    }

    console.log(`[PERM] User denied ${toolUseId} via Telegram (tmux keystroke)`);
    await ctx.answerCallbackQuery();
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'User';
    const updatedText = formatApprovalResult('deny', who, pending.originalHtml);
    try {
      await ctx.editMessageText(updatedText, { parse_mode: 'HTML', reply_markup: undefined });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit approval message:', err instanceof Error ? err.message : err);
      }
    }
  });

  // --- Phase 6: Expand/collapse callback query handlers ---

  // Handle Expand button taps
  bot.callbackQuery(/^exp:(\d+)$/, async (ctx) => {
    const messageId = parseInt(ctx.match[1]);
    const key = cacheKey(config.telegramChatId, messageId);
    const entry = expandCache.get(key);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Content no longer available', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery(); // dismiss loading spinner
    const expandedHtml = buildExpandedHtml(entry);
    const collapseKeyboard = new InlineKeyboard().text('\u25C2 Collapse', `col:${messageId}`);
    try {
      await ctx.editMessageText(expandedHtml, {
        parse_mode: 'HTML',
        reply_markup: collapseKeyboard,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to expand message:', err instanceof Error ? err.message : err);
      }
    }
  });

  // Handle Collapse button taps
  bot.callbackQuery(/^col:(\d+)$/, async (ctx) => {
    const messageId = parseInt(ctx.match[1]);
    const key = cacheKey(config.telegramChatId, messageId);
    const entry = expandCache.get(key);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Content no longer available', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const expandKeyboard = new InlineKeyboard().text('\u25B8 Expand', `exp:${messageId}`);
    try {
      await ctx.editMessageText(entry.compact, {
        parse_mode: 'HTML',
        reply_markup: expandKeyboard,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to collapse message:', err instanceof Error ? err.message : err);
      }
    }
  });

  // --- Phase 12: Settings callback query handlers ---

  /** Check if the user is authorized to change settings */
  function isSettingsAuthorized(ctx: Context): boolean {
    if (!config.botOwnerId) return true; // No owner configured -- allow all
    return ctx.from?.id === config.botOwnerId;
  }

  // Sub-agent visibility toggle
  bot.callbackQuery(/^set_sa:(.+)$/, async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({
        text: 'Only the bot owner can change settings',
        show_alert: true,
      });
      return;
    }
    // Toggle sub-agent visibility
    runtimeSettings.subagentOutput = !runtimeSettings.subagentOutput;
    console.log(`[SETTINGS] Sub-agent output: ${runtimeSettings.subagentOutput ? 'visible' : 'hidden'}`);
    await ctx.answerCallbackQuery();
    refreshSettings?.();
  });

  // Default permission mode selection
  bot.callbackQuery(/^set_pm:(.+)$/, async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({
        text: 'Only the bot owner can change settings',
        show_alert: true,
      });
      return;
    }
    const newMode = ctx.match[1];
    const validModes = ['manual', 'safe-only', 'accept-all', 'until-done'];
    if (!validModes.includes(newMode)) {
      await ctx.answerCallbackQuery({ text: 'Unknown mode', show_alert: true });
      return;
    }
    runtimeSettings.defaultPermissionMode = newMode;
    console.log(`[SETTINGS] Default permission mode: ${newMode}`);
    await ctx.answerCallbackQuery();
    refreshSettings?.();
  });

  // Inactive topics cleanup
  bot.callbackQuery('set_rm:inactive', async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({
        text: 'Only the bot owner can change settings',
        show_alert: true,
      });
      return;
    }
    if (!onCleanupInactiveTopics) {
      await ctx.answerCallbackQuery({ text: 'Cleanup not available', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Removing inactive topics...' });
    const removed = await onCleanupInactiveTopics();
    console.log(`[SETTINGS] Removed ${removed} inactive topic(s)`);
    refreshSettings?.();
  });

  // --- CLI command forwarding (catch-all for non-bot-native commands) ---
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text.startsWith('/')) return next(); // Not a command, pass to text handler

    const threadId = ctx.message.message_thread_id;
    if (!threadId) return next(); // Not in a forum topic

    // Phase 12: Ignore commands in settings topic
    if (threadId === runtimeSettings.settingsTopicId) return next();

    const session = sessionStore.getByThreadId(threadId);
    if (!session || session.status !== 'active') return next();

    // Parse command: "/gsd_progress args" or "/gsd_progress@botname args"
    const match = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/);
    if (!match) return next();

    const [, tgCommand, args] = match;

    // Skip bot-native commands (already handled by bot.command() above)
    if (commandRegistry.isBotNative(tgCommand)) return next();

    // Reverse-map to Claude name
    const claudeName = commandRegistry.toClaudeName(tgCommand);
    const cliCommand = claudeName
      ? `/${claudeName}${args ? ' ' + args : ''}`
      : `/${tgCommand}${args ? ' ' + args : ''}`;

    const result = await inputRouter.send(session.sessionId, cliCommand);

    if (result.status === 'sent') {
      try {
        await ctx.react('\u26A1');
      } catch {
        // Reaction not supported
      }
    } else {
      await ctx.reply(
        `\u274C Failed to send command: ${result.error}`,
        { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
      );
    }
  });

  // --- Text input handler (tmux / FIFO / SDK resume) ---

  // Listen for text messages in forum topics.
  // Routes input to the appropriate sender for the session.
  bot.on('message:text', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (!threadId) return; // Not in a forum topic

    // Phase 12: Ignore text messages in settings topic
    if (threadId === runtimeSettings.settingsTopicId) return;

    // Find session for this topic
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return; // Not a managed session topic
    if (session.status !== 'active') return; // Session is closed

    // Build input text, including quoted message context if replying to a specific message
    let text = ctx.message.text;
    const replied = ctx.message.reply_to_message;
    if (replied && 'text' in replied && replied.text) {
      text = `[Quoting: "${replied.text}"]\n\n${text}`;
    }

    const result = await inputRouter.send(session.sessionId, text);

    if (result.status === 'sent') {
      try {
        await ctx.react('\u26A1');
      } catch {
        // Reaction not supported -- ignore
      }
    } else {
      await ctx.reply(
        `\u274C Failed to send input: ${result.error}`,
        { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
      );
    }
  });

  // Global error handler -- prevent unhandled errors from crashing the bot
  bot.catch((err) => {
    console.error('Bot error:', err.message || err);
  });

  return bot;
}

/**
 * Create an InlineKeyboard with Approve/Deny buttons.
 * These send keystrokes via tmux as a convenience — Claude Code
 * shows its local permission dialog as the primary approval method.
 */
export function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u2705 Accept', `approve:${toolUseId}`)
    .text('\u274C Deny', `deny:${toolUseId}`);
}
