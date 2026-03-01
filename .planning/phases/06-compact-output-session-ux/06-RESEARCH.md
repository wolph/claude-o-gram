# Phase 6: Compact Output & Session UX - Research

**Researched:** 2026-03-01
**Domain:** Telegram Bot message formatting, inline keyboard expand/collapse, LRU caching, session lifecycle (/clear)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Tool call formatting
- Single-line format: `Tool(args...)` for all tool types
- Smart path truncation: full relative path for short paths, `src/.../deeply/nested/file.ts` for long ones
- Edit/Write tools include line count stats: `Edit(src/bot/bot.ts) +3 -2`
- Bash shows command + exit status: `Bash(npm test) ✓` or `Bash(npm test) ✗`
- Batched tools (parallel calls within 2s window): each tool gets its own line in the message, not collapsed
- Max 250 chars per tool call line; truncate args with `...` if exceeded
- Grep shows pattern and path: `Grep("pattern", src/**/*.ts)`
- Write shows line count: `Write(src/new-file.ts) 45 lines`
- Agent tool shows name and description: `Agent(researcher) spawned -- "Explore API patterns"`

#### Expand/collapse behavior
- One Expand button per batched message -- tapping expands ALL tool calls in that message
- Expanded view shows each tool's full content with clear headers/separators between them
- Read tool does NOT need expansion -- the path is the whole story
- Edit/Write expansion shows full diff or file content
- Bash expansion shows full command output, up to 4096 chars (Telegram limit); beyond that, send as file attachment
- Button labels: `> Expand` and `< Collapse` (short text labels)
- Content stored in LRU cache keyed by chatId:messageId

#### Status message style
- Compact, no emoji: `claude-o-gram | 45% ctx | 1h 30m` + `42 tools | 8 files`
- Topic name: keep current style (emoji + project name + context %)
- No action buttons on status message -- pure info display
- Update frequency: keep current 3s debounce
- Smart skip: don't call API if content hasn't changed

#### /clear transition behavior
- Detect `source === 'clear'` on SessionStart; detect `reason === 'clear'` on SessionEnd
- SessionEnd with reason=clear: keep topic open (skip close/archive)
- SessionStart with source=clear: reuse existing threadId (no new topic)
- Post timestamped separator: `--- context cleared at 14:30 ---`
- Old messages remain visible above separator (no deletion)
- Topic name stays the same -- no rename on /clear
- Create new StatusMessage instance, post + pin it
- Old status message: unpin but leave in chat (historical record)
- Reset session counters: tools, files, duration

### Claude's Discretion
- Exact LRU cache size limit and eviction policy
- How to handle edge case where expand content exceeds 4096 chars after expansion
- Exact formatting of Edit diffs in expanded view (unified diff vs side-by-side)
- How to handle /clear when there are pending approval requests

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OUT-01 | Tool calls displayed as `Tool(args...)` single-line, max 250 chars | Compact formatter pattern (Architecture Pattern 1), per-tool formatting functions |
| OUT-02 | Tool calls exceeding 250 chars truncated with expand button | InlineKeyboard with callback_data pattern (Architecture Pattern 2), truncation logic |
| OUT-03 | Expand button edits message in-place showing full content with collapse button | `editMessageText` with `reply_markup` (Code Examples section), callback query handler |
| OUT-04 | Expand content stored in LRU cache (evicted after session end or size limit) | LRU cache module (Standard Stack), keying by `chatId:messageId` |
| OUT-05 | Bot commentary removed (no "waiting for input", no emoji status labels) | Formatter rewrite removes emoji prefixes, transcript watcher strips procedural narration |
| OUT-06 | Claude's text output posted directly without extra formatting | Remove `<b>Claude:</b>` prefix in transcript watcher callback |
| OUT-07 | Pinned status message uses compact format (no emoji) | New `formatStatusCompact()` function replacing emoji-laden `formatStatus()` |
| SESS-01 | /clear reuses existing topic instead of creating new one | SessionStart handler `source === 'clear'` code path (Architecture Pattern 3) |
| SESS-02 | Visual separator posted on /clear | Timestamped separator message in clear handler |
| SESS-03 | New pinned status message posted after /clear | StatusMessage re-initialization in clear flow |
| SESS-04 | Old status message unpinned on /clear | `unpinChatMessage(chatId, messageId)` API call |
| SESS-05 | Session counters reset on /clear | SessionStore.resetCounters() method |
| SESS-06 | SessionEnd with reason=clear keeps topic open | HookCallbacks.onSessionEnd receives reason, branches on `reason === 'clear'` |
</phase_requirements>

