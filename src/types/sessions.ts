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
}
