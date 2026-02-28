/**
 * Per-session message debounce/batch queue (Layer 2 rate limiting).
 *
 * Layer 1 (grammY plugins: auto-retry + transformer-throttler) handles
 * Telegram API-level rate limits. This Layer 2 batches rapid per-session
 * message bursts into combined messages to reduce total API calls.
 *
 * PostToolUse events fire in rapid succession during active Claude Code
 * sessions. Without batching, each event would generate a separate Telegram
 * message, quickly hitting the 20 msg/min group limit.
 */

interface QueueEntry {
  messages: string[];
  attachments: Array<{
    content: string;
    filename: string;
    caption?: string;
  }>;
  timer: ReturnType<typeof setTimeout> | null;
}

export class MessageBatcher {
  private queues: Map<number, QueueEntry> = new Map();
  private sendFn: (threadId: number, html: string) => Promise<void>;
  private sendDocFn: (
    threadId: number,
    content: string,
    filename: string,
    caption?: string,
  ) => Promise<void>;
  private batchWindowMs: number;

  /**
   * @param sendFn Function to send HTML text to a topic (TopicManager.sendMessage)
   * @param sendDocFn Function to send a file attachment (TopicManager.sendDocument)
   * @param batchWindowMs Debounce window in milliseconds (default: 2000ms)
   */
  constructor(
    sendFn: (threadId: number, html: string) => Promise<void>,
    sendDocFn: (
      threadId: number,
      content: string,
      filename: string,
      caption?: string,
    ) => Promise<void>,
    batchWindowMs: number = 2000,
  ) {
    this.sendFn = sendFn;
    this.sendDocFn = sendDocFn;
    this.batchWindowMs = batchWindowMs;
  }

  /**
   * Enqueue a message for batched delivery.
   * Messages are held for batchWindowMs before being combined and sent.
   * Each new message resets the debounce timer.
   */
  enqueue(
    threadId: number,
    message: string,
    attachment?: { content: string; filename: string; caption?: string },
  ): void {
    let queue = this.queues.get(threadId);
    if (!queue) {
      queue = { messages: [], attachments: [], timer: null };
      this.queues.set(threadId, queue);
    }

    queue.messages.push(message);
    if (attachment) {
      queue.attachments.push(attachment);
    }

    // Reset debounce timer
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    queue.timer = setTimeout(() => {
      void this.flush(threadId);
    }, this.batchWindowMs);
  }

  /**
   * Enqueue a message for immediate delivery (no batching).
   * Used for lifecycle messages (session start, session end, bot restart notices)
   * that should not be delayed or combined with tool use messages.
   *
   * Flushes any pending messages for this threadId first, then sends immediately.
   */
  async enqueueImmediate(threadId: number, message: string): Promise<void> {
    // Flush any pending messages first so ordering is preserved
    await this.flush(threadId);
    // Send immediately
    await this.sendFn(threadId, message);
  }

  /**
   * Flush all pending messages for a specific threadId.
   * Combines queued messages with double newline separators.
   * If combined text exceeds 4096 chars, splits on message boundaries.
   */
  async flush(threadId: number): Promise<void> {
    const queue = this.queues.get(threadId);
    if (!queue || queue.messages.length === 0) {
      // Still process attachments if any
      if (queue && queue.attachments.length > 0) {
        const attachments = [...queue.attachments];
        queue.attachments = [];
        for (const att of attachments) {
          await this.sendDocFn(threadId, att.content, att.filename, att.caption);
        }
      }
      return;
    }

    // Clear timer
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }

    // Take messages and attachments from queue
    const messages = [...queue.messages];
    const attachments = [...queue.attachments];
    queue.messages = [];
    queue.attachments = [];

    // Combine messages, splitting into chunks that fit within 4096 chars
    const chunks = combineMessages(messages);
    for (const chunk of chunks) {
      await this.sendFn(threadId, chunk);
    }

    // Send file attachments
    for (const att of attachments) {
      await this.sendDocFn(threadId, att.content, att.filename, att.caption);
    }
  }

  /**
   * Graceful shutdown: flush all pending queues immediately and clear all timers.
   */
  shutdown(): void {
    for (const [threadId, queue] of this.queues) {
      if (queue.timer) {
        clearTimeout(queue.timer);
        queue.timer = null;
      }
      if (queue.messages.length > 0 || queue.attachments.length > 0) {
        // Fire-and-forget flush during shutdown
        void this.flush(threadId);
      }
    }
    this.queues.clear();
  }
}

/**
 * Combine messages with double newline separator, splitting into chunks
 * that each fit within Telegram's 4096 character limit.
 * Splits on message boundaries, never mid-message.
 */
function combineMessages(messages: string[]): string[] {
  const MAX_LENGTH = 4096;
  const SEPARATOR = '\n\n';
  const chunks: string[] = [];
  let current = '';

  for (const msg of messages) {
    if (current === '') {
      // First message in chunk
      if (msg.length > MAX_LENGTH) {
        // Single message exceeds limit -- send as-is (TopicManager.sendMessage will truncate)
        chunks.push(msg);
      } else {
        current = msg;
      }
    } else {
      const combined = current + SEPARATOR + msg;
      if (combined.length > MAX_LENGTH) {
        // Adding this message would exceed limit -- finalize current chunk
        chunks.push(current);
        if (msg.length > MAX_LENGTH) {
          chunks.push(msg);
          current = '';
        } else {
          current = msg;
        }
      } else {
        current = combined;
      }
    }
  }

  if (current !== '') {
    chunks.push(current);
  }

  return chunks;
}
