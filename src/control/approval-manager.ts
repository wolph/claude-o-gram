/** State for a single pending approval awaiting user decision */
export interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void;
  sessionId: string;
  messageId: number;    // Telegram message ID (for editing after decision)
  threadId: number;     // Telegram forum topic thread ID
  toolName: string;     // Tool name for logging/display
  createdAt: number;    // Date.now() timestamp for display
}

/**
 * Manages pending tool approval decisions.
 *
 * Core pattern: HTTP handler creates a deferred promise, sends Telegram message
 * with Approve/Deny buttons, awaits the promise. When user taps a button,
 * the promise resolves and the HTTP handler returns the decision to Claude Code.
 *
 * PERM-01: No timeout -- waits indefinitely for user decision. The promise
 * resolves ONLY when decide() is called or cleanupSession()/shutdown()
 * auto-denies remaining pending approvals.
 *
 * Keyed by tool_use_id (UUID, unique per tool call). Single-threaded Node.js
 * guarantees Map operations are atomic -- no race conditions between button
 * presses.
 */
export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();

  constructor() {}

  /**
   * Create a pending approval and return a promise that resolves when
   * the user taps Approve/Deny.
   *
   * The returned promise ALWAYS resolves (never rejects) with 'allow' or 'deny'.
   * PERM-01: No timeout -- waits indefinitely until decide() or cleanup.
   */
  waitForDecision(
    toolUseId: string,
    sessionId: string,
    threadId: number,
    messageId: number,
    toolName: string,
  ): Promise<'allow' | 'deny'> {
    return new Promise<'allow' | 'deny'>((resolve) => {
      this.pending.set(toolUseId, {
        resolve,
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
   * the approval was already resolved (duplicate tap or cleanup).
   */
  decide(toolUseId: string, decision: 'allow' | 'deny'): PendingApproval | null {
    const entry = this.pending.get(toolUseId);
    if (!entry) return null; // Already resolved (duplicate tap or cleanup)
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
        this.pending.delete(toolUseId);
        entry.resolve('deny');
      }
    }
  }

  /** Clean up all pending approvals (shutdown). */
  shutdown(): void {
    for (const [, entry] of this.pending) {
      entry.resolve('deny');
    }
    this.pending.clear();
  }
}
