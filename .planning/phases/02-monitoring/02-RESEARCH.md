# Phase 2: Monitoring - Research

**Researched:** 2026-02-28
**Domain:** JSONL transcript parsing, Claude Code Notification hooks, Telegram editMessageText/pinChatMessage, fs.watch file tailing, verbosity filtering
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Message Verbosity & Filtering**
- Three verbosity tiers: Minimal (edits/bash only), Normal (all except reads/globs), Verbose (everything)
- Default tier: Normal
- Fixed tier mapping -- we define which tools go in which tier, not user-configurable
- Change verbosity via Telegram commands (/verbose, /normal, /quiet) in the session topic at runtime
- Env var sets the default verbosity, Telegram command overrides per-session
- Suppressed calls are tracked via silent counter -- periodic summary reports "12 Read calls, 3 Glob calls suppressed"

**Live Status Indicator**
- Pinned first message in each topic, updated in place with editMessageText
- Shows: context window usage (%), current tool being run, session duration, tool call count
- Updates on every PostToolUse event (real-time, no polling)
- Also update topic description with compact status (e.g., "Active | 45% ctx") via editForumTopic
- Context window data parsed from JSONL transcript file (extract token counts from API responses)

**Text Output & Transcript Parsing**
- Post Claude's direct assistant messages (user-facing responses), skip internal thinking/tool-use reasoning
- Long text blocks: truncate to ~500 chars inline, attach full text as .txt if exceeded (same pattern as Phase 1)
- Watch transcript file with fs.watch + tail approach -- event-driven, read new lines as appended
- Periodic summaries every ~5 minutes of activity: "Working on X -- edited 3 files, ran 2 commands, 45% context used"

**Notification Style & Urgency**
- Permission prompts use alert box style: bold header with warning emoji, tool name, what it wants to do -- visually distinct from regular tool calls
- Three urgency levels with different emoji/formatting:
  - Info (context updates, status changes)
  - Warning (permission prompts, high context usage)
  - Error (crashes, timeouts, failures)
- Idle alerts: post notification after ~2 minutes of no activity -- "Claude appears idle -- may be waiting for input or thinking". Configurable timeout.
- Context usage warnings at 80% and 95% thresholds -- separate notification messages, not just status update

### Claude's Discretion
- Exact JSONL transcript parsing implementation and which fields to extract
- fs.watch debounce strategy for rapid file changes
- Periodic summary message formatting and content aggregation
- How to handle transcript file rotation or unavailability
- editMessageText rate limiting strategy (separate from message sending rate limit)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MNTR-01 | Tool calls (file reads, edits, bash commands) are posted to the session topic via PostToolUse hook | Already implemented in Phase 1 -- PostToolUse handler + formatter exist. Phase 2 adds verbosity filtering to suppress/show based on tier. |
| MNTR-02 | Claude's text output is captured by parsing JSONL transcript files and posted to the topic | JSONL format researched: each line is JSON with `type`, `message.role`, `message.content` fields. Assistant messages have `type: "assistant"` with `message.role: "assistant"`. Content is array of blocks (text, tool_use). Token usage in `message.usage`. |
| MNTR-03 | Notification hook events (permission prompts, idle alerts) are forwarded to the topic | Notification hook documented: fires with `notification_type` (permission_prompt, idle_prompt, auth_success, elicitation_dialog), `message`, and optional `title`. HTTP hook config needed in install-hooks.ts. |
| MNTR-05 | A live-updating status message in each topic shows remaining context window and quota usage (updated via editMessageText) | Telegram `editMessageText` + `pinChatMessage` with `message_thread_id` supported. Context data from JSONL `message.usage` fields (input_tokens, cache_read_input_tokens, cache_creation_input_tokens). Context window sizes: 200k default, 1M extended. |
| MNTR-06 | Periodic summary updates aggregate activity ("Working on X, 3 files edited") | Timer-based (5-minute interval per CONTEXT.md). Aggregates from existing session stats (toolCallCount, filesChanged) + new metrics (suppressed count, context %). |
| UX-03 | Users can configure verbosity to filter which events get posted to Telegram | Three tiers (Minimal/Normal/Verbose) with fixed tool mappings. Bot commands (/verbose, /normal, /quiet). Env var for default. Per-session override stored in session state. |

</phase_requirements>

