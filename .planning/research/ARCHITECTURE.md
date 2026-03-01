# Architecture: Claude Agent SDK Migration

**Project:** Claude Code Telegram Bridge v2.0
**Researched:** 2026-03-01
**Confidence:** HIGH (official SDK docs verified, existing codebase fully analyzed)

## Executive Summary

The migration from v1 (HTTP hook server + tmux injection + JSONL transcript watching) to v2 (Claude Agent SDK) fundamentally changes the control flow. In v1, the bot is passive -- it receives events from externally-launched Claude Code sessions via HTTP hooks and JSONL file watching. In v2, the bot is active -- it spawns and owns Claude Code sessions via `query()`, receiving all events through the SDK's async generator stream.

This is not a refactor. It is an inversion of control. The bot goes from "event listener" to "session orchestrator." Most existing Telegram-facing modules survive untouched, but the entire hook infrastructure (server, handlers, install-hooks) gets replaced by SDK integration code, and the control modules (ApprovalManager, TextInputManager) get substantially rewritten to use SDK-native mechanisms (`canUseTool` callback, `streamInput()` / AsyncIterable prompt).

## Current Architecture (v1)

```
+------------------+     HTTP POST      +------------------+
| Claude Code CLI  | -----------------> | Fastify Hook     |
| (external)       |   (hook events)    | Server           |
+------------------+                    +------------------+
        |                                        |
        | writes JSONL                   HookHandlers
        v                                        |
+------------------+                    +------------------+
| Transcript File  | <-- fs.watch ----> | TranscriptWatcher|
+------------------+                    +------------------+
                                                 |
        +------------------+             HookCallbacks
        | tmux send-keys   | <--+                |
        +------------------+    |       +------------------+
                                |       | Bot (grammy)     |
+------------------+            |       | - TopicManager   |
| Approval via     |            |       | - MessageBatcher |
| deferred promise | -----------+       | - StatusMessage  |
| (HTTP blocking)  |                    | - SummaryTimer   |
+------------------+                    +------------------+
                                                 |
                                        +------------------+
                                        | Telegram API     |
                                        +------------------+
```

### v1 Data Flow Summary

1. Claude Code hooks fire HTTP POST to Fastify server
2. HookHandlers route to HookCallbacks (session start/end, tool use, notifications)
3. HookCallbacks create Telegram topics, format messages, enqueue to MessageBatcher
4. TranscriptWatcher tails JSONL for Claude's text output and token usage
5. PreToolUse hook blocks HTTP response, sends Telegram approval message, awaits deferred promise
6. User taps Approve/Deny button, promise resolves, HTTP response sent back to Claude Code
7. Text input: user replies in topic, tmux send-keys injects into Claude Code terminal

## Target Architecture (v2)

```
+------------------+
| Bot (grammy)     |
| - TopicManager   |
| - MessageBatcher |
| - StatusMessage  |
| - SummaryTimer   |
+------------------+
        |
        | uses
        v
+------------------+
| SessionManager   | <-- NEW: orchestrates SDK sessions
| - start/stop     |
| - input routing   |
| - approval bridge |
+------------------+
        |
        | manages N concurrent sessions
        v
+------------------+     AsyncGenerator      +------------------+
| SDK Session      | <--------------------> | Claude Agent SDK  |
| Wrapper          |     SDKMessage stream   | (spawned process) |
| - query()        |                         +------------------+
| - InputChannel   |
| - AbortController|
+------------------+
        |
        | All events arrive via
        | the async generator
        |
+------------------+
| MessageRouter    | <-- NEW: routes SDKMessages to Telegram
| (replaces hooks  |
|  + transcript    |
|  watcher)        |
+------------------+
```

### v2 Data Flow

