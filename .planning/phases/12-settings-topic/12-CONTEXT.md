# Phase 12: Settings Topic - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Create a dedicated "Settings" topic in the Telegram group with inline keyboard toggle buttons for sub-agent visibility and permission mode. Settings persist across restarts and take effect immediately. Only the bot owner can modify settings. Does NOT include per-session overrides or additional settings beyond sub-agent visibility and permission mode (deferred).

</domain>

<decisions>
## Implementation Decisions

### Settings UI design
- Single pinned message in the Settings topic showing all settings with inline keyboard buttons below
- Message is edited in-place when any toggle is tapped — no new messages per change
- Format: each setting on its own line with current value, keyboard buttons below
- Example layout:
  ```
  ⚙️ Settings

  Sub-agents: 🔴 Hidden
  Default permission mode: Manual

  [Toggle Sub-agents]
  [Manual] [Safe Only] [Accept All] [Until Done]
  ```
- After toggle: message updates immediately showing new state
- Tap confirmation via `answerCallbackQuery()` (dismiss spinner)

### Settings available (v4.0 scope)
- **Sub-agent visibility**: Toggle on/off (maps to `config.subagentOutput`)
- **Default permission mode**: Select one of Manual / Safe Only / Accept All / Until Done
  - Sets the default mode for NEW sessions — does not change active sessions
  - Active sessions keep their current per-session mode from the approval flow
  - "Same Tool" is not available as a default (requires a tool name context)

### Settings topic lifecycle
- Created at bot startup if it doesn't already exist
- `settingsTopicId` persisted in `data/bot-state.json` (separate from sessions.json)
- On startup: check if `settingsTopicId` exists in bot-state → reopen and reuse; if not → create new
- Topic name: "⚙️ Settings" (no status color prefix — not a session topic)
- Settings message is pinned in the topic
- If the topic was deleted by a user, detect the error on reopen and re-create

### RuntimeSettings (mutable config layer)
- New `RuntimeSettings` object separate from immutable `AppConfig`
- Initialized from `AppConfig` defaults at startup (env values are the initial state)
- Mutated by settings topic button handlers
- Read by hook callbacks in `index.ts` instead of `config.subagentOutput` directly
- Persisted to `data/bot-state.json` on every change (atomic write)
- Loaded from `bot-state.json` on startup (overrides env defaults if file exists)

### Auth guard
- New optional env var: `BOT_OWNER_ID` (Telegram user ID number)
- If set: only this user's callback taps are accepted; others get `answerCallbackQuery({ show_alert: true, text: "Only the bot owner can change settings" })`
- If not set: any group member can change settings (single-user system — the group is private)
- Auth check applied to all settings callback handlers

### Message routing
- Settings topic `threadId` checked BEFORE session lookup in the text handler
- Text messages in settings topic are ignored (no session to route to)
- Only callback queries from settings keyboard buttons are processed
- Settings callback handlers registered with distinct prefixes (e.g., `set_sa:`, `set_pm:`)

### Persistence (bot-state.json)
- Separate file from sessions.json — different concern
- Contains: `settingsTopicId`, `settingsMessageId`, `subagentOutput`, `defaultPermissionMode`
- Same atomic write pattern as SessionStore (write .tmp, rename)
- New `BotStateStore` class following `SessionStore` pattern

### Claude's Discretion
- Exact callback data prefix naming convention
- Whether to use emoji indicators (🟢/🔴) or text (ON/OFF) for toggle states
- Error recovery when settings topic or message is deleted
- Whether RuntimeSettings is a class or a plain object + functions
- Whether BotStateStore and SettingsStore are one class or two

</decisions>

<specifics>
## Specific Ideas

- User's original words: "Make the settings configurable from telegram in a separate settings topic"
- The settings topic is permanent — it persists across bot restarts, unlike session topics
- This is the foundational infrastructure for future settings (v5+ could add summary interval, verbosity, etc.)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `bot.callbackQuery()` pattern: 8 existing handlers with regex matching — proven pattern for settings buttons
- `InlineKeyboard` from grammY: already used for approval buttons, expand/collapse, stop button
- `SessionStore` (`src/sessions/session-store.ts`): Atomic JSON persistence pattern — reuse for BotStateStore
- `TopicManager.createTopic()` / `reopenTopic()`: Topic lifecycle management
- `ctx.editMessageText()`: In-place message editing — used for settings toggle feedback

### Established Patterns
- Callback data format: short prefix + colon + identifier (e.g., `approve:uuid`, `exp:123`, `stop:123`)
- Error handling: "message is not modified" errors caught and ignored
- `answerCallbackQuery({ show_alert: true })` for error feedback to user
- `config.telegramChatId` used as implicit group-level auth

### Integration Points
1. **`createBot()`** (bot.ts): Needs new params for RuntimeSettings + BotStateStore; add settings callback handlers
2. **`main()`** (index.ts): Initialize BotStateStore, load state, create settings topic, pass to createBot
3. **Text handler** (bot.ts line 316): Add early return for settings topic threadId (before session lookup)
4. **`config.subagentOutput`** references (index.ts, 5 call sites): Change to read from RuntimeSettings instead
5. **Startup** (index.ts): Create/reopen settings topic, send/pin settings message, persist IDs

### New files needed
- `src/settings/bot-state-store.ts`: Atomic JSON persistence for bot-level state
- `src/settings/runtime-settings.ts`: Mutable config object
- `src/settings/settings-topic.ts`: Settings topic lifecycle + keyboard builder + message formatter

</code_context>

<deferred>
## Deferred Ideas

- Per-session sub-agent visibility override (`/agents` command in session topics) — v5+
- Summary interval configuration in settings — v5+
- Output verbosity control in settings — v5+

</deferred>

---

*Phase: 12-settings-topic*
*Context gathered: 2026-03-02*
