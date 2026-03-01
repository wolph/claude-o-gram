# Feature Research: v3.0 UX Overhaul

**Domain:** Telegram bot UX for Claude Code monitoring and control
**Researched:** 2026-03-01
**Confidence:** HIGH (codebase analysis + official Telegram Bot API + Claude Code hooks reference)

## Feature Landscape

This research covers the six target features for v3.0, analyzing what's table stakes for a usable remote dev tool, what's genuinely differentiating, and what to avoid.

### Table Stakes (Users Expect These)

Features that make the bot usable as a remote terminal replacement. Without these, the v3.0 goal of "terminal-fidelity output" fails.

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|-------------|
| **Compact tool output** | Terminal shows `Read(file)` not multi-line blocks. Current bot is noisier than terminal. | MEDIUM | Existing `formatter.ts`, `verbosity.ts` |
| **Remove bot commentary** | Terminal has no "Bot restarted" emoji spam or narration filtering. Clean output = trust. | LOW | Existing `isProceduralNarration()` in `text.ts`, `formatSessionStart()` in `formatter.ts` |
| **No permission timeout** | Current 5-min auto-deny is hostile for remote users who may be away. Terminal waits forever. | LOW | `ApprovalManager` constructor takes `timeoutMs`. Set to `Infinity` or remove timer. |
| **/clear reuses topic** | Without this, /clear creates a new topic (via SessionStart source="clear"), cluttering the group with dead topics. | MEDIUM | `handleSessionStart()` in `handlers.ts` already handles `source` field. Need to detect `source === 'clear'` and reuse existing topic. |

### Differentiators (Competitive Advantage)

Features that make the Telegram bridge genuinely *better* than the terminal for remote work.

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|-------------|
| **Expand/collapse inline buttons** | Terminal can't do this at all. Telegram users tap to see full content on demand, reducing noise while preserving detail access. | MEDIUM | Telegram `editMessageText` + `InlineKeyboard` callback queries. Existing pattern in approval buttons. |
| **Permission modes (Accept All, Same Tool, Safe Only, Until Done)** | Terminal has fixed permission modes (default/acceptEdits/dontAsk). Telegram can offer *session-scoped* graduated modes that are more nuanced than binary approve/deny. | HIGH | New `PermissionModeManager` class. Modifies `onPreToolUse` callback. Interacts with existing `ApprovalManager`. |
| **Subagent visibility with agent identity** | Terminal shows subagent activity inline but without clear hierarchy. Telegram can visually separate and label subagent work with indentation/prefixes. | HIGH | New `SubagentStart`/`SubagentStop` hook handlers. New hook types in `hooks.ts`. Agent tracking state in session store. |
| **Local permission visibility (stdout)** | When a permission is auto-accepted by a mode, the terminal user sees nothing. Printing to stdout gives local dev confirmation that permissions are being handled remotely. | LOW | `console.log()` in PreToolUse handler when auto-accepting. No Telegram API needed. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Streaming tool output** (real-time character-by-character) | "I want to see bash output as it runs" | Telegram rate limits (20 msg/min group, editMessageText has stricter limits). Would require constant message edits, hitting 429s. Current 3-second debounce on status message is already aggressive. | Post final output after tool completes. Use expand/collapse for long outputs. Status message shows "Running: Bash" during execution. |
| **Per-subagent Telegram topics** | "Each subagent should get its own thread" | Subagents are ephemeral (seconds to minutes). Creating/closing topics per subagent would create massive topic clutter. Telegram group would become unusable. | Label subagent messages with agent identity prefix within the session topic. Use indentation or icon prefixes. |
| **Nested inline keyboards for deep navigation** | "Click to expand, then click sub-items" | Telegram callback_data is limited to 64 bytes. Deep state trees require server-side lookup tables and become fragile. Message edits have API rate limits. | Single-level expand/collapse only. One tap = toggle full content. No nested drilling. |
| **Approval from multiple users** | "Team should vote on dangerous operations" | This is a single-user system (one bot owner per machine). Multi-user auth adds complexity for no value. | Single user approves/denies. If team visibility is needed, they can read the topic. |
| **Custom permission rules per tool** | "Auto-accept Read but always ask for Bash" | Claude Code already has its own permission system (`permission_mode`, allowlists in settings.json). Duplicating it in the bot creates conflicts and confusion. | Use Claude Code's native permission modes. Bot's permission modes layer on top as session-scoped overrides. |

