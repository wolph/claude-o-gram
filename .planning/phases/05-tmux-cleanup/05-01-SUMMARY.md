---
phase: 05-tmux-cleanup
plan: 01
subsystem: cleanup
tags: [tmux, dead-code-removal, sdk-input, typescript]

# Dependency graph
requires:
  - phase: 04-sdk-input
    provides: SdkInputManager as primary input path
provides:
  - Clean codebase with zero tmux references in src/
  - SDK-only text handler in bot.ts with direct error reporting
  - SessionInfo without tmuxPane field
  - Hook installer with HTTP hooks only (no command hook)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SDK-only input: sdkInputManager.send() is sole text delivery path, no fallback"
    - "Direct error reporting: failed SDK input shows error message instead of silent fallback"

key-files:
  created: []
  modified:
    - src/types/sessions.ts
    - src/sessions/session-store.ts
    - src/hooks/handlers.ts
    - src/utils/install-hooks.ts
    - src/bot/bot.ts
    - src/index.ts
    - src/sdk/input-manager.ts

key-decisions:
  - "Deleted TextInputManager entirely rather than deprecating -- no consumers remain"
  - "SDK failure reports error directly to user rather than queueing for later"
  - "Removed tmux comment from sdk/input-manager.ts to achieve zero tmux references"

patterns-established:
  - "SDK-only input: all text delivery goes through sdkInputManager.send()"
  - "Direct error reporting: on failure, user sees error message immediately"

requirements-completed: [CLN-01, CLN-02, CLN-03]

# Metrics
duration: 3min
completed: 2026-03-01
---

# Phase 5 Plan 1: tmux Cleanup Summary

**Removed all tmux dead code: TextInputManager, tmuxPane session field, command hook, and fallback logic -- SDK-only input path with zero tmux references**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-01T09:20:23Z
- **Completed:** 2026-03-01T09:23:44Z
- **Tasks:** 2
- **Files modified:** 7 (1 deleted, 6 edited)

## Accomplishments
- Removed tmuxPane field from SessionInfo type, updateTmuxPane from SessionStore, and all tmuxPane initializations
- Removed tmux capture script generation and command hook from hook installer (HTTP-only SessionStart)
- Deleted src/control/input-manager.ts (TextInputManager class with execSync tmux calls)
- Rewrote bot.ts text handler to SDK-only with direct error reporting (no tmux fallback)
- Removed tryReadTmuxPane function and all tmux pane file I/O from index.ts
- Achieved zero "tmux" matches in grep -r across src/

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove tmux data layer (types, store, handlers, hook installer)** - `77442f7` (refactor)
2. **Task 2: Remove tmux consumers (TextInputManager, bot fallback, index wiring)** - `59932bb` (feat)

## Files Created/Modified
- `src/types/sessions.ts` - Removed tmuxPane field from SessionInfo interface
- `src/sessions/session-store.ts` - Removed updateTmuxPane() method and tmuxPane from load()
- `src/hooks/handlers.ts` - Removed tmuxPane: null from session creation in ensureSession() and handleSessionStart()
- `src/utils/install-hooks.ts` - Removed tmux script generation, command hook, chmodSync import
- `src/control/input-manager.ts` - DELETED (TextInputManager class fully replaced by SdkInputManager)
- `src/bot/bot.ts` - Removed TextInputManager import/param, rewrote text handler to SDK-only
- `src/index.ts` - Removed TextInputManager, tryReadTmuxPane, fs imports, tmux pane capture/cleanup
- `src/sdk/input-manager.ts` - Cleaned residual tmux reference in JSDoc comment

## Decisions Made
- Deleted TextInputManager entirely (no deprecation needed -- zero consumers after SDK migration)
- SDK failure reports error directly to user rather than queueing for tmux fallback delivery
- Cleaned tmux mention from sdk/input-manager.ts JSDoc to achieve strict zero-match requirement

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Cleaned tmux reference in sdk/input-manager.ts comment**
- **Found during:** Task 2 (verification step)
- **Issue:** JSDoc comment in sdk/input-manager.ts mentioned "Replaces tmux-based text injection" -- would fail the zero-tmux-refs check
- **Fix:** Rewrote comment to "Cross-platform, reliable input delivery mechanism"
- **Files modified:** src/sdk/input-manager.ts
- **Verification:** grep -r "tmux" src/ returns zero matches
- **Committed in:** 59932bb (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug - stale comment)
**Impact on plan:** Trivial comment cleanup required to meet the zero-tmux-references success criterion. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Codebase is clean: zero tmux references, zero TypeScript errors, successful build
- SDK input path (SdkInputManager) is the sole input mechanism
- No further cleanup phases planned -- project is feature-complete for v2.0

## Self-Check: PASSED

- All modified files exist on disk
- src/control/input-manager.ts confirmed deleted
- Commit 77442f7 (Task 1) found in git log
- Commit 59932bb (Task 2) found in git log

---
*Phase: 05-tmux-cleanup*
*Completed: 2026-03-01*
