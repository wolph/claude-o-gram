import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK-based input manager that delivers text to Claude Code sessions
 * via the `query({ prompt, options: { resume } })` pattern.
 *
 * Replaces tmux-based text injection with a cross-platform, reliable
 * mechanism. Each `send()` call spawns a one-shot query that resumes
 * the target session, delivers the text, and drains the response stream
 * (output is captured by the existing hook server + transcript watcher).
 *
 * Key design decisions:
 * - One-shot query() per message (avoids double-turn bug #207)
 * - Per-session serialization (one active query at a time)
 * - 5-minute AbortController timeout (prevents orphaned processes #142)
 * - Response stream drained but NOT processed for Telegram (hook server handles that)
 */
export class SdkInputManager {
  /** Track active queries per session to serialize (one at a time) */
  private activeQueries = new Map<string, Promise<void>>();

  /**
   * Send text input to a Claude Code session via SDK resume.
   *
   * Serializes messages per session: if a query is already active for this
   * session, waits for it to complete before starting a new one.
   *
   * @param sessionId - The SDK session ID (same as hook payload session_id)
   * @param text - The user's text input from Telegram
   * @param cwd - The session's working directory
   * @returns 'sent' on success, { status: 'failed', error } on failure
   */
  async send(
    sessionId: string,
    text: string,
    cwd: string,
  ): Promise<{ status: 'sent' } | { status: 'failed'; error: string }> {
    // Wait for any active query on this session to complete first
    const activeQuery = this.activeQueries.get(sessionId);
    if (activeQuery) {
      try {
        await activeQuery;
      } catch {
        // Previous query failed -- proceed with new one
      }
    }

    // Create the query promise and track it
    const queryPromise = this.executeQuery(sessionId, text, cwd);
    this.activeQueries.set(sessionId, queryPromise);

    try {
      await queryPromise;
      return { status: 'sent' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`SDK resume input failed for session ${sessionId}:`, errorMsg);
      return { status: 'failed', error: errorMsg };
    } finally {
      // Only clear if this is still the tracked promise (not replaced by a newer one)
      if (this.activeQueries.get(sessionId) === queryPromise) {
        this.activeQueries.delete(sessionId);
      }
    }
  }

  private async executeQuery(sessionId: string, text: string, cwd: string): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 300_000); // 5 min

    try {
      const q = query({
        prompt: text,
        options: {
          resume: sessionId,
          cwd,
          abortController,
          // Do not load filesystem settings -- the external CLI session has its own
          settingSources: [],
        },
      });

      // Drain stream to completion. Output is captured by existing
      // hook server + transcript watcher -- we do NOT process it.
      try {
        for await (const message of q) {
          if (message.type === 'result') {
            break;
          }
        }
      } finally {
        q.close();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Clean up tracking for a closed session */
  cleanup(sessionId: string): void {
    this.activeQueries.delete(sessionId);
  }
}
