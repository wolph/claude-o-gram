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
import type { HookEvent } from '../runtime/runtime-status.js';

interface HookServerObservability {
  onHookReceived?: (event: HookEvent) => void;
  onAuthFailure?: (route: string) => void;
  onHandlerError?: (route: string, error: unknown) => void;
}
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
  hookSecret: string,
  onAgentToolDetected?: (sessionId: string, toolName: string, toolInput: Record<string, unknown>) => void,
  observability?: HookServerObservability,
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });

  // SECURITY: Validate Bearer token on all /hooks/* routes.
  // Rejects requests from other local processes that don't know the secret.
  // The /health endpoint is excluded (registered after this hook applies).
  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for non-hook routes (e.g. /health)
    if (!request.url.startsWith('/hooks/')) return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${hookSecret}`) {
      observability?.onAuthFailure?.(request.url);
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  });

  // POST /hooks/session-start
  fastify.post<{ Body: SessionStartPayload }>(
    '/hooks/session-start',
    async (request) => {
      observability?.onHookReceived?.('SessionStart');
      try {
        await handlers.handleSessionStart(request.body as SessionStartPayload);
      } catch (err) {
        observability?.onHandlerError?.('/hooks/session-start', err);
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
      observability?.onHookReceived?.('SessionEnd');
      try {
        await handlers.handleSessionEnd(request.body as SessionEndPayload);
      } catch (err) {
        observability?.onHandlerError?.('/hooks/session-end', err);
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
      observability?.onHookReceived?.('PostToolUse');
      // Fire and forget -- process asynchronously
      handlers
        .handlePostToolUse(request.body as PostToolUsePayload)
        .catch((err) => {
          observability?.onHandlerError?.('/hooks/post-tool-use', err);
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
      observability?.onHookReceived?.('Notification');
      handlers
        .handleNotification(request.body as NotificationPayload)
        .catch((err) => {
          observability?.onHandlerError?.('/hooks/notification', err);
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
      observability?.onHookReceived?.('Stop');
      handlers.handleStop(request.body as StopPayload).catch((err) => {
        observability?.onHandlerError?.('/hooks/stop', err);
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
      observability?.onHookReceived?.('PreToolUse');
      const payload = request.body as PreToolUsePayload;

      // Stash Agent/Task description for SubagentStart correlation
      if (onAgentToolDetected && (payload.tool_name === 'Agent' || payload.tool_name === 'Task')) {
        onAgentToolDetected(payload.session_id, payload.tool_name, payload.tool_input);
      }

      // Fire and forget — post informational message to Telegram asynchronously
      handlers.handlePreToolUse(payload).catch((err) => {
        observability?.onHandlerError?.('/hooks/pre-tool-use', err);
        request.log.error(err, 'Error handling pre-tool-use hook');
      });

      // Return empty — no permission decision, let Claude Code show local dialog
      return {};
    }
  );

  // POST /hooks/subagent-start (fire-and-forget)
  // SubagentStart arrives directly from an HTTP hook.
  fastify.post<{ Body: SubagentStartPayload }>(
    '/hooks/subagent-start',
    async (request) => {
      observability?.onHookReceived?.('SubagentStart');
      handlers.handleSubagentStart(request.body as SubagentStartPayload)
        .catch((err) => {
          observability?.onHandlerError?.('/hooks/subagent-start', err);
          request.log.error(err, 'Error handling subagent-start hook');
        });
      return {};
    }
  );

  // POST /hooks/subagent-stop (fire-and-forget)
  fastify.post<{ Body: SubagentStopPayload }>(
    '/hooks/subagent-stop',
    async (request) => {
      observability?.onHookReceived?.('SubagentStop');
      handlers.handleSubagentStop(request.body as SubagentStopPayload)
        .catch((err) => {
          observability?.onHandlerError?.('/hooks/subagent-stop', err);
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
