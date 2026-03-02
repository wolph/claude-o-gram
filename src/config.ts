import 'dotenv/config';
import type { AppConfig } from './types/config.js';
import { parseVerbosityTier } from './monitoring/verbosity.js';

/**
 * Load and validate application configuration from environment variables.
 *
 * Required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional: HOOK_SERVER_PORT (default 3456), HOOK_SERVER_HOST (default '127.0.0.1'), DATA_DIR (default './data')
 *
 * Exits with a clear error message if required variables are missing.
 */
export function loadConfig(): AppConfig {
  const missing: string[] = [];

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }
  if (!process.env.TELEGRAM_CHAT_ID) {
    missing.push('TELEGRAM_CHAT_ID');
  }
  if (missing.length > 0) {
    console.error('');
    console.error('ERROR: Missing required environment variables:');
    console.error('');
    for (const varName of missing) {
      console.error(`  - ${varName}`);
    }
    console.error('');
    console.error('To configure, either:');
    console.error('  1. Copy .env.example to .env and fill in the values');
    console.error('  2. Set the variables in your shell environment');
    console.error('');
    console.error('See .env.example for all configuration options.');
    console.error('');
    process.exit(1);
  }

  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: parseInt(process.env.TELEGRAM_CHAT_ID!, 10),
    hookServerPort: parseInt(process.env.HOOK_SERVER_PORT || '3456', 10),
    hookServerHost: process.env.HOOK_SERVER_HOST || '127.0.0.1',
    dataDir: process.env.DATA_DIR || './data',
    defaultVerbosity: parseVerbosityTier(process.env.VERBOSITY_DEFAULT),
    idleTimeoutMs: parseInt(process.env.IDLE_TIMEOUT_MS || '120000', 10),
    summaryIntervalMs: parseInt(process.env.SUMMARY_INTERVAL_MS || '300000', 10),
    approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS || '300000', 10),
    autoApprove: process.env.AUTO_APPROVE === 'true',
    subagentOutput: process.env.SUBAGENT_VISIBLE === 'true',
  };
}
