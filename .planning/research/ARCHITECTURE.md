# Architecture Patterns

**Domain:** Per-machine Telegram bot bridging Claude Code sessions
**Researched:** 2026-02-28

## Recommended Architecture

The system is a **local HTTP server** that acts as a bridge between Claude Code hooks and the Telegram Bot API. Each machine runs one bot process. Claude Code communicates with it via HTTP hooks (native, first-class support). The bot process manages Telegram topics, routes messages, and holds pending approval state.

```
+-----------------------------------------------------------+
|                        Machine                            |
|                                                           |
|  +------------------+       +------------------------+    |
|  |  Claude Code     |       |  Bridge Server         |    |
|  |  Session A       |       |  (Node.js, port 4100)  |    |
|  |  +-----------+   | HTTP  |                        |    |
|  |  | Hooks     |---+------>| /hooks/pre-tool-use    |    |
|  |  | (HTTP)    |   |       | /hooks/post-tool-use   |    |     +------------------+
|  |  +-----------+   |       | /hooks/notification    |    |     |  Telegram API    |
|  +------------------+       | /hooks/stop            |    |     |                  |
|                             | /hooks/session-start   |    |     |  Supergroup      |
|  +------------------+       | /hooks/session-end     |    |     |  with Topics     |
|  |  Claude Code     |       |                        |    |     |                  |
|  |  Session B       |       | Session Manager        |----+--->|  Topic: Sess A   |
|  |  +-----------+   | HTTP  | Telegram Client        |<---+----+  Topic: Sess B   |
|  |  | Hooks     |---+------>| Approval Queue         |    |     |                  |
|  |  | (HTTP)    |   |       | Log Watcher            |    |     +------------------+
|  |  +-----------+   |       +------------------------+    |
|  +------------------+                                     |
+-----------------------------------------------------------+
```

### Why HTTP Hooks (Not Command Hooks)

Claude Code natively supports `type: "http"` hooks that POST JSON to a URL. This is the optimal IPC mechanism because:

1. **No shell script intermediary needed.** Command hooks require a shell script that reads stdin, connects to a socket/pipe, sends data, waits for response, and writes to stdout. HTTP hooks eliminate this entirely -- Claude Code POSTs directly to the bridge server.
2. **Blocking is natural.** For PreToolUse, the HTTP response IS the decision. The bridge server receives the POST, sends a Telegram message with Approve/Deny buttons, waits for the callback query, then returns the JSON response. Claude Code blocks on the HTTP request natively (up to 600s timeout).
3. **No IPC plumbing to build.** Unix domain sockets, named pipes, and file-based locking all require custom client code in bash scripts. HTTP hooks skip all of this.
4. **Battle-tested pattern.** The `claude-code-hooks-multi-agent-observability` project uses exactly this pattern (HTTP POST to localhost:4000) successfully.

**Confidence: HIGH** -- HTTP hooks are documented in official Claude Code docs at https://code.claude.com/docs/en/hooks with explicit examples of `type: "http"` configuration pointing to localhost URLs.

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **Hook Config** (`.claude/settings.json`) | Declares HTTP hook endpoints for all events | Claude Code (read at startup) |
| **HTTP Server** (Express/Fastify) | Receives hook POSTs, routes to handlers | Claude Code (inbound), Session Manager, Approval Queue |
| **Session Manager** | Tracks active sessions, maps session_id to Telegram topic_id | HTTP Server, Telegram Client, Log Watcher |
| **Telegram Client** | Sends/receives messages via Bot API, manages topics | Telegram API, Session Manager, Approval Queue |
| **Approval Queue** | Holds pending PreToolUse requests, resolves on callback_query | HTTP Server (holds response), Telegram Client (receives callbacks) |
| **Log Watcher** | Tails JSONL transcript files for Claude's text output | Filesystem (inotify/chokidar), Session Manager, Telegram Client |
| **Message Formatter** | Converts hook JSON into readable Telegram messages | HTTP Server, Telegram Client |

### Data Flow

#### Outbound: Claude Code -> Telegram

