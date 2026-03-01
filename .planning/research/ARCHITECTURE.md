# Architecture Research: v3.0 UX Overhaul Integration

**Domain:** Telegram Bot UX features integrating with existing hook/transcript architecture
**Researched:** 2026-03-01
**Confidence:** HIGH (existing codebase fully analyzed, official Claude Code hooks docs verified, Telegram Bot API constraints verified)

## Current Architecture (Baseline)

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Claude Code Process                            │
│  Hooks: SessionStart, SessionEnd, PreToolUse, PostToolUse,            │
│         Notification, SubagentStart, SubagentStop                     │
│  Transcript: ~/.claude/projects/.../session.jsonl                     │
└──────────────┬──────────────────────────────────────┬─────────────────┘
               │ HTTP POST (hook events)              │ JSONL file writes
               ▼                                      ▼
┌──────────────────────────┐         ┌──────────────────────────────────┐
│  Fastify Hook Server     │         │  TranscriptWatcher (per-session) │
│  /hooks/session-start    │         │  fs.watch + byte-position tail   │
│  /hooks/session-end      │         │  Filters: isSidechain === false  │
│  /hooks/post-tool-use    │         │  Emits: onAssistantMessage,      │
│  /hooks/notification     │         │         onUsageUpdate            │
│  /hooks/pre-tool-use     │         └──────────────┬───────────────────┘
│    (BLOCKING)            │                        │
└──────────┬───────────────┘                        │
           │                                        │
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         index.ts Wiring Layer                        │
│  HookCallbacks: onSessionStart, onSessionEnd, onToolUse,             │
│                 onNotification, onPreToolUse, onBackfillSummary       │
│  SessionMonitor: { transcriptWatcher, statusMessage, summaryTimer }  │
│  ApprovalManager: deferred promises keyed by tool_use_id             │
│  InputRouter: tmux | fifo | sdk-resume per session                   │
└──────────┬───────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          Telegram Layer                               │
│  Bot (grammY): callback queries, text input, /commands               │
│  TopicManager: create/close/reopen/rename topics, send messages      │
│  MessageBatcher: debounce tool calls into combined messages          │
│  StatusMessage: pinned msg, edit-in-place with 3s debounce           │
│  Formatter: formatToolUse, formatApprovalRequest, etc.               │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Properties

1. **Hook server is the event source** -- all tool calls and session lifecycle arrive as HTTP POSTs
2. **TranscriptWatcher is the text source** -- Claude's text output comes from tailing JSONL, currently filters `isSidechain === true`
3. **ApprovalManager blocks HTTP responses** -- PreToolUse hook connection stays open until user taps Approve/Deny or timeout
4. **MessageBatcher debounces** -- 2s window, combines messages, respects 4096 char Telegram limit
5. **StatusMessage edits in place** -- pinned per-topic, 3s debounce minimum
6. **SessionStore is the truth** -- in-memory Map with atomic JSON persistence, keyed by sessionId, lookup by threadId

## Feature Integration Analysis

### Feature 1: Compact Tool Output with Expand/Collapse

**Requirement:** Tool calls displayed as `Tool(args...)` with 250-char limit. Inline "Expand" button shows full content.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `formatter.ts` | **MODIFY** | New `formatCompactToolUse()` returning compact one-liner + full content |
| `bot.ts` | **MODIFY** | Add `callbackQuery` handler for `expand:{id}` and `collapse:{id}` |
| `rate-limiter.ts` | **MODIFY** | `enqueue()` must accept optional `InlineKeyboard` for expand button |
| `topics.ts` | **MODIFY** | `sendMessage()` must accept optional `reply_markup` parameter |
| New: `content-store.ts` | **NEW** | In-memory Map storing full tool output keyed by short ID |

**Architecture Pattern: Server-Side Content Store**

Telegram's `callback_data` is limited to 64 bytes. A tool_use_id UUID is 36 chars. With prefix `expand:`, that is 43 bytes -- fits. But the FULL content to show on expand cannot be in callback_data. Solution: store full content server-side, look up on callback.

