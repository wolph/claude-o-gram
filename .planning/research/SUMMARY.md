# Project Research Summary

**Project:** Claude Code Telegram Bridge v3.0 UX Overhaul
**Domain:** Telegram bot UX for remote Claude Code monitoring and control
**Researched:** 2026-03-01
**Confidence:** HIGH

## Executive Summary

The v3.0 UX Overhaul transforms the Telegram bridge from a verbose notification relay into a terminal-fidelity remote control interface. The overhaul encompasses six features across four capability areas: compact tool output with expand/collapse buttons, graduated permission modes replacing binary approve/deny, subagent lifecycle visibility, and /clear topic reuse. The defining finding across all research is that **zero new dependencies are required** -- every feature is implementable with the existing grammY + Fastify + Claude Code hooks stack through application-level changes only.

The recommended approach is a four-phase build ordered by dependency chains and risk. Compact output comes first because it is the visual foundation that expand/collapse, subagent labeling, and terminal-fidelity all depend on. Permission modes come second because they deliver the highest usability gain (eliminating button-tap fatigue for remote users) and interact cleanly with the infinite-timeout requirement. Topic reuse for /clear is third -- a focused scope that requires careful coordination between SessionEnd and SessionStart hooks but no novel patterns. Subagent visibility is last because it carries the highest uncertainty: while SubagentStart/SubagentStop hooks are documented and verified, **individual tool calls cannot be attributed to specific subagents through hooks alone** (confirmed via GitHub issues #16126, #14859, #7881). This limitation means subagent visibility delivers lifecycle events (start/stop with agent type labels) but not per-tool-call attribution, which is an acceptable trade-off for v3.0.

The primary risks are: (1) security escalation from "Accept All" permission mode -- mitigated by a mandatory dangerous-command blocklist and per-session scoping; (2) /clear double-processing where SessionEnd closes the topic before SessionStart can reuse it -- mitigated by a "clearing" intermediate state; and (3) expand/collapse memory leaks from unbounded content storage -- mitigated by an LRU cache with TTL from day one. All three are well-understood with clear prevention strategies documented in PITFALLS.md.

## Key Findings

### Recommended Stack

No new packages are needed. All v3.0 features build on the existing validated stack. The work is purely application-level: new formatting logic, additional Telegram API method calls already available in grammY, expanded hook endpoints in Fastify, and state management built on existing in-memory Map + JSON persistence patterns.

**Core technologies (unchanged):**
- **grammY ^1.40.1:** Telegram bot framework -- provides InlineKeyboard, editMessageText, callbackQuery handlers, unpinChatMessage needed for all v3.0 features
- **Fastify ^5.7.4:** HTTP hook server -- add 2 new routes (SubagentStart, SubagentStop), no structural changes
- **@anthropic-ai/claude-agent-sdk ^0.2.63:** SDK input delivery -- no changes needed
- **TypeScript ^5.9.3:** Language -- no version change needed

**Explicitly NOT adding:** Redis/SQLite (session data is ephemeral), @grammyjs/menu (over-engineered for expand/collapse), @grammyjs/conversations (no multi-step flows), any WebSocket library (hooks are sufficient).

**One new environment variable:** `DEFAULT_APPROVAL_MODE` (default: `ask`). One changed default: `APPROVAL_TIMEOUT_MS` from 300000 to 0 (infinite).

### Expected Features

**Must have (table stakes for terminal-fidelity):**
- **Compact tool output** -- Terminal shows `Read(file)` one-liners; the bot currently shows verbose multi-line blocks with emoji. MEDIUM complexity.
- **Remove bot commentary** -- Strip emoji prefixes, stop filtering "procedural narration," stop labeling Claude's output. LOW complexity.
- **No permission timeout** -- Current 5-min auto-deny is hostile for remote users. Change to infinite wait. LOW complexity (one-line change).
- **/clear topic reuse** -- Without this, /clear creates new topics, cluttering the group. Handle `source === 'clear'` to reuse existing topic. MEDIUM complexity.

**Should have (competitive differentiators exploiting Telegram's interactive UI):**
- **Expand/collapse inline buttons** -- Terminal cannot do this. Tap to see full content on demand. MEDIUM complexity.
- **Permission modes (Ask, Safe Only, Same Tool, Accept All, Until Done)** -- More nuanced than terminal's fixed modes. Session-scoped, user-controllable from Telegram. HIGH complexity.
- **Subagent visibility** -- Start/stop lifecycle messages with agent type labels. MEDIUM-HIGH complexity.
- **Local stdout visibility** -- Print auto-accepted permissions to bot's stdout. LOW complexity.

**Anti-features (explicitly avoid):**
- Streaming tool output (rate limits make it impractical)
- Per-subagent Telegram topics (subagents are too ephemeral)
- Nested inline keyboards (64-byte callback_data limit makes deep navigation fragile)
- Multi-user approval voting (single-user system)

### Architecture Approach

The architecture follows four established patterns: (1) a server-side content store for expand/collapse (short callback_data IDs mapping to full content, with LRU eviction), (2) a per-session permission state machine in ApprovalManager (checking mode before creating deferred promises), (3) a lifecycle hook pattern for subagent visibility (SubagentStart/Stop for structured events, transcript for content), and (4) a coordinated state machine for /clear (SessionEnd sets "clearing" state, SessionStart completes the reuse). The key architectural constraint is that messages with inline keyboards cannot be batched -- they must be sent as standalone messages.

**Major components and changes:**
1. **ContentStore (NEW)** -- In-memory LRU Map storing expanded content for callback lookups, keyed by monotonic counter (base36 short IDs). 1-hour TTL cleanup.
2. **ApprovalManager (MODIFY)** -- Add `shouldAutoAccept()` with per-session mode state, approved-tools tracking for "Same Tool" mode, and 24-hour safety timeout replacing 5-min timeout.
3. **Formatter (MODIFY)** -- Rewrite to compact `Tool(args...)` one-liner format. Add subagent `[AgentType]` prefix labels. Remove emoji from tool output.
4. **HookHandlers (MODIFY)** -- Add SubagentStart/SubagentStop handlers. Add /clear detection via SessionEnd `reason` and SessionStart `source` fields. New "clearing" intermediate state.
5. **Fastify Server (MODIFY)** -- Two new routes: `/hooks/subagent-start`, `/hooks/subagent-stop`.
6. **MessageBatcher/RateLimiter (MODIFY)** -- Messages with InlineKeyboard bypass batching (sent immediately as standalone).

### Critical Pitfalls

1. **callback_data 64-byte overflow** -- Use server-side content store with 3-7 byte IDs (`x:a1b2`) instead of encoding full state in callback_data. Design the encoding scheme before implementing any expand/collapse buttons. *Phase 1.*

2. **Auto-accept security escalation** -- Never implement a bare "Accept All" with no safety net. Maintain a blocklist of dangerous command patterns (`rm -rf`, `sudo`, `curl | bash`, SSH key ops) that always require manual approval regardless of mode. Show persistent warning in status message. *Phase 2.*

3. **/clear double-processing** -- SessionEnd fires before SessionStart. If SessionEnd closes the topic, SessionStart cannot reuse it. Handle as a coordinated pair: SessionEnd(reason=clear) sets "clearing" state instead of "closed"; SessionStart(source=clear) finds the "clearing" session by cwd match and reuses the threadId. *Phase 3.*

4. **Expand/collapse memory leak** -- Unbounded content Map grows indefinitely. Use LRU cache (200 entries per session, 30-min TTL) from day one. Evicted entries show "Content no longer available" on expand tap. *Phase 1.*

5. **Missing subagent hooks** -- `installHooks()` only registers v1.0 hook events. Must add SubagentStart and SubagentStop to hook installation before any subagent display work. PostToolUse payloads do NOT contain agent_id -- per-tool-call attribution is not possible via hooks alone. *Phase 4.*

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Compact Tool Output with Expand/Collapse

**Rationale:** This is the visual foundation that all other features depend on. Expand/collapse requires compact format to exist. Subagent labeling requires the compact format to prepend agent type prefixes. Terminal-fidelity requires removing emoji and verbose formatting. Building this first also establishes the ContentStore and callback_data patterns reused by permission mode buttons.

**Delivers:** Terminal-matching `Tool(args...)` one-liner format with inline "Expand" buttons for long outputs. Removes bot commentary (emoji, narration filtering, Claude labeling). Establishes the server-side content store pattern.

**Features addressed:** Compact tool output (F-01), Remove bot commentary (F-02), Expand/collapse buttons (partial F-01)

**Pitfalls to address:**
- callback_data 64-byte limit (Pitfall 1) -- use short monotonic IDs
- Content Map memory leak (Pitfall 2) -- LRU cache with TTL from start
- Edit race conditions (Pitfall 3) -- expandable messages bypass batching
- Expanded content exceeding 4096 chars (Pitfall 12) -- truncation with file fallback
- Rate limiting from expand spam (Pitfall 9) -- 2-second debounce per message_id

**Files changed:** `formatter.ts`, `bot.ts`, `rate-limiter.ts`, `topics.ts`, `text.ts`, new `content-store.ts`

### Phase 2: Permission Modes

**Rationale:** Independent of Phase 1 but delivers the highest usability improvement for remote users. Eliminates button-tap fatigue. Requires infinite timeout (a prerequisite one-liner). The permission state machine is self-contained within ApprovalManager.

**Delivers:** Five session-scoped permission modes (Ask, Safe Only, Same Tool, Accept All, Until Done) controllable via Telegram. Infinite approval timeout. Local stdout logging of auto-accepted permissions. Dangerous-command blocklist as safety net.

**Features addressed:** Permission modes (F-04), No permission timeout (part of F-04 prerequisites), Local stdout visibility (F-05)

**Pitfalls to address:**
- Auto-accept security escalation (Pitfall 4) -- blocklist of dangerous patterns, per-session scope
- Permission mode state lost on restart (Pitfall 8) -- persist `botPermissionMode` in SessionInfo JSON
- Approval button overcrowding (Pitfall 13) -- separate mode selection to /mode command or 2-tap flow

**Files changed:** `approval-manager.ts`, `bot.ts`, `formatter.ts`, `hooks/server.ts`, `types/sessions.ts`, `session-store.ts`, `types/config.ts`, `config.ts`, `index.ts`

### Phase 3: /clear Topic Reuse

**Rationale:** Smaller scope than subagent visibility but requires careful coordination between SessionEnd and SessionStart handlers. Benefits from the stable wiring layer established in Phases 1-2. The "clearing" state pattern is well-understood from the resume detection code already in the codebase.

**Delivers:** /clear reuses the existing topic with a visual separator, new pinned status message, and reset counters. Also handles `source === 'compact'` with a lighter separator. Context percentage reset on clear.

**Features addressed:** /clear topic reuse (F-03)

**Pitfalls to address:**
- /clear double-processing (Pitfall 5) -- "clearing" intermediate state, coordinated SessionEnd+SessionStart
- Session ID instability across /clear (Pitfall 11) -- match by cwd + "clearing" status, not session_id
- Pin race conditions (Pitfall 7) -- sequential unpin-then-pin, or unpinAllForumTopicMessages
- Context percentage not resetting (Pitfall 15) -- force-reset to 0 on clear detection

**Files changed:** `hooks/handlers.ts`, `session-store.ts`, `status-message.ts`, `types/hooks.ts`, `types/sessions.ts`, `topics.ts`, `index.ts`

### Phase 4: Subagent Visibility

**Rationale:** Most complex feature, most uncertain (hook behavior for subagent tool calls needs runtime verification), and least critical for day-to-day usage. Benefits from all prior phases being stable. The compact format from Phase 1 enables agent-type prefix labeling.

**Delivers:** SubagentStart/SubagentStop lifecycle messages with agent type labels (e.g., "[Explore] Started", "[Explore] Finished: summary"). Active subagent count in status message. Tool calls prefixed with agent type when a single subagent is active (temporal inference).

**Features addressed:** Subagent visibility (F-06)

**Pitfalls to address:**
- Missing SubagentStart/SubagentStop hooks in installHooks (Pitfall 6) -- add hook registration first
- Subagent transcript path access failures (Pitfall 10) -- use `last_assistant_message` as primary, transcript as optional
- Nested subagent message flood (Pitfall 14) -- show only top-level agents, aggregate nested ones
- Tool call attribution limitation -- accept that PostToolUse cannot identify which agent made the call

**Files changed:** `types/hooks.ts`, `hooks/server.ts`, `hooks/handlers.ts`, `formatter.ts`, `transcript-watcher.ts`, `utils/install-hooks.ts`, `status-message.ts`, `index.ts`

### Phase Ordering Rationale

- **Phase 1 before Phase 2:** Compact format establishes the ContentStore and callback_data patterns. Permission mode buttons use the same InlineKeyboard callback pattern. Building the pattern once in Phase 1 means Phase 2 reuses it.
- **Phase 1 before Phase 4:** Subagent labeling prepends `[AgentType]` to compact tool one-liners. Without compact format, there is nothing clean to prepend to.
- **Phase 2 before Phase 3:** Infinite timeout (Phase 2 prerequisite) should be live before /clear reuse. A /clear during a pending approval with a 5-minute timeout creates confusing state.
- **Phase 3 before Phase 4:** /clear handling modifies the SessionEnd/SessionStart flow. Subagent hooks add to the same handlers. Doing /clear first keeps the handler changes isolated and testable.
- **Phase 4 last:** Highest uncertainty. SubagentStart/SubagentStop hooks are documented but the exact runtime behavior (especially PostToolUse firing for subagent tools) needs verification at implementation time. Shipping this last means the rest of v3.0 is stable if subagent visibility needs iteration.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Subagent Visibility):** The interaction between SubagentStart/SubagentStop hooks and PostToolUse hooks for subagent tool calls is not fully verified. GitHub issues #16126, #14859, #7881 document limitations. Runtime testing is required to confirm whether subagent PostToolUse hooks fire at all and whether temporal correlation works for single-subagent attribution. Recommend `/gsd:research-phase` before implementation.

Phases with standard patterns (skip additional research):
- **Phase 1 (Compact Output):** Well-documented grammY InlineKeyboard + editMessageText + callbackQuery pattern. Already proven in the existing approval button flow.
- **Phase 2 (Permission Modes):** Straightforward state machine in ApprovalManager. Claude Code's permission classification is documented. Safe tool list is defined.
- **Phase 3 (/clear Topic Reuse):** Follows the exact same pattern as resume detection already implemented in handleSessionStart. SessionStart `source` field is documented.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new dependencies. All Telegram API methods verified against official docs. grammY version compatibility confirmed. |
| Features | HIGH | Feature set is well-scoped. Dependency chains are clear. Anti-features identified. Competitive analysis shows clear differentiators. |
| Architecture | HIGH | Existing codebase fully analyzed. Integration points mapped per component. Data flow changes documented with code examples. Build order derived from dependency graph. |
| Pitfalls | HIGH | 15 pitfalls identified with prevention strategies and phase mapping. Recovery strategies documented. "Looks done but isn't" checklist provided. |

**Overall confidence:** HIGH

### Gaps to Address

- **Subagent PostToolUse attribution:** Cannot determine from hooks alone which agent made a tool call. PostToolUse payloads do not contain `agent_id`. Temporal correlation (single active subagent = attribute tool calls to it) is a heuristic, not a guarantee. Validate at implementation time by running Claude Code with subagents and inspecting actual hook payloads.

- **SessionEnd `reason` field for /clear:** The hooks documentation shows `reason` exists on SessionEnd, but the current codebase `SessionEndPayload` type may not include it. Verify the actual payload content by triggering /clear and logging the raw HTTP body.

- **"Until Done" mode reset trigger:** "Until Done" should reset after the agent's current agentic turn ends. The exact hook event that signals "turn complete" (is it a SessionEnd? a specific Notification? the absence of PreToolUse for N seconds?) needs clarification during Phase 2 planning.

- **Compaction handling:** `source === 'compact'` follows the same pattern as /clear but is less documented. Should be handled alongside /clear in Phase 3 but may need runtime verification of the hook payload.

## Sources

### Primary (HIGH confidence)
- [Telegram Bot API](https://core.telegram.org/bots/api) -- callback_data 64-byte limit, editMessageText, message limits, pinning/unpinning
- [Telegram API limits](https://limits.tginfo.me/en) -- rate limits for edit operations
- [grammY Documentation](https://grammy.dev/) -- InlineKeyboard, callback queries, editMessageText, scaling/flood limits
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- SubagentStart/SubagentStop schemas, SessionStart source, SessionEnd reason, PreToolUse decision control
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions) -- permission modes, tool type classification
- [Claude Code Subagents Documentation](https://code.claude.com/docs/en/sub-agents) -- subagent types, transcript storage, lifecycle
- Existing codebase analysis (`/home/cryptobot/workspace/claude-o-gram/src/`) -- all integration points verified against actual code

### Secondary (MEDIUM confidence)
- [GitHub Issue #16126](https://github.com/anthropics/claude-code/issues/16126) -- agent identity NOT available in PreToolUse hooks (closed NOT PLANNED)
- [GitHub Issue #14859](https://github.com/anthropics/claude-code/issues/14859) -- agent hierarchy in hook events (open)
- [GitHub Issue #7881](https://github.com/anthropics/claude-code/issues/7881) -- SubagentStop shared session_id limitation
- [GitHub Issue #13765](https://github.com/anthropics/claude-code/issues/13765) -- context tracking not resetting on /clear
- [GitHub Issue #21481](https://github.com/anthropics/claude-code/issues/21481) -- agent context fields request
- [Enhanced callback_data patterns](https://seroperson.me/2025/02/05/enhanced-telegram-callback-data/) -- community pattern for 64-byte workaround
- [Telegram bot inline buttons with large data](https://medium.com/@knock.nevis/telegram-bot-inline-buttons-with-large-data-950e818c1272) -- server-side lookup pattern

---
*Research completed: 2026-03-01*
*Ready for roadmap: yes*