1. User sends prompt via Telegram (e.g., `/run Fix the auth bug`)
2. SessionManager creates `query()` call with AsyncIterable prompt + `canUseTool` callback
3. SDK streams `SDKMessage` objects through the async generator
4. MessageRouter classifies messages and routes to existing Telegram formatting/sending:
   - `SDKAssistantMessage` with text blocks -> replaces TranscriptWatcher output
   - `SDKAssistantMessage` with tool_use blocks -> replaces PostToolUse hook
   - `SDKResultMessage` -> replaces SessionEnd hook
   - `SDKSystemMessage` (init) -> replaces SessionStart hook
   - `SDKAssistantMessage.message.usage` -> replaces TranscriptWatcher onUsageUpdate
5. `canUseTool()` callback fires for permission-required tools -> replaces PreToolUse hook blocking
6. Follow-up user text: yield from AsyncIterable -> replaces tmux injection

## Component Migration Map

### Files to DELETE (fully replaced by SDK)

| File | v1 Purpose | v2 Replacement |
|------|-----------|----------------|
| `src/hooks/server.ts` | Fastify HTTP server receiving hook POSTs | SDK async generator provides all events |
| `src/hooks/handlers.ts` | Routes hook payloads, manages session state, backfill | SessionManager + MessageRouter handle all of this |
| `src/utils/install-hooks.ts` | Writes hook config to `~/.claude/settings.json` | Not needed -- SDK runs in-process, no external hooks |
| `src/monitoring/transcript-watcher.ts` | Tails JSONL for Claude text output + token usage | SDK streams `SDKAssistantMessage` with text + usage directly |
| `src/types/hooks.ts` | Hook payload TypeScript types | SDK exports its own types (`SDKMessage`, `SDKAssistantMessage`, etc.) |

### Files to MODIFY (keep core logic, adapt interface)

| File | What Changes | What Stays |
|------|-------------|------------|
| `src/index.ts` | Complete rewrite of wiring. Remove Fastify, hook handlers, transcript watcher, install-hooks. Add SessionManager initialization, SDK session lifecycle. Remove `tryReadTmuxPane`. | Overall structure (config -> bot -> monitoring -> shutdown). HookCallbacks pattern adapts to SessionManager event handlers. |
| `src/control/approval-manager.ts` | Core pattern unchanged but interface adapts: `canUseTool` callback resolves/rejects the deferred promise instead of HTTP response. Add AbortSignal awareness. | `Map<toolUseId, PendingApproval>` pattern, `waitForDecision()`, `decide()`, timeout logic, `cleanupSession()`. |
| `src/control/input-manager.ts` | Complete rewrite. Remove all tmux code (`execSync`, `shellQuote`, `inject`). Replace with: push message to InputChannel, or call `query.streamInput()`. | Queue concept for messages waiting to be sent (adapted), `cleanup()`. |
| `src/sessions/session-store.ts` | Remove `transcriptPath`, `tmuxPane` fields and their methods (`updateTmuxPane`). Add `sdkSessionId` field. Adjust serialization. | Core Map persistence, `get`/`set`/`getByThreadId`/`getActiveByCwd`, thread tracking, verbosity, context%, status message tracking, tool counting. |
| `src/types/sessions.ts` | Remove `transcriptPath: string`, `tmuxPane: string | null`. Add `sdkSessionId: string`. | All other fields (threadId, cwd, topicName, toolCallCount, filesChanged, verbosity, statusMessageId, suppressedCounts, contextPercent, lastActivityAt). |
| `src/types/config.ts` | Remove `hookServerPort`, `hookServerHost`. Add `anthropicApiKey` (or rely on env var). Consider adding `defaultModel`, `defaultPermissionMode`. | telegramBotToken, telegramChatId, dataDir, defaultVerbosity, idleTimeoutMs, summaryIntervalMs, approvalTimeoutMs, autoApprove. |
| `src/config.ts` | Remove hook server env var parsing. Add `ANTHROPIC_API_KEY` validation (or document it as implicit SDK requirement). | Core loadConfig pattern, env var validation. |
| `src/bot/bot.ts` | Text input handler changes: instead of `inputManager.send(tmuxPane, ...)`, call `sessionManager.sendInput(sessionId, text)`. Remove tmux-related replies ("delivery requires tmux"). Add `/run` command to start sessions. | Bot creation, command handlers (/status, /verbose, /normal, /quiet), approval callback query handlers (approve/deny buttons), auto-retry/throttler plugins. |
| `src/bot/formatter.ts` | Adapt `formatToolUse` input: SDK tool_use blocks have slightly different structure from PostToolUsePayload. Create adapter or accept both. `formatApprovalRequest` input adapts similarly. | All formatting logic (formatSessionStart, formatSessionEnd, formatToolUse internals, formatNotification, formatApprovalRequest, formatApprovalResult, formatApprovalExpired). |
| `src/monitoring/summary-timer.ts` | Data source changes: instead of pulling from SessionStore populated by hooks, pulls from SessionStore populated by SDK message processing. Same interface. | Timer logic, formatSummary, skip-if-no-activity check. |

