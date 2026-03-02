# Phase 10: Sub-Agent Suppression - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Suppress all sub-agent output by default — no spawn/done announcements, no tool calls, no text output. Sub-agents do not create their own Telegram topics. SubagentTracker continues running internally for correct tool attribution. Configurable via env var; Phase 12 adds Telegram settings UI later.

</domain>

<decisions>
## Implementation Decisions

### Suppression scope
- **Truly invisible by default**: When suppressed, zero sub-agent output reaches Telegram — no spawn announcement, no done announcement, no tool calls, no text output
- Sub-agent tool calls from the `onToolUse` callback are fully hidden (not shown as anonymous main-chain tools)
- Auto-approved sub-agent tools from the hook server callback are also hidden
- The `[AgentName]` prefixed tool lines and text lines all suppressed
- `onPreToolUse` approval requests from sub-agents should still show (user needs to approve/deny regardless of visibility setting)

### SubagentTracker behavior
- `SubagentTracker.start()` and `.stop()` are called unconditionally — tracker state must stay accurate
- `isSubagentActive()` continues to work correctly — used for tool attribution logic
- Only the Telegram posting (batcher.enqueue/enqueueImmediate) calls are gated by the suppression flag
- Description stashing from PreToolUse(Agent) also continues unconditionally

### Sub-agent topic prevention
- Sub-agents do not create separate Telegram topics — they share the parent session's topic (already the case in current code)
- If a sub-agent somehow triggers a new session registration, it should be suppressed when the flag is off

### Configuration
- New env var: `SUBAGENT_VISIBLE` (default: `false`)
- New field in `AppConfig`: `subagentOutput: boolean`
- Env var only until Phase 12 adds the settings topic toggle
- When `subagentOutput` is `true`, behavior is identical to current v3.0 (full visibility)

### Claude's Discretion
- Whether to check the flag at each call site individually or create a helper function
- Whether `subagentOutput` should be on `AppConfig` (immutable) or prepared for runtime override (Phase 12)
- Log-level console output when suppressing (e.g., `[AGENT] Suppressed spawn: AgentName`)

</decisions>

<specifics>
## Specific Ideas

- User's original words: "I don't want sub-agents (i.e. non-interactive agents) to get their own telegram topic, they should not communicate at all unless configured"
- The emphasis on "at all" means zero residual output — not even a summary line
- PreToolUse approval for sub-agent actions must still work (user safety trumps suppression)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SubagentTracker` (`src/monitoring/subagent-tracker.ts`): Pure state tracker, no Telegram dependencies — safe to always run
- `subagentTracker.isSubagentActive()`: Used in `onToolUse` for prefix logic — must stay functional
- `AppConfig` (`src/types/config.ts`): Configuration interface — add `subagentOutput` field
- `loadConfig()` (`src/config.ts`): Config loader — add `SUBAGENT_VISIBLE` env var parsing

### Established Patterns
- Boolean config flags: `autoApprove` in AppConfig (parsed from env in loadConfig())
- Suppression already exists conceptually: `isProceduralNarration()` filters short narration from output

### Integration Points — 5 call sites to gate
1. **`onSubagentStart`** (index.ts ~line 746): `batcher.enqueueImmediate(threadId, spawnHtml)` — gate this
2. **`onSubagentStop`** (index.ts ~line 762): `batcher.enqueueImmediate(threadId, doneHtml)` — gate this
3. **`onSidechainMessage`** callback in `initMonitoring` (index.ts ~line 339): `batcher.enqueue(threadId, prefix + html)` — gate this
4. **`onToolUse`** (index.ts ~line 622): Subagent prefix block `if (activeAgent) { ... displayLine = prefix + result.compact }` — gate this, fall through to main-chain display only
5. **Hook server auto-approve callback** (index.ts ~line 788): Subagent auto-approved tool display `if (activeAgent) { ... batcher.enqueue(threadId, prefixedLine) }` — gate this

### What NOT to touch
- `subagentTracker.start()` / `.stop()` calls — always execute
- `subagentTracker.stashDescription()` calls — always execute
- `onPreToolUse` sub-agent approval requests — always show (user must approve)
- `subagentTracker.cleanup()` calls — always execute

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 10-sub-agent-suppression*
*Context gathered: 2026-03-02*