```
1. Claude Code fires hook event (PreToolUse, PostToolUse, Stop, etc.)
2. Claude Code HTTP-POSTs JSON to http://localhost:4100/hooks/{event}
3. HTTP Server receives request, extracts session_id from JSON body
4. Session Manager looks up Telegram topic_id for this session_id
   - If no topic exists (first event for session): create topic, store mapping
5. Message Formatter converts hook JSON to human-readable Telegram message
6. Telegram Client sends message to the topic via sendMessage with message_thread_id
7. HTTP Server returns 200 with empty body (for non-blocking events)
   OR holds request open for approval (PreToolUse) -- see Approval Flow below
```

#### Inbound: Telegram -> Claude Code (Approval Flow)

```
1. PreToolUse hook POST arrives at /hooks/pre-tool-use
2. HTTP Server creates a Promise, stores its resolve function in Approval Queue
   keyed by a unique request_id
3. Telegram Client sends message to session's topic with:
   - Tool name, command/file details
   - InlineKeyboardMarkup with [Approve] [Deny] buttons
   - callback_data encodes: request_id
4. User taps Approve or Deny in Telegram
5. Telegram sends callback_query to bot
6. Bot matches callback_data to request_id in Approval Queue
7. Approval Queue resolves the stored Promise with approve/deny decision
8. HTTP Server responds to the still-open PreToolUse POST with:
   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
     "permissionDecision": "allow" | "deny",
     "permissionDecisionReason": "Approved via Telegram" } }
9. Claude Code receives response, proceeds or blocks tool call
```

#### Inbound: Telegram -> Claude Code (Text Input)

```
1. User sends a text message in a session's topic
2. Telegram delivers update to bot via polling
3. Bot identifies which session this topic belongs to (topic_id -> session_id)
4. Text is written to a response file or injected via an available mechanism
   (this is the hardest part -- see "Open Architecture Questions" below)
```

#### Claude Text Output: Log Watcher -> Telegram

```
1. SessionStart hook fires, provides transcript_path in JSON body
2. Log Watcher starts tailing the JSONL file at transcript_path using chokidar
3. On new lines appended: parse JSON, extract assistant text messages
4. Filter for type=assistant messages, extract text content
5. Telegram Client sends formatted text to session's topic
6. On SessionEnd hook: Log Watcher stops tailing, topic is closed
```

## Component Details

### 1. Hook Configuration

Configured in `~/.claude/settings.json` (global, all projects) or `.claude/settings.json` (project-level).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/pre-tool-use",
            "timeout": 300
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/post-tool-use"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/notification"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/stop"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/session-start"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:4100/hooks/session-end"
          }
        ]
      }
    ]
  }
}
```

**Key detail:** HTTP hooks have a default timeout of 600 seconds for command hooks. For PreToolUse blocking, set timeout to 300 seconds (5 min) to give the user time to respond in Telegram while leaving headroom.

**Key detail:** If the bridge server is down when a hook fires, HTTP hook failures are non-blocking -- Claude Code continues. This means the bot going down does NOT break Claude Code sessions. Only PreToolUse approvals would be lost (Claude Code would proceed without approval in the default permission mode).

### 2. HTTP Server

A lightweight HTTP server running on localhost. Routes map 1:1 to hook events.

```
POST /hooks/session-start   -> SessionStart handler
POST /hooks/session-end     -> SessionEnd handler
POST /hooks/pre-tool-use    -> PreToolUse handler (BLOCKING)
POST /hooks/post-tool-use   -> PostToolUse handler
POST /hooks/notification    -> Notification handler
POST /hooks/stop            -> Stop handler
```

**Implementation choice: Fastify over Express.** Fastify has better TypeScript support, built-in JSON schema validation, and lower overhead. But Express is fine too -- this is a localhost-only server handling maybe 10-50 requests per minute at peak.

### 3. Session Manager

In-memory data structure mapping sessions to Telegram topics.

```typescript
interface Session {
  sessionId: string;
  topicId: number;          // Telegram message_thread_id
  transcriptPath: string;   // For log watcher
  cwd: string;              // Working directory
  startedAt: Date;
  lastActivityAt: Date;
  model: string;
}

