# Project Research Summary

**Project:** Claude Code Telegram Bridge v2.0 SDK Migration
**Domain:** Telegram bot daemon migrating from HTTP hook/tmux architecture to Claude Agent SDK
**Researched:** 2026-03-01
**Confidence:** HIGH (with two MEDIUM-confidence gaps noted)

## Executive Summary

The v2.0 migration replaces the entire v1.0 infrastructure layer -- Fastify HTTP hook server, tmux text injection, JSONL transcript file watcher, and hook auto-installer -- with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This is an inversion of control: the bot shifts from a passive observer that discovers externally-launched Claude Code sessions to an active controller that spawns and owns sessions via the SDK's `query()` function. The Telegram-facing layer (grammY, topic management, rate limiting, formatting, approval UI) survives intact. The net effect is eliminating ~650 lines of fragile infrastructure code and replacing it with ~400 lines of SDK integration code, while gaining new capabilities (bot-initiated sessions, session interruption, dynamic permissions, image input) that were impossible in v1.

The recommended approach is to use the SDK's V1 `query()` API with streaming input mode (`AsyncIterable<SDKUserMessage>` prompt). This gives the bot multi-turn conversation support, programmatic tool approval via `canUseTool` callback, and structured event streaming -- all through a single async generator. The V2 preview API (`unstable_v2_createSession`) is explicitly ruled out: it silently ignores critical options like `permissionMode` and `canUseTool` (GitHub issue #176, unfixed). The core new component is a `SessionManager` that orchestrates concurrent SDK sessions, each running its own `for await` event loop consuming `SDKMessage` objects and routing them to Telegram.