## Summary

Phase 2 adds the monitoring layer on top of Phase 1's session-to-topic plumbing. The existing codebase already posts tool calls to Telegram via PostToolUse hooks and has message formatting, batching, and rate limiting in place. Phase 2 needs to add five capabilities: (1) verbosity filtering for tool call messages, (2) JSONL transcript file watching to capture Claude's text output, (3) Notification hook forwarding for permission prompts and idle alerts, (4) a live-updating pinned status message per topic, and (5) periodic activity summaries.

The JSONL transcript format is well-documented through community tools and the official status line documentation. Each line is a JSON object with fields including `type` ("user", "assistant", "summary"), `message` (containing `role`, `content`, and for assistant messages `usage` with token counts), `uuid`, `timestamp`, `isSidechain`, and `sessionId`. Context window data is available from `message.usage` on assistant message entries: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens`. The official Claude Code status line docs confirm the context window size is 200,000 tokens by default (1,000,000 for extended context models), and `used_percentage` is calculated from input tokens only.

The Notification hook is officially documented with HTTP hook support. It fires for `permission_prompt`, `idle_prompt`, `auth_success`, and `elicitation_dialog` events with `message`, `title`, and `notification_type` fields. The hook needs to be added to the install-hooks.ts configuration. For the live status indicator, Telegram's `editMessageText` and `pinChatMessage` APIs both support `message_thread_id` for targeting specific forum topics. The topic description can be updated via `editForumTopic` with a name up to 128 characters.

**Primary recommendation:** Extend the existing PostToolUse pipeline with a verbosity filter, add a TranscriptWatcher class using `fs.watch` + incremental read for JSONL tailing, register a new Notification hook endpoint, and create a StatusMessage class that manages a pinned message per topic with debounced editMessageText calls.

## Standard Stack

### Core (already installed from Phase 1)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | 1.40.x | Telegram Bot framework | Already in use; provides editMessageText, pinChatMessage, editForumTopic APIs |
| fastify | 5.7.x | HTTP server for hook POSTs | Already in use; add new Notification route |
| @grammyjs/auto-retry | latest | Auto-retry on 429 flood wait | Already configured |
| @grammyjs/transformer-throttler | latest | API request throttling | Already configured |

### Supporting (no new dependencies needed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs (watch, read) | Node 20+ built-in | Watching JSONL transcript file | fs.watch for change notifications, fs.read with file position tracking for incremental reads |
| node:readline | Node 20+ built-in | Line-by-line JSONL parsing | createInterface with readable stream for parsing new lines |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fs.watch + manual tail | chokidar | Adds a dependency for marginally better cross-platform support; fs.watch is sufficient for single-file watching on Linux |
| Manual JSONL line splitting | tail (npm) | Adds dependency; simple readline/split approach is sufficient for append-only files |
| Node built-in timers | cron/node-schedule | Overkill for a simple 5-minute interval; setInterval is sufficient |

**Installation:**
```bash
# No new dependencies required -- Phase 2 uses only Node.js built-ins on top of Phase 1's stack
```

## Architecture Patterns

### Recommended Project Structure (additions to Phase 1)
```
src/
  bot/
    bot.ts              # Add /verbose, /normal, /quiet command handlers
    formatter.ts        # Add notification formatters, status message formatter
    rate-limiter.ts     # (unchanged)
    topics.ts           # Add pinMessage, editMessage, editTopicDescription methods
  hooks/
    handlers.ts         # Add Notification handler, extend PostToolUse with verbosity filter
    server.ts           # Add POST /hooks/notification route
  monitoring/           # NEW MODULE
    transcript-watcher.ts  # fs.watch + tail for JSONL transcript parsing
    status-message.ts      # Pinned status message lifecycle (create, update, destroy)
    summary-timer.ts       # Periodic 5-minute summary aggregator
    verbosity.ts           # Verbosity tier logic and tool-to-tier mapping
  sessions/
    session-store.ts    # Extend SessionInfo with verbosity, statusMessageId, context stats
  types/
    hooks.ts            # Add NotificationPayload type
    monitoring.ts       # NEW: VerbosityTier, StatusData, TranscriptEntry types
    sessions.ts         # Extend SessionInfo interface
  utils/
    install-hooks.ts    # Add Notification hook configuration
