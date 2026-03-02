# Stack Research: v4.0 Status & Settings

**Domain:** Telegram bot status indicators, sub-agent suppression, message deduplication, interactive settings topic
**Researched:** 2026-03-02
**Confidence:** HIGH (existing stack, Telegram API capabilities verified against official docs and aiogram reference)

## Scope

This research covers ONLY the stack additions and changes needed for v4.0 features. The validated existing stack (grammY 1.41.0, Fastify 5.x, TypeScript 5.x, @anthropic-ai/claude-agent-sdk, LRU cache, JSONL transcript watching, InlineKeyboard, message batching, debounced status edits) is not re-researched.

---

## Critical Finding: Telegram API Constraint on Topic Icon Color

**`editForumTopic` does NOT support changing `icon_color` after creation.**

Verified against:
- [aiogram 3.24 editForumTopic docs](https://docs.aiogram.dev/en/latest/api/methods/edit_forum_topic.html) — parameters: `name` (optional), `icon_custom_emoji_id` (optional). No `icon_color`.
- [python-telegram-bot ForumTopic constants](https://docs.python-telegram-bot.org/en/v21.6/telegram.forumtopic.html) — icon_color is a read-only attribute set at creation time.
- [Telegram API method channels.editForumTopic](https://core.telegram.org/method/channels.editForumTopic) — `icon_emoji_id` editable, `icon_color` is NOT listed.

**Implication:** Color-coded status cannot use the Telegram topic icon color field for live status updates. The existing code already solves this correctly: the topic **name** carries a Unicode status emoji prefix (e.g., `\u{1F7E2} project-name`). This is the right approach. The v4.0 work is purely expanding the status emoji vocabulary and defining a consistent mapping.

**`icon_color` at creation time only** — integers map to:
- `7322096` (0x6FB9F0) — Blue
- `16766590` (0xFFD67E) — Yellow
- `13338331` (0xCB86DB) — Purple
- `9367192` (0x8EEE98) — Green
- `16749490` (0xFF93B2) — Pink
- `16478047` (0xFB6F5F) — Red/Orange

These are useful for initial topic creation color, but NOT for live status changes. Do not design around them.

---

## Feature 1: Color-Coded Topic Status (Emoji in Topic Names)

### What's Needed

Replace the inconsistent emoji usage across `topics.ts`, `status-message.ts`, and `index.ts` with a defined `TopicStatus` enum and a single `setTopicStatus()` function. Define four states: ready (green), busy (yellow), error (red), down/gray (closed).

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Change topic name | `editForumTopic(chatId, threadId, { name })` via grammY — already used in `topics.ts` | No unified status model; emojis scattered across code | New `TopicStatus` type + `setTopicStatus()` in `topics.ts` |
| Status emoji vocabulary | Existing: `\u{1F7E2}` (green), `\u2705` (done), `\u{1F504}` (restart) | No yellow or gray states defined | Add `\u{1F7E1}` (yellow), `\u26AA` (gray), `\u{1F534}` (red) — all standard Unicode |
| Startup gray sweep | `SessionStore.getAllSessions()` exists | No startup cleanup pass | Loop all sessions with threadId > 0, call `editForumTopic` with gray prefix |
| Rate limiting on startup sweep | `auto-retry` and `apiThrottler` plugins active | Multiple editForumTopic calls on startup | Throttler handles it; add sequential await pattern in startup sequence |

### Status Emoji Mapping (No New Libraries)

```typescript
// src/types/topic-status.ts (new file, ~15 lines)
export type TopicStatus = 'ready' | 'busy' | 'error' | 'down';

export const STATUS_EMOJI: Record<TopicStatus, string> = {
  ready: '\u{1F7E2}',   // green circle — waiting for next task
  busy:  '\u{1F7E1}',   // yellow circle — tool calls in progress
  error: '\u{1F534}',   // red circle — error / permission blocked
  down:  '\u26AA',      // gray circle — bot not running / session closed
};
```

Startup sweep in `index.ts`:
```typescript
// Set all known topics to gray on startup before reconnecting
for (const session of sessionStore.getAllSessions()) {
  if (session.threadId > 0) {
    await topicManager.setTopicStatus(session.threadId, session.topicName, 'down');
  }
}
```

### What NOT to Add

- **No `icon_color` manipulation.** Cannot change color after creation. emoji prefix in the name is the correct approach and is already established in the codebase.
- **No `icon_custom_emoji_id`.** Custom emoji IDs require calling `getForumTopicIconStickers` to enumerate valid IDs, and the sticker set for default topic icons does not include status-meaningful icons (it's decorative emoji, not status circles). Standard Unicode emoji in the topic name is universally visible and requires zero additional API calls.

---

## Feature 2: Sub-Agent Suppression Configuration

### What's Needed

Add a per-session (or global) flag: `subagentVisible: boolean`. When `false` (the new default), suppress SubagentStart topic creation, SubagentStop announcements, and sub-agent tool output lines. When `true`, maintain current behavior.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Global default flag | `config.ts` reads env vars for feature flags | No subagent visibility flag | Add `SUBAGENT_VISIBLE` env var, default `false` |
| Per-session override | `SessionInfo` has `verbosity` field pattern | No subagent visibility field | Add `subagentVisible?: boolean` to `SessionInfo` |
| Suppression in hook handler | `onSubagentStart`, `onSubagentStop`, `onToolUse` already check `activeAgent` | No suppression gate | Add `if (!shouldShowSubagent(session)) return;` guard before posting |
| Suppression in transcript watcher | `onSidechainMessage` callback in `TranscriptWatcher` | No suppression gate | Guard same callback in `initMonitoring()` |

### Implementation Pattern (No New Libraries)

The suppression logic is a runtime conditional check, not a new component. The `SubagentTracker` continues to track lifecycle state (needed for correct temporal attribution), but Telegram posting is gated on `subagentVisible`.

```typescript
// Guard in index.ts HookCallbacks
onSubagentStart: async (session, payload) => {
  const agent = subagentTracker.start(session.sessionId, payload.agent_id, payload.agent_type);
  const config = getSessionConfig(session); // reads subagentVisible
  if (!config.subagentVisible) return;      // suppress — no Telegram post
  // ... existing posting logic
},
```

The `SubagentTracker.start()` / `.stop()` calls happen unconditionally so temporal tool attribution remains correct. Only the Telegram-facing output is suppressed.

### What NOT to Add

- **No separate subagent message queue.** Suppression is a simple boolean gate, not a buffering system.
- **No settings to hide/show specific agent types.** Per-type filtering is over-engineered for v4.0. A single `subagentVisible` flag covers the stated requirement.

---

## Feature 3: Sticky Message Deduplication

### What's Needed

Before creating a new pinned status message (`StatusMessage.initialize()`), check if the existing pinned message content matches what would be sent. If it matches, skip creating a new one and reuse the existing `messageId`.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Know current pinned content | `StatusMessage` tracks `lastSentText` privately | `lastSentText` not accessible at initialization time | Expose `getLastSentText()` or pass initial content to constructor |
| Fetch existing pinned message content | `bot.api.getMessage()` / `forwardMessage()` — NOT available in Bot API | **Bot API has no getMessages method** | Must track content ourselves; cannot fetch from Telegram |
| Reuse existing message ID | `sessionStore.statusMessageId` persists across restarts | `StatusMessage.initialize()` always calls `sendMessage()` | Add early-return path: if `statusMessageId > 0` and content unchanged, skip re-send |
| Content comparison | `StatusMessage.flush()` already skips identical content on edit | No comparison at initialization | Apply same `lastSentText` comparison in `initialize()` |

### Critical Telegram API Constraint

**`bot.api.getMessage()` does not exist in the Telegram Bot API.** Bots cannot fetch arbitrary messages by ID. Therefore, the only reliable way to know the current sticky content is to track what was last sent in-process (already done via `lastSentText`).

The deduplication strategy is: pass the current `statusMessageId` and last-known `statusContent` into `StatusMessage` at initialization. If both are non-empty and the formatted initial status matches, skip `sendMessage()` and resume with the existing message ID.

### Implementation Pattern (No New Libraries)

```typescript
// Modified StatusMessage constructor/initialize signature
async initialize(existingMessageId?: number, existingContent?: string): Promise<number> {
  const initialData = buildInitialStatusData();
  const text = formatStatus(initialData);

  // Skip re-send if content matches existing pinned message
  if (existingMessageId && existingContent && text === existingContent) {
    this.messageId = existingMessageId;
    this.lastSentText = existingContent;
    return existingMessageId; // reuse
  }

  // Otherwise send fresh (existing path)
  const msg = await this.bot.api.sendMessage(...);
  // ...
}
```

The `SessionStore` already persists `statusMessageId`. A new `statusMessageContent` field stores the last known text for comparison on reconnect.

### What NOT to Add

- **No `bot.api.getMessage()`.** This method does not exist in the Telegram Bot API for bots. Any implementation relying on fetching message content from Telegram will not work.
- **No message history cache beyond the single status message.** The deduplication only applies to the pinned status message, not all messages.

---

## Feature 4: Settings Topic with Interactive Configuration

### What's Needed

A persistent Telegram forum topic named "Settings" that shows current bot configuration as a message with toggle buttons. Pressing a button updates the setting in memory and on disk, then re-renders the message.

### Stack Assessment

| Requirement | Existing Capability | Gap | Solution |
|-------------|---------------------|-----|----------|
| Create a dedicated topic | `TopicManager.createTopic()` | No concept of a "settings topic" | Create settings topic at startup if not exists; persist `settingsThreadId` in a config file |
| Interactive toggle buttons | `InlineKeyboard` + `bot.callbackQuery()` — already used for approvals | No settings-specific keyboard | New settings keyboard builder function |
| Settings persistence | JSON file via `SessionStore` pattern | No settings data model | New `SettingsStore` using same atomic-write JSON pattern |
| Settings message edit in place | `TopicManager.editMessage()` | No settings message tracking | Store `settingsMessageId` in `SettingsStore` |

### Settings Topic Architecture (No New Libraries Needed)

The settings topic follows the same `editMessageText` pattern already used for `StatusMessage`. No `@grammyjs/menu` plugin is needed:

- The menu plugin's primary benefit is multi-page navigation and dynamic ranges. Our settings panel is a single-page set of toggles.
- The existing `InlineKeyboard` + `bot.callbackQuery()` pattern (already proven for 8+ handlers) handles this with less complexity.
- `@grammyjs/menu` adds a grammY session dependency that requires storage wiring not needed for a single-screen settings panel.

**Settings keyboard pattern:**

```typescript
// Callback data format: "cfg:{key}" — e.g., "cfg:subagentVisible"
// Fits comfortably within 64-byte callback_data limit
function buildSettingsKeyboard(settings: BotSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      settings.subagentVisible ? '🟢 Sub-agents: Visible' : '⚫ Sub-agents: Hidden',
      'cfg:subagentVisible'
    )
    .row()
    .text(
      `Verbosity: ${settings.defaultVerbosity}`,
      'cfg:verbosity'
    );
}

bot.callbackQuery(/^cfg:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  settingsStore.toggle(key);
  const settings = settingsStore.getAll();
  await ctx.editMessageText(buildSettingsMessage(settings), {
    parse_mode: 'HTML',
    reply_markup: buildSettingsKeyboard(settings),
  });
  await ctx.answerCallbackQuery();
});
```

### Settings Persistence: Custom SettingsStore (No New Library)

Settings are simple key-value pairs that change infrequently. The same atomic JSON write pattern from `SessionStore` (write to `.tmp`, rename) is sufficient:

```typescript
// src/settings/settings-store.ts (new file, ~80 lines)
export class SettingsStore {
  private data: BotSettings;
  private filePath: string;
  // load(), save() via atomic JSON write — identical pattern to SessionStore
}
```

`@grammyjs/storage-file` (v2.5.1) was evaluated but adds the grammY session middleware dependency chain. For a plain key-value settings file that is written only on user interaction, the minimal custom store is preferable.

### Settings Topic Initialization

At startup:
1. Read `settingsThreadId` from `SettingsStore` (persisted).
2. If `settingsThreadId === 0`, call `createForumTopic('Settings')` and store the returned ID.
3. If `settingsThreadId > 0`, attempt to post/edit the settings message in the existing topic.

The settings topic is identified by thread ID, not by searching topic names. This is robust to the bot restarting and to the topic being renamed.

### What NOT to Add

- **`@grammyjs/menu` (v1.3.1).** The menu plugin's navigation framework (submenus, back buttons, dynamic ranges) is unnecessary for a single-screen settings panel. The existing `InlineKeyboard` + callback handlers are simpler, already proven, and already in the codebase. Re-evaluate if settings grow to require multiple pages.
- **`@grammyjs/storage-file` (v2.5.1).** Adds grammY session middleware wiring overhead. The `SessionStore` atomic-write pattern covers the same need without session context threading.
- **`@grammyjs/conversations`.** Settings updates are single-tap interactions, not multi-step dialogues.
- **Telegram `bot.api.getMessage()`.** Does not exist. Cannot fetch settings message content from Telegram; must track locally.

---

## Recommended Stack (No New Dependencies)

All four v4.0 features can be implemented with the existing dependency set. The work is purely application-level.

### Core Technologies (No Changes)

| Technology | Current Version | Purpose | Action |
|------------|----------------|---------|--------|
| grammy | ^1.40.1 (1.41.0 available) | Telegram bot framework | KEEP — all needed API methods present; consider bumping to 1.41.0 |
| @grammyjs/auto-retry | ^2.0.2 | Rate limit retry | KEEP |
| @grammyjs/transformer-throttler | ^1.2.1 | API request throttling | KEEP |
| fastify | ^5.7.4 | HTTP hook server | KEEP |
| @anthropic-ai/claude-agent-sdk | ^0.2.63 | SDK input delivery | KEEP |
| lru-cache | ^11.2.6 | Expand/collapse cache | KEEP |
| typescript | ^5.9.3 | Language | KEEP |

### Supporting Libraries (No Changes)

| Library | Current Version | Purpose | Action |
|---------|----------------|---------|--------|
| dotenv | ^17.3.1 | Environment config | KEEP |
| pino | ^10.3.1 | Structured logging | KEEP |
| zod | ^4.3.6 | Schema validation | KEEP |

### New Application Modules (No New npm Packages)

| New File | Purpose |
|----------|---------|
| `src/types/topic-status.ts` | `TopicStatus` type + `STATUS_EMOJI` map |
| `src/settings/settings-store.ts` | Atomic JSON persistence for bot settings |
| `src/settings/settings-topic.ts` | Settings topic creation, message rendering, keyboard builder |

### Modified Files

| File | Changes |
|------|---------|
| `src/bot/topics.ts` | Add `setTopicStatus(threadId, name, status)` method |
| `src/types/sessions.ts` | Add `statusMessageContent?: string` for deduplication |
| `src/types/config.ts` | Add `subagentVisible: boolean`, `settingsThreadId: number` |
| `src/config.ts` | Parse `SUBAGENT_VISIBLE` env var (default: `false`) |
| `src/monitoring/status-message.ts` | Add `existingMessageId` + `existingContent` params to `initialize()` |
| `src/sessions/session-store.ts` | Add `updateStatusMessageContent()` method |
| `src/index.ts` | Startup gray sweep; subagent suppression gates; settings topic init; wire cfg: callbacks |
| `src/bot/bot.ts` | Add `cfg:` callback query handler for settings toggles |

### New Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SUBAGENT_VISIBLE` | `false` | Show sub-agent spawn/done/output by default |

---

## Installation

```bash
# No new packages to install for v4.0.
# All required capabilities exist in the current dependency set.

# Optional: bump grammy to latest (1.41.0 is available, backward-compatible)
npm install grammy@latest
```

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| Unicode emoji prefix in topic name | `editForumTopic icon_color` | Cannot change icon_color after creation — Telegram Bot API limitation (verified) |
| Unicode emoji prefix in topic name | `editForumTopic icon_custom_emoji_id` | Requires calling `getForumTopicIconStickers` to get valid emoji IDs; default topic icon stickers are decorative emoji, not status-meaningful symbols; adds complexity with no UX benefit over standard Unicode circles |
| Custom `SettingsStore` (JSON atomic write) | `@grammyjs/storage-file` v2.5.1 | Storage-file requires grammY session middleware wiring; for a plain settings file with ~5 keys written on user tap, a 80-line custom store is simpler and has no middleware chain |
| `InlineKeyboard` + callback handlers | `@grammyjs/menu` v1.3.1 | Menu plugin is designed for multi-page navigation; settings is a single screen; existing callback handler pattern is already proven for 8+ handlers in the codebase |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `bot.api.getMessage()` | Does not exist in Telegram Bot API — bots cannot fetch messages by ID | Track last-sent content in memory (`lastSentText` pattern already in `StatusMessage`) |
| `editForumTopic` with `icon_color` | Not a valid parameter for edit — only valid at creation via `createForumTopic` | Emoji prefix in topic name (already the correct implementation) |
| `@grammyjs/menu` | Adds multi-page navigation overhead for a single-screen settings panel | `InlineKeyboard` + `bot.callbackQuery(/^cfg:/)` |
| `@grammyjs/storage-file` | Session middleware overhead for settings that change only on user tap | Custom `SettingsStore` following `SessionStore` atomic-write pattern |
| Database (SQLite, Redis, etc.) | Settings are 5-10 simple key-value pairs, not relational data | JSON file with atomic write (same as existing `sessions.json`) |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| grammy@1.40–1.41 | @grammyjs/auto-retry@2.0.2 | Confirmed compatible — both in current codebase |
| grammy@1.40–1.41 | Telegram Bot API 8.x–9.x | grammY 1.x tracks current Bot API; `editForumTopic` with `name` + `icon_custom_emoji_id` available |
| grammy@1.40–1.41 | @grammyjs/transformer-throttler@1.2.1 | Confirmed compatible — in current codebase |
| TypeScript@5.9 | All dependencies | All have bundled types or @types packages |

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| `editForumTopic` cannot change `icon_color` | HIGH | Verified against aiogram 3.24 docs (authoritative Bot API mirror), Telegram API method spec, python-telegram-bot constants |
| Emoji prefix in topic name works for status | HIGH | Already implemented in the codebase (`\u{1F7E2}` prefix on create, edit on close/reopen) |
| No new npm packages needed | HIGH | Mapped every feature to existing grammY API methods + existing code patterns |
| `@grammyjs/menu` not needed | HIGH | Settings panel is single-screen; `InlineKeyboard` + `callbackQuery` pattern is already proven for 8+ handlers |
| Sub-agent suppression via boolean gate | HIGH | SubagentTracker already tracks state; suppression is a posting-layer gate, not a tracker change |
| Sticky message deduplication via content tracking | HIGH | `StatusMessage.lastSentText` already tracks content; extend to initialization path |
| Settings persistence via custom JSON store | HIGH | Identical pattern to `SessionStore` which is proven in production |

---

## Sources

- [aiogram 3.24 editForumTopic](https://docs.aiogram.dev/en/latest/api/methods/edit_forum_topic.html) — confirmed `icon_color` NOT a parameter for edit
- [python-telegram-bot ForumTopic v21.6](https://docs.python-telegram-bot.org/en/v21.6/telegram.forumtopic.html) — `ForumIconColor` constants: BLUE=7322096, GREEN=9367192, YELLOW=16766590, RED=16478047, PURPLE=13338331, PINK=16749490
- [Telegram API channels.editForumTopic](https://core.telegram.org/method/channels.editForumTopic) — MTProto-level confirmation of editable fields
- [grammY Menu plugin](https://grammy.dev/plugins/menu) — evaluated; single-screen settings does not benefit from navigation framework
- [grammY InlineKeyboard docs](https://grammy.dev/plugins/keyboard) — confirmed callbackQuery pattern; 64-byte callback_data limit
- [@grammyjs/menu npm](https://www.npmjs.com/package/@grammyjs/menu) — v1.3.1 confirmed current (npm info)
- [@grammyjs/storage-file npm](https://www.npmjs.com/package/@grammyjs/storage-file) — v2.5.1 confirmed current; evaluated and rejected for simple settings use case
- Existing codebase review: `src/bot/topics.ts`, `src/monitoring/status-message.ts`, `src/sessions/session-store.ts`, `src/monitoring/subagent-tracker.ts`, `src/index.ts` — confirmed all integration points

---
*Stack research for: Claude Code Telegram Bridge v4.0 Status & Settings*
*Researched: 2026-03-02*
