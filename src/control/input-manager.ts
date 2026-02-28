import { execSync } from 'node:child_process';

/**
 * Manages text input injection into Claude Code sessions.
 *
 * Primary mechanism: tmux programmatic input via bracketed paste.
 * When tmux is not available, text is queued for later delivery.
 *
 * Per user decision: "User replies to any bot message in the session topic.
 * Reply text is fed to Claude Code as user input."
 */
export class TextInputManager {
  /** Per-session input queues (sessionId -> queued text strings) */
  private queues = new Map<string, string[]>();

  /**
   * Inject text into the tmux pane running Claude Code.
   * Uses bracketed paste to avoid Ink autocomplete intercepting Enter.
   *
   * @param tmuxPane The tmux pane identifier (e.g., "%5")
   * @param text The text to inject (supports multi-line)
   * @returns true if injection succeeded, false if it failed
   */
  inject(tmuxPane: string, text: string): boolean {
    try {
      // Set tmux buffer to the text content
      execSync(`tmux set-buffer ${shellQuote(text)}`);
      // Paste with bracketed paste flag (-p) for reliable delivery
      execSync(`tmux paste-buffer -p -t ${shellQuote(tmuxPane)}`);
      // Send Enter to submit the pasted text
      execSync(`tmux send-keys -t ${shellQuote(tmuxPane)} Enter`);
      return true;
    } catch (err) {
      console.warn(
        'Failed to inject text via tmux:',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /**
   * Attempt to send text to a session. If tmux pane is available, injects
   * directly. Otherwise, queues for later delivery.
   *
   * @returns 'sent' if delivered, 'queued' if queued for later, 'failed' if error
   */
  send(tmuxPane: string | null, sessionId: string, text: string): 'sent' | 'queued' | 'failed' {
    if (!tmuxPane) {
      this.queue(sessionId, text);
      return 'queued';
    }

    const success = this.inject(tmuxPane, text);
    if (success) {
      return 'sent';
    }

    // tmux injection failed -- queue as fallback
    this.queue(sessionId, text);
    return 'queued';
  }

  /**
   * Queue text for a session that isn't in tmux or isn't waiting for input.
   */
  queue(sessionId: string, text: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(text);
    this.queues.set(sessionId, q);
  }

  /**
   * Dequeue and return the next queued text for a session, or null if empty.
   */
  dequeue(sessionId: string): string | null {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    return q.shift() ?? null;
  }

  /**
   * Get the number of queued messages for a session.
   */
  queueSize(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /**
   * Clean up queues for a session (e.g., on session end).
   */
  cleanup(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}

/**
 * Shell-escape a string for use in execSync commands.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
