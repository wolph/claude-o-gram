# Design: Notification-Driven Approval Buttons + AskUserQuestion Regex Fix

**Date:** 2026-03-12
**Status:** Approved

## Problem

Two bugs in the Telegram bot's interaction with Claude Code:

### Bug 1: Approval buttons shown in bypass mode

When Claude Code runs with `--allow-dangerously-skip-permissions`, tools are auto-approved
but the bot still shows "Approval Required" messages with Approve/Deny buttons. Buttons are
never cleaned up afterward.

**Root cause (permission_mode mismatch):** The `permission_mode` field in hook payloads
reports the configured defaultMode (e.g., `'plan'`) regardless of
`--allow-dangerously-skip-permissions`. The bot only checks for `'bypassPermissions'` /
`'dontAsk'`, so the bypass check at `src/index.ts:1257` never triggers.

**Root cause (race condition):** PreToolUse and PostToolUse are both fire-and-forget HTTP
handlers. In auto-approve modes, PostToolUse fires before PreToolUse has finished calling
`trackPending()`, so `resolvePending()` finds nothing and buttons are never cleaned up.

### Bug 2: AskUserQuestion buttons don't work

Pressing a button after AskUserQuestion does nothing — the button spins, nothing appears in
logs.

**Root cause:** The callback regex `/^ask:([a-f0-9]+):(\w+)$/` only accepts lowercase hex
chars, but Claude API `tool_use_id` values start with `toolu_` (e.g., `toolu_vr...`). The
first 8 chars of the ID contain non-hex characters, so the regex never matches. grammY
silently skips unmatched callbacks.

## Design

### Bug 1: Notification-driven approval flow

Replace the current "show buttons on PreToolUse" approach with Notification correlation.
The `permission_prompt` Notification is the only reliable signal that Claude Code is
actually blocking for user input.

#### Current flow

```
PreToolUse -> format + send approval message with buttons immediately
PostToolUse -> try to clean up buttons (race condition)
```

#### New flow

```
PreToolUse -> stash payload in Map (no Telegram message yet)
Notification (permission_prompt) -> pop stashed PreToolUse -> send approval message with buttons
PostToolUse -> if stashed (no notification came) -> bypassBatcher; if pending approval -> clean up
Timer (2s) -> flush stash to bypassBatcher (fallback for silent auto-approve)
```

#### Stash data structure

```typescript
interface StashedPreToolUse {
  toolUseId: string;
  payload: PreToolUsePayload;
  agentPrefix: string | null;
  timer: ReturnType<typeof setTimeout>;
}
```

Per-session FIFO queue: `Map<string, StashedPreToolUse[]>`.

Multiple PreToolUse events can arrive before any Notification (e.g., a safe Read followed
by a dangerous Bash). FIFO ordering lets the Notification pop the correct entry.

#### Lifecycle by event

| Event | Action |
|-------|--------|
| PreToolUse | Push to session queue. Start 2s timer. |
| Notification (permission_prompt) | Pop oldest stash entry. Send approval message with buttons + trackPending. If no stash entry, show notification text as-is. |
| PostToolUse | Look up tool_use_id in stash. If found: remove, cancel timer, bypassBatcher. If not: existing onToolComplete cleanup. |
| Timer (2s) | Remove entry, route to bypassBatcher. |
| SessionEnd | Clear all stash entries for session. |

#### Why this fixes the race condition

Buttons only appear after Notification, which means Claude Code IS blocking for input.
PostToolUse won't fire until the user approves/denies, so `trackPending()` always completes
before `resolvePending()` runs.

#### Existing bypass check

The `permission_mode === 'bypassPermissions' || 'dontAsk'` check becomes redundant but is
kept as a fast path to skip stashing entirely for known bypass modes. It is no longer
load-bearing.

#### Non-blocking guarantee preserved

The bot's hooks return `{}` immediately. Claude Code always shows its local dialog. Telegram
buttons send tmux keystrokes as a convenience. This design does not change any of that.

### Bug 2: AskUserQuestion regex fix

Change callback regex from:
```typescript
/^ask:([a-f0-9]+):(\w+)$/
```
to:
```typescript
/^ask:([\w]+):(\w+)$/
```

`\w` matches `[a-zA-Z0-9_]`, covering all characters in Claude API tool_use_id prefixes.

Add logging at the top of the handler:
```typescript
console.log(`[ASK] Button pressed: ask:${idPrefix}:${optionStr} in thread ${threadId}`);
```

Add a catch-all fallback handler (after the main one) for unmatched `ask:` callbacks:
```typescript
bot.callbackQuery(/^ask:/, async (ctx) => {
  console.warn('[ASK] Unmatched callback data:', ctx.callbackQuery.data);
  await ctx.answerCallbackQuery({ text: 'Button format not recognized', show_alert: true });
});
```

## Files affected

- `src/index.ts` — PreToolUse stash logic, Notification correlation, PostToolUse stash cleanup, SessionEnd cleanup
- `src/bot/bot.ts` — AskUserQuestion callback regex fix, catch-all handler, logging
- `src/control/bypass-batcher.ts` — no changes (receives entries from timer/PostToolUse flush)
- `src/control/approval-manager.ts` — no changes (trackPending/resolvePending unchanged)