## Feature Dependencies

```
Compact tool output
    +-- (enables) --> Expand/collapse buttons
                         +-- (uses same pattern) --> Subagent message formatting

/clear topic reuse
    +-- (independent, no deps)

Permission modes
    +-- (requires) --> No permission timeout (infinite wait)
    +-- (enhances) --> Local stdout visibility

Subagent visibility
    +-- (requires) --> New hook types (SubagentStart, SubagentStop)
    +-- (requires) --> Agent tracking state in SessionInfo
    +-- (enhances) --> Status message (show active subagent count)
    +-- (enhances) --> Compact tool output (prefix with agent identity)
```

### Dependency Notes

- **Expand/collapse requires compact output:** The expand button only makes sense when tool output is initially compact. Build compact format first, then add the expand button.
- **Permission modes require infinite timeout:** If auto-accept modes exist, the timeout is irrelevant for accepted tools but must be infinite for tools that still need manual approval (so remote users aren't punished).
- **Subagent visibility requires new hook types:** The existing codebase only handles `SessionStart`, `SessionEnd`, `PostToolUse`, `PreToolUse`, and `Notification`. SubagentStart and SubagentStop are separate hook events with distinct payloads (`agent_id`, `agent_type`).
- **Subagent visibility enhances compact output:** Once subagent identity is tracked, tool call messages can be prefixed with the agent name (e.g., `[Explore] Read src/...`).

## Detailed Feature Analysis

### F-01: Compact Tool Output with Expand/Collapse

**What:** Replace current multi-line tool formatting with `Tool(args...)` one-liners capped at 250 chars. Add an "Expand" inline button that edits the message to show full content.

**Current state:** `formatter.ts` already has tiered formatting -- reads are one-liners, edits show diffs, bash shows command + output. But even "compact" read lines include emoji prefixes and HTML wrapping. The v3.0 goal is terminal-style: `Read(src/bot/bot.ts)` not `[eye emoji] Read <code>src/bot/bot.ts</code>`.

**Telegram API mechanism:**
- Send message with compact text + `InlineKeyboard` with "Expand" button
- `callback_data`: `"exp:{messageId}"` or `"exp:{toolUseId}"` (must fit 64 bytes)
- On button tap: `editMessageText` with full content, replace button with "Collapse"
- On collapse tap: `editMessageText` back to compact, replace button with "Expand"

**Implementation approach:**
- Store expanded content in a `Map<string, string>` (message ID -> full content) with TTL cleanup
- Compact format: `Tool(arg1, arg2)` -- no emoji, no HTML bold, just monospace
- Only add Expand button when full content exceeds compact limit
- Batched messages: when multiple tool calls batch into one message, each gets its own expand/collapse? No -- batch as compact one-liners, single Expand button shows all full content. Simpler.

**Confidence:** HIGH -- `editMessageText` + `InlineKeyboard` callback pattern is well-established. The existing approval button flow (`bot.callbackQuery(/^approve:(.+)$/, ...)`) proves the pattern works in this codebase.

**Complexity:** MEDIUM
- Reformatting `formatter.ts` is straightforward
- Callback data management needs thought (64-byte limit, cleanup)
- Interaction with MessageBatcher: batched messages need expand state per batch, not per tool call

### F-02: Remove Bot Commentary / Terminal-Fidelity Output

**What:** Strip emoji prefixes, remove "Bot reconnected" fluff, stop filtering "procedural narration." If Claude said it, post it. If a tool ran, post the compact line. Nothing else.

**Current state:**
- `isProceduralNarration()` filters short Claude messages like "Let me read..." -- this filtering hides real Claude output
- `formatSessionStart()` adds emoji prefixes and bold tags
- Session end shows summary with emoji bullets
- Status message uses emoji for every field
- Transcript watcher wraps Claude output in `<b>Claude:</b>\n` prefix

**What to keep:** Status message is pinned and separate from the conversation flow -- emojis there are fine (it's a dashboard, not conversation). Session start/end are lifecycle events, not Claude output -- they can keep minimal formatting.

**What to remove:**
- `isProceduralNarration()` filter -- post everything Claude says
- `<b>Claude:</b>\n` prefix on transcript output -- terminal doesn't label who's talking
- Emoji prefixes on tool call messages
- File attachment "captions" and explanatory text

**Confidence:** HIGH -- this is purely formatting changes, no API or external dependency risk.

**Complexity:** LOW -- mostly removing code, not adding it.

### F-03: /clear Reuses Topic

**What:** When the user runs `/clear` in Claude Code, instead of creating a new topic, post a separator in the existing topic and re-pin a fresh status message.

**Current state:** The `SessionStartPayload` has `source: 'startup' | 'resume' | 'clear' | 'compact'`. The `handleSessionStart()` method only checks for `source === 'resume'` to reuse topics. When `source === 'clear'`, it falls through to new topic creation.

**Implementation approach:**
1. In `handleSessionStart()`, add handling for `source === 'clear'` similar to resume
2. Find existing active session by cwd (same as resume detection)
3. Post a visual separator: `--- /clear ---` or similar
4. Reset session counters (toolCallCount, filesChanged, suppressedCounts)
5. Create new StatusMessage and pin it (old one stays as historical)
6. Keep the same topic, same threadId

**Edge case:** `/clear` generates a new `session_id` but same `cwd`. The existing `getActiveByCwd()` method handles this. Need to re-map session store from old ID to new ID (same pattern as resume).

**Also handle `source === 'compact'`:** Compaction is similar -- same session continues with a new transcript. Should post a brief "Context compacted" notice and update the transcript watcher path. Probably same logic as /clear but lighter separator.

**Confidence:** HIGH -- the hook payload already provides the information needed. The resume-detection pattern in `handleSessionStart()` is the template.

**Complexity:** MEDIUM -- the logic is clear but involves status message lifecycle (destroy old, create new) and session store remapping. Must handle edge case where session doesn't have an active topic (first clear after bot restart).

### F-04: Permission Modes (Accept All, Same Tool, Safe Only, Until Done)

**What:** Replace binary approve/deny with graduated acceptance modes, controllable via Telegram commands or inline buttons.

**Proposed modes:**

| Mode | Behavior | Telegram Command |
|------|----------|-----------------|
| **Ask** (default) | Every tool that needs permission shows approve/deny buttons | `/ask` |
| **Safe Only** | Auto-accept reads, glob, grep. Ask for writes, edits, bash. | `/safeonly` |
| **Same Tool** | After approving a tool once, auto-accept that same tool name for the rest of the session | `/sametool` |
| **Accept All** | Auto-accept everything. Equivalent to Claude Code's `dontAsk` | `/acceptall` |
| **Until Done** | Auto-accept everything until Claude's next Stop event, then revert to previous mode | `/untildone` |

**Implementation approach:**
- New `PermissionModeManager` class with per-session mode state
- Integrates into `onPreToolUse` callback in `index.ts`
- Decision flow: check mode -> if auto-accept, return `allow` immediately -> if not, delegate to existing `ApprovalManager`
- "Same Tool" mode: maintain a `Set<string>` of approved tool names per session
- "Until Done" mode: listen for Stop hook event, revert mode

**Interaction with Claude Code's own permission modes:**
- If `session.permissionMode === 'bypassPermissions'` or `dontAsk`, Claude Code never fires PreToolUse hooks. Bot never sees these tool calls. This is fine -- the bot's modes only apply when Claude Code *does* ask.
- If Claude Code is in `default` mode, the bot's modes provide a *second layer* of control on the Telegram side.

**Risk classification integration:**
- The existing `classifyRisk()` function in `formatter.ts` maps tools to safe/caution/danger
- "Safe Only" mode uses this: auto-accept `safe` risk tools, ask for `caution` and `danger`

**Confidence:** HIGH for the mode logic. MEDIUM for UX -- the interaction between Claude Code's native permission modes and the bot's modes could confuse users. Needs clear documentation.

**Complexity:** HIGH -- new class, new session state, interaction with existing approval flow, command registration, inline keyboard for mode switching.

### F-05: Local Permission Visibility (stdout)

**What:** When a tool approval is auto-accepted by a permission mode, print to the bot's local stdout so the developer at the terminal can see what's happening.

**Current state:** Auto-approve decisions (from `config.autoApprove`) return immediately in `onPreToolUse` with no local output. The developer running the bot process sees nothing.

**Implementation:**
```typescript
console.log(`[${session.topicName}] Auto-accepted: ${payload.tool_name} (mode: ${currentMode})`);
```

**Confidence:** HIGH -- trivially simple.

**Complexity:** LOW -- a few `console.log` statements in the permission mode handler.

### F-06: Subagent Visibility with Agent Identity

**What:** Show subagent starts, stops, and tool calls with agent identity labels. Users should see `[Explore] Read src/...` when a subagent reads a file vs `Read src/...` for the main agent.

**Current state:** The codebase has no SubagentStart/SubagentStop handling. The `HookPayload` base interface has `session_id` but no `agent_id`. The `isSidechain` field in transcript entries is checked during backfill but only to skip them.

**Claude Code hook reality (CRITICAL FINDING):**

Per official hooks reference (code.claude.com/docs/en/hooks):
- `SubagentStart` fires with `agent_id` and `agent_type` (e.g., "Explore", "Plan", "Bash")
- `SubagentStop` fires with `agent_id`, `agent_type`, `agent_transcript_path`, and `last_assistant_message`
- **However:** per GitHub issue #14859 and #7881, tool call hook events (`PreToolUse`, `PostToolUse`) from subagents share the same `session_id` as the parent and do NOT include `agent_id`

This means: **we can detect when subagents start and stop, but we cannot attribute individual tool calls to specific subagents through hooks alone.**

**Workaround options:**
1. **Temporal correlation (MEDIUM confidence):** Track active subagent windows (start time -> stop time) and attribute tool calls to the subagent that was active during that window. Breaks with parallel subagents.
2. **Transcript parsing (HIGH confidence):** SubagentStop provides `agent_transcript_path`. Parse the subagent's JSONL transcript for tool calls. But this is post-hoc, not real-time.
3. **Label only start/stop events (HIGH confidence, recommended):** Post `[Explore] Started: "Search for auth patterns"` and `[Explore] Completed: "Found 3 issues"` messages. Don't try to attribute individual tool calls to subagents. This is honest about what the API provides.

**Recommended approach (Option 3 + enhancement):**
- Add SubagentStart/SubagentStop to the HTTP hook server routes
- Post start/stop messages with agent type labels
- Add active subagent count to status message
- If only one subagent is active, prefix tool calls with its type (temporal inference is safe for single subagent)
- For parallel subagents, don't attempt attribution -- just show the start/stop lifecycle

**Required changes:**
- New hook types: `SubagentStartPayload`, `SubagentStopPayload` in `hooks.ts`
- New Fastify routes in `server.ts`
- New handlers in `handlers.ts`: `handleSubagentStart()`, `handleSubagentStop()`
- New session state: `activeSubagents: Map<string, { type: string, startedAt: string }>`
- Status message update: show subagent count
- Format functions for subagent messages

**Confidence:** MEDIUM -- SubagentStart/SubagentStop hooks exist and have documented payloads. But the inability to attribute tool calls to specific subagents (issue #14859, still open) limits the depth of visibility we can provide. The temporal-correlation workaround for single-subagent scenarios is reasonable.

**Complexity:** HIGH -- new hook types, new state management, new formatting, conditional tool call prefixing, status message updates.

## MVP Definition

### Launch With (v3.0 Phase 1)

Foundation that makes everything else possible:

- [ ] **Compact tool output** -- reformats formatter.ts to terminal-style one-liners. Required before expand/collapse makes sense.
- [ ] **Remove bot commentary** -- strip emoji, remove narration filter, stop labeling Claude's output.
- [ ] **No permission timeout** -- change timeout to infinite. One line change that unblocks remote usage.
- [ ] **/clear topic reuse** -- handle `source === 'clear'` in handleSessionStart. Prevents topic clutter.

### Add After Foundation (v3.0 Phase 2)

Features that depend on the foundation:

- [ ] **Expand/collapse buttons** -- add InlineKeyboard to compact tool messages. Depends on compact format from Phase 1.
- [ ] **Permission modes** -- add mode manager and commands. Depends on infinite timeout from Phase 1.
- [ ] **Local stdout visibility** -- add console.log for auto-accepted permissions. Depends on permission modes from this phase.

### Add After Modes Work (v3.0 Phase 3)

Most complex feature, independent enough to ship last:

- [ ] **Subagent visibility** -- add SubagentStart/SubagentStop handling with agent identity labels. Depends on compact output format for prefix-labeling tool calls.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Phase |
|---------|------------|---------------------|----------|-------|
| Compact tool output | HIGH | MEDIUM | P1 | 1 |
| Remove bot commentary | MEDIUM | LOW | P1 | 1 |
| No permission timeout | HIGH | LOW | P1 | 1 |
| /clear topic reuse | HIGH | MEDIUM | P1 | 1 |
| Expand/collapse | HIGH | MEDIUM | P2 | 2 |
| Permission modes | HIGH | HIGH | P2 | 2 |
| Local stdout visibility | LOW | LOW | P2 | 2 |
| Subagent visibility | MEDIUM | HIGH | P3 | 3 |

**Priority key:**
- P1: Foundation -- must ship first, enables everything else
- P2: Core differentiators -- the features that make v3.0 worth doing
- P3: Advanced -- ships last, most complex, most value-add for power users

## Competitor Feature Analysis

| Feature | Claude Code Terminal | Cursor | Telegram Bot (current) | Telegram Bot (v3.0) |
|---------|---------------------|--------|------------------------|---------------------|
| Compact tool output | Native -- `Tool(args)` one-liners | Similar compact view | Verbose multi-line with emojis | Terminal-matching compact |
| Expand details | Not available (scrollback only) | Hover/click to expand | Not available | Inline expand/collapse buttons |
| Permission modes | 5 fixed modes (CLI flags) | Auto-accept built in | Binary approve/deny with timeout | 5 session-scoped modes controllable from Telegram |
| Subagent visibility | Inline in terminal output | Not applicable | None | Start/stop labels with agent type |
| Remote access | SSH/tmux required | Browser-native | Native Telegram (any device) | Native Telegram (any device) |
| Conversation reset | /clear creates new context | Clear chat | /clear creates new topic (cluttering) | /clear reuses topic with separator |

**Key insight:** The Telegram bot's unique competitive advantage is expand/collapse and graduated permission modes -- features that exploit Telegram's interactive UI (inline keyboards) to provide something the terminal fundamentally cannot. Focus energy there.

## Technical Constraints from Telegram API

These constraints shape implementation decisions across all features:

| Constraint | Limit | Impact |
|-----------|-------|--------|
| `callback_data` size | 64 bytes max | Expand/collapse button data must be compact. Use short prefixes + message ID, not full content hashes. |
| `editMessageText` rate | Unspecified but throttled per chat | Status message already debounces at 3s. Expand/collapse edits are user-initiated (low frequency), safe. |
| Message text length | 4096 chars max | Already handled by `TopicManager.sendMessage()` truncation. Expanded content must respect this. |
| Group message rate | ~20 msgs/min | Already handled by `MessageBatcher`. No change needed for v3.0. |
| Topic name length | 128 chars max | Already handled in `TopicManager`. No change for v3.0. |
| Inline keyboard per message | Up to 100 buttons, 8 per row | We'll use 1-2 buttons per message. Not a concern. |

## Sources

- Official Telegram Bot API: https://core.telegram.org/bots/api
- grammY Inline Keyboard docs: https://grammy.dev/plugins/keyboard
- Claude Code Hooks Reference: https://code.claude.com/docs/en/hooks
- Claude Code Permissions: https://code.claude.com/docs/en/permissions
- GitHub Issue #14859 (Agent hierarchy in hook events): https://github.com/anthropics/claude-code/issues/14859
- GitHub Issue #7881 (SubagentStop identification): https://github.com/anthropics/claude-code/issues/7881
- GitHub Issue #13994 (Per-sub-agent metrics): https://github.com/anthropics/claude-code/issues/13994
- Enhanced callback_data patterns: https://seroperson.me/2025/02/05/enhanced-telegram-callback-data/

---
*Feature research for: Claude Code Telegram Bridge v3.0 UX Overhaul*
*Researched: 2026-03-01*
