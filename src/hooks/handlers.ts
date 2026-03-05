import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { SessionInfo } from '../types/sessions.js';
import type {
  HookPayload,
  SessionStartPayload,
  SessionEndPayload,
  PostToolUsePayload,
  NotificationPayload,
  PreToolUsePayload,
  StopPayload,
  SubagentStartPayload,
  SubagentStopPayload,
} from '../types/hooks.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { TranscriptEntry, ContentBlock } from '../types/monitoring.js';
import { shouldPostToolCall } from '../monitoring/verbosity.js';
import { escapeHtml } from '../utils/text.js';

/**
 * Callback interface for delegating Telegram actions.
 * The handlers manage session state; the callbacks handle Telegram API calls.
 * This decouples session logic from Telegram, making it testable and wirable in Plan 04.
 */
export interface HookCallbacks {
  onSessionStart(session: SessionInfo, source: 'new' | 'resume' | 'clear' | 'reuse'): Promise<void>;
  onSessionEnd(session: SessionInfo, reason: string): Promise<void>;
  onToolUse(session: SessionInfo, payload: PostToolUsePayload): Promise<void>;
  onNotification(session: SessionInfo, payload: NotificationPayload): Promise<void>;
  onPreToolUse(session: SessionInfo, payload: PreToolUsePayload): Promise<void>;
  onStop(session: SessionInfo, payload: StopPayload): Promise<void>;
  onBackfillSummary(session: SessionInfo, summary: string): Promise<void>;
  onSubagentStart(session: SessionInfo, payload: SubagentStartPayload): Promise<void>;
  onSubagentStop(session: SessionInfo, payload: SubagentStopPayload): Promise<void>;
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
   * Ensure a session exists for the given payload.
   * If the session is unknown (e.g. bot restarted while Claude Code was running),
   * auto-registers it, creates a Telegram topic, and backfills transcript history.
   */
  private async ensureSession(payload: HookPayload): Promise<SessionInfo | null> {
    const existing = this.sessionStore.get(payload.session_id);
    if (existing) return existing;

    console.log(`Auto-registering late session: ${payload.session_id}`);
    const now = new Date().toISOString();
    const session: SessionInfo = {
      sessionId: payload.session_id,
      threadId: 0,
      cwd: payload.cwd,
      topicName: basename(payload.cwd),
      startedAt: now,
      status: 'active',
      transcriptPath: payload.transcript_path,
      toolCallCount: 0,
      filesChanged: new Set<string>(),
      verbosity: 'normal',
      statusMessageId: 0,
      suppressedCounts: {},
      contextPercent: 0,
      lastActivityAt: now,
      permissionMode: payload.permission_mode,
    };

    this.sessionStore.set(payload.session_id, session);
    await this.callbacks.onSessionStart(session, 'new');

    // Re-fetch to get updated threadId set by onSessionStart
    const registered = this.sessionStore.get(payload.session_id);
    if (registered) {
      await this.backfillFromTranscript(registered);
    }
    return registered ?? null;
  }

