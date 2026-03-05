# Output Reduction + Task Checklist — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce Telegram output to match Claude Code's terminal — suppress individual tool lines, replace bypass batch trees with summary counts, suppress subagent spawn messages, and add a live-updating task checklist.

**Architecture:** Four independent changes to the output pipeline: (1) suppress PostToolUse compact lines, (2) simplify bypass batch to count-only, (3) suppress subagent spawn messages, (4) add TaskChecklist component that intercepts TaskCreate/TaskUpdate PostToolUse events and maintains an in-place edited checklist message per session.

**Tech Stack:** TypeScript, grammY Bot API (`editMessageText`, `sendMessage`)

---

### Task 1: Create TaskChecklist component

**Files:**
- Create: `src/monitoring/task-checklist.ts`

**Step 1: Create the TaskChecklist class**

Create `src/monitoring/task-checklist.ts` with the following content:

```typescript
import { escapeHtml } from '../utils/text.js';

/** Tracked task entry */
interface TaskEntry {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

/** Callbacks for sending/editing Telegram messages */
export interface TaskChecklistCallbacks {
  send(threadId: number, html: string): Promise<number>;
  edit(messageId: number, html: string): Promise<void>;
}

/**
 * Maintains a live-updating task checklist message per session.
 *
 * Intercepts TaskCreate and TaskUpdate PostToolUse events,
 * tracks task state, and renders a single Telegram message
 * that is edited in-place as tasks progress.
 */
export class TaskChecklist {
  private sessions = new Map<string, {
    threadId: number;
    tasks: TaskEntry[];
    messageId: number;
  }>();
  private callbacks: TaskChecklistCallbacks;
  private updateTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private static DEBOUNCE_MS = 500;

  constructor(callbacks: TaskChecklistCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Handle a PostToolUse event. Returns true if the event was consumed
   * (i.e., it was a TaskCreate or TaskUpdate that the checklist handled).
   */
  handleToolUse(
    sessionId: string,
    threadId: number,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
  ): boolean {
    if (toolName === 'TaskCreate') {
      const subject = (toolInput.subject as string) || 'Untitled task';
      // Extract task ID from response — format: "Task #N created successfully: ..."
      const responseStr = typeof toolResponse === 'string'
        ? toolResponse
        : (toolResponse.content as string) || (toolResponse.result as string) || JSON.stringify(toolResponse);
      const idMatch = responseStr.match(/#(\d+)/);
      const id = idMatch ? idMatch[1] : String(Date.now());

      let session = this.sessions.get(sessionId);
      if (!session) {
        session = { threadId, tasks: [], messageId: 0 };
        this.sessions.set(sessionId, session);
      }
      session.tasks.push({ id, subject, status: 'pending' });
      this.scheduleUpdate(sessionId);
      return true;
    }

    if (toolName === 'TaskUpdate') {
      const taskId = String(toolInput.taskId || '');
      const newStatus = toolInput.status as string | undefined;
      const session = this.sessions.get(sessionId);
      if (!session || !taskId) return true; // Consumed but nothing to do

      const task = session.tasks.find(t => t.id === taskId);
      if (task && newStatus) {
        if (newStatus === 'deleted') {
          session.tasks = session.tasks.filter(t => t.id !== taskId);
        } else {
          task.status = newStatus as TaskEntry['status'];
        }
        // Also update subject if provided
        if (toolInput.subject) {
          task.subject = toolInput.subject as string;
        }
        this.scheduleUpdate(sessionId);
      }
      return true;
    }

    // TaskList, TaskGet — ignore but consume
    if (toolName === 'TaskList' || toolName === 'TaskGet') {
      return true;
    }

    return false; // Not a task tool
  }

  /** Clean up a session's checklist state */
  cleanup(sessionId: string): void {
    const timer = this.updateTimer.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.updateTimer.delete(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  /** Shut down all sessions */
  shutdown(): void {
    for (const sessionId of this.sessions.keys()) {
      this.cleanup(sessionId);
    }
  }

  private scheduleUpdate(sessionId: string): void {
    const existing = this.updateTimer.get(sessionId);
    if (existing) clearTimeout(existing);

    this.updateTimer.set(sessionId, setTimeout(() => {
      this.updateTimer.delete(sessionId);
      void this.render(sessionId);
    }, TaskChecklist.DEBOUNCE_MS));
  }

  private async render(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tasks.length === 0) return;

    const html = this.formatChecklist(session.tasks);

    try {
      if (session.messageId === 0) {
        session.messageId = await this.callbacks.send(session.threadId, html);
      } else {
        await this.callbacks.edit(session.messageId, html);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('message is not modified')) {
        return; // Content unchanged — fine
      }
      console.warn('[CHECKLIST] Failed to update:', err instanceof Error ? err.message : err);
    }
  }

  private formatChecklist(tasks: TaskEntry[]): string {
    const lines: string[] = ['\u2722 <b>Task progress</b>', ''];

    for (const task of tasks) {
      const escaped = escapeHtml(task.subject);
      switch (task.status) {
        case 'completed':
          lines.push(`  \u2714 <s>${escaped}</s>`);
          break;
        case 'in_progress':
          lines.push(`  \u25FC <b>${escaped}</b>`);
          break;
        case 'pending':
        default:
          lines.push(`  \u25FB ${escaped}`);
          break;
      }
    }

    return lines.join('\n');
  }
}
```

**Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/monitoring/task-checklist.ts
git commit -m "feat: add TaskChecklist component for live-updating task progress"
```

---

### Task 2: Suppress PostToolUse lines, wire TaskChecklist

**Files:**
- Modify: `src/index.ts`

**Step 1: Add TaskChecklist import**

At the top of `src/index.ts`, after the existing imports (around line 28, after the `ClearDetector` import), add:

```typescript
import { TaskChecklist } from './monitoring/task-checklist.js';
```

**Step 2: Initialize TaskChecklist instance**

After the `bypassBatcher` initialization (around line 262, before the `// 8. Per-session monitoring instances` comment), add:

```typescript
// 7e. Task checklist: live-updating task progress per session
const taskChecklist = new TaskChecklist({
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
});
```

**Step 3: Replace the `onToolUse` handler body**

Replace the entire `onToolUse` handler (from `// Set topic to yellow` through the closing `},` before `onNotification`) with:

```typescript
    onToolUse: async (session, payload) => {
      // Auto-approve resolution: if there's a pending approval for this tool_use_id,
      // update the message (existing logic for approval message cleanup)
      if (payload.tool_use_id) {
        const pending = approvalManager.resolve(payload.tool_use_id, 'allow');
        if (pending) {
          try {
            const resultText = formatApprovalResult('allow', 'auto', pending.originalText);
            await bot.api.editMessageText(config.telegramChatId, pending.messageId, resultText, {
              parse_mode: 'HTML',
              reply_markup: undefined,
            });
          } catch (err) {
            if (!(err instanceof Error && err.message.includes('message is not modified'))) {
              console.warn('Failed to update local approval message:', err instanceof Error ? err.message : err);
            }
          }
        }
      }

      // Set topic to yellow (processing) -- debounced, won't spam API
      topicStatusManager.setStatus(session.threadId, 'yellow');

      // Task tools: route to checklist (consumes TaskCreate, TaskUpdate, TaskList, TaskGet)
      if (taskChecklist.handleToolUse(
        session.sessionId,
        session.threadId,
        payload.tool_name,
        payload.tool_input,
        payload.tool_response,
      )) {
        // Still update status message even for task tools
        const monitor = monitors.get(session.sessionId);
        if (monitor) {
          const latestSession = sessionStore.get(session.sessionId);
          if (latestSession) {
            monitor.statusMessage.requestUpdate(
              buildStatusData(latestSession, payload.tool_name),
            );
          }
        }
        return;
      }

      // All other tools: suppress display, only update status message
      const monitor = monitors.get(session.sessionId);
      if (monitor) {
        const latestSession = sessionStore.get(session.sessionId);
        if (latestSession) {
          monitor.statusMessage.requestUpdate(
            buildStatusData(latestSession, payload.tool_name),
          );
        }
      }
    },
```

