---
phase: 04-sdk-resume-input
plan: 01
subsystem: sdk
tags: [claude-agent-sdk, zod, query-resume, input-delivery, cross-platform]

# Dependency graph
requires:
  - phase: 03-control
    provides: "Session management, text input handler, approval flow"
provides:
  - "SdkInputManager class wrapping query()+resume for text input delivery"
  - "ANTHROPIC_API_KEY config validation in loadConfig()"
  - "@anthropic-ai/claude-agent-sdk and zod dependencies installed"
affects: [04-02, 05-tmux-cleanup]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/claude-agent-sdk@0.2.63", "zod@4.3.6"]
  patterns: ["one-shot query() with resume per message", "per-session serialization", "AbortController timeout"]

key-files:
  created: ["src/sdk/input-manager.ts"]
  modified: ["package.json", "src/types/config.ts", "src/config.ts"]

key-decisions:
  - "Used settingSources: [] to avoid loading filesystem settings during resume"
  - "Query stream drained but NOT processed for Telegram (hook server handles output)"
  - "5-minute AbortController timeout per query to prevent orphaned processes"

patterns-established:
  - "SDK input pattern: one-shot query({ prompt, options: { resume } }) per user message"
  - "Per-session serialization: Map<sessionId, Promise> ensures only one active query per session"

requirements-completed: [SDK-01, SDK-02, REL-01]

# Metrics
duration: 2min
completed: 2026-03-01
---

# Phase 4 Plan 1: SDK Dependencies and SdkInputManager Summary

**Installed Claude Agent SDK with zod peer dep, added ANTHROPIC_API_KEY config validation, and created SdkInputManager class with one-shot query()+resume pattern for cross-platform text input delivery**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-01T08:57:07Z
- **Completed:** 2026-03-01T08:59:22Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Installed @anthropic-ai/claude-agent-sdk@0.2.63 and zod@4.3.6 as dependencies
- Added ANTHROPIC_API_KEY validation to loadConfig() following existing required var pattern
- Created SdkInputManager with send(sessionId, text, cwd) returning typed status results
- Per-session message serialization prevents concurrent query() calls on same session
- 5-minute AbortController timeout on every query prevents orphaned child processes

## Task Commits

Each task was committed atomically:

1. **Task 1: Install SDK dependencies and add API key config** - `d6efa1e` (chore)
2. **Task 2: Create SdkInputManager class** - `bb8717d` (feat)

## Files Created/Modified
- `package.json` - Added @anthropic-ai/claude-agent-sdk and zod dependencies
- `package-lock.json` - Lock file updated with SDK dependency tree
- `src/types/config.ts` - Added anthropicApiKey field to AppConfig interface
- `src/config.ts` - Added ANTHROPIC_API_KEY validation in loadConfig()
- `src/sdk/input-manager.ts` - SdkInputManager class (103 lines) with send() and cleanup()

## Decisions Made
- Used `settingSources: []` to avoid loading filesystem settings during resume calls -- the external CLI session has its own settings configured
- Query stream is drained to completion but output is NOT processed for Telegram display -- the existing hook server + transcript watcher already capture Claude's responses
- AbortController with 5-minute (300s) timeout chosen to match the existing approvalTimeoutMs default

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required

New environment variable required:
- `ANTHROPIC_API_KEY` - Anthropic API key for SDK query() calls. Get one at https://console.anthropic.com/

## Next Phase Readiness
- SdkInputManager is ready to be wired into the bot text handler (Plan 04-02)
- The class is fully self-contained with no dependencies on existing bot infrastructure
- Plan 04-02 will instantiate SdkInputManager in index.ts and call send() from the text message handler

## Self-Check: PASSED

All artifacts verified:
- src/sdk/input-manager.ts exists with SdkInputManager export (103 lines)
- src/types/config.ts contains anthropicApiKey field
- src/config.ts validates ANTHROPIC_API_KEY
- Commit d6efa1e (Task 1) exists
- Commit bb8717d (Task 2) exists
- TypeScript compiles with zero errors

---
*Phase: 04-sdk-resume-input*
*Completed: 2026-03-01*
