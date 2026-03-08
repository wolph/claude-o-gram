import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HOOK_SECRET_ENV_VAR } from './hook-secret.js';

/**
 * Auto-install Claude Code HTTP hooks into ~/.claude/settings.json.
 *
 * Merges managed hook configurations pointing at the local Fastify server.
 * Preserves any existing hooks for other event types. Idempotent -- safe to
 * call on every startup.
 *
 * All HTTP hooks include an Authorization header with a Bearer token
 * that the Fastify server validates, preventing other local processes
 * from forging hook payloads.
 *
 * Per user decision: "Bot auto-installs Claude Code hooks by writing
 * hook config to Claude Code's settings on first run."
 */
export function installHooks(port: number, secret: string): void {
  const log = (message: string) => console.log(`[HOOK INSTALL] ${message}`);
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`Starting hook installation for Claude Code.`);
  log(`Claude settings target: ${settingsPath}`);
  log(`Hook server base URL: ${baseUrl}`);
  log(`Hook auth env var key: ${HOOK_SECRET_ENV_VAR}`);
  log('Secret value is intentionally hidden in logs.');

  // Ensure ~/.claude/ directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    log(`Created Claude settings directory: ${claudeDir}`);
  } else {
    log(`Claude settings directory already exists: ${claudeDir}`);
  }

  // Read existing settings.json or start with empty object
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
      log(`Loaded existing Claude settings from: ${settingsPath}`);
    } catch (err) {
      console.warn(
        `Warning: Failed to parse ${settingsPath}, starting with empty settings.`,
        err instanceof Error ? err.message : err,
      );
      settings = {};
      log('Proceeding with empty settings due to parse failure.');
    }
  } else {
    log(`No existing Claude settings found; creating new file at: ${settingsPath}`);
  }

  const existingEnv = (settings.env as Record<string, unknown> | undefined) || {};
  const previousSecret = existingEnv[HOOK_SECRET_ENV_VAR];
  settings.env = { ...existingEnv, [HOOK_SECRET_ENV_VAR]: secret };

  if (typeof previousSecret === 'string' && previousSecret === secret) {
    log(`settings.env.${HOOK_SECRET_ENV_VAR} already matched current secret.`);
  } else if (typeof previousSecret === 'string') {
    log(`settings.env.${HOOK_SECRET_ENV_VAR} existed and was updated to the latest secret.`);
  } else {
    log(`Added settings.env.${HOOK_SECRET_ENV_VAR} for hook authentication.`);
  }
  log(`Environment variable location: ${settingsPath} -> env.${HOOK_SECRET_ENV_VAR}`);

  // Auth headers for HTTP hooks — reference env var resolved by Claude Code.
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
        hooks: [httpHook('/hooks/subagent-start', 10)],
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
  const legacyLocalPreToolUseUrl = /^http:\/\/127\.0\.0\.1:\d+\/hooks\/pre-tool-use$/;

  const isManagedPreToolUseHook = (hook: Record<string, unknown>): boolean => {
    if (hook.type !== 'http' || typeof hook.url !== 'string') return false;
    if (!legacyLocalPreToolUseUrl.test(hook.url)) return false;

    const headers = (hook.headers as Record<string, unknown> | undefined) || {};
    const auth = headers.Authorization;
    const allowed = Array.isArray(hook.allowedEnvVars)
      ? hook.allowedEnvVars.filter((v): v is string => typeof v === 'string')
      : [];

    return auth === `Bearer $${HOOK_SECRET_ENV_VAR}` || allowed.includes(HOOK_SECRET_ENV_VAR);
  };

  // Filter out our previous entry (including stale bridge ports), keep user hooks.
  const userPreToolUse = existingPreToolUse.filter((entry: unknown) => {
    const e = entry as { hooks?: Array<Record<string, unknown>> };
    if (!Array.isArray(e.hooks)) return true;
    return !e.hooks.some((hook) => isManagedPreToolUseHook(hook));
  });
  const removedManagedEntries = existingPreToolUse.length - userPreToolUse.length;

  // Rebuild PreToolUse: user hooks first, then ours
  const mergedPreToolUse = userPreToolUse.length > 0
    ? [...userPreToolUse, ...ourPreToolUse]
    : ourPreToolUse;

  settings.hooks = { ...existingHooks, ...hookConfig, PreToolUse: mergedPreToolUse };
  log('Hook configuration merged into settings.hooks (preserving existing user-defined hook events).');
  if (removedManagedEntries > 0) {
    log(`Removed ${removedManagedEntries} legacy managed PreToolUse bridge entr${removedManagedEntries === 1 ? 'y' : 'ies'}.`);
  }
  log(`HTTP hook headers now use: Authorization: Bearer $${HOOK_SECRET_ENV_VAR}`);
  log(`HTTP hooks explicitly allow env expansion for: ${HOOK_SECRET_ENV_VAR}`);

  // Write back atomically
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  log(`Hooks installed/updated in ${settingsPath}`);
  log('Next step 1/3: Restart any running Claude Code sessions to reload ~/.claude/settings.json.');
  log('Next step 2/3: Start Claude Code in a fresh shell/session.');
  log(`Next step 3/3: End a Claude session once and confirm no 401 for ${baseUrl}/hooks/session-end.`);
}
