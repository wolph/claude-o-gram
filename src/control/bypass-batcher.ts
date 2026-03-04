import type { PreToolUsePayload } from '../types/hooks.js';

/** Callback to send or edit a Telegram message */
export interface BypassBatchCallbacks {
  /** Send a new message to the thread. Returns the Telegram message ID. */
  send(threadId: number, html: string, expanded: boolean): Promise<number>;
  /** Edit an existing message in the thread. */
  edit(messageId: number, html: string, expanded: boolean): Promise<void>;
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

/** Stored data for a flushed batch message (persists after batch reset) */
interface MessageSnapshot {
  entries: BufferedEntry[];
  expanded: boolean;
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
 * - Supports expand/collapse toggling of individual batch messages.
 */
export class BypassBatcher {
  private sessions = new Map<string, SessionBatch>();
  private callbacks: BypassBatchCallbacks;
  private formatFn: (entries: BufferedEntry[], expanded: boolean) => string;

  /** Snapshot of entries per message ID — persists across batch resets for expand */
  private messageData = new Map<number, MessageSnapshot>();
  /** Track all message IDs per session for cleanup */
  private sessionMessageIds = new Map<string, number[]>();

  constructor(
    callbacks: BypassBatchCallbacks,
    formatFn: (entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>, expanded: boolean) => string,
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

  /**
   * Toggle expand/collapse for a batch message.
   * Returns true if the message was found and toggled.
   */
  async toggleExpand(messageId: number): Promise<boolean> {
    const data = this.messageData.get(messageId);
    if (!data) return false;

    data.expanded = !data.expanded;
    const html = this.formatFn(data.entries, data.expanded);
    try {
      await this.callbacks.edit(messageId, html, data.expanded);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('[BYPASS] Failed to toggle expand:', err instanceof Error ? err.message : err);
      }
    }
    return true;
  }

  cleanupSession(sessionId: string): void {
    const batch = this.sessions.get(sessionId);
    if (batch) {
      if (batch.entries.length > batch.flushedCount) {
        void this.flush(sessionId);
      }
      if (batch.flushTimer) clearTimeout(batch.flushTimer);
      if (batch.inactivityTimer) clearTimeout(batch.inactivityTimer);
      this.sessions.delete(sessionId);
    }

    // Clean up message data for this session
    const msgIds = this.sessionMessageIds.get(sessionId);
    if (msgIds) {
      for (const id of msgIds) {
        this.messageData.delete(id);
      }
      this.sessionMessageIds.delete(sessionId);
    }
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

    // Respect user's expand state if they toggled it
    const existingData = batch.messageId > 0 ? this.messageData.get(batch.messageId) : null;
    const expanded = existingData?.expanded ?? false;

    const html = this.formatFn(batch.entries, expanded);

    try {
      if (batch.messageId === 0) {
        batch.messageId = await this.callbacks.send(batch.threadId, html, expanded);
        // Track messageId for session cleanup
        let ids = this.sessionMessageIds.get(sessionId);
        if (!ids) {
          ids = [];
          this.sessionMessageIds.set(sessionId, ids);
        }
        ids.push(batch.messageId);
      } else {
        await this.callbacks.edit(batch.messageId, html, expanded);
      }
      batch.flushedCount = batch.entries.length;

      // Store/update snapshot for expand toggle
      this.messageData.set(batch.messageId, {
        entries: [...batch.entries],
        expanded,
      });
    } catch (err) {
      console.warn(
        `[BYPASS] Failed to flush batch for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
