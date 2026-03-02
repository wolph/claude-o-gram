---
phase: 10-sub-agent-suppression
plan: 01
subsystem: monitoring
tags: [subagent, suppression, config, telegram-output]

requires:
  - phase: 08-subagent-visibility
    provides: SubagentTracker, subagent lifecycle callbacks, agent-prefixed output
provides:
  - subagentOutput boolean config field on AppConfig
  - SUBAGENT_VISIBLE env var parsing (default false)
  - 5 gated call sites for sub-agent output suppression in index.ts
affects: [12-settings-topic]

tech-stack:
  added: []
  patterns: [config-gated output suppression at call sites]

key-files:
  created: []
  modified:
    - src/types/config.ts
    - src/config.ts
    - src/index.ts

key-decisions:
  - "Gate at call sites rather than batcher level — more explicit, easier to audit"
  - "No helper function — direct config.subagentOutput checks at 5 sites, simple enough"
  - "Always track autoApprovedToolUseIds even when display suppressed — prevents PostToolUse dedup failures"

patterns-established:
  - "Config-gated output suppression: wrap batcher calls with config.subagentOutput check"
  - "Tracker operations always unconditional: start/stop/stash/cleanup run regardless of display"

requirements-completed: [AGNT-01, AGNT-02, AGNT-03]

duration: 3min
completed: 2026-03-02
---

# Phase 10: Sub-Agent Suppression Summary

**Config-gated suppression of all sub-agent Telegram output at 5 call sites with SUBAGENT_VISIBLE env var toggle**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-02
- **Completed:** 2026-03-02
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Added `subagentOutput: boolean` to AppConfig with `SUBAGENT_VISIBLE` env var (default false)
- Gated all 5 sub-agent Telegram output call sites: spawn announcements, done announcements, sidechain text, tool call display, auto-approved tool display
- SubagentTracker operations remain unconditional for accurate state tracking
- PreToolUse approval requests from sub-agents always shown (user safety preserved)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add subagentOutput config field and env var parsing** - `ea6fa4e` (feat)
2. **Task 2: Gate 5 sub-agent output call sites in index.ts** - `b010aa9` (feat)

## Files Created/Modified
- `src/types/config.ts` - Added subagentOutput boolean field to AppConfig interface
- `src/config.ts` - Added SUBAGENT_VISIBLE env var parsing (default false)
- `src/index.ts` - Gated 5 call sites with config.subagentOutput checks

## Decisions Made
- Gated at individual call sites rather than creating a helper function — only 5 sites, simple boolean check, helper would add indirection for minimal DRY benefit
- Always populate autoApprovedToolUseIds set even when display is suppressed to prevent PostToolUse dedup failures
- Status message updates (requestUpdate) still fire for suppressed sub-agent tools — internal tracking stays accurate

## Deviations from Plan
None - plan executed exactly as written

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Sub-agent suppression active by default — Phase 12 (Settings Topic) can add runtime toggle via Telegram settings UI
- AGNT-03 toggleability verified at config level; Phase 12 will expose via inline keyboard buttons

---
*Phase: 10-sub-agent-suppression*
*Completed: 2026-03-02*