```

### Pattern 1: Verbosity Filter in PostToolUse Pipeline
**What:** A pure function that takes a tool name and verbosity tier, returns whether the message should be sent or suppressed. Suppressed calls increment a silent counter on the session.
**When to use:** Every PostToolUse event, before formatting and enqueuing.
**Example:**
```typescript
// Source: Project CONTEXT.md decisions
type VerbosityTier = 'minimal' | 'normal' | 'verbose';

const MINIMAL_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash']);
const NORMAL_EXCLUDE = new Set(['Read', 'Glob', 'Grep']);

function shouldPostToolCall(toolName: string, tier: VerbosityTier): boolean {
  switch (tier) {
    case 'verbose':
      return true;
    case 'minimal':
      return MINIMAL_TOOLS.has(toolName);
    case 'normal':
      return !NORMAL_EXCLUDE.has(toolName);
  }
}
```

### Pattern 2: JSONL Transcript Watcher (fs.watch + incremental read)
**What:** Watch the transcript file for changes, read only newly appended bytes from the last known position, split into lines, parse JSON, and emit assistant text messages.
**When to use:** Started when a session begins (after SessionStart), stopped on SessionEnd.
**Example:**
```typescript
// Source: Node.js fs.watch docs + JSONL format from community tools
import { watch, open, read, stat } from 'node:fs';
import type { FSWatcher } from 'node:fs';

class TranscriptWatcher {
  private watcher: FSWatcher | null = null;
  private filePosition = 0;
  private filePath: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onAssistantMessage: (text: string) => void;
  private onUsageUpdate: (usage: TokenUsage) => void;

  constructor(
    filePath: string,
    onAssistantMessage: (text: string) => void,
    onUsageUpdate: (usage: TokenUsage) => void,
  ) {
    this.filePath = filePath;
    this.onAssistantMessage = onAssistantMessage;
    this.onUsageUpdate = onUsageUpdate;
  }

