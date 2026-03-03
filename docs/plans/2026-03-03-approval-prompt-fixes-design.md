# Approval Prompt Fixes Design

**Date**: 2026-03-03
**Status**: Approved

## Problems

1. **Orphaned buttons**: When PostToolUse resolves a pending approval but the bot restarts (losing the in-memory pending Map), Accept/Deny buttons remain on old Telegram messages forever. Clicking them shows "Already resolved" but doesn't remove the buttons.

2. **Bypass mode spam**: When `permission_mode === 'bypassPermissions'`, PreToolUse still sends individual approval messages with Accept/Deny buttons to Telegram — pointless since Claude Code auto-approves everything.

3. **Stale button UX**: Clicking a stale button shows a toast ("Already resolved") but leaves the buttons intact, leading to confusion.

4. **Notification leakage**: `permission_prompt` notifications are forwarded to Telegram even in bypass mode.

## Design

### 1. Bypass Mode — Batched Auto-Approved Summary

When `permissionMode === 'bypassPermissions'` or `'dontAsk'`:

- **Skip** sending individual approval messages with buttons.
- **Buffer** auto-approved tool descriptions per session.
- **Batch send/edit** a single rolling message every 10 seconds containing all accumulated entries.
- **Format**: Compact tree-style, no buttons:
  ```
  ⚡ Auto-approved (bypass mode)
  ├ Read(src/index.ts)
  ├ Bash(npm test)
  ├ Write(src/utils/helper.ts)
  └ Edit(src/bot/bot.ts)
  ```
- **Reset**: After 30 seconds of inactivity (no new tool calls), next batch starts a fresh message.
- First tool call in a batch → send new message, start 10s flush timer.
- Subsequent calls within window → buffer only.
- Timer fires → edit message with all accumulated entries, clear buffer.

### 2. Persistent Pending Store

Replace the in-memory `Map<string, PendingApproval>` with a file-backed store.

- **Storage**: `~/.claude/telegram-bot/pending-approvals.json`
- **Format**:
  ```json
  {
    "tu-abc123": {
      "sessionId": "sess-1",
      "messageId": 456,
      "threadId": 789,
      "toolName": "Bash",
      "originalHtml": "...",
      "createdAt": 1709500000000
    }
  }
  ```
- **Write strategy**: Debounced (500ms) to avoid I/O bursts. `writeFileSync` on shutdown.
- **Startup**: Load from disk, prune entries older than 1 hour.
- **Stale cleanup**: On startup, edit each orphaned message to strip the Accept/Deny keyboard and append "Resolved — session ended".

### 3. Stale Button Cleanup on Click

When a user clicks Accept/Deny on a message whose pending has already been resolved:

- Show toast: "Already resolved."
- **Also** edit the message to remove the inline keyboard AND append "✅ Resolved" to the message text.

Changes in both `approve:` and `deny:` callback handlers in `bot.ts`.

### 4. Notification Suppression in Bypass Mode

In `onNotification`, when session's `permissionMode` is `'bypassPermissions'` or `'dontAsk'`:

- **Suppress** `permission_prompt` notifications (don't send to Telegram).
- **Keep** forwarding `idle_prompt`, `auth_success`, and `elicitation_dialog` regardless of mode.

## Files to Modify

| File | Changes |
|------|---------|
| `src/control/approval-manager.ts` | Add file persistence, startup load/prune, debounced writes |
| `src/index.ts` | Bypass mode check in `onPreToolUse`, batch buffer logic, notification suppression in `onNotification` |
| `src/bot/bot.ts` | Stale button cleanup in approve/deny callback handlers |
| `src/bot/formatter.ts` | New `formatBypassBatch()` for the batched summary message |

## New Files

| File | Purpose |
|------|---------|
| `src/control/bypass-batcher.ts` | Per-session batch buffer + 10s flush timer + 30s inactivity reset |
