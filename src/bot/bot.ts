import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppConfig } from '../types/config.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ApprovalManager } from '../control/approval-manager.js';
import type { InputRouter } from '../input/input-router.js';
import type { CommandRegistry } from './command-registry.js';
import type { PermissionModeManager } from '../control/permission-modes.js';
import {
  formatApprovalResult,
} from './formatter.js';
import { expandCache, cacheKey, buildExpandedHtml } from './expand-cache.js';
import { escapeHtml } from '../utils/text.js';
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
  onCleanupOldButtons?: () => Promise<number>,
): Promise<Bot<BotContext>> {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  // Layer 1 rate limiting: grammY API-level protection
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  bot.api.config.use(apiThrottler());

  // SECURITY: Global middleware — only the bot owner can interact with the bot.
  // This gates ALL commands, callback queries, text messages, and any other updates.
  // Silently drops updates from unauthorized users (no error reply to avoid leaking info).
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.botOwnerId) {
      return; // Silently drop — unauthorized user
    }
    return next();
  });

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
      // Note: must pass an empty inline_keyboard array, NOT undefined.
      // grammY's JSON serializer strips undefined values, so reply_markup: undefined
      // results in the field being omitted from the request entirely, which tells
      // Telegram "don't change the markup" rather than "remove the markup".
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
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
      // See approve handler above for why { inline_keyboard: [] } is needed instead of undefined.
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
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

  /** Check if the user is authorized to change settings (defense-in-depth; global middleware already blocks) */
  function isSettingsAuthorized(ctx: Context): boolean {
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

  // Bulk cleanup: remove orphaned approval buttons by brute-force ID range
  bot.callbackQuery('set_rm:buttons', async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({
        text: 'Only the bot owner can change settings',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Cleaning old buttons... this may take a minute.' });
    const cleaned = await onCleanupOldButtons?.() ?? 0;
    console.log(`[SETTINGS] Cleaned ${cleaned} old approval button(s)`);
  });

  // --- AskUserQuestion callback query handlers ---
  // Buttons send number keystrokes (1-4) via tmux to select an option.

  bot.callbackQuery(/^ask:([a-f0-9]+):(\w+)$/, async (ctx) => {
    const optionStr = ctx.match[2];

    // "Other →" button: show toast, no keystroke
    if (optionStr === 'other') {
      await ctx.answerCallbackQuery({
        text: 'Type your answer in the terminal.',
        show_alert: true,
      });
      return;
    }

    const optionIndex = parseInt(optionStr, 10);
    if (isNaN(optionIndex)) {
      await ctx.answerCallbackQuery({ text: 'Invalid option.', show_alert: true });
      return;
    }

    // Find the session from the thread
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: 'No session found.', show_alert: true });
      return;
    }

    const session = sessionStore.getByThreadId(threadId);
    if (!session || session.status !== 'active') {
      await ctx.answerCallbackQuery({ text: 'Session not active.', show_alert: true });
      // Remove buttons from stale message
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
      } catch { /* best-effort */ }
      return;
    }

    // Check tmux availability
    const method = inputRouter.getMethod(session.sessionId);
    if (method !== 'tmux') {
      await ctx.answerCallbackQuery({
        text: 'No tmux pane \u2014 answer from your terminal',
        show_alert: true,
      });
      return;
    }

    // Send the option number key (1-indexed: option 0 → key "1", option 1 → key "2", etc.)
    const keystroke = String(optionIndex + 1);
    const result = await inputRouter.send(session.sessionId, keystroke);
    if (result.status !== 'sent') {
      await ctx.answerCallbackQuery({ text: `Failed: ${result.error}`, show_alert: true });
      return;
    }

    // Success: dismiss loading spinner
    await ctx.answerCallbackQuery();

    // Edit message: remove buttons, append selection indicator
    const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'User';
    try {
      // Get the button text that was selected from the inline keyboard
      const buttons = ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.flat() || [];
      const selectedButton = buttons.find(b => 'callback_data' in b && b.callback_data === ctx.callbackQuery.data);
      const selectedLabel = selectedButton?.text || `Option ${optionIndex + 1}`;

      const originalText = ctx.callbackQuery.message?.text || '';
      const baseText = escapeHtml(originalText);
      const updatedText = `${baseText}\n\n\u2705 <b>${escapeHtml(selectedLabel)}</b> \u2014 selected by ${escapeHtml(who)}`;
      await ctx.editMessageText(updatedText, { parse_mode: 'HTML', reply_markup: undefined });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit ask message:', err instanceof Error ? err.message : err);
      }
    }
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

    // Include quoted message context when replying to a specific message
    let text = ctx.message.text;
    const replied = ctx.message.reply_to_message;
    if (replied && 'text' in replied && replied.text) {
      text = `> ${replied.text.split('\n').join('\n> ')}\n\n${text}`;
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

/**
 * Create an InlineKeyboard for AskUserQuestion options.
 * Each predefined option becomes a button. An "Other →" button is appended.
 * Callback data format: `ask:<toolUseId_first8>:<option_index>`
 *
 * The 64-byte Telegram callback_data limit is respected:
 * "ask:" (4) + 8-char ID (8) + ":" (1) + index (1-2) = 14-15 bytes max.
 */
export function makeAskKeyboard(
  toolUseId: string,
  options: Array<{ label: string }>,
): InlineKeyboard {
  const idPrefix = toolUseId.slice(0, 8);
  const kb = new InlineKeyboard();

  for (let i = 0; i < options.length; i++) {
    const label = options[i].label.slice(0, 30); // Truncate long labels
    kb.text(label, `ask:${idPrefix}:${i}`);
    // Two buttons per row
    if (i % 2 === 1 && i < options.length - 1) {
      kb.row();
    }
  }

  // "Other →" button on its own row
  kb.row();
  kb.text('Other \u2192', `ask:${idPrefix}:other`);

  return kb;
}