## Summary

This phase transforms the Telegram output from verbose, emoji-laden bot messages into clean terminal-fidelity display. The work spans three interconnected domains: (1) rewriting the formatter to produce compact `Tool(args...)` one-liners, (2) adding inline keyboard expand/collapse with LRU-cached content, and (3) implementing `/clear` topic reuse with session counter reset.

The existing codebase has strong foundations. The `MessageBatcher` already batches tool calls within a 2-second window. The `TopicManager` has `sendMessageRaw` (returns message_id), `editMessage`, `pinMessage`, and `unpinChatMessage` support via grammY. InlineKeyboard is already imported and used for approval buttons. The main changes are: (a) replacing the verbose `formatToolUse` output with compact one-liners, (b) making the batcher return message IDs so expand buttons can reference them, (c) adding a callback query handler for expand/collapse, (d) adding a new code path in `handleSessionEnd` and `handleSessionStart` for the `/clear` lifecycle, and (e) rewriting the status message format to be compact and emoji-free.

The critical architectural challenge is the batcher. Currently, `MessageBatcher.enqueue()` calls `sendFn` which returns void. For expand/collapse to work, the batcher must return the Telegram message_id of the sent message so the expand content can be stored in the LRU cache keyed by `chatId:messageId`. The batcher's `flush()` combines multiple tool calls into one Telegram message; the expand button applies to the entire combined message.

**Primary recommendation:** Rewrite the formatter for compact output first (pure logic, no API changes), then add the expand/collapse infrastructure (batcher changes + LRU cache + callback handler), then implement /clear lifecycle, then clean up status message format.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | ^1.40.1 | Telegram bot framework, InlineKeyboard, editMessageText, callback queries | Already in project; provides typed API for inline keyboards and message editing |
| lru-cache | ^10.x | LRU cache for expand content | Standard Node.js LRU implementation; written in TypeScript; zero dependencies; 70M+ weekly downloads |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @grammyjs/auto-retry | ^2.0.2 | 429 retry handling | Already installed; critical for expand/collapse which adds editMessageText calls |
| @grammyjs/transformer-throttler | ^1.2.1 | API request throttling | Already installed; protects against burst edits |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| lru-cache npm | Hand-rolled Map with size tracking | lru-cache handles eviction, TTL, size calculation correctly; hand-rolling risks memory leaks |
| lru-cache npm | Simple Map (no eviction) | Would grow unbounded; sessions can run for hours with hundreds of tool calls |

**Installation:**
```bash
npm install lru-cache
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── bot/
│   ├── formatter.ts         # REWRITE: compact Tool(args...) one-liners
│   ├── expand-cache.ts      # NEW: LRU cache + expand content builder
│   ├── bot.ts               # MODIFY: add expand/collapse callback handler
│   ├── topics.ts            # MODIFY: add unpinMessage, sendMessageWithKeyboard
│   └── rate-limiter.ts      # MODIFY: batcher returns message IDs for expand tracking
├── hooks/
│   └── handlers.ts          # MODIFY: pass reason to onSessionEnd, handle source=clear
├── monitoring/
│   └── status-message.ts    # REWRITE: formatStatus() to compact no-emoji format
├── sessions/
│   └── session-store.ts     # MODIFY: add resetCounters(), clearTransition tracking
├── types/
│   ├── hooks.ts             # No change needed (already has source/reason types)
│   └── sessions.ts          # MODIFY: add clearTransition flag
└── index.ts                 # MODIFY: wire expand handler, /clear lifecycle
```

### Pattern 1: Compact Tool Formatter
**What:** Replace verbose multi-line tool formatting with single-line `Tool(args...)` format
**When to use:** Every PostToolUse event

The formatter returns two things: (a) a compact one-liner string for the Telegram message, and (b) optionally, the full expanded content for the LRU cache.

