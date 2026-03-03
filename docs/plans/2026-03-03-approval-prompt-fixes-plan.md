# Approval Prompt Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix orphaned approval buttons, suppress approval spam in bypass mode, and add persistent pending store so approval messages survive bot restarts.

**Architecture:** Four independent changes — (1) persistent file-backed pending store, (2) bypass-mode batched summary, (3) stale-button cleanup on click, (4) notification suppression. Each task is self-contained and commits independently.

**Tech Stack:** TypeScript, Node.js fs (writeFileSync/readFileSync), grammY (Telegram bot API), Fastify hooks.

---

### Task 1: Persistent Pending Store — ApprovalManager

**Files:**
- Modify: `src/control/approval-manager.ts` (complete rewrite)
- Modify: `src/index.ts:109` (pass config.dataDir + bot.api to constructor)
- Modify: `src/index.ts:1051` (shutdown now flushes to disk)
- Modify: `src/index.ts` (after line ~931, call startup cleanup)

**Step 1: Rewrite ApprovalManager with file persistence**

Replace the entire `src/control/approval-manager.ts` with a file-backed version. The `PendingApproval` interface stays the same. The class gains:
- Constructor takes `filePath: string` and a `cleanupFn` callback for editing stale messages on startup
- `load()` reads JSON from disk on construction, prunes entries older than 1 hour
- Debounced `scheduleSave()` (500ms) writes to disk after mutations
- `shutdown()` does synchronous final flush

```typescript
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
```

**Step 2: Update ApprovalManager construction in index.ts**

In `src/index.ts`, change line ~109 from:
```typescript
const approvalManager = new ApprovalManager();
```
to:
```typescript
const approvalManager = new ApprovalManager(
  join(config.dataDir, 'pending-approvals.json'),
);
```

**Step 3: Add stale cleanup call after bot startup**

In `src/index.ts`, after the reconnect loop (after line ~991, before settings topic init), add:
```typescript
// Clean up stale pending approvals from previous run
const staleCount = await approvalManager.cleanupStale(async (entry) => {
  try {
    await bot.api.editMessageText(
      config.telegramChatId,
      entry.messageId,
      entry.originalHtml + '\n\n✅ <b>Resolved</b> — session ended',
      { parse_mode: 'HTML', reply_markup: undefined },
    );
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('message is not modified'))) {
      throw err;
    }
  }
});
if (staleCount > 0) {
  console.log(`Cleaned up ${staleCount} stale pending approval(s)`);
}
```

**Step 4: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation, no errors.

**Step 5: Commit**

```bash
git add src/control/approval-manager.ts src/index.ts
git commit -m "feat: persist pending approvals to disk, clean stale on startup"
```

---

### Task 2: Stale Button Cleanup on Click

**Files:**
- Modify: `src/bot/bot.ts:125-198` (approve and deny callback handlers)

**Step 1: Update approve handler to clean up stale buttons**

In `src/bot/bot.ts`, in the `approve:` callback handler (line 125-162), replace the early return when `!pending`:

Current code (lines 128-131):
```typescript
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.', show_alert: true });
      return;
    }
```

Replace with:
```typescript
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.', show_alert: true });
      // Clean up orphaned buttons — edit message to remove keyboard and mark resolved
      try {
        const existingText = ctx.callbackQuery.message?.text
          || ctx.callbackQuery.message?.caption
          || '';
        if (existingText) {
          await ctx.editMessageText(
            existingText + '\n\n✅ <b>Resolved</b>',
            { parse_mode: 'HTML', reply_markup: undefined },
          );
        } else {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        }
      } catch {
        // Best-effort: message may already be edited or too old
      }
      return;
    }
```

**Step 2: Update deny handler to clean up stale buttons**

In `src/bot/bot.ts`, in the `deny:` callback handler (line 165-198), replace the early return when `!pending`:

Current code (lines 168-171):
```typescript
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.', show_alert: true });
      return;
    }
```

Replace with the same pattern as the approve handler (identical code block from Step 1).

**Step 3: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation, no errors.

**Step 4: Commit**

```bash
git add src/bot/bot.ts
git commit -m "fix: clean up orphaned approval buttons when clicked after resolution"
```

---

