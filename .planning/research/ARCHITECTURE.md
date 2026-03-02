# Architecture Research: v4.0 Status & Settings Integration

**Domain:** Claude Code Telegram Bridge -- adding status indicators, sub-agent suppression, sticky deduplication, and settings topic to existing architecture
**Researched:** 2026-03-02
**Confidence:** HIGH (existing codebase fully analyzed, Telegram Bot API constraints verified, v3.0 architecture fully understood)

## Existing Architecture (v3.0 Baseline)

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Claude Code Process                            │
│  Hooks: SessionStart, SessionEnd, PreToolUse, PostToolUse,            │
│         Notification, Stop, SubagentStart, SubagentStop               │
│  Transcript: ~/.claude/projects/.../session.jsonl                     │
└──────────────┬──────────────────────────────────────┬─────────────────┘
               │ HTTP POST (hook events)              │ JSONL file writes
               ▼                                      ▼
┌──────────────────────────┐         ┌──────────────────────────────────┐
│  Fastify Hook Server     │         │  TranscriptWatcher (per-session) │
│  /hooks/session-start    │         │  fs.watch + byte-position tail   │
│  /hooks/session-end      │         │  Emits: onAssistantMessage,      │
│  /hooks/post-tool-use    │         │         onUsageUpdate,           │
│  /hooks/notification     │         │         onSidechainMessage       │
│  /hooks/pre-tool-use     │         └──────────────┬───────────────────┘
│    (BLOCKING)            │                        │
│  /hooks/subagent-start   │                        │
│  /hooks/subagent-stop    │                        │
└──────────┬───────────────┘                        │
           │                                        │
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         index.ts Wiring Layer                        │
│  HookCallbacks: onSessionStart, onSessionEnd, onToolUse,             │
│                 onNotification, onPreToolUse, onStop,                 │
│                 onSubagentStart, onSubagentStop, onBackfillSummary    │
│  SessionMonitor: { transcriptWatcher, statusMessage, summaryTimer }  │
│  ApprovalManager: deferred promises keyed by tool_use_id             │
│  PermissionModeManager: per-session auto-accept state machine        │
│  SubagentTracker: agent lifecycle, depth, description stash          │
│  InputRouter: tmux | fifo | sdk-resume per session                   │
│  ClearDetector: filesystem watcher for /clear workaround             │
└──────────┬───────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          Telegram Layer                               │
│  Bot (grammY): callback queries, text input, /commands               │
│  TopicManager: create/close/reopen/rename topics, send messages      │
│  MessageBatcher: 2s debounce, combines messages, expand cache        │
│  StatusMessage: pinned msg, edit-in-place with 3s debounce           │
│  ExpandCache: in-memory LRU for expand/collapse button content       │
│  Formatter: formatToolCompact, formatApproval*, formatSubagent*      │
└──────────────────────────────────────────────────────────────────────┘
```

### Current Topic Naming Conventions (v3.0)

The `TopicManager` already uses emoji unicode prefixes to convey status via topic names:

| State | Current Prefix | API Method |
|-------|---------------|------------|
| Active (new/resume) | `🟢 project-name` | `createForumTopic` / `editForumTopic({ name })` |
| Done (closed) | `✅ project-name (done)` | `editForumTopic({ name })` + `closeForumTopic` |

### Critical Telegram API Constraint (HIGH confidence)

`icon_color` (RGB integer) in forum topics is ONLY settable at creation time via `createForumTopic`. `editForumTopic` does NOT accept `icon_color`. The `icon_custom_emoji_id` parameter CAN be changed after creation, but requires Telegram Premium or emoji IDs from `getForumTopicIconStickers` (the default topic icon pack) -- these are opaque IDs with no semantic color guarantee.

**Conclusion:** Color-coded status is best implemented via unicode circle emoji prefixes in the topic name (🟢/🟡/🔴/⬜), NOT via the `icon_color` API field. The existing `TopicManager` already uses this pattern. The v4.0 feature extends it with two new states (busy/yellow and down/gray) and adds startup reset behavior.

---

## Feature Integration Analysis

### Feature 1: Color-Coded Topic Status Indicators

**Requirement:** Green=ready, yellow=busy, red=error, gray=down. All old topics set to gray on startup.

**Mechanism:** Extend the existing `TopicManager.editTopicName()` pattern. No new Telegram API calls needed -- just extend the prefix logic.

**Status Color Mapping:**

| Status | Emoji Prefix | When |
|--------|-------------|------|
| Ready (idle, awaiting input) | `🟢` | Session active, Stop hook fired, no subagent |
| Busy (working) | `🟡` | PostToolUse, SubagentStart received |
| Error | `🔴` | Session error state (future use; not triggered today) |
| Down (closed/offline) | `⬜` | Bot startup (all old sessions), SessionEnd |

**Current state vs target:**

- Currently: `🟢` on create/resume, `✅ (done)` on close -- no busy/down states
- Target: 4-state machine updated on hook events

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `bot/topics.ts` | **MODIFY** | Add `setTopicStatus(threadId, topicName, status)` method; status enum covers `ready | busy | error | down` |
| `index.ts` | **MODIFY** | Call `setTopicStatus('busy')` on PostToolUse and SubagentStart; call `setTopicStatus('ready')` on Stop hook; call `setTopicStatus('down')` on SessionEnd |
| `index.ts` startup | **MODIFY** | On bot start, iterate all sessions in SessionStore, call `setTopicStatus('down')` for each known threadId |
| `types/sessions.ts` | **MODIFY** | Add `topicStatus: 'ready' | 'busy' | 'error' | 'down'` field to `SessionInfo` for persistence |
| `sessions/session-store.ts` | **MODIFY** | Add `updateTopicStatus(sessionId, status)` method |

**Data Flow:**

```
Bot starts up
    ↓
