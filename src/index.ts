import { join } from 'node:path';
import { loadConfig } from './config.js';
import { SessionStore } from './sessions/session-store.js';
import { createHookHandlers, type HookCallbacks } from './hooks/handlers.js';
import { createHookServer } from './hooks/server.js';
import { createBot, makeApprovalKeyboard } from './bot/bot.js';
import { TopicManager } from './bot/topics.js';
import { MessageBatcher } from './bot/rate-limiter.js';
import {
  formatSessionStart,
  formatSessionEnd,
  formatToolCompact,
  formatNotification,
  formatApprovalRequest,
  formatApprovalExpired,
} from './bot/formatter.js';
import { installHooks } from './utils/install-hooks.js';
import { TranscriptWatcher, calculateContextPercentage } from './monitoring/transcript-watcher.js';
import { StatusMessage } from './monitoring/status-message.js';
import { SummaryTimer } from './monitoring/summary-timer.js';
import { ClearDetector } from './monitoring/clear-detector.js';
import { escapeHtml, markdownToHtml, isProceduralNarration, convertCommandsForTelegram } from './utils/text.js';
import { ApprovalManager } from './control/approval-manager.js';
import { InputRouter } from './input/input-router.js';
import { CommandRegistry } from './bot/command-registry.js';
import { expandCache, cacheKey } from './bot/expand-cache.js';
import { InlineKeyboard } from 'grammy';
import type { SessionInfo } from './types/sessions.js';
import type { StatusData } from './types/monitoring.js';
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

  // 4. Create control managers and input router
  const approvalManager = new ApprovalManager(config.approvalTimeoutMs);
  const inputRouter = new InputRouter();

  // 4b. Discover Claude Code commands for Telegram autocomplete
  const commandRegistry = new CommandRegistry();
  commandRegistry.discover();
  console.log(`Discovered ${commandRegistry.getEntries().length} Claude Code commands`);

  // 5. Create bot instance (with plugins, not yet started)
  const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry);

  // 6. Create topic manager wired to bot
  const topicManager = new TopicManager(bot, config.telegramChatId);

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

  // 8. Per-session monitoring instances
  const monitors = new Map<string, SessionMonitor>();

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
   * Handle a /clear event detected via filesystem watcher.
   * Mirrors the onSessionStart(source='clear') logic but triggered by
   * ClearDetector instead of HTTP hooks.
   */
  async function handleClearDetected(
    cwd: string,
    newTranscriptPath: string,
    newSessionId: string,
  ): Promise<void> {
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
      statusMessageId: 0,
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
      inputRouter.cleanup(oldSession.sessionId);
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

  // Phase 3: Track original message text for approval expiry edits
  const approvalMessageTexts = new Map<string, string>();
  // Track whether denials were caused by timeout (vs user button press)
  const timeoutDenials = new Set<string>();

  // Phase 3: Set up approval timeout callback
  approvalManager.setTimeoutCallback(async (toolUseId, pending) => {
    timeoutDenials.add(toolUseId);
    const originalText = approvalMessageTexts.get(toolUseId) || '';
    approvalMessageTexts.delete(toolUseId);
    try {
      const expiredText = formatApprovalExpired(originalText, config.approvalTimeoutMs);
      await bot.api.editMessageText(
        config.telegramChatId,
        pending.messageId,
        expiredText,
        { parse_mode: 'HTML', reply_markup: undefined },
      );
    } catch (err) {
      console.warn('Failed to edit expired approval message:', err instanceof Error ? err.message : err);
    }
  });

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

    // Start async initialization (status message send + pin) then start watchers
    void statusMsg.initialize().then((statusMessageId) => {
      sessionStore.updateStatusMessageId(session.sessionId, statusMessageId);
      // Set default verbosity from config
      sessionStore.updateVerbosity(session.sessionId, config.defaultVerbosity);
    }).catch((err) => {
      console.warn('Failed to initialize status message:', err instanceof Error ? err.message : err);
    });

    transcriptWatcher.start();
    summaryTimer.start();
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
              inputRouter.cleanup(oldSessionId);

              // Mark old session as closed since SessionEnd never did it
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

      if (source === 'resume' && session.threadId > 0) {
        // Resume: reopen existing topic and post resume message
        await topicManager.reopenTopic(session.threadId, session.topicName);
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
        inputRouter.cleanup(session.sessionId);

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

      // Clean up control state and input router
      approvalManager.cleanupSession(session.sessionId);
      inputRouter.cleanup(session.sessionId);

      const summary = formatSessionEnd(latest, 'completed');
      // Send immediately (not batched) -- this is a lifecycle event
      await batcher.enqueueImmediate(latest.threadId, summary);
      // Close the topic
      await topicManager.closeTopic(latest.threadId, latest.topicName);
    },

    onToolUse: async (session, payload) => {
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

      // Enqueue compact one-liner (batched with 2s window)
      batcher.enqueue(session.threadId, result.compact);

      // Update status message with current tool
      const monitor = monitors.get(session.sessionId);
      if (monitor) {
        const latestSession = sessionStore.get(session.sessionId);
        if (latestSession) {
          monitor.statusMessage.requestUpdate(
            buildStatusData(latestSession, payload.tool_name),
          );
          // Update topic description with compact status
          const ctx = latestSession.contextPercent || 0;
          monitor.statusMessage.updateTopicDescription(
            `\u{1F7E2} ${latestSession.topicName} | ${ctx}% ctx`,
          );
        }
      }
    },

    onNotification: async (session, payload) => {
      const html = formatNotification(payload);
      // Notify only for prompts that block Claude and need user action
      const shouldNotify = payload.notification_type === 'permission_prompt'
        || payload.notification_type === 'elicitation_dialog';
      await batcher.enqueueImmediate(session.threadId, html, shouldNotify);
    },

    onBackfillSummary: async (session, summary) => {
      await batcher.enqueueImmediate(session.threadId, summary);
    },

    // Phase 3: PreToolUse approval handler
    onPreToolUse: async (session, payload: PreToolUsePayload) => {
      // Format the approval request message
      const approvalHtml = formatApprovalRequest(payload);
      const keyboard = makeApprovalKeyboard(payload.tool_use_id);

      // Send approval message with inline keyboard to the session topic
      const msg = await bot.api.sendMessage(config.telegramChatId, approvalHtml, {
        message_thread_id: session.threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      // Store original text for expiry editing
      approvalMessageTexts.set(payload.tool_use_id, approvalHtml);

      // Wait for user decision or timeout -- THIS BLOCKS THE HTTP RESPONSE
      const decision = await approvalManager.waitForDecision(
        payload.tool_use_id,
        session.sessionId,
        session.threadId,
        msg.message_id,
        payload.tool_name,
      );

      // Clean up stored text (may already be cleaned by timeout callback)
      approvalMessageTexts.delete(payload.tool_use_id);

      // Build the hook response
      if (decision === 'allow') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Approved by user via Telegram',
          },
        };
      }

      // Determine if denial was user-initiated or timeout
      const isTimeout = timeoutDenials.has(payload.tool_use_id);
      timeoutDenials.delete(payload.tool_use_id);
      const reason = isTimeout
        ? 'Auto-denied: approval timeout'
        : 'Denied by user via Telegram';

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    },
  };

  // 9. Create hook handlers with session store and callbacks
  const handlers = createHookHandlers(sessionStore, callbacks);

  // 10. Create Fastify hook server (configured but not listening)
  const server = await createHookServer(config, handlers);

  // 11. Reconnect to existing sessions on restart
  //     Per user decision: "reconnect to existing topics from saved session map
  //     + post 'Bot restarted' notification"
  const activeSessions = sessionStore.getActiveSessions();
  for (const session of activeSessions) {
    if (session.threadId > 0) {
      try {
        // Re-initialize monitoring for active sessions on restart
        initMonitoring(session);
        // Start /clear detector (filesystem workaround for bug #6428)
        startClearDetector(session);
        // Re-detect input method
        void inputRouter.register(session.sessionId, session.cwd, session.permissionMode);
      } catch (err) {
        console.warn(
          `Failed to reconnect session in topic ${session.threadId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  if (activeSessions.length > 0) {
    console.log(
      `Reconnected to ${activeSessions.length} active session(s)`,
    );
  }

  // 12. Start both servers
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

  await server.listen({
    port: config.hookServerPort,
    host: config.hookServerHost,
  });
  console.log(
    `Fastify hook server listening on ${config.hookServerHost}:${config.hookServerPort}`,
  );
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
    // Stop all clear detectors
    for (const [, detector] of clearDetectors) {
      detector.stop();
    }
    clearDetectors.clear();
    // Phase 3: Clean up control managers
    approvalManager.shutdown();
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