```typescript
// New formatter return type
interface CompactToolResult {
  /** Single-line compact display, max 250 chars */
  compact: string;
  /** Full expanded content (if tool warrants expansion). null for Read/Glob. */
  expandContent: string | null;
}

// Example outputs:
// Read(src/bot/bot.ts)                          -- no expand content
// Edit(src/bot/bot.ts) +3 -2                    -- expand: unified diff
// Bash(npm test) ✓                              -- expand: full stdout
// Write(src/new-file.ts) 45 lines               -- expand: file content
// Grep("pattern", src/**/*.ts)                  -- no expand content (path is the story)
// Agent(researcher) spawned -- "Explore API..."  -- no expand content

function formatToolCompact(payload: PostToolUsePayload): CompactToolResult {
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};

  switch (toolName) {
    case 'Read':
      return { compact: `Read(${smartPath(input.file_path)})`, expandContent: null };
    case 'Edit': {
      const path = smartPath(input.file_path);
      const stats = diffStats(input.old_string, input.new_string);
      const line = `Edit(${path}) ${stats}`;
      return {
        compact: truncateLine(line, 250),
        expandContent: buildUnifiedDiff(input),
      };
    }
    case 'Bash': {
      const cmd = smartPath(input.command);
      const exit = extractExitStatus(response);
      const statusChar = exit === 0 ? '\u2713' : '\u2717';
      const line = `Bash(${cmd}) ${statusChar}`;
      return {
        compact: truncateLine(line, 250),
        expandContent: extractBashOutput(response) || null,
      };
    }
    // ... similar for Write, Grep, Glob, MultiEdit, Agent, default
  }
}
```

**Path truncation logic:**
```typescript
function smartPath(fullPath: string | unknown): string {
  if (typeof fullPath !== 'string') return 'unknown';
  // Replace HOME with ~
  let p = fullPath.replace(process.env.HOME + '/', '~/');
  // If short enough, return as-is
  if (p.length <= 60) return p;
  // Smart truncation: keep first segment and last 2 segments
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return `${parts[0]}/${parts[1]}/.../${parts.slice(-2).join('/')}`;
}
```

### Pattern 2: Expand/Collapse with Inline Keyboard
**What:** Attach an Expand button to batched tool messages; on tap, edit message in-place to show full content
**When to use:** Any batched message that contains at least one tool call with expandContent

**Critical constraint:** Telegram `callback_data` is limited to **64 bytes**. The callback_data must encode enough information to look up the expanded content.

**Design:**
```typescript
// callback_data format: "exp:{messageId}" or "col:{messageId}"
// messageId is a number (up to ~10 digits), prefix is 4 chars = ~14 bytes total. Well within 64.

// Expand button added when sending a batched tool message with expandable content:
const keyboard = new InlineKeyboard().text('▸ Expand', `exp:${messageId}`);

// In bot.ts callback handler:
bot.callbackQuery(/^exp:(\d+)$/, async (ctx) => {
  const messageId = parseInt(ctx.match[1]);
  const cacheKey = `${config.telegramChatId}:${messageId}`;
  const expandedContent = expandCache.get(cacheKey);
  if (!expandedContent) {
    await ctx.answerCallbackQuery({ text: 'Content no longer available', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery(); // dismiss spinner
  const collapseKeyboard = new InlineKeyboard().text('◂ Collapse', `col:${messageId}`);
  await ctx.editMessageText(expandedContent, {
    parse_mode: 'HTML',
    reply_markup: collapseKeyboard,
  });
});

bot.callbackQuery(/^col:(\d+)$/, async (ctx) => {
  const messageId = parseInt(ctx.match[1]);
  const cacheKey = `${config.telegramChatId}:${messageId}`;
  const entry = expandCache.getCompact(cacheKey);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: 'Content no longer available', show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const expandKeyboard = new InlineKeyboard().text('▸ Expand', `exp:${messageId}`);
  await ctx.editMessageText(entry, {
    parse_mode: 'HTML',
    reply_markup: expandKeyboard,
  });
});
```

**LRU cache storage:** Store both compact and expanded versions so collapse can restore the original.

