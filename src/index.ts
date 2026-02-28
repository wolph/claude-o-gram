import { join } from 'node:path';
import { loadConfig } from './config.js';
import { SessionStore } from './sessions/session-store.js';
import { createHookHandlers, type HookCallbacks } from './hooks/handlers.js';
import { createHookServer } from './hooks/server.js';
import { createBot } from './bot/bot.js';
import { TopicManager } from './bot/topics.js';
import { MessageBatcher } from './bot/rate-limiter.js';
import {
  formatSessionStart,
  formatSessionEnd,
  formatToolUse,
  formatNotification,
} from './bot/formatter.js';
import { installHooks } from './utils/install-hooks.js';

/**
 * Main entry point for the Claude Code Telegram Bridge.
 *
 * Single-process daemon (per research Pattern 1) that:
 * 1. Auto-installs HTTP hooks into Claude Code's settings.json
 * 2. Starts a Fastify HTTP server to receive hook POSTs
 * 3. Starts a grammY Telegram bot for forum topic management
 * 4. Wires hook handlers to Telegram actions via HookCallbacks
 * 5. Reconnects to existing sessions on restart
 * 6. Handles graceful shutdown
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

  // 4. Create bot instance (with plugins, not yet started)
  const bot = await createBot(config, sessionStore);

  // 5. Create topic manager wired to bot
  const topicManager = new TopicManager(bot, config.telegramChatId);

  // 6. Create message batcher wired to topic manager
  const batcher = new MessageBatcher(
    (threadId, html) => topicManager.sendMessage(threadId, html),
    (threadId, content, filename, caption) =>
      topicManager.sendDocument(threadId, content, filename, caption),
  );

  // 7. Define HookCallbacks -- THE CRITICAL WIRING
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
    },

    onSessionEnd: async (session) => {
      // Re-fetch session from store to get latest toolCallCount/filesChanged
      const latest = sessionStore.get(session.sessionId) || session;
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
    },

    onNotification: async (session, payload) => {
      const text = formatNotification(payload);
      // Send immediately -- notifications are urgent (permission prompts, etc.)
      await batcher.enqueueImmediate(session.threadId, text);
    },
  };

  // 8. Create hook handlers with session store and callbacks
  const handlers = createHookHandlers(sessionStore, callbacks);

  // 9. Create Fastify hook server (configured but not listening)
  const server = await createHookServer(config, handlers);

  // 10. Reconnect to existing sessions on restart
  //     Per user decision: "reconnect to existing topics from saved session map
  //     + post 'Bot restarted' notification"
  const activeSessions = sessionStore.getActiveSessions();
  for (const session of activeSessions) {
    if (session.threadId > 0) {
      try {
        await topicManager.sendBotRestartNotice(session.threadId);
      } catch (err) {
        console.warn(
          `Failed to send restart notice to topic ${session.threadId}:`,
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

  // 11. Start both servers
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

  // 12. Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
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
