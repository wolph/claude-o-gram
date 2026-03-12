import type { PreToolUsePayload } from '../types/hooks.js';

export interface StashedPreToolUse {
  toolUseId: string;
  sessionId: string;
  threadId: number;
  payload: PreToolUsePayload;
  agentPrefix: string | null;
  timer: ReturnType<typeof setTimeout>;
}

type FlushCallback = (sessionId: string, threadId: number, payload: PreToolUsePayload) => void;

/**
 * Per-session FIFO queue of PreToolUse payloads awaiting Notification correlation.
 *
 * PreToolUse events are stashed here instead of immediately sending approval buttons.
 * When a permission_prompt Notification arrives, the oldest entry is popped and
 * promoted to an approval message. If no Notification arrives within the timeout,
 * the entry is flushed to the bypassBatcher (it was auto-approved).
 */
export class PreToolUseStash {
  private queues = new Map<string, StashedPreToolUse[]>();
  private timeoutMs: number;
  private onFlush: FlushCallback;

  constructor(timeoutMs: number, onFlush: FlushCallback) {
    this.timeoutMs = timeoutMs;
    this.onFlush = onFlush;
  }

  /** Stash a PreToolUse payload. Starts a timer that flushes to bypassBatcher on expiry. */
  push(
    sessionId: string,
    threadId: number,
    payload: PreToolUsePayload,
    agentPrefix: string | null,
  ): void {
    const entry: StashedPreToolUse = {
      toolUseId: payload.tool_use_id,
      sessionId,
      threadId,
      payload,
      agentPrefix,
      timer: setTimeout(() => {
        // Timer fired — no Notification came, tool was auto-approved
        const removed = this.removeByToolUseId(sessionId, payload.tool_use_id);
        if (removed) {
          this.onFlush(sessionId, threadId, payload);
        }
      }, this.timeoutMs),
    };

    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }
    queue.push(entry);
  }

  /** Pop the oldest stashed entry for a session (used by Notification handler). */
  popOldest(sessionId: string): StashedPreToolUse | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift()!;
    clearTimeout(entry.timer);
    if (queue.length === 0) this.queues.delete(sessionId);
    return entry;
  }

  /** Remove a specific entry by toolUseId (used by PostToolUse handler). */
  removeByToolUseId(sessionId: string, toolUseId: string): StashedPreToolUse | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue) return undefined;
    const idx = queue.findIndex(e => e.toolUseId === toolUseId);
    if (idx === -1) return undefined;
    const [entry] = queue.splice(idx, 1);
    clearTimeout(entry.timer);
    if (queue.length === 0) this.queues.delete(sessionId);
    return entry;
  }

  /** Clear all stashed entries for a session (used by SessionEnd). */
  cleanupSession(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    for (const entry of queue) clearTimeout(entry.timer);
    this.queues.delete(sessionId);
  }

  /** Cancel all timers (used on shutdown). */
  shutdown(): void {
    for (const queue of this.queues.values()) {
      for (const entry of queue) clearTimeout(entry.timer);
    }
    this.queues.clear();
  }
}