```typescript
// expand-cache.ts
import { LRUCache } from 'lru-cache';

interface CacheEntry {
  compact: string;    // Original compact message (for collapse)
  expanded: string;   // Full expanded content (for expand)
}

const cache = new LRUCache<string, CacheEntry>({
  max: 500,  // 500 messages worth of expand content
  ttl: 1000 * 60 * 60 * 4,  // 4 hours TTL (typical session lifetime)
});
```

### Pattern 3: /clear Lifecycle Flow
**What:** When Claude Code runs `/clear`, a SessionEnd(reason=clear) fires followed by SessionStart(source=clear). The topic stays open, gets a separator, new pinned status, and reset counters.
**When to use:** Detect `reason === 'clear'` in SessionEnd and `source === 'clear'` in SessionStart

**The flow (two hook events):**

1. **SessionEnd with reason=clear arrives:**
   - Do NOT close/archive the topic (skip `closeTopic()`)
   - Do NOT post session end summary
   - Stop monitoring (transcript watcher, summary timer)
   - Mark session as closed in store (it will be re-created by SessionStart)
   - Keep the topic open and the threadId available

2. **SessionStart with source=clear arrives:**
   - Look up existing topic by cwd (like resume flow)
   - Reuse existing threadId (no new topic creation)
   - Post timestamped separator: `--- context cleared at 14:30 ---`
   - Unpin old status message: `unpinChatMessage(chatId, oldStatusMessageId)`
   - Create new StatusMessage instance, post + pin new status
   - Reset session counters (tools=0, files=empty, startedAt=now)
   - Re-initialize monitoring (transcript watcher, summary timer)
   - Clear expand cache entries for this session (optional cleanup)

**Key code changes needed:**

```typescript
// handlers.ts - handleSessionEnd must pass reason to callback
async handleSessionEnd(payload: SessionEndPayload): Promise<void> {
  const session = this.sessionStore.get(payload.session_id);
  if (!session) return;
  this.sessionStore.updateStatus(payload.session_id, 'closed');
  await this.callbacks.onSessionEnd(session, payload.reason);  // ADD reason parameter
}

// HookCallbacks interface change:
onSessionEnd(session: SessionInfo, reason: string): Promise<void>;

// index.ts - onSessionEnd branches on reason
onSessionEnd: async (session, reason) => {
  if (reason === 'clear') {
    // Skip topic close, just clean up monitoring
    // Keep threadId mapping for the upcoming SessionStart(source=clear)
    return;
  }
  // Existing close flow...
}

// index.ts - handleSessionStart branches on source
// In handleSessionStart, add source=clear path similar to source=resume
if (payload.source === 'clear') {
  const existing = this.sessionStore.getActiveByCwd(payload.cwd);
  // Actually, session was marked 'closed' -- need getClosedByCwd or getRecentByCwd
  // Solution: store lastThreadId on closed sessions, or use a separate mapping
}
```

**Important subtlety:** Between SessionEnd(reason=clear) and SessionStart(source=clear), the session is marked 'closed'. The SessionStart handler needs to find the **recently closed** session for the same cwd to reuse its threadId. Options:
- Add `getRecentlyClosedByCwd(cwd)` to SessionStore
- Store a `clearPending` flag before marking closed
- Keep a Map<cwd, threadId> for clear transitions

**Recommended approach:** Add a `clearPending: Map<string, { threadId: number, statusMessageId: number }>` in the wiring layer (index.ts). When SessionEnd(reason=clear) arrives, store the threadId and statusMessageId in this map keyed by cwd. When SessionStart(source=clear) arrives, look it up and consume it.

### Anti-Patterns to Avoid

- **Storing expand content in callback_data:** Telegram limits callback_data to 64 bytes. Store content server-side in LRU cache, use message ID as key.
- **Editing messages without checking length:** Expanded content can exceed 4096 chars. Must truncate or send as file.
- **Assuming SessionEnd and SessionStart arrive atomically:** There may be a small delay between the two hooks during /clear. The `clearPending` map handles this race.
- **Resetting the batcher queue on /clear:** The batcher may have pending messages from before /clear. Flush first, then reset.
- **Forgetting to unpin before pinning:** Telegram allows multiple pins but they clutter the pin list. Explicitly unpin the old status message.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LRU eviction | Custom Map with manual size tracking | `lru-cache` npm package | Handles TTL, max size, eviction callbacks; 10+ years battle-tested |
| Message batching | N/A | Existing `MessageBatcher` class | Already built and working; just needs modification to return message IDs |
| Rate limiting | N/A | Existing grammY auto-retry + throttler | Already handles 429s and Bottleneck queuing |
| Inline keyboard | N/A | grammY `InlineKeyboard` class | Already used for approval buttons; same pattern extends to expand/collapse |

