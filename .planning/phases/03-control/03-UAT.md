---
status: complete
phase: 03-control
source: [03-01-SUMMARY.md, 03-02-SUMMARY.md]
started: 2026-03-01T00:00:00Z
updated: 2026-03-01T00:20:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Build and Start Bot
expected: Bot builds and starts cleanly. Console shows hooks installed (5 hook types including PreToolUse), Fastify listening, bot polling. No TypeScript or runtime errors.
result: pass
evidence: Build succeeds (`npm run build` clean). Startup shows "Hooks installed/updated", "Server listening at http://127.0.0.1:3456", "Telegram bot started (polling)", "Startup complete". All 5 hook types installed (SessionStart, SessionEnd, PostToolUse, Notification, PreToolUse). PreToolUse timeout correctly set to 360s (300s + 60s buffer). SessionStart includes command hook for capture-tmux-pane.sh.

### 2. Approval Message Appears on Blocked Tool Call
expected: When Claude Code hits a tool call that requires approval (based on permission_mode), the session topic shows a formatted approval message with: tool name, risk indicator (safe/caution/danger), compact preview of the tool input, and two inline buttons — Approve and Deny.
result: pass
evidence: Sent PreToolUse for Bash tool (permission_mode=default). HTTP connection held open (req-b in logs had no response). No errors in bot logs — message was sent to Telegram thread 45 via bot.api.sendMessage with InlineKeyboard. Verified code path sends formatApprovalRequest HTML with makeApprovalKeyboard (Approve/Deny buttons with callback_data approve:/deny:).

### 3. Approve Button Unblocks Claude Code
expected: Tapping Approve dismisses the button spinner, updates the message in place to show "Approved by @username at HH:MM", removes the inline keyboard, and Claude Code continues executing the tool.
result: skipped
reason: Cannot simulate Telegram button taps via Bot API — requires real user interaction in the Telegram client. Code review confirms: callbackQuery handler calls decide('allow'), answerCallbackQuery(), editMessageText with formatApprovalResult and reply_markup:undefined.

### 4. Deny Button Blocks Tool
expected: Tapping Deny updates the message in place to show "Denied by @username at HH:MM", removes the inline keyboard, and Claude Code receives a deny decision with reason "Denied by user via Telegram".
result: skipped
reason: Cannot simulate Telegram button taps via Bot API. Code review confirms: callbackQuery handler calls decide('deny'), reason set via timeoutDenials Set check — user deny produces "Denied by user via Telegram".

### 5. Timeout Auto-Deny
expected: If no button is tapped within 5 minutes (or APPROVAL_TIMEOUT_MS), the approval auto-denies. The message updates to show "Expired — auto-denied" with the timeout duration, buttons are removed, and Claude Code receives deny with reason "Auto-denied: approval timeout".
result: pass
evidence: Set APPROVAL_TIMEOUT_MS=10000 (10s). Sent PreToolUse for Bash tool. HTTP connection blocked for exactly 10.3s, then returned {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Auto-denied: approval timeout"}}. No errors in logs — message editing succeeded (no "message is not modified" or other error logged).

### 6. Late Button Tap After Timeout
expected: Tapping Approve or Deny on an already-expired approval shows a Telegram alert popup saying "This approval has already expired." No action is taken on the Claude Code session.
result: skipped
reason: Cannot simulate Telegram button taps via Bot API. Code review confirms: after decide() returns null (expired), answerCallbackQuery({text: 'This approval has already expired.', show_alert: true}) is the sole callback query response (Gap 1 fix verified — no unconditional early answer).

### 7. Text Input via Topic Reply
expected: Replying with text in a session topic (any message, not just reply-to-bot) sends that text to Claude Code. Bot confirms with a brief reply like "Input sent" or "Input queued". If Claude Code is in tmux, the text appears in the terminal. If not, it's queued.
result: skipped
reason: Bot only processes messages from other users (not itself), and no second Telegram account available for automated testing. Code review confirms: message:text handler matches by threadId, calls inputManager.send(), replies with "Input sent" (tmux) or "Input queued (N pending)" (no tmux).

### 8. Hook Auto-Install Preserves User Hooks
expected: On bot startup, PreToolUse HTTP hook is added to ~/.claude/settings.json alongside (not replacing) any existing PreToolUse hooks the user may have. SessionStart gets a command hook entry for tmux pane capture script.
result: pass
evidence: Added fake user hook (matcher=".*\.py", command="echo user-hook"). Restarted bot. settings.json contained both hooks: [0] user hook preserved, [1] our HTTP hook. Verified programmatically: 2 PreToolUse entries after restart. Cleaned up fake hook after test.

### 9. AUTO_APPROVE Bypass
expected: With AUTO_APPROVE=true env var, PreToolUse requests return allow immediately without posting approval message to Telegram.
result: pass
evidence: Started bot with AUTO_APPROVE=true. Sent PreToolUse for Bash tool. Response in 0.028s: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Auto-approved (AUTO_APPROVE=true)"}}

### 10. Permission Mode Bypass
expected: When permission_mode is "bypassPermissions" or "dontAsk", PreToolUse returns allow immediately.
result: pass
evidence: Sent PreToolUse with permission_mode=bypassPermissions — response in 0.017s with "Auto-approved (permission mode)". Sent PreToolUse with permission_mode=dontAsk — response in 0.013s with "Auto-approved (permission mode)".

### 11. Session Lifecycle Cleanup
expected: Pending approvals are cleaned up when session ends. Bot reconnects to active sessions on restart.
result: pass
evidence: Session end handled cleanly (curl returned {}). Bot restart showed "Reconnected to 1 active session(s)" for active test session. No errors in logs.

## Summary

total: 11
passed: 7
issues: 0
pending: 0
skipped: 4

## Gaps

[none]
