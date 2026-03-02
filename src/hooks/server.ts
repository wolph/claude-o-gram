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
import type { PermissionModeManager } from '../control/permission-modes.js';

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
  permissionModeManager?: PermissionModeManager,
  onAutoApproved?: (sessionId: string, toolName: string, toolInput: Record<string, unknown>, toolUseId: string) => void,
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

      // Permission mode auto-approve: check BEFORE sending to Telegram
      if (permissionModeManager) {
        const session_id = payload.session_id;
        if (permissionModeManager.shouldAutoApprove(session_id, payload.tool_name, payload.tool_input)) {
          // PERM-08: Log to stdout before decision
          console.log(`[PERM] Auto-approving ${payload.tool_name} (${permissionModeManager.getMode(session_id).mode} mode) for session ${session_id}`);
          permissionModeManager.incrementAutoApproved(session_id);
          // Notify index.ts to post the lightning display line
          if (onAutoApproved) {
            onAutoApproved(session_id, payload.tool_name, payload.tool_input, payload.tool_use_id);
          }
          // PERM-08: Log to stdout after decision
          console.log(`[PERM] Auto-approved ${payload.tool_name} (tool_use_id: ${payload.tool_use_id})`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: `Auto-approved (${permissionModeManager.getMode(session_id).mode} mode)`,
            },
          };
        }
      }

      // PERM-08: Log manual approval prompt
      console.log(`[PERM] Prompting user for ${payload.tool_name} (tool_use_id: ${payload.tool_use_id})`);

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
