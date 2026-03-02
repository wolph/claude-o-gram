import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppConfig } from '../types/config.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { VerbosityTier } from '../types/monitoring.js';
import type { ApprovalManager } from '../control/approval-manager.js';
import type { InputRouter } from '../input/input-router.js';
import type { CommandRegistry } from './command-registry.js';
import { PermissionModeManager, type PermissionMode } from '../control/permission-modes.js';
import {
  formatApprovalResult,
} from './formatter.js';
import { expandCache, cacheKey, buildExpandedHtml } from './expand-cache.js';
import { escapeHtml } from '../utils/text.js';
import type { RuntimeSettings } from '../settings/runtime-settings.js';
import { buildSettingsKeyboard, formatSettingsMessage } from '../settings/settings-topic.js';

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
  permissionModeManager: PermissionModeManager,
  runtimeSettings: RuntimeSettings,
  onModeChange?: (sessionId: string) => void,
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
      console.log(`[PERM] User approved ${toolUseId}`);
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
      console.log(`[PERM] User denied ${toolUseId}`);
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

  // --- Phase 7: Permission mode callback query handlers ---

  /**
   * Shared handler for mode selection buttons (ma:, ms:, mf:, mu:).
   * Approves the current tool call AND activates the selected mode.
   */
  async function handleModeSelection(
    ctx: Context,
    toolUseId: string,
    mode: PermissionMode,
  ): Promise<void> {
    // Approve the current tool call AND activate mode
    const pending = approvalManager.decide(toolUseId, 'allow');
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'This approval has already expired.', show_alert: true });
      return;
    }

    // For same-tool, pass the tool name from the pending approval
    const toolName = mode === 'same-tool' ? pending.toolName : undefined;
    permissionModeManager.setMode(pending.sessionId, mode, toolName);

    // PERM-08: Log mode activation
    console.log(`[PERM] Mode activated: ${mode}${toolName ? ` (${toolName})` : ''} for session ${pending.sessionId}`);

    await ctx.answerCallbackQuery();

    // Notify index.ts of mode change (triggers Stop button on status message)
    onModeChange?.(pending.sessionId);

    // Edit message to show mode activation result
    const who = ctx.from?.username ? `@${escapeHtml(ctx.from.username)}` : escapeHtml(ctx.from?.first_name || 'User');
    const modeLabel: Record<string, string> = {
      'accept-all': 'Accept All',
      'same-tool': `Same Tool (${pending.toolName})`,
      'safe-only': 'Safe Only',
      'until-done': 'Until Done',
    };
    const originalText = ctx.callbackQuery?.message?.text || '';
    const updatedText = `${originalText}\n\n\u26A1 <b>${modeLabel[mode]}</b> activated by ${who}`;
    try {
      await ctx.editMessageText(updatedText, {
        parse_mode: 'HTML',
        reply_markup: undefined,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit mode activation message:', err instanceof Error ? err.message : err);
      }
    }
  }

  // Mode selection handlers
  bot.callbackQuery(/^ma:(.+)$/, async (ctx) => handleModeSelection(ctx, ctx.match[1], 'accept-all'));
  bot.callbackQuery(/^ms:(.+)$/, async (ctx) => handleModeSelection(ctx, ctx.match[1], 'same-tool'));
  bot.callbackQuery(/^mf:(.+)$/, async (ctx) => handleModeSelection(ctx, ctx.match[1], 'safe-only'));
  bot.callbackQuery(/^mu:(.+)$/, async (ctx) => handleModeSelection(ctx, ctx.match[1], 'until-done'));

  // Stop auto-accept button handler
  bot.callbackQuery(/^stop:(\d+)$/, async (ctx) => {
    const threadId = parseInt(ctx.match[1]);
    const session = sessionStore.getByThreadId(threadId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'Session not found', show_alert: true });
      return;
    }
    permissionModeManager.resetToManual(session.sessionId);
    console.log(`[PERM] Auto-accept stopped for session ${session.sessionId}`);
    await ctx.answerCallbackQuery({ text: 'Auto-accept stopped' });

    // Notify index.ts to update status message (remove Stop button)
    onModeChange?.(session.sessionId);

    // Post a brief announcement to the topic
    try {
      await ctx.api.sendMessage(config.telegramChatId, '\u26D4 Auto-accept stopped', {
        message_thread_id: threadId,
      });
    } catch (err) {
      console.warn('Failed to post stop message:', err instanceof Error ? err.message : err);
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
    // Edit settings message in-place
    const text = formatSettingsMessage(
      runtimeSettings.subagentOutput,
      runtimeSettings.defaultPermissionMode,
    );
    const keyboard = buildSettingsKeyboard(
      runtimeSettings.subagentOutput,
      runtimeSettings.defaultPermissionMode,
    );
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit settings message:', err instanceof Error ? err.message : err);
      }
    }
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
    // Edit settings message in-place
    const text = formatSettingsMessage(
      runtimeSettings.subagentOutput,
      runtimeSettings.defaultPermissionMode,
    );
    const keyboard = buildSettingsKeyboard(
      runtimeSettings.subagentOutput,
      runtimeSettings.defaultPermissionMode,
    );
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('Failed to edit settings message:', err instanceof Error ? err.message : err);
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
 * Create an InlineKeyboard with Approve/Deny on row 1 and mode buttons on row 2.
 * All buttons visible by default — no expansion step needed.
 *
 * Callback data prefixes (all within 64-byte Telegram limit):
 * - approve: (8 + 36 UUID = 44 bytes)
 * - deny: (5 + 36 = 41 bytes)
 * - ma: mode accept-all (3 + 36 = 39 bytes)
 * - ms: mode same-tool (3 + 36 = 39 bytes)
 * - mf: mode safe-only (3 + 36 = 39 bytes)
 * - mu: mode until-done (3 + 36 = 39 bytes)
 */
export function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u2705 Accept', `approve:${toolUseId}`)
    .text('\u274C Deny', `deny:${toolUseId}`)
    .row()
    .text('All', `ma:${toolUseId}`)
    .text('Same Tool', `ms:${toolUseId}`)
    .text('Safe Only', `mf:${toolUseId}`)
    .text('Until Done', `mu:${toolUseId}`);
}