```typescript
// src/bot/content-store.ts
interface StoredContent {
  compactHtml: string;      // The collapsed one-liner
  expandedHtml: string;     // The full detailed view
  threadId: number;         // For validation
  createdAt: number;        // For TTL cleanup
}

class ContentStore {
  private store = new Map<string, StoredContent>();
  private counter = 0;

  // Short IDs: monotonic counter, base36 = ~4 chars for first 1M entries
  store(content: StoredContent): string {
    const id = (this.counter++).toString(36);
    this.store.set(id, content);
    return id;
  }

  get(id: string): StoredContent | undefined {
    return this.store.get(id);
  }

  // Periodic cleanup: remove entries older than 1 hour
  cleanup(maxAgeMs: number = 3600_000): void { ... }
}
```

**callback_data format:** `x:{id}` for expand (3-7 bytes), `c:{id}` for collapse (3-7 bytes). Well within 64-byte limit.

**Data Flow:**

```
PostToolUse hook arrives
    ↓
HookHandlers.handlePostToolUse() -- unchanged
    ↓
callbacks.onToolUse() in index.ts
    ↓
formatter.formatCompactToolUse(payload) → { compact, expanded }
    ↓
contentStore.store({ compactHtml, expandedHtml, threadId })
    ↓
batcher.enqueue(threadId, compact, { keyboard: expandButton(id) })
    ↓
User taps [Expand ▼]
    ↓
bot.callbackQuery(/^x:(.+)$/) → contentStore.get(id) → editMessageText(expanded, collapseButton)
    ↓
User taps [Collapse ▲]
    ↓
bot.callbackQuery(/^c:(.+)$/) → contentStore.get(id) → editMessageText(compact, expandButton)
```

**Critical Decision: When to show expand button?**

Only when content exceeds 250 chars. Short tool calls (Read, Glob) stay as bare one-liners with no button. This keeps noise low.

**MessageBatcher Change:**

The batcher currently concatenates messages with `\n\n` separators. Messages with inline keyboards CANNOT be batched together (each keyboard is per-message). Two options:

1. **Messages with keyboards bypass batching** -- send immediately via `enqueueImmediate`. This is safe because expand buttons are informational, not time-critical.
2. **Split batch on keyboard boundary** -- flush accumulated non-keyboard messages, then send keyboard message, continue batching.

**Recommendation: Option 1** because it is simpler and the keyboard messages are already lower frequency (only for long tool outputs).

However, this creates a subtlety: if a rapid sequence of tool calls all have expand buttons, they become individual messages instead of batched. This is acceptable because long-output tools (Bash with output, Write with content) are less frequent than short ones (Read, Glob, Grep).

### Feature 2: Permission Modes (Accept All, Same Tool, Safe Only, Until Done)

**Requirement:** Replace binary approve/deny with tiered auto-accept modes. No timeout -- wait forever.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `approval-manager.ts` | **MODIFY** | Add mode state per-session, auto-resolve logic |
| `bot.ts` | **MODIFY** | New callback queries for mode buttons, new /permission command |
| `formatter.ts` | **MODIFY** | Mode selector keyboard on approval messages |
| `hooks/server.ts` | **MODIFY** | Remove timeout for PreToolUse, respect auto-accept |
| `types/sessions.ts` | **MODIFY** | Add `permissionAutoAccept` field to SessionInfo |
| `session-store.ts` | **MODIFY** | Add `updatePermissionMode()` method |
| `types/config.ts` | **MODIFY** | Remove `approvalTimeoutMs`, add default permission mode |

**Architecture Pattern: Per-Session Permission State Machine**

```
                    ┌─────────────────────────┐
                    │  Permission Mode State   │
                    │  (per session in store)   │
                    └────────────┬────────────┘
                                 │
    ┌────────────────┬───────────┼───────────┬──────────────────┐
    ▼                ▼           ▼           ▼                  ▼
 ┌──────┐    ┌───────────┐  ┌────────┐  ┌──────────┐    ┌──────────┐
 │ Ask  │    │ Same Tool │  │ Safe   │  │ All      │    │ Until    │
 │ Each │    │ Auto      │  │ Only   │  │ Auto     │    │ Done     │
 └──────┘    └───────────┘  └────────┘  └──────────┘    └──────────┘
  default     auto-accept    auto-accept  auto-accept    auto-accept
  (prompt)    same tool_name  Read/Glob/   everything     everything
              as last         Grep/safe               until session ends
              approved        tools only
```

