---
phase: 01-foundation
plan: 04
subsystem: infra
tags: [grammy, fastify, telegram, hooks, claude-code, session-management]

# Dependency graph
requires:
  - phase: 01-foundation plan 02
    provides: SessionStore, Fastify hook server, HookHandlers
  - phase: 01-foundation plan 03
    provides: Bot, TopicManager, MessageBatcher, formatSessionStart, formatSessionEnd, formatToolUse

provides:
  - "Single-process daemon (src/index.ts) that wires Fastify hook server to Telegram forum topic lifecycle"
  - "Hook auto-installer (src/utils/install-hooks.ts) that writes SessionStart/SessionEnd/PostToolUse HTTP hooks to ~/.claude/settings.json"
  - "HookCallbacks implementation connecting onSessionStart->createTopic, onToolUse->batcher.enqueue, onSessionEnd->closeTopic"
  - "Bot restart reconnection: posts restart notice to any active topics found in SessionStore on startup"
  - "Graceful shutdown: flushes MessageBatcher, stops grammY bot, closes Fastify server"

affects:
  - Phase 2 monitoring plans (all depend on the same daemon process and HookCallbacks pattern)
  - Phase 3 control plans (same entry point, extend HookCallbacks for PreToolUse)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-process dual server: grammY bot + Fastify in one Node.js process"
    - "HookCallbacks interface as decoupling layer between session state and Telegram messaging"
    - "Idempotent hook auto-install: overwrite our three hook keys, preserve all others"
    - "Fire-and-forget PostToolUse route: handler returns immediately, Telegram send is async"

key-files:
  created:
    - src/index.ts
    - src/utils/install-hooks.ts
  modified: []

key-decisions:
  - "Auto-install hooks on every startup (idempotent merge, not conditional) -- simplest approach, no 'already installed' flag needed"
  - "onSessionStart resume detection delegates to session store cwd matching established in plan 02"
  - "Reconnect-on-restart sends bot restart notice via sendBotRestartNotice (plan 03) rather than reopening topic to avoid Telegram API errors on already-open topics"

patterns-established:
  - "Entry point pattern: loadConfig -> installHooks -> SessionStore -> Bot -> TopicManager -> Batcher -> HookCallbacks -> HookHandlers -> server.listen"
  - "Graceful shutdown: SIGINT/SIGTERM registers both signals, same handler, process.exit(0) after cleanup"

requirements-completed: [SESS-03, SESS-05]

# Metrics
duration: ~30min
completed: 2026-02-28
---

# Phase 1 Plan 4: Integration Wiring, Hook Auto-Install, and End-to-End Verification Summary

**Single-process daemon wiring Fastify hook server to grammY Telegram bot with auto-install of Claude Code HTTP hooks into ~/.claude/settings.json**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-02-28T19:07:00Z
- **Completed:** 2026-02-28T20:10:00Z
- **Tasks:** 2 (1 implementation, 1 human verification)
- **Files modified:** 2

## Accomplishments
- Hook auto-installer writes SessionStart/SessionEnd/PostToolUse HTTP hook config into `~/.claude/settings.json` on every startup (idempotent merge)
- Main entry point wires all prior plan components: SessionStore + HookHandlers + HookServer + Bot + TopicManager + MessageBatcher into a single process
- HookCallbacks implementation: SessionStart creates forum topic and sends start message, PostToolUse batches formatted messages, SessionEnd sends summary and closes topic
- Bot restart reconnects to all active sessions found in persistent SessionStore and posts restart notice to each topic
- Graceful shutdown on SIGINT/SIGTERM: flushes batcher, stops bot, closes server
- End-to-end verification passed: build clean, bot startup, forum topic creation, formatted tool use messages, session end with summary, graceful shutdown

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement hook auto-installer and entry point** - `bcf5005` (feat)
2. **Task 2: Verify end-to-end bot startup** - N/A (human verification checkpoint, no code changes)

## Files Created/Modified
- `src/index.ts` - Main entry point: loadConfig -> installHooks -> SessionStore -> Bot -> TopicManager -> Batcher -> HookCallbacks -> HookHandlers -> server.listen + graceful shutdown
- `src/utils/install-hooks.ts` - Reads ~/.claude/settings.json, merges HTTP hook entries for the three Claude Code events, writes back

## Decisions Made
- Auto-install hooks on every startup rather than checking if already installed -- idempotent merge means no stale URLs if port changes, no "already installed" flag to maintain
- onSessionStart resume path delegates entirely to the session store's cwd-matching logic established in plan 02; no new resume detection needed at this layer
- Reconnect-on-restart sends `sendBotRestartNotice` (which sends a message to the existing open topic) rather than calling `reopenTopic`, since the topic was never closed -- avoids Telegram API error on already-open topics
- PostToolUse route is fire-and-forget (no await on the enqueue) per plan 02 decision -- Claude Code is not blocked waiting for Telegram delivery

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required beyond what was established at project initialization (.env with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).

## Next Phase Readiness
- Complete Phase 1 foundation is live and verified end-to-end
- Phase 2 (Monitoring) can begin: daemon process accepts new hook types, HookCallbacks pattern extends naturally for transcript capture and notification forwarding
- Key concern for Phase 2: JSONL transcript format is MEDIUM confidence (community-documented). Plan 02-01 should include defensive parsing

---
*Phase: 01-foundation*
*Completed: 2026-02-28*
