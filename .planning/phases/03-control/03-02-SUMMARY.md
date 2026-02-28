---
phase: 03-control
plan: 02
subsystem: control
tags: [approval-wiring, callback-query, inline-keyboard, text-input, tmux, pretooluse, blocking-hook]

# Dependency graph
requires:
  - phase: 03-control-plan-01
    provides: ApprovalManager, TextInputManager, formatApprovalRequest, formatApprovalResult, formatApprovalExpired, PreToolUsePayload, extended SessionInfo/AppConfig
  - phase: 01-foundation
    provides: HookHandlers, createHookServer, createBot, SessionStore, installHooks, TopicManager, MessageBatcher
  - phase: 02-monitoring
    provides: TranscriptWatcher, StatusMessage, SummaryTimer, verbosity system
provides:
  - POST /hooks/pre-tool-use blocking route with AUTO_APPROVE and permission_mode bypass
  - Callback query handlers for approve/deny inline buttons
  - Text input handler for message:text in session topics via TextInputManager
  - PreToolUse HTTP hook auto-installation with append-not-replace merge
  - SessionStart command hook for tmux pane capture
  - Full control lifecycle integration (approval flow, timeout editing, cleanup, shutdown)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [blocking-http-route, callback-query-handlers, inline-keyboard-lifecycle, timeout-denial-tracking]

key-files:
  created: []
  modified:
    - src/hooks/server.ts
    - src/hooks/handlers.ts
    - src/bot/bot.ts
    - src/utils/install-hooks.ts
    - src/sessions/session-store.ts
    - src/index.ts

key-decisions:
  - "Timeout vs user deny tracked via timeoutDenials Set in index.ts -- simple flag pattern avoids changing ApprovalManager API"
  - "Approval message text tracked in separate Map (approvalMessageTexts) for timeout callback to reconstruct expired message"
  - "Lazy tmux pane capture: onPreToolUse retries reading pane file if onSessionStart didn't find it yet"
  - "Late button taps show 'This approval has already expired.' alert via answerCallbackQuery show_alert"

patterns-established:
  - "Blocking HTTP route pattern: POST handler awaits promise that resolves from external event (button tap or timeout)"
  - "Callback query pattern: answerCallbackQuery first (dismiss spinner), then decide, then editMessageText"
  - "InlineKeyboard lifecycle: create with approve/deny buttons, edit to remove buttons on resolution"

requirements-completed: [CTRL-01, CTRL-02, CTRL-03]

# Metrics
duration: 5min
completed: 2026-02-28
---

# Phase 3 Plan 02: Control Wiring and Integration Summary

**PreToolUse blocking route with inline keyboard approval flow, callback query handlers, text input via tmux, and full lifecycle integration in index.ts**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-28T22:52:06Z
- **Completed:** 2026-02-28T22:57:22Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Blocking POST /hooks/pre-tool-use route wired in server.ts with AUTO_APPROVE bypass, permission_mode bypass, and error fallback
- Callback query handlers for approve/deny buttons with message editing, expiry alerts, and timeout detection
- Text input handler for session topic messages with tmux injection and queue fallback
- Full integration in index.ts: ApprovalManager + TextInputManager creation, timeout callback, onPreToolUse callback, session lifecycle cleanup, shutdown cleanup

## Task Commits

Each task was committed atomically:

1. **Task 1: Add PreToolUse route to server, handlePreToolUse to handlers, update hook auto-install, add tmuxPane to session store** - `c21bdcf` (feat)
2. **Task 2: Wire callback query handlers in bot.ts, text input handler, and full control integration in index.ts** - `d67ede2` (feat)

## Files Created/Modified
- `src/hooks/server.ts` - Added blocking POST /hooks/pre-tool-use route with AUTO_APPROVE and permission_mode bypass
- `src/hooks/handlers.ts` - Added onPreToolUse to HookCallbacks interface and handlePreToolUse method to HookHandlers
- `src/utils/install-hooks.ts` - Added PreToolUse HTTP hook with dynamic timeout, SessionStart command hook for tmux pane capture, append-not-replace merge logic
- `src/sessions/session-store.ts` - Added updateTmuxPane method
- `src/bot/bot.ts` - Added callbackQuery handlers (approve/deny), message:text handler for text input, makeApprovalKeyboard export
- `src/index.ts` - Created ApprovalManager and TextInputManager, wired onPreToolUse callback, timeout callback with message editing, tmux pane reading, session cleanup, shutdown cleanup

## Decisions Made
- Timeout vs user deny tracked via `timeoutDenials` Set -- simple flag set in timeout callback, checked after waitForDecision resolves with 'deny', avoids changing ApprovalManager API
- Approval message text stored in separate `approvalMessageTexts` Map so timeout callback can reconstruct the "Expired" message with original text
- Lazy tmux pane capture: onPreToolUse retries reading the pane file if session.tmuxPane is still null (handles race between command hook and HTTP hook)
- Late button taps (after timeout or duplicate) show "This approval has already expired." as a Telegram alert via answerCallbackQuery

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added temporary onPreToolUse stub in index.ts for Task 1 compilation**
- **Found during:** Task 1
- **Issue:** Adding onPreToolUse to HookCallbacks interface caused TypeScript error in index.ts (missing required property)
- **Fix:** Added temporary stub returning auto-approve, replaced with full implementation in Task 2
- **Files modified:** src/index.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** c21bdcf (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Temporary stub necessary for incremental TypeScript compilation between tasks. Replaced with full implementation in Task 2. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 3 is fully complete. All control modules are wired and integrated.
- The Telegram group is a complete remote control interface for Claude Code:
  - Approve/deny tool calls via inline buttons
  - Timeout expiration with auto-deny and message editing
  - Text input injection via tmux or queue fallback
  - AUTO_APPROVE bypass for unattended operation
  - Full cleanup on session end and bot shutdown
- No blockers or further phases planned

## Self-Check: PASSED

All 6 modified files verified present. Both task commits (c21bdcf, d67ede2) verified in git log.

---
*Phase: 03-control*
*Completed: 2026-02-28*