**Mode definitions:**

| Mode | Behavior | Auto-Accept Criteria |
|------|----------|---------------------|
| Ask Each | Current behavior | Never auto-accept |
| Same Tool | Auto-accept if tool_name matches a previously approved tool | `approvedTools.has(payload.tool_name)` |
| Safe Only | Auto-accept read-only tools | `SAFE_TOOLS.has(payload.tool_name)` |
| Accept All | Auto-accept everything for this session | Always |
| Until Done | Auto-accept everything until session ends | Always (same as Accept All but named for clarity) |

**Where auto-accept logic lives:**

The PreToolUse handler in `hooks/server.ts` currently checks `config.autoApprove` and `payload.permission_mode`. The new mode logic should live in `ApprovalManager` because:

1. ApprovalManager already owns the per-session approval state
2. The mode is per-session, and ApprovalManager is already keyed by sessionId
3. Keeps the hook server thin (just delegates)

```typescript
// In ApprovalManager
shouldAutoAccept(sessionId: string, toolName: string): boolean {
  const mode = this.sessionModes.get(sessionId);
  if (!mode || mode === 'ask') return false;
  if (mode === 'all' || mode === 'until-done') return true;
  if (mode === 'safe') return SAFE_TOOLS.has(toolName);
  if (mode === 'same-tool') return this.approvedTools.get(sessionId)?.has(toolName) ?? false;
  return false;
}
```

**No Timeout Change:**

Current: `approvalTimeoutMs` defaults to 300000 (5 min). Requirement says "wait forever."

Options:
1. Set timeout to `Infinity` / remove `setTimeout` entirely
2. Set very large timeout (24 hours) as safety net

**Recommendation: Option 2** -- use 24-hour timeout as a safety net against leaked promises. HTTP connections can also time out on the client (Claude Code) side, so "wait forever" really means "wait as long as Claude Code keeps the connection open."

**Keyboard Layout for Approval Messages:**

```
[Approve] [Deny]
[Accept All] [Same Tool] [Safe Only]
```

callback_data: `aa:{toolUseId}`, `st:{toolUseId}`, `so:{toolUseId}` -- all well within 64 bytes.

On "Same Tool" tap: approve this tool AND add tool_name to session's approvedTools set. On "Accept All" tap: approve this tool AND set session mode to 'all'.

**Stdout Visibility (Local Permission):**

The requirement says "Permissions visible locally via stdout." This means when a PreToolUse arrives, ALSO print to the bot process's stdout. This is trivial -- just add `console.log()` in the PreToolUse callback. No architectural change needed.

### Feature 3: Subagent Visibility

**Requirement:** Subagent output visible with agent name/type/status labels.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `transcript-watcher.ts` | **MODIFY** | Stop filtering `isSidechain === true`, instead emit with agent metadata |
| `types/monitoring.ts` | **MODIFY** | Extend TranscriptEntry type with subagent fields |
| `hooks/server.ts` | **MODIFY** | Add routes for SubagentStart, SubagentStop hooks |
| `hooks/handlers.ts` | **MODIFY** | New handlers for SubagentStart/SubagentStop |
| `types/hooks.ts` | **MODIFY** | Add SubagentStartPayload, SubagentStopPayload types |
| `formatter.ts` | **MODIFY** | New formatSubagentStart(), formatSubagentStop() |
| `index.ts` | **MODIFY** | Wire new hook callbacks |
| New: `types/hooks.ts` additions | **MODIFY** | SubagentStartPayload, SubagentStopPayload |

**Two Data Sources for Subagent Visibility:**

1. **SubagentStart/SubagentStop hooks** -- structured events with agent_id, agent_type, agent_transcript_path
2. **TranscriptWatcher with isSidechain entries** -- the actual text output from subagents

**Architecture Decision: Use hooks for lifecycle, transcript for content.**

