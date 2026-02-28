# Phase 1: Foundation - Research

**Researched:** 2026-02-28
**Domain:** Claude Code HTTP hooks, Telegram Bot API (forum topics, rate limiting, HTML formatting), Fastify HTTP server, grammY Telegram framework
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Topic Naming & Presentation**
- Topic name uses session description if available, falls back to project directory name
- Machine name is implicit (the bot IS the machine identity in the group)
- Topic name updates if the user runs /rename in Claude Code
- Post a final summary message before closing topic (duration, files changed, tools used)
- Use status emojis as visual indicators (green circle active, checkmark done)

**Bot Setup Experience**
- Configuration via both config file and environment variables -- env vars override config file defaults
- Simple startup via `node src/index.js` -- user manages how to keep it running (systemd, pm2, etc.)
- Bot auto-installs Claude Code hooks by writing hook config to Claude Code's settings on first run
- On first run with missing config, show clear error with setup steps (no interactive wizard)

**Message Style**
- Tiered verbosity: compact one-liners for reads/searches, detailed structured blocks for edits/bash commands
- Smart output splitting: short output inline, medium in code block, long as .txt file attachment
- Use emojis per tool type (pencil edits, eye reads, computer bash, checkmark success, x errors)
- Show diffs for file edits: old_string to new_string in code blocks

**Session Lifecycle**
- On bot restart: reconnect to existing topics from saved session map + post "Bot restarted" notification in active topics
- On session resume (--resume): reuse the old topic -- reopen it and continue posting there
- Health check via on-demand /status command sent to the bot (no periodic heartbeat spam)
- Duplicate sessions in same directory: append start timestamp for disambiguation, e.g. "my-project (14:32)"

### Claude's Discretion
- Exact HTML formatting templates and message structure
- Rate limit batching strategy (debounce timing, batch window size)
- Session map storage format and persistence mechanism
- Error handling for Telegram API failures

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SESS-01 | Bot auto-creates a Telegram forum topic when a Claude Code session starts (via SessionStart hook) | SessionStart hook documented with full JSON schema; grammY `createForumTopic` API verified; HTTP hook type posts to local Fastify server |
| SESS-02 | Bot auto-closes the topic when the Claude Code session ends (via SessionEnd hook) | SessionEnd hook documented with JSON schema and reason field; grammY `closeForumTopic` API verified |
| SESS-03 | Bot auto-discovers new sessions without manual registration | HTTP hooks POST to local server automatically; bot auto-installs hooks into `~/.claude/settings.json` on first run |
| SESS-04 | Concurrent sessions each get their own topic with isolated message routing | Each hook POST includes `session_id` for routing; session map correlates session_id to topic message_thread_id |
| SESS-05 | Each machine runs its own bot with a separate BotFather token, appearing as a distinct group member | One bot token per config; bot name in group IS the machine identity |
| MNTR-04 | Messages are batched and queued to stay under Telegram's 20 msg/min rate limit | grammY `transformer-throttler` plugin (Bottleneck-based) + `auto-retry` plugin; custom debounce layer for within-session batching |
| UX-01 | Messages use HTML formatting with code blocks for commands, bold for tool names | Telegram HTML parse_mode supports `<b>`, `<code>`, `<pre>`, `<blockquote>`; grammY parse-mode plugin sets default |
| UX-02 | Outputs exceeding 4096 characters are sent as .txt document attachments | Telegram 4096 char limit confirmed; grammY `sendDocument` with `InputFile(buffer, 'output.txt')` |
</phase_requirements>

## Summary

This phase builds the plumbing layer: a single Node.js process running both a Fastify HTTP server (receiving Claude Code hook POSTs) and a grammY Telegram bot (managing forum topics and sending formatted messages). Claude Code's hook system now supports 17 lifecycle events with 4 handler types including HTTP (`type: "http"`), which POSTs JSON payloads directly to a URL. The bot receives SessionStart, SessionEnd, and PostToolUse events, correlates them by `session_id`, and routes messages to the correct Telegram forum topic.

The Telegram Bot API confirms forum topic support via `createForumTopic`, `closeForumTopic`, and `reopenForumTopic`. The bot needs admin rights with `can_manage_topics` in the supergroup. Messages sent to topics require `message_thread_id`. The confirmed rate limit is 20 messages per minute per group, which the grammY ecosystem handles through the `transformer-throttler` plugin (Bottleneck-based queuing) and `auto-retry` plugin (retry on 429 errors). However, for this project's use case, a custom debounce/batch layer is also needed because multiple PostToolUse events fire in rapid succession during active sessions and should be combined into fewer messages.