### Task 3: Bypass Mode Batched Summary — BypassBatcher

**Files:**
- Create: `src/control/bypass-batcher.ts`
- Modify: `src/bot/formatter.ts` (add `formatBypassBatch`)
- Modify: `src/index.ts` (add bypass check in `onPreToolUse`, wire batcher, shutdown cleanup)

**Step 1: Create BypassBatcher class**

Create `src/control/bypass-batcher.ts`:

```typescript
import type { PreToolUsePayload } from '../types/hooks.js';

/** Callback to send or edit a Telegram message */
export interface BypassBatchCallbacks {
  /** Send a new message to the thread. Returns the Telegram message ID. */
  send(threadId: number, html: string): Promise<number>;
  /** Edit an existing message in the thread. */
  edit(messageId: number, html: string): Promise<void>;
}

/** A buffered tool call entry */
interface BufferedEntry {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Per-session batch state */
interface SessionBatch {
  threadId: number;
  entries: BufferedEntry[];
  /** ID of the Telegram message currently showing the batch (0 if not yet sent) */
  messageId: number;
  /** Entries already sent/edited into the message (to avoid re-sending) */
  flushedCount: number;
  /** 10-second flush timer */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp of last entry added */
  lastEntryAt: number;
  /** 30-second inactivity timer — starts a new message on next entry */
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

const FLUSH_INTERVAL_MS = 10_000;
const INACTIVITY_RESET_MS = 30_000;

/**
 * Batches auto-approved tool calls in bypass mode into rolling Telegram messages.
 *
 * Per session:
 * - Accumulates tool descriptions as PreToolUse fires.
 * - Every 10 seconds, sends or edits a single Telegram message with all entries.
 * - After 30 seconds of inactivity, resets — next entry starts a fresh message.
 */
export class BypassBatcher {
  private sessions = new Map<string, SessionBatch>();
  private callbacks: BypassBatchCallbacks;
  private formatFn: (entries: BufferedEntry[]) => string;

  constructor(
    callbacks: BypassBatchCallbacks,
    formatFn: (entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>) => string,
  ) {
    this.callbacks = callbacks;
    this.formatFn = formatFn;
  }

  /**
   * Add a tool call to the batch for a session.
   * If this is the first entry after inactivity, starts a new batch.
   */
  add(sessionId: string, threadId: number, payload: PreToolUsePayload): void {
    let batch = this.sessions.get(sessionId);

    if (!batch) {
      batch = {
        threadId,
        entries: [],
        messageId: 0,
        flushedCount: 0,
        flushTimer: null,
        lastEntryAt: 0,
        inactivityTimer: null,
      };
      this.sessions.set(sessionId, batch);
    }

    // Add entry
    batch.entries.push({
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
    });
    batch.lastEntryAt = Date.now();

    // Reset inactivity timer
    if (batch.inactivityTimer) {
      clearTimeout(batch.inactivityTimer);
    }
    batch.inactivityTimer = setTimeout(() => {
      // After 30s of inactivity, reset the batch so next entry starts fresh
      this.resetBatch(sessionId);
    }, INACTIVITY_RESET_MS);

    // Start flush timer if not running
    if (!batch.flushTimer) {
      batch.flushTimer = setTimeout(() => {
        void this.flush(sessionId);
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** Clean up all timers for a session (e.g., session end) */
  cleanupSession(sessionId: string): void {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;
    // Flush any remaining entries before cleanup
    if (batch.entries.length > batch.flushedCount) {
      void this.flush(sessionId);
    }
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    if (batch.inactivityTimer) clearTimeout(batch.inactivityTimer);
    this.sessions.delete(sessionId);
  }

  /** Shut down all batchers */
  shutdown(): void {
    for (const [sessionId] of this.sessions) {
      this.cleanupSession(sessionId);
    }
  }

  private resetBatch(sessionId: string): void {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;
    if (batch.flushTimer) clearTimeout(batch.flushTimer);
    if (batch.inactivityTimer) clearTimeout(batch.inactivityTimer);
    // Keep the session entry but reset to start a new message
    batch.entries = [];
    batch.messageId = 0;
    batch.flushedCount = 0;
    batch.flushTimer = null;
    batch.inactivityTimer = null;
  }

  private async flush(sessionId: string): Promise<void> {
    const batch = this.sessions.get(sessionId);
    if (!batch) return;

    // Clear flush timer
    batch.flushTimer = null;

    // Nothing new to flush?
    if (batch.entries.length <= batch.flushedCount) return;

    const html = this.formatFn(batch.entries);

    try {
      if (batch.messageId === 0) {
        // First flush — send new message
        batch.messageId = await this.callbacks.send(batch.threadId, html);
      } else {
        // Subsequent flush — edit existing message
        await this.callbacks.edit(batch.messageId, html);
      }
      batch.flushedCount = batch.entries.length;
    } catch (err) {
      console.warn(
        `[BYPASS] Failed to flush batch for session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Schedule next flush if there might be more entries coming
    // (timer will be started by next add() call)
  }
}
```

**Step 2: Add formatBypassBatch to formatter.ts**

Add the following at the end of `src/bot/formatter.ts`, before the closing of the file (after `formatSubagentDone`):

```typescript
// ---------------------------------------------------------------------------
// Bypass mode batch formatting
// ---------------------------------------------------------------------------

