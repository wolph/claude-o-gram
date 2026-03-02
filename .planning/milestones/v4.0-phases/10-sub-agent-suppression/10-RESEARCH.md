# Phase 10: Sub-Agent Suppression - Research

**Researched:** 2026-03-02
**Domain:** Internal codebase modification — gating existing Telegram output paths
**Confidence:** HIGH

## Summary

Phase 10 suppresses all sub-agent output from Telegram by default. The implementation is a surgical gating pattern: add a `subagentOutput` boolean to `AppConfig`, parse it from `SUBAGENT_VISIBLE` env var (default `false`), and wrap 5 specific `batcher.enqueue`/`enqueueImmediate` call sites with a guard that checks both `config.subagentOutput` and `subagentTracker.isSubagentActive()`.

The SubagentTracker itself remains untouched — it continues tracking lifecycle, depth, and tool attribution unconditionally. Only the Telegram posting calls are gated. PreToolUse approval requests from sub-agents must always show (user safety requirement).

**Primary recommendation:** Create a helper function `shouldShowSubagentOutput(config, subagentTracker, sessionId)` to centralize the suppression check, then apply it at all 5 call sites. This keeps the logic DRY and makes it easy for Phase 12 to replace the static config check with a runtime settings check.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Truly invisible by default**: When suppressed, zero sub-agent output reaches Telegram — no spawn announcement, no done announcement, no tool calls, no text output
- Sub-agent tool calls from the `onToolUse` callback are fully hidden (not shown as anonymous main-chain tools)
- Auto-approved sub-agent tools from the hook server callback are also hidden
- The `[AgentName]` prefixed tool lines and text lines all suppressed
- `onPreToolUse` approval requests from sub-agents should still show (user needs to approve/deny regardless of visibility setting)
- `SubagentTracker.start()` and `.stop()` are called unconditionally — tracker state must stay accurate
- `isSubagentActive()` continues to work correctly — used for tool attribution logic
- Only the Telegram posting (batcher.enqueue/enqueueImmediate) calls are gated by the suppression flag
- Description stashing from PreToolUse(Agent) also continues unconditionally
- Sub-agents do not create separate Telegram topics — they share the parent session's topic (already the case in current code)
- New env var: `SUBAGENT_VISIBLE` (default: `false`)
- New field in `AppConfig`: `subagentOutput: boolean`
- Env var only until Phase 12 adds the settings topic toggle
- When `subagentOutput` is `true`, behavior is identical to current v3.0 (full visibility)

### Claude's Discretion
- Whether to check the flag at each call site individually or create a helper function
- Whether `subagentOutput` should be on `AppConfig` (immutable) or prepared for runtime override (Phase 12)
- Log-level console output when suppressing (e.g., `[AGENT] Suppressed spawn: AgentName`)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AGNT-01 | Sub-agent output is suppressed by default (no spawn/done announcements, no tool calls, no text) | 5 call sites identified in index.ts; gating pattern documented; default `false` for SUBAGENT_VISIBLE |
| AGNT-02 | Sub-agents do not create their own Telegram topics by default | Already the case — sub-agents share parent session topic. No new code needed, verify in research. |
| AGNT-03 | Sub-agent visibility is toggleable via settings topic | Config field `subagentOutput` on AppConfig; env var toggle now, Phase 12 adds runtime UI. Verify toggle works by setting SUBAGENT_VISIBLE=true. |
</phase_requirements>

## Standard Stack

### Core
No new libraries required. This phase modifies existing code only.

| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| grammy | existing | Telegram bot framework | No changes |
| dotenv | existing | Env var loading | Used for SUBAGENT_VISIBLE |
| fastify | existing | Hook server | No changes |

### Supporting
None — pure internal refactor.

## Architecture Patterns

### Pattern 1: Config-Gated Output Suppression

**What:** A helper function that checks both the config flag and the subagent tracker state to determine if output should be shown.

**When to use:** At every call site that posts sub-agent output to Telegram.

**Example:**
```typescript
// src/index.ts or extracted utility
function shouldSuppressSubagent(sessionId: string): boolean {
  return !config.subagentOutput && subagentTracker.isSubagentActive(sessionId);
}
```

**Why a helper:** The 5 call sites all need the same check. A helper:
1. Prevents inconsistency (missed call sites)
2. Makes Phase 12 easier — replace `config.subagentOutput` with `settingsManager.get('subagentOutput')` in one place
3. Can add console logging for debugging suppressed output

### Pattern 2: Existing Boolean Config Pattern

**What:** The codebase already has `autoApprove: boolean` on AppConfig parsed from `AUTO_APPROVE` env var. Follow the exact same pattern.

**Example (existing):**
```typescript
// types/config.ts
autoApprove: boolean;

// config.ts
autoApprove: process.env.AUTO_APPROVE === 'true',
```

