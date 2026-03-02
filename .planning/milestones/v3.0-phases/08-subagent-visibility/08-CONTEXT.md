# Phase 8: Subagent Visibility - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Make subagent lifecycle visible in Telegram — spawn announcements, agent-prefixed tool/text output, and nested agent indicators. Users currently have zero visibility into background agent work. This phase adds that visibility without changing how agents actually work.

</domain>

<decisions>
## Implementation Decisions

### Spawn and completion display
- Spawn and completion appear as **inline text messages** in the conversation flow (not status message updates)
- Spawn announcement format: `▶ Agent(name) spawned — "description"` — includes agent name and the short description passed at spawn time. No agent type shown.
- Completion announcement format: `✓ Agent(name) done (duration)` — includes agent name and elapsed time. No result summary.
- **Distinct visual symbols**: `▶` for spawn, `✓` for done — different from `⚡` (auto-approved tools) to avoid confusion between features

### Agent-prefixed output
- Tool calls from subagents use **bracket prefix**: `[agent-name] Tool(args...)` — prepended before the tool display
- Subagent tool calls do **NOT** use the lightning bolt `⚡` prefix — lightning is reserved for auto-approved permission mode tools. Subagent tools show as plain `[name] Tool(args)`
- Subagent **text output also gets the bracket prefix**: `[agent-name] text...` — consistent treatment, everything from a subagent is clearly attributed
- Subagent **permission prompts also get the bracket prefix**: `[agent-name] Bash: command` — crucial context for deciding whether to approve

### Nesting behavior
- Nested agents use **indentation with single prefix** — each nesting level indents, but only shows the immediate agent's name (no stacked brackets)
- Nested spawn/done announcements are **indented** to show parent-child relationship visually
- **Depth 3+ flattens to depth 2** — agents deeper than 2 levels display at the same indent as level 2 to prevent runaway indentation
- **Indentation alone conveys hierarchy** — parent agent name is not repeated on every line; the spawn announcement establishes the relationship

### Information density
- **Full treatment always** — every agent gets spawn announcement, prefixed tool calls, and done line, regardless of how short-lived. No collapsing or condensing of short agents.
- **Interleaved with prefixes** for parallel agents — output from concurrent agents appears in real-time order, each line prefixed with its agent name. No buffering or grouping.
- **Show everything** — no cap on tool call volume per agent. Full transparency. Phase 6 compact format keeps lines short.

### Claude's Discretion
- Exact indentation width (2 spaces, 3 spaces, etc.)
- How to handle the batcher when multiple agents post simultaneously (batching strategy per agent vs shared)
- Whether to track agent-to-thread mapping in session store or separate structure

</decisions>

<specifics>
## Specific Ideas

- Spawn/done symbols (`▶` / `✓`) should be visually distinct from tool call symbols (`⚡` for auto-approved, plain for manual)
- The bracket prefix `[name]` should work within the existing HTML formatting (use `<b>[name]</b>` or similar for visual weight)
- Permission prompts from subagents showing `[agent-name]` are particularly important for security — user needs to know WHICH agent is requesting destructive operations

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-subagent-visibility*
*Context gathered: 2026-03-02*