sessionStore.getAllSessions() → filter: threadId > 0
    ↓
for each: topicManager.setTopicStatus(threadId, topicName, 'down')
    (fire-and-forget, best-effort -- topic may be closed already)

PostToolUse / SubagentStart hook fires
    ↓
callbacks.onToolUse / callbacks.onSubagentStart
    ↓
topicManager.setTopicStatus(session.threadId, session.topicName, 'busy')
    (debounced -- avoid editForumTopic spam on rapid tool calls)

Stop hook fires
    ↓
callbacks.onStop
    ↓
topicManager.setTopicStatus(session.threadId, session.topicName, 'ready')

SessionEnd fires
    ↓
callbacks.onSessionEnd
    ↓
topicManager.closeTopic() (existing) with 'down' prefix instead of '✅'
```

**Debouncing Requirement:**

`editForumTopic` is rate-limited by Telegram (same limits as `editMessageText`). Rapid PostToolUse events (e.g., 10 Read calls in 2s) would trigger 10 `editForumTopic` calls. The busy state only needs to be set ONCE per "working" period. Debounce strategy: track `currentTopicStatus` per session in-memory; skip `editForumTopic` if already in the target state.

```typescript
// In TopicManager or SessionMonitor -- track current known state
private topicStatusCache = new Map<number, string>(); // threadId -> current prefix

