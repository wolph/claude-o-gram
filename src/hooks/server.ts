import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../types/config.js';
import type {
  SessionStartPayload,
  SessionEndPayload,
  PostToolUsePayload,
  NotificationPayload,
  PreToolUsePayload,
  StopPayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from '../types/hooks.js';
import type { HookHandlers } from './handlers.js';
/**
 * Create and configure the Fastify HTTP server with hook routes.
 *
 * Registers POST endpoints for SessionStart, SessionEnd, and PostToolUse hooks.
 * All routes respond immediately with 200 {} to avoid blocking Claude Code.
 * Processing (especially Telegram API calls) happens asynchronously.
 *
 * Does NOT call fastify.listen() -- that is done in the entry point (Plan 04).
 */
export async function createHookServer(
  config: AppConfig,
  handlers: HookHandlers,
  onAgentToolDetected?: (sessionId: string, toolName: string, toolInput: Record<string, unknown>) => void,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: true });

  // POST /hooks/session-start
  fastify.post<{ Body: SessionStartPayload }>(
    '/hooks/session-start',
    async (request) => {
      try {
        await handlers.handleSessionStart(request.body as SessionStartPayload);
      } catch (err) {
        // Log but do not block Claude Code -- always return 200
        request.log.error(err, 'Error handling session-start hook');
      }
      return {};
    }
  );

  // POST /hooks/session-end
  fastify.post<{ Body: SessionEndPayload }>(
    '/hooks/session-end',
    async (request) => {
      try {
        await handlers.handleSessionEnd(request.body as SessionEndPayload);
      } catch (err) {
        request.log.error(err, 'Error handling session-end hook');
      }
      return {};
    }
  );

  // POST /hooks/post-tool-use
  // Fire and forget: do not await the handler to avoid slowing Claude Code (Pitfall 6)
  fastify.post<{ Body: PostToolUsePayload }>(
    '/hooks/post-tool-use',
    async (request) => {
      // Fire and forget -- process asynchronously
      handlers
        .handlePostToolUse(request.body as PostToolUsePayload)
        .catch((err) => {
          request.log.error(err, 'Error handling post-tool-use hook');
        });
      return {};
    }
  );

  // POST /hooks/notification
  // Fire and forget: process asynchronously to avoid slowing Claude Code
  fastify.post<{ Body: NotificationPayload }>(
    '/hooks/notification',
    async (request) => {
      handlers
        .handleNotification(request.body as NotificationPayload)
        .catch((err) => {
          request.log.error(err, 'Error handling notification hook');
        });
      return {};
    }
  );

  // POST /hooks/stop
  // Fire and forget: process asynchronously when Claude finishes responding
  fastify.post<{ Body: StopPayload }>(
    '/hooks/stop',
    async (request) => {
      handlers.handleStop(request.body as StopPayload).catch((err) => {
        request.log.error(err, 'Error handling stop hook');
      });
      return {};
    }
  );

  // POST /hooks/pre-tool-use
  // NON-BLOCKING: Returns {} immediately (no permission decision).
  // Claude Code shows its local permission dialog. The bot posts an
  // informational message to Telegram; Approve/Deny buttons send keystrokes
  // via tmux as a convenience.
  fastify.post<{ Body: PreToolUsePayload }>(
    '/hooks/pre-tool-use',
    async (request) => {
      const payload = request.body as PreToolUsePayload;

      // Stash Agent/Task description for SubagentStart correlation
      if (onAgentToolDetected && (payload.tool_name === 'Agent' || payload.tool_name === 'Task')) {
        onAgentToolDetected(payload.session_id, payload.tool_name, payload.tool_input);
      }

      // Fire and forget — post informational message to Telegram asynchronously
      handlers.handlePreToolUse(payload).catch((err) => {
        request.log.error(err, 'Error handling pre-tool-use hook');
      });

      // Return empty — no permission decision, let Claude Code show local dialog
      return {};
    }
  );

  // POST /hooks/subagent-start (fire-and-forget)
  // SubagentStart arrives via command hook bridge (shell script -> curl -> here)
  fastify.post<{ Body: SubagentStartPayload }>(
    '/hooks/subagent-start',
    async (request) => {
      handlers.handleSubagentStart(request.body as SubagentStartPayload)
        .catch((err) => {
          request.log.error(err, 'Error handling subagent-start hook');
        });
      return {};
    }
  );

  // POST /hooks/subagent-stop (fire-and-forget)
  fastify.post<{ Body: SubagentStopPayload }>(
    '/hooks/subagent-stop',
    async (request) => {
      handlers.handleSubagentStop(request.body as SubagentStopPayload)
        .catch((err) => {
          request.log.error(err, 'Error handling subagent-stop hook');
        });
      return {};
    }
  );

  // GET /health -- debugging and monitoring endpoint
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  return fastify;
}
