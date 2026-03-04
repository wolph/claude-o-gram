import { join } from 'node:path';
import { loadConfig } from './config.js';
import { SessionStore } from './sessions/session-store.js';
import { createHookHandlers, type HookCallbacks } from './hooks/handlers.js';
import { createHookServer } from './hooks/server.js';
import { createBot, makeApprovalKeyboard, makeAskKeyboard } from './bot/bot.js';
import { PermissionModeManager } from './control/permission-modes.js';
// PermissionModeManager kept for session cleanup; no longer used for auto-approval
import { TopicManager } from './bot/topics.js';
import { MessageBatcher } from './bot/rate-limiter.js';
import {
  formatSessionStart,
  formatSessionEnd,
  formatToolCompact,
  formatNotification,
  formatApprovalRequest,
  formatApprovalResult,
  formatSubagentDone,
  formatBypassBatch,
  formatAskUserQuestion,
} from './bot/formatter.js';
import { SubagentTracker } from './monitoring/subagent-tracker.js';
import { installHooks } from './utils/install-hooks.js';
import { TranscriptWatcher, calculateContextPercentage } from './monitoring/transcript-watcher.js';
import { StatusMessage } from './monitoring/status-message.js';
import { TopicStatusManager } from './monitoring/topic-status.js';
import { SummaryTimer } from './monitoring/summary-timer.js';
import { ClearDetector } from './monitoring/clear-detector.js';
import { escapeHtml, markdownToHtml, isProceduralNarration, convertCommandsForTelegram } from './utils/text.js';
import { ApprovalManager } from './control/approval-manager.js';
import { BypassBatcher } from './control/bypass-batcher.js';
import { InputRouter } from './input/input-router.js';
import { CommandRegistry } from './bot/command-registry.js';
import { expandCache, cacheKey } from './bot/expand-cache.js';
import { InlineKeyboard } from 'grammy';
import { BotStateStore } from './settings/bot-state-store.js';
import { RuntimeSettings } from './settings/runtime-settings.js';
import { SettingsTopic } from './settings/settings-topic.js';
import type { SessionInfo } from './types/sessions.js';
import type { StatusData, AskUserQuestionData } from './types/monitoring.js';
import type { PreToolUsePayload } from './types/hooks.js';

/** Per-session monitoring instances */
interface SessionMonitor {
  transcriptWatcher: TranscriptWatcher;
  statusMessage: StatusMessage;
  summaryTimer: SummaryTimer;
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

  // 2. Auto-install hooks into Claude Code settings (idempotent)
  installHooks(config.hookServerPort);

  // 3. Initialize session store
  const sessionStore = new SessionStore(
    join(config.dataDir, 'sessions.json'),
  );

  // 3b. Initialize bot-level state store and runtime settings
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

  // 4. Create control managers and input router
  const approvalManager = new ApprovalManager(
    join(config.dataDir, 'pending-approvals.json'),
  );
  const permissionModeManager = new PermissionModeManager();
  const inputRouter = new InputRouter();

  // 4c. Subagent lifecycle tracker
  const subagentTracker = new SubagentTracker();

  // 4b. Discover Claude Code commands for Telegram autocomplete
  const commandRegistry = new CommandRegistry();
  commandRegistry.discover();
  console.log(`Discovered ${commandRegistry.getEntries().length} Claude Code commands`);

  // 5. Create bot instance (with plugins, not yet started)
  /** Get count of closed (inactive) sessions */
  const getInactiveCount = () => sessionStore.getClosedSessions().length;

  // Late-bound callbacks — topicManager and settingsTopic are assigned after bot creation
  let topicManagerRef: TopicManager | null = null;
  let settingsTopicRef: SettingsTopic | null = null;