### Files to KEEP (unchanged or trivially adapted)

| File | Why It Stays |
|------|-------------|
| `src/bot/topics.ts` | TopicManager is pure Telegram API. Zero coupling to hooks or SDK. |
| `src/bot/rate-limiter.ts` | MessageBatcher is pure queue logic. Zero coupling to hooks or SDK. |
| `src/monitoring/status-message.ts` | StatusMessage is pure Telegram edit logic. Input data shape (StatusData) unchanged. |
| `src/monitoring/verbosity.ts` | Pure filter logic, tool-name based. Works the same regardless of event source. |
| `src/utils/text.ts` | Pure text utilities (escapeHtml, markdownToHtml, truncateText). |
| `src/types/monitoring.ts` | StatusData, VerbosityTier, TokenUsage types still needed. ContentBlock/TranscriptEntry types can be removed (only used by TranscriptWatcher). |

### Files to CREATE (new SDK integration layer)

| File | Purpose | Complexity |
|------|---------|------------|
| `src/sdk/session-manager.ts` | Orchestrates multiple concurrent SDK sessions. Creates `query()` calls, manages lifecycle, maps sessions to Telegram topics. Central new component. | High |
| `src/sdk/message-router.ts` | Processes `SDKMessage` stream, classifies message types, routes to Telegram formatting and sending. Replaces HookHandlers + TranscriptWatcher. | Medium |
| `src/sdk/input-channel.ts` | AsyncIterable wrapper that can receive messages pushed from outside. Enables multi-turn conversations via the SDK streaming input pattern. | Medium |
| `src/sdk/types.ts` | Re-export and adapt SDK types. Bridge between SDK's type system and internal types. Adapter functions for tool_use blocks, usage data, etc. | Low |

## SessionManager Design

The SessionManager is the central new component. It replaces the combination of HookHandlers + Fastify server + TranscriptWatcher + tmux TextInputManager.

### Interface

```typescript
class SessionManager {
  // Active SDK sessions
  private sessions: Map<string, ActiveSession>;

  // Dependencies (injected)
  private sessionStore: SessionStore;
  private topicManager: TopicManager;
  private batcher: MessageBatcher;
  private bot: Bot;
  private config: AppConfig;

  // Create a new SDK session (called from Telegram /run command)
  async startSession(prompt: string, cwd: string): Promise<string>;

  // Send follow-up input to an active session
  async sendInput(sessionId: string, text: string): Promise<void>;

  // Approve/deny a pending tool use (called from Telegram callback handler)
  // (delegates to internal ApprovalManager)
  decideTool(toolUseId: string, decision: 'allow' | 'deny'): PendingApproval | null;

  // Abort a session (called from Telegram /abort command)
  async abortSession(sessionId: string): Promise<void>;

  // Clean up all sessions (shutdown)
  async shutdown(): Promise<void>;
}

interface ActiveSession {
  id: string;                          // Internal tracking ID
  sdkSessionId: string;                // SDK's session_id from init message
  query: Query;                        // The SDK Query instance (async generator + methods)
  inputChannel: InputChannel;          // For streaming input to the session
  threadId: number;                    // Telegram topic thread ID
  abortController: AbortController;    // For cancellation
  processingPromise: Promise<void>;    // The background event loop promise
}
```

