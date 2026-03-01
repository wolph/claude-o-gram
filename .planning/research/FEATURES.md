# Feature Landscape: SDK Migration

**Domain:** Claude Agent SDK migration for Claude Code Telegram Bridge
**Researched:** 2026-03-01
**Confidence:** HIGH (based on official SDK documentation at platform.claude.com)

## SDK-to-Current Feature Mapping

The core question: what does the SDK handle natively, and what must the bot still implement?

### Architecture Shift Summary

| Current (v1) | SDK Replacement (v2) | Effort |
|--------------|---------------------|--------|
| Fastify HTTP hook server | SDK `hooks` callbacks in `options` | ELIMINATES server entirely |
| `install-hooks.ts` writing to settings.json | Hooks passed programmatically to `query()` | ELIMINATES file manipulation |
| JSONL transcript file watcher | `stream_event` async generator output | ELIMINATES file I/O watcher |
| tmux `send-keys` / `paste-buffer` | AsyncIterable prompt input (streaming mode) | ELIMINATES tmux dependency |
| Deferred-promise HTTP blocking for approvals | `canUseTool` async callback | SIMPLIFIES approval flow |
| Session discovery via SessionStart HTTP hook | Bot owns session creation via `query()` | INVERTS control flow |
| Session ID from hook payloads | `session_id` from SDK system init message | SIMPLIFIES session tracking |

## Table Stakes (Must Migrate)

Features the bot already has. These MUST work equivalently in v2 or the migration is a regression.

### TS-01: Session Lifecycle Management

**Current:** SessionStart/SessionEnd HTTP hooks fire, bot creates/closes Telegram topics.
**SDK equivalent:** Bot calls `query()` directly, so it owns the session lifecycle. The `system` message with `subtype: "init"` provides the `session_id`. Session ends when the async generator completes or `query.close()` is called.

```typescript
// V2 approach: bot CREATES the session, not discovers it
import { query } from "@anthropic-ai/claude-agent-sdk";

async function* userMessages() {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: promptText }
  };
  // Yield more messages as Telegram user sends them
}

const q = query({
  prompt: userMessages(),
  options: {
    hooks: {
      SessionStart: [{ hooks: [onSessionStart] }],
      SessionEnd: [{ hooks: [onSessionEnd] }]
    }
  }
});

let sessionId: string;
for await (const message of q) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
    // Create Telegram topic here
  }
}
```

**Complexity:** HIGH -- This is the biggest architectural change. The bot shifts from "observer that discovers sessions" to "controller that creates sessions." Requires rethinking when/how sessions start.
**Dependency:** Everything depends on this. Build first.

### TS-02: Tool Call Notifications (PostToolUse)

**Current:** PostToolUse HTTP hook fires, handler posts tool name/input/output to Telegram.
**SDK equivalent:** Two options:
1. **PostToolUse hooks** -- SDK callback hooks receive the same data as HTTP hooks.
2. **AssistantMessage with tool_use blocks** -- Complete messages include tool call info.
3. **StreamEvent (content_block_start/delta/stop)** -- Real-time tool call streaming.

```typescript
// Option 1: PostToolUse hook callback (closest to current behavior)
const onPostToolUse: HookCallback = async (input, toolUseID, { signal }) => {
  const toolInput = input as PostToolUseHookInput;
  await postToTelegram(toolInput.tool_name, toolInput.tool_input);
  return {}; // Don't modify behavior
};

// Option 2: Stream events for real-time tool detection
for await (const message of q) {
  if (message.type === "stream_event") {
    if (message.event.type === "content_block_start"
        && message.event.content_block.type === "tool_use") {
      // Tool call starting -- post to Telegram
    }
  }
  if (message.type === "assistant") {
    // Complete message with all tool_use blocks
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        // Post completed tool call to Telegram
      }
    }
  }
}
```

**Recommendation:** Use PostToolUse hooks for consistency with current behavior. The hook provides tool_name, tool_input, and tool output in a familiar format. Stream events add real-time tool progress (tool starting -> input streaming -> complete) but require more complex state management.
**Complexity:** LOW -- Direct mapping from HTTP hook handler to SDK callback hook.

### TS-03: Claude Text Output Capture

**Current:** TranscriptWatcher parses JSONL file, extracts assistant text blocks, posts to Telegram.
**SDK equivalent:** The async generator yields `AssistantMessage` objects with text content. With `includePartialMessages: true`, you also get `stream_event` messages with `text_delta` events for real-time streaming.