  start(): void {
    // Get initial file size to skip existing content
    try {
      const stats = statSync(this.filePath);
      this.filePosition = stats.size;
    } catch {
      this.filePosition = 0;
    }

    this.watcher = watch(this.filePath, () => {
      // Debounce rapid change events (fs.watch fires multiple times)
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.readNewLines(), 100);
    });
  }

  private readNewLines(): void {
    // Read from last position to end of file
    // Split on newlines, parse each as JSON
    // Filter for type === 'assistant' with text content
    // Extract usage data for context tracking
  }

  stop(): void {
    this.watcher?.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
```

### Pattern 3: Pinned Status Message with Debounced Updates
**What:** On session start, send an initial status message and pin it. On every PostToolUse event, update it in place via editMessageText. Debounce updates to avoid excessive API calls.
**When to use:** One per session/topic.
**Example:**
```typescript
// Source: Telegram Bot API docs + grammY API reference
class StatusMessage {
  private messageId: number = 0;
  private threadId: number;
  private chatId: number;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingData: StatusData | null = null;
  private minUpdateIntervalMs = 3000; // Minimum 3 seconds between edits
  private lastUpdateTime = 0;

  async initialize(bot: Bot): Promise<void> {
    // Send initial status message
    const msg = await bot.api.sendMessage(this.chatId, formatStatus(initialData), {
      message_thread_id: this.threadId,
    });
    this.messageId = msg.message_id;
    // Pin the message (silently)
    await bot.api.pinChatMessage(this.chatId, this.messageId, {
      disable_notification: true,
    });
  }

  requestUpdate(data: StatusData): void {
    this.pendingData = data;
    const elapsed = Date.now() - this.lastUpdateTime;
    if (elapsed >= this.minUpdateIntervalMs) {
      void this.flush();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(
        () => void this.flush(),
        this.minUpdateIntervalMs - elapsed,
      );
    }
  }

  private async flush(): Promise<void> {
    if (!this.pendingData || !this.messageId) return;
    const data = this.pendingData;
    this.pendingData = null;
    this.lastUpdateTime = Date.now();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    await bot.api.editMessageText(this.chatId, this.messageId, formatStatus(data), {
      message_thread_id: this.threadId, // Not needed for editMessageText (uses message_id)
    });
  }
}
```

### Pattern 4: Notification Hook Handler
**What:** A new Fastify route and handler for the Notification hook event. Formats permission prompts, idle alerts, and other notifications with urgency-based styling.
**When to use:** Registered alongside existing hook routes on startup.
**Example:**
```typescript
// Source: Claude Code hooks reference (code.claude.com/docs/en/hooks)
interface NotificationPayload extends HookPayload {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog';
  message: string;
  title?: string;
}

// Fastify route
fastify.post<{ Body: NotificationPayload }>(
  '/hooks/notification',
  async (request) => {
    handlers.handleNotification(request.body as NotificationPayload)
      .catch((err) => request.log.error(err, 'Error handling notification hook'));
    return {};
  },
);
```

### Anti-Patterns to Avoid
- **Polling the transcript file on a timer:** Do not use setInterval to check file changes. Use fs.watch for event-driven notification, then read new bytes. Polling wastes CPU and has higher latency.
- **Reading the entire transcript file on every change:** The transcript file grows continuously (can reach megabytes). Always track the byte position and only read from the last known offset.
- **Updating the pinned message on every single event:** editMessageText has rate limits. Debounce to at most once every 3 seconds. Rapid edits will trigger 429 errors or message deduplication (Telegram silently ignores edits that produce identical content).
- **Parsing tool_use content blocks as text output:** JSONL assistant messages contain both text blocks and tool_use blocks in the content array. Only extract `type: "text"` blocks. Tool use is already captured by PostToolUse hooks.
- **Blocking the hook response for transcript parsing:** Transcript parsing is CPU-bound (JSON.parse on each line). Never do it in the Fastify request handler. All transcript processing happens asynchronously in the watcher.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File change detection | Custom inode/stat polling loop | `fs.watch()` (Node.js built-in) | OS-level notification is more efficient and lower latency than polling; handles inode changes |
| Rate limiting editMessageText | Custom token bucket for edit calls | Debounce timer (3-second minimum interval) + grammY auto-retry | editMessageText deduplicates identical content; debounce + auto-retry handles the rest |
| JSONL line splitting | Manual buffer accumulation and newline scanning | Read new bytes, split on `\n`, filter empty lines | JSONL is append-only, one JSON object per line -- simple string split is sufficient |
| Context window percentage | Custom calculation from raw tokens | Parse `message.usage` fields using the official formula: `(input_tokens + cache_creation_input_tokens + cache_read_input_tokens) / context_window_size * 100` | Formula verified from official Claude Code status line docs |

**Key insight:** The JSONL transcript format is append-only and line-delimited, making "tailing" trivial compared to general file watching. Track byte offset, read new bytes, split on newlines, JSON.parse each line. No streaming parser or complex state machine needed.

## Common Pitfalls

### Pitfall 1: fs.watch Fires Multiple Events per Write
**What goes wrong:** A single append to the JSONL file triggers 2-3 `change` events from fs.watch, causing duplicate processing.
**Why it happens:** OS-level file notification APIs (inotify on Linux, FSEvents on macOS) often fire multiple events for a single write operation.
**How to avoid:** Debounce fs.watch callbacks with a 100ms timer. On each `change` event, reset the timer. Only process when 100ms of silence occurs after the last event.
**Warning signs:** Duplicate assistant messages appearing in Telegram, or the same transcript line processed twice.

### Pitfall 2: editMessageText "Message is not modified" Error
**What goes wrong:** Telegram returns error 400 "Bad Request: message is not modified" when calling editMessageText with identical content.
**Why it happens:** If the status data hasn't actually changed between updates (e.g., two rapid tool calls with same context %), the formatted text is identical.
**How to avoid:** Before calling editMessageText, compare the new formatted text with the last sent text. Skip the API call if they match. Alternatively, catch the 400 error and ignore it (grammY auto-retry won't retry 400s).
**Warning signs:** Console errors showing "message is not modified" on status updates.

### Pitfall 3: Transcript File Doesn't Exist Yet When Watcher Starts
**What goes wrong:** fs.watch throws ENOENT if the transcript file doesn't exist when the session starts.
**Why it happens:** The transcript_path is provided in the SessionStart payload, but the file may not be created until Claude Code makes its first API call.
**How to avoid:** Retry fs.watch setup with a short delay (500ms) if the file doesn't exist. Use a maximum retry count (e.g., 10 retries = 5 seconds). The file should appear quickly after session start.
**Warning signs:** "ENOENT" errors in logs during session startup.

### Pitfall 4: JSONL Lines Split Across Read Boundaries
**What goes wrong:** A read from the file offset returns a partial JSON line (the write was mid-line when we read).
**Why it happens:** We read new bytes as soon as fs.watch fires, but the write may not be complete -- especially for long assistant messages with large content arrays.
**How to avoid:** Buffer incomplete lines. After splitting on `\n`, if the last segment doesn't end with `\n`, save it as a partial buffer for the next read. Only parse complete lines.
**Warning signs:** JSON.parse errors on partial lines, or corrupted data.

### Pitfall 5: pinChatMessage Requires Admin Rights
**What goes wrong:** `pinChatMessage` fails with "not enough rights to pin a message" error.
**Why it happens:** The bot needs the `can_pin_messages` admin right, which may not have been granted when the bot was added to the group.
**How to avoid:** Wrap pinChatMessage in a try/catch. If it fails, log a warning and continue without pinning. The status message still works even if unpinned -- it's just less discoverable.
**Warning signs:** Error logs on first session start in a new group.

### Pitfall 6: editMessageText Rate Limiting is Separate from sendMessage
**What goes wrong:** Even with the grammY throttler handling sendMessage limits, editMessageText calls can still be rate-limited.
**Why it happens:** Telegram applies separate (undocumented) rate limits for message editing. The grammY throttler's defaults are tuned for sendMessage, not editMessageText.
**How to avoid:** Implement a separate debounce for status message updates (minimum 3 seconds between edits). The auto-retry plugin handles any 429s that slip through.
**Warning signs:** 429 "Too Many Requests" errors specifically on editMessageText calls.

### Pitfall 7: Idle Detection False Positives During Long Tool Calls
**What goes wrong:** Idle alert fires while Claude Code is running a long Bash command (e.g., `npm install` taking 30+ seconds).
**Why it happens:** The idle timer fires based on time since last PostToolUse event, but a single tool call can legitimately take minutes.
**How to avoid:** Use the Notification hook's `idle_prompt` event type instead of building custom idle detection. Claude Code itself determines when idle is appropriate and fires the Notification hook. Our bot just forwards it.
**Warning signs:** "Claude appears idle" messages appearing while Claude is actively running a command.

## Code Examples

Verified patterns from official sources:

### JSONL Transcript Entry Structure (Assistant Message)
```typescript
// Source: Community tools analysis + official status line docs
// Each line in the JSONL file is one of these objects:

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'summary';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;        // ISO 8601
  sessionId: string;
  version: string;
  cwd: string;
  isSidechain: boolean;     // true for subagent messages
  message: {
    id?: string;            // present on assistant messages (msg_...)
    role: 'user' | 'assistant';
    model?: string;         // e.g., "claude-sonnet-4-6"
    content: string | ContentBlock[];
    usage?: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      output_tokens: number;
      service_tier?: string;
    };
  };
}

