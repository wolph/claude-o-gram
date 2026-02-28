---
phase: 03-control
verified: 2026-03-01T00:30:00Z
status: passed
score: 25/25 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 23/25
  gaps_closed:
    - "Late button taps (after timeout) answer with 'This approval has already expired.' alert and take no action"
    - "PreToolUse hook config is APPENDED to existing PreToolUse array, not replacing it"
  gaps_remaining: []
  regressions: []
---

# Phase 3: Control Verification Report

**Phase Goal:** Users can approve or deny Claude Code's tool calls from Telegram and send text input back to Claude Code, making the Telegram group a full remote control interface
**Verified:** 2026-03-01T00:30:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

#### Plan 01 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ApprovalManager creates externally-resolvable promises keyed by tool_use_id resolving to 'allow' or 'deny' | VERIFIED | `waitForDecision()` returns `new Promise<'allow' | 'deny'>` keyed by toolUseId in `pending` Map |
| 2 | Pending approvals auto-deny after APPROVAL_TIMEOUT_MS via setTimeout | VERIFIED | `setTimeout(() => { ... resolve('deny') }, this.timeoutMs)` in `waitForDecision` |
| 3 | ApprovalManager.decide() clears timeout, removes entry, resolves promise | VERIFIED | `clearTimeout(entry.timer)`, `this.pending.delete(toolUseId)`, `entry.resolve(decision)` all present |
| 4 | TextInputManager injects via tmux set-buffer + paste-buffer -p + send-keys Enter | VERIFIED | `execSync('tmux set-buffer ...')`, `execSync('tmux paste-buffer -p -t ...')`, `execSync('tmux send-keys -t ... Enter')` |
| 5 | TextInputManager queues text when tmux pane not available, with dequeue | VERIFIED | `send()` calls `queue()` when tmuxPane is null or inject fails; `dequeue()` exists |
| 6 | Risk indicator classifies tools as safe/caution/danger | VERIFIED | `classifyRisk()` with `dangerTools` Set (Bash, BashBackground) and `cautionTools` Set (Write, Edit, MultiEdit, NotebookEdit) |
| 7 | formatApprovalRequest produces HTML with tool name, risk indicator, action preview, ready for InlineKeyboard | VERIFIED | Returns HTML string with risk emoji + label, tool name, buildToolPreview output |
| 8 | AUTO_APPROVE and APPROVAL_TIMEOUT_MS env vars parsed in config | VERIFIED | `approvalTimeoutMs: parseInt(process.env.APPROVAL_TIMEOUT_MS \|\| '300000', 10)` and `autoApprove: process.env.AUTO_APPROVE === 'true'` in `src/config.ts` |

**Plan 01 score: 8/8**

