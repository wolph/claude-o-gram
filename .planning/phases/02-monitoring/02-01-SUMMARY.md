---
phase: 02-monitoring
plan: 01
subsystem: monitoring
tags: [verbosity, notifications, hooks, types, fastify]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "Hook handlers, session store, formatter, Fastify server, install-hooks"
provides:
  - "VerbosityTier, StatusData, TranscriptEntry, TokenUsage, ContentBlock types"
  - "shouldPostToolCall verbosity filter function"
  - "NotificationPayload type and /hooks/notification route"
  - "SessionStore monitoring methods (updateLastActivity, suppressedCounts, verbosity, statusMessageId, contextPercent)"
  - "formatNotification with urgency-based styling"
  - "Notification hook auto-install in Claude Code settings"
affects: [02-monitoring, 03-control]

# Tech tracking
tech-stack:
  added: []
  patterns: ["verbosity tier filtering in hook pipeline", "fire-and-forget notification route", "urgency-based notification formatting"]

key-files:
  created:
    - src/types/monitoring.ts
    - src/monitoring/verbosity.ts
  modified:
    - src/types/sessions.ts
    - src/types/config.ts
    - src/types/hooks.ts
    - src/config.ts
    - src/hooks/handlers.ts
    - src/hooks/server.ts
    - src/bot/formatter.ts
    - src/utils/install-hooks.ts
    - src/sessions/session-store.ts
    - src/index.ts

key-decisions:
  - "Verbosity filter runs before callback dispatch -- suppressed tool calls never reach Telegram"
  - "Notification messages sent immediately (enqueueImmediate) since they are urgent"
  - "New SessionInfo fields initialized with sensible defaults in handleSessionStart"

patterns-established:
  - "Verbosity filtering: shouldPostToolCall checks tool name against tier before forwarding"
  - "Suppressed count tracking: incrementSuppressedCount for periodic summary reporting"
  - "Notification urgency styling: permission_prompt gets warning + blockquote, others get type-appropriate formatting"

requirements-completed: [MNTR-01, MNTR-03, UX-03]

# Metrics
duration: 4min
completed: 2026-02-28
---

# Phase 2 Plan 1: Monitoring Foundation Summary

**Verbosity-filtered tool call pipeline with notification hooks, monitoring types, and extended session/config for Phase 2 infrastructure**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-28T20:28:37Z
- **Completed:** 2026-02-28T20:32:35Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments
- Created all Phase 2 type contracts (VerbosityTier, StatusData, TranscriptEntry, TokenUsage, ContentBlock, NotificationPayload)
- Integrated verbosity filtering into PostToolUse pipeline with suppressed count tracking
- Added Notification hook with route, handler, formatter, and auto-install

## Task Commits

Each task was committed atomically:

1. **Task 1: Create monitoring types, verbosity filter, and extend session/config types** - `2a109d8` (feat)
2. **Task 2: Add notification handler, verbosity filtering in PostToolUse, notification formatter, server route, and hook auto-install** - `9dc014f` (feat)

## Files Created/Modified
- `src/types/monitoring.ts` - VerbosityTier, StatusData, TranscriptEntry, TokenUsage, ContentBlock types
- `src/monitoring/verbosity.ts` - shouldPostToolCall filter and parseVerbosityTier helper
- `src/types/sessions.ts` - Extended SessionInfo with verbosity, statusMessageId, suppressedCounts, contextPercent, lastActivityAt
- `src/types/config.ts` - Extended AppConfig with defaultVerbosity, idleTimeoutMs, summaryIntervalMs
- `src/types/hooks.ts` - Added NotificationPayload interface
- `src/config.ts` - Parses VERBOSITY_DEFAULT, IDLE_TIMEOUT_MS, SUMMARY_INTERVAL_MS env vars
- `src/hooks/handlers.ts` - Verbosity filtering in handlePostToolUse, new handleNotification method
- `src/hooks/server.ts` - POST /hooks/notification route (fire-and-forget)
- `src/bot/formatter.ts` - formatNotification with urgency-based styling per notification type
- `src/utils/install-hooks.ts` - Added Notification hook to hookConfig (4 hooks total)
- `src/sessions/session-store.ts` - 6 new monitoring methods (updateLastActivity, incrementSuppressedCount, updateVerbosity, updateStatusMessageId, updateContextPercent, getSuppressedCounts)
- `src/index.ts` - Wired onNotification callback

## Decisions Made
- Verbosity filter runs before callback dispatch in handlePostToolUse -- suppressed tool calls never reach Telegram, reducing noise
- Notification messages use enqueueImmediate (not batched) since they represent urgent events like permission prompts
- New SessionInfo monitoring fields initialized with sensible defaults (verbosity: 'normal', statusMessageId: 0, suppressedCounts: {}, contextPercent: 0, lastActivityAt: now)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added onNotification callback to index.ts entry point**
- **Found during:** Task 2 (TypeScript compilation)
- **Issue:** src/index.ts implements HookCallbacks and the new onNotification method was missing, causing TS2741 compile error
- **Fix:** Added onNotification callback that formats and sends notification via batcher.enqueueImmediate
- **Files modified:** src/index.ts
- **Verification:** TypeScript compiles without errors
- **Committed in:** 9dc014f (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential fix for TypeScript compilation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. New env vars (VERBOSITY_DEFAULT, IDLE_TIMEOUT_MS, SUMMARY_INTERVAL_MS) are all optional with sensible defaults.

## Next Phase Readiness
- All Phase 2 type contracts defined and exported
- Verbosity filtering integrated into tool call pipeline
- Notification infrastructure ready for Phase 2 Plans 2-3 (transcript parsing, status message, periodic summaries)
- SessionStore has all methods needed for monitoring state management

## Self-Check: PASSED

All files and commits verified:
- src/types/monitoring.ts: FOUND
- src/monitoring/verbosity.ts: FOUND
- 02-01-SUMMARY.md: FOUND
- Commit 2a109d8: FOUND
- Commit 9dc014f: FOUND

---
*Phase: 02-monitoring*
*Completed: 2026-02-28*
