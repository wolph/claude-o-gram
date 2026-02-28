import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionInfo } from '../types/sessions.js';
import type { VerbosityTier } from '../types/monitoring.js';

/**
 * In-memory session map with atomic JSON file persistence.
 *
 * Manages Claude Code sessions and their mapping to Telegram forum topics.
 * Persists to disk as JSON using atomic writes (write-to-temp + rename).
 * Node.js single-threaded event loop guarantees Map operations are atomic.
 */
export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Get a session by its Claude Code session ID */
  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Find a session by its Telegram thread ID */
  getByThreadId(threadId: number): SessionInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Find an active session matching the given cwd.
   * Used for session resume detection: when a SessionStart with source "resume"
   * arrives for a cwd that already has an active session, reuse existing topic.
   */
  getActiveByCwd(cwd: string): SessionInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.cwd === cwd && session.status === 'active') {
        return session;
      }
    }
    return undefined;
  }

  /** Store or update a session and persist to disk */
  set(sessionId: string, info: SessionInfo): void {
    this.sessions.set(sessionId, info);
    this.save();
  }

  /** Update the status of a session (active -> closed) */
  updateStatus(sessionId: string, status: 'active' | 'closed'): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      this.save();
    }
  }

  /** Update the Telegram thread ID after topic creation */
  updateThreadId(sessionId: string, threadId: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.threadId = threadId;
      this.save();
    }
  }

  /** Get all sessions with status 'active' */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === 'active'
    );
  }

  /** Increment the tool call counter for a session */
  incrementToolCount(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.toolCallCount++;
      this.save();
    }
  }

  /**
   * Add a changed file path to the session's filesChanged set.
   * Handles conversion from array (loaded from JSON) to Set if needed.
   */
  addChangedFile(sessionId: string, filePath: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Convert array to Set if loaded from JSON
    if (Array.isArray(session.filesChanged)) {
      session.filesChanged = new Set(session.filesChanged);
    }

    (session.filesChanged as Set<string>).add(filePath);
    this.save();
  }

  // --- Phase 2 monitoring methods ---

  /** Update the last activity timestamp for idle detection */
  updateLastActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date().toISOString();
      this.save();
    }
  }

  /** Increment the suppressed tool call count for a given tool name */
  incrementSuppressedCount(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!session.suppressedCounts) {
        session.suppressedCounts = {};
      }
      session.suppressedCounts[toolName] = (session.suppressedCounts[toolName] || 0) + 1;
      this.save();
    }
  }

  /** Update the verbosity tier for a session */
  updateVerbosity(sessionId: string, tier: VerbosityTier): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.verbosity = tier;
      this.save();
    }
  }

  /** Update the pinned status message ID */
  updateStatusMessageId(sessionId: string, messageId: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.statusMessageId = messageId;
      this.save();
    }
  }

  /** Update the context window usage percentage */
  updateContextPercent(sessionId: string, percent: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.contextPercent = percent;
      this.save();
    }
  }

  /**
   * Get and reset the suppressed counts for periodic summary reporting.
   * Returns the counts record and resets it to an empty object.
   */
  getSuppressedCounts(sessionId: string): Record<string, number> {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    const counts = session.suppressedCounts || {};
    session.suppressedCounts = {};
    this.save();
    return counts;
  }

  /** Update the tmux pane ID for a session */
  updateTmuxPane(sessionId: string, tmuxPane: string | null): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.tmuxPane = tmuxPane;
      this.save();
    }
  }

  /** Get all sessions (active and closed) */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Persist sessions to disk using atomic write.
   * Writes to a temp file first, then renames for crash safety.
   */
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    // Serialize Map to a plain object, converting Sets to arrays for JSON
    const data: Record<string, unknown> = {};
    for (const [id, session] of this.sessions) {
      data[id] = {
        ...session,
        filesChanged: session.filesChanged instanceof Set
          ? Array.from(session.filesChanged)
          : session.filesChanged,
      };
    }

    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  /**
   * Load sessions from disk on startup.
   * Converts filesChanged arrays back to Sets for in-memory use.
   * Gracefully handles missing or corrupt files.
   */
  private load(): void {
    if (!existsSync(this.filePath)) {
      return; // Empty map is fine for first run
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, SessionInfo>;

      for (const [id, session] of Object.entries(data)) {
        // Convert filesChanged from array (JSON) to Set (in-memory)
        // Ensure Phase 3 fields have defaults for sessions saved before Phase 3
        this.sessions.set(id, {
          ...session,
          filesChanged: new Set(
            Array.isArray(session.filesChanged) ? session.filesChanged : []
          ),
          tmuxPane: session.tmuxPane ?? null,
        });
      }
    } catch (err) {
      console.warn(
        `Warning: Failed to load sessions from ${this.filePath}, starting with empty session map.`,
        err instanceof Error ? err.message : err
      );
      // Start with empty map on corrupt file
    }
  }
}