**New (same pattern):**
```typescript
// types/config.ts
subagentOutput: boolean;

// config.ts
subagentOutput: process.env.SUBAGENT_VISIBLE === 'true',
```

### Pattern 3: Guard-and-Return vs Guard-and-Skip

**What:** Two gating patterns for the different call sites.

**onSubagentStart/onSubagentStop:** Guard the entire batcher call:
```typescript
if (config.subagentOutput) {
  await batcher.enqueueImmediate(session.threadId, spawnHtml);
}
```

**onToolUse:** Guard only the subagent prefix branch, but ALSO skip the main display when suppressed:
```typescript
if (activeAgent) {
  if (!config.subagentOutput) return; // Suppress entire tool display for subagent
  displayLine = prefix + result.compact;
} else {
  displayLine = result.compact;
}
```

**Hook server auto-approve callback:** Guard the subagent branch:
```typescript
if (activeAgent) {
  if (config.subagentOutput) {
    // show prefixed line
    batcher.enqueue(...);
  }
  // Always track for PostToolUse dedup regardless
  autoApprovedToolUseIds.add(toolUseId);
} else {
  // main agent lightning display (unchanged)
}
```

### Anti-Patterns to Avoid
- **Touching SubagentTracker internals:** The tracker must remain purely state-tracking with no Telegram awareness
- **Gating PreToolUse approval:** Sub-agent approval requests MUST always show — user safety trumps suppression
- **Gating subagentTracker.start()/stop()/stashDescription():** These must always execute for accurate state tracking
- **Filtering at batcher level:** Suppression must happen at the call site, not inside MessageBatcher — the batcher has no session/agent awareness

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime config toggle | Dynamic config reloading system | Static AppConfig now, Phase 12 settings manager later | Phase 10 scope is env var only |
| Per-session suppression | Session-level toggle storage | Global config flag | Phase 12 scope; AGNT-04 is v5+ |
| Output filtering middleware | MessageBatcher filter layer | Call-site guards | Simpler, more explicit, easier to audit |

## Common Pitfalls

### Pitfall 1: Suppressed Tool Still Updating Status Message
**What goes wrong:** onToolUse returns early for suppressed sub-agent tools, but the status message update (monitor.statusMessage.requestUpdate) and toolCallCount increment still happen at the session store level.
**Why it happens:** The hook handler in handlers.ts increments toolCallCount before calling onToolUse.
**How to avoid:** This is actually fine — internal counters should stay accurate even when display is suppressed. The status message shows session-level data (context %, duration) not per-tool data.
**Warning signs:** If status message starts showing sub-agent tool names when suppressed, the guard placement is wrong.

### Pitfall 2: PostToolUse Dedup Not Working After Suppression
**What goes wrong:** In the hook server auto-approve callback, if we skip `autoApprovedToolUseIds.add(toolUseId)` when suppressing, the PostToolUse handler will try to display the tool again.
**Why it happens:** The dedup set must be populated regardless of display.
**How to avoid:** Always add to `autoApprovedToolUseIds` even when display is suppressed. The guard should only wrap the `batcher.enqueue` call, not the dedup tracking.

### Pitfall 3: Expand Cache Pollution from Suppressed Tools
**What goes wrong:** If onToolUse suppresses display but still pushes to `pendingExpandData`, the expand cache gets entries that reference messages that were never sent.
**Why it happens:** The expand data push happens before the display.
**How to avoid:** Return early from onToolUse before both the display AND the expand data push when suppressing sub-agent output.

### Pitfall 4: onSidechainMessage Missing Guard
**What goes wrong:** Sub-agent text output still appears because the `onSidechainMessage` callback in `initMonitoring` was not gated.
**Why it happens:** It's inside a closure passed to TranscriptWatcher, easy to miss.
**How to avoid:** Add the guard as the first check inside the `onSidechainMessage` callback, before the existing `if (!activeAgent) return` check.

### Pitfall 5: Topic Status Flicker from Suppressed Tools
**What goes wrong:** `topicStatusManager.setStatus(session.threadId, 'yellow')` in onToolUse fires for suppressed sub-agent tools, causing the topic to flicker yellow even though the user sees nothing.
**Why it happens:** The status update happens before the display guard.
**How to avoid:** Move the status update after the subagent suppression check, or only update status for main-chain tools.

## Code Examples

### 5 Call Sites to Gate

**Call site 1: onSubagentStart (index.ts ~line 782)**
```typescript
onSubagentStart: async (session, payload) => {
  // Always track (unconditional)
  const agent = subagentTracker.start(session.sessionId, payload.agent_id, payload.agent_type);

  // Gate display
  if (config.subagentOutput) {
    const indent = subagentTracker.getIndent(agent.agentId);
    const spawnHtml = formatSubagentSpawn(agent.displayName, agent.description, indent);
    await batcher.enqueueImmediate(session.threadId, spawnHtml);
  }

  console.log(`[AGENT] Subagent ${agent.displayName} (${payload.agent_id}) spawned for session ${session.sessionId} (depth ${agent.depth})`);
},
```

