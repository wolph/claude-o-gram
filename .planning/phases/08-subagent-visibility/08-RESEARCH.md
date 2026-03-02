# Phase 8: Subagent Visibility - Research

**Researched:** 2026-03-02
**Domain:** Claude Code subagent hooks, Telegram message formatting, agent lifecycle tracking
**Confidence:** HIGH

## Summary

Phase 8 adds visibility into Claude Code subagent lifecycle for Telegram users. The core mechanism is two new Claude Code hooks -- `SubagentStart` and `SubagentStop` -- that fire when agents spawn and complete. These hooks carry `agent_id` and `agent_type` fields that uniquely identify each subagent instance. Tool calls and text output from subagents must be attributed with bracket-prefix formatting `[agent-name]`.

The biggest technical challenge is that **SubagentStart only supports command-type hooks, not HTTP hooks**. This means `install-hooks.ts` cannot simply add another HTTP endpoint like the existing hooks. Instead, a shell script bridge must be installed that receives SubagentStart JSON on stdin and forwards it to the HTTP server via curl. SubagentStop supports HTTP hooks natively, so it can use the standard HTTP endpoint pattern.

A second significant challenge is **PostToolUse payloads do not contain `agent_id`**. Tool calls from subagents arrive through the same PostToolUse endpoint as main-agent tool calls, with no field indicating which agent made the call. Attribution requires a temporal tracking approach: maintain an in-memory set of active agent IDs (populated on SubagentStart, removed on SubagentStop), and tag tool calls that arrive while a subagent is active. For single active subagents this is reliable. For parallel subagents, attribution is ambiguous without additional heuristics.

**Primary recommendation:** Register SubagentStart via a command hook (shell script bridge to HTTP), SubagentStop via HTTP hook. Track active agents in a new `SubagentTracker` class that maps `agent_id` to metadata. Use temporal heuristic for PostToolUse attribution. Prefix all output from active subagents with `[agent-name]` bracket formatting.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Spawn and completion display:**
- Spawn and completion appear as **inline text messages** in the conversation flow (not status message updates)
- Spawn announcement format: `> Agent(name) spawned -- "description"` -- includes agent name and the short description passed at spawn time. No agent type shown.
- Completion announcement format: `checkmark Agent(name) done (duration)` -- includes agent name and elapsed time. No result summary.
- **Distinct visual symbols**: `>` for spawn, `checkmark` for done -- different from `lightning` (auto-approved tools) to avoid confusion between features

**Agent-prefixed output:**
- Tool calls from subagents use **bracket prefix**: `[agent-name] Tool(args...)` -- prepended before the tool display
- Subagent tool calls do **NOT** use the lightning bolt prefix -- lightning is reserved for auto-approved permission mode tools. Subagent tools show as plain `[name] Tool(args)`
- Subagent **text output also gets the bracket prefix**: `[agent-name] text...` -- consistent treatment
- Subagent **permission prompts also get the bracket prefix**: `[agent-name] Bash: command` -- crucial for security

**Nesting behavior:**
- Nested agents use **indentation with single prefix** -- each nesting level indents, but only shows the immediate agent's name (no stacked brackets)
- Nested spawn/done announcements are **indented** to show parent-child relationship visually
- **Depth 3+ flattens to depth 2** -- agents deeper than 2 levels display at the same indent as level 2
- **Indentation alone conveys hierarchy** -- parent agent name is not repeated on every line

**Information density:**
- **Full treatment always** -- every agent gets spawn announcement, prefixed tool calls, and done line
- **Interleaved with prefixes** for parallel agents -- output from concurrent agents appears in real-time order, each line prefixed with its agent name
- **Show everything** -- no cap on tool call volume per agent. Phase 6 compact format keeps lines short.

