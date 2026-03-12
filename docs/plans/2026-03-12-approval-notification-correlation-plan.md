# Notification-Driven Approval Buttons + AskUserQuestion Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs: (1) approval buttons shown when Claude Code auto-approves tools, (2) AskUserQuestion buttons silently fail due to regex mismatch.

**Architecture:** Replace PreToolUse-driven approval buttons with Notification correlation. PreToolUse stashes payloads; only when a `permission_prompt` Notification arrives do we send approval buttons. Also fix the AskUserQuestion callback regex to accept non-hex tool_use_id prefixes.

**Tech Stack:** TypeScript, grammY, Vitest

---

### Task 1: Fix AskUserQuestion callback regex (Bug 2)

**Files:**
- Modify: `src/bot/bot.ts:376` (regex), `src/bot/bot.ts:449` (add catch-all)

**Step 1: Fix the regex**

In `src/bot/bot.ts:376`, change:
```typescript
bot.callbackQuery(/^ask:([a-f0-9]+):(\w+)$/, async (ctx) => {
```
to:
```typescript
bot.callbackQuery(/^ask:([\w]+):(\w+)$/, async (ctx) => {
```

**Step 2: Add logging at handler entry**

After the `const optionStr = ctx.match[2];` line (line 377), add:
```typescript
const idPrefix = ctx.match[1];
const threadId = ctx.callbackQuery.message?.message_thread_id;
console.log(`[ASK] Button pressed: ask:${idPrefix}:${optionStr} in thread ${threadId}`);
```

Note: `threadId` is already extracted later at line 395 — that's fine, this early log helps debug before the session lookup.

**Step 3: Add catch-all handler for unmatched ask: callbacks**

After the closing `});` of the main ask handler (line 449), add:
```typescript
// Catch-all for unmatched ask: callbacks (defense in depth — log regex mismatches)
bot.callbackQuery(/^ask:/, async (ctx) => {
  console.warn('[ASK] Unmatched callback data:', ctx.callbackQuery.data);
  await ctx.answerCallbackQuery({ text: 'Button format not recognized', show_alert: true });
});
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bot/bot.ts
git commit -m "fix: AskUserQuestion callback regex to accept non-hex tool_use_id prefixes"
```

---

### Task 2: Create PreToolUse stash module

**Files:**
- Create: `src/control/pretooluse-stash.ts`
- Create: `tests/pretooluse-stash.test.ts`

**Step 1: Write the test**