  /**
   * Read the transcript JSONL file and send a compact backfill summary
   * to the Telegram topic. Updates session metadata (toolCallCount, filesChanged).
   */
  private async backfillFromTranscript(session: SessionInfo): Promise<void> {
    let lines: string[];
    try {
      const raw = readFileSync(session.transcriptPath, 'utf-8');
      lines = raw.split('\n').filter((l) => l.trim().length > 0);
    } catch (err) {
      console.warn(
        'Backfill: failed to read transcript:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const toolCalls: { name: string; detail: string }[] = [];
    const filesChanged = new Set<string>();
    let totalToolCalls = 0;

    for (const line of lines) {
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }

      if (entry.isSidechain) continue;
      if (entry.type !== 'assistant') continue;
      if (entry.message.role !== 'assistant') continue;

      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as ContentBlock[]) {
        if (block.type !== 'tool_use') continue;
        totalToolCalls++;

        // Track file changes
        const input = block.input as Record<string, unknown>;
        if (FILE_MODIFYING_TOOLS.has(block.name)) {
          const filePath = extractFilePath(input);
          if (filePath) filesChanged.add(filePath);
        }

        // Build detail string for recent activity display
        let detail = '';
        if (block.name === 'Bash' && typeof input.command === 'string') {
          const cmd = input.command.length > 60
            ? input.command.slice(0, 60) + '...'
            : input.command;
          detail = cmd;
        } else if (typeof input.file_path === 'string') {
          detail = input.file_path;
        } else if (typeof input.path === 'string') {
          detail = input.path;
        } else if (typeof input.pattern === 'string') {
          detail = input.pattern;
        } else if (typeof input.query === 'string') {
          detail = input.query.length > 60
            ? input.query.slice(0, 60) + '...'
            : input.query;
        }

        toolCalls.push({ name: block.name, detail });
      }
    }

    // Update session store with backfilled metadata
    for (let i = 0; i < totalToolCalls; i++) {
      this.sessionStore.incrementToolCount(session.sessionId);
    }
    for (const file of filesChanged) {
      this.sessionStore.addChangedFile(session.sessionId, file);
    }

    // Build summary message
    const parts: string[] = [
      `\u{1F504} <b>Late join</b> \u2014 backfilling from transcript`,
      '',
      `\u{1F4CA} <b>Session so far:</b>`,
      `\u2022 Tool calls: ${totalToolCalls}`,
    ];

    if (filesChanged.size > 0) {
      parts.push(`\u2022 Files changed: ${filesChanged.size}`);
      for (const file of filesChanged) {
        parts.push(`  \u2022 <code>${escapeHtml(file)}</code>`);
      }
    }

    // Show last ~10 tool calls as recent activity
    const recentCalls = toolCalls.slice(-10);
    if (recentCalls.length > 0) {
      parts.push('');
      parts.push(`\u{1F527} <b>Recent activity:</b>`);
      for (const call of recentCalls) {
        if (call.detail) {
          parts.push(`\u2022 ${escapeHtml(call.name)}: <code>${escapeHtml(call.detail)}</code>`);
        } else {
          parts.push(`\u2022 ${escapeHtml(call.name)}`);
        }
      }
    }

    const summary = parts.join('\n');
    await this.callbacks.onBackfillSummary(session, summary);
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
          permissionMode: payload.permission_mode ?? existing.permissionMode,
        });
        // Clear old session's threadId to prevent getByThreadId collision
        this.sessionStore.updateThreadId(existing.sessionId, 0);
        await this.callbacks.onSessionStart(
          this.sessionStore.get(payload.session_id)!,
          'resume'
        );
        return;
      }
    }

    // /clear detection: reuse topic from active or recently closed session
    if (payload.source === 'clear') {
      // Primary path: find the ACTIVE session for this cwd.
      // Claude Code bug #6428: SessionEnd does NOT fire on /clear,
      // so the session is still active when SessionStart(source=clear) arrives.
      const existing = this.sessionStore.getActiveByCwd(payload.cwd);

      // Fallback: if upstream bug is fixed in future, SessionEnd may have
      // already closed the session before this fires.
      const prior = existing ?? this.sessionStore.getRecentlyClosedByCwd(payload.cwd);

      if (prior) {
        // Reuse the topic: create new session entry with old threadId
        const clearNow = new Date().toISOString();
        this.sessionStore.set(payload.session_id, {
          ...prior,
          sessionId: payload.session_id,
          transcriptPath: payload.transcript_path,
          status: 'active',
          startedAt: clearNow,
          lastActivityAt: clearNow,
          toolCallCount: 0,
          filesChanged: new Set<string>(),
          suppressedCounts: {},
          contextPercent: 0,
          permissionMode: payload.permission_mode ?? prior.permissionMode,
        });

        // Clear old session's threadId to prevent getByThreadId from returning
        // the stale closed entry instead of the new active one
        this.sessionStore.updateThreadId(prior.sessionId, 0);

        await this.callbacks.onSessionStart(
          this.sessionStore.get(payload.session_id)!,
          'clear'
        );
        return;
      }
      // Fallback: if no session found at all, treat as new session
      // (handles edge cases where the bot restarted between clear events)
    }

    // Topic reuse: check for a recently closed session with the same cwd.
    // If found, reuse its topic instead of creating a new one (prevents topic proliferation).
    // Only reuse when no other active session exists for this cwd (simultaneous sessions
    // still get separate topics).
    const existingActive = this.sessionStore.getActiveByCwd(payload.cwd);
    if (!existingActive) {
      const closedSession = this.sessionStore.getRecentlyClosedByCwd(payload.cwd);
      if (closedSession && closedSession.threadId > 0) {
        const reuseNow = new Date().toISOString();
        this.sessionStore.set(payload.session_id, {
          ...closedSession,
          sessionId: payload.session_id,
          threadId: closedSession.threadId,
          topicName: closedSession.topicName,
          transcriptPath: payload.transcript_path,
          status: 'active',
          startedAt: reuseNow,
          lastActivityAt: reuseNow,
          toolCallCount: 0,
          filesChanged: new Set<string>(),
          suppressedCounts: {},
          contextPercent: 0,
          statusMessageId: 0,
          permissionMode: payload.permission_mode ?? closedSession.permissionMode,
        });
        // Clear old session's threadId to prevent getByThreadId collision
        this.sessionStore.updateThreadId(closedSession.sessionId, 0);
        await this.callbacks.onSessionStart(
          this.sessionStore.get(payload.session_id)!,
          'reuse'
        );
        return;
      }
    }

    // Derive topic name from cwd basename
    let topicName = basename(payload.cwd);

    // Duplicate detection: if another active session exists for the same cwd,
    // append start timestamp for disambiguation
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
      permissionMode: payload.permission_mode,
    };

    this.sessionStore.set(payload.session_id, session);
    await this.callbacks.onSessionStart(session, 'new');
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
    await this.callbacks.onSessionEnd(session, payload.reason);
  }

  /**
   * Handle a PostToolUse hook event.
   * Checks verbosity filter before posting. Tracks tool usage and file changes.
   */
  async handlePostToolUse(payload: PostToolUsePayload): Promise<void> {
    const session = await this.ensureSession(payload);
    if (!session) return;

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
    const session = await this.ensureSession(payload);
    if (!session) return;
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onNotification(session, payload);
  }

  /**
   * Handle a PreToolUse hook event.
   * NON-BLOCKING: Posts informational message to Telegram. Does not return
   * a permission decision — Claude Code shows its local dialog.
   */
  async handlePreToolUse(payload: PreToolUsePayload): Promise<void> {
    const session = await this.ensureSession(payload);
    if (!session) return; // ensureSession failed — Claude Code handles locally
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onPreToolUse(session, payload);
  }

  /**
   * Handle a Stop hook event.
   * Fires when Claude finishes responding (turn ends).
   * Used to expire "Until Done" permission mode.
   */
  async handleStop(payload: StopPayload): Promise<void> {
    const session = this.sessionStore.get(payload.session_id);
    if (!session) return;
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onStop(session, payload);
  }

  /**
   * Handle a SubagentStart hook event (fire-and-forget).
   * Fires when a subagent spawns. Delegates to onSubagentStart callback.
   */
  async handleSubagentStart(payload: SubagentStartPayload): Promise<void> {
    const session = await this.ensureSession(payload);
    if (!session) return;
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onSubagentStart(session, payload);
  }

  /**
   * Handle a SubagentStop hook event (fire-and-forget).
   * Fires when a subagent completes. Delegates to onSubagentStop callback.
   */
  async handleSubagentStop(payload: SubagentStopPayload): Promise<void> {
    const session = await this.ensureSession(payload);
    if (!session) return;
    this.sessionStore.updateLastActivity(payload.session_id);
    await this.callbacks.onSubagentStop(session, payload);
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