### Session Lifecycle

```
1. startSession(prompt, cwd) -- called from Telegram /run command
   |
   +--> Create AbortController
   +--> Create InputChannel (AsyncIterable for streaming input)
   +--> Yield initial SDKUserMessage to InputChannel
   +--> Call query({
   |      prompt: inputChannel.iterable(),
   |      options: {
   |        cwd,
   |        canUseTool: this.handleToolApproval.bind(this, sessionId),
   |        permissionMode: "default",
   |        abortController,
   |        includePartialMessages: false,
   |      }
   |    })
   +--> Store ActiveSession with processingPromise
   +--> Spawn processSession() loop (async, fire-and-forget)
   +--> Return sessionId

2. processSession(sessionId, query) -- runs per-session, concurrent
   |
   for await (const message of query) {
     try {
       await this.routeMessage(sessionId, message);
     } catch (err) {
       console.warn("Message routing error:", err);
       // Do NOT let Telegram errors crash the SDK session
     }
   }
   // Loop ends when SDK session completes
   await this.cleanupSession(sessionId);

3. routeMessage(sessionId, message) -- classify and dispatch
   |
   switch (message.type) {
     case "system":
       if (message.subtype === "init") {
         // Capture sdkSessionId from message.session_id
         // Create Telegram topic via TopicManager
         // Initialize monitoring (StatusMessage, SummaryTimer)
         // Post session start message
       }
       break;
     case "assistant":
       // Extract text blocks -> post Claude's text to topic
       // Extract tool_use blocks -> format and post tool calls
       // Extract usage -> update context %, status message
       break;
     case "result":
       // Post session summary (duration, tool count, cost)
       // Close topic
       // Clean up monitoring
       break;
   }

4. sendInput(sessionId, text) -- called when user replies in topic
   |
   +--> Find ActiveSession
   +--> Build SDKUserMessage: { type: "user", message: { role: "user", content: text } }
   +--> Push to InputChannel
   +--> SDK receives it on next iteration of the async generator

5. handleToolApproval(sessionId, toolName, input, options) -- canUseTool callback
   |
   +--> Auto-approve check (config.autoApprove, permission mode checks)
   +--> Format approval message with tool details
   +--> Send to Telegram topic with Approve/Deny buttons
   +--> Create deferred promise via ApprovalManager.waitForDecision()
   +--> Race against options.signal (AbortSignal) for cancellation
   +--> Return PermissionResult: { behavior: "allow" } or { behavior: "deny", message }
```

## InputChannel Pattern

The InputChannel wraps a controllable async generator that bridges external message pushes to the SDK's expected AsyncIterable prompt format.

```typescript
class InputChannel {
  private pending: SDKUserMessage[] = [];
  private resolver: ((msg: SDKUserMessage) => void) | null = null;
  private closed = false;

  // Called by SessionManager when user sends text from Telegram
  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(message);
    } else {
      this.pending.push(message);
    }
  }

  // Used as the prompt parameter for query()
  async *iterable(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!;
      } else {
        // Park until push() delivers a message
        const msg = await new Promise<SDKUserMessage>((resolve) => {
          this.resolver = resolve;
        });
        if (!this.closed) {
          yield msg;
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    // Unblock any parked consumer
    if (this.resolver) {
      // Signal end by rejecting or resolving with a sentinel
      this.resolver = null;
    }
  }
}
```

**V2 API alternative (when stable):** The V2 preview API (`unstable_v2_createSession`) provides `session.send()` which is simpler than managing an InputChannel. However, V2 is unstable and missing some features (session forking). **Recommendation:** Build with V1 streaming input but isolate InputChannel so switching to V2 later is a single-module change.