Create `tests/pretooluse-stash.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PreToolUseStash, type StashedPreToolUse } from '../src/control/pretooluse-stash.js';
import type { PreToolUsePayload } from '../src/types/hooks.js';

function makePayload(toolUseId: string, sessionId = 'sess-1'): PreToolUsePayload {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    permission_mode: 'plan',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: toolUseId,
  };
}

describe('PreToolUseStash', () => {
  let stash: PreToolUseStash;
  let flushed: Array<{ sessionId: string; threadId: number; payload: PreToolUsePayload }>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    stash = new PreToolUseStash(2000, (sessionId, threadId, payload) => {
      flushed.push({ sessionId, threadId, payload });
    });
  });

  afterEach(() => {
    stash.shutdown();
    vi.useRealTimers();
  });

  it('stashes a PreToolUse entry and pops it by session (FIFO)', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    const popped = stash.popOldest('sess-1');
    expect(popped).toBeDefined();
    expect(popped!.toolUseId).toBe('tool-a');

    const popped2 = stash.popOldest('sess-1');
    expect(popped2).toBeDefined();
    expect(popped2!.toolUseId).toBe('tool-b');

    expect(stash.popOldest('sess-1')).toBeUndefined();
  });

  it('removes a specific entry by toolUseId', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    const removed = stash.removeByToolUseId('sess-1', 'tool-a');
    expect(removed).toBeDefined();
    expect(removed!.toolUseId).toBe('tool-a');

    // tool-b still there
    expect(stash.popOldest('sess-1')?.toolUseId).toBe('tool-b');
  });

  it('returns undefined when removing a non-existent entry', () => {
    expect(stash.removeByToolUseId('sess-1', 'nope')).toBeUndefined();
  });

  it('flushes to bypassBatcher callback on timer expiry', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].payload.tool_use_id).toBe('tool-a');
    // Entry removed from stash
    expect(stash.popOldest('sess-1')).toBeUndefined();
  });

  it('does not flush if entry was popped before timer fires', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.popOldest('sess-1'); // consumed by Notification

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(0);
  });

  it('does not flush if entry was removed by toolUseId before timer fires', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.removeByToolUseId('sess-1', 'tool-a'); // consumed by PostToolUse

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(0);
  });

  it('cleanupSession clears all entries and cancels timers', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    stash.cleanupSession('sess-1');

    expect(stash.popOldest('sess-1')).toBeUndefined();
    // Timers should not fire after cleanup
    vi.advanceTimersByTime(5000);
    expect(flushed).toHaveLength(0);
  });

  it('isolates sessions from each other', () => {
    stash.push('sess-1', 42, makePayload('tool-a', 'sess-1'), null);
    stash.push('sess-2', 99, makePayload('tool-b', 'sess-2'), null);

    expect(stash.popOldest('sess-1')?.toolUseId).toBe('tool-a');
    expect(stash.popOldest('sess-2')?.toolUseId).toBe('tool-b');
  });

  it('stores agentPrefix for later use', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), '<b>[Explorer]</b> ');
    const popped = stash.popOldest('sess-1');
    expect(popped?.agentPrefix).toBe('<b>[Explorer]</b> ');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pretooluse-stash.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/control/pretooluse-stash.ts`:
```typescript
import type { PreToolUsePayload } from '../types/hooks.js';

export interface StashedPreToolUse {
  toolUseId: string;
  sessionId: string;
  threadId: number;
  payload: PreToolUsePayload;
  agentPrefix: string | null;
  timer: ReturnType<typeof setTimeout>;
}

type FlushCallback = (sessionId: string, threadId: number, payload: PreToolUsePayload) => void;

/**
 * Per-session FIFO queue of PreToolUse payloads awaiting Notification correlation.
 *
 * PreToolUse events are stashed here instead of immediately sending approval buttons.
 * When a permission_prompt Notification arrives, the oldest entry is popped and
 * promoted to an approval message. If no Notification arrives within the timeout,
 * the entry is flushed to the bypassBatcher (it was auto-approved).
 */
export class PreToolUseStash {
  private queues = new Map<string, StashedPreToolUse[]>();
  private timeoutMs: number;
  private onFlush: FlushCallback;

  constructor(timeoutMs: number, onFlush: FlushCallback) {
    this.timeoutMs = timeoutMs;
    this.onFlush = onFlush;
  }

  /** Stash a PreToolUse payload. Starts a timer that flushes to bypassBatcher on expiry. */
  push(
    sessionId: string,
    threadId: number,
    payload: PreToolUsePayload,
    agentPrefix: string | null,
  ): void {
    const entry: StashedPreToolUse = {
      toolUseId: payload.tool_use_id,
      sessionId,
      threadId,
      payload,
      agentPrefix,
      timer: setTimeout(() => {
        // Timer fired — no Notification came, tool was auto-approved
        const removed = this.removeByToolUseId(sessionId, payload.tool_use_id);
        if (removed) {
          this.onFlush(sessionId, threadId, payload);
        }
      }, this.timeoutMs),
    };

    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }
    queue.push(entry);
  }

  /** Pop the oldest stashed entry for a session (used by Notification handler). */
  popOldest(sessionId: string): StashedPreToolUse | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift()!;
    clearTimeout(entry.timer);
    if (queue.length === 0) this.queues.delete(sessionId);
    return entry;
  }

  /** Remove a specific entry by toolUseId (used by PostToolUse handler). */
  removeByToolUseId(sessionId: string, toolUseId: string): StashedPreToolUse | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue) return undefined;
    const idx = queue.findIndex(e => e.toolUseId === toolUseId);
    if (idx === -1) return undefined;
    const [entry] = queue.splice(idx, 1);
    clearTimeout(entry.timer);
    if (queue.length === 0) this.queues.delete(sessionId);
    return entry;
  }

  /** Clear all stashed entries for a session (used by SessionEnd). */
  cleanupSession(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    for (const entry of queue) clearTimeout(entry.timer);
    this.queues.delete(sessionId);
  }

  /** Cancel all timers (used on shutdown). */
  shutdown(): void {
    for (const queue of this.queues.values()) {
      for (const entry of queue) clearTimeout(entry.timer);
    }
    this.queues.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pretooluse-stash.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Run full test suite**

Run: `npm test`
Expected: All 15 test files pass

**Step 6: Commit**

```bash
git add src/control/pretooluse-stash.ts tests/pretooluse-stash.test.ts
git commit -m "feat: add PreToolUseStash for Notification-driven approval correlation"
```

---

### Task 3: Wire stash into index.ts — PreToolUse handler

**Files:**
- Modify: `src/index.ts:1-45` (imports), `src/index.ts:470-515` (stash instantiation), `src/index.ts:1233-1306` (onPreToolUse)

**Step 1: Add import**

In `src/index.ts`, add after the BypassBatcher import (line 35):
```typescript
import { PreToolUseStash } from './control/pretooluse-stash.js';
```

**Step 2: Instantiate stash after bypassBatcher**

After the bypassBatcher expand/collapse handler (around line 515), add:
```typescript
// 7d2. PreToolUse stash: holds payloads until Notification correlation confirms approval needed
const preToolUseStash = new PreToolUseStash(2000, (sessionId, threadId, payload) => {
  // Timer expired — no Notification came, tool was auto-approved → route to bypass batcher
  bypassBatcher.add(sessionId, threadId, payload);
});
```

**Step 3: Replace the onPreToolUse handler body**

Replace the onPreToolUse handler (lines 1235-1306) with:
```typescript
onPreToolUse: async (session, payload: PreToolUsePayload) => {
  cli.debug('PERM', 'PreToolUse received', {
    session: session.sessionId.slice(0, 8),
    tool: payload.tool_name,
  });
  // Guard: skip if threadId not yet assigned (race during topic creation)
  if (!session.threadId) return;

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

  // Fast path: known bypass modes skip stashing entirely
  const permMode = payload.permission_mode || session.permissionMode;
  if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
    bypassBatcher.add(session.sessionId, session.threadId, payload);
    return;
  }

  // Telegram auto-approve modes: route to bypass batcher, no stashing needed
  if (permissionModeManager.shouldAutoApprove(session.sessionId, payload.tool_name, payload.tool_input)) {
    bypassBatcher.add(session.sessionId, session.threadId, payload);
    permissionModeManager.incrementAutoApproved(session.sessionId);
    return;
  }

  // Compute agent prefix now (subagent state may change by the time Notification arrives)
  let agentPrefix: string | null = null;
  const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
  if (activeAgent) {
    const indent = subagentTracker.getIndent(activeAgent.agentId);
    agentPrefix = `${indent}<b>[${escapeHtml(activeAgent.displayName)}]</b> `;
  }

  // Stash payload — wait for Notification correlation before showing buttons
  preToolUseStash.push(session.sessionId, session.threadId, payload, agentPrefix);
},
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor: PreToolUse stashes payloads instead of immediately showing buttons"
```

---

### Task 4: Wire stash into index.ts — Notification handler

**Files:**
- Modify: `src/index.ts:1195-1227` (onNotification)

**Step 1: Replace the onNotification handler body**

Replace the onNotification handler (lines 1195-1227) with:
```typescript
onNotification: async (session, payload) => {
  cli.debug('NOTIFY', 'Notification received', {
    type: payload.notification_type,
    session: session.sessionId.slice(0, 8),
  });
  // Suppress idle notifications — status message already shows idle state
  if (payload.notification_type === 'idle_prompt') return;

  // permission_prompt: correlate with stashed PreToolUse to show approval buttons
  if (payload.notification_type === 'permission_prompt') {
    const stashed = preToolUseStash.popOldest(session.sessionId);
    if (stashed) {
      // Build approval message from the stashed PreToolUse context
      let approvalHtml = formatApprovalRequest(stashed.payload);
      if (stashed.agentPrefix) {
        approvalHtml = stashed.agentPrefix + approvalHtml;
      }

      cli.info('PERM', 'Permission request (Notification correlated)', {
        tool: stashed.payload.tool_name,
        session: session.sessionId.slice(0, 8),
      });

      const keyboard = makeApprovalKeyboard(stashed.payload.tool_use_id);
      const msg = await bot.api.sendMessage(config.telegramChatId, approvalHtml, {
        message_thread_id: stashed.threadId,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      approvalManager.trackPending(
        stashed.payload.tool_use_id,
        session.sessionId,
        stashed.threadId,
        msg.message_id,
        stashed.payload.tool_name,
        approvalHtml,
      );

      // Set topic to green — waiting for user approval (= waiting for input)
      topicStatusManager.setStatus(stashed.threadId, 'green');
      return;
    }

    // No stashed PreToolUse — fall through to show notification as-is
    // (can happen if PreToolUse was already flushed by timer)
    cli.warn('NOTIFY', 'permission_prompt with no stashed PreToolUse', {
      session: session.sessionId.slice(0, 8),
    });
  }

  const html = formatNotification(payload);
  // Notify only for prompts that block Claude and need user action
  const shouldNotify = payload.notification_type === 'permission_prompt'
    || payload.notification_type === 'elicitation_dialog';
  await batcher.enqueueImmediate(session.threadId, html, shouldNotify);
},
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: Notification handler pops stashed PreToolUse to show approval buttons"
```

---

### Task 5: Wire stash into index.ts — PostToolUse cleanup + SessionEnd

**Files:**
- Modify: `src/index.ts:1130-1148` (onToolComplete), `src/index.ts:1078-1084` (clear cleanup), `src/index.ts:1112-1119` (end cleanup), `src/index.ts:1610-1625` (shutdown)

**Step 1: Update onToolComplete to drain stash before checking approvalManager**

Replace onToolComplete (lines 1130-1148) with:
```typescript
onToolComplete: async (session, payload) => {
  // Check if this tool was stashed (no Notification came — auto-approved)
  const stashed = preToolUseStash.removeByToolUseId(session.sessionId, payload.tool_use_id);
  if (stashed) {
    // Auto-approved: route to bypassBatcher (no approval buttons were ever shown)
    bypassBatcher.add(session.sessionId, stashed.threadId, stashed.payload);
    return;
  }

  // Not stashed — check if there's a pending approval message to clean up
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

**Step 2: Add stash cleanup to both SessionEnd paths**

In the /clear cleanup block (around line 1083), add after `bypassBatcher.cleanupSession(session.sessionId);`:
```typescript
preToolUseStash.cleanupSession(session.sessionId);
```

In the normal SessionEnd cleanup block (around line 1117), add after `bypassBatcher.cleanupSession(session.sessionId);`:
```typescript
preToolUseStash.cleanupSession(session.sessionId);
```

**Step 3: Add stash shutdown**

In the shutdown sequence (around line 1616, near `bypassBatcher.shutdown()`), add:
```typescript
preToolUseStash.shutdown();
```

**Step 4: Run typecheck and full test suite**

Run: `npm run typecheck && npm test`
Expected: All pass

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: PostToolUse drains stash, SessionEnd/shutdown clean up stash timers"
```

---

### Task 6: Run full quality gate and manual verification

**Step 1: Run the full quality gate (CI parity)**

Run: `npx lefthook run quality`
Expected: lint, typecheck, test, secrets all pass

**Step 2: Verify the bot starts cleanly**

Check that the running bot (tsx watch) has reloaded without errors by inspecting the tmux pane output.

**Step 3: Commit any fixups if needed, then done**
