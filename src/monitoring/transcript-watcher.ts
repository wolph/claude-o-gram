import {
  watch,
  statSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { TokenUsage, TranscriptEntry, ContentBlock } from '../types/monitoring.js';

/** Default context window size for Claude models (200k tokens) */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Calculate the context window usage percentage from token usage data.
 *
 * Uses the official formula from Claude Code status line docs:
 * (input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_size * 100
 */
export function calculateContextPercentage(
  usage: TokenUsage,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): number {
  const totalInputTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  return Math.round((totalInputTokens / contextWindow) * 100);
}

/**
 * TranscriptWatcher tails a JSONL transcript file for new entries,
 * emitting assistant text messages and token usage updates via callbacks.
 *
 * Uses fs.watch for event-driven file change detection (not polling).
 * Handles edge cases: fs.watch multi-fire debounce, partial line buffering,
 * file truncation detection, and file-not-yet-exists retry.
 */
export class TranscriptWatcher {
  private filePath: string;
  private onAssistantMessage: (text: string) => void;
  private onUsageUpdate: (usage: TokenUsage) => void;

  private watcher: FSWatcher | null = null;
  private filePosition: number = 0;
  private partialBuffer: string = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount: number = 0;

  /** Maximum retries waiting for the transcript file to appear */
  private static readonly MAX_RETRIES = 10;
  /** Delay between retries in milliseconds */
  private static readonly RETRY_DELAY_MS = 500;
  /** Debounce delay for fs.watch change events */
  private static readonly DEBOUNCE_MS = 100;

  private onSidechainMessage?: (text: string) => void;

  constructor(
    filePath: string,
    onAssistantMessage: (text: string) => void,
    onUsageUpdate: (usage: TokenUsage) => void,
    onSidechainMessage?: (text: string) => void,
  ) {
    this.filePath = filePath;
    this.onAssistantMessage = onAssistantMessage;
    this.onUsageUpdate = onUsageUpdate;
    this.onSidechainMessage = onSidechainMessage;
  }

  /**
   * Start watching the transcript file for new entries.
   *
   * Sets the initial file position to the current file size so that
   * only entries written after start() is called are processed.
   * If the file doesn't exist yet, retries up to 10 times with 500ms delay.
   */
  start(): void {
    if (!existsSync(this.filePath)) {
      this.retryStart();
      return;
    }
    this.beginWatching();
  }

  /**
   * Retry waiting for the transcript file to appear.
   * Claude Code may not create the file until the first API call.
   */
  private retryStart(): void {
    this.retryCount++;
    if (this.retryCount > TranscriptWatcher.MAX_RETRIES) {
      console.warn(
        `TranscriptWatcher: file not found after ${TranscriptWatcher.MAX_RETRIES} retries: ${this.filePath}`,
      );
      return;
    }
    this.retryTimer = setTimeout(() => {
      if (existsSync(this.filePath)) {
        this.beginWatching();
      } else {
        this.retryStart();
      }
    }, TranscriptWatcher.RETRY_DELAY_MS);
  }

  /**
   * Initialize the watcher once the file is confirmed to exist.
   * Skips existing content by setting filePosition to current file size.
   */
  private beginWatching(): void {
    try {
      const stats = statSync(this.filePath);
      this.filePosition = stats.size;
    } catch {
      this.filePosition = 0;
    }

    this.watcher = watch(this.filePath, () => {
      // Debounce: fs.watch fires multiple events per single write
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(
        () => this.readNewLines(),
        TranscriptWatcher.DEBOUNCE_MS,
      );
    });

    // Handle watcher errors (e.g., file deleted)
    this.watcher.on('error', (err) => {
      console.warn('TranscriptWatcher: watcher error:', err.message);
    });
  }

  /**
   * Read new bytes from the file starting at the last known position.
   * Handles file truncation (compaction) by resetting position to 0.
   * Buffers partial lines across reads to handle split JSON.
   */
  private readNewLines(): void {
    let fd: number | null = null;
    try {
      const stats = statSync(this.filePath);
      const currentSize = stats.size;

      // File truncation detection: if file shrank, reset to beginning
      if (currentSize < this.filePosition) {
        this.filePosition = 0;
        this.partialBuffer = '';
      }

      // Nothing new to read
      if (currentSize === this.filePosition) return;

      const bytesToRead = currentSize - this.filePosition;
      const buffer = Buffer.alloc(bytesToRead);

      fd = openSync(this.filePath, 'r');
      readSync(fd, buffer, 0, bytesToRead, this.filePosition);
      closeSync(fd);
      fd = null;

      this.filePosition = currentSize;

      // Combine with any partial line from previous read
      const text = this.partialBuffer + buffer.toString('utf8');
      const lines = text.split('\n');

      // If the last element is not empty, it's an incomplete line -- buffer it
      const lastLine = lines.pop();
      this.partialBuffer = lastLine ?? '';

      // Process each complete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        try {
          const entry = JSON.parse(trimmed) as TranscriptEntry;
          this.processEntry(entry);
        } catch {
          // Defensive parsing: skip malformed JSON lines (MEDIUM confidence format)
        }
      }
    } catch (err) {
      // Close fd if still open after error
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close errors
        }
      }
      console.warn(
        'TranscriptWatcher: error reading file:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Process a parsed transcript entry.
   * Only emits main-chain assistant text messages and token usage updates.
   * Filters out sidechain (subagent) messages and tool_use/tool_result blocks.
   */
  private processEntry(entry: TranscriptEntry): void {
    // Subagent (sidechain) messages: emit via sidechain callback if registered
    if (entry.isSidechain) {
      if (!this.onSidechainMessage) return;
      if (entry.type !== 'assistant') return;
      if (entry.message.role !== 'assistant') return;

      // Extract text content (same logic as main chain)
      const content = entry.message.content;
      let text: string | null = null;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const textParts = (content as ContentBlock[])
          .filter(
            (block): block is { type: 'text'; text: string } =>
              block.type === 'text',
          )
          .map((block) => block.text);
        text = textParts.length > 0 ? textParts.join('\n') : null;
      }

      if (text && text.trim().length > 0) {
        this.onSidechainMessage(text);
      }
      return;
    }

    // Only process assistant messages
    if (entry.type !== 'assistant') return;
    if (entry.message.role !== 'assistant') return;

    // Extract text content from the message
    const content = entry.message.content;
    let text: string | null = null;

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Filter for text blocks only, skip tool_use and tool_result
      const textParts = (content as ContentBlock[])
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )
        .map((block) => block.text);

      text = textParts.length > 0 ? textParts.join('\n') : null;
    }

    // Emit text if non-empty
    if (text && text.trim().length > 0) {
      this.onAssistantMessage(text);
    }

    // Emit usage update if present
    if (entry.message.usage) {
      this.onUsageUpdate(entry.message.usage);
    }
  }

  /**
   * Stop watching the transcript file and clean up resources.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
