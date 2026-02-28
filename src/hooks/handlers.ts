import { basename } from 'node:path';
import type { SessionInfo } from '../types/sessions.js';
import type {
  SessionStartPayload,
  SessionEndPayload,
  PostToolUsePayload,
  NotificationPayload,
} from '../types/hooks.js';
import type { SessionStore } from '../sessions/session-store.js';
import { shouldPostToolCall } from '../monitoring/verbosity.js';

/**
 * Callback interface for delegating Telegram actions.
 * The handlers manage session state; the callbacks handle Telegram API calls.
 * This decouples session logic from Telegram, making it testable and wirable in Plan 04.
 */
export interface HookCallbacks {
  onSessionStart(session: SessionInfo, isResume: boolean): Promise<void>;
  onSessionEnd(session: SessionInfo): Promise<void>;
  onToolUse(session: SessionInfo, payload: PostToolUsePayload): Promise<void>;
  onNotification(session: SessionInfo, payload: NotificationPayload): Promise<void>;
}

/** Tool names that modify files (used to track changed files) */
const FILE_MODIFYING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Handler functions for SessionStart, SessionEnd, and PostToolUse hooks.
 * Manages session lifecycle through SessionStore and delegates Telegram
 * actions to HookCallbacks.
 */
export class HookHandlers {
  private sessionStore: SessionStore;
  private callbacks: HookCallbacks;

  constructor(sessionStore: SessionStore, callbacks: HookCallbacks) {
    this.sessionStore = sessionStore;
    this.callbacks = callbacks;
  }

  /**
   * Handle a SessionStart hook event.
   * Creates or resumes a session and delegates to the onSessionStart callback.
   */
  async handleSessionStart(payload: SessionStartPayload): Promise<void> {
    // Resume detection: if source is "resume", check for existing active session
    // with the same cwd (handles session ID instability per Pitfall 1)
    if (payload.source === 'resume') {
      const existing = this.sessionStore.getActiveByCwd(payload.cwd);
      if (existing) {
        // Re-map: remove old session ID, store under new ID with existing topic
        this.sessionStore.set(payload.session_id, {
          ...existing,
          sessionId: payload.session_id,
          transcriptPath: payload.transcript_path,
        });
        await this.callbacks.onSessionStart(
          this.sessionStore.get(payload.session_id)!,
          true
        );
        return;
      }
    }

    // Derive topic name from cwd basename
    let topicName = basename(payload.cwd);

    // Duplicate detection: if another active session exists for the same cwd,
    // append start timestamp for disambiguation
    const existingActive = this.sessionStore.getActiveByCwd(payload.cwd);
    if (existingActive) {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      topicName = `${topicName} (${hours}:${minutes})`;
    }

    // Create new session
    const now = new Date().toISOString();
    const session: SessionInfo = {
      sessionId: payload.session_id,
      threadId: 0, // Set after Telegram topic creation in Plan 04 wiring
      cwd: payload.cwd,
      topicName,
      startedAt: now,
      status: 'active',
      transcriptPath: payload.transcript_path,
      toolCallCount: 0,
      filesChanged: new Set<string>(),
      verbosity: 'normal', // Will be overridden by config default in wiring layer
      statusMessageId: 0,
      suppressedCounts: {},
      contextPercent: 0,
      lastActivityAt: now,
    };

    this.sessionStore.set(payload.session_id, session);
    await this.callbacks.onSessionStart(session, false);
  }

  /**
   * Handle a SessionEnd hook event.
   * Marks the session as closed and delegates to the onSessionEnd callback.
   */
  async handleSessionEnd(payload: SessionEndPayload): Promise<void> {
    const session = this.sessionStore.get(payload.session_id);
    if (!session) {
      console.warn(
        `SessionEnd received for unknown session: ${payload.session_id}`
      );
      return;
    }

    this.sessionStore.updateStatus(payload.session_id, 'closed');
    await this.callbacks.onSessionEnd(session);
  }

  /**
   * Handle a PostToolUse hook event.
   * Checks verbosity filter before posting. Tracks tool usage and file changes.
   */
  async handlePostToolUse(payload: PostToolUsePayload): Promise<void> {
    const session = this.sessionStore.get(payload.session_id);
    if (!session) {
      console.warn(
        `PostToolUse received for unknown session: ${payload.session_id}`
      );
      return;
    }

    // Update activity timestamp for idle detection
    this.sessionStore.updateLastActivity(payload.session_id);
    this.sessionStore.incrementToolCount(payload.session_id);

    // Track file changes for Write, Edit, MultiEdit tools
    if (FILE_MODIFYING_TOOLS.has(payload.tool_name)) {
      const filePath = extractFilePath(payload.tool_input);
      if (filePath) {
        this.sessionStore.addChangedFile(payload.session_id, filePath);
      }
    }

    // Verbosity filter: check if this tool call should be posted to Telegram
    const verbosity = session.verbosity || 'normal';
    if (!shouldPostToolCall(payload.tool_name, verbosity)) {
      // Track suppressed call for periodic summary
      this.sessionStore.incrementSuppressedCount(payload.session_id, payload.tool_name);
      return; // Skip posting to Telegram
    }

    await this.callbacks.onToolUse(session, payload);
  }

  /**
   * Handle a Notification hook event.
   * Delegates to the onNotification callback for Telegram posting.
   */
  async handleNotification(payload: NotificationPayload): Promise<void> {
    const session = this.sessionStore.get(payload.session_id);
    if (!session) {
      console.warn(`Notification received for unknown session: ${payload.session_id}`);
      return;
    }
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onNotification(session, payload);
  }
}

/**
 * Extract the file path from a tool's input object.
 * Different tools use different field names for the file path.
 */
function extractFilePath(toolInput: Record<string, unknown>): string | null {
  // Write and Edit tools use "file_path"
  if (typeof toolInput.file_path === 'string') {
    return toolInput.file_path;
  }
  // Some tools may use "path"
  if (typeof toolInput.path === 'string') {
    return toolInput.path;
  }
  return null;
}

/** Factory function for creating HookHandlers */
export function createHookHandlers(
  sessionStore: SessionStore,
  callbacks: HookCallbacks
): HookHandlers {
  return new HookHandlers(sessionStore, callbacks);
}
