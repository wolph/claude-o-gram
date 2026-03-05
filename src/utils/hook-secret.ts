import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_DIR = join(homedir(), '.claude-o-gram');
const SECRET_FILE = join(SECRET_DIR, 'hook-secret');
const ENV_VAR_NAME = 'CLAUDE_CODE_TELEGRAM_SECRET';

/**
 * Get or create the hook authentication secret.
 *
 * On first run, generates a random 256-bit hex secret and stores it at
 * ~/.claude-o-gram/hook-secret with mode 0o600 (owner-only).
 * On subsequent runs, reads the existing secret.
 *
 * Also sets the secret as an environment variable so Claude Code processes
 * (which inherit the bot's environment) can reference it in hook headers
 * via allowedEnvVars.
 */
export function getOrCreateHookSecret(): string {
  if (!existsSync(SECRET_DIR)) {
    mkdirSync(SECRET_DIR, { recursive: true });
  }

  let secret: string;

  if (existsSync(SECRET_FILE)) {
    secret = readFileSync(SECRET_FILE, 'utf-8').trim();
    if (secret.length < 32) {
      // Corrupted or too short — regenerate
      secret = randomBytes(32).toString('hex');
      writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    }
  } else {
    secret = randomBytes(32).toString('hex');
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    // Ensure permissions even if umask was permissive
    chmodSync(SECRET_FILE, 0o600);
  }

  // Set env var so Claude Code sessions inherit it
  process.env[ENV_VAR_NAME] = secret;

  return secret;
}

/** The environment variable name used for hook auth */
export { ENV_VAR_NAME as HOOK_SECRET_ENV_VAR };