### Claude's Discretion
- Exact indentation width (2 spaces, 3 spaces, etc.)
- How to handle the batcher when multiple agents post simultaneously (batching strategy per agent vs shared)
- Whether to track agent-to-thread mapping in session store or separate structure

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AGENT-01 | SubagentStart/SubagentStop hooks registered in hook installer | SubagentStart requires command hook bridge (shell script + curl to HTTP endpoint); SubagentStop supports native HTTP hook. install-hooks.ts must install both, plus write the bridge script to disk. |
| AGENT-02 | Subagent spawn shown: `> Agent(name) spawned -- "description"` with type | SubagentStart payload contains `agent_id` and `agent_type`. Description must be captured from PreToolUse(Agent) `tool_input.description` or `tool_input.prompt` field, correlated via temporal proximity. |
| AGENT-03 | Subagent completion shown: `checkmark Agent(name) done` | SubagentStop payload contains `agent_id`, `agent_type`, `last_assistant_message`. Duration calculated from SubagentTracker start time. |
| AGENT-04 | Subagent tool calls tagged with agent prefix: `[name] Tool(args...)` | PostToolUse has no `agent_id` field. Use temporal heuristic: if SubagentTracker has active agents, prefix tool output with active agent name. |
| AGENT-05 | Subagent text output tagged with agent prefix: `[name] text...` | TranscriptWatcher currently skips `isSidechain` entries. Must be modified to process sidechain entries and prefix them with agent name. |
| AGENT-06 | Nested subagents use stacked prefix: `>> [inner]` (max 2 levels) | SubagentTracker must track parent-child relationships using temporal nesting (SubagentStart within active SubagentStart). Indent with spaces per depth level, cap at depth 2. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | ^5.7.4 | HTTP hook server (existing) | Already used for all hook endpoints |
| grammy | ^1.40.1 | Telegram bot (existing) | Already used for message sending |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node.js child_process | built-in | Not needed | Hook bridge uses shell script, not Node spawning |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Shell script bridge for SubagentStart | Unix socket / named pipe | Shell + curl is simpler, debuggable, matches existing HTTP pattern; no new dependencies |
| Temporal heuristic for tool attribution | Parsing subagent transcript JSONL | Transcript parsing is heavier and async; temporal tracking is fast and in-memory |

**Installation:**
No new packages needed. All dependencies are already in the project.

## Architecture Patterns

### Recommended Project Structure
```
src/
  hooks/
    handlers.ts         # Add handleSubagentStart, handleSubagentStop methods
    server.ts           # Add /hooks/subagent-start, /hooks/subagent-stop routes
  bot/
    formatter.ts        # Add formatSubagentSpawn, formatSubagentDone, agent prefix helpers
  monitoring/
    subagent-tracker.ts # NEW: tracks active subagents, depth, parent-child, timing
    transcript-watcher.ts  # Modify to handle isSidechain entries with agent prefix
  utils/
    install-hooks.ts    # Add SubagentStart (command hook) and SubagentStop (HTTP hook)
  types/
    hooks.ts            # Add SubagentStartPayload, SubagentStopPayload types
```

### Pattern 1: Command Hook Bridge for SubagentStart
**What:** SubagentStart only supports `type: "command"` hooks (no HTTP). We need a shell script that receives the JSON payload on stdin and forwards it to our Fastify server via curl.
**When to use:** Always -- this is the only way to receive SubagentStart events.
**Example:**
```bash
#!/bin/bash
# .claude-o-gram/hooks/subagent-start.sh
# Bridge: reads SubagentStart JSON from stdin, POSTs to local HTTP server
curl -s -X POST http://127.0.0.1:${HOOK_PORT:-4001}/hooks/subagent-start \
  -H "Content-Type: application/json" \
  -d @- < /dev/stdin
```

The `install-hooks.ts` must:
1. Write this script to a known location (e.g., `~/.claude-o-gram/hooks/subagent-start.sh`)
2. Make it executable (`chmod +x`)
3. Register SubagentStart in settings.json as `type: "command"` pointing to this script
4. Pass the port number via environment variable or hardcode it in the script

### Pattern 2: SubagentTracker State Machine
**What:** In-memory tracker that maps `agent_id` to metadata (name, type, start time, depth, parent).
**When to use:** All subagent-related operations flow through this tracker.
**Example:**
```typescript
// Source: project-specific pattern
interface ActiveAgent {
  agentId: string;
  agentType: string;    // "Explore", "Plan", custom name
  displayName: string;  // Human-friendly name for bracket prefix
  description: string;  // From PreToolUse(Agent) correlation
  startedAt: number;    // Date.now() for duration calculation
  depth: number;        // 0 = top-level subagent, 1 = nested, capped at 2
  parentAgentId?: string;
}

class SubagentTracker {
  private activeAgents = new Map<string, ActiveAgent>();
  // Per-session: ordered list of active agent IDs for attribution
  private sessionAgentStack = new Map<string, string[]>();

  start(sessionId: string, agentId: string, agentType: string, description: string): void;
  stop(agentId: string): { agent: ActiveAgent; durationMs: number } | null;
  getActiveAgent(sessionId: string): ActiveAgent | null;  // Most recent for attribution
  getDepth(agentId: string): number;
  getIndent(agentId: string): string;  // "  " per depth level
}
```