async setTopicStatus(threadId: number, topicName: string, status: TopicStatus): Promise<void> {
  const prefix = STATUS_PREFIXES[status];
  const cacheKey = `${threadId}:${prefix}`;
  if (this.topicStatusCache.get(threadId) === prefix) return; // Already in this state
  this.topicStatusCache.set(threadId, prefix);
  await this.editTopicName(threadId, `${prefix} ${topicName}`);
}
```

**Startup Cleanup:**

On bot start, before `bot.start()`, iterate all sessions from SessionStore and set their topics to gray/down. This is fire-and-forget -- topics that are already closed will produce API errors which are swallowed. No need to re-open closed topics.

---

### Feature 2: Sub-Agent Silence by Default

**Requirement:** Sub-agent output suppressed by default (no topic, no output). Configurable to re-enable.

**Current behavior (v3.0):** SubagentStart posts spawn announcement, PostToolUse hooks from subagents post with `[AgentName]` prefix, SubagentStop posts done announcement, sidechain transcript messages post with `[AgentName]` prefix.

**Target behavior:** Sub-agent events silenced unless explicitly enabled. Config key `SUBAGENT_OUTPUT=show|hide` (default: `hide`).

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `types/config.ts` | **MODIFY** | Add `subagentOutput: 'show' | 'hide'` field |
| `src/config.ts` | **MODIFY** | Parse `SUBAGENT_OUTPUT` env var (default `'hide'`) |
| `index.ts` | **MODIFY** | Gate `onSubagentStart`, `onSubagentStop`, and sidechain transcript handling on `config.subagentOutput === 'show'` |
| `index.ts` | **MODIFY** | Gate subagent prefix on `PostToolUse` tool display on `config.subagentOutput === 'show'`; if `hide`, suppress the tool call entirely when a subagent is active |

**Data Flow (suppress path):**

```
SubagentStart hook fires
    ↓
callbacks.onSubagentStart
    ↓
config.subagentOutput === 'hide' → subagentTracker.start() (still track, for lifecycle)
                                  → skip spawn announcement post
                                  → skip Telegram message

PostToolUse fires while subagent active
    ↓
callbacks.onToolUse
    ↓
config.subagentOutput === 'hide' AND subagentTracker.isSubagentActive(sessionId)
    → return early (suppress tool display)
    (still increment tool count for status message)

TranscriptWatcher.onSidechainMessage fires
    ↓
config.subagentOutput === 'hide' → return without posting

SubagentStop fires
    ↓
callbacks.onSubagentStop
    ↓
subagentTracker.stop() (still clean up state)
config.subagentOutput === 'hide' → skip done announcement
```

**Why still track in SubagentTracker even when hidden:**

The subagentTracker is needed to correctly attribute PostToolUse events during suppression. If we skip `subagentTracker.start()`, the `isSubagentActive()` check fails and subagent tool calls would incorrectly appear as main-chain output. The tracker is pure in-memory state -- cheap to maintain regardless of display setting.

**Session-Level Override (Optional, deferred):**

Per-session override (e.g., `/verbose subagents`) is out of scope for this milestone. The config-level default covers the primary use case.

---

### Feature 3: Sticky Message Deduplication

**Requirement:** Skip creating a new sticky/pinned message if content matches the existing pinned message.

**Current behavior (v3.0):** `StatusMessage.initialize()` always sends a new message and pins it, even if the previous status message for the session (from a resume or clear) had the same initial content.

**The actual duplication scenario:**

The current `StatusMessage` class already has content deduplication for `requestUpdate()` (skips `editMessageText` if content unchanged). The missing dedup is in `initialize()` on session resume or restart -- a new "Starting..." message is always posted even if one already exists.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| `monitoring/status-message.ts` | **MODIFY** | `initialize(existingMessageId?)` -- if an existing message ID is provided, attempt to re-use it instead of sending a new message; verify content via stored `lastSentText` |
| `index.ts` | **MODIFY** | In `initMonitoring()`, pass `session.statusMessageId` to `StatusMessage` when it is non-zero (resume/restart path); only call `initialize()` for new sessions (statusMessageId === 0) |
| `sessions/session-store.ts` | No change needed | `statusMessageId` already persisted |

**Dedup Strategy:**

For resume and reconnect flows (where `session.statusMessageId > 0`), instead of calling `initialize()`:
1. Instantiate `StatusMessage` with the existing `messageId` pre-set
2. The first `requestUpdate()` call will overwrite in place (existing behavior already works)
3. Re-pin only if the message is not already pinned (requires a `getChatAdministrators` check OR just swallow the "already pinned" error)

For `/clear` transitions:
- A fresh status message IS desired (separator was posted, context is reset)
- Pass `existingMessageId = 0` to force a new message

**Concrete Change:**

```typescript
// StatusMessage (modified)
async initialize(existingMessageId?: number): Promise<number> {
  if (existingMessageId && existingMessageId > 0) {
    // Resume path: adopt existing message, request update to sync content
    this.messageId = existingMessageId;
    this.requestUpdate(/* initial status data */);
    return existingMessageId; // No new message sent, no new pin
  }
  // New session path: send + pin (existing behavior)
  ...
}
```

```typescript
// index.ts - initMonitoring (modified)
const isResume = session.statusMessageId > 0;
void statusMsg.initialize(isResume ? session.statusMessageId : undefined)
  .then((statusMessageId) => {
    if (!isResume) {
      sessionStore.updateStatusMessageId(session.sessionId, statusMessageId);
    }
  });
