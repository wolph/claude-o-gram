# Stack Research: v3.0 UX Overhaul

**Domain:** Telegram bot UX features -- compact output, permission modes, subagent visibility, topic reuse
**Researched:** 2026-03-01
**Confidence:** HIGH (existing stack, Telegram API capabilities verified against official docs)

## Scope

This research covers ONLY the stack additions and changes needed for v3.0 features. The existing validated stack (grammY, Fastify, JSONL transcript watching, SDK query({ resume }), InlineKeyboard, message batching, debounced status edits) is not re-researched.

## Key Finding: No New Dependencies Needed

All four v3.0 features can be implemented with the existing dependency set. The work is purely application-level: new formatting logic, additional Telegram API method calls already available in grammY, expanded hook endpoints, and state management patterns built on the existing in-memory Map + JSON persistence model.

---

## Feature 1: Compact Tool Output with Expand/Collapse Buttons

### What's Needed

Transform the current verbose tool call format into `ToolName(args...)` one-liners with a 250-char limit and an inline "Expand" button that toggles to show full details.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Compact one-liner formatting | `formatToolUse()` in formatter.ts already has tiered verbosity | Current format includes emoji + bold + code blocks, not `Tool(args...)` | Rewrite formatter to produce compact format |
| Expand/collapse buttons | `InlineKeyboard` in grammY, `bot.callbackQuery()` handler pattern | No expand/collapse pattern exists | New callback_data pattern + message editing |
| Store full content for expand | Nothing in-memory for message content | Need to store original full content keyed by message | In-memory Map with TTL cleanup |
| Edit message on button tap | `editMessageText` used by approval flow and `StatusMessage` | Works, pattern is proven | Reuse same pattern |

### Telegram API Constraints (verified)

- **callback_data limit: 1-64 bytes UTF-8.** Current approval buttons use `approve:{toolUseId}` (44 bytes). For expand/collapse, `expand:{messageId}` is sufficient. Message IDs are integers (typically 5-8 digits), so `expand:12345678` = 16 bytes, well within limit.
- **editMessageText** returns the edited Message object (not for inline messages). Can update both text and reply_markup in a single call. Returns error if text is identical ("message is not modified") -- already handled in TopicManager.editMessage().
- **editMessageReplyMarkup** can swap an InlineKeyboard independently of text. Available in grammY as `ctx.editMessageReplyMarkup()` or `bot.api.editMessageReplyMarkup()`.
- **4096 char message limit** applies to expanded content. Long tool outputs already use file attachments; expanded view should do the same truncation.
- **Rate limit on edits: shared bucket** for editMessageText and editMessageCaption. The existing 3-second debounce on StatusMessage is sufficient protection.

### Implementation Pattern (No New Libraries)

```typescript
// callback_data format: "expand:{threadId}:{msgId}" or "collapse:{threadId}:{msgId}"
// Both fit comfortably within 64-byte limit

// Store expanded content in-memory with auto-cleanup
const expandableContent = new Map<string, {
  compact: string;
  expanded: string;
  timestamp: number;
}>();

// grammY callback query handler (same pattern as approval buttons)
bot.callbackQuery(/^expand:(\d+):(\d+)$/, async (ctx) => {
  const key = `${ctx.match[1]}:${ctx.match[2]}`;
  const content = expandableContent.get(key);
  if (content) {
    await ctx.editMessageText(content.expanded, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('Collapse', `collapse:${key}`),
    });
  }
  await ctx.answerCallbackQuery();
});
```

### What NOT to Add

- **No database** for storing expanded content. In-memory Map with TTL (10-15 minute cleanup) is sufficient -- expanded content is ephemeral, and if the bot restarts the "Expand" button gracefully shows "Content no longer available."
- **No @grammyjs/conversations plugin.** The expand/collapse is a simple stateless toggle, not a multi-step conversation flow.
- **No @grammyjs/menu plugin.** The built-in InlineKeyboard is simpler and already used for approvals. The menu plugin adds complexity for dynamic menus we do not need.

---

## Feature 2: Permission Modes (Accept All, Same Tool, Safe Only, Until Done)

### What's Needed

Replace the binary approve/deny flow with configurable auto-acceptance modes that persist per-session.

### Permission Mode Definitions

