import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HOOK_SECRET_ENV_VAR } from './hook-secret.js';

/**
 * Auto-install Claude Code HTTP hooks into ~/.claude/settings.json.
 *
 * Merges SessionStart, SessionEnd, and PostToolUse hook configurations
 * pointing at the local Fastify server. Preserves any existing hooks
 * for other event types. Idempotent -- safe to call on every startup.
 *
 * All HTTP hooks include an Authorization header with a Bearer token
 * that the Fastify server validates, preventing other local processes
 * from forging hook payloads.
 *
 * Per user decision: "Bot auto-installs Claude Code hooks by writing
 * hook config to Claude Code's settings on first run."
 */
export function installHooks(port: number, secret: string): void {
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  // Ensure ~/.claude/ directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Write shell script bridge for SubagentStart (command-only hook)
  const hookDir = join(homedir(), '.claude-o-gram', 'hooks');
  if (!existsSync(hookDir)) {
    mkdirSync(hookDir, { recursive: true });
  }
  const scriptPath = join(hookDir, 'subagent-start.sh');
  // Include literal Bearer token in curl command (script is 0o755, readable by owner)
  const scriptContent = `#!/bin/bash
# Bridge: SubagentStart command hook -> HTTP server
curl -s --max-time 5 -X POST "http://127.0.0.1:${port}/hooks/subagent-start" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${secret}" \\
  -d @- < /dev/stdin
exit 0
`;
  writeFileSync(scriptPath, scriptContent, { mode: 0o700 });
  // Ensure permissions even if file already existed with different mode
  chmodSync(scriptPath, 0o700);

  // Read existing settings.json or start with empty object
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `Warning: Failed to parse ${settingsPath}, starting with empty settings.`,
        err instanceof Error ? err.message : err,
      );
      settings = {};
    }
  }

  // Define hook configuration for our hook events
  const baseUrl = `http://127.0.0.1:${port}`;

  // Auth headers for HTTP hooks — reference env var, resolved by Claude Code
  const authHeaders = { Authorization: `Bearer $${HOOK_SECRET_ENV_VAR}` };
  const allowedEnvVars = [HOOK_SECRET_ENV_VAR];

  // Helper to build an HTTP hook entry with auth
  const httpHook = (path: string, timeout: number) => ({
    type: 'http' as const,
    url: `${baseUrl}${path}`,
    timeout,
    headers: authHeaders,
    allowedEnvVars,
  });

  // PreToolUse hook is non-blocking (returns {} immediately, informational only).
  // Local Claude Code dialog handles the actual permission decision.
  const preToolUseTimeoutSec = 10;

  const hookConfig: Record<string, unknown> = {
    SessionStart: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/session-start', 10)],
      },
    ],
    SessionEnd: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/session-end', 10)],
      },
    ],
    PostToolUse: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/post-tool-use', 10)],
      },
    ],
    Notification: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/notification', 10)],
      },
    ],
    PreToolUse: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/pre-tool-use', preToolUseTimeoutSec)],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/stop', 10)],
      },
    ],
    SubagentStart: [
      {
        matcher: '',
        hooks: [
          { type: 'command', command: scriptPath, timeout: 10 },
        ],
      },
    ],
    SubagentStop: [
      {
        matcher: '',
        hooks: [httpHook('/hooks/subagent-stop', 10)],
      },
    ],
  };

  // Merge into settings: preserve existing hooks for other events
  const existingHooks =
    (settings.hooks as Record<string, unknown> | undefined) || {};

  // For PreToolUse, append our hook to existing user hooks rather than replacing
  const existingPreToolUse = (existingHooks.PreToolUse as unknown[]) || [];
  const ourPreToolUse = hookConfig.PreToolUse as unknown[];
  const ourUrl = `${baseUrl}/hooks/pre-tool-use`;

  // Filter out our previous entry (if any), keep all user hooks
  const userPreToolUse = existingPreToolUse.filter((entry: unknown) => {
    const e = entry as { hooks?: Array<{ url?: string }> };
    return !e.hooks?.some((h) => h.url === ourUrl);
  });

  // Rebuild PreToolUse: user hooks first, then ours
  const mergedPreToolUse = userPreToolUse.length > 0
    ? [...userPreToolUse, ...ourPreToolUse]
    : ourPreToolUse;

  settings.hooks = { ...existingHooks, ...hookConfig, PreToolUse: mergedPreToolUse };

  // Write back atomically
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  console.log(`Hooks installed/updated in ${settingsPath}`);
}
