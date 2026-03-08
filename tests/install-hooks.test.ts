import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installHooks } from '../src/utils/install-hooks.js';
import { HOOK_SECRET_ENV_VAR } from '../src/utils/hook-secret.js';

describe('installHooks', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = mkdtempSync(join(tmpdir(), 'claude-o-gram-home-'));
    process.env.HOME = testHome;

    const claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        env: { EXISTING_VAR: 'keep-me' },
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('writes env-backed bearer headers and injects hook secret env var into settings', () => {
    installHooks(3456, 'test-secret');

    const settingsPath = join(testHome, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      env: Record<string, string>;
      hooks: {
        SessionEnd: Array<{
          hooks: Array<{
            headers: Record<string, string>;
            allowedEnvVars: string[];
          }>;
        }>;
      };
    };

    const header = settings.hooks.SessionEnd[0].hooks[0].headers.Authorization;
    expect(header).toBe(`Bearer $${HOOK_SECRET_ENV_VAR}`);
    expect(settings.hooks.SessionEnd[0].hooks[0].allowedEnvVars).toContain(HOOK_SECRET_ENV_VAR);
    expect(settings.env.EXISTING_VAR).toBe('keep-me');
    expect(settings.env[HOOK_SECRET_ENV_VAR]).toBe('test-secret');
  });

  it('logs verbose setup steps and user next actions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      installHooks(3456, 'test-secret');

      const logs = logSpy.mock.calls.map((call) => String(call[0]));
      expect(logs.some(line =>
        line.includes(`Environment variable location: ${join(testHome, '.claude', 'settings.json')} -> env.${HOOK_SECRET_ENV_VAR}`),
      )).toBe(true);
      expect(logs.some(line =>
        line.includes('Next step 1/3: Restart any running Claude Code sessions'),
      )).toBe(true);
      expect(logs.some(line =>
        line.includes('Next step 2/3: Start Claude Code in a fresh shell/session.'),
      )).toBe(true);
      expect(logs.some(line =>
        line.includes('Next step 3/3: End a Claude session once and confirm no 401'),
      )).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('configures SubagentStart as an HTTP hook with env-backed bearer auth', () => {
    installHooks(3456, 'test-secret');

    const settingsPath = join(testHome, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: {
        SubagentStart: Array<{
          hooks: Array<{
            type: string;
            url?: string;
            headers?: Record<string, string>;
            allowedEnvVars?: string[];
          }>;
        }>;
      };
    };

    const subagentStartHook = settings.hooks.SubagentStart[0].hooks[0];
    expect(subagentStartHook.type).toBe('http');
    expect(subagentStartHook.url).toBe('http://127.0.0.1:3456/hooks/subagent-start');
    expect(subagentStartHook.headers?.Authorization).toBe(`Bearer $${HOOK_SECRET_ENV_VAR}`);
    expect(subagentStartHook.allowedEnvVars).toContain(HOOK_SECRET_ENV_VAR);
  });

  it('removes legacy managed PreToolUse bridge entries on old ports while preserving user hooks', () => {
    const settingsPath = join(testHome, '.claude', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'http',
                  url: 'http://127.0.0.1:39456/hooks/pre-tool-use',
                  timeout: 10,
                  headers: {
                    Authorization: `Bearer $${HOOK_SECRET_ENV_VAR}`,
                  },
                  allowedEnvVars: [HOOK_SECRET_ENV_VAR],
                },
              ],
            },
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: '/usr/local/bin/custom-pretool-hook',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );

    installHooks(3456, 'test-secret');

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: {
        PreToolUse: Array<{
          hooks: Array<{
            type: string;
            url?: string;
            command?: string;
          }>;
        }>;
      };
    };

    const entries = settings.hooks.PreToolUse;
    const urls = entries.flatMap((entry) => entry.hooks.map((hook) => hook.url).filter(Boolean));
    const commands = entries.flatMap((entry) => entry.hooks.map((hook) => hook.command).filter(Boolean));

    expect(urls).toContain('http://127.0.0.1:3456/hooks/pre-tool-use');
    expect(urls).not.toContain('http://127.0.0.1:39456/hooks/pre-tool-use');
    expect(commands).toContain('/usr/local/bin/custom-pretool-hook');
  });
});