```typescript
for await (const message of query({
  prompt: userMessages(),
  options: { includePartialMessages: true }
})) {
  if (message.type === "assistant") {
    // Complete assistant response -- extract text
    const text = message.message.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    if (text) postToTelegram(text);
  }
  // OR for real-time streaming:
  if (message.type === "stream_event"
      && message.event.type === "content_block_delta"
      && message.event.delta.type === "text_delta") {
    accumulateText(message.event.delta.text);
  }
}
```

**Recommendation:** Use `AssistantMessage` (complete messages) rather than stream events. Telegram rate limits (20 msg/min) make token-by-token streaming pointless. Wait for the complete assistant message, then post it. This eliminates the entire TranscriptWatcher class.
**Complexity:** LOW -- Much simpler than current file watcher approach.

### TS-04: Tool Approval Flow (PreToolUse)

**Current:** PreToolUse HTTP hook blocks the connection, ApprovalManager creates a deferred promise, Telegram inline keyboard posted, user taps Approve/Deny, promise resolves, HTTP response sent to Claude Code.
**SDK equivalent:** `canUseTool` callback is an async function that pauses execution until it returns. Same deferred-promise pattern works, but no HTTP layer.

```typescript
const q = query({
  prompt: userMessages(),
  options: {
    permissionMode: "default",
    canUseTool: async (toolName, input, { signal, toolUseID }) => {
      // Post approval request to Telegram with inline keyboard
      const msg = await bot.api.sendMessage(chatId, formatApproval(toolName, input), {
        message_thread_id: threadId,
        reply_markup: makeApprovalKeyboard(toolUseID)
      });

      // Wait for user decision (same deferred promise pattern)
      const decision = await approvalManager.waitForDecision(
        toolUseID, sessionId, threadId, msg.message_id, toolName
      );

      if (decision === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Denied by user via Telegram" };
    }
  }
});
```

**Key insight:** The `canUseTool` callback receives a `signal: AbortSignal` for cancellation. The existing ApprovalManager pattern (deferred promise + timeout) maps directly. The HTTP layer disappears entirely.
**Complexity:** MEDIUM -- Same core logic, but must handle AbortSignal integration and removal of HTTP blocking semantics.

### TS-05: User Text Input

**Current:** TextInputManager uses tmux `send-keys` / `paste-buffer` to inject text. Fragile, Linux-only, fails with Ink's bracketed paste handling.
**SDK equivalent:** Streaming input mode -- `prompt` accepts an `AsyncIterable<SDKUserMessage>`. The bot controls an async generator that yields messages when the Telegram user sends text.

```typescript
// Create a controllable message stream
class TelegramInputBridge {
  private pending: Array<{
    resolve: (msg: SDKUserMessage) => void;
  }> = [];
  private queue: SDKUserMessage[] = [];

  // Called when Telegram user sends a message in the session topic
  sendMessage(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text }
    };
    if (this.pending.length > 0) {
      this.pending.shift()!.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // Async generator that yields messages to the SDK
  async *stream(): AsyncIterable<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        yield await new Promise<SDKUserMessage>(resolve => {
          this.pending.push({ resolve });
        });
      }
    }
  }
}

const bridge = new TelegramInputBridge();
const q = query({ prompt: bridge.stream(), options: { ... } });

// When Telegram message arrives:
bridge.sendMessage(telegramMessage.text);
```

**This is the killer feature of the SDK migration.** The current tmux injection is the most fragile part of v1. The SDK's async iterable input is clean, cross-platform, and officially supported.
**Complexity:** MEDIUM -- The async generator bridge pattern requires careful lifecycle management (what happens when session ends while user is typing?).

### TS-06: Notification Forwarding

**Current:** Notification HTTP hook fires, handler posts notification to Telegram topic.
**SDK equivalent:** `Notification` hook callback receives the same data.

```typescript
const onNotification: HookCallback = async (input, toolUseID, { signal }) => {
  const notification = input as NotificationHookInput;
  await postToTelegram(notification.message);
  return {};
};

// Register in options:
hooks: {
  Notification: [{ hooks: [onNotification] }]
}
```

**Complexity:** LOW -- Direct 1:1 mapping.

### TS-07: Message Batching / Rate Limiting

**Current:** MessageBatcher queues messages and respects Telegram's 20 msg/min limit.
**SDK equivalent:** No SDK equivalent. The bot still needs its own rate limiting for Telegram API calls. The SDK doesn't interact with Telegram.

**Complexity:** NONE -- MessageBatcher and rate limiter are preserved as-is. They are Telegram-side concerns, not Claude-side.

### TS-08: Status Messages

**Current:** StatusMessage posts and edits a pinned message showing context %, tool count, duration.
**SDK equivalent:** Partially. The SDK provides token usage in `message_delta` stream events (`usage` field). Context percentage calculation moves from transcript parsing to stream event extraction.

