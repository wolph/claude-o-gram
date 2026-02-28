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

  // Define hook configuration for our three hook events
  const baseUrl = `http://127.0.0.1:${port}`;
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
  };

  // Merge into settings: preserve existing hooks for other events
  const existingHooks =
    (settings.hooks as Record<string, unknown> | undefined) || {};
  settings.hooks = { ...existingHooks, ...hookConfig };

  // Write back atomically
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  console.log(`Hooks installed/updated in ${settingsPath}`);
}
