import type { PreToolUsePayload } from '../types/hooks.js';

/** Callback to send or edit a Telegram message */
export interface BypassBatchCallbacks {
  /** Send a new message to the thread. Returns the Telegram message ID. */
  send(threadId: number, html: string): Promise<number>;
  /** Edit an existing message in the thread. */
  edit(messageId: number, html: string): Promise<void>;
}

/** A buffered tool call entry */
interface BufferedEntry {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Per-session batch state */
interface SessionBatch {
  threadId: number;
  entries: BufferedEntry[];
  messageId: number;
  flushedCount: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastEntryAt: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_INTERVAL_MS = 10_000;
const INACTIVITY_RESET_MS = 30_000;

/**
 * Batches auto-approved tool calls in bypass mode into rolling Telegram messages.
 *
 * Per session:
 * - Accumulates tool descriptions as PreToolUse fires.
 * - Every 10 seconds, sends or edits a single Telegram message with all entries.
 * - After 30 seconds of inactivity, resets — next entry starts a fresh message.
 */
export class BypassBatcher {
  private sessions = new Map<string, SessionBatch>();
  private callbacks: BypassBatchCallbacks;
  private formatFn: (entries: BufferedEntry[]) => string;

  constructor(
    callbacks: BypassBatchCallbacks,
    formatFn: (entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>) => string,
  ) {
    this.callbacks = callbacks;
    this.formatFn = formatFn;
  }

  add(sessionId: string, threadId: number, payload: PreToolUsePayload): void {
    let batch = this.sessions.get(sessionId);

    if (!batch) {
      batch = {
        threadId,
        entries: [],
        messageId: 0,
        flushedCount: 0,
        flushTimer: null,
        lastEntryAt: 0,
        inactivityTimer: null,
      };
      this.sessions.set(sessionId, batch);
    }

    batch.entries.push({
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
    });
    batch.lastEntryAt = Date.now();

    if (batch.inactivityTimer) {
      clearTimeout(batch.inactivityTimer);
    }
    batch.inactivityTimer = setTimeout(() => {
      this.resetBatch(sessionId);
    }, INACTIVITY_RESET_MS);

    if (!batch.flushTimer) {
      batch.flushTimer = setTimeout(() => {
        void this.flush(sessionId);
      }, FLUSH_INTERVAL_MS);
    }
  }

  cleanupSession(sessionId: string): void {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;
    if (batch.entries.length > batch.flushedCount) {
      void this.flush(sessionId);
    }
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    if (batch.inactivityTimer) clearTimeout(batch.inactivityTimer);
    this.sessions.delete(sessionId);
  }

  shutdown(): void {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      this.cleanupSession(sessionId);
    }
  }

  private resetBatch(sessionId: string): void {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;
    // Flush any unflushed entries before resetting
    if (batch.entries.length > batch.flushedCount) {
      void this.flush(sessionId);
    }
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    if (batch.inactivityTimer) clearTimeout(batch.inactivityTimer);
    batch.entries = [];
    batch.messageId = 0;
    batch.flushedCount = 0;
    batch.flushTimer = null;
    batch.inactivityTimer = null;
  }

  private async flush(sessionId: string): Promise<void> {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;

    batch.flushTimer = null;

    if (batch.entries.length <= batch.flushedCount) return;

    const html = this.formatFn(batch.entries);

    try {
      if (batch.messageId === 0) {
        batch.messageId = await this.callbacks.send(batch.threadId, html);
      } else {
        await this.callbacks.edit(batch.messageId, html);
      }
      batch.flushedCount = batch.entries.length;
    } catch (err) {
      console.warn(
        `[BYPASS] Failed to flush batch for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