| Mode | Behavior | Implementation |
|------|----------|----------------|
| **Ask** (default) | Current behavior: show button, wait for decision | No change needed |
| **Accept All** | Auto-allow everything until mode changes | Return `permissionDecision: "allow"` in PreToolUse handler without sending Telegram message |
| **Safe Only** | Auto-allow read-only tools (Read, Glob, Grep), ask for others | Check tool name against safe set before deciding to prompt |
| **Same Tool** | After approving a tool once, auto-allow same tool_name for rest of session | Track approved tool names per session in a Set |
| **Until Done** | Auto-allow everything for remainder of session (no way back except session end) | Same as Accept All but cannot be changed back |

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Per-session mode storage | `SessionInfo` has `permissionMode` field already | Field stores CLI mode, not bot mode | Add new `approvalMode` field to SessionInfo |
| Mode switching command | `/verbose`, `/normal`, `/quiet` command pattern | No permission mode commands | Add `/approve` command with mode argument |
| Mode buttons | InlineKeyboard for approve/deny | Need mode selector keyboard | New InlineKeyboard with mode options |
| Tool classification | `classifyRisk()` in formatter.ts | Classifies for display, not for auto-approval decisions | New `isToolSafe()` function based on Claude Code's own read-only classification |
| Same-tool tracking | Nothing | Need per-session approved tool set | Add `approvedTools: Set<string>` to session state |

### Claude Code's Permission Classification (verified from official docs)

| Tool Type | Tools | Approval Required |
|-----------|-------|-------------------|
| Read-only (safe) | Read, Glob, Grep, WebSearch, WebFetch | No |
| File modification | Write, Edit, MultiEdit, NotebookEdit | Yes (until session end) |
| Bash commands | Bash, BashBackground | Yes (permanently per project+command) |
| Subagent | Agent | Depends on subagent permissions |

The bot should mirror this classification for "Safe Only" mode:
- **Auto-allow:** Read, Glob, Grep, WebSearch, WebFetch
- **Still ask:** Bash, BashBackground, Write, Edit, MultiEdit, NotebookEdit, Agent, and any unknown/MCP tools

### Implementation Pattern (No New Libraries)

The decision logic goes into the PreToolUse HTTP handler in `server.ts`, before sending the Telegram message. The existing `ApprovalManager.waitForDecision()` is only called when the mode requires user interaction.

```typescript
// New type in types/sessions.ts
type ApprovalMode = 'ask' | 'accept-all' | 'safe-only' | 'same-tool' | 'until-done';

// Decision logic in PreToolUse handler
function shouldAutoApprove(
  mode: ApprovalMode,
  toolName: string,
  approvedTools: Set<string>,
): boolean {
  switch (mode) {
    case 'accept-all':
    case 'until-done':
      return true;
    case 'safe-only':
      return SAFE_TOOLS.has(toolName);
    case 'same-tool':
      return approvedTools.has(toolName);
    case 'ask':
    default:
      return false;
  }
}
```

### What NOT to Add

- **No PermissionRequest hook.** The existing PreToolUse hook provides everything needed. PermissionRequest is a separate hook that fires when Claude Code's own permission dialog appears -- our bot intercepts at the PreToolUse level, which is earlier and gives us full control.
- **No persistent mode storage beyond session lifetime.** Permission modes reset when sessions end. This matches Claude Code's own behavior where `acceptEdits` mode is session-scoped.
- **No AUTO_APPROVE env var changes.** The existing `AUTO_APPROVE=true` config is a global override. The new modes are per-session, user-selectable, and more granular.

---

## Feature 3: Subagent Visibility

### What's Needed

Show when subagents start/stop, what type they are, and their tool calls, with clear visual labeling distinguishing main agent vs subagent activity.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Detect subagent start | No SubagentStart hook endpoint | Need new HTTP endpoint | Add `/hooks/subagent-start` to Fastify server |
| Detect subagent stop | No SubagentStop hook endpoint | Need new HTTP endpoint | Add `/hooks/subagent-stop` to Fastify server |
| Track active subagents | SessionStore tracks sessions, not subagents | Need subagent tracking per session | Add `activeSubagents: Map<string, SubagentInfo>` to session state |
| Identify which agent made a tool call | Hooks do NOT include agent_id in PreToolUse/PostToolUse | **Cannot determine from hooks alone** | Parse transcript JSONL for `isSidechain` field |
| Display agent identity in messages | Formatter has no agent context | Need agent label in formatted output | Add optional `agentLabel` parameter to format functions |