/**
 * Format a batch of auto-approved tool calls for bypass mode.
 * Tree-style display similar to Claude Code's terminal output.
 */
export function formatBypassBatch(
  entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>,
): string {
  const lines: string[] = ['⚡ <b>Auto-approved</b> (bypass mode)'];

  for (let i = 0; i < entries.length; i++) {
    const { toolName, toolInput } = entries[i];
    const isLast = i === entries.length - 1;
    const prefix = isLast ? '└' : '├';
    const preview = buildBypassPreview(toolName, toolInput);
    lines.push(`${prefix} ${escapeHtml(preview)}`);
  }

  return lines.join('\n');
}

/** Build a compact one-liner for a tool call in bypass batch */
function buildBypassPreview(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'Bash':
    case 'BashBackground': {
      const cmd = shortenCommand((toolInput.command as string) || '');
      const line = cmd.split('\n')[0];
      return `${toolName}(${line.slice(0, 80)})`;
    }
    case 'Read': {
      const fp = (toolInput.file_path as string) || (toolInput.path as string) || '?';
      return `Read(${smartPathForBatch(fp)})`;
    }
    case 'Write': {
      const fp = (toolInput.file_path as string) || (toolInput.path as string) || '?';
      return `Write(${smartPathForBatch(fp)})`;
    }
    case 'Edit':
    case 'MultiEdit': {
      const fp = (toolInput.file_path as string) || (toolInput.path as string) || '?';
      return `Edit(${smartPathForBatch(fp)})`;
    }
    case 'Glob': {
      const pattern = (toolInput.pattern as string) || '*';
      return `Glob("${pattern.slice(0, 60)}")`;
    }
    case 'Grep': {
      const pattern = (toolInput.pattern as string) || '';
      return `Grep("${pattern.slice(0, 60)}")`;
    }
    default:
      return toolName;
  }
}

/** Shorten file path for batch display. Reuses smartPath logic. */
function smartPathForBatch(filePath: string): string {
  let p = filePath;
  const home = process.env.HOME;
  if (home && p.startsWith(home + '/')) {
    p = '~/' + p.slice(home.length + 1);
  }
  if (p.length <= 50) return p;
  const segments = p.split('/');
  if (segments.length <= 3) return p;
  return segments[0] + '/.../' + segments.slice(-2).join('/');
}
```

**Step 3: Wire BypassBatcher in index.ts**

In `src/index.ts`:

**3a. Add imports** (near line 29-31):
```typescript
import { BypassBatcher } from './control/bypass-batcher.js';
import { formatBypassBatch } from './bot/formatter.js';
```

**3b. Create batcher instance** (after line ~113, after `inputRouter`):
```typescript
// Bypass mode batcher: accumulates auto-approved tool calls, flushes every 10s
const bypassBatcher = new BypassBatcher(
  {
    send: async (threadId, html) => {
      const msg = await bot.api.sendMessage(config.telegramChatId, html, {
        message_thread_id: threadId,
        parse_mode: 'HTML',
      });
      return msg.message_id;
    },
    edit: async (messageId, html) => {
      await bot.api.editMessageText(config.telegramChatId, messageId, html, {
        parse_mode: 'HTML',
      });
    },
  },
  formatBypassBatch,
);
```

**3c. Add bypass check at top of onPreToolUse** (line ~794):

Replace the current `onPreToolUse` body. The existing Agent/Task stash logic stays. Insert a bypass check after it:

```typescript
    onPreToolUse: async (session, payload: PreToolUsePayload) => {
      // Stash description from Agent/Task tool for SubagentStart correlation
      if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
        const desc = (payload.tool_input.description as string)
          || (payload.tool_input.prompt as string)
          || '';
        subagentTracker.stashDescription(
          session.sessionId,
          (payload.tool_input.subagent_type as string) || 'unknown',
          desc,
        );
      }

      // Bypass mode: batch tool calls instead of sending individual approval messages
      const permMode = payload.permission_mode || session.permissionMode;
      if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        return;
      }

      // --- Normal approval flow (unchanged) ---
      // Format approval request message
      let approvalHtml = formatApprovalRequest(payload);
      // ... rest stays the same ...