// Content blocks in assistant messages:
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[] };
```

### Context Window Percentage Calculation
```typescript
// Source: code.claude.com/docs/en/statusline (official formula)
const DEFAULT_CONTEXT_WINDOW = 200_000;

function calculateContextPercentage(usage: TranscriptEntry['message']['usage']): number {
  if (!usage) return 0;
  const totalInputTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  return Math.round((totalInputTokens / DEFAULT_CONTEXT_WINDOW) * 100);
}
```

### Extracting Assistant Text from Transcript Entry
```typescript
// Source: JSONL format analysis
function extractAssistantText(entry: TranscriptEntry): string | null {
  // Only process main-chain assistant messages
  if (entry.type !== 'assistant') return null;
  if (entry.message.role !== 'assistant') return null;
  if (entry.isSidechain) return null; // Skip subagent messages

  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  // Extract only text blocks, skip tool_use and tool_result
  const textParts = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text);

  return textParts.length > 0 ? textParts.join('\n') : null;
}
```

### Notification Hook Payload and Formatting
```typescript
// Source: code.claude.com/docs/en/hooks - Notification event
interface NotificationPayload extends HookPayload {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog';
  message: string;
  title?: string;
}

function formatNotification(payload: NotificationPayload): string {
  const { notification_type, message, title } = payload;

  switch (notification_type) {
    case 'permission_prompt':
      // Warning urgency: bold header, warning emoji, visually distinct
      return [
        `\u26A0\uFE0F <b>Permission Required</b>`,
        title ? `<b>${escapeHtml(title)}</b>` : '',
        `<blockquote>${escapeHtml(message)}</blockquote>`,
      ].filter(Boolean).join('\n');

    case 'idle_prompt':
      // Info urgency: softer styling
      return `\u{1F4A4} <b>Claude is idle</b>\n${escapeHtml(message)}`;

    case 'auth_success':
      return `\u2705 <b>Authentication successful</b>`;

    case 'elicitation_dialog':
      // Warning: Claude is asking for user input
      return `\u2753 <b>Input Needed</b>\n${escapeHtml(message)}`;

    default:
      return `\u{1F514} <b>Notification</b>\n${escapeHtml(message)}`;
  }
}
```

### Pinning a Status Message in a Topic
```typescript
// Source: grammy.dev/ref/core/api + Telegram Bot API
async function createPinnedStatus(
  bot: Bot,
  chatId: number,
  threadId: number,
  initialHtml: string,
): Promise<number> {
  // Send the initial status message to the topic
  const msg = await bot.api.sendMessage(chatId, initialHtml, {
    message_thread_id: threadId,
  });
  // Pin it silently (no notification to group members)
  try {
    await bot.api.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    });
  } catch (err) {
    // Non-fatal: bot may lack pin rights
    console.warn('Failed to pin status message:', err instanceof Error ? err.message : err);
  }
  return msg.message_id;
}

