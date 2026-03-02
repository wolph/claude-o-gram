import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bot-level state persisted to disk (separate from session state) */
export interface BotState {
  /** Telegram thread ID of the settings topic (0 if not yet created) */
  settingsTopicId: number;
  /** Telegram message ID of the pinned settings message (0 if not yet sent) */
  settingsMessageId: number;
  /** Whether sub-agent output is visible in session topics */
  subagentOutput: boolean;
  /** Default permission mode for new sessions: 'manual' | 'safe-only' | 'accept-all' | 'until-done' */
  defaultPermissionMode: string;
}

/**
 * Atomic JSON persistence for bot-level state.
 *
 * Follows the same write-tmp-rename pattern as SessionStore for crash safety.
 * Manages settings topic IDs and runtime configuration that must survive restarts.
 */
export class BotStateStore {
  private state: BotState;
  private filePath: string;

  constructor(filePath: string, defaults: BotState) {
    this.filePath = filePath;
    this.state = { ...defaults };
    this.load();
  }

  /** Get the current bot state */
  get(): BotState {
    return this.state;
  }

  /** Update bot state with partial values and persist to disk */
  update(partial: Partial<BotState>): void {
    Object.assign(this.state, partial);
    this.save();
  }

  /**
   * Persist state to disk using atomic write.
   * Writes to a temp file first, then renames for crash safety.
   */
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.state, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  /**
   * Load state from disk on startup.
   * Merges saved values over defaults. Gracefully handles missing or corrupt files.
   */
  private load(): void {
    if (!existsSync(this.filePath)) {
      return; // Use defaults
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Partial<BotState>;
      Object.assign(this.state, data);
    } catch (err) {
      console.warn(
        `Warning: Failed to load bot state from ${this.filePath}, using defaults.`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
