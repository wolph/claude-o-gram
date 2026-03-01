# Technology Stack: v2.0 SDK Migration

**Project:** Claude Code Telegram Bridge
**Researched:** 2026-03-01
**Focus:** Stack changes needed for Claude Agent SDK migration
**Overall Confidence:** HIGH

## Executive Summary

The v2.0 migration replaces the fragile tmux/HTTP-hook/JSONL-watching architecture with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). This is primarily a **subtraction**: the SDK subsumes the Fastify HTTP hook server, the tmux text injection layer, the JSONL transcript watcher, and the hook auto-installer. One package is added (the SDK itself plus its Zod peer dependency), and two packages are removed (Fastify and Pino). The existing grammY Telegram stack, TypeScript toolchain, and all monitoring/formatting code remain unchanged.

## Current Stack (v1.0)

| Package | Version | Purpose | v2.0 Status |
|---------|---------|---------|-------------|
| `grammy` | ^1.40.1 | Telegram bot framework | **KEEP** |
| `@grammyjs/auto-retry` | ^2.0.2 | Auto-retry on Telegram rate limits | **KEEP** |
| `@grammyjs/parse-mode` | ^2.2.1 | HTML parse mode plugin | **KEEP** |
| `@grammyjs/transformer-throttler` | ^1.2.1 | Message throttling | **KEEP** |
| `fastify` | ^5.7.4 | HTTP server for hook POSTs | **REMOVE** |
| `pino` | ^10.3.1 | Logging (Fastify default logger) | **REMOVE** |
| `dotenv` | ^17.3.1 | Environment variable loading | **KEEP** |
| `typescript` | ^5.9.3 | Build toolchain (dev) | **KEEP** |
| `@types/node` | ^25.3.2 | Node.js type definitions (dev) | **KEEP** |

## Recommended Stack Changes

### ADD: @anthropic-ai/claude-agent-sdk

| Property | Value |
|----------|-------|
| **Package** | `@anthropic-ai/claude-agent-sdk` |
| **Version** | `^0.2.63` (latest as of 2026-03-01) |
| **Confidence** | HIGH -- verified via `npm view`, official docs, changelog |
| **Purpose** | Replaces Fastify hook server, tmux injection, JSONL transcript watching |
| **Node.js requirement** | `>=18.0.0` (project already requires `>=20.0.0`, compatible) |
| **Peer dependency** | `zod@^4.0.0` (must be installed alongside) |
| **License** | Proprietary (Anthropic Commercial Terms of Service) |

**Why this package:**
- Official programmatic interface to Claude Code -- same tools, agent loop, and context management
- `query()` function returns an async generator streaming `SDKMessage` events that replace ALL three v1 data sources:
  - `SDKAssistantMessage` replaces JSONL transcript watching (text output)
  - `PostToolUse` hook callbacks replace HTTP POST handlers (tool call events)
  - `canUseTool` callback replaces HTTP PreToolUse blocking endpoint (approval flow)
- `streamInput()` / AsyncIterable prompt replaces tmux `send-keys` (text input injection)
- Session management (create, resume, fork) replaces our manual session tracking from hook payloads
- Cross-platform -- no tmux dependency

**Release cadence:** Very frequent (every 1-3 days), tracks Claude Code CLI versions. The `0.x` version indicates pre-1.0 but the API is stable with backward-compatible incremental changes. Pin to `^0.2.63` and expect regular updates.

