---
phase: 06-compact-output-session-ux
plan: 01
subsystem: ui
tags: [lru-cache, telegram, formatter, inline-keyboard, compact-output]

# Dependency graph
requires:
  - phase: 03-approval-control
    provides: "TopicManager with sendMessageRaw, MessageBatcher with debounce"
provides:
  - "CompactToolResult type and formatToolCompact function for single-line tool display"
  - "LRU expand cache (max 500, 4hr TTL) for expand/collapse content storage"
  - "buildExpandedHtml helper for constructing expanded view"
  - "TopicManager.sendMessageWithKeyboard for inline keyboard messages"
  - "TopicManager.unpinMessage for /clear flow"
  - "MessageBatcher returning message IDs from flush with onFlush callback"
affects: [06-02-PLAN, 06-03-PLAN]

# Tech tracking
tech-stack:
  added: [lru-cache]
  patterns: [compact-tool-format, expand-cache-pattern, smart-path-truncation]

key-files:
  created:
    - src/bot/expand-cache.ts
  modified:
    - src/bot/formatter.ts
    - src/bot/rate-limiter.ts
    - src/bot/topics.ts
    - src/index.ts
    - package.json

key-decisions:
  - "Formatter is a pure function returning data; caching is done by caller (separation of concerns)"
  - "Batcher sendFn changed to return Promise<number> for message_id tracking; wired to sendMessageRaw"
  - "onFlush callback pattern chosen over internal expand cache awareness (keeps batcher generic)"

patterns-established:
  - "CompactToolResult: { compact, expandContent, toolName } -- standard return for tool formatting"
  - "smartPath: ~/.../ truncation for paths > 60 chars"
  - "diffStats: +N -M format for edit operations"

requirements-completed: [OUT-01, OUT-02, OUT-04]

# Metrics
duration: 5min
completed: 2026-03-01
---

# Phase 6 Plan 1: Compact Tool Formatter and Infrastructure Summary

**Compact single-line tool formatter with LRU expand cache and message ID tracking via upgraded MessageBatcher and TopicManager**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-01T21:12:19Z
- **Completed:** 2026-03-01T21:17:09Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Replaced verbose multi-line formatToolUse with compact formatToolCompact returning single-line HTML (max 250 chars) per tool call
- Created LRU expand cache module (max 500 entries, 4hr TTL) with buildExpandedHtml for expand/collapse content
- Upgraded MessageBatcher to track message IDs (sendFn returns Promise<number>) with setOnFlush callback for expand cache wiring
- Added sendMessageWithKeyboard and unpinMessage methods to TopicManager for inline keyboard and /clear support

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite formatter for compact output and create expand cache module** - `c5770d2` (feat)
2. **Task 2: Upgrade MessageBatcher to return message IDs and add keyboard support to TopicManager** - `b073ff3` (feat)

## Files Created/Modified
- `src/bot/expand-cache.ts` - LRU cache for expand/collapse content with ExpandEntry type and buildExpandedHtml helper
- `src/bot/formatter.ts` - Replaced formatToolUse with formatToolCompact; compact single-line format per tool type
- `src/bot/rate-limiter.ts` - MessageBatcher upgraded: sendFn returns message_id, setOnFlush callback, enqueueImmediate returns number
- `src/bot/topics.ts` - Added sendMessageWithKeyboard (InlineKeyboard) and unpinMessage methods
- `src/index.ts` - Updated import to formatToolCompact, wired batcher to sendMessageRaw
- `package.json` - Added lru-cache dependency

## Decisions Made
- Formatter is a pure function returning data; caching is done by the caller (not inside formatter) to maintain separation of concerns
- Batcher uses onFlush callback pattern rather than internal expand cache awareness, keeping it a generic message batching utility
- Wired batcher to sendMessageRaw immediately (instead of deferring to Plan 02) because the type change from Promise<void> to Promise<number> required a compatible send function

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated index.ts import and call site for formatToolCompact**
- **Found during:** Task 1
- **Issue:** Removing formatToolUse broke the import in index.ts; TypeScript would not compile
- **Fix:** Updated import to formatToolCompact and adapted call site to use result.compact instead of result.text
- **Files modified:** src/index.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** c5770d2 (Task 1 commit)

**2. [Rule 3 - Blocking] Wired batcher to sendMessageRaw instead of sendMessage**
- **Found during:** Task 2
- **Issue:** Changing sendFn type from Promise<void> to Promise<number> broke wiring; sendMessage returns void
- **Fix:** Updated batcher wiring to use sendMessageRaw (which already returns message_id)
- **Files modified:** src/index.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** b073ff3 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed unpinChatMessage API call signature**
- **Found during:** Task 2
- **Issue:** grammy's unpinChatMessage takes message_id as a direct number parameter, not wrapped in an object
- **Fix:** Changed `{ message_id: messageId }` to just `messageId`
- **Files modified:** src/bot/topics.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** b073ff3 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All auto-fixes necessary for compilation. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Compact formatter, expand cache, and batcher message ID tracking are ready for Plan 02 wiring
- Plan 02 will wire the expand/collapse button flow: onFlush callback stores expand content, callback query handler expands/collapses
- TopicManager.sendMessageWithKeyboard ready for expand button attachment

## Self-Check: PASSED

All created files verified present. All commit hashes verified in git log.

---
*Phase: 06-compact-output-session-ux*
*Completed: 2026-03-01*
