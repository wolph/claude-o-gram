import type { BotStateStore } from './bot-state-store.js';

/**
 * Mutable runtime settings layer that wraps BotStateStore.
 *
 * Provides getter/setter pairs for each setting. Setters automatically
 * persist changes to disk via BotStateStore. Read by hook callbacks in
 * index.ts instead of the immutable AppConfig, allowing settings to take
 * effect immediately without a restart.
 */
export class RuntimeSettings {
  private store: BotStateStore;

  constructor(store: BotStateStore) {
    this.store = store;
  }

  /** Whether sub-agent output is visible in session topics */
  get subagentOutput(): boolean {
    return this.store.get().subagentOutput;
  }

  set subagentOutput(value: boolean) {
    this.store.update({ subagentOutput: value });
  }

  /** Default permission mode for new sessions */
  get defaultPermissionMode(): string {
    return this.store.get().defaultPermissionMode;
  }

  set defaultPermissionMode(value: string) {
    this.store.update({ defaultPermissionMode: value });
  }

  /** Telegram thread ID of the settings topic */
  get settingsTopicId(): number {
    return this.store.get().settingsTopicId;
  }

  set settingsTopicId(value: number) {
    this.store.update({ settingsTopicId: value });
  }

  /** Telegram message ID of the pinned settings message */
  get settingsMessageId(): number {
    return this.store.get().settingsMessageId;
  }

  set settingsMessageId(value: number) {
    this.store.update({ settingsMessageId: value });
  }
}
