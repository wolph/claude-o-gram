import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Auto-install Claude Code HTTP hooks into ~/.claude/settings.json.
 *
 * Merges SessionStart, SessionEnd, and PostToolUse hook configurations
 * pointing at the local Fastify server. Preserves any existing hooks
 * for other event types. Idempotent -- safe to call on every startup.
 *
 * Per user decision: "Bot auto-installs Claude Code hooks by writing
 * hook config to Claude Code's settings on first run."
 */
export function installHooks(port: number): void {
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
  const scriptContent = `#!/bin/bash
# Bridge: SubagentStart command hook -> HTTP server
curl -s --max-time 5 -X POST "http://127.0.0.1:${port}/hooks/subagent-start" \\
  -H "Content-Type: application/json" \\
  -d @- < /dev/stdin
exit 0
`;
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

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

  // PERM-01: PreToolUse timeout set to 24 hours (86400s) for indefinite wait.
  // Approval prompts wait until user decides -- no auto-deny timeout.
  const preToolUseTimeoutSec = 86400;

  const hookConfig: Record<string, unknown> = {
    SessionStart: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/session-start`, timeout: 10 },
        ],
      },
    ],
    SessionEnd: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/session-end`, timeout: 10 },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/post-tool-use`, timeout: 10 },
        ],
      },
    ],
    Notification: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/notification`, timeout: 10 },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/pre-tool-use`, timeout: preToolUseTimeoutSec },
        ],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/stop`, timeout: 10 },
        ],
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
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/subagent-stop`, timeout: 10 },
        ],
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