### Critical Finding: Hook Limitations for Agent Identity

**The PreToolUse and PostToolUse hooks do NOT include `agent_id`, `agent_type`, or any field identifying which agent made the tool call.** This was confirmed by reviewing:
- Official hooks documentation (common input fields: session_id, transcript_path, cwd, permission_mode, hook_event_name only)
- GitHub issue #16126 requesting agent identity in PreToolUse (CLOSED as NOT PLANNED)
- GitHub issue #21481 requesting agent context fields (CLOSED as COMPLETED, but not visible in current common hook input schema)

**Consequence:** We cannot reliably label individual PostToolUse messages with their originating agent purely from hook data. Two approaches exist:

#### Approach A: SubagentStart/Stop Hooks + Heuristic (RECOMMENDED)

Use SubagentStart and SubagentStop hooks to track active subagent windows. When a subagent is active and a PostToolUse arrives, it *might* be from that subagent, but there is no guarantee (the main agent can also make tool calls while subagents run).

**Advantages:** Simple, no extra parsing, gives start/stop lifecycle messages.
**Limitations:** Cannot definitively attribute individual tool calls to subagents. Acceptable for v3.0 -- the goal is "see what subagents are doing" not "perfectly attribute every call."

SubagentStart hook payload (verified):
```json
{
  "session_id": "abc123",
  "hook_event_name": "SubagentStart",
  "agent_id": "agent-abc123",
  "agent_type": "Explore"
}
```

SubagentStop hook payload (verified):
```json
{
  "session_id": "abc123",
  "hook_event_name": "SubagentStop",
  "agent_id": "def456",
  "agent_type": "Explore",
  "agent_transcript_path": "~/.claude/projects/.../subagents/agent-def456.jsonl",
  "last_assistant_message": "Analysis complete..."
}
```

#### Approach B: Transcript Parsing for Sidechain Attribution

The existing `TranscriptWatcher` already reads JSONL entries and has access to the `isSidechain` field. Currently it filters OUT sidechain entries (`if (entry.isSidechain) return;`). This could be changed to process sidechain entries separately and emit them with an agent label.

**Advantages:** More accurate attribution.
**Limitations:** Transcript entries do not reliably include the agent_id or agent_type. The `isSidechain: true` flag tells you it is a subagent, but not which one. Would need to correlate with SubagentStart timing.

#### Recommended Hybrid Approach

1. Add SubagentStart/SubagentStop HTTP hook endpoints to Fastify
2. Track active subagents per session (agent_id, agent_type, start time)
3. Post lifecycle messages: "Subagent Explore started", "Subagent Explore finished: {last_assistant_message summary}"
4. In TranscriptWatcher, process `isSidechain: true` entries and emit them as subagent messages (currently skipped)
5. Label subagent messages with a visual prefix like `[Explore]` in the Telegram output

### Hook Installation Changes

The `installHooks()` function in `utils/install-hooks.ts` needs two new entries:

```typescript
SubagentStart: [
  {
    matcher: '',
    hooks: [
      { type: 'http', url: `${baseUrl}/hooks/subagent-start`, timeout: 10 },
    ],
  },
],
SubagentStop: [
  {
    matcher: '',
    hooks: [
      { type: 'http', url: `${baseUrl}/hooks/subagent-stop`, timeout: 10 },
    ],
  },
],
```

### New Types Needed

```typescript
// In types/hooks.ts
interface SubagentStartPayload extends HookPayload {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;  // 'Bash' | 'Explore' | 'Plan' | custom agent names
}

interface SubagentStopPayload extends HookPayload {
  hook_event_name: 'SubagentStop';
  agent_id: string;
  agent_type: string;
  agent_transcript_path: string;
  last_assistant_message: string;
  stop_hook_active: boolean;
}

// In types/sessions.ts or new file
interface SubagentInfo {
  agentId: string;
  agentType: string;
  startedAt: string;
}
```

### What NOT to Add

- **No separate transcript watcher per subagent.** The SubagentStop hook includes `last_assistant_message` which provides the summary. Reading `agent_transcript_path` JSONL files for every subagent would be expensive and complex.
- **No WebSocket or streaming connection to Claude Code.** The hook-based architecture is sufficient for lifecycle events.
- **No SDK `canUseTool` callback.** This was explicitly deferred to v2.1 and is out of scope for v3.0.

---

## Feature 4: /clear Topic Reuse with New Pinned Status