### Pattern 3: Temporal Tool Attribution
**What:** PostToolUse events arrive without `agent_id`. When a subagent is active (tracked via SubagentStart/SubagentStop), tool calls are attributed to the most recently started agent for that session.
**When to use:** Every PostToolUse and PreToolUse event.
**Limitation:** When multiple subagents run in parallel for the same session, attribution to the correct agent is ambiguous. The heuristic assigns to the most recently spawned active agent. This is acceptable per user decision ("interleaved with prefixes" -- each line shows its agent name, even if occasionally misattributed during rare parallel scenarios).
**Example:**
```typescript
// In onToolUse callback (index.ts)
const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
if (activeAgent) {
  const prefix = subagentTracker.getIndent(activeAgent.agentId);
  const agentTag = `[${activeAgent.displayName}] `;
  // Prepend to compact tool line
  const result = formatToolCompact(payload);
  const prefixed = `${prefix}${agentTag}${result.compact}`;
  batcher.enqueue(session.threadId, prefixed);
} else {
  // Normal (main agent) tool call
  const result = formatToolCompact(payload);
  batcher.enqueue(session.threadId, result.compact);
}
```

### Pattern 4: Description Capture from PreToolUse(Agent)
**What:** The SubagentStart payload only has `agent_id` and `agent_type`, not the task description. The description is available in the PreToolUse payload when `tool_name` is "Agent" (in `tool_input.description` or `tool_input.prompt`).
**When to use:** To show meaningful spawn announcements like `> Agent(name) spawned -- "description"`.
**Strategy:** In the PreToolUse handler, when tool_name matches Agent/Task, stash `{ description, subagent_type }` in a pending map. When SubagentStart fires shortly after, look up the pending description by matching `agent_type`. If no match (race condition), use `agent_type` as fallback.
**Example:**
```typescript
// Pending description buffer (in SubagentTracker or index.ts)
private pendingAgentDescriptions = new Map<string, {
  description: string;
  timestamp: number;
  sessionId: string;
}>();

// In PreToolUse auto-approve path (server.ts), for Agent tool:
if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
  const desc = (payload.tool_input.description as string)
    || (payload.tool_input.prompt as string)
    || '';
  const agentType = (payload.tool_input.subagent_type as string) || 'unknown';
  subagentTracker.stashDescription(payload.session_id, agentType, desc);
}

// In handleSubagentStart:
const description = subagentTracker.popDescription(payload.session_id, payload.agent_type)
  || payload.agent_type;
```

### Pattern 5: Transcript Watcher Sidechain Processing
**What:** Currently, `TranscriptWatcher.processEntry()` skips `isSidechain: true` entries. For AGENT-05, sidechain entries must be processed and prefixed with the agent name.
**When to use:** To show subagent text output in Telegram.
**Strategy:** Instead of `if (entry.isSidechain) return;`, conditionally process sidechain entries by looking up the active agent in SubagentTracker and prefixing the text.
**Example:**
```typescript
// Modified processEntry in TranscriptWatcher
private processEntry(entry: TranscriptEntry): void {
  if (entry.type !== 'assistant') return;
  if (entry.message.role !== 'assistant') return;

  // Extract text content
  const text = this.extractText(entry);
  if (!text) return;

  if (entry.isSidechain) {
    // Subagent text: delegate to sidechain callback with text
    this.onSidechainMessage?.(text);
  } else {
    // Main agent text: existing behavior
    this.onAssistantMessage(text);
    if (entry.message.usage) {
      this.onUsageUpdate(entry.message.usage);
    }
  }
}
```

The `onSidechainMessage` callback in index.ts would look up the active agent and prefix the text before posting.

