/** State for a single pending approval awaiting user decision */
export interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  messageId: number;    // Telegram message ID (for editing after decision)
  threadId: number;     // Telegram forum topic thread ID
  toolName: string;     // Tool name for logging/display
  createdAt: number;    // Date.now() timestamp for "Expired after Xm" display
}

/**
 * Manages pending tool approval decisions.
 *
 * Core pattern: HTTP handler creates a deferred promise, sends Telegram message
 * with Approve/Deny buttons, awaits the promise. When user taps a button (or
 * timeout fires), the promise resolves and the HTTP handler returns the decision
 * to Claude Code.
 *
 * Keyed by tool_use_id (UUID, unique per tool call). Single-threaded Node.js
 * guarantees Map operations are atomic -- no race conditions between button
 * press and timeout.
 */
export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private timeoutMs: number;
  private onTimeout: ((toolUseId: string, pending: PendingApproval) => void) | null = null;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Register a callback for when an approval times out.
   * Used by the wiring layer to edit the Telegram message with "Expired" text.
   */
  setTimeoutCallback(cb: (toolUseId: string, pending: PendingApproval) => void): void {
    this.onTimeout = cb;
  }

  /**
   * Create a pending approval and return a promise that resolves when
   * the user taps Approve/Deny or the timeout fires.
   *
   * The returned promise ALWAYS resolves (never rejects) with 'allow' or 'deny'.
   * On timeout, it resolves with 'deny' (auto-deny per user decision).
   */
  waitForDecision(
    toolUseId: string,
    sessionId: string,
    threadId: number,
    messageId: number,
    toolName: string,
  ): Promise<'allow' | 'deny'> {
    return new Promise<'allow' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(toolUseId);
        if (entry) {
          this.pending.delete(toolUseId);
          resolve('deny'); // auto-deny on timeout
          if (this.onTimeout) {
            this.onTimeout(toolUseId, entry);
          }
        }
      }, this.timeoutMs);

      this.pending.set(toolUseId, {
        resolve,
        timer,
        sessionId,
        messageId,
        threadId,
        toolName,
        createdAt: Date.now(),
      });
    });
  }

  /**
   * Resolve a pending approval with the user's decision.
   * Called by the grammY callback query handler when user taps Approve/Deny.
   *
   * Returns the PendingApproval entry (for editing the message) or null if
   * the approval was already resolved (timeout fired, or duplicate tap).
   */
  decide(toolUseId: string, decision: 'allow' | 'deny'): PendingApproval | null {
    const entry = this.pending.get(toolUseId);
    if (!entry) return null; // Already resolved (timeout or duplicate tap)
    clearTimeout(entry.timer);
    this.pending.delete(toolUseId);
    entry.resolve(decision);
    return entry;
  }

  /** True if an approval is currently pending for this tool_use_id */
  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  /** Get the number of currently pending approvals */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clean up all pending approvals for a session (e.g., on session end).
   * Auto-denies all pending approvals for the session.
   */
  cleanupSession(sessionId: string): void {
    for (const [toolUseId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pending.delete(toolUseId);
        entry.resolve('deny');
      }
    }
  }

  /** Clean up all pending approvals (shutdown). */
  shutdown(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve('deny');
    }
    this.pending.clear();
  }
}