The three highest-impact risks are: (1) the AsyncIterable streaming input mode has a confirmed bug (#207, unfixed) that doubles token costs by triggering redundant AI turns -- the workaround is one-shot `query()` with `resume: sessionId` per user message; (2) each `query()` call spawns a separate OS process (~12s cold start, ~50-100MB RAM) that becomes an orphan if the bot crashes (#142, unfixed); (3) the `canUseTool` callback blocks the entire agent loop during approval waits, requiring short timeouts and auto-approval of safe tools. All three are well-understood with documented workarounds, but they must be addressed in the architecture from day one -- not retrofitted.

## Key Findings

### Recommended Stack

The migration is a net subtraction in dependencies. Two packages are added (the Agent SDK and its Zod peer dependency) and two are removed (Fastify and Pino). The existing grammY Telegram stack, TypeScript toolchain, and dotenv remain unchanged. The SDK requires `ANTHROPIC_API_KEY` as a new environment variable -- a billing model change from v1.0 which used the user's existing Claude.ai auth.

**Core technologies:**
- **@anthropic-ai/claude-agent-sdk ^0.2.63** -- replaces Fastify hook server, tmux injection, JSONL watcher, and hook installer with a single `query()` async generator
- **zod ^4.0.0** -- required peer dependency of the Agent SDK (not used directly in bot code)
- **grammy ^1.40.1 + plugins** -- KEPT unchanged; Telegram interface is orthogonal to Claude interface
- **dotenv ^17.3.1** -- KEPT; now also loads `ANTHROPIC_API_KEY`
- **TypeScript 5.9.x / ES2022 target** -- KEPT unchanged; compatible with SDK V1 API

**Removed:** `fastify` (no HTTP server needed), `pino` (only used by Fastify)

**Critical decision:** Use V1 `query()` API, not V2 `unstable_v2_createSession()`. V2 silently ignores `permissionMode`, `cwd`, `allowedTools`, and `canUseTool`. V1 is production-ready and fully supports streaming input for multi-turn conversations.

### Expected Features

**Must migrate (table stakes -- regressions if broken):**
- **TS-01: Session lifecycle management** -- bot calls `query()` directly, owns session creation/teardown; `SDKSystemMessage` (init) replaces SessionStart hook
- **TS-02: Tool call notifications** -- PostToolUse hook callbacks or `SDKAssistantMessage` tool_use blocks replace HTTP PostToolUse handler
- **TS-03: Claude text output capture** -- `SDKAssistantMessage` text blocks replace JSONL transcript watcher entirely
- **TS-04: Tool approval flow** -- `canUseTool` async callback replaces PreToolUse HTTP blocking; same deferred-promise pattern
- **TS-05: User text input** -- AsyncIterable prompt replaces tmux send-keys; this is the killer improvement of the migration
- **TS-06: Notification forwarding** -- Notification hook callback; direct 1:1 mapping
- **TS-07/08/09/10: Rate limiting, status messages, verbosity, summary timer** -- preserved as-is (Telegram-side concerns)

**New capabilities enabled by SDK (differentiators):**
- **DF-01: Bot-initiated sessions** -- users start Claude sessions from Telegram via `/run <prompt>` (this becomes the DEFAULT flow since the bot IS the Claude runtime)
- **DF-02: Dynamic permission modes** -- `/yolo` and `/careful` commands to change permission mode mid-session
- **DF-03: Session interruption** -- `/stop` command calls `query.interrupt()`
- **DF-04: Streaming tool progress** -- real-time "Using Bash..." indicators via stream events

**Defer to v2.1+:**
- DF-05: Subagent tracking (low value, medium complexity)
- DF-07: AskUserQuestion structured UI (high complexity)
- DF-08: Image input from Telegram (medium complexity, low priority)

**Anti-features (do NOT build):**
- Token-by-token streaming to Telegram (rate limits make it impossible)
- HTTP wrapper around the SDK (Telegram IS the remote access layer)
- Auto-approve all tools by default (dangerous; subagents inherit it)
- Custom tool implementations (scope creep; use built-in tools + MCP)
- V2 preview API (unstable, silently broken)

### Architecture Approach

The v2.0 architecture centers on a `SessionManager` that orchestrates concurrent SDK sessions. Each session consists of a `query()` instance, an `InputChannel` (AsyncIterable wrapper for streaming user messages), an `AbortController` for cancellation, and a background `for await` event loop that consumes `SDKMessage` objects and routes them to Telegram via a `MessageRouter`. The `MessageRouter` replaces both the HookHandlers and TranscriptWatcher from v1, classifying SDK messages by type and dispatching to the existing MessageBatcher, StatusMessage, and SummaryTimer components. The approval flow uses the same deferred-promise pattern as v1, but the promise now resolves inside the `canUseTool` callback instead of an HTTP response handler.

**New components to create:**
1. **SessionManager** (`src/sdk/session-manager.ts`) -- orchestrates N concurrent sessions; start/stop/input/abort; HIGH complexity
2. **MessageRouter** (`src/sdk/message-router.ts`) -- classifies SDKMessages, routes to Telegram formatters; MEDIUM complexity
3. **InputChannel** (`src/sdk/input-channel.ts`) -- AsyncIterable push-pull bridge for streaming user input; MEDIUM complexity
4. **SDK types adapter** (`src/sdk/types.ts`) -- bridges SDK types to internal types; LOW complexity

**Components to delete:** `hooks/server.ts`, `hooks/handlers.ts`, `utils/install-hooks.ts`, `monitoring/transcript-watcher.ts`, `types/hooks.ts`

**Components preserved:** bot/bot.ts, bot/topics.ts, bot/rate-limiter.ts, bot/formatter.ts (minor updates), monitoring/status-message.ts, monitoring/summary-timer.ts, monitoring/verbosity.ts, control/approval-manager.ts (interface change), sessions/session-store.ts (simplified)

### Critical Pitfalls

All three researchers flagged overlapping concerns. The top 5 pitfalls, ranked by combined severity and recovery cost:

1. **AsyncIterable double-turn bug (#207, UNFIXED)** -- streaming input mode triggers two AI turns per user message, doubling token costs. Prevention: use one-shot `query()` + `resume: sessionId` pattern until the bug is fixed. This is the single most expensive pitfall if missed ($140-700/month wasted per reporter's estimate). Recovery cost: MEDIUM (refactor session interaction pattern).

2. **Orphaned child processes on crash (#142, UNFIXED)** -- each `query()` spawns a child process; bot crash leaves orphans consuming 50-100MB each. Prevention: PID tracking, startup orphan cleanup, systemd cgroup management. Recovery cost: LOW (add cleanup script), but consequences are HIGH (OOM over time).

3. **Event loop interference between grammY and SDK** -- tight `for await` loops over SDK messages starve grammY's update processing, causing approval buttons to time out. Prevention: async message queuing, yield control with `setImmediate()`, keep callback query handlers lightweight. Recovery cost: HIGH (architectural refactor if not designed correctly from day one).

4. **canUseTool blocks the entire agent loop** -- during approval waits, the Claude session is completely paused. Prevention: short timeouts (60-120s), auto-approve safe read-only tools, "waiting for approval" status messages. Recovery cost: LOW (configuration change).

5. **SDK settings isolation** -- SDK defaults to loading NO filesystem settings (empty `settingSources`). Claude Code sessions started via SDK behave differently from CLI sessions. Prevention: explicitly set `settingSources: ['user', 'project', 'local']` or configure everything programmatically. Recovery cost: LOW (one-line fix once diagnosed).

## Implications for Roadmap

Based on the combined dependency analysis from ARCHITECTURE.md and pitfall-to-phase mapping from PITFALLS.md, the migration should follow a 5-phase structure. This differs from the v1.0 research (6 phases) because the SDK consolidates several v1 concerns into fewer components.

### Phase 1: SDK Foundation + Session Lifecycle

**Rationale:** Everything depends on `query()` working correctly. The process lifecycle (Pitfall 1: cold start, Pitfall 5: orphaned processes), session interaction pattern (Pitfall 2: double-turn), and event loop coexistence (Pitfall 6: grammY interference) must be designed before any feature work. This phase validates the fundamental SDK integration.

**Delivers:** SDK dependency installed; updated types and config (remove hook server fields, add API key); InputChannel implementation; SessionManager skeleton with single-session `query()` + `for await` loop; orphan process cleanup on startup; session ID capture and persistence; topic creation on session init; basic text output forwarding to Telegram.

**Addresses features:** TS-01 (session lifecycle), TS-03 (text output capture), DF-01 (bot-initiated sessions via `/run`)

**Avoids pitfalls:** Process spawn overhead (1), double-turn bug (2) via one-shot+resume pattern, V2 API (3) by using V1, orphaned processes (5), event loop interference (6), settings isolation (10)

**Key decision:** One-shot `query()` + `resume` vs. streaming input. Research strongly recommends one-shot+resume due to the double-turn bug (#207). Design the InputChannel to support both patterns so switching to streaming input is a single-module change when #207 is fixed.

### Phase 2: Approval Flow + Tool Notifications

**Rationale:** The `canUseTool` callback is the second-highest-value feature after basic session management. It requires Phase 1's SessionManager but is independent of text input or monitoring. The approval flow architecture (Pitfall 4: blocking agent loop, Pitfall 9: hook vs canUseTool execution order) must be correctly established before adding more complexity.

**Delivers:** `canUseTool` callback wired to ApprovalManager's deferred-promise pattern; AbortSignal awareness; auto-approve for safe read-only tools (Read, Glob, Grep); PostToolUse hook callbacks forwarding tool notifications to Telegram; Notification hook callbacks.

**Addresses features:** TS-04 (tool approval), TS-02 (tool call notifications), TS-06 (notification forwarding)

**Avoids pitfalls:** canUseTool blocking (4), hook vs canUseTool execution order (9)

### Phase 3: User Text Input + Multi-Turn Conversations

**Rationale:** With sessions running and approvals working, add the ability for Telegram users to send follow-up messages to active Claude sessions. This is the feature that was most fragile in v1 (tmux injection) and most improved by the SDK (structured async input). It depends on Phase 1's InputChannel but can be built incrementally on top of the one-shot+resume pattern.

**Delivers:** Telegram text messages in session topics routed to `sessionManager.sendInput()`; new `query()` call with `resume: sessionId` per user message (one-shot+resume pattern); session resume after bot restart; `/stop` command for session interruption.

**Addresses features:** TS-05 (user text input), DF-03 (session interruption)

**Avoids pitfalls:** Double-turn bug (2) continues to be avoided via one-shot+resume; session resume requires stored session IDs (8)

### Phase 4: Monitoring + Status + Cleanup

**Rationale:** With core functionality proven (sessions, approvals, text I/O), adapt the monitoring components to pull data from SDK messages instead of transcript files and hook payloads. Remove dead code (Fastify, hook installer, transcript watcher) in this phase -- only after the SDK path is fully verified.

**Delivers:** Status message updates from `SDKAssistantMessage.message.usage`; context percentage tracking from token usage; summary timer adapted to SDK data source; `SDKCompactBoundaryMessage` handling; Fastify and Pino removed from package.json; dead files deleted; settings.json cleaned of HTTP hook config.

**Addresses features:** TS-08 (status messages), TS-10 (summary timer), DF-02 (dynamic permissions via `/yolo` and `/careful`)

**Avoids pitfalls:** Ghost hook events from old settings.json (15); streaming output overwhelming Telegram (7) by using complete messages not partial streams

### Phase 5: Polish + Operational Hardening

**Rationale:** Edge cases, error handling, and operational concerns. This phase addresses the "looks done but isn't" checklist from PITFALLS.md.

**Delivers:** Graceful shutdown (abort all sessions, wait for processing loops); memory monitoring for child processes; configurable verbosity preserved; formatter adapted for SDK tool_use block shape differences; comprehensive error isolation (Telegram errors never crash SDK sessions); event loop lag monitoring.

**Addresses features:** TS-07 (rate limiting preserved), TS-09 (verbosity preserved)

**Avoids pitfalls:** Streaming output volume (7), extended thinking + streaming incompatibility (11), session.close() leak (13)

### Phase Ordering Rationale

- **Phase 1 first** because it resolves the three most critical architectural decisions: session interaction pattern (one-shot+resume vs streaming), process lifecycle management, and event loop coexistence. Every subsequent phase depends on these being correct.
- **Phase 2 before Phase 3** because the approval flow is higher-value and higher-risk than text input. Approvals involve the `canUseTool` blocking behavior (Pitfall 4) which must be stable before adding more async complexity.
- **Phase 3 before Phase 4** because user text input is core functionality, while monitoring is polish. Users need to interact with sessions before they need status dashboards.
- **Phase 4 before Phase 5** because dead code removal (Fastify, transcript watcher) should happen only after the SDK replacement is fully verified. Removing infrastructure before verification creates rollback risk.
- **Phase 5 last** because operational hardening and polish should not precede feature completeness. The "looks done but isn't" checklist is explicitly a final-phase activity.

### Research Flags

Phases likely needing `/gsd:research-phase` during planning:
- **Phase 1:** The one-shot+resume vs streaming input decision needs empirical validation. The double-turn bug (#207) workaround must be tested with actual SDK sessions to confirm resume works seamlessly for multi-turn flows. Also verify `settingSources` behavior and SDK settings isolation.
- **Phase 2:** Verify exact `canUseTool` callback signature, `PermissionResult` shape, and interaction with AbortSignal. Confirm that auto-approve in `canUseTool` (returning `allow` without posting to Telegram) does not interfere with the SDK's internal permission pipeline.

Phases with standard patterns (skip research-phase):
- **Phase 3:** AsyncIterable input and `query.interrupt()` are well-documented with examples. The InputChannel pattern is standard producer-consumer.
- **Phase 4:** Monitoring data extraction from SDK messages is straightforward field mapping. Dead code removal is mechanical.
- **Phase 5:** Error handling, graceful shutdown, and operational hardening are standard patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | SDK package verified on npm (v0.2.63), all API surface confirmed against official TypeScript reference docs. Zod peer dependency verified. Fastify/Pino removal justified. |
| Features | HIGH | All table-stakes features have direct SDK equivalents with documented patterns. Feature dependency tree clearly maps to SDK capabilities. Differentiators are straightforward SDK method calls. |
| Architecture | HIGH | SessionManager + MessageRouter + InputChannel pattern is well-supported by SDK docs. Concurrent session handling via per-session event loops is standard Node.js async. The only MEDIUM area is the one-shot+resume workaround for the double-turn bug. |
| Pitfalls | HIGH | Critical pitfalls verified against GitHub issues with reproduction steps. Three unfixed SDK bugs (#207, #142, #176) are well-documented with workarounds. Phase-specific warnings are concrete and actionable. |

**Overall confidence:** HIGH

### Gaps to Address

- **One-shot+resume latency:** The recommended workaround for the double-turn bug (#207) uses one-shot `query()` + `resume` per user message. This adds 3-12 seconds of latency per message (process spawn overhead from Pitfall 1). Need to empirically measure whether the 12s cold start applies to resume calls or only initial session creation. If resume is fast (~2-3s), the workaround is viable. If resume has the same 12s overhead, streaming input with output filtering (Workaround B) may be preferable despite token waste.

- **Zod version conflict:** STACK.md says the SDK requires `zod ^4.0.0` as a peer dependency. PITFALLS.md (Pitfall 14) says the SDK requires `zod ^3.24.1` and warns about Zod 4 conflicts. This is a contradiction between researchers. The `npm view` verification in STACK.md (HIGH confidence) says `^4.0.0`, so that is authoritative. Resolve by installing `zod@4` and testing.

- **API key billing model change:** v1.0 used the user's Claude.ai subscription (free for Pro users). v2.0 SDK requires `ANTHROPIC_API_KEY` which bills per-token via the Anthropic API. This is a significant cost model change for users. Must be documented clearly. No technical mitigation available.

- **SDK 0.x versioning:** The SDK is pre-1.0 (v0.2.63) with very frequent releases (every 1-3 days). While the V1 API appears stable across recent releases, there is no formal stability guarantee. Pin to `^0.2.63` and test after each update.

- **Bot restart session resume:** Architecture research recommends using `resume: sessionId` to reconnect after bot restart. This has not been empirically validated. Need to confirm: (a) does the SDK persist enough state to disk for resume to work after the parent process dies? (b) does resume restore the `canUseTool` callback correctly? (c) does the resumed session pick up from where it left off or restart from the beginning?

## Sources

### Primary (HIGH confidence)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- complete V1 API: `query()`, `Options`, `SDKMessage` types, `CanUseTool`, `PermissionResult`
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- capabilities, architecture, built-in tools, hooks, permissions
- [Streaming Input Modes](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- AsyncIterable pattern, streaming vs single message
- [Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- `includePartialMessages`, `SDKPartialAssistantMessage`, thinking incompatibility
- [Handle Approvals and User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- `canUseTool` callback, `PermissionResult`, `AskUserQuestion`
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- session IDs, resume, fork, persistence
- [SDK Hooks System](https://platform.claude.com/docs/en/agent-sdk/hooks) -- PostToolUse, Notification, SessionStart/End callbacks
- [Configure Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) -- permission modes, canUseTool execution order
- [Hosting the Agent SDK](https://platform.claude.com/docs/en/agent-sdk/hosting) -- resource requirements, process management
- [Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) -- breaking changes, settingSources default
- [npm: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- v0.2.63, peer deps, engines
- [SDK Changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) -- release history

### Secondary (MEDIUM confidence)
- [GitHub Issue #207: AsyncIterable double turn](https://github.com/anthropics/claude-agent-sdk-typescript/issues/207) -- double token cost bug, reproduction, workarounds
- [GitHub Issue #176: V2 ignores options](https://github.com/anthropics/claude-agent-sdk-typescript/issues/176) -- V2 preview silently broken
- [GitHub Issue #142: Orphaned processes](https://github.com/anthropics/claude-agent-sdk-typescript/issues/142) -- process leak after crash
- [GitHub Issue #34: 12-second overhead](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) -- cold start benchmarks
- [TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- unstable API, feature gaps
- [Claudegram (grammY + SDK)](https://github.com/NachoSEO/claudegram) -- real-world integration patterns

### Tertiary (LOW confidence)
- [GitHub Issue #184: SDKRateLimitEvent missing export](https://github.com/anthropics/claude-agent-sdk-typescript/issues/184) -- minor type export gap
- [GitHub Issue #333 (Python): Multi-instance performance](https://github.com/anthropics/claude-agent-sdk-python/issues/333) -- 20-30s startup (Python-specific but directionally relevant)

---
*Research completed: 2026-03-01*
*Ready for roadmap: yes*