**Call site 2: onSubagentStop (index.ts ~line 798)**
```typescript
onSubagentStop: async (session, payload) => {
  // Always track (unconditional)
  const result = subagentTracker.stop(payload.agent_id);
  if (!result) { ... return; }

  // Gate display
  if (config.subagentOutput) {
    const indentStr = '  '.repeat(Math.min(result.agent.depth, 2));
    const doneHtml = formatSubagentDone(result.agent.displayName, result.durationMs, indentStr);
    await batcher.enqueueImmediate(session.threadId, doneHtml);
  }

  console.log(`[AGENT] Subagent ${result.agent.displayName} done after ${Math.round(result.durationMs / 1000)}s`);
},
```

**Call site 3: onSidechainMessage in initMonitoring (index.ts ~line 344)**
```typescript
// onSidechainMessage: subagent text output
(rawText) => {
  // Suppress subagent text output if not configured to show
  if (!config.subagentOutput) return;

  const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
  if (!activeAgent) return;
  // ... rest unchanged
},
```

**Call site 4: onToolUse subagent branch (index.ts ~line 641)**
```typescript
const activeAgent = subagentTracker.getActiveAgent(session.sessionId);
let displayLine: string;
if (activeAgent) {
  if (!config.subagentOutput) {
    // Suppress subagent tool display entirely — don't enqueue, don't track expand data
    // Still update status message (internal tracking)
    const monitor = monitors.get(session.sessionId);
    if (monitor) {
      const latestSession = sessionStore.get(session.sessionId);
      if (latestSession) {
        monitor.statusMessage.requestUpdate(buildStatusData(latestSession, payload.tool_name));
      }
    }
    return;
  }
  const indent = subagentTracker.getIndent(activeAgent.agentId);
  const prefix = `${indent}[${escapeHtml(activeAgent.displayName)}] `;
  displayLine = prefix + result.compact;
} else {
  displayLine = result.compact;
}
```

**Call site 5: Hook server auto-approve callback (index.ts ~line 813)**
```typescript
if (activeAgent) {
  if (config.subagentOutput) {
    // Show subagent auto-approved tool
    const result = formatToolCompact({ tool_name: toolName, tool_input: toolInput } as PostToolUsePayload);
    const indent = subagentTracker.getIndent(activeAgent.agentId);
    const prefixedLine = `${indent}[${escapeHtml(activeAgent.displayName)}] ${result.compact}`;
    batcher.enqueue(session.threadId, prefixedLine);
  }
  // Always track for PostToolUse dedup
  autoApprovedToolUseIds.add(toolUseId);
} else {
  // Main agent: unchanged
}
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | No automated test framework detected |
| Config file | None |
| Quick run command | `npx tsc --noEmit` (type check) |
| Full suite command | `npx tsc --noEmit` (type check) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGNT-01 | Sub-agent output suppressed by default | manual | Start bot with default env, trigger sub-agent, verify no output | No automated test |
| AGNT-02 | Sub-agents don't create own topics | manual | Trigger sub-agent, verify no new topic created | No automated test (already passing) |
| AGNT-03 | Toggleable via env var | manual | Start bot with SUBAGENT_VISIBLE=true, verify output shows | No automated test |

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit`
- **Per wave merge:** `npx tsc --noEmit` + manual smoke test
- **Phase gate:** Full type check + manual UAT with real sub-agent

### Wave 0 Gaps
None — no test framework to set up. This phase is a config + gating pattern applied to existing code. Type checking ensures no regressions.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Full sub-agent visibility (Phase 8) | Suppressed by default (Phase 10) | Now | Users only see main-chain output unless opt-in |

## Open Questions

1. **Topic status flicker from suppressed sub-agent tools**
   - What we know: `topicStatusManager.setStatus(yellow)` fires in onToolUse for all tools including sub-agent
   - What's unclear: Whether flickering yellow for invisible tools is confusing to users
   - Recommendation: Leave as-is for Phase 10 — the yellow status provides useful "something is happening" feedback. If users report confusion, address in Phase 12.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of `src/index.ts` (957 lines)
- Direct codebase analysis of `src/monitoring/subagent-tracker.ts` (207 lines)
- Direct codebase analysis of `src/types/config.ts` and `src/config.ts`
- CONTEXT.md from discuss-phase (5 call sites pre-identified)

### Secondary (MEDIUM confidence)
- None needed — all implementation details are in the codebase

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries, pure internal modification
- Architecture: HIGH - gating pattern well-understood, 5 call sites precisely identified
- Pitfalls: HIGH - identified from direct code reading (expand cache, dedup, sidechain)

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable — internal codebase patterns don't expire)
