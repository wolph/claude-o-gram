import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Metadata for a pending tool approval shown in Telegram */
export interface PendingApproval {
  sessionId: string;
  messageId: number;
  threadId: number;
  toolName: string;
  originalHtml: string;
  createdAt: number;
}

/** Serializable format for the JSON file */
interface PendingStore {
  [toolUseId: string]: PendingApproval;
}

/** Callback to clean up stale approval messages on startup */
export type StaleCleanupFn = (entry: PendingApproval) => Promise<void>;

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SAVE_DEBOUNCE_MS = 500;

/**
 * Tracks pending tool approval messages with file-backed persistence.
 *
 * On startup, loads pending approvals from disk and cleans up stale entries
 * (older than 1 hour) by invoking the cleanup callback to edit Telegram messages.
 *
 * Keyed by tool_use_id (UUID, unique per tool call).
 */
export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /**
   * Run stale entry cleanup. Call this AFTER the bot is ready to make API calls.
   * Edits orphaned Telegram messages to remove buttons.
   */
  async cleanupStale(cleanupFn: StaleCleanupFn): Promise<number> {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [toolUseId, entry] of this.pending) {
      if (now - entry.createdAt > MAX_AGE_MS) {
        staleIds.push(toolUseId);
      }
    }

    let cleaned = 0;
    for (const toolUseId of staleIds) {
      const entry = this.pending.get(toolUseId)!;
      try {
        await cleanupFn(entry);
      } catch (err) {
        console.warn(
          `Failed to clean up stale approval ${toolUseId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      this.pending.delete(toolUseId);
      cleaned++;
    }

    if (cleaned > 0) {
      this.saveSync();
    }
    return cleaned;
  }

  trackPending(
    toolUseId: string,
    sessionId: string,
    threadId: number,
    messageId: number,
    toolName: string,
    originalHtml: string,
  ): void {
    this.pending.set(toolUseId, {
      sessionId,
      messageId,
      threadId,
      toolName,
      originalHtml,
      createdAt: Date.now(),
    });
    this.scheduleSave();
  }

  getPending(toolUseId: string): PendingApproval | null {
    return this.pending.get(toolUseId) ?? null;
  }

  resolvePending(toolUseId: string): PendingApproval | null {
    const entry = this.pending.get(toolUseId);
    if (!entry) return null;
    this.pending.delete(toolUseId);
    this.scheduleSave();
    return entry;
  }

  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  cleanupSession(sessionId: string): void {
    let changed = false;
    for (const [toolUseId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        this.pending.delete(toolUseId);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  shutdown(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }

  // --- Persistence internals ---

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as PendingStore;
      for (const [toolUseId, entry] of Object.entries(data)) {
        this.pending.set(toolUseId, entry);
      }
    } catch (err) {
      console.warn(
        'Failed to load pending approvals:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSync();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveSync(): void {
    const data: PendingStore = {};
    for (const [toolUseId, entry] of this.pending) {
      data[toolUseId] = entry;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }
}
