---
phase: 07-permission-modes
plan: 01
subsystem: control
tags: [permission-modes, state-machine, hooks, approval, dangerous-commands]

# Dependency graph
requires:
  - phase: 06-compact-output
    provides: formatter with classifyRisk, compact tool display patterns, StatusMessage
provides:
  - PermissionModeManager class with 5-mode state machine
  - isDangerous function for narrow dangerous command blocklist
  - formatAutoApproved for lightning-prefixed auto-approved display
  - formatDangerousPrompt for warning-styled dangerous command prompts
  - StopPayload type and Stop hook route/handler
  - Indefinite-wait ApprovalManager (no timeout)
affects: [07-permission-modes plan 02 (wiring)]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-session permission mode state machine, fire-and-forget Stop hook, indefinite approval wait]

key-files:
  created:
    - src/control/permission-modes.ts
  modified:
    - src/bot/formatter.ts
    - src/control/approval-manager.ts
    - src/types/hooks.ts
    - src/hooks/handlers.ts
    - src/hooks/server.ts
    - src/utils/install-hooks.ts
    - src/index.ts
    - src/bot/bot.ts

key-decisions:
  - "classifyRisk exported from formatter.ts for PermissionModeManager safe-only mode reuse"
  - "buildToolPreview exported from formatter.ts for formatDangerousPrompt reuse"
  - "ApprovalManager constructor takes no args (removed timeoutMs entirely, not just ignored)"
  - "onStop callback stub added to index.ts for Plan 02 wiring"

patterns-established:
  - "PermissionModeManager: in-memory Map<sessionId, ModeState> with manual default when no entry exists"
  - "isDangerous: narrow blocklist of RegExp patterns checked before any auto-approval decision"
  - "Stop hook: fire-and-forget HTTP route pattern matching PostToolUse/Notification"

requirements-completed: [PERM-01, PERM-09]

# Metrics
duration: 5min
completed: 2026-03-02
---

# Phase 7 Plan 01: Permission Modes Infrastructure Summary

**PermissionModeManager state machine with 5 modes, isDangerous blocklist, Stop hook, and indefinite-wait ApprovalManager (PERM-01)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-02T13:48:47Z
- **Completed:** 2026-03-02T13:53:42Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Created PermissionModeManager class with all 5 modes (manual, accept-all, same-tool, safe-only, until-done) and shouldAutoApprove query method
- Implemented isDangerous function with narrow blocklist (rm -rf, sudo, curl|bash, git push --force) that blocks auto-approval regardless of mode
- Added formatAutoApproved (lightning-prefixed compact lines) and formatDangerousPrompt (warning-styled prompts) to formatter
- Removed approval timeout from ApprovalManager entirely (PERM-01: indefinite wait)
- Added StopPayload type, /hooks/stop route, handleStop handler, and Stop hook registration in install-hooks.ts
- Set PreToolUse hook timeout to 86400 seconds (24 hours) for effective indefinite wait

## Task Commits

Each task was committed atomically:

1. **Task 1: Create PermissionModeManager, isDangerous, and formatter additions** - `3e8568f` (feat)
2. **Task 2: Remove approval timeout, add Stop hook, increase PreToolUse hook timeout** - `100e59e` (feat)

## Files Created/Modified
- `src/control/permission-modes.ts` - NEW: PermissionModeManager class, isDangerous function, PermissionMode/ModeState types
- `src/bot/formatter.ts` - Exported classifyRisk and buildToolPreview; added formatAutoApproved and formatDangerousPrompt
- `src/control/approval-manager.ts` - Removed timeout: no timer field, no setTimeout, no timeoutMs constructor param
- `src/types/hooks.ts` - Added StopPayload interface
- `src/hooks/handlers.ts` - Added onStop to HookCallbacks, handleStop method to HookHandlers
- `src/hooks/server.ts` - Added /hooks/stop fire-and-forget route
- `src/utils/install-hooks.ts` - Registered Stop hook, set PreToolUse timeout to 86400s
- `src/index.ts` - Removed timeout logic, added onStop stub callback
- `src/bot/bot.ts` - Removed unused formatApprovalExpired import

## Decisions Made
- Exported classifyRisk (was private) for PermissionModeManager safe-only mode check
- Exported buildToolPreview (was private) for formatDangerousPrompt reuse
- Removed ApprovalManager constructor parameter entirely rather than keeping for backward compat -- cleaner contract
- Added onStop stub in index.ts callbacks so the HookCallbacks interface is satisfied; Plan 02 will wire actual mode reset logic

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused formatApprovalExpired import from bot.ts**
- **Found during:** Task 2 (removing timeout logic)
- **Issue:** bot.ts imported formatApprovalExpired which was no longer used after timeout removal
- **Fix:** Removed the unused import to prevent TypeScript warnings
- **Files modified:** src/bot/bot.ts
- **Verification:** npx tsc --noEmit passes cleanly
- **Committed in:** 100e59e (Task 2 commit)

**2. [Rule 3 - Blocking] Added onStop stub callback in index.ts**
- **Found during:** Task 2 (adding onStop to HookCallbacks interface)
- **Issue:** HookCallbacks interface now requires onStop, but index.ts callbacks object didn't have it -- TypeScript error
- **Fix:** Added no-op onStop stub with comment indicating Plan 02 will wire it
- **Files modified:** src/index.ts
- **Verification:** npx tsc --noEmit passes cleanly
- **Committed in:** 100e59e (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary for clean compilation after planned changes. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All contracts and infrastructure ready for Plan 02 wiring
- PermissionModeManager, isDangerous, formatAutoApproved, formatDangerousPrompt are exported and available
- Stop hook route and handler ready to receive events
- onStop callback stub ready to be wired to mode reset logic
- ApprovalManager ready for indefinite-wait usage

---
*Phase: 07-permission-modes*
*Completed: 2026-03-02*
