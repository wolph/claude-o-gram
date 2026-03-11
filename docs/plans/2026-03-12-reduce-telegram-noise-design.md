# Reduce Telegram Message Noise — Design

## Problem

Two user-facing bugs plus excessive API call volume causing Telegram to throttle
the bot, which makes AskUserQuestion inline buttons silently fail on tap.

### Symptoms

1. **AskUserQuestion buttons don't respond** — Telegram ignores taps (no spinner,
   no edit) because the bot's callback query response times out under API pressure.
2. **Approval buttons shown in auto-approve modes** — `accept-all`, `safe-only`,
   `until-done`, and `same-tool` modes from `PermissionModeManager` are not checked
   in `onPreToolUse`. Only Claude Code's built-in `bypassPermissions`/`dontAsk` are
   checked.
3. **Approval buttons linger after tool completes** — no cleanup path exists in
   PostToolUse to remove buttons from the corresponding PreToolUse message.

### Root Cause

Telegram throttles bots that send too many API calls (messages + edits) per minute
to a single chat. Three sources of excessive calls:

- Spurious approval messages (5-10 per session in auto-approve modes)
- Status message edits every 3 seconds during active tool use (~20/min)
- Tool output batches for non-essential tools (Agent, TaskCreate, WebSearch, etc.)

## Solution: Four Surgical Fixes

### Fix 1: Suppress Approvals in Auto-Approve Modes

**File:** `src/index.ts` (onPreToolUse callback, ~line 1248)

After the existing `bypassPermissions`/`dontAsk` check, add a second check against
`PermissionModeManager.shouldAutoApprove()`. If the custom mode would auto-approve
this tool call, route to `bypassBatcher` instead of sending an approval message
with buttons.

```typescript
// After existing bypass check:
if (permissionModeManager.shouldAutoApprove(session.sessionId, payload.tool_name, payload.tool_input)) {
  bypassBatcher.add(session.sessionId, session.threadId, payload);
  permissionModeManager.incrementAutoApproved(session.sessionId);
  return;
}
```

### Fix 2: Clean Up Approval Buttons on PostToolUse

**File:** `src/index.ts` (onToolUse callback or handlePostToolUse)

When a tool completes, check `approvalManager` for a pending approval matching
the `tool_use_id`. If found, resolve it and edit the message to remove buttons.

```typescript
const pending = approvalManager.resolvePending(payload.tool_use_id);
if (pending) {
  await bot.api.editMessageText(
    config.telegramChatId,
    pending.messageId,
    `${pending.originalHtml}\n\n⚡ <i>Completed</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}
```

Handles cases where the user approved locally in the terminal or Claude Code
proceeded without waiting.

### Fix 3: Smart Status Message Updates

**File:** `src/monitoring/status-message.ts`

Replace the 3-second debounce with meaningful-change detection gated by a 10-second
minimum interval.

**Update triggers** (any of these, still gated by 10s floor):

- **Status transition** (active ↔ idle): only after new state persists for 5+ seconds
  to avoid flickering during brief pauses between tool calls.
- **Context % delta > 10%**: meaningful progress signal.
- **Files changed count changed**: meaningful work signal.
- **Session closed**: always flush immediately on destroy (existing behavior).

**Ignored changes:**

- `currentTool` changing (Read → Grep → Edit cycling)
- Context % moving by small amounts (30% → 32%)

New fields:

```typescript
private static readonly MIN_UPDATE_INTERVAL_MS = 10_000;
private static readonly STATUS_SETTLE_MS = 5_000;
private static readonly CONTEXT_DELTA_THRESHOLD = 10;
private lastSentData: StatusData | null = null;
private statusChangeTimer: ReturnType<typeof setTimeout> | null = null;
```

Estimated reduction: ~80-90% fewer `editMessageText` calls for the status message.

### Fix 4: Default Verbosity to Minimal

**Files:** `src/monitoring/verbosity.ts`, `src/hooks/handlers.ts`

Change the default verbosity tier from `normal` to `minimal`. In minimal mode, only
Write/Edit/MultiEdit/Bash tool calls are posted to Telegram — the tools that
actually change things.

```typescript
// verbosity.ts — parseVerbosityTier default
return 'minimal'; // was 'normal'

// handlers.ts — fallback
const verbosity = session.verbosity || 'minimal'; // was 'normal'
```

Users can still switch to `normal` or `verbose` via settings. The pinned status
message already shows the current tool at a glance.

## Files Touched

| File | Changes |
|------|---------|
| `src/index.ts` | Fix 1 (approval suppression) + Fix 2 (PostToolUse cleanup) |
| `src/monitoring/status-message.ts` | Fix 3 (smart update logic) |
| `src/monitoring/verbosity.ts` | Fix 4 (default to minimal) |
| `src/hooks/handlers.ts` | Fix 4 (verbosity fallback) |

## Expected Impact

- Approval messages eliminated in auto-approve modes
- Lingering approval buttons cleaned up automatically
- Status message edits reduced ~80-90%
- Tool output messages reduced to only mutation tools
- Net result: AskUserQuestion buttons become responsive
