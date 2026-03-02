import {
  watch,
  readdirSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * Callback fired when a /clear event is detected via filesystem.
 * @param newTranscriptPath Full path to the new transcript JSONL file
 * @param newSessionId Session UUID derived from the filename
 */
export type ClearDetectedCallback = (
  newTranscriptPath: string,
  newSessionId: string,
) => void;

/**
 * Detects /clear events by watching Claude Code's project directory for new
 * transcript JSONL files. This works around the upstream limitation where
 * Claude Code fires no HTTP hooks on /clear (bug #6428).
 *
 * When /clear runs, Claude Code creates a new transcript file in:
 *   ~/.claude/projects/{slug}/{new-session-id}.jsonl
 *
 * The file contains a progress entry with hookName "SessionStart:clear".
 * We watch for new files, verify the hookName, and trigger the callback.
 */
export class ClearDetector {
  private projectDir: string;
  private cwd: string;
  private currentSessionId: string;
  private isSessionKnown: (sessionId: string) => boolean;
  private onClearDetected: ClearDetectedCallback;

  private watcher: FSWatcher | null = null;
  private knownFiles = new Set<string>();
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Delay before acting on a new file, giving HTTP hooks a chance to fire */
  private static readonly DETECTION_DELAY_MS = 1500;

  constructor(
    cwd: string,
    currentSessionId: string,
    isSessionKnown: (sessionId: string) => boolean,
    onClearDetected: ClearDetectedCallback,
  ) {
    const slug = cwd.replaceAll('/', '-');
    this.projectDir = join(homedir(), '.claude', 'projects', slug);
    this.cwd = cwd;
    this.currentSessionId = currentSessionId;
    this.isSessionKnown = isSessionKnown;
    this.onClearDetected = onClearDetected;
  }

  /**
   * Update the current session ID (after a /clear transition).
   * Prevents the detector from re-triggering on its own session.
   */
  updateSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.knownFiles.add(`${sessionId}.jsonl`);
  }

  /**
   * Start watching the project directory for new transcript files.
   * Snapshots existing files first to avoid false positives.
   */
  start(): void {
    if (!existsSync(this.projectDir)) {
      console.warn(`ClearDetector: project dir not found: ${this.projectDir}`);
      return;
    }

    // Snapshot existing .jsonl files
    try {
      const entries = readdirSync(this.projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          this.knownFiles.add(entry.name);
        }
      }
    } catch (err) {
      console.warn(
        'ClearDetector: failed to snapshot directory:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    this.watcher = watch(this.projectDir, (event, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (this.knownFiles.has(filename)) return;

      // Mark as known immediately to prevent duplicate handling
      this.knownFiles.add(filename);

      // Verify the file was created (not deleted)
      const fullPath = join(this.projectDir, filename);
      if (!existsSync(fullPath)) return;

      const newSessionId = basename(filename, '.jsonl');

      // Skip if this is our own session
      if (newSessionId === this.currentSessionId) return;

      // Delay to let HTTP hooks fire first
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        this.handleNewFile(fullPath, newSessionId);
      }, ClearDetector.DETECTION_DELAY_MS);

      this.pendingTimers.add(timer);
    });

    this.watcher.on('error', (err) => {
      console.warn('ClearDetector: watcher error:', err.message);
    });
  }

  /**
   * Handle a newly detected transcript file.
   * Checks if the hook already handled it, then reads the file
   * to confirm it's a /clear or compact event.
   */
  private handleNewFile(filePath: string, sessionId: string): void {
    // If the session is already registered (hook fired), skip
    if (this.isSessionKnown(sessionId)) return;

    // Read the first few lines to check for SessionStart:clear or compact
    const eventType = this.detectEventType(filePath);
    if (!eventType) return;

    console.log(
      `ClearDetector: detected ${eventType} event → new transcript ${sessionId}`,
    );
    this.onClearDetected(filePath, sessionId);
  }

  /**
   * Read the beginning of a transcript file to determine the event type.
   * Returns 'clear' or 'compact' if found, null otherwise.
   */
  private detectEventType(filePath: string): 'clear' | 'compact' | null {
    try {
      const raw = readFileSync(filePath, { encoding: 'utf-8', flag: 'r' });
      const chunk = raw.slice(0, 4096);
      const lines = chunk.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          if (entry.type !== 'progress') continue;

          const data = entry.data as Record<string, unknown> | undefined;
          if (!data || data.type !== 'hook_progress') continue;

          const hookName = data.hookName as string | undefined;
          if (hookName === 'SessionStart:clear') return 'clear';
          if (hookName === 'SessionStart:compact') return 'compact';
        } catch {
          // Skip malformed lines
        }
      }
    } catch (err) {
      console.warn(
        'ClearDetector: failed to read transcript:',
        err instanceof Error ? err.message : err,
      );
    }

    return null;
  }

  /** Stop watching and clean up all timers. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }
}
