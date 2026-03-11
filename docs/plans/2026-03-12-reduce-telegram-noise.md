# Reduce Telegram Message Noise — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs (approval messages shown in auto-approve modes, approval buttons not cleaned up) and reduce Telegram API call volume (smart status updates, minimal verbosity default) to restore AskUserQuestion button responsiveness.

**Architecture:** Four independent surgical fixes to existing files. No new files, no new abstractions. Each fix is self-contained and testable.

**Tech Stack:** TypeScript, grammY, Vitest

---

## Task 1: Suppress Approvals in Auto-Approve Modes

**Files:**
- Modify: `src/index.ts:1248-1253` (onPreToolUse callback)

**Context:**
- `permissionModeManager` is already instantiated at `src/index.ts:117`
- `shouldAutoApprove()` exists at `src/control/permission-modes.ts:97` but is **never called anywhere**
- The existing bypass check (lines 1248-1253) only handles Claude Code's built-in `bypassPermissions`/`dontAsk` modes
- The Telegram bot's custom modes (`accept-all`, `safe-only`, `until-done`, `same-tool`) from `PermissionModeManager` are never checked
- `bypassBatcher` is the right destination — it batches tool calls into a collapsible summary instead of individual approval messages

**Step 1: Add shouldAutoApprove check after the existing bypass check**

In `src/index.ts`, find the `onPreToolUse` callback. After the existing bypass block (lines 1250-1253), add a new check before the approval message is sent:

```typescript
      // Bypass mode: batch tool calls instead of sending individual approval messages
      const permMode = payload.permission_mode || session.permissionMode;
      if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        return;
      }

      // Telegram auto-approve modes: route to bypass batcher, no approval buttons needed
      if (permissionModeManager.shouldAutoApprove(session.sessionId, payload.tool_name, payload.tool_input as Record<string, unknown>)) {
        bypassBatcher.add(session.sessionId, session.threadId, payload);
        permissionModeManager.incrementAutoApproved(session.sessionId);
        return;
      }
```

The `payload.tool_input` may need a cast to `Record<string, unknown>` since `shouldAutoApprove` expects that type. Check the `PreToolUsePayload` type — if `tool_input` is already `Record<string, unknown>`, the cast is unnecessary.

**Step 2: Also suppress notification_prompt in auto-approve modes**

In the `onNotification` callback (~line 1193), the permission_prompt suppression currently only checks `bypassPermissions`/`dontAsk`. Add the same `shouldAutoApprove` check. Find lines 1201-1206:

```typescript
      // Suppress permission_prompt notifications in bypass mode — they're misleading
      const permMode = payload.permission_mode || session.permissionMode;
      if (payload.notification_type === 'permission_prompt') {
        if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
          return;
        }
        // Also suppress if Telegram auto-approve mode would handle this
        if (permissionModeManager.shouldAutoApprove(
          session.sessionId,
          (payload as any).tool_name ?? '',
          (payload as any).tool_input ?? {},
        )) {
          return;
        }
```

Note: The notification payload may not have `tool_name`/`tool_input` fields. Check the `NotificationPayload` type first. If it doesn't have tool info, we can't filter by tool — in that case, check if the session's mode is `accept-all` or `until-done` (which approve everything regardless of tool):

```typescript
        // Suppress if Telegram mode auto-approves all tools
        const modeState = permissionModeManager.getMode(session.sessionId);
        if (modeState.mode === 'accept-all' || modeState.mode === 'until-done') {
          return;
        }
```

**Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit**

```
git add src/index.ts
git commit -m "fix: suppress approval messages in Telegram auto-approve modes"
```

---

## Task 2: Harden Approval Button Cleanup on PostToolUse

**Files:**
- Modify: `src/hooks/handlers.ts:391-416` (handlePostToolUse)

**Context:**
- Approval cleanup already exists at `src/index.ts:1135-1152` inside the `onToolUse` callback
- But `handlePostToolUse` in `handlers.ts:407-413` has a verbosity filter that returns early before calling `onToolUse`
- If a tool is suppressed by verbosity, the cleanup code in `onToolUse` never runs
- Currently not a problem because Bash/Write/Edit pass all verbosity filters, BUT with Fix 4 changing the default to `minimal`, more tools could be filtered
- Defensive fix: add a dedicated approval cleanup callback that runs BEFORE the verbosity filter

**Step 1: Add an onToolComplete callback to the HookHandlers callbacks interface**

Check what the callbacks interface looks like. It's likely in `src/hooks/handlers.ts` or `src/types/hooks.ts`. Add a new optional callback:

```typescript
/** Called on every PostToolUse, before verbosity filter. For cleanup tasks. */
onToolComplete?: (session: SessionInfo, payload: PostToolUsePayload) => Promise<void>;
```

**Step 2: Call onToolComplete before the verbosity filter in handlePostToolUse**

In `handlePostToolUse` (handlers.ts:391-416), add the callback call after activity/tool tracking but before the verbosity filter:

```typescript
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

    // Always run cleanup (approval button removal) regardless of verbosity
    if (this.callbacks.onToolComplete) {
      await this.callbacks.onToolComplete(session, payload);
    }

    // Verbosity filter: check if this tool call should be posted to Telegram
    const verbosity = session.verbosity || 'minimal';
    if (!shouldPostToolCall(payload.tool_name, verbosity)) {
      this.sessionStore.incrementSuppressedCount(payload.session_id, payload.tool_name);
      return;
    }

    await this.callbacks.onToolUse(session, payload);
  }
```

**Step 3: Move approval cleanup from onToolUse to onToolComplete in index.ts**

In `src/index.ts`, move lines 1135-1152 (the `approvalManager.resolvePending` block) from `onToolUse` to the new `onToolComplete` callback:

```typescript
    onToolComplete: async (_session, payload) => {
      // Clean up approval buttons when tool completes (user approved locally or auto-approved)
      const pendingApproval = approvalManager.resolvePending(payload.tool_use_id);
      if (pendingApproval) {
        try {
          const resultText = formatApprovalResult('allow', 'locally', pendingApproval.originalHtml);
          await bot.api.editMessageText(config.telegramChatId, pendingApproval.messageId, resultText, {
            parse_mode: 'HTML',
            reply_markup: undefined,
          });
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('message is not modified'))) {
            cli.warn('PERM', 'Failed to update local approval message', {
              error: err instanceof Error ? err.message : err,
            });
          }
        }
      }
    },
```

Remove the same block from `onToolUse`.

**Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 5: Verify tests pass**

Run: `npm test`
Expected: All 103 tests pass (or whatever the current count is)

**Step 6: Commit**

```
git add src/hooks/handlers.ts src/index.ts
git commit -m "fix: clean up approval buttons before verbosity filter in PostToolUse"
```

---

## Task 3: Smart Status Message Updates

**Files:**
- Modify: `src/monitoring/status-message.ts`
- Create: `tests/status-message.test.ts`

**Context:**
- Current: 3-second debounce, flushes on every `requestUpdate()` call if interval elapsed
- Target: 10-second minimum interval, only flush on meaningful changes
- Meaningful = status transition (after 5s settle), context % delta >10%, files changed count changed
- `StatusData` has fields: `contextPercent`, `currentTool`, `sessionDuration`, `toolCallCount`, `filesChanged`, `status`
- `setKeyboard()` must still trigger immediate flushes (used for Stop button)
- `destroy()` must still send final status immediately

**Step 1: Write tests for meaningful change detection**

Create `tests/status-message.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { hasMeaningfulChange } from '../src/monitoring/status-message.js';
import type { StatusData } from '../src/types/monitoring.js';

const base: StatusData = {
  contextPercent: 30,
  currentTool: 'Read',
  sessionDuration: '5m',
  toolCallCount: 10,
  filesChanged: 2,
  status: 'active',
};

describe('hasMeaningfulChange', () => {
  it('returns true when no previous data exists', () => {
    expect(hasMeaningfulChange(base, null)).toBe(true);
  });

  it('returns true when context % delta >= 10', () => {
    const updated = { ...base, contextPercent: 40 };
    expect(hasMeaningfulChange(updated, base)).toBe(true);
  });

  it('returns false when context % delta < 10', () => {
    const updated = { ...base, contextPercent: 35 };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns true when filesChanged changes', () => {
    const updated = { ...base, filesChanged: 3 };
    expect(hasMeaningfulChange(updated, base)).toBe(true);
  });

  it('returns false when only currentTool changes', () => {
    const updated = { ...base, currentTool: 'Grep' };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns false when only toolCallCount changes', () => {
    const updated = { ...base, toolCallCount: 15 };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns false when only sessionDuration changes', () => {
    const updated = { ...base, sessionDuration: '10m' };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('does NOT treat status change as meaningful (handled by settle timer)', () => {
    const updated = { ...base, status: 'idle' as const };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/status-message.test.ts`
Expected: FAIL — `hasMeaningfulChange` is not exported yet

**Step 3: Extract and export hasMeaningfulChange**

In `src/monitoring/status-message.ts`, add this exported function (before the class):

```typescript
/** Minimum context % change to trigger a status update */
const CONTEXT_DELTA_THRESHOLD = 10;

/**
 * Determine if the new status data represents a meaningful change
 * worth sending to Telegram. Status transitions (active/idle) are
 * handled separately by the settle timer, not here.
 */
export function hasMeaningfulChange(data: StatusData, lastSent: StatusData | null): boolean {
  if (!lastSent) return true;
  const ctxDelta = Math.abs(data.contextPercent - lastSent.contextPercent);
  if (ctxDelta >= CONTEXT_DELTA_THRESHOLD) return true;
  if (data.filesChanged !== lastSent.filesChanged) return true;
  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/status-message.test.ts`
Expected: All 8 tests pass

