---
phase: 06-compact-output-session-ux
plan: 02
subsystem: ui
tags: [expand-collapse, inline-keyboard, compact-output, telegram, callback-query]

# Dependency graph
requires:
  - phase: 06-compact-output-session-ux
    plan: 01
    provides: "formatToolCompact, expandCache, MessageBatcher with onFlush, sendMessageWithKeyboard"
provides:
  - "Working expand/collapse callback handlers in bot.ts"
  - "Batcher onFlush wiring to populate expand cache and attach Expand button"
  - "Clean Claude text output without <b>Claude:</b> prefix"
  - "Compact no-emoji pinned status message format"
affects: [06-03-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [expand-collapse-callback, onflush-cache-wiring, compact-status-format]

key-files:
  created: []
  modified:
    - src/bot/bot.ts
    - src/index.ts
    - src/monitoring/status-message.ts

key-decisions:
  - "Expand button added post-flush via editMessageText rather than sent with initial message (allows batching to complete first)"
  - "pendingExpandData map tracks expand content per-thread between enqueue and flush (cleared on flush)"
  - "Status format uses plain text 'claude-o-gram' branding -- no emoji, no HTML formatting"

patterns-established:
  - "Callback data format: exp:{messageId} / col:{messageId} -- numeric IDs keep within 64-byte Telegram limit"
  - "Post-flush edit pattern: send plain text, then edit to add keyboard after message ID is known"

requirements-completed: [OUT-03, OUT-05, OUT-06, OUT-07]

# Metrics
duration: 2min
completed: 2026-03-01
---

# Phase 6 Plan 2: Wire Compact Output and Expand/Collapse Summary

**Expand/collapse callback handlers wired to expand cache, compact status message, and clean Claude output without bot prefixes**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-01T21:20:09Z
- **Completed:** 2026-03-01T21:22:39Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Added expand/collapse callback query handlers to bot.ts for in-place message editing with inline keyboard toggle
- Wired batcher onFlush callback in index.ts to populate expand cache and attach Expand button via editMessageText
- Removed `<b>Claude:</b>` prefix from Claude text output (OUT-06)
- Rewrote status message to compact 2-line no-emoji format: "claude-o-gram | N% ctx | Xh Ym" + "N tools | M files"

## Task Commits

Each task was committed atomically:

1. **Task 1: Add expand/collapse callback handlers to bot.ts** - `89ab239` (feat)
2. **Task 2: Rewire index.ts for compact formatter, expand cache, and clean output** - `962c185` (feat)
3. **Task 3: Rewrite status message to compact no-emoji format** - `6eecdf5` (feat)

## Files Created/Modified
- `src/bot/bot.ts` - Added expand (exp:{id}) and collapse (col:{id}) callback query handlers with cache miss alerts
- `src/index.ts` - Added expand cache imports, pendingExpandData map, onFlush wiring, removed Claude: prefix
- `src/monitoring/status-message.ts` - Replaced 5-line emoji format with 2-line compact no-emoji format

## Decisions Made
- Expand button is added post-flush via editMessageText rather than sent with the initial message, because the message ID is not known until after sendMessageRaw returns. This means a brief moment where the message appears without a button before the edit adds it.
- pendingExpandData is a simple Map per threadId, cleared on every flush. This works because tool calls for a given thread are batched within the same flush window.
- Status format uses plain "claude-o-gram" text branding with no emoji and no HTML bold/formatting for maximum compactness.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All compact output infrastructure is wired and functional
- Plan 03 can now implement /clear command and session lifecycle improvements
- Expand/collapse, compact status, and clean output are all live

## Self-Check: PASSED

All created/modified files verified present. All commit hashes verified in git log.

---
*Phase: 06-compact-output-session-ux*
*Completed: 2026-03-01*
