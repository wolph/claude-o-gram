import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../types/config.js';
import type {
  SessionStartPayload,
  SessionEndPayload,
  PostToolUsePayload,
  NotificationPayload,
  PreToolUsePayload,
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
  handlers: HookHandlers
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

  // POST /hooks/pre-tool-use
  // BLOCKING: Unlike other hooks, this route awaits the handler.
  // The HTTP connection stays open until the user approves/denies or timeout fires.
  // Claude Code waits for the response before proceeding with the tool call.
  fastify.post<{ Body: PreToolUsePayload }>(
    '/hooks/pre-tool-use',
    async (request) => {
      const payload = request.body as PreToolUsePayload;

      // AUTO_APPROVE bypass: skip approval, return allow immediately
      if (config.autoApprove) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Auto-approved (AUTO_APPROVE=true)',
          },
        };
      }

      // If permission_mode indicates Claude auto-approves, mirror that behavior.
      // Don't interrupt with approval prompts for tools Claude itself wouldn't prompt for.
      if (
        payload.permission_mode === 'bypassPermissions' ||
        payload.permission_mode === 'dontAsk'
      ) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Auto-approved (permission mode)',
          },
        };
      }

      try {
        // Delegate to handler -- THIS AWAITS until user decides or timeout
        return await handlers.handlePreToolUse(payload);
      } catch (err) {
        request.log.error(err, 'Error handling pre-tool-use hook');
        // On error, allow the tool call (non-blocking error behavior)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Auto-approved (hook error)',
          },
        };
      }
    }
  );

  // GET /health -- debugging and monitoring endpoint
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  return fastify;
}