```

**3d. Clean up bypassBatcher in shutdown** (add near line 1051):
```typescript
    bypassBatcher.shutdown();
```

**3e. Clean up bypassBatcher on session end** in the `onSessionEnd` callback. Find the session end callback and add:
```typescript
    bypassBatcher.cleanupSession(session.sessionId);
```

**Step 4: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation, no errors.

**Step 5: Commit**

```bash
git add src/control/bypass-batcher.ts src/bot/formatter.ts src/index.ts
git commit -m "feat: batch auto-approved tool calls in bypass mode"
```

---

### Task 4: Notification Suppression in Bypass Mode

**Files:**
- Modify: `src/index.ts:780-786` (onNotification callback)

**Step 1: Add bypass check to onNotification**

In `src/index.ts`, the `onNotification` callback (lines 780-786):

Current code:
```typescript
    onNotification: async (session, payload) => {
      const html = formatNotification(payload);
      // Notify only for prompts that block Claude and need user action
      const shouldNotify = payload.notification_type === 'permission_prompt'
        || payload.notification_type === 'elicitation_dialog';
      await batcher.enqueueImmediate(session.threadId, html, shouldNotify);
    },
```

Replace with:
```typescript
    onNotification: async (session, payload) => {
      // Suppress permission_prompt notifications in bypass mode — they're misleading
      const permMode = payload.permission_mode || session.permissionMode;
      if (
        payload.notification_type === 'permission_prompt'
        && (permMode === 'bypassPermissions' || permMode === 'dontAsk')
      ) {
        return;
      }

      const html = formatNotification(payload);
      // Notify only for prompts that block Claude and need user action
      const shouldNotify = payload.notification_type === 'permission_prompt'
        || payload.notification_type === 'elicitation_dialog';
      await batcher.enqueueImmediate(session.threadId, html, shouldNotify);
    },
```

**Step 2: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation, no errors.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: suppress permission_prompt notifications in bypass mode"
```

---

### Task 5: Manual Integration Test

**Files:** None (testing only)

**Step 1: Test bypass mode**

1. Start the bot: `npm start`
2. Start a Claude Code session with `--dangerously-skip-permissions`
3. Give Claude a task that triggers multiple tool calls
4. Verify: Telegram shows a batched "Auto-approved (bypass mode)" message with tree-style entries, updated every ~10 seconds
5. Wait 30+ seconds of inactivity, then trigger more tool calls — verify a new batch message starts

**Step 2: Test stale button cleanup**

1. Find any old message with stale Accept/Deny buttons in Telegram
2. Click either button
3. Verify: Toast shows "Already resolved" AND the buttons disappear, message gets "Resolved" appended

**Step 3: Test persistent pending store**

1. Start a Claude Code session in default permission mode
2. Trigger a tool call that needs approval (see buttons appear in Telegram)
3. Restart the bot (Ctrl+C, `npm start`)
4. Verify: Console shows "Cleaned up N stale pending approval(s)"
5. Check the old message — buttons should be gone, shows "Resolved — session ended"

**Step 4: Test notification suppression**

1. In a bypass-mode session, verify no "Permission Required" notification messages appear in Telegram
2. In a default-mode session, verify they still appear normally