The SubagentStart hook provides: `agent_id`, `agent_type` (e.g., "Explore", "Plan", "Bash").
The SubagentStop hook provides: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`.

The transcript entries with `isSidechain === true` contain the subagent's tool calls and text output.

**Recommended approach:**

```
SubagentStart hook arrives → Post "Subagent started: [type] [agent_id]" to topic
                           → Track agent_id in session state

Transcript entries with isSidechain === true → Post with "[SubagentType]:" prefix
                                             → Use agent_id to look up type

SubagentStop hook arrives → Post "Subagent finished: [type]" with last_assistant_message summary
                          → Clean up agent tracking
```

**TranscriptWatcher Change:**

Current code at line 203-208 of transcript-watcher.ts:
```typescript
private processEntry(entry: TranscriptEntry): void {
  // Skip subagent messages
  if (entry.isSidechain) return;
```

Change to:
```typescript
private processEntry(entry: TranscriptEntry): void {
  if (entry.isSidechain) {
    // Emit subagent messages through a different callback
    this.onSubagentMessage?.(entry);
    return;
  }
```

**New TranscriptWatcher constructor parameter:**
```typescript
constructor(
  filePath: string,
  onAssistantMessage: (text: string) => void,
  onUsageUpdate: (usage: TokenUsage) => void,
  onSubagentMessage?: (entry: TranscriptEntry) => void,  // NEW
)
```

**Agent ID Correlation Problem:**

The transcript's `isSidechain` entries do NOT contain the `agent_type` field. To label messages with the agent type, we need to correlate:
- SubagentStart hook provides `agent_id` + `agent_type`
- Transcript entries have `sessionId` but this is the parent session ID

The transcript entries for subagents are written to a separate file: `agent_transcript_path` (e.g., `~/.claude/projects/.../abc123/subagents/agent-def456.jsonl`).

**Key Insight:** Subagent transcript entries go to a SEPARATE JSONL file, not the main session transcript. The main transcript only has tool_use entries for the Agent tool itself. The subagent's actual work is in the subagent transcript file.

**Revised approach:**

Option A: Watch subagent transcript files (complex -- need dynamic file watchers)
Option B: Use SubagentStop hook's `last_assistant_message` for summary (simpler, less real-time)
Option C: Parse main transcript's Agent tool_use entries for subagent task context, then show SubagentStop summary

**Recommendation: Option B + SubagentStart/Stop hooks for lifecycle.**

Rationale: Watching N subagent transcript files dynamically adds significant complexity for marginal value. The main session transcript shows the Agent tool call (task description) and the subagent's tool calls still fire PostToolUse hooks. The SubagentStop hook provides the final result. This gives us:

1. SubagentStart hook -> "Agent [type] started: [task description]"
2. PostToolUse hooks from subagent -> tool calls appear (they already do, they have the same session_id)
3. SubagentStop hook -> "Agent [type] finished: [summary]"

**Wait -- do subagent PostToolUse hooks fire?** Need to verify. According to the hooks reference, PreToolUse/PostToolUse fire for subagent tool calls too. The hook payload includes the same `session_id` as the parent. So subagent tool calls are ALREADY being posted to Telegram -- they just lack the "[Subagent]" label.

**Verification needed at implementation time:** Whether subagent PostToolUse hooks carry any identifier linking them to the subagent. If not, we need to use timing correlation between SubagentStart and SubagentStop to bracket which tool calls came from subagents.

**Practical Subagent Tracking:**

```typescript
// Per-session active subagent tracking
interface ActiveSubagent {
  agentId: string;
  agentType: string;
  startedAt: number;
}

// In SessionStore or a new SubagentTracker
activeSubagents: Map<string, ActiveSubagent[]>  // sessionId -> active subagents
```

When a SubagentStart arrives: push to active list.
When a SubagentStop arrives: remove from active list, post summary.
When formatting PostToolUse during active subagent: prepend "[SubagentType]" label.

**Confidence:** MEDIUM -- the exact behavior of PostToolUse hooks for subagent tool calls needs verification at implementation time. The hooks docs confirm SubagentStart/SubagentStop exist with the documented fields.

### Feature 4: /clear Topic Reuse

**Requirement:** `/clear` reuses existing topic instead of creating a new one. Posts separator message, re-pins fresh status.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `hooks/handlers.ts` | **MODIFY** | Detect `source === 'clear'` in handleSessionStart, reuse topic |
| `index.ts` | **MODIFY** | initMonitoring must handle status message re-creation |
| `status-message.ts` | **MODIFY** | Support re-initialization (new pinned message in existing topic) |
| `session-store.ts` | **MODIFY** | Need method to reset session metadata while keeping threadId |

**Architecture: /clear Flow**

```
User types /clear in Claude Code terminal
    ↓
Claude Code fires SessionEnd with reason "clear"
    ↓ (current: closes topic)
    ↓ (new: keep topic open, post separator)
Claude Code fires SessionStart with source "clear"
    ↓ (current: creates new topic -- wrong)
    ↓ (new: detect 'clear', reuse topic)
```

**The tricky part:** SessionEnd fires BEFORE SessionStart. Current onSessionEnd closes the topic. We need to detect that the end reason is "clear" and NOT close the topic.

**Hook payload for SessionEnd with reason "clear":** Per the official docs, `SessionEnd` receives a `reason` field. We need to add this to `SessionEndPayload`:

```typescript
export interface SessionEndPayload extends HookPayload {
  hook_event_name: 'SessionEnd';
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'bypass_permissions_disabled' | 'other';
}
```

**Flow:**

1. SessionEnd with `reason === 'clear'`:
   - Do NOT close the topic
   - Do NOT post "Session ended" message
   - Clean up monitoring (stop transcript watcher, summary timer)
   - Keep session in store as "pending-clear" state
   - Destroy old status message

2. SessionStart with `source === 'clear'`:
   - Detect pending-clear session by cwd match (same as resume detection)
   - Reuse existing threadId
   - Post separator: `"--- Session cleared ---"`
   - Create new StatusMessage (new pinned message)
   - Reset session metadata: toolCallCount=0, filesChanged=empty, contextPercent=0
   - Re-initialize monitoring

**Session ID Change:** Critical -- `/clear` creates a NEW session_id. The old session's data is stale. We need to:
1. On SessionEnd(clear): mark session as `status: 'clearing'` (not 'closed')
2. On SessionStart(clear): look up by cwd with status 'clearing', remap to new sessionId, reuse threadId

```typescript
// In handleSessionStart, before existing resume detection:
if (payload.source === 'clear') {
  const clearing = this.sessionStore.getClearingByCwd(payload.cwd);
  if (clearing) {
    // Remap: reuse topic, new session ID, reset counters
    this.sessionStore.set(payload.session_id, {
      ...clearing,
      sessionId: payload.session_id,
      transcriptPath: payload.transcript_path,
      status: 'active',
      startedAt: new Date().toISOString(),
      toolCallCount: 0,
      filesChanged: new Set<string>(),
      contextPercent: 0,
      suppressedCounts: {},
      lastActivityAt: new Date().toISOString(),
    });
    // Post separator and re-init
    await this.callbacks.onSessionClear(this.sessionStore.get(payload.session_id)!);
    return;
  }
}
```

**New HookCallback needed:**
```typescript
onSessionClear(session: SessionInfo): Promise<void>;
```

This posts the separator, creates new StatusMessage, re-pins it.

## Component Responsibilities (New + Modified)

| Component | Responsibility | Change Type |
|-----------|---------------|-------------|
| `content-store.ts` | Store expanded content for callback lookups | **NEW** |
| `formatter.ts` | Compact tool format, subagent labels, mode keyboards | **MODIFY** |
| `approval-manager.ts` | Per-session permission modes, auto-accept logic | **MODIFY** |
| `transcript-watcher.ts` | Emit subagent messages (was: filter them) | **MODIFY** |
| `hooks/handlers.ts` | SubagentStart/Stop handling, /clear detection | **MODIFY** |
| `hooks/server.ts` | New routes, remove timeout, PermissionRequest route | **MODIFY** |
| `types/hooks.ts` | SubagentStartPayload, SubagentStopPayload, reason field | **MODIFY** |
| `types/sessions.ts` | Permission mode, clearing status | **MODIFY** |
| `bot.ts` | Expand/collapse callbacks, mode callbacks, /clear handling | **MODIFY** |
| `topics.ts` | reply_markup support in sendMessage | **MODIFY** |
| `rate-limiter.ts` | Handle messages with keyboards (no batching) | **MODIFY** |
| `status-message.ts` | Re-initialization for /clear flow | **MODIFY** |
| `session-store.ts` | getClearingByCwd, permission mode methods | **MODIFY** |
| `index.ts` | Wire new callbacks, content store, subagent tracking | **MODIFY** |

## Data Flow Changes

### Current Tool Call Flow
```
PostToolUse → HookHandlers → verbosity filter → formatter.formatToolUse() → batcher.enqueue() → topic
```

### New Tool Call Flow (v3.0)
```
PostToolUse → HookHandlers → verbosity filter → formatter.formatCompactToolUse()
    ↓
    ├─ short output (< 250 chars): batcher.enqueue(text) [no keyboard, batchable]
    └─ long output (>= 250 chars): contentStore.store(compact, expanded)
                                    → batcher.enqueueImmediate(compact, keyboard) [not batched]
```

### Current Approval Flow
```
PreToolUse → server (blocking) → ApprovalManager.waitForDecision() → [timeout or button tap] → HTTP response
```

### New Approval Flow (v3.0)
```
PreToolUse → server (blocking) → ApprovalManager.shouldAutoAccept()?
    ├─ YES: return allow immediately (no message sent)
    └─ NO:  send approval message with mode buttons
            → ApprovalManager.waitForDecision() [no timeout]
            → button tap: approve/deny + optionally set mode
            → HTTP response
```

### New Subagent Flow
```
SubagentStart hook → post "[AgentType] started" to topic
                   → track agent in session state

PostToolUse hooks (from subagent, same session_id)
                   → check if subagent active → prepend "[AgentType]" label

SubagentStop hook  → post "[AgentType] finished: summary" to topic
                   → remove from tracking
```

### New /clear Flow
```
SessionEnd(reason=clear) → keep topic open, clean up monitors, mark 'clearing'
SessionStart(source=clear) → find clearing session by cwd
                           → reuse threadId, reset counters
                           → post "--- cleared ---" separator
                           → create new StatusMessage, pin it
                           → re-init monitoring
```

## Recommended Project Structure Changes

```
src/
├── bot/
│   ├── bot.ts              # MODIFY: expand/collapse + mode callback handlers
│   ├── command-registry.ts  # unchanged
│   ├── content-store.ts     # NEW: server-side content for expand/collapse
│   ├── formatter.ts         # MODIFY: compact format, subagent labels, mode keyboards
│   ├── rate-limiter.ts      # MODIFY: keyboard-aware batching
│   └── topics.ts            # MODIFY: reply_markup support
├── control/
│   └── approval-manager.ts  # MODIFY: permission modes, auto-accept, no timeout
├── hooks/
│   ├── handlers.ts          # MODIFY: SubagentStart/Stop, /clear detection
│   └── server.ts            # MODIFY: new routes, timeout removal
├── monitoring/
│   ├── status-message.ts    # MODIFY: re-initialization for /clear
│   ├── summary-timer.ts     # unchanged
│   ├── transcript-watcher.ts # MODIFY: emit subagent messages
│   └── verbosity.ts         # unchanged
├── sessions/
│   └── session-store.ts     # MODIFY: getClearingByCwd, permission mode
├── types/
│   ├── config.ts            # MODIFY: remove approvalTimeoutMs
│   ├── hooks.ts             # MODIFY: SubagentStart/Stop payloads, reason field
│   ├── monitoring.ts        # unchanged
│   └── sessions.ts          # MODIFY: permissionAutoAccept, clearing status
├── input/                   # unchanged
├── utils/
│   └── text.ts              # unchanged
├── config.ts                # MODIFY: remove timeout config
└── index.ts                 # MODIFY: wire everything
```

## Architectural Patterns

### Pattern 1: Server-Side Callback Store

**What:** Store full content server-side, put only a short ID in Telegram callback_data.
**When to use:** Any time you need expand/collapse, pagination, or multi-step inline interactions.
**Trade-offs:** Adds memory pressure (mitigated by TTL cleanup). Loses state on bot restart (acceptable -- buttons on old messages just stop working).

```typescript
// Compact callback_data: "x:a3" (5 bytes) vs UUID (36 bytes)
// 64-byte limit is never an issue with monotonic counter IDs
const id = contentStore.store({ compactHtml, expandedHtml, threadId });
const keyboard = new InlineKeyboard().text('Expand', `x:${id}`);
```

### Pattern 2: Permission State Machine per Session

**What:** Session-scoped auto-accept mode that progressively reduces permission prompts.
**When to use:** When the user signals trust ("I approved Bash once, approve it again").
**Trade-offs:** Reduces safety (mitigated by per-session scope and explicit user choice). "Same Tool" mode accumulates approved tools over session lifetime.

```typescript
// ApprovalManager checks mode BEFORE creating deferred promise
if (this.shouldAutoAccept(sessionId, toolName)) {
  return { allow: true, reason: `Auto-accepted (${mode} mode)` };
}
// Only create promise + send Telegram message if NOT auto-accepting
```

### Pattern 3: Lifecycle Hook for Topic Reuse

**What:** Intercept SessionEnd(clear) + SessionStart(clear) pair to reuse topic instead of creating new one.
**When to use:** Any command that resets context but should preserve the conversation thread (clear, compact).
**Trade-offs:** Requires intermediate "clearing" state to bridge the gap between SessionEnd and SessionStart events.

### Pattern 4: Dual-Source Subagent Visibility

**What:** Structured lifecycle from hooks (SubagentStart/Stop) + content from transcript (isSidechain).
**When to use:** When you need both structured metadata and unstructured content from a subsystem.
**Trade-offs:** Content may be delayed vs lifecycle events (transcript write vs HTTP hook). Correlation requires tracking active subagents.

## Anti-Patterns

### Anti-Pattern 1: Storing Full Content in callback_data

**What people do:** Try to encode full tool output in Telegram callback_data.
**Why it's wrong:** 64-byte hard limit. Even base64 encoding won't help for multi-KB content.
**Do this instead:** Server-side content store with short ID in callback_data.

### Anti-Pattern 2: Batching Messages with Inline Keyboards

**What people do:** Try to combine multiple messages that each have inline keyboards.
**Why it's wrong:** Each Telegram message can have only ONE inline keyboard (reply_markup). Combining messages loses keyboards.
**Do this instead:** Send keyboard messages individually (via enqueueImmediate), batch only plain text messages.

### Anti-Pattern 3: Watching N Subagent Transcript Files

**What people do:** Dynamically create a TranscriptWatcher for each subagent's transcript file.
**Why it's wrong:** O(N) file watchers, complex lifecycle management, most subagents are short-lived.
**Do this instead:** Use SubagentStart/Stop hooks for lifecycle + last_assistant_message for content. Parse main transcript for subagent tool calls.

### Anti-Pattern 4: Global Permission Mode

**What people do:** Single global "accept all" toggle.
**Why it's wrong:** Affects all sessions. User approving dangerous ops in one session shouldn't auto-approve in another.
**Do this instead:** Per-session mode stored in ApprovalManager, cleaned up on session end.

## Build Order (Dependency-Aware)

```
Phase 1: Compact Tool Output (independent, highest visual impact)
  1a. content-store.ts (new, no deps)
  1b. formatter.ts compact format (depends on nothing new)
  1c. topics.ts reply_markup support (small change)
  1d. rate-limiter.ts keyboard awareness (depends on 1c)
  1e. bot.ts expand/collapse callbacks (depends on 1a)
  1f. index.ts wiring (depends on all above)

Phase 2: Permission Modes (independent of Phase 1)
  2a. types/sessions.ts + session-store.ts permission fields
  2b. approval-manager.ts mode logic + auto-accept
  2c. formatter.ts mode keyboard buttons
  2d. bot.ts mode callback handlers
  2e. hooks/server.ts timeout removal
  2f. index.ts wiring + stdout logging

Phase 3: /clear Topic Reuse (depends on understanding Phase 1+2 wiring)
  3a. types/hooks.ts reason field on SessionEnd
  3b. hooks/handlers.ts clear detection logic
  3c. session-store.ts getClearingByCwd + reset methods
  3d. status-message.ts re-initialization
  3e. index.ts onSessionClear callback wiring

Phase 4: Subagent Visibility (most complex, benefits from Phase 1-3 stability)
  4a. types/hooks.ts SubagentStart/Stop payload types
  4b. hooks/server.ts new routes
  4c. hooks/handlers.ts SubagentStart/Stop handlers
  4d. transcript-watcher.ts emit subagent entries
  4e. formatter.ts subagent labels
  4f. index.ts wiring + subagent tracking
```

**Build order rationale:**
- Phase 1 first: standalone, highest user-visible impact, establishes the content-store pattern used by other features
- Phase 2 second: standalone, high usability impact (reduces button-tap fatigue)
- Phase 3 third: smaller scope, needs stable wiring layer
- Phase 4 last: most complex, most uncertain (subagent hook behavior needs runtime verification), least critical for day-to-day use

## Integration Points Summary

### New Hook Routes Needed

| Route | Event | Blocking? |
|-------|-------|-----------|
| `/hooks/subagent-start` | SubagentStart | No (fire-and-forget) |
| `/hooks/subagent-stop` | SubagentStop | No (fire-and-forget) |

### New Callback Queries

| Pattern | Purpose | Callback Data |
|---------|---------|--------------|
| `x:{id}` | Expand tool output | 3-7 bytes |
| `c:{id}` | Collapse tool output | 3-7 bytes |
| `aa:{toolUseId}` | Accept All mode | ~40 bytes |
| `st:{toolUseId}` | Same Tool mode | ~40 bytes |
| `so:{toolUseId}` | Safe Only mode | ~40 bytes |

### New HookCallbacks

| Callback | Trigger |
|----------|---------|
| `onSessionClear(session)` | SessionStart with source 'clear' after matching SessionEnd |
| `onSubagentStart(session, payload)` | SubagentStart hook |
| `onSubagentStop(session, payload)` | SubagentStop hook |

### Modified SessionInfo Fields

| Field | Type | Purpose |
|-------|------|---------|
| `permissionAutoAccept` | `'ask' \| 'all' \| 'same-tool' \| 'safe' \| 'until-done'` | Current permission mode |
| `approvedTools` | `Set<string>` | Tools approved in "same-tool" mode |
| `status` | add `'clearing'` | Intermediate state for /clear flow |
| `activeSubagents` | `Map<string, { agentType: string }>` | Currently running subagents |

## Scaling Considerations

| Concern | Current (2-3 sessions) | At 10 sessions | At 50 sessions |
|---------|------------------------|-----------------|----------------|
| ContentStore memory | ~100 entries, negligible | ~500 entries, ~5MB | ~2500 entries, ~25MB. Add TTL cleanup |
| Active subagents | 0-2 per session | 0-5 per session | Consider subagent count limits |
| Approval mode state | Negligible | Negligible | Negligible |
| Hook routes | +2 routes, no impact | Same | Same |

No scaling concerns for the target scale of 2-3 machines with 2-3 sessions each.

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- SubagentStart/SubagentStop fields, SessionStart source values, SessionEnd reasons, PermissionRequest hook (HIGH confidence, official docs)
- [grammY Inline Keyboards](https://grammy.dev/plugins/keyboard) -- callback_data usage, editMessageReplyMarkup (HIGH confidence, official docs)
- [Telegram Bot API](https://core.telegram.org/bots/api) -- 64-byte callback_data limit, editMessageText with reply_markup (HIGH confidence, official docs)
- [callback-data library](https://github.com/deptyped/callback-data) -- structured callback data patterns for grammY (MEDIUM confidence, community library)
- [Claude Code Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) -- permission modes: default, plan, acceptEdits, dontAsk, bypassPermissions (HIGH confidence, official docs)

---
*Architecture research for: Claude Code Telegram Bridge v3.0 UX Overhaul*
*Researched: 2026-03-01*