```typescript
if (message.type === "stream_event"
    && message.event.type === "message_delta") {
  const usage = message.event.usage;
  if (usage) {
    updateContextPercent(usage);
  }
}
```

**Complexity:** LOW -- StatusMessage class stays, but usage data source changes from transcript parsing to stream events.

### TS-09: Verbosity Filtering

**Current:** `shouldPostToolCall()` filters which tools get posted based on verbosity tier.
**SDK equivalent:** No SDK equivalent. Verbosity filtering is a Telegram UX feature. The bot still applies the same filter before posting to Telegram.

**Complexity:** NONE -- Verbosity module preserved as-is.

### TS-10: Summary Timer

**Current:** SummaryTimer posts periodic aggregated status every N minutes.
**SDK equivalent:** No SDK equivalent. This is a Telegram UX feature.

**Complexity:** NONE -- SummaryTimer preserved as-is.

## Differentiators (SDK Enables New Capabilities)

Features the SDK makes possible that v1 could not do.

### DF-01: Bot-Initiated Sessions

**Current:** Impossible. Bot only discovers externally-launched sessions via hooks.
**SDK equivalent:** Bot calls `query()` directly. User can send a message in Telegram to start a new Claude session.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Start session from Telegram | User sends a prompt in a "new session" topic or command; bot creates query() | MEDIUM | PROJECT.md defers to v2.1, but SDK makes it straightforward |
| Session resume from Telegram | User sends `/resume` with session ID; bot calls query() with `resume` option | LOW | SDK handles all context restoration |