**Key insight:** This phase is primarily a rewrite of formatting logic and addition of new lifecycle paths. The infrastructure (batcher, topics, keyboards, status message) already exists and just needs modification, not replacement.

## Common Pitfalls

### Pitfall 1: editMessageText "message is not modified" Error
**What goes wrong:** Calling editMessageText with identical content throws a Telegram API error
**Why it happens:** Expand/Collapse could be tapped multiple times; race conditions between debounced updates
**How to avoid:** Wrap all editMessageText calls in try/catch that ignores "message is not modified" errors (already done in TopicManager.editMessage). Use the same pattern for expand/collapse.
**Warning signs:** Unhandled promise rejection logs mentioning "message is not modified"

### Pitfall 2: callback_data Exceeds 64 Bytes
**What goes wrong:** Telegram returns BUTTON_DATA_INVALID error
**Why it happens:** Encoding too much info in callback_data (e.g., full cache key with session ID)
**How to avoid:** Use minimal callback_data: `exp:{messageId}` (max ~14 bytes). Look up the rest server-side.
**Warning signs:** 400 errors when sending messages with inline keyboards

### Pitfall 3: Expand Content Exceeds 4096 Chars
**What goes wrong:** editMessageText fails or silently truncates
**Why it happens:** Bash output, file content, or multi-tool expanded views can be very large
**How to avoid:** When building expanded content, check length. If > 4096, truncate to 3900 chars + "... (full output sent as file)" and attach file. Per user decision: Bash expansion caps at 4096 chars; beyond that, send as file attachment.
**Warning signs:** Expanded view shows incomplete content without explanation

### Pitfall 4: Race Between SessionEnd(clear) and SessionStart(clear)
**What goes wrong:** SessionStart(source=clear) arrives but can't find the topic to reuse
**Why it happens:** Session was marked 'closed' by handleSessionEnd, getActiveByCwd returns nothing
**How to avoid:** Use a `clearPending` map to bridge the gap between the two hook events
**Warning signs:** New topic created instead of reusing existing one on /clear

### Pitfall 5: Expand Cache Grows Unbounded
**What goes wrong:** Memory usage climbs steadily during long sessions
**Why it happens:** Every tool call with expand content adds to the cache; no eviction
**How to avoid:** Use LRU cache with `max: 500` entries and `ttl: 4 hours`. Clear cache entries on session end.
**Warning signs:** process.memoryUsage().heapUsed grows linearly over session lifetime

### Pitfall 6: Batcher Flush Loses Message IDs
**What goes wrong:** Expand buttons created but can't map back to the message for cache lookup
**Why it happens:** Current batcher's sendFn returns void; message_id is discarded
**How to avoid:** Change batcher to use `sendMessageRaw` (which returns message_id) and pass it back to callers for cache storage
**Warning signs:** Expand button shows "Content no longer available" immediately after sending

### Pitfall 7: HTML Entities in Compact Format
**What goes wrong:** Compact lines like `Edit(src/config.ts)` break HTML parsing if path contains `<` or `&`
**Why it happens:** File paths and bash commands can contain HTML-special characters
**How to avoid:** Always escape dynamic content with `escapeHtml()` before embedding in the compact line
**Warning signs:** Telegram returns "Can't parse entities" error

### Pitfall 8: Pending Approvals During /clear
**What goes wrong:** A PreToolUse approval is waiting when /clear fires; the session ends but the approval Promise never resolves
**Why it happens:** /clear triggers SessionEnd, which cleans up the approval manager, but the HTTP response for PreToolUse is still pending
**How to avoid:** On SessionEnd(reason=clear), auto-approve or auto-deny all pending approvals for the session before cleanup. The existing `approvalManager.cleanupSession()` should handle this, but verify it resolves pending Promises.
**Warning signs:** Claude Code hangs waiting for PreToolUse response after /clear