The session map (correlating `session_id` to Telegram `message_thread_id`) should be persisted as a simple JSON file. This handles bot restarts (reconnect to existing topics) and session resumes. A known issue exists where `session_id` may change on `--resume` (GitHub issue #12235), but for `--continue` and `/exit` cycles the fix in v2.0.24 ensures stable IDs. The `cwd` field in hook payloads provides the project directory, which is used for topic naming. The `transcript_path` field provides the path to the session's JSONL transcript for potential future use.

**Primary recommendation:** Build a single-process Fastify + grammY daemon. Use HTTP hooks (`type: "http"`) for all Claude Code lifecycle events. Implement a two-layer rate limit strategy: grammY's `transformer-throttler` for API-level protection, plus a custom debounce/batch queue per-session for message consolidation.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | 1.40.x | Telegram Bot framework | TypeScript-first, active maintenance, 10M+ downloads/month, built-in plugin ecosystem for throttling and auto-retry |
| fastify | 5.7.x | HTTP server for hook POSTs | Fastest Node.js HTTP framework, JSON body parsing built-in, plugin architecture, v5 stable |
| @grammyjs/auto-retry | latest | Auto-retry on 429 flood errors | Transparently handles Telegram rate limit responses with backoff |
| @grammyjs/transformer-throttler | latest | API request throttling | Bottleneck-based queue, 20 msg/min group limit built into defaults |
| @grammyjs/parse-mode | latest | Default HTML parse mode | Sets parse_mode globally, adds `replyWithHTML` convenience methods |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| dotenv | latest | Environment variable loading | Loading `.env` file for bot token, chat ID, etc. |
| pino | latest | Structured logging | Fastify uses pino by default; share it for consistent logging |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fastify | Express | Express is simpler but slower, no built-in JSON schema validation, no native TypeScript support |
| grammy | telegraf | Telegraf is older and less actively maintained; grammY has better TypeScript support and plugin ecosystem |
| JSON file persistence | node-persist, SQLite | Overkill for a simple session map of 2-10 entries; plain JSON file with atomic write is sufficient |

**Installation:**
```bash
npm install grammy @grammyjs/auto-retry @grammyjs/transformer-throttler @grammyjs/parse-mode fastify dotenv pino
npm install -D typescript @types/node
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  index.ts              # Entry point: starts both Fastify and grammY bot
  config.ts             # Configuration loading (env vars + config file)
  bot/
    bot.ts              # grammY bot setup, plugins, middleware
    topics.ts           # Forum topic lifecycle (create, close, reopen, rename)
    formatter.ts        # HTML message formatting templates
    rate-limiter.ts     # Custom debounce/batch queue per session
  hooks/
    server.ts           # Fastify HTTP server for receiving hook POSTs
    handlers.ts         # Route handlers: session-start, session-end, post-tool-use
  sessions/
    session-map.ts      # session_id <-> message_thread_id mapping + persistence
    session-store.ts    # JSON file read/write with atomic save
  types/
    hooks.ts            # TypeScript types for Claude Code hook payloads
    config.ts           # Configuration type definitions
  utils/
    text.ts             # Text truncation, smart splitting for 4096 char limit
    install-hooks.ts    # Auto-install HTTP hooks into Claude Code settings.json
data/
  sessions.json         # Persisted session map (created at runtime)
```

### Pattern 1: Single-Process Dual Server
**What:** One Node.js process runs both the Fastify HTTP server (port configurable, default 3456) and the grammY bot (long polling mode).
**When to use:** Always -- this is the core architecture for the bot daemon.
**Example:**
```typescript
// Source: Fastify + grammY official docs
import Fastify from 'fastify';
import { Bot } from 'grammy';

const fastify = Fastify({ logger: true });
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// Register hook routes
fastify.post('/hooks/session-start', async (request, reply) => {
  const payload = request.body as SessionStartPayload;
  await handleSessionStart(payload);
  return { status: 'ok' };
});

// Start both
await bot.start();
await fastify.listen({ port: 3456, host: '127.0.0.1' });
```

### Pattern 2: Session Map with Atomic Persistence
**What:** In-memory Map<string, SessionInfo> backed by a JSON file. Writes use rename-on-close for atomic updates.
**When to use:** For correlating session_id to Telegram topic thread ID across restarts.
**Example:**
```typescript
import { writeFileSync, readFileSync, renameSync } from 'node:fs';

interface SessionInfo {
  sessionId: string;
  threadId: number;         // Telegram message_thread_id
  cwd: string;              // Project directory
  topicName: string;        // Display name in Telegram
  startedAt: string;        // ISO timestamp
  status: 'active' | 'closed';
}

class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private filePath: string;

  save(): void {
    const data = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, this.filePath);
  }

  load(): void {
    const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    this.sessions = new Map(Object.entries(data));
  }
}
```

### Pattern 3: Two-Layer Rate Limiting
**What:** Layer 1 (grammY plugins) handles Telegram API limits. Layer 2 (custom) batches per-session messages before they even reach grammY.
**When to use:** Always -- PostToolUse events fire in rapid bursts during active sessions.
**Example:**
```typescript
// Layer 1: grammY API-level throttling
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';

bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
bot.api.config.use(apiThrottler());

// Layer 2: Custom per-session debounce
class MessageBatcher {
  private queues = new Map<string, { messages: string[]; timer: NodeJS.Timeout | null }>();
  private batchWindowMs = 2000; // 2-second window

  enqueue(sessionId: string, message: string): void {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { messages: [], timer: null };
      this.queues.set(sessionId, queue);
    }
    queue.messages.push(message);
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => this.flush(sessionId), this.batchWindowMs);
  }

  private async flush(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.messages.length === 0) return;
    const combined = queue.messages.join('\n\n');
    queue.messages = [];
    queue.timer = null;
    await this.sendToTelegram(sessionId, combined);
  }
}
```

### Pattern 4: Auto-Install Hooks into Claude Code Settings
**What:** On first run, the bot reads `~/.claude/settings.json`, merges HTTP hook configuration, and writes it back.
**When to use:** First run setup -- the bot configures Claude Code to POST to its Fastify server.
**Example:**
```typescript
// Source: Claude Code hooks reference (code.claude.com/docs/en/hooks)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function installHooks(port: number): void {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const claudeDir = join(homedir(), '.claude');

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let settings: any = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const hookConfig = {
    SessionStart: [{
      hooks: [{ type: 'http', url: `${baseUrl}/hooks/session-start` }]
    }],
    SessionEnd: [{
      hooks: [{ type: 'http', url: `${baseUrl}/hooks/session-end` }]
    }],
    PostToolUse: [{
      hooks: [{ type: 'http', url: `${baseUrl}/hooks/post-tool-use`, async: true }]
    }]
  };

  settings.hooks = { ...settings.hooks, ...hookConfig };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

### Anti-Patterns to Avoid
- **Polling for sessions:** Do not scan for Claude Code processes or watch file system. HTTP hooks push events to the bot -- no polling needed.
- **Shell command hooks instead of HTTP:** Do not use `type: "command"` hooks that shell out to curl. Use `type: "http"` directly -- it is a first-class hook handler type with proper error handling.
- **Blocking PostToolUse hooks:** PostToolUse is non-blocking by design (exit code 2 just shows stderr to Claude, it cannot block). Keep PostToolUse hook handlers fast. Use `async: true` if processing takes time.
- **Single-message-per-event:** Do not send one Telegram message per PostToolUse event. Batch them. A session can fire dozens of tool calls per minute.
- **Storing session state in memory only:** Always persist to disk. The bot restarts, and you need to reconnect to existing Telegram topics.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Telegram rate limiting | Custom retry logic with timers | `@grammyjs/auto-retry` + `@grammyjs/transformer-throttler` | Bottleneck handles reservoir-based rate limiting with 20 msg/min group defaults; auto-retry handles 429 responses transparently |
| HTML entity escaping | Manual string replacement for `<>&` | grammY `parse-mode` plugin + template literals | Missed edge cases cause message send failures; the plugin handles escaping properly |
| HTTP JSON body parsing | Manual stream reading and JSON.parse | Fastify built-in JSON parsing | Fastify parses JSON bodies by default with configurable limits and security settings |
| File uploads to Telegram | Manual multipart/form-data construction | grammY `InputFile` class | `new InputFile(buffer, 'output.txt')` handles all multipart encoding automatically |
| Graceful shutdown | Manual signal handlers | Fastify `close()` + grammY `bot.stop()` | Both have built-in graceful shutdown that drains connections and flushes queues |

**Key insight:** The Telegram rate limiting problem is deceptively complex. The actual limits are undocumented and flexible -- Telegram intentionally does not publish exact numbers. The only safe strategy is: send as fast as you can, handle 429 responses with auto-retry, and use the throttler plugin as a preventive layer. Do not try to predict exact timing.

## Common Pitfalls

### Pitfall 1: Session ID Instability on Resume
**What goes wrong:** When a user resumes a session with `--resume`, the `session_id` in hook payloads may be a new UUID instead of the original session's ID (GitHub issue #12235).
**Why it happens:** Claude Code internally creates new sessions on resume in some code paths.
**How to avoid:** Use `cwd` + `transcript_path` as a secondary correlator. When a SessionStart with `source: "resume"` arrives, check if there's an existing active session for the same `cwd` and reuse its topic. Store `transcript_path` in the session map as an additional key.
**Warning signs:** A resumed session creates a new topic instead of reusing the existing one.

### Pitfall 2: Message Length Exceeding 4096 Characters
**What goes wrong:** Telegram returns error 400 "message is too long" and the message is lost.
**Why it happens:** Tool outputs (especially Bash command results, file contents) can be arbitrarily long.
**How to avoid:** Check length before sending. If > 4096 chars, send as `.txt` document attachment using `sendDocument` with `InputFile`. For medium-length outputs, truncate with "... (truncated)" and offer full output as attachment.
**Warning signs:** `sendMessage` calls returning 400 errors.

### Pitfall 3: HTML Parse Errors Killing Messages
**What goes wrong:** Telegram returns error 400 "can't parse entities" and the message is lost.
**Why it happens:** Tool output may contain unescaped `<`, `>`, or `&` characters that break HTML parsing.
**How to avoid:** Always escape user content (tool outputs, file paths) before embedding in HTML templates. Only the template structure should contain HTML tags. Escape function: replace `&` with `&amp;`, `<` with `&lt;`, `>` with `&gt;`.
**Warning signs:** Messages fail to send for certain tool outputs (especially ones containing angle brackets like generic types, XML, JSX).

### Pitfall 4: Race Condition in Session Map on Concurrent Hook POSTs
**What goes wrong:** Two concurrent sessions start simultaneously, both try to read-modify-write the session map, and one write overwrites the other.
**Why it happens:** Multiple Claude Code sessions fire SessionStart hooks at nearly the same time, and the Fastify server handles them concurrently.
**How to avoid:** Use an in-memory Map as the primary store and only flush to disk on changes. Since Node.js is single-threaded, Map operations are atomic within the event loop. Serialize disk writes (don't write concurrently).
**Warning signs:** A session's topic disappears from the session map after restart.

### Pitfall 5: Bot Not Admin in Group
**What goes wrong:** `createForumTopic` fails with "bot is not an administrator" error.
**Why it happens:** The user created the group but forgot to promote the bot to admin with `can_manage_topics` rights.
**How to avoid:** On startup, call `getChat` or `getChatMember` to verify the bot has admin rights. Show a clear error message if not. Document this in setup instructions.
**Warning signs:** First SessionStart event fails to create a topic.

### Pitfall 6: PostToolUse Hooks Not Being Async
**What goes wrong:** Claude Code waits for the HTTP response before continuing to the next tool call, slowing down the session.
**Why it happens:** HTTP hooks block by default. Non-2xx responses and timeouts are non-blocking errors, but successful responses still cause Claude Code to wait for the response.
**How to avoid:** Response immediately with `200 {}` from all PostToolUse endpoints. The Fastify handler should enqueue the message and return immediately. Consider also setting `"async": true` on the hook config, which makes Claude Code fire-and-forget the POST.
**Warning signs:** Claude Code sessions feel slower with the bot running.

## Code Examples

Verified patterns from official sources:

### Creating a Forum Topic
```typescript
// Source: grammy.dev/ref/core/api - createForumTopic
const topic = await bot.api.createForumTopic(
  chatId,
  '🟢 my-project',     // topic name with status emoji
  {
    icon_color: 0x6FB9F0, // optional: blue icon
  }
);
const threadId = topic.message_thread_id;
// Store threadId in session map for routing messages
```

### Sending a Message to a Forum Topic
```typescript
// Source: grammy.dev/guide/api + Telegram Bot API docs
await bot.api.sendMessage(chatId, formattedHtml, {
  message_thread_id: threadId,
  parse_mode: 'HTML',
});
```

### Closing and Reopening a Topic
```typescript
// Source: grammy.dev/ref/core/api
await bot.api.closeForumTopic(chatId, threadId);
// On session resume:
await bot.api.reopenForumTopic(chatId, threadId);
```

### Editing a Topic Name (for rename or status change)
```typescript
// Source: grammy.dev/ref/core/api - editForumTopic
await bot.api.editForumTopic(chatId, threadId, {
  name: '✅ my-project (done)',
});
```

### Sending a File Attachment for Long Output
```typescript
// Source: grammy.dev/guide/files + InputFile docs
import { InputFile } from 'grammy';

const content = longToolOutput; // string > 4096 chars
const buffer = new TextEncoder().encode(content);
await bot.api.sendDocument(
  chatId,
  new InputFile(buffer, 'output.txt'),
  {
    message_thread_id: threadId,
    caption: '<b>Output too long for inline display</b>',
    parse_mode: 'HTML',
  }
);
```

### HTML Formatting for Tool Messages
```typescript
// Source: core.telegram.org/bots/api#html-style
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Compact one-liner for reads
function formatRead(filePath: string): string {
  return `👁 Read <code>${escapeHtml(filePath)}</code>`;
}

// Detailed block for edits
function formatEdit(filePath: string, oldStr: string, newStr: string): string {
  return [
    `📝 <b>Edit</b> <code>${escapeHtml(filePath)}</code>`,
    '<pre>',
    `- ${escapeHtml(oldStr)}`,
    `+ ${escapeHtml(newStr)}`,
    '</pre>',
  ].join('\n');
}

// Bash command with output
function formatBash(command: string, output: string): string {
  const truncated = output.length > 1000
    ? output.slice(0, 1000) + '\n... (truncated)'
    : output;
  return [
    `💻 <b>Bash</b>`,
    `<pre><code>${escapeHtml(command)}</code></pre>`,
    truncated ? `<blockquote>${escapeHtml(truncated)}</blockquote>` : '',
  ].filter(Boolean).join('\n');
}
```

### Fastify Hook Endpoint with Type Safety
```typescript
// Source: fastify.dev/docs/latest/Reference/Server + Claude Code hooks reference
import Fastify from 'fastify';

interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
}