**Note:** PROJECT.md marks "Starting sessions from Telegram" as out of scope for v2.0. However, the SDK migration REQUIRES the bot to create sessions (since there's no external Claude Code process to hook into). The question becomes: does the Telegram user initiate sessions, or does the user still start Claude Code at the terminal and the bot attaches?

**Critical architectural decision:** If the bot IS the Claude Code process (via SDK), then session initiation from Telegram becomes the default flow, not a deferred feature. This changes the product model fundamentally.

### DF-02: Dynamic Permission Mode Changes

**Current:** Permission mode is static (based on Claude Code's own config).
**SDK equivalent:** `query.setPermissionMode()` can change permissions mid-session.

```typescript
// Start restrictive, loosen after trust builds
await q.setPermissionMode("acceptEdits");
```

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `/yolo` command in Telegram | Switch to bypassPermissions for current session | LOW | One API call |
| `/careful` command | Switch back to default mode | LOW | One API call |

**Complexity:** LOW -- Trivial to wire to Telegram commands.

### DF-03: Session Interruption

**Current:** No way to interrupt a running Claude session from Telegram.
**SDK equivalent:** `query.interrupt()` pauses the current operation.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `/stop` command | Interrupt current Claude operation | LOW | Call `q.interrupt()` |
| Interrupt on deny | When user denies a tool, optionally interrupt the whole turn | LOW | Return `{ behavior: "deny", interrupt: true }` in canUseTool |

**Complexity:** LOW -- SDK provides the mechanism.

### DF-04: Streaming Tool Progress

**Current:** Tool calls posted after completion (PostToolUse). User doesn't know what's happening during long-running tools.
**SDK equivalent:** Stream events show tool calls as they start, input as it streams, and completion.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| "Using Bash..." indicator | Post a status when a tool starts, update when complete | MEDIUM | Track content_block_start/stop events |
| Real-time command preview | Show command as it's being composed (before execution) | HIGH | Track input_json_delta for Bash tool |

**Complexity:** MEDIUM -- Requires streaming event state machine.

### DF-05: Subagent Tracking

**Current:** Not implemented (v2 deferred).
**SDK equivalent:** `SubagentStart` and `SubagentStop` hooks, plus `parent_tool_use_id` on messages.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Subagent activity in topic | Post "Subagent started/stopped" messages | LOW | Hook callbacks |
| Nested subagent context | Tag messages from subagents with parent context | MEDIUM | Track parent_tool_use_id |

**Complexity:** LOW for basic tracking, MEDIUM for nested display.

### DF-06: Model Switching Mid-Session

**Current:** Impossible.
**SDK equivalent:** `query.setModel()` changes the model during a session.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `/model sonnet` command | Switch to a cheaper model mid-session | LOW | One API call |

**Complexity:** LOW.

### DF-07: Clarifying Questions via AskUserQuestion

**Current:** Not possible. Claude's clarifying questions appear as text output, user can only respond via tmux text injection.
**SDK equivalent:** `AskUserQuestion` tool calls trigger `canUseTool` with structured question/options format. Bot can render multiple-choice buttons in Telegram.

```typescript
canUseTool: async (toolName, input, options) => {
  if (toolName === "AskUserQuestion") {
    // Render questions as Telegram inline keyboard
    const keyboard = buildQuestionKeyboard(input.questions);
    const msg = await bot.api.sendMessage(chatId, formatQuestions(input), {
      reply_markup: keyboard
    });
    // Wait for user selection
    const answers = await waitForAnswers(input.questions);
    return {
      behavior: "allow",
      updatedInput: { questions: input.questions, answers }
    };
  }
  // ... normal tool approval
}
```

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Structured question UI | Render Claude's questions as Telegram buttons | HIGH | Multiple questions, multi-select, free text support |

**Complexity:** HIGH -- Rich UI with multiple question types.

### DF-08: Image Input from Telegram

**Current:** Not possible.
**SDK equivalent:** Streaming input mode supports `image` content blocks with base64 data.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Send images to Claude | User sends a photo in the topic; bot forwards to Claude | MEDIUM | Download from Telegram, base64 encode, yield as SDKUserMessage |

**Complexity:** MEDIUM.

## Anti-Features (Do NOT Build)

Features to explicitly avoid during migration.

| Anti-Feature | Why Tempting | Why Avoid | Alternative |
|--------------|-------------|-----------|-------------|
| Token-by-token streaming to Telegram | SDK provides real-time text deltas | Telegram rate limits (20 msg/min) make it impossible. Would require constant editMessageText that hits limits instantly. | Post complete assistant messages after each turn |
| Wrapping the SDK in a web API | "What if we want remote access?" | The bot IS the remote access layer. Telegram is the API. Adding HTTP on top adds no value. | Telegram bot is the interface |
| Auto-approve all tools by default | "Faster iteration" | bypassPermissions is dangerous. Subagents inherit it. | Start with `default` mode, let users `/yolo` when they want |
| Persist SDK sessions to custom store | "What if we need session history?" | SDK handles session persistence internally (`persistSession: true` is default). Telegram topics ARE the message history. | Use SDK built-in persistence + Telegram message history |
| Custom tool implementations | "We could add our own tools" | Scope creep. SDK has all built-in tools. MCP covers extensions. | Use built-in tools + MCP servers if needed |
| V2 preview API (`unstable_v2_createSession`) | "Simpler multi-turn!" | Marked `unstable`, APIs may change. V1 `query()` with streaming input handles multi-turn fine. Session forking not available in V2. | Use stable V1 `query()` API with AsyncIterable input |

## Feature Dependencies

```
[SDK query() with AsyncIterable input]  <-- FOUNDATION
    |
    |-- yields --> [Session lifecycle (system init message)]
    |                  |
    |                  |-- enables --> [Topic creation/closure] (TS-01)
    |                  |-- enables --> [All monitoring below]
    |
    |-- yields --> [AssistantMessage]
    |                  |-- enables --> [Text output capture] (TS-03)
    |                  |-- enables --> [Tool call notifications] (TS-02)
    |
    |-- option --> [canUseTool callback]
    |                  |-- enables --> [Tool approval flow] (TS-04)
    |                  |-- enables --> [AskUserQuestion handling] (DF-07)
    |
    |-- option --> [hooks callbacks]
    |                  |-- enables --> [PostToolUse notifications] (TS-02 alt)
    |                  |-- enables --> [Notification forwarding] (TS-06)
    |                  |-- enables --> [Subagent tracking] (DF-05)
    |
    |-- option --> [includePartialMessages]
    |                  |-- enables --> [Streaming tool progress] (DF-04)
    |                  |-- enables --> [Token usage extraction] (TS-08)
    |
    |-- input --> [AsyncIterable<SDKUserMessage>]
    |                  |-- enables --> [User text input] (TS-05)
    |                  |-- enables --> [Image input] (DF-08)
    |
    |-- method --> [query.interrupt()]
    |                  |-- enables --> [Session interruption] (DF-03)
    |
    |-- method --> [query.setPermissionMode()]
                       |-- enables --> [Dynamic permissions] (DF-02)

[Telegram-side features] (PRESERVED, no SDK dependency)
    |-- MessageBatcher / rate limiter (TS-07)
    |-- Verbosity filtering (TS-09)
    |-- Summary timer (TS-10)
    |-- Status message display (TS-08 partial)
    |-- Inline keyboard / formatting
```

## Eliminated Components

Components that the SDK migration removes entirely:

| Component | Lines of Code | Replaced By |
|-----------|--------------|-------------|
| `hooks/server.ts` (Fastify HTTP) | ~140 | SDK hooks callbacks |
| `utils/install-hooks.ts` (settings.json writer) | ~136 | Hooks passed to query() options |
| `monitoring/transcript-watcher.ts` (JSONL parser) | ~258 | SDK AssistantMessage / stream_event |
| `control/input-manager.ts` (tmux injection) | ~104 | SDK AsyncIterable input |
| `types/hooks.ts` (HTTP hook payload types) | ~varies | SDK built-in types |
| tmux pane capture script | ~10 | N/A (no tmux) |

**Total eliminated:** ~650+ lines of infrastructure code.

## Preserved Components

Components that survive the migration (Telegram-side concerns):

| Component | Why Preserved |
|-----------|--------------|
| `bot/bot.ts` (grammY bot) | Telegram interface unchanged |
| `bot/topics.ts` (TopicManager) | Topic lifecycle unchanged |
| `bot/rate-limiter.ts` (MessageBatcher) | Rate limiting still needed |
| `bot/formatter.ts` | Message formatting still needed |
| `sessions/session-store.ts` | Session-to-topic mapping still needed (though simplified) |
| `monitoring/status-message.ts` | Status display still needed |
| `monitoring/summary-timer.ts` | Periodic summaries still needed |
| `monitoring/verbosity.ts` | Verbosity filtering still needed |
| `control/approval-manager.ts` | Deferred-promise pattern still needed (for canUseTool) |

## Migration Priority Matrix

| Feature | Migration Priority | Risk | Rationale |
|---------|-------------------|------|-----------|
| TS-01: Session lifecycle | P0 | HIGH | Everything depends on this |
| TS-05: User text input | P0 | HIGH | Core value prop; validates SDK streaming input |
| TS-03: Text output capture | P0 | LOW | Validates SDK streaming output |
| TS-04: Tool approval flow | P1 | MEDIUM | Core control feature; canUseTool is well-documented |
| TS-02: Tool call notifications | P1 | LOW | Direct hook mapping |
| TS-06: Notification forwarding | P1 | LOW | Direct hook mapping |
| TS-08: Status messages | P2 | LOW | Usage data source changes, display stays |
| DF-03: Session interruption | P2 | LOW | Simple API call |
| DF-02: Dynamic permissions | P2 | LOW | Simple API call |
| DF-04: Streaming tool progress | P3 | MEDIUM | Nice to have; complex state management |
| DF-05: Subagent tracking | P3 | LOW | Deferred per PROJECT.md |
| DF-07: AskUserQuestion | P3 | HIGH | Complex UI, deferred |
| DF-08: Image input | P3 | MEDIUM | Deferred |

## Critical Architecture Decision

**The fundamental question:** In v1, the bot OBSERVES externally-launched Claude Code sessions. In v2, the bot IS the Claude Code runtime (via SDK). This inverts the control flow.

**Options:**

1. **Bot-as-controller (recommended):** The bot manages Claude Code sessions. Users start sessions from Telegram. The bot calls `query()`. This is the natural SDK pattern.

2. **Bot-as-observer (hybrid):** Continue supporting external Claude Code sessions (via traditional hooks in settings.json) AND add SDK-based bot-initiated sessions. More complex, but preserves the "start at terminal" workflow.

3. **Bot-as-sidecar:** The bot attaches to running Claude Code processes by resuming their sessions via `query({ options: { resume: sessionId } })`. Requires discovering session IDs from external processes.

**Recommendation:** Option 1 (bot-as-controller) for v2.0. It's the cleanest architecture, eliminates all v1 infrastructure, and is the natural way to use the SDK. Users who want terminal access can use Claude Code CLI directly -- the bot serves the "remote access" use case.

**Risk:** This changes the product model. Users who currently start Claude Code in a terminal and monitor from Telegram must now start sessions FROM Telegram. Mitigation: provide a Telegram command (`/new <prompt>`) and consider Option 3 as a v2.1 enhancement for hybrid workflows.

## Sources

- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- HIGH confidence
- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- HIGH confidence
- [Streaming input modes](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- HIGH confidence
- [Streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- HIGH confidence
- [Permissions and canUseTool](https://platform.claude.com/docs/en/agent-sdk/user-input) -- HIGH confidence
- [SDK hooks system](https://platform.claude.com/docs/en/agent-sdk/hooks) -- HIGH confidence
- [Session management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- HIGH confidence
- [Configure permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) -- HIGH confidence
- [TypeScript V2 preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- MEDIUM confidence (unstable preview)
- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- HIGH confidence

---
*Feature research for: Claude Code Telegram Bridge v2.0 SDK Migration*
*Researched: 2026-03-01*