## Concurrent Session Architecture

### The Challenge

Multiple Claude Code sessions run simultaneously (2-3 per machine). Each produces an independent stream of SDKMessages. Each needs its own Telegram topic. Each might be waiting for approval at the same time.

### The Solution: Per-Session Event Loops

Each SDK session runs its own async `for await` loop as a background task. These loops are independent and concurrent within Node.js's single-threaded event loop. All async operations (Telegram API calls, message formatting) yield back to the event loop, allowing interleaving.

No shared mutable state between loops except through the SessionStore, where Map operations are atomic in single-threaded JS.

```typescript
// Inside SessionManager.startSession():
const q = query({
  prompt: inputChannel.iterable(),
  options: {
    cwd,
    canUseTool: (toolName, input, opts) =>
      this.handleToolApproval(sessionId, toolName, input, opts),
    permissionMode: "default",
    abortController,
  }
});

// Spawn the processing loop (fire-and-forget, tracked in ActiveSession)
const processingPromise = this.processSession(sessionId, q).catch(err => {
  console.error(`Session ${sessionId} processing error:`, err);
  this.cleanupSession(sessionId);
});

this.sessions.set(sessionId, {
  id: sessionId,
  sdkSessionId: "", // Set when init message arrives
  query: q,
  inputChannel,
  threadId: 0, // Set when topic is created
  abortController,
  processingPromise,
});
```

### Important: Each query() Spawns a Child Process

The SDK spawns a separate Claude Code child process for each `query()` call. This is heavier than v1 (where Claude Code ran independently and the bot was lightweight). At 3 concurrent sessions, expect ~150MB extra memory from child processes. This is manageable but worth monitoring.

## Approval Flow: canUseTool Bridge

### Key Difference from v1

In v1, the PreToolUse HTTP hook holds the Fastify HTTP response open with a deferred promise. When the user taps Approve/Deny, the promise resolves and the HTTP response is sent.

In v2, the `canUseTool()` callback is called by the SDK inside the query's event loop. The callback returns a `Promise<PermissionResult>` that the SDK awaits. The callback can take as long as needed -- the SDK does not proceed with the tool until the promise resolves.

The deferred promise pattern from ApprovalManager works identically -- only the outer interface changes.

### Design

```typescript
// Inside SessionManager:
private async handleToolApproval(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; decisionReason?: string }
): Promise<PermissionResult> {

  // Auto-approve check
  if (this.config.autoApprove) {
    return { behavior: "allow", updatedInput: input };
  }

  // Look up session's thread ID
  const session = this.sessionStore.get(sessionId);
  if (!session) {
    return { behavior: "allow", updatedInput: input };
  }

  // Format approval message (reuse existing formatter)
  const approvalHtml = formatApprovalRequest({
    tool_name: toolName,
    tool_input: input,
    tool_use_id: options.toolUseID,
    // Adapter: SDK provides these fields differently than hook payloads
  });
  const keyboard = makeApprovalKeyboard(options.toolUseID);

  const msg = await this.bot.api.sendMessage(
    this.config.telegramChatId,
    approvalHtml,
    {
      message_thread_id: session.threadId,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );

  // Wait for decision with abort signal awareness
  const decision = await Promise.race([
    this.approvalManager.waitForDecision(
      options.toolUseID,
      sessionId,
      session.threadId,
      msg.message_id,
      toolName
    ),
    // Abort signal: if session is cancelled while waiting
    new Promise<"deny">((resolve) => {
      if (options.signal.aborted) resolve("deny");
      options.signal.addEventListener("abort", () => resolve("deny"), { once: true });
    }),
  ]);

  // Map to SDK PermissionResult
  if (decision === "allow") {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "Denied by user via Telegram" };
}
```

### Telegram Button Handlers (mostly unchanged)