  const onCleanupInactiveTopics = async (): Promise<number> => {
    if (!topicManagerRef) return 0;
    const closed = sessionStore.getClosedSessions();
    for (const session of closed) {
      if (session.threadId > 0) {
        // Best-effort: topic may already be deleted by the user
        await topicManagerRef.deleteTopic(session.threadId);
      }
    }
    // Always remove all closed sessions from the store
    const ids = closed.map(s => s.sessionId);
    if (ids.length > 0) {
      sessionStore.deleteSessions(ids);
    }
    return ids.length;
  };

  const refreshSettings = () => settingsTopicRef?.requestRefresh();

  let cleanupOldButtonsFn: (() => Promise<number>) | null = null;

  const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry, permissionModeManager, runtimeSettings, onCleanupInactiveTopics, refreshSettings, async () => cleanupOldButtonsFn?.() ?? 0);

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
      console.log('[CLEANUP] No message ID anchors found');
      return 0;
    }

    let cleaned = 0;
    for (const anchor of anchors) {
      const start = Math.max(1, anchor - 500);
      for (let msgId = anchor; msgId >= start; msgId--) {
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
        // Rate limit: 50ms between calls
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    console.log(`[CLEANUP] Removed keyboards from ${cleaned} message(s)`);
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
        console.warn('Failed to add expand button:', err instanceof Error ? err.message : err);
      }
    });
  });

  // 7d. Bypass mode batcher: accumulates auto-approved tool calls, flushes every 10s
  const bypassBatcher = new BypassBatcher(
    {
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
    },
    formatBypassBatch,
  );

  // 8. Per-session monitoring instances
  const monitors = new Map<string, SessionMonitor>();

  // Per-session dedup for AskUserQuestion tool_use_ids
  const seenAskIds = new Map<string, Set<string>>();

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
      console.log(`Cleaned up ${toDelete.length} duplicate topic(s) for ${cwd}`);
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
        oldMonitor.summaryTimer.stop();
        oldMonitor.statusMessage.destroy();
        monitors.delete(oldSession.sessionId);
      }
      approvalManager.cleanupSession(oldSession.sessionId);
      permissionModeManager.cleanup(oldSession.sessionId);
      inputRouter.cleanup(oldSession.sessionId);
      subagentTracker.cleanup(oldSession.sessionId);
      seenAskIds.delete(oldSession.sessionId);
      if (oldSession.status === 'active') {
        sessionStore.updateStatus(oldSession.sessionId, 'closed');
      }
      // Clear old session's threadId to prevent getByThreadId collision
      sessionStore.updateThreadId(oldSession.sessionId, 0);
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
        // Filter short procedural narration ("Let me read...", "I'll check...")
        if (isProceduralNarration(rawText)) return;

        // Convert Claude Code command references to Telegram-clickable format
        const text = convertCommandsForTelegram(rawText);

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

        // Send immediately (not batched) — this needs user interaction
        void bot.api.sendMessage(config.telegramChatId, html, {
          message_thread_id: session.threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }).catch((err) => {
          console.warn(
            'Failed to send AskUserQuestion message:',
            err instanceof Error ? err.message : err,
          );
        });
      },
    );

    // Initialize summary timer
    const summaryTimer = new SummaryTimer(
      config.summaryIntervalMs,
      () => {
        const s = sessionStore.get(session.sessionId);
        if (!s || s.status !== 'active') return null;
        const suppressed = sessionStore.getSuppressedCounts(session.sessionId);
        const files = s.filesChanged instanceof Set ? s.filesChanged.size : (s.filesChanged?.length || 0);
        return {
          cwd: s.cwd,
          toolCallCount: s.toolCallCount,
          filesChanged: files,
          contextPercent: s.contextPercent || 0,
          suppressedCounts: suppressed,
          lastToolName: '',
        };
      },
      (summaryText) => {
        batcher.enqueue(session.threadId, summaryText);
      },
    );

    // Store monitor and start components
    monitors.set(session.sessionId, {
      transcriptWatcher,
      statusMessage: statusMsg,
      summaryTimer,
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
        console.warn('Failed to initialize status message:', err instanceof Error ? err.message : err);
      });
    }

    transcriptWatcher.start();
    summaryTimer.start();

    // Phase 9: Register topic for status tracking and set initial green status
    topicStatusManager.registerTopic(session.threadId, session.topicName);
    topicStatusManager.setStatus(session.threadId, 'green');
  }

  // 8. Define HookCallbacks -- THE CRITICAL WIRING
  //    This connects session lifecycle events to Telegram forum topic actions.
  const callbacks: HookCallbacks = {
    onSessionStart: async (session, source) => {
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
              monitor.summaryTimer.stop();
              monitor.statusMessage.destroy();
              monitors.delete(oldSessionId);

              // Also clean up control state for the old session
              approvalManager.cleanupSession(oldSessionId);
              permissionModeManager.cleanup(oldSessionId);
              inputRouter.cleanup(oldSessionId);
              subagentTracker.cleanup(oldSessionId);
              seenAskIds.delete(oldSessionId);

              // Mark old session as closed and clear its threadId to prevent
              // getByThreadId from returning the stale closed session
              sessionStore.updateStatus(oldSessionId, 'closed');
              sessionStore.updateThreadId(oldSessionId, 0);
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
      // Re-fetch session from store to get latest toolCallCount/filesChanged
      const latest = sessionStore.get(session.sessionId) || session;

      if (reason === 'clear') {
        // /clear transition: keep topic open, clean up monitoring but preserve threadId
        const monitor = monitors.get(session.sessionId);
        if (monitor) {
          monitor.transcriptWatcher.stop();
          monitor.summaryTimer.stop();
          monitor.statusMessage.destroy();
          monitors.delete(session.sessionId);
        }

        // Clean up control state
        approvalManager.cleanupSession(session.sessionId);
        permissionModeManager.cleanup(session.sessionId);
        inputRouter.cleanup(session.sessionId);
        subagentTracker.cleanup(session.sessionId);
        bypassBatcher.cleanupSession(session.sessionId);
        seenAskIds.delete(session.sessionId);

        // Store threadId for the upcoming SessionStart(source=clear)
        clearPending.set(latest.cwd, {
          threadId: latest.threadId,
          statusMessageId: latest.statusMessageId,
        });

        // Clear old session's threadId to prevent getByThreadId collision
        sessionStore.updateThreadId(session.sessionId, 0);

        // Do NOT close the topic, do NOT post session end summary (SESS-06)
        return;
      }

      // Normal session end: clean up monitoring
      const monitor = monitors.get(session.sessionId);
      if (monitor) {
        monitor.transcriptWatcher.stop();
        monitor.summaryTimer.stop();

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
      seenAskIds.delete(session.sessionId);

      const summary = formatSessionEnd(latest, 'completed');
      // Send immediately (not batched) -- this is a lifecycle event
      await batcher.enqueueImmediate(latest.threadId, summary);
      // Unregister topic from status tracking before closing
      topicStatusManager.unregisterTopic(latest.threadId);
      // Close the topic
      await topicManager.closeTopic(latest.threadId, latest.topicName);
    },

    onToolUse: async (session, payload) => {
      // Check if this tool had a pending Telegram approval message.
      // If so, the user approved locally — update the Telegram message.
      const pendingApproval = approvalManager.resolvePending(payload.tool_use_id);
      if (pendingApproval) {
        const updatedText = formatApprovalResult('allow', 'locally', pendingApproval.originalHtml);
        try {
          await bot.api.editMessageText(config.telegramChatId, pendingApproval.messageId, updatedText, {
            parse_mode: 'HTML',
            reply_markup: undefined,
          });
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('message is not modified'))) {
            console.warn('Failed to update local approval message:', err instanceof Error ? err.message : err);
          }
        }
      }

      // Set topic to yellow (processing) -- debounced, won't spam API
      topicStatusManager.setStatus(session.threadId, 'yellow');

      const result = formatToolCompact(payload);

      // Track expand data for this thread's pending batch
      if (result.expandContent) {
        let pending = pendingExpandData.get(session.threadId);
        if (!pending) {
          pending = [];
          pendingExpandData.set(session.threadId, pending);
        }
        pending.push({ toolName: result.toolName, expandContent: result.expandContent });
      }

      // Subagent prefix: if a subagent is active, prepend [agentName]
      // Suppressed when subagentOutput is false — skip display and expand data
      const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
      let displayLine: string;
      if (activeAgent) {
        if (!runtimeSettings.subagentOutput) {
          // Suppressed: skip display and expand data, but still update status message
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
        const indent = subagentTracker.getIndent(activeAgent.agentId);
        const prefix = `${indent}[${escapeHtml(activeAgent.displayName)}] `;
        displayLine = prefix + result.compact;
      } else {
        displayLine = result.compact;
      }

      // Enqueue compact one-liner (batched with 2s window)
      batcher.enqueue(session.threadId, displayLine);

      // Update status message with current tool
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
      // Suppress idle notifications — status message already shows idle state
      if (payload.notification_type === 'idle_prompt') return;

      // Suppress permission_prompt notifications in bypass mode — they're misleading
      const permMode = payload.permission_mode || session.permissionMode;
      if (
        payload.notification_type === 'permission_prompt'
        && (permMode === 'bypassPermissions' || permMode === 'dontAsk')
      ) {
        return;
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

    // PreToolUse: informational message to Telegram (non-blocking).
    // Claude Code shows its local dialog. Telegram buttons send keystrokes via tmux.
    onPreToolUse: async (session, payload: PreToolUsePayload) => {
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

      // Bypass mode: batch tool calls instead of sending individual approval messages
      const permMode = payload.permission_mode || session.permissionMode;
      if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        return;
      }

      // Format approval request message
      let approvalHtml = formatApprovalRequest(payload);

      // Prefix with agent name if tool call is from a subagent
      const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
      if (activeAgent) {
        const indent = subagentTracker.getIndent(activeAgent.agentId);
        const agentPrefix = `${indent}<b>[${escapeHtml(activeAgent.displayName)}]</b> `;
        approvalHtml = agentPrefix + approvalHtml;
      }

      console.log(`[PERM] Permission request for ${payload.tool_name} (local dialog shown)`);

      const keyboard = makeApprovalKeyboard(payload.tool_use_id);

      // Post informational message with Approve/Deny buttons
      const msg = await bot.api.sendMessage(config.telegramChatId, approvalHtml, {
        message_thread_id: session.threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      // Track pending approval for Telegram message updates
      approvalManager.trackPending(
        payload.tool_use_id,
        session.sessionId,
        session.threadId,
        msg.message_id,
        payload.tool_name,
        approvalHtml,
      );

      // Set topic to green -- waiting for user approval (= waiting for input)
      topicStatusManager.setStatus(session.threadId, 'green');
    },

    onStop: async (session, _payload) => {
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

      console.log(`[AGENT] Subagent ${agent.displayName} (${payload.agent_id}) spawned for session ${session.sessionId} (depth ${agent.depth})`);
    },

    onSubagentStop: async (session, payload) => {
      const result = subagentTracker.stop(payload.agent_id);
      if (!result) {
        console.warn(`[AGENT] SubagentStop for unknown agent: ${payload.agent_id}`);
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

      console.log(`[AGENT] Subagent ${result.agent.displayName} (${payload.agent_id}) done after ${Math.round(result.durationMs / 1000)}s`);
    },
  };

  // 9. Create hook handlers with session store and callbacks
  const handlers = createHookHandlers(sessionStore, callbacks);

  // 10. Create Fastify hook server and START LISTENING IMMEDIATELY.
  //     The server must accept connections before any slow startup work
  //     (gray sweep, reconnection, settings init) that could take seconds.
  //     Hooks are already installed in settings.json (step 2), so any Claude
  //     Code session that fires a hook during startup needs a listening server.
  const server = await createHookServer(config, handlers,
    // onAgentToolDetected: stash Agent/Task description for SubagentStart correlation
    (sessionId, toolName, toolInput) => {
      const desc = (toolInput.description as string) || (toolInput.prompt as string) || '';
      subagentTracker.stashDescription(sessionId, (toolInput.subagent_type as string) || 'unknown', desc);
    },
  );

  await server.listen({
    port: config.hookServerPort,
    host: config.hookServerHost,
  });
  console.log(
    `Fastify hook server listening on ${config.hookServerHost}:${config.hookServerPort}`,
  );

  // 11. Phase 9: Startup gray sweep -- mark all active sessions as offline
  //     Sequential with delay to avoid editForumTopic rate limits.
  //     Runs BEFORE reconnect loop so users see gray while bot reconnects.
  const sessionsToSweep = sessionStore.getActiveSessions();
  for (const session of sessionsToSweep) {
    if (session.threadId > 0) {
      try {
        await topicStatusManager.setStatusImmediate(session.threadId, 'gray', session.topicName);
      } catch (err) {
        console.warn(
          `Gray sweep: failed to update topic ${session.threadId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      // Brief delay between calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (sessionsToSweep.length > 0) {
    console.log(`Gray sweep: marked ${sessionsToSweep.length} topic(s) as offline`);
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
            console.log(`Topic ${threadId} for session ${session.sessionId} was deleted, creating new`);
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
      console.warn(
        `Failed to reconnect session ${session.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (reconnectedCount > 0) {
    console.log(
      `Reconnected to ${reconnectedCount} active session(s)`,
    );
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
    console.log(`Cleaned up ${staleCount} stale pending approval(s)`);
  }

  // 11c. Phase 12: Initialize settings topic
  const settingsTopic = new SettingsTopic(bot, config.telegramChatId, runtimeSettings, getInactiveCount);
  settingsTopicRef = settingsTopic;
  try {
    const settingsThreadId = await settingsTopic.init();
    console.log(`Settings topic ready: thread ${settingsThreadId}`);
  } catch (err) {
    console.error('Failed to initialize settings topic:', err instanceof Error ? err.message : err);
    // Non-fatal: bot continues without settings topic
  }

  // 12. Start Telegram bot (hook server already listening from step 10)
  bot.start();
  console.log('Telegram bot started (polling)');

  // 12b. Register discovered commands with Telegram autocomplete menu
  const botCommands = commandRegistry.getEntries().map((e) => ({
    command: e.telegramName,
    description: e.description.slice(0, 256),
  }));
  if (botCommands.length > 100) {
    console.warn(`Command count ${botCommands.length} exceeds Telegram limit of 100; truncating`);
  }
  const toRegister = botCommands.slice(0, 100);
  if (toRegister.length > 0) {
    try {
      await bot.api.setMyCommands(toRegister, {
        scope: { type: 'chat', chat_id: config.telegramChatId },
      });
      console.log(`Registered ${toRegister.length} commands with Telegram`);
    } catch (err) {
      console.warn('Failed to register Telegram commands:', err instanceof Error ? err.message : err);
    }
  }

  console.log('Startup complete');

  // 13. Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    // Stop all monitoring instances
    for (const [, monitor] of monitors) {
      monitor.transcriptWatcher.stop();
      monitor.summaryTimer.stop();
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
    // Clean up permission mode and subagent tracker state for all sessions
    for (const session of sessionStore.getActiveSessions()) {
      permissionModeManager.cleanup(session.sessionId);
      subagentTracker.cleanup(session.sessionId);
    }
    batcher.shutdown();
    bot.stop();
    await server.close();
    console.log('Shutdown complete');
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