// Core state
Map<string, Session>  // sessionId -> Session
Map<number, string>   // topicId -> sessionId (reverse lookup for incoming Telegram messages)
```

**Session detection:** Sessions are detected automatically when the first hook event arrives with a new `session_id`. No polling or process scanning needed.

**Session end:** Detected via the `SessionEnd` hook event. On session end:
1. Close/archive the Telegram topic via `closeForumTopic`
2. Post a summary message (last_assistant_message from Stop hook)
3. Stop the log watcher for this session's transcript
4. Remove from active sessions map (or move to a "completed" set)

**Persistence:** Not needed for MVP. Sessions are transient -- if the bot restarts, active sessions won't have topics. New hook events will create new topics. For robustness, optionally persist the session map to a JSON file on disk.

### 4. Telegram Client

Wraps the Telegram Bot API. Use **grammY** (not `node-telegram-bot-api`) because:

- grammY has first-class TypeScript support, active maintenance, and better docs
- Built-in flood control (auto-retry on 429 Too Many Requests) via `auto-retry` plugin
- Transformer middleware for rate limiting via `transformer-throttler` plugin
- Clean API for forum topics: `ctx.api.createForumTopic()`, `ctx.api.closeForumTopic()`
- Webhook and polling support

**Confidence: MEDIUM** -- grammY is well-documented and widely used, but I haven't verified its forum topic API completeness via Context7.

Key operations:
- `createForumTopic(chatId, name)` -- create topic for new session
- `closeForumTopic(chatId, topicId)` -- close topic on session end
- `sendMessage(chatId, text, { message_thread_id: topicId })` -- post to topic
- `sendMessage(chatId, text, { message_thread_id: topicId, reply_markup: inlineKeyboard })` -- approval buttons
- Handle `callback_query` updates for approval button presses
- Handle `message` updates for text replies in topics

**Rate limiting critical:** Telegram limits groups to **20 messages per minute** and bots to 30 messages/second globally. During heavy tool use, Claude Code can fire dozens of PostToolUse events per minute. Mitigation strategies:
- Batch consecutive tool calls into a single message (e.g., "Read 5 files: a.ts, b.ts, ...")
- Use `editMessageText` to update a running "activity" message instead of sending new ones
- Debounce PostToolUse events with a 2-3 second window
- Only send detailed messages for Write/Edit/Bash tools, summarize Read/Glob/Grep

### 5. Approval Queue

The most architecturally interesting component. It bridges the synchronous HTTP request/response cycle with the asynchronous Telegram callback.

```typescript
interface PendingApproval {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  telegramMessageId: number;
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: NodeJS.Timeout;
  createdAt: Date;
}

type ApprovalDecision = {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason: string;
};
```

**Flow:**
1. PreToolUse POST arrives
2. Create a new `Promise<ApprovalDecision>`
3. Store the promise's `resolve` function in a `Map<string, PendingApproval>` keyed by `requestId`
4. Send Telegram message with buttons (callback_data includes requestId)
5. `await` the promise (this holds the HTTP response open)
6. When callback_query arrives: lookup requestId, call `resolve(decision)`
7. Promise resolves, HTTP handler returns the decision as JSON response

**Timeout handling:** Set a timeout (e.g., 240 seconds, under the 300s hook timeout). On timeout:
- Option A: Auto-approve (convenient but risky)
- Option B: Auto-deny (safe but annoying)
- Option C: Return `permissionDecision: "ask"` which escalates to the terminal permission prompt
- **Recommend Option C** -- if the user doesn't respond in Telegram, they can still approve at the terminal

**Concurrent sessions:** Each approval is keyed by a unique `requestId` (UUID), not `sessionId`. Multiple sessions can have simultaneous pending approvals. The callback_data in Telegram buttons encodes the requestId, so responses are unambiguous regardless of which topic they come from.

### 6. Log Watcher

Monitors Claude Code's JSONL transcript files for assistant text output that isn't captured by hooks.

**Why needed:** Hooks capture structured events (tool calls, notifications, stops) but NOT Claude's text reasoning output. The text Claude writes between tool calls is only in the transcript JSONL file.

**Implementation:**
- Use `chokidar` to watch the transcript file path (provided in SessionStart hook's `transcript_path` field)
- On file change: read new lines appended since last read position
- Parse each JSONL line, filter for assistant messages
- Extract text content, post to session's Telegram topic
- Use file offset tracking (not re-reading entire file)

**Transcript format (based on community analysis):**
- Each line is a JSON object
- Lines have a `type` field indicating the message type
- Assistant text messages contain the reasoning/response content
- Tool use and tool results are separate line types

**Confidence: MEDIUM** -- The JSONL format is used by multiple community tools (claude-code-log, claude-JSONL-browser, claude-conversation-extractor) but the exact schema varies by Claude Code version and isn't formally documented as a stable API.

**Deduplication concern:** PostToolUse hooks already capture tool results. The log watcher should skip lines that correspond to events already forwarded via hooks to avoid duplicating messages in Telegram.

### 7. Message Formatter

Converts raw hook JSON into readable Telegram messages with appropriate formatting.

```
PreToolUse(Bash):
  "Running: npm test"
  -> "$ npm test"
  [Approve] [Deny]