## Code Examples

Verified patterns from the existing codebase and grammY docs:

### Sending Message with Inline Keyboard (from existing approval code)
```typescript
// Source: src/bot/bot.ts lines 263-266, src/index.ts lines 338-343
const keyboard = new InlineKeyboard().text('▸ Expand', `exp:${messageId}`);
const msg = await bot.api.sendMessage(config.telegramChatId, htmlText, {
  message_thread_id: session.threadId,
  parse_mode: 'HTML',
  reply_markup: keyboard,
});
// msg.message_id is available for cache keying
```

### Editing Message Text with New Keyboard
```typescript
// Source: grammY docs - editMessageText supports reply_markup parameter
await bot.api.editMessageText(chatId, messageId, newHtml, {
  parse_mode: 'HTML',
  reply_markup: new InlineKeyboard().text('◂ Collapse', `col:${messageId}`),
});
```

### Handling Callback Queries (from existing approval code)
```typescript
// Source: src/bot/bot.ts lines 117-145
bot.callbackQuery(/^exp:(\d+)$/, async (ctx) => {
  const messageId = parseInt(ctx.match[1]);
  // Look up from cache...
  await ctx.answerCallbackQuery(); // MUST call to dismiss loading spinner
  await ctx.editMessageText(expandedHtml, {
    parse_mode: 'HTML',
    reply_markup: collapseKeyboard,
  });
});
```

### Unpinning a Message
```typescript
// Source: grammY API reference - unpinChatMessage
await bot.api.unpinChatMessage(chatId, oldStatusMessageId);
// Note: message_id is optional; if omitted, unpins all
```

### LRU Cache Setup
```typescript
// Source: lru-cache npm README
import { LRUCache } from 'lru-cache';

interface ExpandEntry {
  compact: string;
  expanded: string;
}

const expandCache = new LRUCache<string, ExpandEntry>({
  max: 500,           // Max 500 entries
  ttl: 4 * 60 * 60 * 1000, // 4 hour TTL
});

// Store: key = `${chatId}:${messageId}`
expandCache.set(`${chatId}:${msgId}`, { compact: compactHtml, expanded: fullHtml });

// Retrieve:
const entry = expandCache.get(`${chatId}:${msgId}`);

// Clean up on session end:
// No built-in "delete by prefix" -- iterate or track keys per session
```