**Important:** This replaces the existing `onToolUse` handler entirely. The old handler at lines 815-887 (starting after the `onSessionEnd` handler's closing brace) should be fully replaced. The approval message cleanup at the top must be preserved — check the lines before `// Set topic to yellow` in the current handler to see if there's approval resolution code. If so, include it in the replacement above (it's included as the first block).

**Step 4: Add `taskChecklist.cleanup()` to all session cleanup paths**

There are 4 cleanup locations in `src/index.ts`. Add `taskChecklist.cleanup(sessionId)` alongside the existing `seenAskIds.delete(sessionId)` calls:

1. **handleClearDetected (around line 385):** After `seenAskIds.delete(oldSession.sessionId);` add:
   ```typescript
   taskChecklist.cleanup(oldSession.sessionId);
   ```

2. **onSessionStart clear path (around line 637):** After `seenAskIds.delete(oldSessionId);` add:
   ```typescript
   taskChecklist.cleanup(oldSessionId);
   ```

3. **onSessionEnd clear path (around line 768):** After `seenAskIds.delete(session.sessionId);` add:
   ```typescript
   taskChecklist.cleanup(session.sessionId);
   ```

4. **onSessionEnd normal path (around line 805):** After `seenAskIds.delete(session.sessionId);` add:
   ```typescript
   taskChecklist.cleanup(session.sessionId);
   ```

**Step 5: Add `taskChecklist.shutdown()` to the shutdown handler**

Find the existing `bypassBatcher.shutdown()` call in the shutdown section and add after it:

```typescript
taskChecklist.shutdown();
```

**Step 6: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: suppress PostToolUse lines, wire TaskChecklist for live progress"
```

---

### Task 3: Replace bypass batch tree with summary count

**Files:**
- Modify: `src/bot/formatter.ts`
- Modify: `src/control/bypass-batcher.ts`

**Step 1: Replace `formatBypassBatch` in formatter.ts**

In `src/bot/formatter.ts`, find the `formatBypassBatch` function (around line 698) and replace the entire function body:

From:
```typescript
export function formatBypassBatch(
  entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>,
): string {
  const lines: string[] = ['\u26A1 <b>Auto-approved</b> (bypass mode)'];

  for (let i = 0; i < entries.length; i++) {
    const { toolName, toolInput } = entries[i];
    const isLast = i === entries.length - 1;
    const prefix = isLast ? '\u2514' : '\u251C';
    const preview = buildBypassPreview(toolName, toolInput);
    lines.push(`${prefix} ${escapeHtml(preview)}`);
  }

  return lines.join('\n');
}
```

To:
```typescript
export function formatBypassBatch(
  entries: Array<{ toolName: string; toolInput: Record<string, unknown> }>,
): string {
  return `\u26A1 ${entries.length} auto-approved tool call${entries.length === 1 ? '' : 's'}`;
}
```

**Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/bot/formatter.ts src/control/bypass-batcher.ts
git commit -m "feat: replace bypass batch tree with summary count"
```

---

### Task 4: Suppress subagent spawn messages

**Files:**
- Modify: `src/index.ts`

**Step 1: Remove the spawn announcement from `onSubagentStart`**

In `src/index.ts`, find the `onSubagentStart` callback (around line 979). Change the block that sends the spawn message:

From:
```typescript
      // Post spawn announcement as inline message (suppressed when subagentOutput is false)
      if (runtimeSettings.subagentOutput) {
        const indent = subagentTracker.getIndent(agent.agentId);
        const spawnHtml = formatSubagentSpawn(agent.displayName, agent.description, indent);
        await batcher.enqueueImmediate(session.threadId, spawnHtml);
      }
```

To:
```typescript
      // Spawn announcements suppressed — subagentDone shows completion summary
```

**Step 2: Remove the unused `formatSubagentSpawn` import**

In the import block at the top of `src/index.ts` (around line 18), remove `formatSubagentSpawn` from the imports:

Change:
```typescript
  formatSubagentSpawn,
  formatSubagentDone,
```
To:
```typescript
  formatSubagentDone,
```

**Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: suppress subagent spawn messages, keep done summaries"
```

---

### Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | TaskChecklist component | New: `src/monitoring/task-checklist.ts` |
| 2 | Suppress PostToolUse, wire checklist | `src/index.ts` |
| 3 | Bypass batch → summary count | `src/bot/formatter.ts` |
| 4 | Suppress subagent spawn | `src/index.ts` |