PostToolUse(Write):
  "Wrote /src/index.ts (45 lines)"
  -> "Wrote src/index.ts (45 lines)"

PostToolUse(Edit):
  "Edited /src/app.ts: replaced 3 lines"
  -> "Edited src/app.ts"

PostToolUse(Read):
  -> batched/suppressed (too noisy)

Stop:
  "Claude finished: 'I've completed the refactoring...'"
  -> "Session paused. Summary: I've completed the refactoring..."
```

**Telegram message format:** Use HTML parse mode (Telegram supports HTML in messages). Format tool names as `<code>`, file paths as `<code>`, bash commands in `<pre>` blocks.

**Message length limit:** Telegram messages max at 4096 characters. For long tool outputs, truncate with "... (truncated, N chars total)".

## Patterns to Follow

### Pattern 1: Promise-based Request Bridging

**What:** Use JavaScript Promises to bridge synchronous HTTP request/response with asynchronous event-driven Telegram callbacks.
**When:** Any time a hook needs to wait for user input from Telegram before responding.
**Example:**

```typescript
// In HTTP route handler
app.post('/hooks/pre-tool-use', async (req, res) => {
  const { session_id, tool_name, tool_input } = req.body;
  const requestId = crypto.randomUUID();

  // Create promise and store its resolver
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      resolve({ permissionDecision: 'ask', permissionDecisionReason: 'Telegram timeout' });
      approvalQueue.delete(requestId);
    }, 240_000);

    approvalQueue.set(requestId, { resolve, timeoutHandle, sessionId: session_id });

    // Send approval message to Telegram
    telegramClient.sendApprovalRequest(session_id, requestId, tool_name, tool_input);
  });

  res.json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...decision,
    },
  });
});

// In Telegram callback handler
bot.on('callback_query:data', async (ctx) => {
  const [action, requestId] = ctx.callbackQuery.data.split(':');
  const pending = approvalQueue.get(requestId);
  if (!pending) return ctx.answerCallbackQuery('Request expired');

  clearTimeout(pending.timeoutHandle);
  approvalQueue.delete(requestId);

  const decision: ApprovalDecision = {
    permissionDecision: action === 'approve' ? 'allow' : 'deny',
    permissionDecisionReason: `${action === 'approve' ? 'Approved' : 'Denied'} via Telegram`,
  };

  pending.resolve(decision);
  await ctx.answerCallbackQuery(action === 'approve' ? 'Approved' : 'Denied');
  await ctx.editMessageReplyMarkup(undefined); // Remove buttons after decision
});
```

### Pattern 2: Message Batching with Debounce

**What:** Batch rapid-fire PostToolUse events into single Telegram messages to avoid rate limits.
**When:** Claude reads multiple files, runs sequential commands, or edits several files in quick succession.
**Example:**

```typescript
class MessageBatcher {
  private pending = new Map<string, { messages: string[]; timer: NodeJS.Timeout }>();
  private readonly DEBOUNCE_MS = 2000;
  private readonly MAX_BATCH = 10;

  add(sessionId: string, message: string) {
    const existing = this.pending.get(sessionId);
    if (existing) {
      existing.messages.push(message);
      clearTimeout(existing.timer);
      if (existing.messages.length >= this.MAX_BATCH) {
        this.flush(sessionId);
        return;
      }
    } else {
      this.pending.set(sessionId, { messages: [message], timer: null! });
    }
    const entry = this.pending.get(sessionId)!;
    entry.timer = setTimeout(() => this.flush(sessionId), this.DEBOUNCE_MS);
  }

