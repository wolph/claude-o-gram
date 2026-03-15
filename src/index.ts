import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { parseHistoryUsage } from './monitoring/history-parser.js';
import { SessionStore } from './sessions/session-store.js';
import { planInactiveCleanup } from './sessions/inactive-cleanup.js';
import { discoverActiveClaudeSessions } from './sessions/live-session-discovery.js';
import { createHookHandlers, type HookCallbacks } from './hooks/handlers.js';
import { createHookServer } from './hooks/server.js';
import { createBot, makeApprovalKeyboard, makeAskKeyboard, makePlanKeyboard } from './bot/bot.js';
import { PermissionModeManager } from './control/permission-modes.js';
// PermissionModeManager kept for session cleanup; no longer used for auto-approval
import { TopicManager } from './bot/topics.js';
import { MessageBatcher } from './bot/rate-limiter.js';
import {
  formatSessionStart,
  formatSessionEnd,
  formatNotification,
  formatApprovalRequest,
  formatApprovalResult,
  formatSubagentDone,
  formatBypassBatch,
  formatAskUserQuestion,
  formatPlanPrompt,
} from './bot/formatter.js';
import { SubagentTracker } from './monitoring/subagent-tracker.js';
import { installHooks } from './utils/install-hooks.js';
import { getOrCreateHookSecret } from './utils/hook-secret.js';
import { TranscriptWatcher, calculateContextPercentage } from './monitoring/transcript-watcher.js';
import { StatusMessage } from './monitoring/status-message.js';
import { TopicStatusManager } from './monitoring/topic-status.js';
import { ClearDetector } from './monitoring/clear-detector.js';
import { TaskChecklist } from './monitoring/task-checklist.js';
import { escapeHtml, markdownToHtml, isProceduralNarration, convertCommandsForTelegram, stripSystemTags, parseNumberedOptions, extractPromptText } from './utils/text.js';
import { ApprovalManager } from './control/approval-manager.js';
import { BypassBatcher } from './control/bypass-batcher.js';
import { PreToolUseStash } from './control/pretooluse-stash.js';
import { InputRouter } from './input/input-router.js';
import { CommandRegistry } from './bot/command-registry.js';
import { expandCache, cacheKey } from './bot/expand-cache.js';
import { InlineKeyboard } from 'grammy';
import { BotStateStore } from './settings/bot-state-store.js';
import { RuntimeSettings } from './settings/runtime-settings.js';
import { CommandSettingsStore } from './settings/command-settings.js';
import { SettingsTopic } from './settings/settings-topic.js';
import { RuntimeStatus } from './runtime/runtime-status.js';
import { CliOutput } from './runtime/cli-output.js';
import type { SessionInfo } from './types/sessions.js';
import type { StatusData, AskUserQuestionData } from './types/monitoring.js';
import type { PreToolUsePayload } from './types/hooks.js';

/** Per-session monitoring instances */
interface SessionMonitor {
  transcriptWatcher: TranscriptWatcher;
  statusMessage: StatusMessage;
  warned80: boolean;
  warned95: boolean;
}

/**
 * Build a StatusData object from the current session state.
 */
function buildStatusData(session: SessionInfo, currentTool: string): StatusData {
  const startMs = new Date(session.startedAt).getTime();
  const durationMs = Date.now() - startMs;
  const minutes = Math.floor(durationMs / 60000);
  const hours = Math.floor(minutes / 60);
  const sessionDuration = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  const files = session.filesChanged instanceof Set
    ? session.filesChanged.size
    : (session.filesChanged?.length || 0);
  return {
    contextPercent: session.contextPercent || 0,
    currentTool,
    sessionDuration,
    toolCallCount: session.toolCallCount,
    filesChanged: files,
    status: session.status === 'active' ? 'active' : 'closed',
  };
}

/**
 * Main entry point for the Claude Code Telegram Bridge.
 *
 * Single-process daemon (per research Pattern 1) that:
 * 1. Auto-installs HTTP hooks into Claude Code's settings.json
 * 2. Starts a Fastify HTTP server to receive hook POSTs
 * 3. Starts a grammY Telegram bot for forum topic management
 * 4. Wires hook handlers to Telegram actions via HookCallbacks
 * 5. Initializes monitoring (transcript watcher, status message, summary timer)
 * 6. Reconnects to existing sessions on restart
 * 7. Handles graceful shutdown
 */