### Anti-Patterns to Avoid
- **Parsing subagent transcripts directly:** The `agent_transcript_path` in SubagentStop is tempting but would require reading and parsing an entire JSONL file. Use the existing TranscriptWatcher `isSidechain` detection instead.
- **Storing agent state in SessionInfo:** The `SessionInfo` interface is already crowded. Use a separate `SubagentTracker` class with its own Map, keyed by `agent_id`.
- **Blocking SubagentStart handling:** SubagentStart hooks are non-blocking (cannot delay agent creation). The command hook bridge must be fast -- curl POST and exit. Do not add heavy processing.
- **Prefixing in the formatter:** Don't modify `formatToolCompact()` to know about agents. Keep the formatter pure; apply prefixes in the callback wiring layer (index.ts).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Agent state tracking | Ad-hoc Maps in index.ts | Dedicated SubagentTracker class | Clean separation, testable, handles nesting/depth/timing |
| Shell script templating | String concatenation | Template literal with port variable | Avoid shell injection, ensure proper escaping |
| Duration formatting | Custom ms-to-string | Reuse existing `formatDuration` in formatter.ts | Already exists, handles hours/minutes/seconds |

**Key insight:** The complexity is in the wiring and state management, not in any single algorithm. A clean SubagentTracker class that encapsulates all agent lifecycle state is the critical abstraction.

## Common Pitfalls

### Pitfall 1: SubagentStart Does Not Support HTTP Hooks
**What goes wrong:** Attempting to register SubagentStart as an HTTP hook in settings.json will silently fail -- the hook never fires.
**Why it happens:** Claude Code only supports `type: "command"` for SubagentStart events (official docs confirmed).
**How to avoid:** Use a command hook (shell script) that bridges to HTTP via curl. The script reads JSON from stdin and POSTs to the local Fastify server.
**Warning signs:** SubagentStart handler never gets called; subagent spawn announcements never appear.

### Pitfall 2: PostToolUse Has No agent_id
**What goes wrong:** Assuming PostToolUse payloads contain `agent_id` and building attribution logic around it.
**Why it happens:** The PostToolUse schema only includes: `session_id`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`. No agent identification.
**How to avoid:** Use temporal heuristic: if SubagentTracker reports an active agent for the session, attribute the tool call to that agent. Accept that parallel subagent attribution is approximate.
**Warning signs:** Tool calls from subagents appear without prefix; code tries to read `payload.agent_id` and gets `undefined`.

### Pitfall 3: SubagentStart Payload Lacks Description
**What goes wrong:** Trying to read a `description` field from SubagentStart payload. It only has `agent_id` and `agent_type`.
**Why it happens:** The description lives in the PreToolUse(Agent) `tool_input`, not the SubagentStart event.
**How to avoid:** Capture description from PreToolUse when `tool_name === 'Agent'` and stash it. Match on SubagentStart by `agent_type`. Clear stashed descriptions after a timeout (e.g., 30 seconds) to prevent memory leaks.
**Warning signs:** Spawn announcements show agent type but no description: `> Agent(Explore) spawned -- ""`.

### Pitfall 4: Race Between PreToolUse(Agent) and SubagentStart
**What goes wrong:** SubagentStart fires before the PreToolUse(Agent) hook response is processed, or vice versa, causing description lookup to fail.
**Why it happens:** PreToolUse is BLOCKING (waits for response), while SubagentStart is fire-and-forget. The SubagentStart fires after Claude creates the subagent, which happens after PreToolUse allows it.
**How to avoid:** The ordering is: PreToolUse(Agent) fires first (blocking) -> response returns allowing it -> agent spawns -> SubagentStart fires. So the description IS available by the time SubagentStart arrives. For the auto-approve path (permission modes), the description is captured in the pre-tool-use handler before the allow response.
**Warning signs:** N/A -- the ordering is deterministic.

### Pitfall 5: Nesting Depth Tracking
**What goes wrong:** Nested agents produce visually confusing output or infinite indentation.
**Why it happens:** A subagent can spawn its own subagents, creating arbitrary nesting depth.
**How to avoid:** Cap visual depth at 2 (per user decision). Track parent-child via: when SubagentStart fires while another agent is already active for the same session, the new agent's parent is the currently active agent. Depth = parent.depth + 1, capped at 2.
**Warning signs:** Indentation grows unbounded; deeply nested agents produce messages that are mostly whitespace.

### Pitfall 6: TranscriptWatcher isSidechain Filtering
**What goes wrong:** Subagent text output never appears in Telegram because TranscriptWatcher skips all sidechain entries.
**Why it happens:** Line 205 of transcript-watcher.ts: `if (entry.isSidechain) return;` -- deliberate filtering from earlier phases.
**How to avoid:** Change to conditional: if sidechain, emit via a new `onSidechainMessage` callback with the raw text. The callback handler in index.ts looks up the active agent and prefixes.
**Warning signs:** Tool calls from subagents appear (via PostToolUse hooks) but text output does not.

### Pitfall 7: Command Hook Script Must Be Idempotent and Fast
**What goes wrong:** The shell script bridge takes too long, times out (default 600s for command hooks), or fails silently.
**Why it happens:** Using a complex script, or curl blocking on slow server response.
**How to avoid:** Script should be 2-3 lines: read stdin, POST to localhost, exit. Use `curl -s --max-time 5` to avoid hangs. The Fastify route should respond immediately (fire-and-forget processing, like PostToolUse).
**Warning signs:** Subagent spawn announcements appear late or not at all.

### Pitfall 8: Auto-Approved Subagent Tool Dedup
**What goes wrong:** Subagent tool calls that were auto-approved show up twice -- once as a lightning line (from permission mode) and once as a `[agent-name] Tool(...)` line (from PostToolUse).
**Why it happens:** The existing Phase 7 dedup logic (autoApprovedToolUseIds Set) skips the PostToolUse display for auto-approved tools. But for subagent tools, we WANT them to show (with prefix) and NOT show as lightning.
**How to avoid:** Subagent tool calls should NOT get the lightning treatment. The PreToolUse auto-approve logic should check if the tool call is from an active subagent and skip the lightning line. OR: the SubagentStart fires before tools run, so the tracker knows the tool is from a subagent by the time PreToolUse fires. Subagent tools that are auto-approved by permission modes should show as `[name] Tool(args)` not `lightning Tool(args)`.
**Warning signs:** Subagent tool calls appear with lightning prefix instead of agent bracket prefix.

## Code Examples

Verified patterns from official sources and existing codebase:

### SubagentStart Payload (from official docs)
```json
// Source: https://code.claude.com/docs/en/hooks#subagentstart
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SubagentStart",
  "agent_id": "agent-abc123",
  "agent_type": "Explore"
}
```

### SubagentStop Payload (from official docs)
```json
// Source: https://code.claude.com/docs/en/hooks#subagentstop
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_id": "def456",
  "agent_type": "Explore",
  "agent_transcript_path": "~/.claude/projects/.../abc123/subagents/agent-def456.jsonl",
  "last_assistant_message": "Analysis complete. Found 3 potential issues..."
}
```

### Hook Type Support Matrix (from official docs)
```
SubagentStart: command only (NO http, NO prompt, NO agent)
SubagentStop:  command, http, prompt, agent (ALL four types)
```

### Shell Script Bridge Pattern
```bash
#!/bin/bash
# Installed by install-hooks.ts to ~/.claude-o-gram/hooks/subagent-start.sh
# Bridges SubagentStart (command-only hook) to the HTTP server
curl -s --max-time 5 -X POST "http://127.0.0.1:PORT/hooks/subagent-start" \
  -H "Content-Type: application/json" \
  -d @- < /dev/stdin