  private flush(sessionId: string) {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    const combined = entry.messages.join('\n');
    this.emit('batch', sessionId, combined);
  }
}
```

### Pattern 3: Graceful Degradation

**What:** If the bridge server is down or Telegram is unreachable, Claude Code continues unimpaired.
**When:** Always -- this is a monitoring/control overlay, not a dependency.
**How:** HTTP hook failures are non-blocking by design (Claude Code continues on connection failure). For PreToolUse, timeout resolution falls back to `permissionDecision: "ask"` which shows the terminal prompt.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Command Hooks with Unix Socket IPC

**What:** Using `type: "command"` hooks with bash scripts that connect to a Unix domain socket or named pipe to communicate with the bot process.
**Why bad:** Requires writing and maintaining bash scripts that handle JSON parsing (jq), socket connections (netcat/socat), timeouts, error handling, and response formatting. Fragile, hard to debug, and unnecessary when HTTP hooks exist natively.
**Instead:** Use `type: "http"` hooks that POST directly to the bridge server. Zero shell scripts needed.

### Anti-Pattern 2: Polling for New Sessions

**What:** Periodically scanning the filesystem or process list to detect new Claude Code sessions.
**Why bad:** Race conditions, missed sessions, wasted CPU, and fragile process detection.
**Instead:** Let sessions self-register via the SessionStart hook. The first hook event from a session automatically triggers topic creation.

### Anti-Pattern 3: One Message Per Tool Event

**What:** Sending a separate Telegram message for every single Read, Glob, and Grep tool call.
**Why bad:** Hits Telegram's 20 messages/minute/group rate limit within seconds during a typical Claude Code session. Results in 429 errors, dropped messages, and a noisy unreadable topic.
**Instead:** Batch non-critical events, use editMessageText for running updates, and suppress low-value events (Read, Glob, Grep) by default.

### Anti-Pattern 4: Persistent Database for Session State

**What:** Using SQLite or similar for session state management.
**Why bad:** Over-engineered for 2-3 machines with at most 5-10 concurrent sessions each. Adds a dependency, migration concerns, and failure modes. Sessions are ephemeral by nature.
**Instead:** In-memory Map with optional JSON file backup for crash recovery.

### Anti-Pattern 5: Webhook Mode for Telegram Bot

**What:** Setting up Telegram webhook (requires public HTTPS URL) instead of long-polling.
**Why bad:** This is a local-only per-machine bot. There is no public URL. Setting up ngrok/Cloudflare Tunnel adds unnecessary complexity and a failure point.
**Instead:** Use long-polling via `bot.start()` in grammY. Perfectly fine for this use case with low message volume.

## Scalability Considerations

| Concern | 1 session | 5 concurrent sessions | 10+ sessions |
|---------|-----------|----------------------|--------------|
| HTTP server load | Trivial | Trivial | Still trivial (localhost, < 100 req/min) |
| Telegram rate limit | No issue | Batching needed | Aggressive batching, event filtering |
| Memory (session state) | < 1 MB | < 5 MB | < 10 MB |
| Telegram topics | Clean | Manageable | Topic list gets long; consider archival |
| Approval queue | 0-1 pending | 0-5 pending | Need UI to show which sessions are waiting |
| Log watcher (file handles) | 1 file | 5 files | chokidar handles fine, but watch inotify limits |

**Target scale (from PROJECT.md): 2-3 machines, each potentially running multiple concurrent sessions.** The architecture handles this easily. No scaling concerns at this level.

## Open Architecture Questions

### How to Send Text Input FROM Telegram TO Claude Code

This is the **hardest unsolved problem** in the architecture. Hooks provide a clean output channel (Claude Code -> bridge), but there is no clean input channel for arbitrary text going the other way.

**Options investigated:**

1. **Hijack PreToolUse response with `updatedInput`**: The PreToolUse hook can modify tool input via `updatedInput`. Not useful for injecting arbitrary text.

2. **Use `additionalContext` on PreToolUse/SessionStart**: These hooks can add context strings that Claude sees. But they only fire on events -- there is no way to push text to Claude on demand.

3. **Write to a file that Claude is instructed to check**: Have the bot write Telegram messages to a file like `.claude-telegram-input.txt` and include CLAUDE.md instructions telling Claude to read it periodically. Fragile and unreliable.

4. **Use Stop hook to continue with new context**: When Claude stops, the Stop hook fires. Return `decision: "block"` with `reason` containing the user's Telegram text, which forces Claude to continue with that text as feedback. **This only works when Claude has already stopped and is waiting.**

5. **PermissionRequest hook for interactive approval**: When Claude asks for permission (separate from PreToolUse), the user can respond via Telegram. This covers the approval case but not general text input.

**Pragmatic recommendation for MVP:** Focus on the approval flow (PreToolUse approve/deny via Telegram) and status monitoring (PostToolUse, Stop, Notification posted to Telegram). Defer arbitrary text input as a phase 2 feature. The Stop hook + `decision: "block"` approach can provide a limited form of feedback injection when Claude pauses.

**Confidence: LOW** -- This is an area where the Claude Code hook system has a genuine architectural gap for full bidirectional communication. The hook system is designed as an event listener, not a bidirectional channel.

### Hook Timeout Edge Cases

The default command hook timeout is 600s, but HTTP hook timeout behavior on connection failure vs slow response needs testing. If the bridge server is up but slow to respond (waiting for Telegram approval), does Claude Code wait the full timeout or does it have a separate connection timeout?

**Recommendation:** Test empirically during Phase 1. Set hook timeout to 300s and verify Claude Code waits the full duration for a slow HTTP response.

## Suggested Build Order

Based on component dependencies:

```
Phase 1: Foundation
  1. HTTP Server skeleton (routes, JSON parsing)
  2. Telegram Client (bot initialization, long-polling, basic sendMessage)
  3. Session Manager (in-memory map)
  4. Hook Config (settings.json for HTTP hooks)
  -> Delivers: PostToolUse events posted to manually-created Telegram topic

