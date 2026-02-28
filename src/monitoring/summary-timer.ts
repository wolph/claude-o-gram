import { basename } from 'node:path';
import { escapeHtml } from '../utils/text.js';

/** Data for generating a periodic summary message */
export interface SummaryData {
  /** Current working directory of the Claude Code session */
  cwd: string;
  /** Total tool calls since session start */
  toolCallCount: number;
  /** Total unique files changed since session start */
  filesChanged: number;
  /** Current context window usage percentage */
  contextPercent: number;
  /** Tool name -> count of suppressed (filtered by verbosity) calls */
  suppressedCounts: Record<string, number>;
  /** Name of the last tool that was called */
  lastToolName: string;
}

/**
 * SummaryTimer fires periodic summary messages at a configurable interval.
 *
 * Each summary aggregates session activity since the last summary,
 * including tool call count, files changed, context usage, and
 * suppressed tool call counts. Skips the summary if no new activity
 * has occurred since the previous one.
 */
export class SummaryTimer {
  private intervalMs: number;
  private getSummaryData: () => SummaryData | null;
  private onSummary: (text: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSummaryToolCount: number = 0;

  /**
   * @param intervalMs Interval between summaries (default: 300000 = 5 minutes)
   * @param getSummaryData Callback returning current session stats, or null if session inactive
   * @param onSummary Callback to post the formatted summary text to Telegram
   */
  constructor(
    intervalMs: number,
    getSummaryData: () => SummaryData | null,
    onSummary: (text: string) => void,
  ) {
    this.intervalMs = intervalMs;
    this.getSummaryData = getSummaryData;
    this.onSummary = onSummary;
  }

  /**
   * Start the periodic summary timer.
   * On each tick, fetches summary data and posts if there is new activity.
   */
  start(): void {
    this.timer = setInterval(() => {
      const data = this.getSummaryData();
      if (!data) return;

      // Skip if no new tool calls since last summary
      if (data.toolCallCount <= this.lastSummaryToolCount) return;

      const text = this.formatSummary(data);
      this.lastSummaryToolCount = data.toolCallCount;
      this.onSummary(text);
    }, this.intervalMs);
  }

  /**
   * Format a summary message from the session data.
   *
   * Produces a compact, scannable one-line summary with optional
   * suppressed tool call details.
   */
  private formatSummary(data: SummaryData): string {
    const project = escapeHtml(basename(data.cwd));
    const parts = [
      `\u{1F4CB} Working on <b>${project}</b>`,
      `${data.toolCallCount} tool calls`,
      `${data.filesChanged} files changed`,
      `${data.contextPercent}% context used`,
    ];

    let text = parts.join(' \u{2014} ');

    // Append suppressed counts if any tools were filtered
    const suppressedEntries = Object.entries(data.suppressedCounts).filter(
      ([, count]) => count > 0,
    );
    if (suppressedEntries.length > 0) {
      const suppressedParts = suppressedEntries.map(
        ([name, count]) => `${count} ${escapeHtml(name)}`,
      );
      text += `\n<i>(${suppressedParts.join(', ')} suppressed)</i>`;
    }

    return text;
  }

  /**
   * Stop the periodic summary timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