exit 0
```

### Formatter Output Patterns (from CONTEXT.md decisions)
```
// Spawn announcement (inline message, not status update)
▶ Agent(Explore) spawned — "Search for auth patterns"

// Tool call from subagent (bracket prefix, NO lightning)
[Explore] Grep("auth.*pattern", src/)
[Explore] Read(src/auth/handler.ts)

// Completion announcement
✓ Agent(Explore) done (2m)

// Nested agent spawn (indented)
  ▶ Agent(Validator) spawned — "Check test coverage"
  [Validator] Bash(npm test)
  ✓ Agent(Validator) done (45s)

// Parallel agents (interleaved, each prefixed)
[Explore] Grep("auth", src/)
[Builder] Write(src/new-file.ts) 45 lines
[Explore] Read(src/auth/handler.ts)
[Builder] Edit(src/index.ts) +3 -1

// Depth 3+ flattened to depth 2
  [DeepAgent] Bash(npm test)    // Same indent as depth 2
```

### PreToolUse Agent Tool Input (from official docs)
```json
// Source: https://code.claude.com/docs/en/hooks#agent
{
  "tool_name": "Agent",
  "tool_input": {
    "prompt": "Find all API endpoints",
    "description": "Find API endpoints",
    "subagent_type": "Explore",
    "model": "sonnet"
  }
}
```

### Existing install-hooks.ts Pattern (project source)
```typescript
// Source: src/utils/install-hooks.ts
// Current pattern: HTTP hooks registered directly in settings.json
const hookConfig: Record<string, unknown> = {
  SubagentStop: [
    {
      matcher: '',
      hooks: [
        { type: 'http', url: `${baseUrl}/hooks/subagent-stop`, timeout: 10 },
      ],
    },
  ],
  // SubagentStart requires command type:
  SubagentStart: [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `${scriptPath}`,  // path to installed shell script
          timeout: 10,
        },
      ],
    },
  ],
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No SubagentStart hook existed | SubagentStart hook now available (command-only) | 2025-2026 | Can detect agent spawns; previously only SubagentStop existed |
| SubagentStop had no agent_id | SubagentStop now includes agent_id + agent_type | 2025-2026 | Can identify which agent finished |
| PostToolUse had no agent context | Still no agent_id in PostToolUse | Current | Must use temporal heuristic for tool attribution |

