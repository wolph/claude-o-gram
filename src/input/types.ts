/** Result of an input send attempt */
export type SendResult =
  | { status: 'sent' }
  | { status: 'failed'; error: string };

/**
 * Interface for delivering text input to a Claude Code session.
 * Implementations: tmux send-keys, FIFO write, SDK resume.
 */
export interface InputSender {
  /** Human-readable name for logging/status messages */
  readonly method: 'tmux' | 'fifo' | 'sdk-resume';

  /** Send text to the session. Returns status. */
  send(text: string): Promise<SendResult>;

  /** Clean up resources (called on session end) */
  cleanup(): void;
}
