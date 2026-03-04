# Output Reduction + Task Checklist Design

**Date**: 2026-03-04
**Status**: Approved

## Problem

Telegram output is far too verbose compared to Claude Code's terminal. Individual tool call lines, bypass batch trees, and subagent spawn messages create walls of text. Claude Code's terminal shows collapsed summaries and a live checklist — Telegram should match.

## Design

### 1. Suppress PostToolUse compact lines

In `onToolUse`: skip `batcher.enqueue()` entirely. Still update the status message (pinned message shows tool activity). Removes all `Read(...)`, `Grep(...)`, `Bash(...)` lines.

### 2. Replace bypass batch tree with summary line

Change `formatBypassBatch` to return a single count: `"⚡ 43 auto-approved tool calls"`. No tree.

### 3. Suppress subagent spawn, keep done

- **Suppress** `formatSubagentSpawn` — don't send to Telegram
- **Keep** `formatSubagentDone`: `"✓ Agent(Explore) done (1m 30s)"`

### 4. Task Checklist — live-updating message

New component: **TaskChecklist** (per-session)

**Data model:** Per session, ordered list of tasks:
```
{ id: string, subject: string, status: 'pending' | 'in_progress' | 'completed' | 'deleted' }
```

**Capture from PostToolUse:**
- `TaskCreate` → add task (extract `subject` from `tool_input`, `id` from `tool_response`)
- `TaskUpdate` → update status (extract `taskId` and `status` from `tool_input`)
- `TaskList` / `TaskGet` → ignore (read-only)

**Rendering — single message, edited in-place:**
```
✢ Task progress

  ✔ ~~Explore project context~~
  ◼ Ask clarifying questions
  ◻ Propose approaches
  ◻ Present design
  ◻ Write design doc
```

Indicators:
- `◻` — pending
- `◼` (bold subject) — in_progress
- `✔` (strikethrough subject) — completed
- Deleted tasks: removed from display

**Message lifecycle:**
- First TaskCreate → send new message, store message ID
- Subsequent TaskCreate/TaskUpdate → edit message in-place
- Session end / context clear → cleanup tracker

### 5. Resulting Telegram output

```
─── context cleared at 13:05 ───

Let me explore the telegram bot code...

✢ Task progress
  ✔ ~~Explore project context~~
  ◼ Ask clarifying questions
  ◻ Propose approaches
  ◻ Present design

✓ Agent(Explore) done (1m 30s)

Good news — the exploration found the full propagation chain...

❓ Input Needed — Question
Which approach do you prefer?
```

### Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Suppress PostToolUse enqueue, suppress subagent spawn, wire task checklist |
| `src/bot/formatter.ts` | Add `formatTaskChecklist()` |
| `src/control/bypass-batcher.ts` | Change flush to use count-only summary |
| New: `src/monitoring/task-checklist.ts` | TaskChecklist class — per-session task tracking + message management |