**Source:** [npm package](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | [GitHub](https://github.com/anthropics/claude-agent-sdk-typescript) | [Official docs](https://platform.claude.com/docs/en/agent-sdk/typescript)

### ADD: zod

| Property | Value |
|----------|-------|
| **Package** | `zod` |
| **Version** | `^4.0.0` (peer dep requirement; latest is 4.3.6) |
| **Confidence** | HIGH -- required peer dependency, verified via `npm view` |
| **Purpose** | Required peer dependency of the Agent SDK; also used for `tool()` MCP definitions |
| **Direct use** | Not required for our use case (we are not defining custom MCP tools via `tool()`), but must be installed to satisfy peer dependency |

**Why Zod 4:** The SDK requires `^4.0.0` specifically. Zod 4 is a major version bump from Zod 3 with a different API surface. Since we only need it as a peer dep (not for direct schema validation in our code), this is a transparent dependency.

**Source:** [npm peer dependency metadata](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

### REMOVE: fastify

| Property | Value |
|----------|-------|
| **Package** | `fastify` |
| **Current version** | ^5.7.4 |
| **Why remove** | The SDK's `query()` async generator and hook callbacks eliminate the need for an HTTP server. Hook events arrive as `SDKMessage` stream events and `canUseTool` callbacks, not HTTP POSTs. |
| **Migration impact** | Delete `src/hooks/server.ts`. Rewrite `src/hooks/handlers.ts` to process `SDKMessage` events instead of HTTP payloads. Delete `src/utils/install-hooks.ts` (no hook config to install). |

### REMOVE: pino

| Property | Value |
|----------|-------|
| **Package** | `pino` |
| **Current version** | ^10.3.1 |
| **Why remove** | Only used as Fastify's default logger (`Fastify({ logger: true })`). With Fastify removed, Pino has no consumers. Use `console.log`/`console.warn`/`console.error` for basic logging (sufficient for a single-machine daemon). |
| **Migration impact** | Minimal. All existing log calls already use `console.*`. |

### KEEP UNCHANGED

The following packages require no changes:

| Package | Rationale |
|---------|-----------|
| `grammy` + plugins | Telegram bot layer is orthogonal to the Claude interface. The bot still manages topics, sends messages, handles callback queries. Nothing changes. |
| `dotenv` | Still needed to load `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and now `ANTHROPIC_API_KEY`. |
| `typescript` | Build toolchain. May need `target` bump for `await using` (V2 SDK preview), but V1 `query()` API works with current `ES2022` target. |
| `@types/node` | Node.js types. No change needed. |

## SDK API Surface Mapping

How each v1.0 mechanism maps to the SDK.

### Session Lifecycle

| v1.0 | v2.0 SDK |
|------|----------|
| HTTP POST `/hooks/session-start` with `SessionStartPayload` | `SDKSystemMessage` with `subtype: "init"` contains `session_id`, `cwd`, `tools` |
| HTTP POST `/hooks/session-end` with `SessionEndPayload` | `SDKResultMessage` with `subtype: "success"` or `"error_*"` indicates session/query completion |
| `installHooks()` writing to `~/.claude/settings.json` | Not needed -- SDK spawns Claude Code internally, no hook config required |
| `SessionStore.getActiveByCwd()` resume detection | `options.resume: sessionId` for session resumption |

### Tool Call Monitoring

| v1.0 | v2.0 SDK |
|------|----------|
| HTTP POST `/hooks/post-tool-use` | `SDKAssistantMessage` with `message.content` containing `tool_use` blocks |
| `PostToolUsePayload.tool_name`, `tool_input`, `tool_response` | `content_block.name`, `content_block.input`; tool results arrive as `SDKUserMessage` with `tool_use_result` |
| SDK hooks for programmatic callbacks | `hooks.PostToolUse` callback receives `PostToolUseHookInput` with `tool_name`, `tool_input`, `tool_response`, `tool_use_id` |
| Verbosity filter in handler | Same filter logic, applied to SDK hook events or stream messages |

### Text Output Capture

| v1.0 | v2.0 SDK |
|------|----------|
| `TranscriptWatcher` tailing JSONL file with `fs.watch` | `SDKAssistantMessage.message.content` text blocks in the stream |
| `onAssistantMessage(text)` callback | Filter `message.content` for `block.type === "text"` blocks |
| Real-time streaming via `includePartialMessages: true` | `SDKPartialAssistantMessage` (type `"stream_event"`) with `content_block_delta` events |
| `calculateContextPercentage()` from token usage | `SDKAssistantMessage.message.usage` contains `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Context compaction detection | `SDKCompactBoundaryMessage` with `subtype: "compact_boundary"` |

### Approval Flow

| v1.0 | v2.0 SDK |
|------|----------|
| HTTP POST `/hooks/pre-tool-use` (blocking, long timeout) | `canUseTool` callback in `Options` |
| `PreToolUsePayload` with `tool_name`, `tool_use_id`, `tool_input` | `canUseTool(toolName, input, options)` where `options.toolUseID` provides the ID |
| `ApprovalManager.waitForDecision()` deferred promise | Same pattern: `canUseTool` returns a `Promise<PermissionResult>` that resolves when user decides |
| Return `{ permissionDecision: "allow" }` HTTP response | Return `{ behavior: "allow", updatedInput }` from callback |
| Return `{ permissionDecision: "deny" }` HTTP response | Return `{ behavior: "deny", message: "reason" }` from callback |
| Auto-approve if `permission_mode === "bypassPermissions"` | Set `permissionMode: "bypassPermissions"` in SDK options (SDK handles it) |

### Text Input Injection

| v1.0 | v2.0 SDK |
|------|----------|
| `tmux send-keys` / `paste-buffer` via `TextInputManager.inject()` | `query()` with `AsyncIterable<SDKUserMessage>` prompt (streaming input mode) |
| Queue text then inject on next poll | Yield new `SDKUserMessage` from the async generator when user sends text |
| Bracketed paste workaround for Ink | Not needed -- SDK accepts structured messages, not terminal keystrokes |
| `tmux` availability check | Not needed -- SDK is cross-platform |

### Notifications

| v1.0 | v2.0 SDK |
|------|----------|
| HTTP POST `/hooks/notification` | `hooks.Notification` callback OR `SDKStatusMessage` / `SDKTaskNotificationMessage` in stream |
| `NotificationPayload.notification_type` | `NotificationHookInput.notification_type` in hook callback |

## Key SDK Concepts for v2.0

### Streaming Input Mode (Required)

The bot MUST use **streaming input mode** because it needs multi-turn interaction (user sends text from Telegram mid-session). This means passing an `AsyncIterable<SDKUserMessage>` as the `prompt` parameter:

```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// AsyncGenerator that yields user messages on demand
async function* userMessageStream(): AsyncGenerator<SDKUserMessage> {
  // Yield initial prompt
  yield {
    type: "user",
    session_id: "",
    message: { role: "user", content: "Initial task prompt" },
    parent_tool_use_id: null,
  };

  // Later, when Telegram user sends text:
  // yield another SDKUserMessage from a queued promise
}

const q = query({
  prompt: userMessageStream(),
  options: {
    permissionMode: "default",
    canUseTool: async (toolName, input, opts) => {
      // Post to Telegram, wait for Approve/Deny button press
      // Return { behavior: "allow" } or { behavior: "deny", message: "..." }
    },
    includePartialMessages: true, // For real-time tool call streaming
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  },
});

for await (const message of q) {
  // Route to Telegram based on message.type
}
```

The `Query` object also provides `streamInput(stream)` for sending additional messages and `interrupt()` for cancellation.

### V1 vs V2 API Decision

**Use V1 `query()` API.** The V2 `unstable_v2_createSession()` interface is simpler for multi-turn but:
- All exports prefixed `unstable_` -- API may change without notice
- Missing some features (session forking)
- V1 is mature, well-documented, and production-ready
- V1 streaming input mode (`AsyncIterable<SDKUserMessage>`) handles our multi-turn needs

Revisit V2 when it drops the `unstable_` prefix and reaches feature parity.

### Authentication

The SDK requires an API key via one of:
1. `ANTHROPIC_API_KEY` environment variable (default, recommended)
2. `CLAUDE_CODE_USE_BEDROCK=1` for AWS Bedrock
3. `CLAUDE_CODE_USE_VERTEX=1` for Google Vertex AI

Use `ANTHROPIC_API_KEY` in the `.env` file (loaded by `dotenv`). This is a **new** environment variable -- v1.0 did not require an API key because it attached to externally-launched Claude Code sessions.

### Permission Mode

Use `permissionMode: "default"` with a `canUseTool` callback. This is the only mode that gives us programmatic control over individual approval decisions. The other modes either auto-approve everything (`bypassPermissions`, `acceptEdits`) or deny without callback (`dontAsk`).

Processing order: PreToolUse Hook -> Deny Rules -> Allow Rules -> Ask Rules -> Permission Mode Check -> `canUseTool` Callback -> PostToolUse Hook.

### SDK Message Types (Key Ones)

| Type | Constant | When It Fires | What We Do |
|------|----------|---------------|------------|
| `SDKSystemMessage` | `type: "system", subtype: "init"` | Session start | Create Telegram topic, capture `session_id` |
| `SDKAssistantMessage` | `type: "assistant"` | Each assistant turn completes | Extract text blocks -> post to topic; extract tool_use blocks -> post tool calls |
| `SDKPartialAssistantMessage` | `type: "stream_event"` | Token-by-token streaming | Real-time tool call detection (`content_block_start` for tool_use) |
| `SDKUserMessage` | `type: "user"` | User turn (including tool results) | Ignore (we generate these) |
| `SDKResultMessage` | `type: "result"` | Query completes | Close topic, post summary |
| `SDKCompactBoundaryMessage` | `type: "system", subtype: "compact_boundary"` | Context compacted | Post context warning |
| `SDKStatusMessage` | `type: "status"` | Status updates | Update status message |
| `SDKToolUseSummaryMessage` | `type: "tool_use_summary"` | Tool call summary | Post summary to topic |

### Query Object Methods

| Method | Purpose | Our Use |
|--------|---------|---------|
| `interrupt()` | Cancel current turn | When user sends /stop from Telegram |
| `close()` | Terminate session | On session end or bot shutdown |
| `streamInput(stream)` | Send additional messages | Inject user text from Telegram replies |
| `setPermissionMode(mode)` | Change permission mode | Not needed (always "default") |

## Installation Commands

```bash
# Add new dependencies
npm install @anthropic-ai/claude-agent-sdk zod

# Remove obsolete dependencies
npm uninstall fastify pino
```

## Environment Variables

### New

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude API authentication for SDK |

### Unchanged

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | grammY bot authentication |
| `TELEGRAM_CHAT_ID` | Yes | Target Telegram group |
| `DEFAULT_VERBOSITY` | No | Message verbosity filter |
| `APPROVAL_TIMEOUT_MS` | No | How long to wait for user approval |
| `SUMMARY_INTERVAL_MS` | No | Periodic summary frequency |

### Removed

| Variable | Reason |
|----------|--------|
| `HOOK_SERVER_PORT` | No HTTP server needed |
| `HOOK_SERVER_HOST` | No HTTP server needed |

## TypeScript Configuration

Current `tsconfig.json` works as-is for V1 SDK API:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true
  }
}
```

No changes needed. If V2 preview is adopted later (uses `await using`), bump target to `ES2024` or add `lib: ["ESNext.Disposable"]`.

## Source File Impact Analysis

### Files to DELETE

| File | Reason |
|------|--------|
| `src/hooks/server.ts` | Fastify HTTP server -- replaced by SDK stream |
| `src/utils/install-hooks.ts` | Hook auto-installer -- SDK spawns Claude internally |
| `src/monitoring/transcript-watcher.ts` | JSONL file watcher -- replaced by SDK stream events |
| `src/control/input-manager.ts` | tmux text injection -- replaced by SDK streaming input |

### Files to REWRITE

| File | Change |
|------|--------|
| `src/hooks/handlers.ts` | Transform from HTTP payload handlers to SDK message/hook processors |
| `src/index.ts` | Replace Fastify server + hook install with SDK `query()` loop |
| `src/types/hooks.ts` | Replace custom hook payload types with SDK-provided types |
| `src/types/sessions.ts` | Simplify: remove `tmuxPane`, `transcriptPath` fields |
| `src/config.ts` | Remove hook server config, add API key config |

### Files to KEEP (Minor Updates)

| File | Change |
|------|--------|
| `src/bot/bot.ts` | No change -- grammY bot setup is independent |
| `src/bot/topics.ts` | No change -- topic management is independent |
| `src/bot/rate-limiter.ts` | No change -- Telegram rate limiting still needed |
| `src/bot/formatter.ts` | Minor updates to accept SDK types instead of custom hook types |
| `src/monitoring/status-message.ts` | Minor updates -- data source changes but status message logic stays |
| `src/monitoring/summary-timer.ts` | Minor updates -- same concept, different data source |
| `src/monitoring/verbosity.ts` | No change -- filter logic is independent of data source |
| `src/control/approval-manager.ts` | Minor refactor -- same deferred-promise pattern, now resolves `PermissionResult` instead of custom type |
| `src/sessions/session-store.ts` | Simplify -- remove tmux-specific fields |
| `src/utils/text.ts` | No change -- text formatting utilities are independent |

## Version Compatibility Matrix

| Component | Minimum | Current | Notes |
|-----------|---------|---------|-------|
| Node.js | 18.0.0 (SDK) / 20.0.0 (project) | 25.0.0 | Project min is stricter, compatible |
| TypeScript | 5.0 (SDK V1) / 5.2 (SDK V2) | 5.9.3 | Compatible with both V1 and V2 |
| Zod | 4.0.0 | 4.3.6 | Required peer dependency |
| grammY | 1.x | 1.40.1 | Independent of SDK, no change |
| Agent SDK | 0.2.63 | 0.2.63 | Pin to ^0.2.x for stability |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Claude interface | Agent SDK `query()` | Raw Anthropic API SDK (`@anthropic-ai/sdk`) | SDK provides built-in tools, agent loop, context management. Raw API requires implementing tool execution ourselves -- thousands of lines of code we don't need to write. |
| Claude interface | Agent SDK `query()` | Claude Code CLI (`--print`, `--output-format stream-json`) | CLI is for one-shot tasks or CI. No `canUseTool` callback support for programmatic approval. |
| SDK API version | V1 `query()` | V2 `unstable_v2_createSession()` | V2 is unstable preview, missing features. V1 is production-ready. |
| Session model | Streaming input (AsyncIterable) | Single message + resume | Streaming gives real-time multi-turn, which maps directly to Telegram conversation flow. Single message + resume adds latency per turn and loses in-progress context. |
| Logging | `console.*` | Pino standalone | Overkill for a single-machine daemon. Can add structured logging later if needed. |
| HTTP hook bridge | Remove entirely | Keep Fastify alongside SDK | Redundant. SDK hooks are in-process callbacks, not HTTP endpoints. No reason to keep a server. |
| Session model | Bot manages sessions | Attach to external sessions | v1.0 attached to externally-launched sessions. v2.0 bot launches and manages Claude Code directly via SDK, giving full lifecycle control. |

## SDK Versioning Risk Assessment

The SDK is at `0.2.x` (pre-1.0). Mitigations:

1. **Rapid release cadence** (every 1-3 days) means bugs get fixed quickly
2. **No breaking changes** observed in recent changelog (0.2.40 through 0.2.63)
3. **Parity with Claude Code CLI** -- SDK version tracks CLI version, both maintained by Anthropic
4. **V1 API is stable** -- the `query()` function, `SDKMessage` types, and `canUseTool` callback have been stable across all 0.2.x releases
5. The `0.x` version primarily reflects the rapid iteration pace, not instability
6. Pin to `^0.2.63` to get patches but avoid hypothetical future major changes

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| SDK package choice | HIGH | Official Anthropic SDK, verified on npm, comprehensive docs |
| SDK API surface (`query`, `canUseTool`, message types) | HIGH | Verified against official TypeScript reference docs |
| Zod peer dependency | HIGH | Verified via `npm view @anthropic-ai/claude-agent-sdk peerDependencies` |
| Removal of Fastify | HIGH | SDK eliminates need for HTTP hook server entirely |
| Removal of Pino | MEDIUM | Only used by Fastify; could add back later for structured logging |
| V1 vs V2 decision | MEDIUM | V2 is objectively simpler but unstable; V1 is safer for production |
| Streaming input pattern for multi-turn | HIGH | Documented with examples, matches our multi-turn Telegram flow exactly |
| canUseTool for approval flow | HIGH | Documented pattern, maps directly to existing `ApprovalManager.waitForDecision()` |
| Token usage from SDK messages | MEDIUM | `message.usage` is documented on `BetaMessage`; exact field mapping for context % needs verification during implementation |

## Sources

- [npm: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- package metadata, version 0.2.63, peer deps confirmed
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- full API: `query()`, `Options`, `CanUseTool`, `PermissionResult`, all `SDKMessage` types
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- capabilities, architecture, built-in tools, hooks, subagents, MCP, permissions, sessions
- [Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart) -- installation, prerequisites (Node.js 18+), basic usage, permission modes
- [Streaming Input Modes](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- streaming vs single message, AsyncIterable pattern, multi-turn flow
- [Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- `includePartialMessages`, `SDKPartialAssistantMessage`, `content_block_delta` events
- [Handle Approvals and User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- `canUseTool` callback, `PermissionResult`, `AskUserQuestion` tool
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- session IDs, resume, fork, persistence
- [TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- `unstable_v2_createSession()`, `send()`, `stream()`, unstable status
- [Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) -- from Claude Code SDK to Agent SDK, breaking changes
- [GitHub Changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) -- release history, version 0.2.63 latest
- `npm view` on local machine -- version 0.2.63, `peerDependencies: { zod: '^4.0.0' }`, `engines: { node: '>=18.0.0' }`

---
*Stack research for: Claude Code Telegram Bridge v2.0 SDK Migration*
*Researched: 2026-03-01*
