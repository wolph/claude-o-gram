import type { VerbosityTier } from './monitoring.js';

/** Session information tracking a Claude Code session mapped to a Telegram topic */
export interface SessionInfo {
  /** Claude Code session ID */
  sessionId: string;
  /** Telegram message_thread_id for the forum topic */
  threadId: number;
  /** Project directory (cwd from hook payload) */
  cwd: string;
  /** Display name shown in the Telegram forum topic */
  topicName: string;
  /** ISO timestamp of when the session started */
  startedAt: string;
  /** Whether the session is active or closed */
  status: 'active' | 'closed';
  /** Path to the JSONL transcript file */
  transcriptPath: string;
  /** Count of tool calls observed during the session (for final summary) */
  toolCallCount: number;
  /**
   * Files changed during the session (for final summary).
   * In-memory: Set<string> for deduplication.
   * Serialized to JSON as string[].
   */
  filesChanged: Set<string> | string[];

  // --- Phase 2 monitoring fields ---

  /** Per-session verbosity override, defaults from config.defaultVerbosity */
  verbosity: VerbosityTier;
  /** Telegram message_id of the pinned status message (0 if not yet created) */
  statusMessageId: number;
  /** Tool name -> count of suppressed (not posted) calls, for periodic summary */
  suppressedCounts: Record<string, number>;
  /** Last known context window usage percentage */
  contextPercent: number;
  /** ISO timestamp of the last hook event, for idle detection */
  lastActivityAt: string;
}