**Deprecated/outdated:**
- Issue #7881 (SubagentStop missing agent_id): Resolved -- `agent_id` is now present in both SubagentStart and SubagentStop payloads per current official docs
- Issue #14859 (SubagentStart hook request): Partially resolved -- SubagentStart exists but only as command type. Agent hierarchy in PostToolUse events is still not available.

## Open Questions

1. **Parallel subagent tool attribution accuracy**
   - What we know: PostToolUse has no agent_id. Temporal heuristic attributes to most recently started active agent.
   - What's unclear: How often Claude Code runs parallel subagents in practice. If rare, the heuristic is sufficient.
   - Recommendation: Implement temporal heuristic. If misattribution is observed in testing, add a note in the output. This matches user decision ("interleaved with prefixes").

2. **SubagentStart command hook script location**
   - What we know: The script must be written to disk and referenced by absolute path in settings.json.
   - What's unclear: Best location. Options: `~/.claude-o-gram/hooks/`, `~/.claude/hooks/`, `/tmp/claude-o-gram/`.
   - Recommendation: Use `~/.claude-o-gram/hooks/subagent-start.sh`. This is a dedicated directory for the bot, not mixed with user hooks in `~/.claude/hooks/`.

3. **isSidechain transcript entries -- do they carry agent_id?**
   - What we know: The `TranscriptEntry` interface has `isSidechain: boolean` but no `agentId` field.
   - What's unclear: Whether the transcript JSONL has additional fields not in our type definition that could identify which agent produced the sidechain entry.
   - Recommendation: Use temporal heuristic for sidechain text too (same as PostToolUse). If future transcript format adds agent_id, we can improve.

4. **Agent/Task tool naming**
   - What we know: PreToolUse docs show `tool_name: "Agent"`. The formatter has `toolName.includes('Agent') || toolName.includes('Task')`.
   - What's unclear: Whether the tool is always called "Agent" or sometimes "Task". The `subagent_type` field distinguishes the type.
   - Recommendation: Check for both "Agent" and "Task" in tool_name matching, consistent with existing formatter logic.

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) - Complete hook event schemas, SubagentStart/SubagentStop payload fields, hook type support matrix (command vs HTTP), matcher patterns
- Project source code: `src/hooks/handlers.ts`, `src/hooks/server.ts`, `src/utils/install-hooks.ts`, `src/bot/formatter.ts`, `src/index.ts`, `src/monitoring/transcript-watcher.ts` - Existing architecture patterns

### Secondary (MEDIUM confidence)
- [GitHub Issue #7881](https://github.com/anthropics/claude-code/issues/7881) - SubagentStop session ID issue (now resolved with agent_id)
- [GitHub Issue #14859](https://github.com/anthropics/claude-code/issues/14859) - Feature request for agent hierarchy in hook events (SubagentStart now exists)
- [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) - Community reference implementation for subagent tracking

### Tertiary (LOW confidence)
- PostToolUse agent attribution via temporal heuristic -- no official guidance on this approach; based on analysis of payload schemas and absence of agent_id field

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, extends existing patterns
- Architecture: HIGH - clear patterns from official docs and existing codebase
- Hook payloads: HIGH - verified against official docs at code.claude.com
- SubagentStart command-only limitation: HIGH - explicitly documented in official hook type support table
- PostToolUse attribution heuristic: MEDIUM - logical approach but no official guidance; parallel agent edge cases exist
- Sidechain transcript handling: MEDIUM - isSidechain exists but transcript format may have undocumented fields

**Research date:** 2026-03-02
**Valid until:** 2026-04-01 (stable -- Claude Code hook API unlikely to change rapidly; re-check if upgrading Claude Code version)
