---
phase: 06-compact-output-session-ux
plan: 04
subsystem: sessions
tags: [clear, lifecycle, session-reuse, monitoring-cleanup, upstream-bug-workaround]

# Dependency graph
requires:
  - phase: 06-compact-output-session-ux (plan 03)
    provides: "/clear session lifecycle with clearPending bridge, separator format, counter reset"
provides:
  - "Working /clear lifecycle that functions when SessionEnd does not fire (upstream bug #6428)"
  - "Old monitoring cleanup on /clear (prevents resource leaks)"
  - "Separator, fresh pinned status, and counter reset all triggered by SessionStart(source=clear) alone"
affects: [phase-07-permission-modes, phase-08-subagent]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Active-first session lookup: getActiveByCwd before getRecentlyClosedByCwd for /clear"
    - "Monitor cleanup by cwd match when SessionEnd is absent"
    - "Future-proof dual-path: works with or without SessionEnd firing"

key-files:
  created: []
  modified:
    - src/hooks/handlers.ts
    - src/index.ts

key-decisions:
  - "getActiveByCwd is primary lookup for /clear; getRecentlyClosedByCwd is fallback for when upstream bug is fixed"
  - "Old monitor found by cwd match (not sessionId) since new session has different ID"
  - "Old session explicitly marked closed to prevent stale getActiveByCwd hits on subsequent /clear cycles"
  - "Unpin logic removed per UAT feedback -- Telegram supports multiple pinned messages"
  - "clearPending bridge retained in onSessionEnd for future-proofing but no longer required for flow"

patterns-established:
  - "Dual-path workaround: code works both with current upstream bug and future fix"
  - "Monitor cleanup by cwd match when session IDs differ across lifecycle events"

requirements-completed: [SESS-01, SESS-02, SESS-03, SESS-05]

# Metrics
duration: 2min
completed: 2026-03-02
---

# Phase 6 Plan 4: Fix /clear Lifecycle Summary

**Working /clear lifecycle triggered by SessionStart(source=clear) alone -- fixes separator, fresh status, and counter reset when SessionEnd never fires due to upstream bug #6428**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-02T01:30:10Z
- **Completed:** 2026-03-02T01:31:49Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Fixed handlers.ts to find ACTIVE session on /clear (not recently closed), resolving the root cause of all 3 UAT failures
- Restructured index.ts /clear flow to unconditionally post separator, reset counters, and create fresh monitoring
- Added old monitor cleanup loop to prevent TranscriptWatcher/SummaryTimer/StatusMessage resource leaks
- Removed unpin logic per UAT feedback; retained clearPending bridge for future-proofing

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix handlers.ts to find active session on source=clear** - `3e938a2` (fix)
2. **Task 2: Fix index.ts to work without clearPending and clean up old monitoring** - `e0e6574` (fix)

## Files Created/Modified
- `src/hooks/handlers.ts` - source=clear branch now calls getActiveByCwd first, getRecentlyClosedByCwd as fallback
- `src/index.ts` - source=clear branch restructured: always posts separator, cleans old monitor, resets counters, creates fresh monitoring

## Decisions Made
- **Active-first lookup:** getActiveByCwd is the primary path since the session is still active when SessionStart fires (SessionEnd never fires). getRecentlyClosedByCwd is retained only as a fallback for when Claude Code eventually fixes bug #6428.
- **Monitor cleanup by cwd:** Old monitors found by matching cwd rather than sessionId, since the new session has a different ID from the old one.
- **Explicit close:** Old session marked as 'closed' in session store to prevent stale hits from getActiveByCwd on subsequent /clear cycles.
- **No unpin:** Removed unpin logic per UAT test 10 feedback -- Telegram supports multiple pinned messages and the old status stays visible.
- **clearPending retained:** The bridge map in onSessionEnd is kept for forward compatibility but is no longer a required dependency of the /clear flow.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All 3 UAT failures (tests 9, 10, 11) addressed by this fix -- ready for re-test
- /clear lifecycle now works whether or not SessionEnd fires, making the code resilient to upstream bug fixes
- Phase 7 (permission modes) and Phase 8 (subagent visibility) can proceed independently

---
*Phase: 06-compact-output-session-ux*
*Completed: 2026-03-02*

## Self-Check: PASSED

- All 2 files modified exist on disk
- Commits 3e938a2 and e0e6574 verified in git log
- TypeScript compiles with zero errors
- SUMMARY.md created at expected path