export async function main(): Promise<void> {
  // 1. Load config (validates required env vars)
  const config = loadConfig();

  // 2. Initialize session store
  const sessionStore = new SessionStore(
    join(config.dataDir, 'sessions.json'),
  );

  // 2b. Initialize bot-level state store and runtime settings
  const botStateStore = new BotStateStore(
    join(config.dataDir, 'bot-state.json'),
    {
      settingsTopicId: 0,
      settingsMessageId: 0,
      subagentOutput: config.subagentOutput,
      defaultPermissionMode: 'manual',
    },
  );
  const runtimeSettings = new RuntimeSettings(botStateStore);

  // 3. Create control managers and input router
  const approvalManager = new ApprovalManager(
    join(config.dataDir, 'pending-approvals.json'),
  );
  const permissionModeManager = new PermissionModeManager();
  const inputRouter = new InputRouter();

  // Runtime observability: colorful CLI logs + live status dashboard
  const runtimeStatus = new RuntimeStatus({
    getActiveSessions: () => sessionStore.getActiveSessions().length,
    getPendingApprovals: () => approvalManager.pendingCount,
  });
  const cli = new CliOutput(runtimeStatus);
  cli.start();
  cli.captureConsole();
  cli.info('CORE', 'Runtime observability enabled', {
    color: process.env.CLI_COLOR || 'auto',
    dashboard: process.env.CLI_DASHBOARD || 'auto',
    level: process.env.CLI_LOG_LEVEL || 'info',
  });
  const parsedInactiveStaleHours = Number.parseInt(process.env.INACTIVE_STALE_HOURS || '6', 10);
  const inactiveStaleHours = Number.isFinite(parsedInactiveStaleHours) && parsedInactiveStaleHours > 0
    ? parsedInactiveStaleHours
    : 6;
  const inactiveStaleMs = inactiveStaleHours * 60 * 60 * 1000;

  // 4. Generate/load hook auth secret and install hooks
  const hookSecret = getOrCreateHookSecret();
  installHooks(config.hookServerPort, hookSecret);

  // 5. Subagent lifecycle tracker
  const subagentTracker = new SubagentTracker();

  // 5b. Discover Claude Code commands for Telegram autocomplete
  const commandRegistry = new CommandRegistry();
  commandRegistry.discover();
  cli.info('CORE', 'Discovered Claude Code commands', {
    count: commandRegistry.getEntries().length,
  });

  // 5c. Initialize command settings store (namespace modes, per-command enable/disable, usage counts)
  const commandSettingsStore = new CommandSettingsStore(
    join(config.dataDir, 'command-settings.json'),
  );
  // Parse ~/.claude/history.jsonl once at startup for usage-seeded defaults
  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  let usageCounts = new Map<string, number>();
  try {
    usageCounts = await parseHistoryUsage(historyPath);
    cli.info('CORE', 'Parsed command usage history', { commands: usageCounts.size });
  } catch (err) {
    cli.warn('CORE', 'Could not read command history, using empty counts', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Apply auto-defaults for all discovered namespaces/commands
  commandSettingsStore.applyDefaults(commandRegistry.getCommandsByNamespace(), usageCounts);

  // If no commands are 'direct' (migration from pre-history version), auto-apply top-N
  const allCmdSettings = commandSettingsStore.getAllCommands();
  const hasAnyDirect = [...allCmdSettings.values()].some((s) => s.visibility === 'direct');
  if (!hasAnyDirect) {
    commandSettingsStore.applyTopDefaults(commandRegistry.getEntries().map((e) => e.claudeName));
    cli.info('CORE', 'Applied top-N usage defaults (no direct commands found)');
  }

  /**
   * Build the Telegram command list using three-state visibility per command.
   *
   * - 'direct': register the command individually (also appears in its namespace submenu)
   * - 'submenu': only appears via the namespace submenu entry
   * - 'hidden': excluded entirely
   * - If still > 100 after grouping: priority-truncate (builtin > user > plugin), then warn.
   */
  function buildTelegramCommandList(): Array<{ command: string; description: string }> {
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const result: Array<{ command: string; description: string }> = [];
    const registeredNs = new Set<string>(); // prevent duplicate namespace entries

    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) {
        // Top-level commands: register 'direct' ones individually
        for (const cn of claudeNames) {
          if (commandSettingsStore.getCommandSetting(cn).visibility === 'direct') {
            const e = allEntries.find((x) => x.claudeName === cn);
            if (e) result.push({ command: e.telegramName, description: e.description.slice(0, 256) });
          }
        }
        continue;
      }

      const tgNs = ns.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
      if (!tgNs) continue;

      const directCmds = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct',
      );
      const visibleCmds = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden',
      );

      // Register each 'direct' command individually (also shows in submenu)
      for (const cn of directCmds) {
        const e = allEntries.find((x) => x.claudeName === cn);
        if (e) result.push({ command: e.telegramName, description: e.description.slice(0, 256) });
      }

      // Register namespace submenu entry if ≥1 non-hidden command exists
      if (visibleCmds.length > 0 && !registeredNs.has(tgNs)) {
        registeredNs.add(tgNs);
        const descriptions = visibleCmds
          .slice(0, 3)
          .map((cn) => allEntries.find((x) => x.claudeName === cn)?.description || cn)
          .join(', ');
        result.push({
          command: tgNs,
          description: `${visibleCmds.length} commands: ${descriptions}`.slice(0, 256),
        });
      }
    }

    if (result.length > 100) {
      const priorityScore = (cmd: string): number => {
        // Direct command match
        const e = allEntries.find((x) => x.telegramName === cmd || x.claudeName === cmd);
        if (e) {
          if (e.source === 'builtin') return 3;
          if (e.source === 'user') return 2;
          return 1;
        }
        // Namespace submenu entry — score by the best source in that namespace
        const nsEntries = allEntries.filter((x) => {
          const tgNs = x.claudeName.split(':')[0]
            .toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
          return tgNs === cmd;
        });
        if (nsEntries.some((x) => x.source === 'builtin')) return 3;
        if (nsEntries.some((x) => x.source === 'user')) return 2;
        if (nsEntries.length > 0) return 1;
        return 0;
      };
      cli.warn('TELEGRAM', 'Command list exceeds limit after grouping, truncating', {
        count: result.length,
        limit: 100,
      });
      return result.sort((a, b) => priorityScore(b.command) - priorityScore(a.command)).slice(0, 100);
    }

    return result;
  }

  // 6. Create bot instance (with plugins, not yet started)
  /** Count sessions that are inactive (closed or stale-active) */
  const getInactiveCount = () => {
    const plan = planInactiveCleanup(sessionStore.getAllSessions(), { staleAfterMs: inactiveStaleMs });
    return plan.deletable.length;
  };

  // Late-bound callbacks — topicManager and settingsTopic are assigned after bot creation
  let topicManagerRef: TopicManager | null = null;
  let settingsTopicRef: SettingsTopic | null = null;

  const onCleanupInactiveTopics = async (): Promise<number> => {
    if (!topicManagerRef) return 0;
    const plan = planInactiveCleanup(sessionStore.getAllSessions(), {
      staleAfterMs: inactiveStaleMs,
    });
    const targets = plan.deletable;
    if (targets.length === 0) {
      if (plan.unmapped.length > 0) {
        const unmappedIds = [...new Set(plan.unmapped.map((s) => s.sessionId))];
        sessionStore.deleteSessions(unmappedIds);
      }
      cli.info('CLEANUP', 'No inactive sessions to remove', {
        closed: plan.closed.length,
        staleActive: plan.staleActive.length,
        unmapped: plan.unmapped.length,
        removedSessions: plan.unmapped.length,
      });
      return 0;
    }

    let deletedTopics = 0;
    let failedDeletes = 0;
    const successfullyDeletedSessionIds = new Set<string>();
    for (const session of targets) {
      if (session.threadId > 0) {
        // Best-effort: topic may already be deleted by the user
        const deleted = await topicManagerRef.deleteTopic(session.threadId);
        if (deleted) {
          deletedTopics++;
          successfullyDeletedSessionIds.add(session.sessionId);
        } else {
          failedDeletes++;
        }
      }
    }
    const unmappedIds = [...new Set(plan.unmapped.map((s) => s.sessionId))];
    const idsToDelete = [...new Set([...successfullyDeletedSessionIds, ...unmappedIds])];
    if (idsToDelete.length > 0) {
      sessionStore.deleteSessions(idsToDelete);
    }
    cli.info('CLEANUP', 'Inactive topic cleanup finished', {
      removedSessions: idsToDelete.length,
      deletedTopics,
      failedDeletes,
      attemptedTopicDeletes: targets.length,
      closed: plan.closed.length,
      staleActive: plan.staleActive.length,
      unmapped: plan.unmapped.length,
      staleAfterHours: inactiveStaleHours,
    });
    return deletedTopics;
  };

  const refreshSettings = () => settingsTopicRef?.requestRefresh();

  let cleanupOldButtonsFn: (() => Promise<number>) | null = null;

  // Late-bound refresh: called when user clicks "Refresh Menu" in /commands UI
  let botRef: Awaited<ReturnType<typeof createBot>> | null = null;
  const onRefreshMenu = async (): Promise<void> => {
    if (!botRef) return;
    const toRegister = buildTelegramCommandList();
    if (toRegister.length === 0) return;
    const scopes = [
      { type: 'chat' as const, chat_id: config.telegramChatId },
      { type: 'chat_member' as const, chat_id: config.telegramChatId, user_id: config.botOwnerId },
    ];
    for (const scope of scopes) {
      try {
        await botRef.api.setMyCommands(toRegister, { scope });
        cli.info('TELEGRAM', 'Re-registered commands with Telegram (refresh)', { scope: scope.type, count: toRegister.length });
      } catch (err) {
        cli.warn('TELEGRAM', 'Failed to re-register Telegram commands', {
          scope: scope.type,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  };

  const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry, permissionModeManager, runtimeSettings, commandSettingsStore, onCleanupInactiveTopics, refreshSettings, async () => cleanupOldButtonsFn?.() ?? 0, onRefreshMenu);
  botRef = bot;

  // 5b. Wire late-bound cleanup for orphaned approval buttons
  cleanupOldButtonsFn = async () => {
    const allSessions = sessionStore.getAllSessions();
    const anchors = new Set<number>();
    for (const s of allSessions) {
      if (s.statusMessageId > 0) {
        anchors.add(s.statusMessageId);
      }
    }

    if (anchors.size === 0) {
      cli.info('CLEANUP', 'No message ID anchors found');
      return 0;
    }

    cli.info('CLEANUP', 'Starting old approval button sweep', {
      anchors: anchors.size,
      rangePerAnchor: 500,
    });

    let cleaned = 0;
    let scanned = 0;
    let anchorIndex = 0;
    for (const anchor of anchors) {
      anchorIndex++;
      cli.info('CLEANUP', 'Scanning message range for stale buttons', {
        anchor,
        anchorIndex,
        anchors: anchors.size,
      });
      const start = Math.max(1, anchor - 500);
      for (let msgId = anchor; msgId >= start; msgId--) {
        scanned++;
        try {
          await bot.api.editMessageReplyMarkup(
            config.telegramChatId,
            msgId,
            { reply_markup: { inline_keyboard: [] } },
          );
          cleaned++;
        } catch {
          // Ignore: wrong message, not ours, already edited, etc.
        }
        if (scanned % 200 === 0) {
          cli.info('CLEANUP', 'Old approval button sweep progress', {
            scanned,
            cleaned,
            anchorIndex,
            anchors: anchors.size,
          });
        }
        // Rate limit: 50ms between calls
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    cli.info('CLEANUP', 'Removed stale approval keyboards', {
      cleaned,
      scanned,
      anchors: anchors.size,
    });
    return cleaned;
  };

  // 6. Create topic manager wired to bot
  const topicManager = new TopicManager(bot, config.telegramChatId);
  topicManagerRef = topicManager;

  // 6b. Create topic status manager (Phase 9: color-coded status emoji prefixes)
  const topicStatusManager = new TopicStatusManager(bot, config.telegramChatId);

  // 7. Create message batcher wired to topic manager
  //    sendFn uses sendMessageRaw (returns message_id) for expand cache support
  const batcher = new MessageBatcher(
    (threadId, html, _notify) => topicManager.sendMessageRaw(threadId, html),
    (threadId, content, filename, caption) =>
      topicManager.sendDocument(threadId, content, filename, caption),
  );

  // 7b. Per-thread pending expand data, cleared on flush
  const pendingExpandData = new Map<number, Array<{ toolName: string; expandContent: string }>>();

  // 7c. Wire batcher onFlush callback for expand cache population
  batcher.setOnFlush((threadId, messageIds, originalMessages) => {
    const expandData = pendingExpandData.get(threadId);
    pendingExpandData.delete(threadId);

    if (!expandData || expandData.length === 0) return;
    if (messageIds.length === 0) return;

    // The first messageId corresponds to the batched tool message
    const msgId = messageIds[0];
    const key = cacheKey(config.telegramChatId, msgId);

    // Build compact text (the original combined message)
    const compactHtml = originalMessages.join('\n\n');

    expandCache.set(key, {
      compact: compactHtml,
      tools: expandData.map(d => ({ name: d.toolName, expanded: d.expandContent })),
    });

    // Edit the message to add an Expand button
    const keyboard = new InlineKeyboard().text('\u25B8 Expand', `exp:${msgId}`);
    void bot.api.editMessageText(config.telegramChatId, msgId, compactHtml, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(err => {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        cli.warn('TELEGRAM', 'Failed to add expand button', {
          error: err instanceof Error ? err.message : err,
        });
      }
    });
  });

  // 7d. Bypass mode batcher: accumulates auto-approved tool calls, flushes every 10s
  const makeBypassKeyboard = (messageId: number, expanded: boolean) =>
    new InlineKeyboard().text(
      expanded ? '\u25BE Hide details' : '\u25B8 Show details',
      `bp:${messageId}`,
    );

  const bypassBatcher = new BypassBatcher(
    {
      send: async (threadId, html, expanded) => {
        const msg = await bot.api.sendMessage(config.telegramChatId, html, {
          message_thread_id: threadId,
          parse_mode: 'HTML',
        });
        // Add expand/collapse button after send (need messageId for callback data)
        try {
          await bot.api.editMessageReplyMarkup(config.telegramChatId, msg.message_id, {
            reply_markup: makeBypassKeyboard(msg.message_id, expanded),
          });
        } catch {
          // Non-critical — button just won't appear
        }
        return msg.message_id;
      },
      edit: async (messageId, html, expanded) => {
        await bot.api.editMessageText(config.telegramChatId, messageId, html, {
          parse_mode: 'HTML',
          reply_markup: makeBypassKeyboard(messageId, expanded),
        });
      },
    },
    formatBypassBatch,
  );

  // Bypass batch expand/collapse callback handler
  bot.callbackQuery(/^bp:(\d+)$/, async (ctx) => {
    const messageId = parseInt(ctx.match[1], 10);
    await ctx.answerCallbackQuery();
    await bypassBatcher.toggleExpand(messageId);
  });

  // 7d2. PreToolUse stash: holds payloads until Notification correlation confirms approval needed
  const preToolUseStash = new PreToolUseStash(2000, (sessionId, threadId, payload) => {
    // Timer expired — no Notification came, tool was auto-approved → route to bypass batcher
    bypassBatcher.add(sessionId, threadId, payload);
  });

  // 7e. Task checklist: live-updating task progress per session
  const taskChecklist = new TaskChecklist({
    send: async (threadId, html) => {
      const msg = await bot.api.sendMessage(config.telegramChatId, html, {
        message_thread_id: threadId,
        parse_mode: 'HTML',
      });
      return msg.message_id;
    },
    edit: async (messageId, html) => {
      await bot.api.editMessageText(config.telegramChatId, messageId, html, {
        parse_mode: 'HTML',
      });
    },
  });

  // 8. Per-session monitoring instances
  const monitors = new Map<string, SessionMonitor>();

  // Per-session dedup for AskUserQuestion tool_use_ids
  const seenAskIds = new Map<string, Set<string>>();

  // Track AskUserQuestion Telegram message IDs for answer resolution
  // Maps toolUseId (first 8 chars) → { messageId, originalHtml, options }
  const pendingAskMessages = new Map<string, {
    messageId: number;
    originalHtml: string;
    options: Array<{ label: string }>;
  }>();

  /**
   * Bridge between SessionEnd(reason=clear) and SessionStart(source=clear).
   * Stores threadId and statusMessageId so the clear flow can reuse the topic.
   */
  const clearPending = new Map<string, { threadId: number; statusMessageId: number }>();

  // Per-CWD clear detectors (filesystem watcher for /clear bypass of hooks)
  const clearDetectors = new Map<string, ClearDetector>();

  /**
   * Start a ClearDetector for a session's CWD if one isn't already running.
   * Detects /clear via filesystem when HTTP hooks don't fire (bug #6428).
   */
  function startClearDetector(session: SessionInfo): void {
    if (clearDetectors.has(session.cwd)) {
      // Update session ID on existing detector
      clearDetectors.get(session.cwd)!.updateSessionId(session.sessionId);
      return;
    }

    const detector = new ClearDetector(
      session.cwd,
      session.sessionId,
      (sid) => !!sessionStore.get(sid),
      (newTranscriptPath, newSessionId) => {
        void handleClearDetected(session.cwd, newTranscriptPath, newSessionId);
      },
    );
    clearDetectors.set(session.cwd, detector);
    detector.start();
  }

  /**
   * Clean up duplicate topics for a given cwd.
   * Deletes Telegram topics and session store entries for all closed sessions
   * with the same cwd but a different threadId than the one being kept.
   */
  async function cleanupDuplicateTopics(cwd: string, keepThreadId: number): Promise<void> {
    const toDelete = sessionStore.getAllSessions().filter(
      s => s.cwd === cwd && s.status === 'closed' && s.threadId > 0 && s.threadId !== keepThreadId
    );
    for (const s of toDelete) {
      try {
        await topicManager.deleteTopic(s.threadId);
      } catch { /* best-effort */ }
    }
    if (toDelete.length > 0) {
      sessionStore.deleteSessions(toDelete.map(s => s.sessionId));
      cli.info('CLEANUP', 'Cleaned duplicate topics', { count: toDelete.length, cwd });
    }
  }

  /**
   * Handle a /clear event detected via filesystem watcher.
   * Mirrors the onSessionStart(source='clear') logic but triggered by
   * ClearDetector instead of HTTP hooks.
   */
  async function handleClearDetected(
    cwd: string,
    newTranscriptPath: string,
    newSessionId: string,
  ): Promise<void> {
    // Dedup: if the HTTP hook already registered this session, skip
    if (sessionStore.get(newSessionId)) return;

    // Find the prior session. SessionEnd(reason=clear) fires BEFORE the new
    // transcript appears, so the session is likely already closed.
    // Check three sources: active (SessionEnd didn't fire), clearPending
    // (SessionEnd fired and stored threadId), recently closed (fallback).
    const active = sessionStore.getActiveByCwd(cwd);
    const pending = clearPending.get(cwd);
    const recentlyClosed = !active ? sessionStore.getRecentlyClosedByCwd(cwd) : undefined;
    const oldSession = active ?? recentlyClosed;

    // Need at least a threadId to post into
    const threadId = oldSession?.threadId ?? pending?.threadId ?? 0;
    if (threadId === 0) return;

    // Clean up clearPending if it was used
    if (pending) clearPending.delete(cwd);

    // Pre-register new session with same threadId (prevents ensureSession race)
    const clearNow = new Date().toISOString();
    const newSessionData: SessionInfo = {
      sessionId: newSessionId,
      threadId,
      cwd,
      topicName: oldSession?.topicName ?? cwd.split('/').pop() ?? 'session',
      startedAt: clearNow,
      status: 'active',
      transcriptPath: newTranscriptPath,
      toolCallCount: 0,
      filesChanged: new Set<string>(),
      verbosity: oldSession?.verbosity ?? config.defaultVerbosity,
      statusMessageId: oldSession?.statusMessageId ?? pending?.statusMessageId ?? 0,
      suppressedCounts: {},
      contextPercent: 0,
      lastActivityAt: clearNow,
      permissionMode: oldSession?.permissionMode,
    };
    sessionStore.set(newSessionId, newSessionData);

    // Clean up old monitoring (may already be cleaned by SessionEnd handler)
    if (oldSession) {
      const oldMonitor = monitors.get(oldSession.sessionId);
      if (oldMonitor) {
        oldMonitor.transcriptWatcher.stop();
        oldMonitor.statusMessage.destroy();
        monitors.delete(oldSession.sessionId);
      }
      approvalManager.cleanupSession(oldSession.sessionId);
      permissionModeManager.cleanup(oldSession.sessionId);
      inputRouter.cleanup(oldSession.sessionId);
      subagentTracker.cleanup(oldSession.sessionId);
      seenAskIds.delete(oldSession.sessionId);
      taskChecklist.cleanup(oldSession.sessionId);
      if (oldSession.status === 'active') {
        sessionStore.updateStatus(oldSession.sessionId, 'closed');
      }
    }

    // Post timestamped separator (SESS-02)
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const separator = `\u2500\u2500\u2500 context cleared at ${timeStr} \u2500\u2500\u2500`;
    await batcher.enqueueImmediate(threadId, separator);

    // Reset counters (SESS-05)
    sessionStore.resetCounters(newSessionId);

    // Fresh monitoring (SESS-03)
    const newSession = sessionStore.get(newSessionId)!;
    initMonitoring(newSession);

    // Update the ClearDetector to track the new session ID
    const detector = clearDetectors.get(cwd);
    if (detector) {
      detector.updateSessionId(newSessionId);
    }

    // Re-detect input method
    void inputRouter.register(newSessionId, cwd, newSession.permissionMode).then(() => {
      const method = inputRouter.getMethod(newSessionId);
      if (method) {
        sessionStore.updateInputMethod(newSessionId, method);
      }
    });
  }

  /**
   * Initialize monitoring components for a session.
   * Used both for new sessions and for reconnecting active sessions on restart.
   */
  function initMonitoring(session: SessionInfo): void {
    // Initialize status message
    const statusMsg = new StatusMessage(bot, config.telegramChatId, session.threadId);

    // Initialize transcript watcher
    const transcriptWatcher = new TranscriptWatcher(
      session.transcriptPath,
      // onAssistantMessage: post to Telegram via batcher
      (rawText) => {
        // Strip system XML tags (e.g. <system-reminder>, <command-name>) that
        // leak into transcript text after /compact or context injection
        const cleaned = stripSystemTags(rawText);
        if (cleaned.length === 0) return;

        // Filter short procedural narration ("Let me read...", "I'll check...")
        if (isProceduralNarration(cleaned)) return;

        // Convert Claude Code command references to Telegram-clickable format
        const text = convertCommandsForTelegram(cleaned);

        if (text.length > 3000) {
          const truncated = text.slice(0, 1500) + '\n... (truncated)';
          batcher.enqueue(session.threadId, markdownToHtml(truncated), {
            content: text,
            filename: 'claude-output.txt',
            caption: 'Full Claude output',
          });
        } else {
          batcher.enqueue(session.threadId, markdownToHtml(text));
        }
      },
      // onUsageUpdate: update context percentage and status message
      (usage) => {
        const percent = calculateContextPercentage(usage);
        sessionStore.updateContextPercent(session.sessionId, percent);
        const latestSession = sessionStore.get(session.sessionId);
        if (latestSession) {
          statusMsg.requestUpdate(buildStatusData(latestSession, ''));

          // Context usage warnings at 80% and 95% thresholds (once each per session)
          const monitor = monitors.get(session.sessionId);
          if (monitor) {
            if (percent >= 95 && !monitor.warned95) {
              monitor.warned95 = true;
              topicStatusManager.setStatus(session.threadId, 'red');
              batcher.enqueue(session.threadId,
                '\u26A0\uFE0F <b>Context window at 95%!</b> Session may need to compact soon.');
            } else if (percent >= 80 && !monitor.warned80) {
              monitor.warned80 = true;
              batcher.enqueue(session.threadId,
                '\u{1F7E1} <b>Context window at 80%.</b> Consider wrapping up current task.');
            }
          }
        }
      },
      // onSidechainMessage: subagent text output (suppressed when subagentOutput is false)
      (rawText) => {
        if (!runtimeSettings.subagentOutput) return;

        const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
        if (!activeAgent) return; // No active agent -- skip (defensive)

        // Filter procedural narration same as main chain
        if (isProceduralNarration(rawText)) return;

        const text = convertCommandsForTelegram(rawText);
        const indent = subagentTracker.getIndent(activeAgent.agentId);
        const prefix = `${indent}[${escapeHtml(activeAgent.displayName)}] `;

        if (text.length > 3000) {
          const truncated = text.slice(0, 1500) + '\n... (truncated)';
          batcher.enqueue(session.threadId, prefix + markdownToHtml(truncated));
        } else {
          batcher.enqueue(session.threadId, prefix + markdownToHtml(text));
        }
      },
      // onAskUserQuestion: forward to Telegram as interactive prompt
      (data: AskUserQuestionData) => {
        // Dedup: skip if we've already seen this tool_use_id
        let seen = seenAskIds.get(session.sessionId);
        if (!seen) {
          seen = new Set();
          seenAskIds.set(session.sessionId, seen);
        }
        if (seen.has(data.toolUseId)) return;
        seen.add(data.toolUseId);

        // Format the question message
        const html = formatAskUserQuestion(data);

        // Build inline keyboard from the first question's options
        const q = data.questions[0];
        if (!q || q.options.length === 0) {
          // No options — just show as text
          batcher.enqueue(session.threadId, html);
          return;
        }

        const keyboard = makeAskKeyboard(data.toolUseId, q.options);
        const idPrefix = data.toolUseId.slice(0, 8);

        // Send immediately (not batched) — this needs user interaction
        bot.api.sendMessage(config.telegramChatId, html, {
          message_thread_id: session.threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }).then((msg) => {
          // Track for answer resolution
          pendingAskMessages.set(idPrefix, {
            messageId: msg.message_id,
            originalHtml: html,
            options: q.options,
          });
        }).catch((err) => {
          cli.warn('TELEGRAM', 'Failed to send AskUserQuestion message', {
            error: err instanceof Error ? err.message : err,
          });
        });
      },
      // onAskUserQuestionResult: update Telegram message when answer detected
      (toolUseId: string, answerText: string) => {
        const idPrefix = toolUseId.slice(0, 8);
        const pending = pendingAskMessages.get(idPrefix);
        if (!pending) return;
        pendingAskMessages.delete(idPrefix);

        // Parse the answer — try to extract the selected option label
        let answerLabel = answerText;
        try {
          const parsed = JSON.parse(answerText);
          if (parsed.answers && typeof parsed.answers === 'object') {
            // answers is { "question text": "selected label" }
            const values = Object.values(parsed.answers) as string[];
            if (values.length > 0) answerLabel = values[0];
          } else if (typeof parsed === 'string') {
            answerLabel = parsed;
          }
        } catch {
          // Not JSON, use raw text (truncated)
          answerLabel = answerText.slice(0, 100);
        }

        const updatedHtml = `${pending.originalHtml}\n\n\u2705 <b>${escapeHtml(answerLabel)}</b>`;
        bot.api.editMessageText(config.telegramChatId, pending.messageId, updatedHtml, {
          parse_mode: 'HTML',
        }).catch((err) => {
          if (!(err instanceof Error && err.message.includes('message is not modified'))) {
            cli.warn('TELEGRAM', 'Failed to update ask answer', {
              error: err instanceof Error ? err.message : err,
            });
          }
        });
      },
      // onUserMessage: mirror prompts from Claude transcript (e.g. local terminal input)
      (rawText: string) => {
        // Strip system XML tags that wrap local command metadata
        const compact = stripSystemTags(rawText);
        if (compact.length === 0) return;
        const text = convertCommandsForTelegram(compact);
        if (text.length > 3000) {
          const truncated = text.slice(0, 1500) + '\n... (truncated)';
          batcher.enqueue(session.threadId, `\u{1F464} <b>You</b>\n${markdownToHtml(truncated)}`, {
            content: text,
            filename: 'user-input.txt',
            caption: 'Full user input',
          });
        } else {
          batcher.enqueue(session.threadId, `\u{1F464} <b>You</b>\n${markdownToHtml(text)}`);
        }
      },
    );

    // Store monitor and start components
    monitors.set(session.sessionId, {
      transcriptWatcher,
      statusMessage: statusMsg,
      warned80: false,
      warned95: false,
    });

    // Start async initialization: reconnect to existing message or create new one
    if (session.statusMessageId > 0) {
      // Phase 11: Dedup — adopt existing pinned message (on /clear or bot restart)
      void statusMsg.reconnect(session.statusMessageId).then(() => {
        // Trigger immediate update to refresh stale content with reset counters
        const latestSession = sessionStore.get(session.sessionId);
        if (latestSession) {
          statusMsg.requestUpdate(buildStatusData(latestSession, 'Starting...'));
        }
      });
    } else {
      // Brand new session: send + pin a new status message
      void statusMsg.initialize().then((statusMessageId) => {
        sessionStore.updateStatusMessageId(session.sessionId, statusMessageId);
        // Set default verbosity from config
        sessionStore.updateVerbosity(session.sessionId, config.defaultVerbosity);
      }).catch((err) => {
        cli.warn('STATUS', 'Failed to initialize status message', {
          error: err instanceof Error ? err.message : err,
        });
      });
    }

    transcriptWatcher.start();

    // Phase 9: Register topic for status tracking and set initial green status
    topicStatusManager.registerTopic(session.threadId, session.topicName);
    topicStatusManager.setStatus(session.threadId, 'green');
  }

  // 8. Define HookCallbacks -- THE CRITICAL WIRING
  //    This connects session lifecycle events to Telegram forum topic actions.
  const callbacks: HookCallbacks = {
    onSessionStart: async (session, source) => {
      cli.info('SESSION', 'Session start', {
        source,
        session: session.sessionId.slice(0, 8),
        cwd: session.cwd,
      });
      if (source === 'clear') {
        // /clear transition: reuse existing topic.
        // The session object already has threadId and statusMessageId
        // from the prior session (copied via spread in handlers.ts).
        //
        // Two paths get us here:
        // 1. SessionEnd never fired (upstream bug #6428) -- prior session was active,
        //    handlers.ts found it via getActiveByCwd. threadId/statusMessageId are
        //    directly on the session object.
        // 2. SessionEnd fired first (future fix) -- clearPending was populated.
        //    handlers.ts found the closed session via getRecentlyClosedByCwd.
        //    threadId/statusMessageId are also on the session object.
        //
        // Either way, session.threadId and session.statusMessageId are valid.

        // Also check clearPending as an additional source (for future-proofing
        // when SessionEnd fires first and has already cleaned up the old session).
        const pending = clearPending.get(session.cwd);
        if (pending) {
          clearPending.delete(session.cwd);
        }

        // Clean up OLD monitoring for the previous session ID.
        // Since SessionEnd may not have fired, the old monitor may still be running.
        // Find it by matching cwd (not sessionId, since the new session has a different ID).
        for (const [oldSessionId, monitor] of monitors) {
          if (oldSessionId !== session.sessionId) {
            const oldSession = sessionStore.get(oldSessionId);
            if (oldSession && oldSession.cwd === session.cwd) {
              monitor.transcriptWatcher.stop();
              monitor.statusMessage.destroy();
              monitors.delete(oldSessionId);

              // Also clean up control state for the old session
              approvalManager.cleanupSession(oldSessionId);
              permissionModeManager.cleanup(oldSessionId);
              inputRouter.cleanup(oldSessionId);
              subagentTracker.cleanup(oldSessionId);
              seenAskIds.delete(oldSessionId);
              taskChecklist.cleanup(oldSessionId);

              // Mark old session as closed; getByThreadId prefers active sessions
              sessionStore.updateStatus(oldSessionId, 'closed');
              break;
            }
          }
        }

        // Post timestamped separator (SESS-02)
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const separator = `\u2500\u2500\u2500 context cleared at ${timeStr} \u2500\u2500\u2500`;
        await batcher.enqueueImmediate(session.threadId, separator);

        // Reset session counters (SESS-05)
        sessionStore.resetCounters(session.sessionId);

        // Initialize fresh monitoring (creates new StatusMessage, pins it) (SESS-03)
        initMonitoring(session);

        // Update ClearDetector for the new session ID
        startClearDetector(session);

        // Re-detect input method
        void inputRouter.register(session.sessionId, session.cwd, session.permissionMode).then(() => {
          const method = inputRouter.getMethod(session.sessionId);
          if (method) {
            sessionStore.updateInputMethod(session.sessionId, method);
          }
        });

        return;
      }

      if (source === 'reuse' && session.threadId > 0) {
        // Reuse: reopen a closed topic for a new session with the same cwd
        await topicManager.reopenTopic(session.threadId, session.topicName);
        topicStatusManager.registerTopic(session.threadId, session.topicName);
        await topicStatusManager.setStatusImmediate(session.threadId, 'green', session.topicName);

        // Post separator to distinguish from previous session
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const separator = `\u2500\u2500\u2500 new session at ${timeStr} \u2500\u2500\u2500`;
        await batcher.enqueueImmediate(session.threadId, separator);

        // Reset counters for the fresh session
        sessionStore.resetCounters(session.sessionId);

        // Initialize monitoring
        initMonitoring(session);

        // Start /clear detector
        startClearDetector(session);

        // Detect input method
        void inputRouter.register(session.sessionId, session.cwd, session.permissionMode).then(() => {
          const method = inputRouter.getMethod(session.sessionId);
          if (method) {
            sessionStore.updateInputMethod(session.sessionId, method);
          }
        });

        // Clean up duplicate topics for this cwd (best-effort, async)
        void cleanupDuplicateTopics(session.cwd, session.threadId);

        return;
      }

      if (source === 'resume' && session.threadId > 0) {
        // Resume: reopen existing topic and post resume message
        await topicManager.reopenTopic(session.threadId, session.topicName);
        // Register topic and set green status immediately after reopen
        topicStatusManager.registerTopic(session.threadId, session.topicName);
        await topicStatusManager.setStatusImmediate(session.threadId, 'green', session.topicName);
        await batcher.enqueueImmediate(
          session.threadId,
          formatSessionStart(session, true),
        );
      } else {
        // New session: create topic, update store, post start message
        const threadId = await topicManager.createTopic(session.topicName);
        sessionStore.updateThreadId(session.sessionId, threadId);
        // Update local session object for the rest of this callback
        session.threadId = threadId;
        // Set green status immediately after topic creation
        await topicStatusManager.setStatusImmediate(threadId, 'green', session.topicName);
        await batcher.enqueueImmediate(
          threadId,
          formatSessionStart(session, false),
        );
      }

      // Initialize monitoring components for this session
      initMonitoring(session);

      // Start filesystem-based /clear detector (workaround for bug #6428)
      startClearDetector(session);

      // Detect and register input method (tmux / FIFO / SDK resume)
      void inputRouter.register(session.sessionId, session.cwd, session.permissionMode).then(() => {
        const method = inputRouter.getMethod(session.sessionId);
        if (method) {
          sessionStore.updateInputMethod(session.sessionId, method);
        }
      });
    },

    onSessionEnd: async (session, reason) => {
      cli.info('SESSION', 'Session end', {
        reason,
        session: session.sessionId.slice(0, 8),
      });
      // Re-fetch session from store to get latest toolCallCount/filesChanged
      const latest = sessionStore.get(session.sessionId) || session;

      if (reason === 'clear') {
        // /clear transition: keep topic open, clean up monitoring but preserve threadId
        const monitor = monitors.get(session.sessionId);
        if (monitor) {
          monitor.transcriptWatcher.stop();
          monitor.statusMessage.destroy();
          monitors.delete(session.sessionId);
        }

        // Clean up control state
        approvalManager.cleanupSession(session.sessionId);
        permissionModeManager.cleanup(session.sessionId);
        inputRouter.cleanup(session.sessionId);
        subagentTracker.cleanup(session.sessionId);
        bypassBatcher.cleanupSession(session.sessionId);
        preToolUseStash.cleanupSession(session.sessionId);
        seenAskIds.delete(session.sessionId);
        taskChecklist.cleanup(session.sessionId);

        // Store threadId for the upcoming SessionStart(source=clear)
        clearPending.set(latest.cwd, {
          threadId: latest.threadId,
          statusMessageId: latest.statusMessageId,
        });

        // Do NOT close the topic, do NOT post session end summary (SESS-06)
        return;
      }

      // Normal session end: clean up monitoring
      const monitor = monitors.get(session.sessionId);
      if (monitor) {
        monitor.transcriptWatcher.stop();

        // Send final status update showing "closed" state before destroying
        const finalData = buildStatusData(latest, '');
        finalData.status = 'closed';
        monitor.statusMessage.requestUpdate(finalData);
        // Small delay to let the final update flush before destroying
        await new Promise(resolve => setTimeout(resolve, 500));
        monitor.statusMessage.destroy();
        monitors.delete(session.sessionId);
      }

      // Clean up control state, permission modes, input router, and subagent tracker
      approvalManager.cleanupSession(session.sessionId);
      permissionModeManager.cleanup(session.sessionId);
      inputRouter.cleanup(session.sessionId);
      subagentTracker.cleanup(session.sessionId);
      bypassBatcher.cleanupSession(session.sessionId);
      preToolUseStash.cleanupSession(session.sessionId);
      seenAskIds.delete(session.sessionId);
      taskChecklist.cleanup(session.sessionId);

      const summary = formatSessionEnd(latest, 'completed');
      // Send immediately (not batched) -- this is a lifecycle event
      await batcher.enqueueImmediate(latest.threadId, summary);
      // Unregister topic from status tracking before closing
      topicStatusManager.unregisterTopic(latest.threadId);
      // Close the topic
      await topicManager.closeTopic(latest.threadId, latest.topicName);
    },

    onToolComplete: async (session, payload) => {
      // Check if this tool was stashed (no Notification came — auto-approved)
      const stashed = preToolUseStash.removeByToolUseId(session.sessionId, payload.tool_use_id);
      if (stashed) {
        // Auto-approved: route to bypassBatcher (no approval buttons were ever shown)
        bypassBatcher.add(session.sessionId, stashed.threadId, stashed.payload);
        return;
      }

      // Not stashed — check if there's a pending approval message to clean up
      const pendingApproval = approvalManager.resolvePending(payload.tool_use_id);
      if (pendingApproval) {
        try {
          const resultText = formatApprovalResult('allow', 'locally', pendingApproval.originalHtml);
          await bot.api.editMessageText(config.telegramChatId, pendingApproval.messageId, resultText, {
            parse_mode: 'HTML',
            reply_markup: undefined,
          });
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('message is not modified'))) {
            cli.warn('PERM', 'Failed to update local approval message', {
              error: err instanceof Error ? err.message : err,
            });
          }
        }
      }
    },

    onToolUse: async (session, payload) => {
      cli.debug('TOOL', 'Tool completed', {
        session: session.sessionId.slice(0, 8),
        tool: payload.tool_name,
      });

      // Guard: skip if threadId not yet assigned (race during topic creation)
      if (!session.threadId) return;

      // Set topic to yellow (processing) -- debounced, won't spam API
      topicStatusManager.setStatus(session.threadId, 'yellow');

      // Task tools: route to checklist (consumes TaskCreate, TaskUpdate, TaskList, TaskGet)
      if (taskChecklist.handleToolUse(
        session.sessionId,
        session.threadId,
        payload.tool_name,
        payload.tool_input,
        payload.tool_response,
      )) {
        // Still update status message even for task tools
        const monitor = monitors.get(session.sessionId);
        if (monitor) {
          const latestSession = sessionStore.get(session.sessionId);
          if (latestSession) {
            monitor.statusMessage.requestUpdate(
              buildStatusData(latestSession, payload.tool_name),
            );
          }
        }
        return;
      }

      // All other tools: suppress display, only update status message
      const monitor = monitors.get(session.sessionId);
      if (monitor) {
        const latestSession = sessionStore.get(session.sessionId);
        if (latestSession) {
          monitor.statusMessage.requestUpdate(
            buildStatusData(latestSession, payload.tool_name),
          );
        }
      }
    },

    onNotification: async (session, payload) => {
      cli.debug('NOTIFY', 'Notification received', {
        type: payload.notification_type,
        session: session.sessionId.slice(0, 8),
      });
      // Suppress idle notifications — status message already shows idle state
      if (payload.notification_type === 'idle_prompt') return;

      // permission_prompt: correlate with stashed PreToolUse to show approval buttons
      if (payload.notification_type === 'permission_prompt') {
        const stashed = preToolUseStash.popOldest(session.sessionId);
        if (stashed) {
          // AskUserQuestion: skip approval UI — transcript watcher shows interactive buttons
          if (stashed.payload.tool_name === 'AskUserQuestion') {
            cli.debug('PERM', 'Skipping approval UI for AskUserQuestion (transcript watcher handles it)', {
              session: session.sessionId.slice(0, 8),
            });
            return;
          }

          // Build approval message from the stashed PreToolUse context
          let approvalHtml = formatApprovalRequest(stashed.payload);
          if (stashed.agentPrefix) {
            approvalHtml = stashed.agentPrefix + approvalHtml;
          }

          cli.info('PERM', 'Permission request (Notification correlated)', {
            tool: stashed.payload.tool_name,
            session: session.sessionId.slice(0, 8),
          });

          const keyboard = makeApprovalKeyboard(stashed.payload.tool_use_id);
          const msg = await bot.api.sendMessage(config.telegramChatId, approvalHtml, {
            message_thread_id: stashed.threadId,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });

          approvalManager.trackPending(
            stashed.payload.tool_use_id,
            session.sessionId,
            stashed.threadId,
            msg.message_id,
            stashed.payload.tool_name,
            approvalHtml,
          );

          // Set topic to green — waiting for user approval (= waiting for input)
          topicStatusManager.setStatus(stashed.threadId, 'green');
          return;
        }

        // No stashed PreToolUse — check for multi-choice prompt (e.g. plan mode)
        const parsedOptions = parseNumberedOptions(payload.message);
        if (parsedOptions.length > 1) {
          // Multi-choice prompt: show options as inline buttons
          const syntheticId = `plan${Date.now()}`;
          const promptText = extractPromptText(payload.message);
          const html = formatPlanPrompt(promptText);
          const keyboard = makePlanKeyboard(syntheticId, parsedOptions);

          cli.info('NOTIFY', 'Plan/multi-choice prompt detected', {
            session: session.sessionId.slice(0, 8),
            options: parsedOptions.length,
          });

          await bot.api.sendMessage(config.telegramChatId, html, {
            message_thread_id: session.threadId,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });

          topicStatusManager.setStatus(session.threadId, 'green');
          return;
        }

        // Plain permission_prompt with no options — show as-is
        cli.warn('NOTIFY', 'permission_prompt with no stashed PreToolUse', {
          session: session.sessionId.slice(0, 8),
        });
      }

      const html = formatNotification(payload);
      // Notify only for prompts that block Claude and need user action
      const shouldNotify = payload.notification_type === 'permission_prompt'
        || payload.notification_type === 'elicitation_dialog';
      await batcher.enqueueImmediate(session.threadId, html, shouldNotify);
    },

    onBackfillSummary: async (session, summary) => {
      await batcher.enqueueImmediate(session.threadId, summary);
    },

    onPreToolUse: async (session, payload: PreToolUsePayload) => {
      cli.debug('PERM', 'PreToolUse received', {
        session: session.sessionId.slice(0, 8),
        tool: payload.tool_name,
      });
      // Guard: skip if threadId not yet assigned (race during topic creation)
      if (!session.threadId) return;

      // Stash description from Agent/Task tool for SubagentStart correlation
      if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
        const desc = (payload.tool_input.description as string)
          || (payload.tool_input.prompt as string)
          || '';
        subagentTracker.stashDescription(
          session.sessionId,
          (payload.tool_input.subagent_type as string) || 'unknown',
          desc,
        );
      }

      // Fast path: known bypass modes skip stashing entirely
      const permMode = payload.permission_mode || session.permissionMode;
      if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        return;
      }

      // Telegram auto-approve modes: route to bypass batcher, no stashing needed
      if (permissionModeManager.shouldAutoApprove(session.sessionId, payload.tool_name, payload.tool_input)) {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        permissionModeManager.incrementAutoApproved(session.sessionId);
        return;
      }

      // Compute agent prefix now (subagent state may change by the time Notification arrives)
      let agentPrefix: string | null = null;
      const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
      if (activeAgent) {
        const indent = subagentTracker.getIndent(activeAgent.agentId);
        agentPrefix = `${indent}<b>[${escapeHtml(activeAgent.displayName)}]</b> `;
      }

      // Stash payload — wait for Notification correlation before showing buttons
      preToolUseStash.push(session.sessionId, session.threadId, payload, agentPrefix);
    },

    onStop: async (session, _payload) => {
      cli.debug('SESSION', 'Turn stopped', { session: session.sessionId.slice(0, 8) });
      // Turn complete -- set topic back to green (waiting for input)
      topicStatusManager.setStatus(session.threadId, 'green');
      // Clear sticky red if set -- new turn means user has seen the warning
      topicStatusManager.clearStickyRed(session.threadId);
    },

    // Phase 8: Subagent lifecycle callbacks
    onSubagentStart: async (session, payload) => {
      // Register agent in tracker (description was stashed from PreToolUse)
      const agent = subagentTracker.start(
        session.sessionId,
        payload.agent_id,
        payload.agent_type,
      );

      // Spawn announcements suppressed — subagentDone shows completion summary

      runtimeStatus.noteSubagentStart();
      cli.info('AGENT', 'Subagent spawned', {
        name: agent.displayName,
        agentId: payload.agent_id,
        session: session.sessionId.slice(0, 8),
        depth: agent.depth,
      });
    },

    onSubagentStop: async (session, payload) => {
      const result = subagentTracker.stop(payload.agent_id);
      if (!result) {
        cli.warn('AGENT', 'SubagentStop received for unknown agent', {
          agentId: payload.agent_id,
          session: session.sessionId.slice(0, 8),
        });
        return;
      }

      // Post done announcement as inline message (suppressed when subagentOutput is false)
      if (runtimeSettings.subagentOutput) {
        // Note: stop() already removed the agent from the map, so getIndent won't work.
        // Use depth directly from the returned agent instead.
        const indentStr = '  '.repeat(Math.min(result.agent.depth, 2));
        const doneHtml = formatSubagentDone(result.agent.displayName, result.durationMs, indentStr);
        await batcher.enqueueImmediate(session.threadId, doneHtml);
      }

      runtimeStatus.noteSubagentStop();
      cli.info('AGENT', 'Subagent completed', {
        name: result.agent.displayName,
        agentId: payload.agent_id,
        durationSec: Math.round(result.durationMs / 1000),
      });
    },
  };

  // 9. Create hook handlers with session store and callbacks
  const handlers = createHookHandlers(sessionStore, callbacks);

  // 10. Create Fastify hook server and START LISTENING IMMEDIATELY.
  //     The server must accept connections before any slow startup work
  //     (gray sweep, reconnection, settings init) that could take seconds.
  //     Hooks are already installed in settings.json (step 2), so any Claude
  //     Code session that fires a hook during startup needs a listening server.
  const server = await createHookServer(config, handlers, hookSecret,
    // onAgentToolDetected: stash Agent/Task description for SubagentStart correlation
    (sessionId, toolName, toolInput) => {
      const desc = (toolInput.description as string) || (toolInput.prompt as string) || '';
      subagentTracker.stashDescription(sessionId, (toolInput.subagent_type as string) || 'unknown', desc);
    },
    {
      onHookReceived: (event) => {
        runtimeStatus.noteHook(event);
        cli.debug('HOOK', 'Hook received', { event });
      },
      onAuthFailure: (route) => {
        runtimeStatus.noteAuthFailure(route);
        cli.warn('HOOK', 'Hook authentication rejected', { route });
      },
      onHandlerError: (route, error) => {
        cli.error('HOOK', 'Hook handler error', {
          route,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  );

  await server.listen({
    port: config.hookServerPort,
    host: config.hookServerHost,
  });
  cli.info('HOOK', 'Fastify hook server listening', {
    host: config.hookServerHost,
    port: config.hookServerPort,
  });

  // 11. Phase 9: Startup gray sweep -- mark all active sessions as offline
  //     Sequential with delay to avoid editForumTopic rate limits.
  //     Runs BEFORE reconnect loop so users see gray while bot reconnects.
  const sessionsToSweep = sessionStore.getActiveSessions();
  for (const session of sessionsToSweep) {
    if (session.threadId > 0) {
      try {
        await topicStatusManager.setStatusImmediate(session.threadId, 'gray', session.topicName);
      } catch (err) {
        cli.warn('STARTUP', 'Gray sweep failed to update topic', {
          threadId: session.threadId,
          error: err instanceof Error ? err.message : err,
        });
      }
      // Brief delay between calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (sessionsToSweep.length > 0) {
    cli.info('STARTUP', 'Gray sweep marked topics offline', { count: sessionsToSweep.length });
  }

  // 11b. Reconnect to existing sessions on restart
  //      Per user decision: "reconnect to existing topics from saved session map
  //      + post 'Bot restarted' notification"
  //      If a topic was manually deleted, create a new one for the session.
  const activeSessions = sessionStore.getActiveSessions();
  let reconnectedCount = 0;
  for (const session of activeSessions) {
    try {
      let threadId = session.threadId;

      if (threadId > 0) {
        // Probe: try reopening the topic to verify it still exists
        try {
          await topicManager.reopenTopic(threadId, session.topicName);
        } catch (err) {
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          if (msg.includes('not modified') || msg.includes('not_modified')) {
            // Topic exists and is already open — good
          } else {
            // Topic was deleted — create a new one
            cli.info('STARTUP', 'Topic missing, creating replacement', {
              threadId,
              session: session.sessionId.slice(0, 8),
            });
            threadId = 0;
          }
        }
      }

      if (threadId === 0) {
        // Create a fresh topic for this session
        threadId = await topicManager.createTopic(session.topicName);
        sessionStore.updateThreadId(session.sessionId, threadId);
        session.threadId = threadId;
        // Reset status message ID — old one belonged to deleted topic
        sessionStore.updateStatusMessageId(session.sessionId, 0);
        session.statusMessageId = 0;
      }

      // Re-initialize monitoring for active sessions on restart
      initMonitoring(session);
      // Start /clear detector (filesystem workaround for bug #6428)
      startClearDetector(session);
      // Re-detect input method
      void inputRouter.register(session.sessionId, session.cwd, session.permissionMode);
      // Clean up duplicate topics for this cwd (best-effort, async)
      void cleanupDuplicateTopics(session.cwd, session.threadId);
      reconnectedCount++;
    } catch (err) {
      cli.warn('STARTUP', 'Failed to reconnect session', {
        session: session.sessionId.slice(0, 8),
        error: err instanceof Error ? err.message : err,
      });
    }
  }
  if (reconnectedCount > 0) {
    cli.info('STARTUP', 'Reconnected active sessions', { count: reconnectedCount });
  }

  // 11c. Discover active Claude sessions that are running but not yet tracked
  //      (e.g. bot started after Claude session). Register them as startup
  //      sessions so they get topic creation/reuse + transcript backfill.
  const liveDiscovery = discoverActiveClaudeSessions();
  let recoveredLiveSessions = 0;
  let skippedKnownLiveSessions = 0;
  let failedLiveRecoveries = 0;

  for (const live of liveDiscovery.sessions) {
    if (sessionStore.get(live.sessionId)) {
      skippedKnownLiveSessions++;
      continue;
    }

    try {
      await handlers.handleSessionStart({
        hook_event_name: 'SessionStart',
        session_id: live.sessionId,
        transcript_path: live.transcriptPath,
        cwd: live.cwd,
        permission_mode: 'default',
        source: 'startup',
        model: 'unknown',
      });
      recoveredLiveSessions++;
    } catch (err) {
      failedLiveRecoveries++;
      cli.warn('STARTUP', 'Failed to recover active live session', {
        session: live.sessionId.slice(0, 8),
        cwd: live.cwd,
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  if (
    liveDiscovery.openTranscripts > 0 ||
    liveDiscovery.unresolved > 0 ||
    recoveredLiveSessions > 0 ||
    skippedKnownLiveSessions > 0 ||
    failedLiveRecoveries > 0
  ) {
    cli.info('STARTUP', 'Live session discovery finished', {
      openTranscripts: liveDiscovery.openTranscripts,
      resolved: liveDiscovery.sessions.length,
      unresolved: liveDiscovery.unresolved,
      recovered: recoveredLiveSessions,
      skippedKnown: skippedKnownLiveSessions,
      failed: failedLiveRecoveries,
    });
  }

  // Clean up all pending approvals from previous run — strip orphaned buttons
  const staleCount = await approvalManager.cleanupStale(async (entry) => {
    try {
      await bot.api.editMessageReplyMarkup(
        config.telegramChatId,
        entry.messageId,
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch {
      // Best-effort: message may already be edited or too old to modify
    }
  });
  if (staleCount > 0) {
    cli.info('CLEANUP', 'Cleaned stale pending approvals', { count: staleCount });
  }

  // 11d. Phase 12: Initialize settings topic
  const settingsTopic = new SettingsTopic(bot, config.telegramChatId, runtimeSettings, getInactiveCount);
  settingsTopicRef = settingsTopic;
  try {
    const settingsThreadId = await settingsTopic.init();
    cli.info('SETTINGS', 'Settings topic ready', { threadId: settingsThreadId });
  } catch (err) {
    cli.error('SETTINGS', 'Failed to initialize settings topic', {
      error: err instanceof Error ? err.message : err,
    });
    // Non-fatal: bot continues without settings topic
  }

  // 12. Start Telegram bot (hook server already listening from step 10)
  bot.start();
  cli.info('TELEGRAM', 'Bot started (polling)');

  // 12b. Register discovered commands with Telegram autocomplete menu (namespace-aware)
  //      Register for both chat scope and chat_member scope (bot owner) so commands
  //      appear in forum topic autocomplete.
  const toRegister = buildTelegramCommandList();
  if (toRegister.length > 0) {
    const scopes = [
      { type: 'chat' as const, chat_id: config.telegramChatId },
      { type: 'chat_member' as const, chat_id: config.telegramChatId, user_id: config.botOwnerId },
    ];
    for (const scope of scopes) {
      try {
        await bot.api.setMyCommands(toRegister, { scope });
        cli.info('TELEGRAM', 'Registered commands with Telegram', { scope: scope.type, count: toRegister.length });
      } catch (err) {
        cli.warn('TELEGRAM', 'Failed to register Telegram commands', {
          scope: scope.type,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  cli.info('CORE', 'Startup complete');

  // 13. Graceful shutdown
  const shutdown = async () => {
    cli.info('CORE', 'Shutting down');
    // Stop all monitoring instances
    for (const [, monitor] of monitors) {
      monitor.transcriptWatcher.stop();
      monitor.statusMessage.destroy();
    }
    monitors.clear();
    clearPending.clear();
    // Phase 9: Clean up topic status manager (cancels debounce timers)
    topicStatusManager.destroy();
    // Clean up settings topic debounce timer
    settingsTopic.destroy();
    // Stop all clear detectors
    for (const [, detector] of clearDetectors) {
      detector.stop();
    }
    clearDetectors.clear();
    // Phase 3+7: Clean up control managers
    approvalManager.shutdown();
    bypassBatcher.shutdown();
    preToolUseStash.shutdown();
    taskChecklist.shutdown();
    commandSettingsStore.shutdown();
    // Clean up permission mode and subagent tracker state for all sessions
    for (const session of sessionStore.getActiveSessions()) {
      permissionModeManager.cleanup(session.sessionId);
      subagentTracker.cleanup(session.sessionId);
    }
    batcher.shutdown();
    bot.stop();
    await server.close();
    cli.info('CORE', 'Shutdown complete');
    cli.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Run main at module level
main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