### What's Needed

When the user runs `/clear` in Claude Code, reuse the existing Telegram topic instead of closing it and creating a new one. Post a visual separator and re-pin a fresh status message.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Detect /clear event | SessionStart hook with `source: "clear"` | Currently treated as new session creation | Add special handling for `source === "clear"` |
| Send separator message | `TopicManager.sendMessage()` | No separator format | New formatter function for clear separator |
| Unpin old status | `bot.api.unpinChatMessage()` available in grammY | Not currently used | Add `unpinMessage()` to TopicManager |
| Pin new status | `StatusMessage.initialize()` creates + pins | Assumes fresh topic | Call initialize() on existing topic's threadId |
| Reset session counters | SessionStore tracks toolCallCount, filesChanged | No reset method | Add `resetSession()` method to SessionStore |

### Telegram API Methods Needed (already in grammY)

- `unpinChatMessage(chatId, { message_id })` -- unpin the old status message
- `unpinAllChatMessages(chatId)` -- alternative: clear all pins in topic (simpler but more aggressive)
- The existing `sendMessage` + `pinChatMessage` flow for the new status message

### SessionStart Source Detection

The SessionStart hook payload already includes `source: "clear"`. The existing `handleSessionStart()` only checks for `source === "resume"`. Adding `source === "clear"` handling follows the same pattern:

```typescript
if (payload.source === 'clear') {
  const existing = this.sessionStore.getActiveByCwd(payload.cwd);
  if (existing) {
    // Reuse topic: post separator, reset counters, new status message
    // Do NOT create new topic or close existing one
  }
}
```

### What NOT to Add

- **No topic deletion/recreation.** The entire point is reusing the existing topic.
- **No message history clearing.** Telegram does not support bulk message deletion in topics by bots. The separator message visually delineates the old vs new context.

---

## Recommended Stack (Unchanged Core + Application Changes)

### Core Technologies (No Changes)

| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| grammy | ^1.40.1 | Telegram bot framework | KEEP -- provides all needed API methods |
| @grammyjs/auto-retry | ^2.0.2 | Rate limit handling | KEEP |
| @grammyjs/transformer-throttler | ^1.2.1 | API request throttling | KEEP |
| fastify | ^5.7.4 | HTTP hook server | KEEP -- add 2 new endpoints |
| @anthropic-ai/claude-agent-sdk | ^0.2.63 | SDK input delivery | KEEP |
| typescript | ^5.9.3 | Language | KEEP |

### Supporting Libraries (No Changes)

| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| dotenv | ^17.3.1 | Environment config | KEEP |
| pino | ^10.3.1 | Structured logging | KEEP |
| zod | ^4.3.6 | Schema validation | KEEP (not currently used but available) |

### What NOT to Add

| Avoid | Why | What to Do Instead |
|-------|-----|-------------------|
| Redis / SQLite / any database | Expandable content and subagent state are ephemeral, session-scoped | In-memory Maps with TTL cleanup |
| @grammyjs/menu | Over-engineered for simple expand/collapse and mode-select keyboards | Built-in InlineKeyboard class |
| @grammyjs/conversations | No multi-step conversation flows needed | Direct callback query handlers |
| @grammyjs/hydrate | Adds method shortcuts to message objects; not needed for our patterns | Direct `bot.api.*` calls |
| @grammyjs/stateless-question | Text input already works via the existing message handler | Keep existing text handler |
| Any state management library | Session state is simple enough for plain Maps + JSON persistence | SessionStore pattern |
| WebSocket libraries | Hook architecture is sufficient; no need for persistent connections | HTTP hooks |

---

## Installation Commands

```bash
# No new packages to install. Existing dependencies cover all v3.0 features.
# Verify current versions are up to date:
npm outdated
```

---

## Application-Level Changes Summary

### New Files Needed

| File | Purpose |
|------|---------|
| `src/types/approval.ts` | ApprovalMode type, SubagentInfo interface, safe tool set |

No new library-level dependencies required.

### Modified Files

