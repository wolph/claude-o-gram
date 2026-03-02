---
phase: 09-color-coded-topic-status
plan: 02
subsystem: monitoring
tags: [telegram, grammy, hook-callbacks, status-wiring, startup-sweep]

requires:
  - phase: 09-01
    provides: TopicStatusManager class and STATUS_EMOJIS constant
provides:
  - Full hook callback wiring with TopicStatusManager integration
  - Startup gray sweep before reconnect loop
  - Complete four-state topic status system (green/yellow/red/gray)
affects: [10-sub-agent-suppression, 11-sticky-message-dedup]

tech-stack:
  added: []
  patterns: [lifecycle-event-status-mapping, startup-gray-sweep]

key-files:
  created: []
  modified:
    - src/index.ts

key-decisions:
  - "Green status set on session start, stop hook, and approval wait (all = waiting for input)"
  - "Yellow status set on tool use and after approval decision (both = processing)"
  - "Red status set on 95% context exhaustion (sticky until cleared on next turn)"
  - "Gray sweep runs BEFORE reconnect loop with 500ms inter-call delay"
  - "clearStickyRed called in onStop so new turn allows green/yellow again"
  - "No unregisterTopic on clear-reason session end (topic is reused)"

patterns-established:
  - "Hook callback -> TopicStatusManager: single path for all status transitions"
  - "Startup gray sweep: mark stale sessions as offline before reconnect"

requirements-completed:
  - STAT-01
  - STAT-02
  - STAT-03
  - STAT-04
  - STAT-05
  - STAT-06

duration: 4min
completed: 2026-03-02
---

# Phase 9 Plan 02: Wire TopicStatusManager into Hook Callbacks

**Full hook callback wiring with status transitions: green (idle), yellow (processing), red (95% context), gray (startup sweep)**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-02
- **Completed:** 2026-03-02
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Imported and instantiated TopicStatusManager after TopicManager
- Wired green status into: onSessionStart (new/resume/clear via initMonitoring), onStop, onPreToolUse (before approval wait)
- Wired yellow status into: onToolUse, onPreToolUse (after approval decision)
- Wired red status into: onUsageUpdate callback at 95% context threshold
- Added startup gray sweep before reconnect loop with 500ms inter-call delays
- Added topicStatusManager.destroy() to shutdown handler
- Unregisters topic on normal session end (not on clear-reason ends)

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire TopicStatusManager into hook callbacks** - `7957fa3` (feat)

## Files Created/Modified
- `src/index.ts` - 57 insertions, 3 deletions: TopicStatusManager import/instantiation, status transitions in all callbacks, startup gray sweep, shutdown cleanup

## Decisions Made
- Green status represents "waiting for user input" -- covers session start, turn complete (Stop), and approval wait
- Yellow status represents "Claude is processing" -- covers tool use and post-approval
- Startup gray sweep runs sequentially with 500ms delays to avoid Telegram API rate limits
- clearStickyRed in onStop ensures the next turn can transition freely after context exhaustion
- No unregisterTopic on clear-reason session ends since the topic is reused for the next context

## Deviations from Plan

None -- all 10 modifications were implemented exactly as specified.

---

**Total deviations:** 0
**Impact on plan:** None

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 9 is fully complete: TopicStatusManager created (Plan 01) and wired (Plan 02)
- All six STAT requirements satisfied
- Ready for Phase 10 (sub-agent suppression) or Phase 11 (sticky message dedup)

---
*Phase: 09-color-coded-topic-status*
*Completed: 2026-03-02*
