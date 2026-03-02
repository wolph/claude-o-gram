import type { Bot } from 'grammy';

/**
 * Status states for topic name emoji prefixes.
 * - green: Session waiting for user input (Claude idle)
 * - yellow: Claude actively processing (tools, thinking)
 * - red: Context window exhaustion (95%+ threshold)
 * - gray: Session down/offline (bot restarted, crashed)
 */
export type TopicStatus = 'green' | 'yellow' | 'red' | 'gray';

/**
 * Emoji constants for topic name prefixes.
 * Shared by TopicStatusManager (live status) and TopicManager (close/done).
 */
export const STATUS_EMOJIS: Record<TopicStatus | 'done', string> = {
  green: '\u{1F7E2}',   // 🟢
  yellow: '\u{1F7E1}',  // 🟡
  red: '\u{1F534}',     // 🔴
  gray: '\u26AA',       // ⚪
  done: '\u2705',       // ✅
};

/**
 * Centralized topic status management with per-topic debounce and no-op cache.
 *
 * All topic name emoji changes (green/yellow/red/gray) flow through this class.
 * Consolidates the five previous editForumTopic call sites into one debounced path.
 *
 * Rate limit strategy:
 * - Layer 1: grammY auto-retry + transformer-throttler (handles 429s)
 * - Layer 2: This class debounces at 3 seconds per topic + caches status to skip no-ops
 *
 * Sticky red: Once context exhaustion triggers red, green/yellow transitions are
 * blocked until clearStickyRed() is called (on next turn start).
 */
export class TopicStatusManager {
  private bot: Bot;
  private chatId: number;

  /** Last confirmed status per threadId (after successful API call) */
  private statusCache = new Map<number, TopicStatus>();

  /** Pending status waiting for debounce flush */
  private pendingStatus = new Map<number, TopicStatus>();

  /** Per-topic debounce timers */
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Clean topic names (without emoji prefix) per threadId */
  private topicNames = new Map<number, string>();

  /** ThreadIds where red status is sticky (context exhaustion) */
  private stickyRed = new Set<number>();

  /** Minimum milliseconds between editForumTopic calls per topic */
  private static readonly DEBOUNCE_MS = 3000;

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /**
   * Register a topic for status tracking.
   * Must be called when a session starts or reconnects.
   * @param threadId Telegram message_thread_id
   * @param cleanName Topic name without emoji prefix
   */
  registerTopic(threadId: number, cleanName: string): void {
    this.topicNames.set(threadId, cleanName);
  }

  /**
   * Unregister a topic when a session ends normally.
   * Cleans up all internal state for the threadId.
   */
  unregisterTopic(threadId: number): void {
    this.topicNames.delete(threadId);
    this.statusCache.delete(threadId);
    this.pendingStatus.delete(threadId);
    this.stickyRed.delete(threadId);

    const timer = this.timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(threadId);
    }
  }

  /**
   * Set topic status with debounce (3-second per-topic).
   * Skips no-op transitions and respects sticky red.
   *
   * Used for routine status changes during session lifecycle:
   * - green on Stop hook (turn complete)
   * - yellow on tool use
   * - red on context exhaustion
   */
  setStatus(threadId: number, status: TopicStatus): void {
    // Topic must be registered
    if (!this.topicNames.has(threadId)) return;

    // Sticky red: block green/yellow until explicitly cleared
    if (this.stickyRed.has(threadId) && (status === 'green' || status === 'yellow')) {
      return;
    }

    // No-op check against confirmed cache
    if (this.statusCache.get(threadId) === status) return;

    this.pendingStatus.set(threadId, status);

    // Reset debounce timer
    const existing = this.timers.get(threadId);
    if (existing) clearTimeout(existing);

    this.timers.set(threadId, setTimeout(() => {
      void this.flush(threadId);
    }, TopicStatusManager.DEBOUNCE_MS));
  }

  /**
   * Set topic status immediately (bypass debounce).
   * Used for startup gray sweep and initial session green status
   * where the visual feedback must be instant.
   *
   * @param threadId Telegram message_thread_id
   * @param status Target status
   * @param cleanName Optional: also register/update the topic name
   */
  async setStatusImmediate(threadId: number, status: TopicStatus, cleanName?: string): Promise<void> {
    if (cleanName !== undefined) {
      this.topicNames.set(threadId, cleanName);
    }

    // Cancel any pending debounce
    const timer = this.timers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(threadId);
    }
    this.pendingStatus.delete(threadId);

    // No-op check
    if (this.statusCache.get(threadId) === status) return;

    const name = this.topicNames.get(threadId);
    if (!name) return;

    const emoji = STATUS_EMOJIS[status];
    const fullName = `${emoji} ${name}`;
    const truncated = fullName.length > 128 ? fullName.slice(0, 128) : fullName;

    try {
      await this.bot.api.editForumTopic(this.chatId, threadId, { name: truncated });
      this.statusCache.set(threadId, status);
      if (status === 'red') {
        this.stickyRed.add(threadId);
      }
    } catch (err) {
      console.warn(
        'TopicStatus: failed to update (immediate):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Clear sticky red flag for a topic.
   * Called when a new turn starts (user sends input), allowing
   * green/yellow transitions again after context exhaustion warning.
   */
  clearStickyRed(threadId: number): void {
    this.stickyRed.delete(threadId);
  }

  /**
   * Get the current or pending status for a topic.
   * Returns pending status if a flush hasn't occurred yet,
   * otherwise the confirmed cached status.
   */
  getStatus(threadId: number): TopicStatus | undefined {
    return this.pendingStatus.get(threadId) ?? this.statusCache.get(threadId);
  }

  /**
   * Clean up all timers and state.
   * Called during graceful shutdown.
   */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.statusCache.clear();
    this.pendingStatus.clear();
    this.topicNames.clear();
    this.stickyRed.clear();
  }

  /**
   * Flush pending status for a topic to the Telegram API.
   * Called after debounce timer expires.
   */
  private async flush(threadId: number): Promise<void> {
    const status = this.pendingStatus.get(threadId);
    if (!status) return;

    this.pendingStatus.delete(threadId);
    this.timers.delete(threadId);

    // Double-check after debounce: status may have been confirmed by setStatusImmediate
    if (this.statusCache.get(threadId) === status) return;

    const name = this.topicNames.get(threadId);
    if (!name) return;

    const emoji = STATUS_EMOJIS[status];
    const fullName = `${emoji} ${name}`;
    const truncated = fullName.length > 128 ? fullName.slice(0, 128) : fullName;

    try {
      await this.bot.api.editForumTopic(this.chatId, threadId, { name: truncated });
      this.statusCache.set(threadId, status);
      if (status === 'red') {
        this.stickyRed.add(threadId);
      }
    } catch (err) {
      console.warn(
        'TopicStatus: failed to update:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}
