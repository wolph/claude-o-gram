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
  formatToolUse,
  formatNotification,
  formatApprovalRequest,
  formatApprovalExpired,
} from './bot/formatter.js';
import { installHooks } from './utils/install-hooks.js';
import { TranscriptWatcher, calculateContextPercentage } from './monitoring/transcript-watcher.js';
import { StatusMessage } from './monitoring/status-message.js';
import { SummaryTimer } from './monitoring/summary-timer.js';
import { escapeHtml, markdownToHtml } from './utils/text.js';
import { ApprovalManager } from './control/approval-manager.js';
import { SdkInputManager } from './sdk/input-manager.js';
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

  // 4. Phase 3/4: Create control managers
  const approvalManager = new ApprovalManager(config.approvalTimeoutMs);
  const sdkInputManager = new SdkInputManager();

  // 5. Create bot instance (with plugins, not yet started)
  const bot = await createBot(config, sessionStore, approvalManager, sdkInputManager);

  // 6. Create topic manager wired to bot
  const topicManager = new TopicManager(bot, config.telegramChatId);

  // 7. Create message batcher wired to topic manager
  const batcher = new MessageBatcher(
    (threadId, html, notify) => topicManager.sendMessage(threadId, html, notify),
    (threadId, content, filename, caption) =>
      topicManager.sendDocument(threadId, content, filename, caption),
  );

  // 8. Per-session monitoring instances
  const monitors = new Map<string, SessionMonitor>();

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
      (text) => {
        // Truncate to 500 chars inline, full as .txt attachment if longer
        if (text.length > 500) {
          const truncated = text.slice(0, 500) + '... (truncated)';
          batcher.enqueue(session.threadId, `<b>Claude:</b>\n${markdownToHtml(truncated)}`, {
            content: text,
            filename: 'claude-output.txt',
            caption: 'Full Claude output',
          });
        } else {
          batcher.enqueue(session.threadId, `<b>Claude:</b>\n${markdownToHtml(text)}`);
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
    onSessionStart: async (session, isResume) => {
      if (isResume && session.threadId > 0) {
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
    },

    onSessionEnd: async (session) => {
      // Re-fetch session from store to get latest toolCallCount/filesChanged
      const latest = sessionStore.get(session.sessionId) || session;

      // Clean up monitoring components
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

      // Phase 3/4: Clean up control state
      approvalManager.cleanupSession(session.sessionId);
      sdkInputManager.cleanup(session.sessionId);

      const summary = formatSessionEnd(latest, 'completed');
      // Send immediately (not batched) -- this is a lifecycle event
      await batcher.enqueueImmediate(latest.threadId, summary);
      // Close the topic
      await topicManager.closeTopic(latest.threadId, latest.topicName);
    },

    onToolUse: async (session, payload) => {
      const result = formatToolUse(payload);
      // Enqueue (batched) -- tool use messages are high frequency
      batcher.enqueue(session.threadId, result.text, result.attachment);

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