```

**Edge Case:** Bot restart while Claude session is active. The old pinned message exists. `statusMessageId` is persisted. The new `StatusMessage` adopts it and posts an update edit. The pin is preserved.

---

### Feature 4: Settings Topic

**Requirement:** A dedicated Telegram topic for configuring bot settings interactively. Runtime configuration changes without restarting the bot.

**Architecture Pattern: Singleton Settings Topic**

One special topic in the group (not tied to any Claude session) where the user sends commands to change bot settings. The topic is created once by the bot and its ID is persisted. Commands are parsed from messages in that topic.

**Integration Points:**

| Component | Change Type | Description |
|-----------|-------------|-------------|
| New: `settings/settings-store.ts` | **NEW** | Persist settings as JSON alongside session data. Read/write runtime config overrides. |
| New: `settings/settings-topic.ts` | **NEW** | `SettingsTopic` class: create/find the settings topic, parse commands, apply changes |
| `types/config.ts` | **MODIFY** | Add `settingsTopicId?: number` -- persisted ID of the settings topic |
| `src/config.ts` | **MODIFY** | Load `settingsTopicId` from settings store on startup |
| `bot/bot.ts` | **MODIFY** | Route messages from the settings topic to `SettingsTopic.handleMessage()` |
| `index.ts` | **MODIFY** | Initialize `SettingsTopic` on startup; create settings topic if not found |

**Settings Topic Lifecycle:**

```
Bot starts
    ↓
settingsStore.load() → find settingsTopicId
    ↓
if not found: topicManager.createSettingsTopic() → store new threadId
if found: verify topic still exists (getForumTopicInfo or first message attempt)
    ↓
Post "Settings ready" message with current config summary
    (only on first creation or after bot restart)

User sends message in settings topic:
    /subagents show|hide
    /verbosity normal|verbose|quiet
    /summary on|off
    (etc.)
    ↓
bot.on('message:text') → detect settingsThreadId match
    ↓
SettingsTopic.handleCommand(text) → parse + apply + reply
    ↓
settingsStore.save() → persist change
    ↓
Runtime config object updated in-memory (no restart needed)
```

**Settings Storage:**

Store settings as a separate JSON file (e.g., `data/settings.json`) alongside `data/sessions.json`. This separates concerns and makes settings editable independently.

```typescript
// data/settings.json
{
  "settingsTopicId": 12345,
  "subagentOutput": "hide",
  "defaultVerbosity": "normal",
  "summaryIntervalMs": 300000
}
```

**Runtime Config Override Mechanism:**

The `AppConfig` object loaded at startup from env is currently immutable. To support runtime changes:

- Wrap mutable settings in a `RuntimeSettings` object (separate from `AppConfig`)
- `RuntimeSettings` holds settings that can change at runtime
- Components that need these settings read from `RuntimeSettings`, not `AppConfig`
- `SettingsTopic` writes to `RuntimeSettings` + persists to `settings.json`

```typescript
// src/settings/runtime-settings.ts
export class RuntimeSettings {
  subagentOutput: 'show' | 'hide';
  defaultVerbosity: VerbosityTier;
  summaryIntervalMs: number;

  constructor(initial: Partial<RuntimeSettings>) { ... }