#### Plan 02 Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 9 | POST /hooks/pre-tool-use route holds HTTP connection open until user responds or timeout fires | VERIFIED | `return await handlers.handlePreToolUse(payload)` — the `await` holds the Fastify response until the promise resolves |
| 10 | AUTO_APPROVE=true or bypassPermissions/dontAsk returns allow immediately without posting to Telegram | VERIFIED | `if (config.autoApprove)` and `if (payload.permission_mode === 'bypassPermissions' \|\| 'dontAsk')` guards return early |
| 11 | Approval message posted with InlineKeyboard containing Approve/Deny buttons with callback_data 'approve:{toolUseId}' and 'deny:{toolUseId}' | VERIFIED | `makeApprovalKeyboard()` creates `InlineKeyboard().text('Approve', 'approve:{toolUseId}').text('Deny', 'deny:{toolUseId}')` used in `onPreToolUse` |
| 12 | Tapping Approve resolves pending promise with 'allow', edits message to show 'Approved by X at time', removes buttons | VERIFIED | `approvalManager.decide(toolUseId, 'allow')` then `ctx.editMessageText(formatApprovalResult('allow', who, originalText), {reply_markup: undefined})` |
| 13 | Tapping Deny resolves pending promise with 'deny', edits message to show 'Denied by X at time', removes buttons | VERIFIED | `approvalManager.decide(toolUseId, 'deny')` then `ctx.editMessageText(formatApprovalResult('deny', who, originalText), {reply_markup: undefined})` |
| 14 | Late button taps (after timeout) answer with 'This approval has already expired.' alert and take no action | VERIFIED | Fix applied: both handlers now call `decide()` first, then `answerCallbackQuery()` only inside the `if (pending)` success branch. The `else` branch calls `answerCallbackQuery({text: 'This approval has already expired.', show_alert: true})` as the sole response — Telegram query is not pre-consumed. |
| 15 | HTTP response uses hookSpecificOutput.permissionDecision format ('allow' or 'deny') with permissionDecisionReason | VERIFIED | Returns `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ..., permissionDecisionReason: ... } }` |
| 16 | Denied via button uses 'Denied by user via Telegram'; timeout uses 'Auto-denied: approval timeout' | VERIFIED | `timeoutDenials` Set tracks timeout, `isTimeout` flag selects reason string after `waitForDecision` resolves |
| 17 | PreToolUse hook auto-installed with timeout = ceil(APPROVAL_TIMEOUT_MS/1000) + 60 seconds | VERIFIED | `const preToolUseTimeoutSec = Math.ceil(approvalTimeoutMs / 1000) + 60` used as hook timeout |
| 18 | PreToolUse hook config is APPENDED to existing PreToolUse array, not replacing it | VERIFIED | Fix applied: `userPreToolUse` filters out our previous entry by URL, then `mergedPreToolUse = [...userPreToolUse, ...ourPreToolUse]` rebuilds the array preserving user hooks on every run (first install and re-runs alike). |
| 19 | bot.on('message:text') handler matches session topics by thread ID and feeds text to TextInputManager | VERIFIED | `bot.on('message:text', ...)` calls `sessionStore.getByThreadId(threadId)` then `inputManager.send(session.tmuxPane, session.sessionId, text)` |
| 20 | Text replies skip bot commands (starting with /) | VERIFIED | `if (ctx.message.text.startsWith('/')) return;` |
| 21 | Successful text injection replies with 'Input sent' confirmation | VERIFIED | `case 'sent': await ctx.reply('\u2705 Input sent', ...)` |
| 22 | Queued text (no tmux) replies with message saying input was queued | VERIFIED | `case 'queued': await ctx.reply('\u{1F4E5} Input queued (${queueSize} pending) ...')` |
| 23 | tmux pane ID read from /tmp/claude-tmux-pane-{session_id}.txt on session start | VERIFIED | `tryReadTmuxPane(session.sessionId)` called in `onSessionStart` and lazily in `onPreToolUse` |
| 24 | SessionStart command hook script installed to capture TMUX_PANE | VERIFIED | `capture-tmux-pane.sh` written to `~/.claude/hooks/` and installed as `type: 'command'` in SessionStart hooks |
| 25 | All pending approvals cleaned up on session end, ApprovalManager and TextInputManager cleaned up on shutdown | VERIFIED | `onSessionEnd`: `approvalManager.cleanupSession(...)`, `inputManager.cleanup(...)`. Shutdown: `approvalManager.shutdown()` |

**Plan 02 score: 17/17**

