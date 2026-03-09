import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppConfig } from '../types/config.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ApprovalManager } from '../control/approval-manager.js';
import type { InputRouter } from '../input/input-router.js';
import type { CommandRegistry } from './command-registry.js';
import type { PermissionModeManager } from '../control/permission-modes.js';
import type { CommandSettingsStore } from '../settings/command-settings.js';
import type { CommandVisibility } from '../settings/command-settings.js';
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
  commandSettingsStore: CommandSettingsStore,
  onCleanupInactiveTopics?: () => Promise<number>,
  refreshSettings?: () => void,
  onCleanupOldButtons?: () => Promise<number>,
  onRefreshMenu?: () => Promise<void>,
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
    const startedAt = Date.now();
    console.log('[SETTINGS] Inactive topic cleanup requested');
    await ctx.answerCallbackQuery({ text: 'Removing inactive topics...' });
    const removed = await onCleanupInactiveTopics();
    console.log(`[SETTINGS] Removed ${removed} inactive topic(s) in ${Date.now() - startedAt}ms`);
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
    const startedAt = Date.now();
    console.log('[SETTINGS] Old approval button cleanup requested');
    await ctx.answerCallbackQuery({ text: 'Cleaning old buttons... this may take a minute.' });
    const cleaned = await onCleanupOldButtons?.() ?? 0;
    console.log(`[SETTINGS] Cleaned ${cleaned} old approval button(s) in ${Date.now() - startedAt}ms`);
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

  // --- Commands overview from settings topic ---
  bot.callbackQuery('set_cmd:overview', async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Only the bot owner can manage commands', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    await sendCommandsOverview(ctx, threadId);
  });

  // --- Submenu state machine ---
  // Tracks which user is waiting to provide parameters for a subcommand.
  // Keyed by chatId (the forum group ID). Resets on restart (intentional).
  const pendingSubcmd = new Map<number, {
    claudeName: string;
    messageId: number;
    threadId: number;
    createdAt: number;
  }>();

  const SUBMENU_PAGE_SIZE = 8;

  /** Build an inline keyboard for a namespace submenu page */
  function buildSubmenuKeyboard(ns: string, entries: Array<{ claudeName: string; description: string }>, page: number): InlineKeyboard {
    const start = page * SUBMENU_PAGE_SIZE;
    const pageEntries = entries.slice(start, start + SUBMENU_PAGE_SIZE);
    const kb = new InlineKeyboard();

    for (let i = 0; i < pageEntries.length; i++) {
      const e = pageEntries[i];
      // Button label: strip namespace prefix for readability, title-case
      const rawName = e.claudeName.includes(':') ? e.claudeName.split(':').slice(1).join(':') : e.claudeName;
      const label = rawName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 20);
      // callback_data: sub:<claudeName> (max 64 bytes; claudeNames are typically <40 chars)
      const cbData = `sub:${e.claudeName}`.slice(0, 64);
      kb.text(label, cbData);
      if (i % 2 === 1 && i < pageEntries.length - 1) kb.row();
    }

    // Pagination row
    const totalPages = Math.ceil(entries.length / SUBMENU_PAGE_SIZE);
    if (totalPages > 1) {
      kb.row();
      if (page > 0) kb.text('\u2190 Prev', `subp:${ns}:${page - 1}`);
      kb.text(`${page + 1}/${totalPages}`, 'subp_noop');
      if (page < totalPages - 1) kb.text('Next \u2192', `subp:${ns}:${page + 1}`);
    }

    return kb;
  }

  /** Build the submenu message text for a namespace */
  function buildSubmenuText(ns: string, entries: Array<{ claudeName: string; description: string }>): string {
    return `\uD83D\uDCC1 <b>/${escapeHtml(ns)}</b> \u2014 ${entries.length} command${entries.length !== 1 ? 's' : ''}\n\nSelect a command:`;
  }

  /** Register submenu namespace command handler for all submenu-mode namespaces */
  function registerSubmenuHandlers(): void {
    const nsByMode = commandRegistry.getCommandsByNamespace();

    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) continue; // skip top-level
      const nsSetting = commandSettingsStore.getNamespaceSetting(ns);
      if (nsSetting.defaultVisibility !== 'submenu') continue;

      const entries = claudeNames
        .map((cn) => {
          const e = commandRegistry.getByClaudeName(cn);
          return e ? { claudeName: e.claudeName, description: e.description } : null;
        })
        .filter((e): e is { claudeName: string; description: string } => e !== null)
        .filter((e) => commandSettingsStore.getCommandSetting(e.claudeName).visibility !== 'hidden');

      if (entries.length === 0) continue;

      // Sanitize namespace to valid Telegram command name
      const tgNs = ns.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
      if (!tgNs) continue;

      bot.command(tgNs, async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const kb = buildSubmenuKeyboard(ns, entries, 0);
        const text = buildSubmenuText(ns, entries);

        await ctx.reply(text, {
          reply_markup: kb,
          message_thread_id: threadId,
        });

        // Clear any pending subcommand when showing a new submenu
        pendingSubcmd.delete(chatId);
      });
    }
  }

  registerSubmenuHandlers();

  // --- Submenu callback: user tapped a subcommand button ---
  bot.callbackQuery(/^sub:(.+)$/, async (ctx) => {
    const claudeName = ctx.match[1];
    const chatId = ctx.chat?.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery({ text: 'Something went wrong', show_alert: true });
      return;
    }

    const entry = commandRegistry.getByClaudeName(claudeName);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Command not found', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // If parameters === 'none', execute immediately
    if (entry.parameters === 'none') {
      pendingSubcmd.delete(chatId);
      commandSettingsStore.recordUse(claudeName);
      const session = threadId ? sessionStore.getByThreadId(threadId) : null;
      if (!session || session.status !== 'active') {
        await ctx.editMessageText(`\u274C No active session in this topic.`, { reply_markup: undefined });
        return;
      }
      const result = await inputRouter.send(session.sessionId, `/${claudeName}`);
      if (result.status === 'sent') {
        await ctx.editMessageText(`\u26A1 Running: <code>/${escapeHtml(claudeName)}</code>`, { reply_markup: undefined });
      } else {
        await ctx.editMessageText(`\u274C Failed: ${escapeHtml(result.error ?? 'unknown error')}`, { reply_markup: undefined });
      }
      return;
    }

    // Otherwise: show parameter prompt
    pendingSubcmd.set(chatId, { claudeName, messageId, threadId: threadId ?? 0, createdAt: Date.now() });

    const paramHint = entry.parameters
      ? `Parameters: <code>${escapeHtml(entry.parameters)}</code>`
      : 'Parameters: (none required, or type anything to pass as arguments)';

    const promptText =
      `\u25B6 <b>${escapeHtml(claudeName)}</b>\n` +
      `${escapeHtml(entry.description)}\n\n` +
      `${paramHint}\n\n` +
      `Type your parameters and send, or:`;

    const promptKb = new InlineKeyboard()
      .text('\u25B6 Run without parameters', 'subrun')
      .row()
      .text('\u2717 Cancel', 'subcancel');

    try {
      await ctx.editMessageText(promptText, { reply_markup: promptKb });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit submenu to prompt:', err instanceof Error ? err.message : err);
      }
    }
  });

  // --- Submenu pagination ---
  bot.callbackQuery(/^subp:([^:]+):(\d+)$/, async (ctx) => {
    const ns = ctx.match[1];
    const page = parseInt(ctx.match[2], 10);
    await ctx.answerCallbackQuery();

    const nsByMode = commandRegistry.getCommandsByNamespace();
    const claudeNames = nsByMode.get(ns) ?? [];
    const entries = claudeNames
      .map((cn) => {
        const e = commandRegistry.getByClaudeName(cn);
        return e ? { claudeName: e.claudeName, description: e.description } : null;
      })
      .filter((e): e is { claudeName: string; description: string } => e !== null)
      .filter((e) => commandSettingsStore.getCommandSetting(e.claudeName).visibility !== 'hidden');

    const kb = buildSubmenuKeyboard(ns, entries, page);
    const text = buildSubmenuText(ns, entries);
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
    } catch { /* message may not be modified */ }
  });

  bot.callbackQuery('subp_noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  // --- Submenu run-without-parameters ---
  bot.callbackQuery('subrun', async (ctx) => {
    const chatId = ctx.chat?.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Something went wrong', show_alert: true });
      return;
    }

    const pending = pendingSubcmd.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'No pending command', show_alert: true });
      return;
    }
    pendingSubcmd.delete(chatId);
    await ctx.answerCallbackQuery();

    commandSettingsStore.recordUse(pending.claudeName);
    const session = threadId ? sessionStore.getByThreadId(threadId) : null;
    if (!session || session.status !== 'active') {
      await ctx.editMessageText(`\u274C No active session in this topic.`, { reply_markup: undefined });
      return;
    }
    const result = await inputRouter.send(session.sessionId, `/${pending.claudeName}`);
    if (result.status === 'sent') {
      await ctx.editMessageText(`\u26A1 Running: <code>/${escapeHtml(pending.claudeName)}</code>`, { reply_markup: undefined });
    } else {
      await ctx.editMessageText(`\u274C Failed: ${escapeHtml(result.error ?? 'unknown error')}`, { reply_markup: undefined });
    }
  });

  // --- Submenu cancel ---
  bot.callbackQuery('subcancel', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) { await ctx.answerCallbackQuery(); return; }
    pendingSubcmd.delete(chatId);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText('Cancelled.', { reply_markup: undefined });
    } catch { /* best-effort */ }
  });

  // --- /commands UI ---
  bot.command('commands', async (ctx) => {
    await sendCommandsOverview(ctx, ctx.message?.message_thread_id);
  });

  async function sendCommandsOverview(ctx: Context, threadId?: number): Promise<void> {
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const totalCount = allEntries.length;

    // Count what's in Telegram menu
    let menuCount = 0;
    const nsLines: string[] = [];
    const kb = new InlineKeyboard();

    // Top-level commands (no namespace)
    const topLevel = nsByMode.get('') ?? [];
    if (topLevel.length > 0) {
      const enabledCount = topLevel.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden').length;
      nsLines.push(`<b>(top-level)</b> (${enabledCount}) \u2014 Direct`);
      menuCount += enabledCount;
    }

    let rowItems = 0;
    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) continue;
      const setting = commandSettingsStore.getNamespaceSetting(ns);
      const enabledCount = claudeNames.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden').length;
      const modeLabel = setting.defaultVisibility === 'submenu' ? 'Submenu' : 'Direct';
      const toggleLabel = setting.defaultVisibility === 'submenu' ? '\u2192 Direct' : '\u2192 Submenu';
      const toggleMode = setting.defaultVisibility === 'submenu' ? 'direct' : 'submenu';
      nsLines.push(`<b>${escapeHtml(ns)}</b> (${enabledCount}) \u2014 ${modeLabel}`);
      menuCount += setting.defaultVisibility === 'submenu' ? 1 : enabledCount;

      kb.text(`${ns}: ${toggleLabel}`, `nsmode:${ns}:${toggleMode}`);
      rowItems++;
      if (rowItems % 2 === 0) kb.row();
    }

    kb.row();
    kb.text('\uD83D\uDD04 Refresh Menu', 'cmd_refresh');

    const header =
      `\uD83D\uDCCB <b>Commands</b> \u2014 ${menuCount} in Telegram menu (${totalCount} total)\n\n` +
      nsLines.join('\n');

    try {
      await ctx.reply(header, {
        reply_markup: kb,
        message_thread_id: threadId,
      });
    } catch (err) {
      console.warn('Failed to send /commands overview:', err instanceof Error ? err.message : err);
    }
  }

  // --- Namespace mode toggle ---
  bot.callbackQuery(/^nsmode:([^:]+):(direct|submenu)$/, async (ctx) => {
    const ns = ctx.match[1];
    const newMode = ctx.match[2] as CommandVisibility;
    commandSettingsStore.setNamespaceSetting(ns, { defaultVisibility: newMode });
    await ctx.answerCallbackQuery({ text: `${ns}: switched to ${newMode}` });

    // Re-render the overview in-place
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const totalCount = allEntries.length;

    let menuCount = 0;
    const nsLines: string[] = [];
    const kb = new InlineKeyboard();

    const topLevel = nsByMode.get('') ?? [];
    if (topLevel.length > 0) {
      const enabledCount = topLevel.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden').length;
      nsLines.push(`<b>(top-level)</b> (${enabledCount}) \u2014 Direct`);
      menuCount += enabledCount;
    }

    let rowItems = 0;
    for (const [nsCurrent, claudeNames] of nsByMode) {
      if (!nsCurrent) continue;
      const setting = commandSettingsStore.getNamespaceSetting(nsCurrent);
      const enabledCount = claudeNames.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden').length;
      const modeLabel = setting.defaultVisibility === 'submenu' ? 'Submenu' : 'Direct';
      const toggleLabel = setting.defaultVisibility === 'submenu' ? '\u2192 Direct' : '\u2192 Submenu';
      const toggleMode = setting.defaultVisibility === 'submenu' ? 'direct' : 'submenu';
      nsLines.push(`<b>${escapeHtml(nsCurrent)}</b> (${enabledCount}) \u2014 ${modeLabel}`);
      menuCount += setting.defaultVisibility === 'submenu' ? 1 : enabledCount;

      kb.text(`${nsCurrent}: ${toggleLabel}`, `nsmode:${nsCurrent}:${toggleMode}`);
      rowItems++;
      if (rowItems % 2 === 0) kb.row();
    }

    kb.row();
    kb.text('\uD83D\uDD04 Refresh Menu', 'cmd_refresh');

    const header =
      `\uD83D\uDCCB <b>Commands</b> \u2014 ${menuCount} in Telegram menu (${totalCount} total)\n\n` +
      nsLines.join('\n');

    try {
      await ctx.editMessageText(header, { reply_markup: kb });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit commands overview:', err instanceof Error ? err.message : err);
      }
    }
  });

  // --- Refresh Telegram menu ---
  bot.callbackQuery('cmd_refresh', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Refreshing Telegram menu...' });
    try {
      await onRefreshMenu?.();
    } catch (err) {
      console.warn('Menu refresh error:', err instanceof Error ? err.message : err);
    }
  });

  // CLI command forwarding also needs to handle pending subcmd parameter input
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

    const chatId = ctx.chat?.id;
    const rawText = ctx.message.text;

    // --- Pending subcommand parameter interception ---
    // If the user has a pending subcommand waiting for params, treat this non-command message as args.
    // (Commands starting with '/' are handled by the command handler above, not here.)
    if (chatId && !rawText.startsWith('/')) {
      const pending = pendingSubcmd.get(chatId);
      if (pending && threadId === pending.threadId) {
        pendingSubcmd.delete(chatId);
        const session = sessionStore.getByThreadId(threadId);
        if (!session || session.status !== 'active') {
          await ctx.reply('\u274C No active session in this topic.', { message_thread_id: threadId });
          return;
        }
        commandSettingsStore.recordUse(pending.claudeName);
        const result = await inputRouter.send(session.sessionId, `/${pending.claudeName} ${rawText}`);
        if (result.status === 'sent') {
          try { await ctx.react('\u26A1'); } catch { /* ignore */ }
        } else {
          await ctx.reply(
            `\u274C Failed to send command: ${result.error}`,
            { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
          );
        }
        return;
      }
    }

    // Find session for this topic
    const session = sessionStore.getByThreadId(threadId);
    if (!session) return; // Not a managed session topic
    if (session.status !== 'active') return; // Session is closed

    // Include quoted message context when replying to a specific message
    let text = rawText;
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