  update(key: keyof RuntimeSettings, value: unknown): void { ... }
}
```

**Settings Topic Commands (MVP):**

| Command | Effect | Example |
|---------|--------|---------|
| `/subagents show` | Enable sub-agent output | Show spawn/done + tool calls |
| `/subagents hide` | Suppress sub-agent output | Default |
| `/verbosity verbose\|normal\|quiet` | Set default verbosity for new sessions | `/verbosity quiet` |
| `/summary on\|off` | Enable/disable periodic summary | `/summary off` |
| `/status` | Show current settings | Lists all current values |

**Settings Topic vs Session Topics:**

The bot receives messages from all topics. The settings topic is identified by `settingsTopicId`. The text message handler in `bot.ts` needs a priority check:

```
message arrives in topic X
    ↓
if X === settingsTopicId → route to SettingsTopic.handleCommand()
else → existing session routing (getByThreadId, then inputRouter)
```

---

## Component Responsibilities (New + Modified)

| Component | Responsibility | Change Type |
|-----------|---------------|-------------|
| `bot/topics.ts` | Add `setTopicStatus()` with in-memory dedup, status enum | **MODIFY** |
| `index.ts` | Wire status updates on PostToolUse/SubagentStart/Stop/SessionEnd; startup cleanup loop; gate subagent output on config; pass statusMessageId to initMonitoring | **MODIFY** |
| `types/config.ts` | Add `subagentOutput: 'show' | 'hide'` | **MODIFY** |
| `src/config.ts` | Parse `SUBAGENT_OUTPUT` env var | **MODIFY** |
| `monitoring/status-message.ts` | `initialize(existingMessageId?)` for resume dedup | **MODIFY** |
| `types/sessions.ts` | Add `topicStatus: TopicStatus` field | **MODIFY** |
| `sessions/session-store.ts` | Add `updateTopicStatus()` method | **MODIFY** |
| New: `settings/settings-store.ts` | Persist runtime settings to JSON | **NEW** |
| New: `settings/settings-topic.ts` | Settings topic lifecycle, command parsing, runtime config updates | **NEW** |
| New: `settings/runtime-settings.ts` | Mutable settings object for in-process runtime config | **NEW** |

---

## System Overview (v4.0 Target)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Process                          │
│  Hooks: SessionStart/End, PreToolUse, PostToolUse,                  │
│         Notification, Stop, SubagentStart, SubagentStop             │
└──────────────┬──────────────────────────────────┬───────────────────┘
               │ HTTP POST                        │ JSONL tail
               ▼                                  ▼
┌──────────────────────┐           ┌──────────────────────────────────┐
│  Fastify Hook Server │           │  TranscriptWatcher               │
│  (unchanged routes)  │           │  (gates sidechain on config)     │
└──────────┬───────────┘           └──────────────┬───────────────────┘
           │                                      │
           ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      index.ts Wiring Layer                          │
│  + status indicator updates (busy on tool/agent, ready on stop)     │
│  + startup gray-out loop                                             │
│  + subagent output gate (config.subagentOutput)                     │
│  + statusMessageId dedup in initMonitoring                          │
│  + RuntimeSettings (live config, updated by SettingsTopic)          │
└──────────┬───────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Telegram Layer                              │
│  Bot (grammY): + settings topic message routing                     │
│  TopicManager: + setTopicStatus() with name-prefix emoji + dedup    │
│  StatusMessage: + initialize(existingMessageId?) for dedup          │
│  SettingsTopic: NEW -- parse commands, update RuntimeSettings        │
│  SettingsStore: NEW -- persist settings.json                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Flows

### Status Indicator Flow

```
PostToolUse arrives (session active, hook event)
    ↓
callbacks.onToolUse (index.ts)
    ↓
subagentOutput === 'hide' AND isSubagentActive? → suppress tool display
    ↓
topicManager.setTopicStatus(threadId, topicName, 'busy')
    ↓ (in TopicManager)
check topicStatusCache: already 'busy'? → skip editForumTopic (dedup)
    ↓
bot.api.editForumTopic(chatId, threadId, { name: '🟡 project-name' })

Stop hook fires (turn complete)
    ↓
callbacks.onStop (index.ts)
    ↓