**Overall score: 25/25 truths verified**

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/control/approval-manager.ts` | VERIFIED | Exports `ApprovalManager` class and `PendingApproval` interface. All required methods: `waitForDecision`, `decide`, `hasPending`, `cleanupSession`, `shutdown`, `setTimeoutCallback` |
| `src/control/input-manager.ts` | VERIFIED | Exports `TextInputManager` class. All methods: `inject`, `send`, `queue`, `dequeue`, `queueSize`, `cleanup` |
| `src/types/hooks.ts` | VERIFIED | `PreToolUsePayload` interface exported with `hook_event_name: 'PreToolUse'`, `tool_name`, `tool_input`, `tool_use_id` |
| `src/types/sessions.ts` | VERIFIED | `SessionInfo` contains `tmuxPane: string \| null` field |
| `src/types/config.ts` | VERIFIED | `AppConfig` contains `approvalTimeoutMs: number` and `autoApprove: boolean` fields |
| `src/bot/formatter.ts` | VERIFIED | Exports `formatApprovalRequest`, `formatApprovalResult`, `formatApprovalExpired` |
| `src/hooks/server.ts` | VERIFIED | POST `/hooks/pre-tool-use` route present and uses `await` for blocking |
| `src/hooks/handlers.ts` | VERIFIED | `HookCallbacks.onPreToolUse` in interface; `handlePreToolUse` method on `HookHandlers` |
| `src/bot/bot.ts` | VERIFIED | `callbackQuery` handlers for approve/deny patterns; `message:text` handler; `makeApprovalKeyboard` export. `answerCallbackQuery()` correctly placed inside `if (pending)` branch only. |
| `src/utils/install-hooks.ts` | VERIFIED | PreToolUse HTTP hook with computed timeout; SessionStart command hook for tmux capture; filter-and-rebuild merge preserves user hooks on re-runs. |
| `src/index.ts` | VERIFIED | `ApprovalManager` and `TextInputManager` instantiated; `onPreToolUse` callback fully wired; `timeoutDenials` and `approvalMessageTexts` maps for correct deny-reason and message-edit tracking |
| `src/sessions/session-store.ts` | VERIFIED | `updateTmuxPane` method present; `tmuxPane` defaults to null on load |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/hooks/server.ts` | `src/hooks/handlers.ts` | pre-tool-use route calls `handlers.handlePreToolUse` | VERIFIED | `return await handlers.handlePreToolUse(payload)` |
| `src/hooks/handlers.ts` | `src/index.ts` | onPreToolUse callback wired in index.ts | VERIFIED | `callbacks.onPreToolUse` defined and passed to `createHookHandlers` |
| `src/bot/bot.ts` | `src/control/approval-manager.ts` | callbackQuery handlers call `approvalManager.decide` | VERIFIED | `approvalManager.decide(toolUseId, 'allow')` and `decide(toolUseId, 'deny')` |
| `src/bot/bot.ts` | `src/control/input-manager.ts` | message:text handler calls `inputManager.send` | VERIFIED | `inputManager.send(session.tmuxPane, session.sessionId, text)` |
| `src/index.ts` | `src/control/approval-manager.ts` | Creates ApprovalManager, wires timeout callback | VERIFIED | `new ApprovalManager(config.approvalTimeoutMs)` and `approvalManager.setTimeoutCallback(...)` |
| `src/index.ts` | `src/control/input-manager.ts` | Creates TextInputManager, passes to bot setup | VERIFIED | `new TextInputManager()` then `createBot(config, sessionStore, approvalManager, inputManager)` |

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CTRL-01 | 03-01, 03-02 | PreToolUse hook blocks and posts permission questions with inline Approve/Deny buttons | SATISFIED | Blocking route, InlineKeyboard, callback handlers all implemented and wired |
| CTRL-02 | 03-01, 03-02 | User can reply with text from Telegram that feeds back into Claude Code | SATISFIED | `message:text` handler in bot.ts calls `inputManager.send()` which injects via tmux |
| CTRL-03 | 03-01, 03-02 | Blocked hooks auto-deny after configurable timeout | SATISFIED | `setTimeout` in `waitForDecision` resolves with 'deny'; `APPROVAL_TIMEOUT_MS` env var configures duration |

No orphaned requirements — all three Phase 3 requirements appear in both plan frontmatter entries and in REQUIREMENTS.md traceability table.

---

### Anti-Patterns Found

No blockers or warnings remaining. The two previously-identified anti-patterns have been resolved:

