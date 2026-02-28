---
phase: 03-control
plan: 01
subsystem: control
tags: [approval, tmux, input-injection, tool-safety, inline-keyboard]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: HookPayload, PostToolUsePayload types, SessionInfo, AppConfig, config parser, formatter utilities
  - phase: 02-monitoring
    provides: VerbosityTier, Phase 2 monitoring fields on SessionInfo and AppConfig
provides:
  - PreToolUsePayload type for blocking approval hook events
  - ApprovalManager class with deferred promise pattern and timeout auto-deny
  - TextInputManager class with tmux injection and queue fallback
  - formatApprovalRequest, formatApprovalResult, formatApprovalExpired functions
  - Extended SessionInfo with tmuxPane field
  - Extended AppConfig with approvalTimeoutMs and autoApprove fields
affects: [03-control-plan-02]

# Tech tracking
tech-stack:
  added: []
  patterns: [deferred-promise-with-timeout, tmux-bracketed-paste-injection, risk-classification]

key-files:
  created:
    - src/control/approval-manager.ts
    - src/control/input-manager.ts
  modified:
    - src/types/hooks.ts
    - src/types/sessions.ts
    - src/types/config.ts
    - src/config.ts
    - src/bot/formatter.ts
    - src/hooks/handlers.ts
    - src/sessions/session-store.ts

key-decisions:
  - "ApprovalManager uses deferred promise pattern: waitForDecision returns promise, decide/timeout resolves it"
  - "Risk classification: Bash/BashBackground=danger, Write/Edit/MultiEdit/NotebookEdit=caution, all others=safe"
  - "TextInputManager uses tmux set-buffer + paste-buffer -p (bracketed paste) + send-keys Enter"
  - "tmuxPane defaults to null for backward compatibility with pre-Phase-3 persisted sessions"

patterns-established:
  - "Deferred promise pattern: create promise in HTTP handler, resolve from button callback or timeout"
  - "Risk classification: static Set-based tool categorization for approval display"
  - "Shell quoting: single-quote wrapping with embedded quote escaping for execSync commands"

requirements-completed: [CTRL-01, CTRL-02, CTRL-03]

# Metrics
duration: 3min
completed: 2026-02-28
---

# Phase 3 Plan 01: Control Types and Core Modules Summary

**ApprovalManager with deferred-promise timeout pattern, TextInputManager with tmux bracketed paste injection, and risk-classified approval formatter**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-28T22:46:16Z
- **Completed:** 2026-02-28T22:49:13Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- All Phase 3 type contracts defined: PreToolUsePayload, extended SessionInfo (tmuxPane), extended AppConfig (approvalTimeoutMs, autoApprove)
- ApprovalManager handles full approval lifecycle: create pending promise, resolve on button tap, auto-deny on timeout with callback
- TextInputManager handles tmux injection with queue fallback for sessions without tmux
- Formatter produces approval-specific HTML with risk indicators and compact tool input previews

## Task Commits

Each task was committed atomically:

1. **Task 1: Add PreToolUsePayload type, extend SessionInfo and AppConfig, update config parser** - `4f54bb2` (feat)
2. **Task 2: Create ApprovalManager, TextInputManager, and approval formatter functions** - `afa4e39` (feat)

## Files Created/Modified
- `src/control/approval-manager.ts` - ApprovalManager class with waitForDecision, decide, hasPending, cleanupSession, shutdown methods
- `src/control/input-manager.ts` - TextInputManager class with inject, send, queue, dequeue, cleanup methods
- `src/types/hooks.ts` - Added PreToolUsePayload interface (tool_name, tool_input, tool_use_id)
- `src/types/sessions.ts` - Added tmuxPane: string | null field to SessionInfo
- `src/types/config.ts` - Added approvalTimeoutMs and autoApprove fields to AppConfig
- `src/config.ts` - Parses APPROVAL_TIMEOUT_MS and AUTO_APPROVE env vars
- `src/bot/formatter.ts` - Added formatApprovalRequest, formatApprovalResult, formatApprovalExpired functions
- `src/hooks/handlers.ts` - Initialize tmuxPane: null in session creation
- `src/sessions/session-store.ts` - Ensure tmuxPane defaults to null for pre-Phase-3 sessions on load

## Decisions Made
- ApprovalManager uses deferred promise pattern: waitForDecision() returns a promise, decide() or timeout resolves it -- clean separation between HTTP handler and Telegram callback
- Risk classification uses static Sets for danger (Bash, BashBackground) and caution (Write, Edit, MultiEdit, NotebookEdit) tools -- all others default to safe
- TextInputManager uses tmux set-buffer + paste-buffer -p (bracketed paste) + send-keys Enter -- avoids Ink autocomplete intercepting input
- Added tmuxPane default to null in session store load() for backward compatibility with sessions persisted before Phase 3

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added tmuxPane initialization to session creation and deserialization**
- **Found during:** Task 1 (type extensions)
- **Issue:** Adding tmuxPane to SessionInfo type caused TypeScript errors in handlers.ts (session creation missing field) and session-store.ts (deserialized sessions from pre-Phase-3 would lack the field)
- **Fix:** Added tmuxPane: null to session creation in handlers.ts and tmuxPane: session.tmuxPane ?? null default in session-store.ts load()
- **Files modified:** src/hooks/handlers.ts, src/sessions/session-store.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** 4f54bb2 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary for TypeScript compilation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All type contracts, core control modules, and formatter functions are ready for Plan 02 wiring
- Plan 02 can wire ApprovalManager and TextInputManager into the server, bot, and index without creating any new types or classes
- No blockers

## Self-Check: PASSED

All 10 files verified present. Both task commits (4f54bb2, afa4e39) verified in git log.

---
*Phase: 03-control*
*Completed: 2026-02-28*
