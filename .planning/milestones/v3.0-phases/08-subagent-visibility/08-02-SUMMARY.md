---
phase: 08-subagent-visibility
plan: 02
subsystem: monitoring
tags: [subagent, visibility, lifecycle, telegram, wiring]

# Dependency graph
requires:
  - phase: 08-subagent-visibility
    plan: 01
    provides: SubagentTracker class, SubagentStart/Stop payloads, formatSubagentSpawn/Done, HookCallbacks extension
provides:
  - Full subagent visibility wiring in index.ts: spawn/done announcements, agent-prefixed tool calls, agent-prefixed text output, agent-prefixed approval prompts
  - TranscriptWatcher sidechain message processing via onSidechainMessage callback
  - Subagent auto-approve dedup: bracket prefix for subagent tools, lightning prefix for main agent
  - SubagentTracker cleanup at all session lifecycle points
  - onAgentToolDetected callback in server.ts for auto-approve path description stashing
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [subagent-prefixed-output, sidechain-callback-routing, agent-tool-detection-callback]

key-files:
  created: []
  modified:
    - src/monitoring/transcript-watcher.ts
    - src/index.ts
    - src/hooks/server.ts

key-decisions:
  - "Sidechain callback is 4th optional parameter on TranscriptWatcher constructor (backward-compatible)"
  - "Agent-prefixed auto-approved tools use batcher.enqueue (batched) not enqueueImmediate (unlike main agent lightning lines)"
  - "onAgentToolDetected callback added to server.ts createHookServer as 5th optional parameter for auto-approve path description stashing"
  - "Subagent done announcement uses depth from returned agent (not getIndent) since stop() already removed agent from tracker"

patterns-established:
  - "Subagent tool attribution: getActiveAgent(sessionId) returns top of per-session stack for temporal prefix"
  - "Sidechain routing: TranscriptWatcher emits isSidechain entries through separate callback for agent-prefixed display"
  - "Dual description stash: both onPreToolUse handler and onAgentToolDetected server callback stash Agent/Task descriptions"

requirements-completed: [AGENT-04, AGENT-05]

# Metrics
duration: 5min
completed: 2026-03-02
---

# Phase 8 Plan 02: Subagent Visibility Wiring Summary

**Full subagent visibility wiring: agent-prefixed tool calls, spawn/done announcements, sidechain text routing, auto-approve dedup, and lifecycle cleanup across all session events**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-02T15:32:09Z
- **Completed:** 2026-03-02T15:37:28Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- TranscriptWatcher processes sidechain entries via new onSidechainMessage callback instead of silently skipping them
- All subagent tool calls, text output, and approval prompts display with [agentName] prefix in Telegram
- Subagent spawn/done announcements posted inline with proper indent for nested agents
- Auto-approved subagent tools show as [name] Tool(args) (bracket prefix) not lightning prefix
- SubagentTracker cleaned up at all lifecycle points: session end, /clear, clear-detected, and shutdown

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sidechain callback to TranscriptWatcher** - `af5cf29` (feat)
2. **Task 2: Wire subagent visibility into index.ts** - `76316f1` (feat)

## Files Created/Modified
- `src/monitoring/transcript-watcher.ts` - Added optional onSidechainMessage 4th constructor parameter; sidechain entries now processed and emitted through callback
- `src/index.ts` - SubagentTracker instantiation, onSubagentStart/Stop callbacks, agent-prefixed tool/text/approval output, sidechain wiring in initMonitoring, auto-approve subagent dedup, cleanup at all lifecycle points
- `src/hooks/server.ts` - Added onAgentToolDetected 5th optional parameter to createHookServer; calls it from PreToolUse route for Agent/Task tool detection

## Decisions Made
- Sidechain callback added as optional 4th parameter (backward-compatible with existing callers)
- Agent-prefixed auto-approved tools use batched enqueue rather than immediate, since subagent tools fire rapidly and batching reduces message spam
- onAgentToolDetected callback added to server.ts as a separate parameter rather than extending onAutoApproved, keeping responsibilities clear
- For subagent done announcement, depth is read from the returned agent object (not getIndent) because stop() already removed the agent from the tracker map

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All AGENT requirements (AGENT-01 through AGENT-06) are now satisfied across Plans 01 and 02
- Phase 8 is complete: subagent visibility infrastructure + wiring both done
- TypeScript compiles with zero errors
- No known blockers remain (PostToolUse temporal heuristic is the accepted attribution strategy)

## Self-Check: PASSED

All 3 source files verified present. Both task commits (af5cf29, 76316f1) verified in git log. SUMMARY.md created.

---
*Phase: 08-subagent-visibility*
*Completed: 2026-03-02*
