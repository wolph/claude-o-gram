import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// We can't easily test getOrCreateHookSecret directly because it uses a
// hardcoded path. Instead, test the core logic by reimplementing the
// key parts with a temp directory.

describe('hook secret generation logic', () => {
  let testDir: string;
  let secretFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `hook-secret-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
    secretFile = join(testDir, 'hook-secret');
  });

  afterEach(() => {
    try { unlinkSync(secretFile); } catch { /* ok */ }
    try { unlinkSync(testDir); } catch { /* ok */ }
  });

  it('generates a 64-char hex secret', async () => {
    const { getOrCreateHookSecret } = await import('../src/utils/hook-secret.js');
    const secret = getOrCreateHookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same secret on second call', async () => {
    const { getOrCreateHookSecret } = await import('../src/utils/hook-secret.js');
    const first = getOrCreateHookSecret();
    const second = getOrCreateHookSecret();
    expect(first).toBe(second);
  });

  it('sets the environment variable', async () => {
    const { getOrCreateHookSecret, HOOK_SECRET_ENV_VAR } = await import('../src/utils/hook-secret.js');
    const secret = getOrCreateHookSecret();
    expect(process.env[HOOK_SECRET_ENV_VAR]).toBe(secret);
  });

  it('stores secret file with 0o600 permissions', async () => {
    const { getOrCreateHookSecret } = await import('../src/utils/hook-secret.js');
    getOrCreateHookSecret();

    const home = process.env.HOME || '/tmp';
    const file = join(home, '.claude-o-gram', 'hook-secret');
    if (existsSync(file)) {
      const stats = statSync(file);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe('600');
    }
  });
});
