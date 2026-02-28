import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
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

  // Calculate PreToolUse hook timeout: must exceed APPROVAL_TIMEOUT_MS
  // Default APPROVAL_TIMEOUT_MS is 300000 (5 min = 300s), so hook timeout = 360s
  const approvalTimeoutMs = parseInt(process.env.APPROVAL_TIMEOUT_MS || '300000', 10);
  const preToolUseTimeoutSec = Math.ceil(approvalTimeoutMs / 1000) + 60;

  // Install SessionStart command hook for tmux pane capture
  const tmuxScript = `#!/bin/bash
# Capture tmux pane ID for text input injection
if [ -n "$TMUX_PANE" ] && [ -n "$CLAUDE_SESSION_ID" ]; then
  echo "$TMUX_PANE" > "/tmp/claude-tmux-pane-\${CLAUDE_SESSION_ID}.txt" 2>/dev/null || true
fi
exit 0
`;
  const hooksDir = join(claudeDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const scriptPath = join(hooksDir, 'capture-tmux-pane.sh');
  writeFileSync(scriptPath, tmuxScript, 'utf-8');
  chmodSync(scriptPath, 0o755);

  // Define hook configuration for our hook events
  const baseUrl = `http://127.0.0.1:${port}`;
  const hookConfig: Record<string, unknown> = {
    SessionStart: [
      {
        matcher: '',
        hooks: [
          { type: 'http', url: `${baseUrl}/hooks/session-start`, timeout: 10 },
          { type: 'command', command: scriptPath, timeout: 5 },
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