**Step 5: Rewrite requestUpdate with smart logic**

Replace the `requestUpdate` method and add new fields to `StatusMessage`:

```typescript
  /** Minimum milliseconds between editMessageText calls */
  private static readonly MIN_UPDATE_INTERVAL_MS = 10_000;

  /** How long a status transition must persist before flushing */
  private static readonly STATUS_SETTLE_MS = 5_000;

  /** Track last sent data for meaningful change detection */
  private lastSentData: StatusData | null = null;

  /** Timer for status transition settle detection */
  private statusSettleTimer: ReturnType<typeof setTimeout> | null = null;
```

New `requestUpdate`:

```typescript
  requestUpdate(data: StatusData): void {
    this.pendingData = data;

    // Status transition detection (active ↔ idle): wait for settle
    if (this.lastSentData && data.status !== this.lastSentData.status
        && data.status !== 'closed') {
      // Start settle timer if not already running
      if (!this.statusSettleTimer) {
        this.statusSettleTimer = setTimeout(() => {
          this.statusSettleTimer = null;
          // Status held — treat as meaningful, schedule flush
          this.scheduleFlush();
        }, StatusMessage.STATUS_SETTLE_MS);
      }
      return;
    }

    // Status reverted before settle — cancel timer, skip update
    if (this.statusSettleTimer && this.lastSentData
        && data.status === this.lastSentData.status) {
      clearTimeout(this.statusSettleTimer);
      this.statusSettleTimer = null;
      // Still check for other meaningful changes
    }

    // Only flush on meaningful changes
    if (!hasMeaningfulChange(data, this.lastSentData)) return;

    this.scheduleFlush();
  }

  /** Schedule a flush respecting the minimum update interval */
  private scheduleFlush(): void {
    const elapsed = Date.now() - this.lastUpdateTime;
    if (elapsed >= StatusMessage.MIN_UPDATE_INTERVAL_MS) {
      void this.flush();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(
        () => void this.flush(),
        StatusMessage.MIN_UPDATE_INTERVAL_MS - elapsed,
      );
    }
  }
```

Update `flush` to track `lastSentData`:

```typescript
  private async flush(): Promise<void> {
    // ... existing null/messageId checks ...
    // ... existing timer cleanup ...
    // ... existing formatStatus + identical check ...

    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text, {
        reply_markup: this.activeKeyboard ?? undefined,
      });
      this.lastSentText = text;
      this.lastSentData = data;  // <-- ADD THIS LINE
    } catch (err) {
      // ... existing error handling ...
    }
  }
```

Update `destroy` to clean up the settle timer:

```typescript
  destroy(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.statusSettleTimer) {
      clearTimeout(this.statusSettleTimer);
      this.statusSettleTimer = null;
    }
    // ... rest unchanged ...
  }
```

**Step 6: Verify typecheck + tests pass**

Run: `npm run typecheck && npm test`
Expected: All pass

**Step 7: Commit**

```
git add src/monitoring/status-message.ts tests/status-message.test.ts
git commit -m "feat: smart status message updates — meaningful-change gating with 10s interval"
```

---

## Task 4: Default Verbosity to Minimal

**Files:**
- Modify: `src/monitoring/verbosity.ts:36` (default return value)
- Modify: `src/hooks/handlers.ts:408` (fallback value)
- Modify: `tests/verbosity.test.ts:57-61` (update expected default)

**Step 1: Update the test expectation**

In `tests/verbosity.test.ts`, change the test at line 57:

```typescript
  it('defaults to minimal for invalid values', () => {
    expect(parseVerbosityTier('invalid')).toBe('minimal');
    expect(parseVerbosityTier(undefined)).toBe('minimal');
    expect(parseVerbosityTier('')).toBe('minimal');
  });
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/verbosity.test.ts`
Expected: FAIL — still returns 'normal'

**Step 3: Change the default in verbosity.ts**

In `src/monitoring/verbosity.ts:36`, change:

```typescript
  return 'minimal'; // was 'normal'
```

**Step 4: Change the fallback in handlers.ts**

In `src/hooks/handlers.ts:408`, change:

```typescript
    const verbosity = session.verbosity || 'minimal';
```

**Step 5: Run all tests**

Run: `npm test`
Expected: All pass

**Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 7: Commit**

```
git add src/monitoring/verbosity.ts src/hooks/handlers.ts tests/verbosity.test.ts
git commit -m "feat: default verbosity to minimal — only show Write/Edit/Bash in Telegram"
```

---

## Verification

After all four tasks, run the full check:

```bash
npm run typecheck && npm run lint && npm test
```

All should pass. The four commits should be:

1. `fix: suppress approval messages in Telegram auto-approve modes`
2. `fix: clean up approval buttons before verbosity filter in PostToolUse`
3. `feat: smart status message updates — meaningful-change gating with 10s interval`
4. `feat: default verbosity to minimal — only show Write/Edit/Bash in Telegram`