Phase 2: Session Lifecycle
  5. SessionStart -> createForumTopic
  6. SessionEnd -> closeForumTopic
  7. Session-to-topic mapping (both directions)
  -> Delivers: Auto-created topics per session, auto-closed on end

Phase 3: Approval Flow (Critical Path)
  8. Approval Queue (Promise-based bridging)
  9. PreToolUse handler with inline keyboard buttons
  10. Callback query handler resolving approvals
  11. Timeout handling with fallback to terminal
  -> Delivers: Approve/deny Claude Code tool calls from Telegram

Phase 4: Message Quality
  12. Message Formatter (readable tool call formatting)
  13. Message Batcher (debounce rapid events)
  14. Rate limit handling (Telegram 429 retries)
  -> Delivers: Clean, rate-limited message output

Phase 5: Log Watcher
  15. Transcript file watcher (chokidar on transcript_path)
  16. JSONL parser for assistant text messages
  17. Deduplication with hook-sourced events
  -> Delivers: Claude's text reasoning visible in Telegram

Phase 6: Polish
  18. Notification handler (idle prompts, permission prompts)
  19. Stop handler with session summary
  20. Error handling and reconnection logic
  21. Optional: text input from Telegram via Stop hook injection
```

**Dependency chain:** Phase 1 is prerequisite for all others. Phase 2 can parallel with Phase 3. Phase 4 can start after Phase 1. Phase 5 depends on Phase 2 (needs session mapping). Phase 6 depends on all prior.

## Sources

- [Claude Code Hooks Reference (official docs)](https://code.claude.com/docs/en/hooks) -- HIGH confidence, primary source for hook architecture
- [Claude Code Hooks Observability Project](https://github.com/disler/claude-code-hooks-multi-agent-observability) -- MEDIUM confidence, validates HTTP hook pattern in practice
- [Telegram Bot API](https://core.telegram.org/bots/api) -- HIGH confidence, official API docs
- [grammY Telegram Bot Framework](https://grammy.dev/) -- MEDIUM confidence, needs Context7 verification
- [grammY Flood Control docs](https://grammy.dev/advanced/flood) -- MEDIUM confidence
- [Claude Code conversation history analysis](https://kentgigger.com/posts/claude-code-conversation-history) -- MEDIUM confidence, community analysis of log format
- [Telegram Bot FAQ - Rate Limits](https://core.telegram.org/bots/faq) -- HIGH confidence, official source