// Update the pinned message in place
async function updatePinnedStatus(
  bot: Bot,
  chatId: number,
  messageId: number,
  html: string,
): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, html);
  } catch (err) {
    // Ignore "message is not modified" errors
    if (err instanceof Error && err.message.includes('message is not modified')) {
      return;
    }
    throw err;
  }
}
```

### Verbosity Bot Commands
```typescript
// Source: grammy.dev/guide/basics + project CONTEXT.md decisions
// Register in bot.ts alongside existing /status command

bot.command('verbose', async (ctx) => {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;
  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;
  sessionStore.updateVerbosity(session.sessionId, 'verbose');
  await ctx.reply('Verbosity set to <b>verbose</b> -- showing all tool calls');
});

bot.command('normal', async (ctx) => {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;
  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;
  sessionStore.updateVerbosity(session.sessionId, 'normal');
  await ctx.reply('Verbosity set to <b>normal</b> -- hiding Read/Glob/Grep calls');
});

bot.command('quiet', async (ctx) => {
  const threadId = ctx.message?.message_thread_id;
  if (!threadId) return;
  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;
  sessionStore.updateVerbosity(session.sessionId, 'minimal');
  await ctx.reply('Verbosity set to <b>quiet</b> -- showing edits and bash only');
});
```

### Hook Configuration for Notification Events
```typescript
// Source: code.claude.com/docs/en/hooks + existing install-hooks.ts
// Add to the hookConfig object in installHooks():
const hookConfig = {
  // ... existing SessionStart, SessionEnd, PostToolUse ...
  Notification: [
    {
      matcher: '',
      hooks: [
        { type: 'http', url: `${baseUrl}/hooks/notification`, timeout: 10 },
      ],
    },
  ],
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No Notification hook | Notification hook with HTTP support | Claude Code 2.x (2025-2026) | Direct forwarding of permission prompts and idle alerts without custom detection |
| Custom idle detection (timer-based) | Built-in `idle_prompt` notification type | Claude Code 2.x (late 2025) | No need to implement custom idle detection -- Claude Code fires the event |
| Polling transcript file | fs.watch + incremental read | Node.js 20+ (stable) | Event-driven, low latency, no CPU waste from polling |
| No context window tracking | `message.usage` in JSONL + official context formula | Status line feature (2025-2026) | Official formula for calculating context percentage from token counts |
| chokidar for file watching | fs.watch (Node.js built-in) | Node.js 19.1+ (inotify improvements) | fs.watch is now reliable enough on Linux for single-file watching; chokidar is overkill |

**Deprecated/outdated:**
- chokidar v4: Major rewrite removed many features; v5 (ESM-only, Nov 2025) is current but unnecessary for our single-file watch use case
- `fs.watchFile` (stat-based polling): Use `fs.watch` instead for event-based notification

## Open Questions

1. **JSONL transcript file rotation/compaction behavior**
   - What we know: Claude Code has a PreCompact hook that fires before context compaction. The transcript file path is provided in SessionStart and remains constant.
   - What's unclear: Whether compaction truncates/rewrites the transcript file, or appends a summary entry and continues appending. If the file is rewritten, our byte offset becomes invalid.
   - Recommendation: Detect file truncation by comparing current file size to our byte offset. If size < offset, reset offset to 0 and re-read. This handles any rotation/rewrite scenario safely.

2. **Exact token count for context window size per model**
   - What we know: Default context window is 200,000 tokens. Extended context models support 1,000,000 tokens. The model name is in SessionStart payload and in JSONL entries.
   - What's unclear: Whether there's a reliable mapping from model ID to exact context window size that we can use without hardcoding.
   - Recommendation: Start with 200,000 as default. Parse the model ID from SessionStart. Maintain a small lookup table for known models (claude-opus-4-6: 200k, claude-sonnet-4-6: 200k, etc.). If usage exceeds 100%, the model likely has extended context -- adjust dynamically.

3. **editMessageText behavior when topic is scrolled**
   - What we know: editMessageText updates message content in place. Pinned messages are accessible via the pin icon regardless of scroll position.
   - What's unclear: Whether editing a pinned message triggers a visible notification or update indicator for the user in Telegram mobile.
   - Recommendation: Pin the status message on creation. Edit it in place. Users tap the pin icon to see current status. This is the best UX available in Telegram forums.

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) - Full Notification event schema, hook_event_name values, notification_type matchers (permission_prompt, idle_prompt, auth_success, elicitation_dialog), HTTP hook configuration
- [Claude Code Status Line Docs](https://code.claude.com/docs/en/statusline) - Official context_window JSON schema with used_percentage, context_window_size, current_usage fields, token count formula
- [Telegram Bot API](https://core.telegram.org/bots/api) - editMessageText, pinChatMessage, editForumTopic methods; topic name limit 128 chars; message_thread_id support
- [grammY API Reference](https://grammy.dev/ref/core/api) - bot.api.editMessageText, bot.api.pinChatMessage signatures
- [Node.js fs.watch docs](https://nodejs.org/docs/latest-v20.x/api/fs.html#fswatchfilename-options-listener) - File watcher API for change detection

### Secondary (MEDIUM confidence)
- [Analyzing Claude Code Logs with DuckDB](https://liambx.com/blog/claude-code-log-analysis-with-duckdb) - JSONL field names: type, uuid, parentUuid, isSidechain, message.role, message.content, message.usage, timestamp, sessionId, version, cwd
- [Calculate Claude Code Context Usage](https://codelynx.dev/posts/calculate-claude-code-context) - Context formula verification: input_tokens + cache_creation_input_tokens + cache_read_input_tokens; 200k default window; sidechain filtering
- [claude-code-log (GitHub)](https://github.com/daaain/claude-code-log) - JSONL message type categorization: user, assistant, summary, system; content block structure with text, tool_use, tool_result types
- [claude-JSONL-browser (GitHub)](https://github.com/withLinda/claude-JSONL-browser) - JSONL processing patterns and session metadata fields

### Tertiary (LOW confidence)
- Exact behavior of fs.watch on JSONL file during Claude Code compaction: Not verified. Recommendation to detect file truncation is defensive programming, not confirmed behavior.
- Whether editForumTopic supports a description parameter (separate from name): Not found in current API docs. Only name (128 chars max) and icon_custom_emoji_id are documented. Use name field with compact status.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; uses Phase 1 stack + Node.js built-ins
- Architecture: HIGH - JSONL format verified from multiple sources; Notification hook schema from official docs; Telegram APIs confirmed via official docs
- Pitfalls: HIGH - fs.watch multi-fire is well-documented; editMessageText "not modified" error is a known Telegram behavior; partial line buffering is standard file-tailing practice
- JSONL format: MEDIUM - Community-documented, not official stable API. Format could change between Claude Code versions. Defensive parsing required.

**Research date:** 2026-02-28
**Valid until:** 2026-03-14 (14 days - JSONL format is community-documented and could change; hooks API is official and stable)