### Compact Status Message Format
```typescript
// Current (emoji-heavy):
// 🟢 Status: Active
// 📊 Context: 45% used
// 🔧 Current: Bash
// ⏱️ Duration: 1h 30m
// 📝 Tools: 42 calls | 8 files changed

// New (compact, no emoji):
// claude-o-gram | 45% ctx | 1h 30m
// 42 tools | 8 files
function formatStatusCompact(data: StatusData): string {
  return [
    `claude-o-gram | ${data.contextPercent}% ctx | ${data.sessionDuration}`,
    `${data.toolCallCount} tools | ${data.filesChanged} files`,
  ].join('\n');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Verbose multi-line tool messages with emoji | Compact `Tool(args...)` one-liners | This phase | Dramatically reduces visual noise |
| File attachments for long tool output | Inline expand/collapse with LRU cache | This phase | Content stays in-message, no file downloads |
| New topic on /clear | Reuse topic with visual separator | This phase | Preserves conversation history continuity |
| Emoji-laden status message (5 lines) | Compact 2-line status | This phase | Less visual clutter in pinned message |
| `<b>Claude:</b>` prefix on all text output | Direct text output without prefix | This phase | Cleaner, terminal-like feel |

**Deprecated/outdated:**
- `formatToolUse()` return type `{ text: string; attachment?: {...} }`: Replaced by `CompactToolResult` with compact/expandContent
- `formatStatus()` with emoji prefixes: Replaced by `formatStatusCompact()`
- Separate `formatRead()`, `formatBash()`, etc. verbose functions: Replaced by compact single-line formatters

## Open Questions

1. **What happens to the expand cache when the batcher combines multiple tool messages?**
   - What we know: The batcher joins multiple tool call lines with `\n\n`. The expand button applies to the entire combined message.
   - What's unclear: The expanded view needs to show all tools' expanded content with separators. The cache entry must store an array of per-tool expanded content, not a single string.
   - Recommendation: Store `ExpandEntry` as `{ compact: string, tools: Array<{ name: string, expanded: string }> }`. Build the expanded view by concatenating tool expanded content with headers.

2. **How to handle /clear when there are pending approvals?**
   - What we know: `approvalManager.cleanupSession()` exists and is called on session end.
   - What's unclear: Does `cleanupSession()` resolve pending Promises, or does it just delete entries? If it deletes without resolving, the PreToolUse HTTP handler will hang forever.
   - Recommendation: Verify `cleanupSession()` calls `decide('deny')` on all pending approvals for the session. If not, add this behavior.

3. **Should the expand cache persist across bot restarts?**
   - What we know: The cache is in-memory only. Bot restarts clear it.
   - What's unclear: Should we persist to disk like session store?
   - Recommendation: No. Expand content is ephemeral UI state. After restart, old expand buttons showing "Content no longer available" is acceptable. The compact view remains visible.

4. **Exact diff format for Edit expansion**
   - What we know: User wants diffs in expanded view. Unified diff is standard.
   - What's unclear: Should we use `---/+++` header format or simplified `-/+` lines?
   - Recommendation: Use simplified format. No `---/+++` headers (wastes space). Just `- old line` and `+ new line` with monospace formatting. Wrap in `<pre>` block.

## Discretion Recommendations

Based on research, here are recommendations for areas marked as Claude's Discretion:

1. **LRU cache size limit:** 500 entries max, 4-hour TTL. Rationale: typical session has 50-200 tool calls; 500 provides comfortable headroom for multiple concurrent sessions. 4-hour TTL matches typical max session length.

2. **Expand content exceeding 4096 chars:** Truncate expanded text to 3900 chars, append `\n\n(truncated -- full output exceeds Telegram limit)`. For Bash output specifically, per user decision, send as file attachment if > 4096. For Edit/Write, truncate the diff/content with a note.

3. **Edit diff format in expanded view:** Use simplified unified diff format with `-` and `+` prefixes, wrapped in `<pre>` blocks. One section per edit (for MultiEdit, show each edit with a separator line).

4. **Pending approvals during /clear:** Auto-deny all pending approvals for the session with reason "Session cleared". This is the safest behavior -- Claude Code will handle the denial gracefully and the new session starts clean.

## Sources

### Primary (HIGH confidence)
- Existing codebase analysis: `src/bot/formatter.ts`, `src/bot/bot.ts`, `src/bot/topics.ts`, `src/bot/rate-limiter.ts`, `src/hooks/handlers.ts`, `src/sessions/session-store.ts`, `src/index.ts`, `src/monitoring/status-message.ts`, `src/types/hooks.ts`, `src/types/sessions.ts`
- [grammY InlineKeyboard docs](https://grammy.dev/plugins/keyboard) - Inline keyboard creation and callback query handling
- [grammY API reference](https://grammy.dev/ref/core/api) - editMessageText, unpinChatMessage, pinChatMessage method signatures
- [lru-cache GitHub](https://github.com/isaacs/node-lru-cache) - Version 10, TypeScript native, max/ttl/dispose API

### Secondary (MEDIUM confidence)
- [Telegram Bot API](https://core.telegram.org/bots/api) - callback_data 64-byte limit, editMessageText with reply_markup, unpinChatMessage with message_id parameter
- [grammY callback query examples](https://grammy.dev/plugins/keyboard) - Pattern for bot.callbackQuery() with regex matching

### Tertiary (LOW confidence)
- None -- all findings verified with codebase or official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Only addition is lru-cache (well-known, verified via npm/GitHub); rest is existing project dependencies
- Architecture: HIGH - Patterns derived directly from existing codebase analysis; expand/collapse follows existing approval keyboard pattern
- Pitfalls: HIGH - All pitfalls identified from codebase review and Telegram API constraints; several already have mitigations in existing code

**Research date:** 2026-03-01
**Valid until:** 2026-03-31 (stable domain; Telegram Bot API and grammY rarely have breaking changes)