topicManager.setTopicStatus(threadId, topicName, 'ready')
    ↓
bot.api.editForumTopic(chatId, threadId, { name: '🟢 project-name' })

Bot startup
    ↓
for each session in sessionStore.getAllSessions():
    if session.threadId > 0:
        topicManager.setTopicStatus(session.threadId, session.topicName, 'down')
        [best-effort, errors swallowed]
    ↓
bot.api.editForumTopic(chatId, threadId, { name: '⬜ project-name' })
```

### Sub-Agent Suppression Flow

```
SubagentStart hook fires
    ↓
subagentTracker.start(sessionId, agentId, agentType) [always -- for lifecycle tracking]
    ↓
config.subagentOutput === 'show'?
    YES → post spawn announcement to topic
    NO  → silent (no Telegram message)

PostToolUse fires while subagent is active
    ↓
callbacks.onToolUse (index.ts)
    ↓
config.subagentOutput === 'hide' AND subagentTracker.isSubagentActive()?
    YES → increment tool count only, skip Telegram display
    NO  → display with [AgentName] prefix (existing behavior)

TranscriptWatcher.onSidechainMessage fires
    ↓
config.subagentOutput === 'hide' → return (no post)

SubagentStop hook fires
    ↓
subagentTracker.stop(agentId) [always -- for lifecycle cleanup]
    ↓
config.subagentOutput === 'show'?
    YES → post done announcement
    NO  → silent
```

### Sticky Message Dedup Flow

```
initMonitoring(session) called (new session, resume, or restart)
    ↓
session.statusMessageId === 0?
    YES (new session): statusMsg.initialize() → send + pin → updateStatusMessageId()
    NO (resume/restart): statusMsg.initialize(session.statusMessageId)
                          → adopt existing messageId, request content update
                          → no new message sent, no new pin
```

### Settings Topic Flow

```
Bot startup:
    settingsStore.load() → read data/settings.json
    → find settingsTopicId
    if missing: topicManager.createTopic('Settings') → store threadId
    → runtimeSettings.load(savedSettings) [override env defaults]

User sends "/subagents hide" in settings topic:
    bot.on('message:text')
    → ctx.message.message_thread_id === settingsTopicId?
    → YES: SettingsTopic.handleCommand(text)
    → parse: key='subagentOutput', value='hide'
    → runtimeSettings.subagentOutput = 'hide'
    → settingsStore.save()
    → ctx.reply("Sub-agent output: hidden")