interface SessionStartPayload extends HookPayload {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model: string;
}

interface SessionEndPayload extends HookPayload {
  hook_event_name: 'SessionEnd';
  reason: string;
}

interface PostToolUsePayload extends HookPayload {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

const fastify = Fastify({ logger: true });

fastify.post<{ Body: SessionStartPayload }>('/hooks/session-start', async (request) => {
  const { session_id, cwd, source } = request.body;
  // Handle session start...
  return {};  // 200 with empty JSON body = success, no decision
});
```

### Claude Code Hook Configuration (auto-installed by bot)
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:3456/hooks/session-start",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:3456/hooks/session-end",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:3456/hooks/post-tool-use",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell command hooks only | HTTP hooks (`type: "http"`) as first-class handler type | Claude Code 2.x (2025) | No shell scripts needed; direct POST to local server |
| 7 hook events | 17 hook events (SessionStart, SessionEnd, PostToolUse, PreToolUse, Notification, SubagentStart/Stop, Stop, etc.) | Claude Code 2.x (late 2025 - early 2026) | Full lifecycle coverage; more events to monitor |
| Prompt-based hooks only | Prompt + Agent + Command + HTTP hook types | Claude Code 2.x (2025-2026) | Four distinct handler types; HTTP is ideal for daemon bots |
| grammY v1.x | grammY 1.40.x | Ongoing | Stable API, TypeScript-first, active ecosystem |
| Fastify v4 | Fastify v5.7.x | 2024-2025 | Requires Node.js v20+; v4 EOL June 2025 |
| Telegraf (older Telegram framework) | grammY (modern replacement) | 2021+ | Better TypeScript support, more active maintenance, plugin ecosystem |

**Deprecated/outdated:**
- PreToolUse top-level `decision` and `reason` fields: deprecated in favor of `hookSpecificOutput.permissionDecision` and `hookSpecificOutput.permissionDecisionReason`
- Fastify v4: end of life June 2025, use v5
- `async: true` on HTTP hooks: Note that `async` is only documented for command hooks. HTTP hooks are inherently non-blocking on error (non-2xx = non-blocking), but successful responses still cause Claude Code to wait. The Fastify handler should respond immediately.

## Open Questions

1. **Session ID stability on --resume**
   - What we know: Issue #12235 reports session_id changes on `--resume`. Issue #9188 (stale session_id on `/exit` + `--continue`) was fixed in v2.0.24. The `--resume` case may or may not be fixed in current versions.
   - What's unclear: Whether current Claude Code (v2.x latest) still exhibits session_id changes on `--resume`.
   - Recommendation: Implement defensive correlation using `cwd` as a secondary key. When a SessionStart with `source: "resume"` arrives for a `cwd` that has an active session, reuse the existing topic. This handles the issue regardless of whether it's been fixed upstream.

2. **Exact async behavior of HTTP hooks**
   - What we know: The `async` field is documented for command hooks. HTTP hooks have different error handling (non-2xx is non-blocking). The docs say "HTTP hooks cannot signal a blocking error through status codes alone."
   - What's unclear: Whether setting `async: true` on HTTP hooks is supported or silently ignored.
   - Recommendation: Do not rely on `async: true` for HTTP hooks. Instead, make all Fastify handlers respond immediately with `200 {}` and process messages asynchronously in the background.

3. **Topic name from session description**
   - What we know: The SessionStart payload includes `session_id`, `cwd`, `source`, and `model`. There is no `description` or `name` field in the SessionStart payload.
   - What's unclear: How to get the "session description" that the user may set. It may only be available by parsing the transcript JSONL file.
   - Recommendation: Default to deriving the topic name from `cwd` (basename of the directory path, e.g., `/home/user/my-project` becomes `my-project`). If a session description feature exists, it can be added later when the transcript parsing phase (Phase 2) is implemented.

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) - Full hook lifecycle, all 17 events, HTTP hook type, JSON schemas for SessionStart/SessionEnd/PostToolUse, configuration format
- [grammY Official Docs](https://grammy.dev/) - Bot creation, API methods, plugin system
- [grammY API Reference](https://grammy.dev/ref/core/api) - createForumTopic, closeForumTopic, reopenForumTopic, editForumTopic, sendMessage, sendDocument signatures
- [Telegram Bot API](https://core.telegram.org/bots/api) - ForumTopic object, message_thread_id, HTML parse mode tags, 4096 char limit
- [Telegram Bots FAQ](https://core.telegram.org/bots/faq) - 20 messages per minute group limit, 50 MB file upload limit
- [Fastify Server Reference](https://fastify.dev/docs/latest/Reference/Server/) - v5.7.x, server creation, routes, JSON parsing, shutdown

### Secondary (MEDIUM confidence)
- [grammY Flood Limits Guide](https://grammy.dev/advanced/flood) - Rate limit handling best practices, auto-retry plugin
- [grammY Transformer-Throttler Plugin](https://grammy.dev/plugins/transformer-throttler) - Bottleneck-based throttling, default limits
- [grammY Auto-Retry Plugin](https://grammy.dev/plugins/auto-retry) - Configuration options, flood wait handling
- [grammY Parse-Mode Plugin](https://grammy.dev/plugins/parse-mode) - Default parse mode, HTML convenience methods
- [grammY File Handling](https://grammy.dev/guide/files) - InputFile class, buffer uploads
- [GitHub Issue #12235](https://github.com/anthropics/claude-code/issues/12235) - Session ID changes on resume (closed as duplicate of #8069)
- [GitHub Issue #9188](https://github.com/anthropics/claude-code/issues/9188) - Stale session_id bug, fixed in v2.0.24

### Tertiary (LOW confidence)
- Session description availability in hook payloads: Not found in official docs; may require transcript parsing (needs validation during implementation)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries verified via official docs and npm; versions confirmed current
- Architecture: HIGH - HTTP hook type fully documented in Claude Code official reference; grammY forum topic API verified; single-process pattern is straightforward
- Pitfalls: HIGH - Rate limits confirmed via official Telegram FAQ; session ID instability documented in GitHub issues with resolution status; HTML escaping requirements verified via official Telegram formatting docs

**Research date:** 2026-02-28
**Valid until:** 2026-03-28 (30 days - all components are stable)