- `src/bot/bot.ts`: `ctx.answerCallbackQuery()` is now called only inside the `if (pending)` branch, not unconditionally at the start of each handler. Late-tap alert is now correctly delivered.
- `src/utils/install-hooks.ts`: PreToolUse merge now uses filter-and-rebuild (`userPreToolUse` + `ourPreToolUse`) on every run, correctly preserving user hooks across re-runs.

---

### Human Verification Required

#### 1. End-to-end Approval Flow

**Test:** Start Claude Code in a tmux session with a project. Trigger a tool call that requires approval (e.g., a Bash command in a project using `defaultMode: "prompt"`). Observe the Telegram topic.
**Expected:** An approval message with risk emoji, tool name, command preview, and Approve/Deny inline buttons appears in the session topic. Tapping Approve allows the tool call to proceed; tapping Deny blocks it. Message updates in place showing "Approved/Denied by @user at HH:MM:SS".
**Why human:** Requires a live Claude Code + Telegram session. Cannot verify the full HTTP blocking pattern, grammY polling loop, and Telegram message editing flow programmatically.

#### 2. Timeout Expiry Display

**Test:** Start an approval-required tool call, then do NOT tap any button for the configured APPROVAL_TIMEOUT_MS (or set a very short timeout for testing).
**Expected:** The approval buttons disappear and the message is edited to show an expiry indicator. Claude Code receives a deny response.
**Why human:** Requires a live timeout cycle; cannot observe the message edit and HTTP response connection programmatically.

#### 3. Late-Tap Alert (Gap 1 Fix Confirmation)

**Test:** After a timeout expires and the message shows "Expired", tap one of the Approve or Deny buttons.
**Expected:** A Telegram alert popup appears saying "This approval has already expired." No other action occurs.
**Why human:** Requires manual confirmation that grammY's `show_alert: true` popup displays correctly end-to-end with the now-correct placement of `answerCallbackQuery()`.

#### 4. Text Input via tmux

**Test:** Start Claude Code in a tmux session. After the session starts and the topic appears, reply to any message in the topic with text (not a command).
**Expected:** Bot replies with "Input sent" confirmation. The text appears in the Claude Code tmux pane as if typed.
**Why human:** Requires verifying actual tmux pane injection occurs; the TMUX_PANE env var must be captured by the command hook.

#### 5. Hook Preservation on Re-run (Gap 2 Fix Confirmation)

**Test:** Manually add a custom PreToolUse hook to `~/.claude/settings.json`, then restart the bot. Inspect `~/.claude/settings.json` again.
**Expected:** Both the custom user hook and the bot's hook appear in the PreToolUse array. The custom hook is not overwritten.
**Why human:** Requires inspecting the settings file after a live bot restart with a pre-existing custom hook entry.

---

### Summary

Both previously-identified gaps have been resolved:

**Gap 1 (Blocker — Closed):** `src/bot/bot.ts` now calls `decide()` first in both the approve and deny callback handlers. The `answerCallbackQuery()` call that dismisses the loading spinner is placed inside the `if (pending)` success branch. In the `else` (late-tap) branch, `answerCallbackQuery({text: 'This approval has already expired.', show_alert: true})` is the sole response, so Telegram's callback query is not pre-consumed and the alert will display correctly.

**Gap 2 (Warning — Closed):** `src/utils/install-hooks.ts` now uses a filter-and-rebuild strategy for the PreToolUse array on every invocation: `existingPreToolUse` entries that match our URL are filtered out (removing our old entry), the remaining user hooks form `userPreToolUse`, and the final array is `[...userPreToolUse, ...ourPreToolUse]`. This is correct on first install (no user hooks, result is just ours), on re-run without user hooks (same), and on re-run with user hooks (theirs preserved, ours updated).

TypeScript compilation passes with zero errors (`npx tsc --noEmit` produces no output).

The phase goal is fully achieved: users can approve or deny Claude Code's tool calls from Telegram and send text input back to Claude Code, making the Telegram group a full remote control interface.

---

_Verified: 2026-03-01T00:30:00Z_
_Verifier: Claude (gsd-verifier)_