```

---

## Recommended Project Structure Changes

```
src/
├── bot/
│   ├── bot.ts             # MODIFY: route settings topic messages
│   ├── topics.ts          # MODIFY: setTopicStatus() + topicStatusCache
│   └── ... (unchanged)
├── monitoring/
│   ├── status-message.ts  # MODIFY: initialize(existingMessageId?)
│   └── ... (unchanged)
├── sessions/
│   └── session-store.ts   # MODIFY: updateTopicStatus() method
├── settings/              # NEW directory
│   ├── settings-store.ts  # NEW: JSON persistence for settings
│   ├── settings-topic.ts  # NEW: topic lifecycle + command parsing
│   └── runtime-settings.ts # NEW: mutable config object
├── types/
│   ├── config.ts          # MODIFY: add subagentOutput field
│   └── sessions.ts        # MODIFY: add topicStatus field
├── config.ts              # MODIFY: parse SUBAGENT_OUTPUT env var
└── index.ts               # MODIFY: status wiring + startup cleanup + settings init
```

---

## Build Order (Dependency-Aware)

### Phase 1: Color-Coded Status Indicators (standalone, high impact)

**Dependencies:** None -- pure extension of existing `TopicManager.editTopicName()` pattern.

```
1a. types/sessions.ts — add TopicStatus type + topicStatus field
1b. sessions/session-store.ts — add updateTopicStatus() method
1c. bot/topics.ts — add setTopicStatus() with cache dedup
1d. index.ts — wire status updates on PostToolUse, SubagentStart, Stop, SessionEnd
1e. index.ts — add startup gray-out loop before bot.start()
```

### Phase 2: Sub-Agent Suppression (standalone, config-gated)

**Dependencies:** None -- gates existing behavior on new config key.

```
2a. types/config.ts — add subagentOutput field
2b. src/config.ts — parse SUBAGENT_OUTPUT env var
2c. index.ts — gate onSubagentStart / onSubagentStop / sidechain / tool display
```

### Phase 3: Sticky Message Deduplication (depends on understanding Phase 1 status flow)

**Dependencies:** Phase 1 (understand session lifecycle changes before touching StatusMessage).

```
3a. monitoring/status-message.ts — initialize(existingMessageId?) overload
3b. index.ts — pass session.statusMessageId to initMonitoring on resume/restart
```

### Phase 4: Settings Topic (most independent, but complex)

**Dependencies:** Phase 2 (settings topic will expose the subagentOutput setting; better to build Phase 2 first).

```
4a. settings/runtime-settings.ts — mutable config class
4b. settings/settings-store.ts — JSON persistence
4c. settings/settings-topic.ts — topic lifecycle + command handlers
4d. types/config.ts — add settingsTopicId to persisted settings
4e. index.ts — initialize SettingsTopic on startup
4f. bot/bot.ts — route settings topic messages
```

**Build order rationale:**

- Phase 1 first: Standalone, immediately visible improvement. No risk to existing behavior -- only adds new `editForumTopic` calls on existing lifecycle events.
- Phase 2 second: Config-only gate, no structural changes. Quick win to reduce noise.
- Phase 3 third: Touches `StatusMessage.initialize()` which is called during session start. After Phase 1 stabilizes session lifecycle understanding, Phase 3 is low-risk.
- Phase 4 last: Most structural (new directory, new classes, new message routing path). Benefits from Phase 2 being done (settings topic can expose and toggle the subagent setting).

---

## Integration Points Summary

### Modified `TopicManager` Interface

| Method | Change | Notes |
|--------|--------|-------|
| `setTopicStatus(threadId, topicName, status)` | NEW | In-memory dedup via topicStatusCache |
| `createTopic(name)` | Unchanged | Still prefixes with `🟢` |
| `closeTopic(threadId, topicName)` | MODIFY | Use `⬜` prefix instead of `✅`, consistent with status machine |

### Modified `StatusMessage` Interface

| Method | Change | Notes |
|--------|--------|-------|
| `initialize(existingMessageId?)` | MODIFY | If existingMessageId > 0, adopt instead of sending new |

### New `RuntimeSettings` Read Paths

Components that need to read `subagentOutput` or `defaultVerbosity` at runtime must read from `RuntimeSettings`, not `AppConfig`. This impacts:

- `index.ts` callbacks (`onSubagentStart`, `onSubagentStop`, `onToolUse`, `onSidechainMessage`)
- `index.ts` `initMonitoring()` (uses `defaultVerbosity` for new sessions)

### New Message Routing in `bot.ts`

```typescript
bot.on('message:text', async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  if (!threadId) return next();

  // Priority 1: Settings topic
  if (threadId === runtimeSettings.settingsTopicId) {
    return settingsTopic.handleCommand(ctx);
  }

  // Priority 2: Session routing (existing behavior)
  const session = sessionStore.getByThreadId(threadId);
  ...
});
```

---

## Anti-Patterns

### Anti-Pattern 1: Calling editForumTopic on Every Tool Call

**What people do:** Call `editForumTopic` with `'busy'` on every PostToolUse event.
**Why it's wrong:** Telegram rate-limits `editForumTopic`. Rapid tool calls (10+ per second) flood the API. "Already modified" errors appear.
**Do this instead:** Track current topic status in-memory (`topicStatusCache`). Only call `editForumTopic` when status actually changes (ready → busy, busy → ready).

### Anti-Pattern 2: Recreating StatusMessage on Resume

**What people do:** Always call `statusMsg.initialize()` which sends + pins a new message, even when the session already has a pinned status message from a previous run.
**Why it's wrong:** Creates duplicate pinned messages on resume/restart. Telegram only shows one pin at a time but the old ones clutter the topic.
**Do this instead:** Check `session.statusMessageId > 0` before initialization; adopt existing message ID.

### Anti-Pattern 3: Changing icon_color After Topic Creation

**What people do:** Try to change topic `icon_color` to reflect status (red circle, green circle via API field).
**Why it's wrong:** `icon_color` is only settable at topic creation time. `editForumTopic` does NOT accept `icon_color`.
**Do this instead:** Use unicode circle emoji prefixes in the topic name (`🟢`, `🟡`, `🔴`, `⬜`). This is the only way to change the visible "color" of a topic after creation.

### Anti-Pattern 4: Stopping SubagentTracker Tracking When Suppressing Output

**What people do:** When `subagentOutput === 'hide'`, skip `subagentTracker.start()` to save memory.
**Why it's wrong:** The tracker is needed to correctly gate PostToolUse display. Without `start()`, `isSubagentActive()` returns false and subagent tool calls leak into main-chain display.
**Do this instead:** Always call `subagentTracker.start()` and `stop()`. Only skip the Telegram message posting.

### Anti-Pattern 5: Storing Settings in AppConfig

**What people do:** Modify `AppConfig` fields at runtime when the user changes a setting.
**Why it's wrong:** `AppConfig` is loaded once from env at startup. Mutating it makes the codebase confusing (env var says one thing, runtime says another). TypeScript may prevent mutation if fields are `readonly`.
**Do this instead:** Introduce a separate `RuntimeSettings` object for mutable settings. `AppConfig` stays immutable (env-derived values). `RuntimeSettings` is initialized from env defaults but can be overridden at runtime by the settings topic.

---

## Scaling Considerations

| Concern | Current (2-3 sessions) | At 10 sessions | Notes |
|---------|------------------------|-----------------|-------|
| `editForumTopic` rate on busy | 1-2 actual calls per tool burst (dedup) | 5-10 calls per concurrent busy sessions | grammY apiThrottler handles queueing |
| Startup gray-out loop | 2-3 API calls at boot | 10 API calls at boot | Fire-and-forget, non-blocking |
| topicStatusCache memory | 3 entries | 10 entries | Negligible |
| SettingsStore JSON | ~200 bytes | Same (global, not per-session) | Negligible |
| RuntimeSettings reads | Per hook event | Per hook event | In-process reads, negligible cost |

No scaling concerns for target scale (2-3 machines, 2-3 sessions each).

---

## Sources

- Telegram Bot API -- `createForumTopic`, `editForumTopic`: `icon_color` only settable at creation, `icon_custom_emoji_id` editable post-creation (HIGH confidence, verified from multiple official sources)
- Telegram Bot API -- `editForumTopic` parameters: only `name` and `icon_custom_emoji_id` are accepted (not `icon_color`) (HIGH confidence)
- Telegram `createForumTopic` icon_color valid values: 7322096 (#6FB9F0), 16766590 (#FFD67E), 13338331 (#CB86DB), 9367192 (#8EEE98), 16749490 (#FF93B2), 16478047 (#FB6F5F) (MEDIUM confidence, inferred from python-telegram-bot docs + API search results)
- Existing codebase (`TopicManager` in `src/bot/topics.ts`): confirms current emoji-prefix pattern for topic naming (HIGH confidence, direct code analysis)
- Existing codebase (`StatusMessage` in `src/monitoring/status-message.ts`): confirms debounce is already implemented for `editMessageText`; same pattern needed for `editForumTopic` (HIGH confidence)
- Existing codebase (`SubagentTracker` in `src/monitoring/subagent-tracker.ts`): pure in-memory state, no Telegram deps -- safe to always run regardless of display config (HIGH confidence)
- grammY `apiThrottler` plugin: handles rate limit queueing at API layer; `editForumTopic` calls go through same throttler (HIGH confidence, existing codebase + grammY docs)

---
*Architecture research for: Claude Code Telegram Bridge v4.0 Status & Settings*
*Researched: 2026-03-02*
