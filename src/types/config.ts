import type { VerbosityTier } from './monitoring.js';

/** Application configuration schema */
export interface AppConfig {
  /** Telegram bot token from @BotFather */
  telegramBotToken: string;
  /** Telegram group chat ID (negative number for supergroups) */
  telegramChatId: number;
  /** Port for the hook HTTP server (default: 3456) */
  hookServerPort: number;
  /** Host for the hook HTTP server (default: '127.0.0.1') */
  hookServerHost: string;
  /** Directory for persistent data like session maps (default: './data') */
  dataDir: string;

  // --- Phase 2 monitoring config ---

  /** Default verbosity tier for new sessions (from VERBOSITY_DEFAULT env var) */
  defaultVerbosity: VerbosityTier;
  /** Idle alert timeout in milliseconds (default: 120000 = 2 minutes) */
  idleTimeoutMs: number;
  /** Periodic summary interval in milliseconds (default: 300000 = 5 minutes) */
  summaryIntervalMs: number;

  // --- Phase 3 control config ---

  /** Approval timeout in milliseconds before auto-deny (default: 300000 = 5 minutes) */
  approvalTimeoutMs: number;
  /** When true, bypass all approval prompts and auto-allow (default: false) */
  autoApprove: boolean;

  // --- Phase 10 sub-agent suppression config ---

  /** When true, sub-agent output (spawn/done, tools, text) is shown in Telegram. Default false. */
  subagentOutput: boolean;

}