| File | Changes |
|------|---------|
| `src/types/hooks.ts` | Add SubagentStartPayload, SubagentStopPayload |
| `src/types/sessions.ts` | Add `approvalMode`, `approvedTools`, `activeSubagents` fields |
| `src/types/config.ts` | Add `defaultApprovalMode` config option |
| `src/bot/formatter.ts` | Rewrite tool format to compact one-liner; add expand content generation; add subagent labels |
| `src/bot/bot.ts` | Add expand/collapse callback query handlers; add `/approve` command handler |
| `src/hooks/handlers.ts` | Add handleSubagentStart/Stop; modify handleSessionStart for /clear source |
| `src/hooks/server.ts` | Add `/hooks/subagent-start` and `/hooks/subagent-stop` endpoints |
| `src/control/approval-manager.ts` | Add approval mode logic to bypass waitForDecision when auto-approving |
| `src/monitoring/transcript-watcher.ts` | Process `isSidechain: true` entries instead of skipping them |
| `src/monitoring/status-message.ts` | Add permission mode display to status message |
| `src/utils/install-hooks.ts` | Add SubagentStart and SubagentStop hook installation |
| `src/index.ts` | Wire new handlers; add expandable content store; add subagent tracking |
| `src/sessions/session-store.ts` | Add resetSession(), approval mode methods |
| `src/config.ts` | Parse DEFAULT_APPROVAL_MODE env var |
| `src/bot/topics.ts` | Add `unpinMessage()` method for /clear flow |

### New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEFAULT_APPROVAL_MODE` | `ask` | Default permission mode for new sessions |

### Changed Environment Variable Defaults

| Variable | Old Default | New Default | Reason |
|----------|-------------|-------------|--------|
| `APPROVAL_TIMEOUT_MS` | `300000` (5 min) | `0` (infinite) | v3.0 requirement: "No permission timeout -- wait forever" |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| grammy@^1.40.1 | @grammyjs/auto-retry@^2.0.2, @grammyjs/transformer-throttler@^1.2.1 | All grammY ecosystem packages maintain backward compat within major versions |
| grammy@^1.40.1 | Telegram Bot API 9.x | grammY 1.x supports all current Bot API features including editMessageReplyMarkup, unpinChatMessage |
| fastify@^5.7.4 | Node.js >=20.0.0 | Matches project engines requirement |
| typescript@^5.9.3 | All project dependencies | ESM-first, all deps provide TS types |

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| No new dependencies needed | HIGH | Verified all required Telegram API methods exist in grammY; all patterns are variations of existing code |
| Expand/collapse buttons | HIGH | Verified callback_data limits (64 bytes), editMessageText behavior, InlineKeyboard patterns -- all work |
| Permission modes | HIGH | PreToolUse hook provides full control; tool classification verified against Claude Code official docs |
| Subagent visibility | MEDIUM | SubagentStart/SubagentStop hooks verified and well-documented; agent attribution for individual tool calls is LIMITED by hook design -- agent_id is not included in PostToolUse payloads |
| /clear topic reuse | HIGH | SessionStart `source: "clear"` verified in hooks docs; topic reuse is straightforward Telegram API |
| Infinite approval timeout | HIGH | Change default from 300000 to 0 and adjust timeout logic to treat 0 as "no timeout" |

## Sources

- [Telegram Bot API official documentation](https://core.telegram.org/bots/api) -- callback_data 1-64 byte limit, editMessageText, message limits
- [Telegram API limits](https://limits.tginfo.me/en) -- rate limits for edit operations
- [grammY InlineKeyboard plugin docs](https://grammy.dev/plugins/keyboard) -- keyboard builder API, callback query handling
- [grammY API reference](https://grammy.dev/ref/core/api) -- editMessageText, editMessageReplyMarkup return types
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks) -- SubagentStart/SubagentStop schemas, common input fields, PreToolUse decision control
- [Claude Code Permissions documentation](https://code.claude.com/docs/en/permissions) -- permission modes (default, acceptEdits, plan, dontAsk, bypassPermissions), tool type classification
- [GitHub issue #16126](https://github.com/anthropics/claude-code/issues/16126) -- agent identity NOT available in PreToolUse hooks (closed as NOT PLANNED)
- [GitHub issue #21481](https://github.com/anthropics/claude-code/issues/21481) -- agent context fields request (closed as COMPLETED but not in current common hook input)
- [GitHub issue #7881](https://github.com/anthropics/claude-code/issues/7881) -- SubagentStop shared session_id limitation
- [GitHub issue #13326](https://github.com/anthropics/claude-code/issues/13326) -- sidechain transcript format, isSidechain field behavior

---
*Stack research for: Claude Code Telegram Bridge v3.0 UX Overhaul*
*Researched: 2026-03-01*