The grammY callback query handlers for approve/deny buttons remain nearly identical. They call `approvalManager.decide(toolUseId, decision)` which resolves the deferred promise. The only change is that the resolved promise now feeds back to the SDK's `canUseTool` callback instead of an HTTP response handler.

## Message Type Mapping

How SDK message types map to existing Telegram output:

| SDK Message Type | v1 Equivalent | Telegram Action | Confidence |
|-----------------|---------------|-----------------|------------|
| `SDKSystemMessage` (subtype: "init") | SessionStart hook | Create topic, post start message, init monitoring | HIGH |
| `SDKAssistantMessage` with text blocks | TranscriptWatcher onAssistantMessage | Post Claude text to topic via batcher | HIGH |
| `SDKAssistantMessage` with tool_use blocks | PostToolUse hook | Post tool call info (format, verbosity filter) | HIGH |
| `SDKAssistantMessage.message.usage` | TranscriptWatcher onUsageUpdate | Update context %, status message, threshold warnings | HIGH |
| `SDKResultMessage` (subtype: "success") | SessionEnd hook | Post summary, close topic, clean up monitoring | HIGH |
| `SDKResultMessage` (subtype: "error_*") | SessionEnd hook (error) | Post error, close topic | HIGH |
| `canUseTool()` callback | PreToolUse hook (blocking HTTP) | Post approval message, wait for button tap | HIGH |
| `SDKCompactBoundaryMessage` | (no v1 equivalent) | Post compaction notice to topic | MEDIUM |
| `SDKPartialAssistantMessage` | (no v1 equivalent) | Optional: live-stream Claude's reasoning text | LOW priority |
| `SDKStatusMessage` | (no v1 equivalent) | Could supplement StatusMessage data | LOW priority |
| `SDKToolUseSummaryMessage` | (no v1 equivalent) | Optional: show tool result summaries | LOW priority |

## Patterns to Follow

### Pattern 1: SDK Session Wrapper

Wrap each SDK session in a struct that encapsulates query instance, input channel, abort controller, and session metadata. This makes cleanup deterministic and prevents resource leaks.

```typescript
interface ActiveSession {
  readonly id: string;
  readonly query: Query;
  readonly inputChannel: InputChannel;
  readonly abortController: AbortController;
  processingPromise: Promise<void>;
  sdkSessionId: string;
  threadId: number;
  cleanedUp: boolean;
}

async function cleanupSession(session: ActiveSession): Promise<void> {
  if (session.cleanedUp) return;
  session.cleanedUp = true;
  session.abortController.abort();
  session.query.close();
  session.inputChannel.close();
}
```

### Pattern 2: Non-Blocking Message Routing

Never await long-running operations (Telegram API calls) directly in the SDK message loop. Use the MessageBatcher for all non-critical messages. Only lifecycle messages (topic creation, close) should be awaited.

```typescript
// GOOD: Non-blocking for tool events
for await (const msg of query) {
  if (msg.type === "assistant") {
    batcher.enqueue(threadId, formatAssistantMessage(msg)); // Returns immediately
  }
  if (msg.type === "result") {
    await batcher.enqueueImmediate(threadId, formatResult(msg)); // Lifecycle: OK to await
  }
}
```

### Pattern 3: Error Isolation

Telegram API errors must never crash the SDK session event loop. Wrap all Telegram interactions in try/catch within the message router.

```typescript
for await (const msg of query) {
  try {
    await routeMessage(sessionId, msg);
  } catch (err) {
    console.warn(`Message routing error (session ${sessionId}):`, err);
    // Continue processing -- the SDK session is still alive
  }
}
```

### Pattern 4: Graceful Shutdown

On bot shutdown, abort all SDK sessions cleanly and wait for processing loops to finish:

```typescript
async shutdown(): Promise<void> {
  const sessions = Array.from(this.sessions.values());

  // Signal all sessions to abort
  for (const session of sessions) {
    session.abortController.abort();
  }

  // Wait for all processing loops to finish (with timeout)
  const timeout = new Promise(r => setTimeout(r, 5000));
  await Promise.race([
    Promise.allSettled(sessions.map(s => s.processingPromise)),
    timeout
  ]);

  // Clean up any remaining sessions
  for (const session of sessions) {
    await cleanupSession(session);
  }

  this.sessions.clear();
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Multiple Consumers of Query AsyncGenerator

The Query async generator can only have ONE reader. Do NOT pass it to multiple consumers. All message processing must happen in a single `for await` loop per session. If you need to fan-out messages, do it inside that single loop.

### Anti-Pattern 2: Blocking the Message Loop with Awaits

Do NOT await slow operations (like topic creation or document upload) inside the message processing loop without error handling. If a Telegram call hangs, it blocks ALL subsequent SDK messages for that session.

### Anti-Pattern 3: Recreating What SDK Provides

The SDK handles the entire agent loop: tool execution, conversation history, token management, compaction. Do NOT implement custom tool result parsing, conversation state management, or context tracking. Just observe the events.

### Anti-Pattern 4: Using SingleMessage Mode for Interactive Sessions

The SDK's single-message mode (string prompt) doesn't support multi-turn input or `canUseTool` properly. Always use streaming input mode (AsyncIterable prompt) for interactive sessions that need approval flows and user input.

## Scalability Considerations

| Concern | At 1 session | At 3 sessions | At 10+ sessions |
|---------|-------------|---------------|-----------------|
| Memory | ~50MB per SDK child process | ~150MB | Consider session limits |
| CPU | Negligible (I/O bound) | Still I/O bound | Still I/O bound |
| Telegram rate limits | No issue | MessageBatcher handles fine | May need more aggressive batching |
| SDK processes | 1 child process | 3 child processes | Monitor with OS-level tools |
| Event loop | Minimal | Concurrent `for await` loops fine | Still fine (all async) |
| Approval concurrency | 0-1 pending | 0-3 pending | Map keyed by toolUseId handles any count |

**Key difference from v1:** Each `query()` spawns a separate Claude Code child process. In v1, Claude Code ran independently and the bot was a lightweight listener. In v2, the bot is responsible for spawning and managing these processes. Monitor memory and set `maxTurns` to prevent runaway sessions.

## Dependency Changes

### Remove from package.json

- `fastify` -- No more HTTP hook server
- `pino` -- Was Fastify's logger (use console or a simpler logger)

### Add to package.json

- `@anthropic-ai/claude-agent-sdk` -- The SDK itself
- `zod` (if not already present) -- SDK peer dependency

### Keep

- `grammy`, `@grammyjs/auto-retry`, `@grammyjs/transformer-throttler`, `@grammyjs/parse-mode` -- Telegram bot
- `dotenv` -- Environment variable loading

## Suggested Build Order

Based on dependency analysis, the migration should be built bottom-up:

### Phase 1: Types + Config + SDK Dependency
- Add `@anthropic-ai/claude-agent-sdk` to package.json
- Update `AppConfig` and `SessionInfo` types (remove hook/tmux fields, add SDK fields)
- Create `src/sdk/types.ts` with adapter types between SDK and internal formats
- Update `config.ts` to remove hook server vars, add API key validation
- **Risk:** Low. No behavior change, just type/config prep.

### Phase 2: InputChannel + Input Bridge
- Create `src/sdk/input-channel.ts` with the AsyncIterable wrapper
- Rewrite `src/control/input-manager.ts` to use InputChannel instead of tmux
- Unit testable in isolation with mock consumers
- **Risk:** Medium. The AsyncIterable/push pattern needs careful testing for edge cases (close during await, rapid pushes, etc.).

### Phase 3: MessageRouter
- Create `src/sdk/message-router.ts` that classifies SDKMessages and routes to existing formatters
- Adapt `formatToolUse` to accept SDK tool_use blocks (create adapter functions)
- Wire to existing MessageBatcher, StatusMessage, SummaryTimer
- **Risk:** Medium. Need to map SDK message fields to v1 formatter expectations. Most of the mapping is straightforward but tool_input/tool_response shapes may differ.

### Phase 4: Approval Bridge
- Adapt `src/control/approval-manager.ts` for canUseTool callback use
- Add AbortSignal awareness
- Wire approval flow into SessionManager (canUseTool -> Telegram -> decide -> PermissionResult)
- **Risk:** Low. The deferred promise pattern is identical. Only the outer interface changes.

### Phase 5: SessionManager
- Create `src/sdk/session-manager.ts` -- the orchestrator
- Integrates InputChannel, MessageRouter, ApprovalBridge
- Manages concurrent session lifecycle
- Integration test with a real SDK session
- **Risk:** High. This is the core integration. Concurrent session management, error handling, cleanup are all critical.

### Phase 6: Entry Point Rewrite + Cleanup
- Rewrite `src/index.ts` to wire SessionManager instead of Fastify/hooks
- Update `src/bot/bot.ts` text handler to use `sessionManager.sendInput()`
- Add `/run` command to start sessions from Telegram
- Delete dead files (hooks/, install-hooks.ts, transcript-watcher.ts)
- Remove Fastify from package.json
- **Risk:** Medium. Large change but mechanically straightforward if phases 1-5 are solid.

## Open Questions

### 1. Session Initiation Model

v1 auto-discovers externally-launched sessions via hooks. v2 needs a new trigger mechanism.

**Options:**
- **(a) User sends `/run <prompt>` in Telegram** -- Bot creates SDK session. This is what PROJECT.md implies ("Bot manages Claude Code sessions directly").
- **(b) Bot monitors filesystem for new Claude Code sessions** -- Hybrid mode. More complex.
- **(c) Both** -- Most flexible but most complex.

**Recommendation:** Start with (a). Add (b) later if needed.

### 2. Bot Restart Behavior

v1 reconnects to sessions that were active before restart (topics still exist, monitoring re-initializes).

With SDK, restarting the bot kills SDK child processes. Options:
- **(a) Use `resume: sessionId`** to continue SDK sessions if their session files exist on disk. The SDK supports this natively.
- **(b) Accept restart = session loss**, post "Bot restarted" notice.

**Recommendation:** (a) is feasible because the SDK persists session state to disk by default. On restart, find active sessions from SessionStore, resume each with `query({ prompt, options: { resume: sdkSessionId } })`.

### 3. API Key Model

v1 uses the user's existing Claude Code CLI auth (Claude.ai account). v2 SDK requires `ANTHROPIC_API_KEY` environment variable (Anthropic API account). This is a different auth model with different billing.

The SDK also supports Bedrock and Vertex via environment variables. Need to document this change clearly for users.

### 4. V1 vs V2 SDK API

The V2 preview (`unstable_v2_createSession`, `session.send()`, `session.stream()`) is much cleaner for multi-turn conversations. However, it's marked unstable and missing some features. Build with V1 streaming input, but structure code so switching to V2 later is a one-module change in InputChannel.

### 5. SDK Process Cleanup on Crash

If the bot process crashes without calling `query.close()`, orphan Claude Code child processes may remain. Consider:
- PID tracking in a temp file
- Process group management
- Cleanup script on startup

## Sources

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- Official overview, capabilities, built-in tools
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- Complete API: query(), Options, SDKMessage types, CanUseTool, PermissionResult, Query methods, Hook types
- [Claude Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart) -- Installation, basic usage, permission modes
- [Handle Approvals and User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- canUseTool callback, AskUserQuestion, PermissionResult
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- Session create, resume, fork, session_id capture
- [Streaming vs Single-Turn Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- AsyncIterable input, multi-turn patterns, streaming benefits
- [TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- send()/stream() patterns, createSession, unstable API
- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- Package info, version
