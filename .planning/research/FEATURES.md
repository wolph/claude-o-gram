# Feature Research: v4.0 Status & Settings

**Domain:** Telegram bot bridge — status/settings UX layer on existing Claude Code session management
**Researched:** 2026-03-02
**Confidence:** HIGH (all four features verified against existing codebase + Telegram Bot API docs)

---

## Context: What Already Exists

This is a subsequent milestone layered onto a fully-built system. The foundation is:

- Per-session Telegram forum topics with emoji-prefix naming (`createTopic` prefixes `\u{1F7E2}`, `closeTopic` sets `\u2705 (done)`)
- Pinned status message per topic (edited in place, debounced 3s, deduplication via `lastSentText` but only in `flush()` not `initialize()`)
- Sub-agent spawn/done announcements with `[AgentName]` prefixes and full output forwarding (v3.0 default is "show everything")
- Config loaded from `.env` only — no runtime config mutation
- `StatusMessage` class owns topic name management via `updateTopicDescription()`
- `SessionStore.getAllSessions()` provides access to all sessions for startup reconciliation

The four target features are: (1) color-coded topic status, (2) sub-agent silence by default, (3) sticky message deduplication, (4) settings topic.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features the project target user expects once the scope is defined. Missing these makes the milestone feel incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Topic name reflects current status via emoji prefix | Existing `createTopic` and `closeTopic` already use emoji prefixes. Users see `\u{1F7E2} project` and `\u2705 project (done)`. Extending to gray (offline) is the logical completion of the pattern. | LOW | `editForumTopic` supports name changes freely at any time. The critical constraint: `icon_color` is **set only at createForumTopic and cannot be changed via editForumTopic** (confirmed Telegram Bot API). Status via emoji-in-name is the only viable dynamic approach. |
| Startup cleanup of stale topics | Bot restart leaves old topics showing green when sessions may be dead. Users expect restart to reconcile state so the topic list is not misleading. | LOW | Iterate `getAllSessions()` on startup, call `editTopicName()` to set gray prefix on all non-active-session topics. Simple loop in startup sequence after bot.start(). |
| Sub-agent silence as default | Sub-agents generate significant output volume. v3.0 shipped "show everything" — power users appreciated it, but for typical use the spawn/done announcements and forwarded output are overwhelming. Silence-by-default is expected for a UX refinement milestone. | LOW | SubagentTracker already tracks active agents. Suppression is a config flag checked in `onSubagentStart`, `onSubagentStop`, and the transcript watcher's `onSidechainMessage` callback. Three call sites to gate. |
| Sticky dedup prevents duplicate pinned messages on /clear | On `/clear`, `initMonitoring` creates a new `StatusMessage` which calls `initialize()` — this sends and pins a new status message even when the topic already has a pinned status from the previous session. Creates clutter: two "Starting..." messages pinned. | LOW | Before `sendMessage` in `StatusMessage.initialize()`, check whether a prior `statusMessageId` is passed in. If `statusMessageId > 0` and the formatted content matches what would be sent, reuse the existing message instead of creating a new one. |

### Differentiators (Competitive Advantage)

Features that make this bot distinctly better than alternatives.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Settings topic — runtime config without restart | Current system requires `.env` edits + bot restart to change verbosity, sub-agent visibility, or summary interval. A dedicated Telegram topic for bot settings lets the user tweak behavior from mobile without touching the server. | MEDIUM | Requires: (1) a fixed "settings" topic persisted separately from `sessions.json`, (2) command handlers scoped to that topic thread, (3) runtime config override layer (not `.env` mutation), (4) display of current config on demand via inline buttons. |
| Color-coded status visible at a glance in topic list | Forum topic list shows topic names, so emoji prefixes in the name provide at-a-glance session health without opening any topic. Current state: only green (active) and checkmark (done). Missing: gray (down/offline), and optionally yellow (busy) and red (error). | LOW | Purely achieved via topic name edits. No new Telegram API surface. 4 states: green=active/ready, done=checkmark (already exists), gray=down/offline, optional yellow=busy tool running, optional red=dangerous approval pending. |
| Per-session sub-agent visibility toggle | Allows users to selectively enable verbose agent output for sessions where they care about agent activity, while keeping others quiet. Complements global default. | LOW | Add `subagentVisibility: 'silent' \| 'verbose'` to `SessionInfo`. Bot command `/agents` in the session topic toggles it. Default inherits from config setting. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| `icon_color` change for topic background | Color-coded topic background tab would be visually clearer than emoji prefix in the name | `icon_color` is set only at `createForumTopic` and **cannot be changed** via `editForumTopic` (confirmed Telegram Bot API docs and MTProto docs). Changing color requires deleting and recreating the topic, losing all message history. Not viable. | Emoji prefix in topic name — established pattern, visible in topic list, works with `editForumTopic`, zero API constraints. |
| Full settings UI mirroring all .env options | Power users want to control every setting from Telegram | Creates two sources of truth (.env + runtime state), complicates restart behavior (which wins?), could expose infrastructure settings (hook port, data dir) to group members. | Expose only UX-behavioral settings (verbosity, sub-agent visibility, summary interval). Infrastructure settings stay in `.env` permanently. |
| Sub-agent topics (separate forum topic per agent) | "Each agent gets its own thread for isolation" | Telegram supergroup topics are expensive API-wise; sub-agent lifetimes are short (seconds to minutes); creating and closing topics rapidly hits rate limits; the topic list becomes cluttered for multi-agent sessions. | Sub-agent output stays in the parent session's topic with `[AgentName]` prefix and configurable suppression. Already the v3.0 design. |
| Real-time busy indicator updated per tool call | Yellow topic name = "something is running" on every tool event | `editForumTopic` is rate-limited. Firing per-tool (which can be every 1-2 seconds during active sessions) will hit flood limits. The existing `StatusMessage` at 3s debounce already occasionally gets rate-limited. | Update topic status only at state transitions: session-start (green), session-end (done/gray). Not per-tool. If yellow/red are added, only trigger on significant state changes (approval pending, session end). |
| Settings stored in Telegram messages | "Persist settings as a formatted message in the settings topic" | Telegram messages are not a reliable data store. Messages can be deleted by users, the API for reading message history is complex, and the bot cannot trust message content as ground truth. | Persist runtime settings to disk alongside `sessions.json`. Use the settings topic only for display and interaction, not as the store. |

---

## Feature Dependencies

```
[Color-coded topic names: green/gray]
    └──depends-on──> [TopicManager.editTopicName() — already exists]
    └──enables──> [Startup cleanup (gray on boot)]

[Startup cleanup (gray on boot)]
    └──requires──> [Color-coded topic name system (gray state must be defined)]
    └──depends-on──> [SessionStore.getAllSessions() — already exists]

[Sub-agent silence by default]
    └──depends-on──> [SubagentTracker — already exists]
    └──enhances──> [Settings topic] (can expose visibility toggle there as a button)

[Sticky dedup]
    └──depends-on──> [StatusMessage.initialize() — already exists]
    └──requires──> [statusMessageId passed in or checked before send]
    └──independent of all other v4.0 features]

[Settings topic]
    └──requires──> [Runtime config override layer (SettingsStore)]
    └──requires──> [Persistent settings topic thread ID (separate from sessions.json)]
    └──requires──> [Bot command handlers scoped to settings topic thread]
    └──enhances──> [Sub-agent silence] (exposes visibility toggle)
    └──enhances──> [Color-coded status] (could show status legend)

[Per-session /agents toggle]
    └──requires──> [Sub-agent silence by default (the flag must exist first)]
    └──independent of settings topic (can be a simple in-topic command)]
```

### Dependency Notes

- **Color-coded topic names must be defined before startup cleanup.** The startup cleanup needs to know what "gray" looks like. Both are so small they can be done in one phase.
- **Settings topic requires runtime config mutations.** A settings topic that can't actually change anything is a no-op. The SettingsStore must be built before the settings topic UI is built.
- **Sticky dedup is fully independent.** It is a fix to `StatusMessage.initialize()` with no coupling to other features. Can be done in any phase or as a standalone fix.
- **Sub-agent silence is independent of settings topic.** The config flag can start as a static config value and later be surfaced in the settings topic. Decouple these — don't block silence-by-default on settings topic completion.

---

## MVP Definition

This is a subsequent milestone (v4.0), not a green-field product.

### Launch With (v4.0)

Minimum to call the milestone done.

- [ ] **Color-coded topic names** — gray (offline/down) state added to complement existing green (active) and checkmark (done). Topic name prefix updated on session start and at startup cleanup.
- [ ] **Startup cleanup** — on bot start, set all topics for non-active sessions to gray. One startup loop.
- [ ] **Sub-agent silence by default** — `showSubagents: boolean` in config (default `false`). Gates `onSubagentStart`, `onSubagentStop`, `onSidechainMessage` at three call sites.
- [ ] **Sticky message deduplication** — `StatusMessage.initialize()` accepts optional `existingMessageId`; if provided and content would be identical, reuse it. Prevents duplicate pin on `/clear`.

### Add After Validation (v4.x)

- [ ] **Settings topic** — dedicated topic for runtime config changes, triggered when users find `.env` editing too painful for day-to-day changes.
- [ ] **Per-session sub-agent visibility toggle** (`/agents` command in session topic) — triggered when users want verbose output for specific sessions without changing global default.

### Future Consideration (v5+)

- [ ] **Yellow (busy) topic status** — update topic name to yellow while a tool is running. Gated on confirming the rate limit safety of `editForumTopic` on state transitions without per-tool updates.
- [ ] **Red (error/approval-pending) topic status** — set red when a dangerous approval is pending, green when resolved. Requires tracking "approval pending" as a topic-level state.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Color-coded topic names (green/gray) | HIGH — visible status from topic list | LOW — name edit on session-start and startup | P1 |
| Startup cleanup (gray on boot) | HIGH — eliminates stale-green confusion | LOW — startup loop + gray prefix | P1 |
| Sub-agent silence by default | HIGH — reduces noise, aligns with expected default | LOW — config flag + 3 conditional gates | P1 |
| Sticky dedup | MEDIUM — prevents clutter on /clear, no functional impact | LOW — guard in initialize() | P1 |
| Settings topic | MEDIUM — convenience without SSH for config changes | MEDIUM — SettingsStore + topic lifecycle + commands | P2 |
| Per-session agent toggle (/agents) | LOW — power user feature, most want global default | LOW — SessionInfo flag + one command handler | P2 |
| Yellow busy state | LOW — status message already shows current tool | MEDIUM — rate limit risk if updated per-tool | P3 |
| Red approval-pending state | MEDIUM — missed approvals are a real problem | MEDIUM — requires approval state at topic level | P3 |

**Priority key:**
- P1: Must have for v4.0 milestone completion
- P2: Should have, add when P1 is validated
- P3: Nice to have, defer to v5+

---

## Dependency on Existing Infrastructure

| New Feature | Existing Code It Builds On | What Needs Adding |
|-------------|---------------------------|-------------------|
| Color-coded topic names | `TopicManager.createTopic()`, `closeTopic()`, `editTopicName()`, `reopenTopic()` | Extract `StatusPrefix` enum/constants; update all name-setting calls to use consistent prefix |
| Startup cleanup | `SessionStore.getAllSessions()`, `TopicManager.editTopicName()` | Loop after bot.start() in `main()` |
| Sub-agent silence | `SubagentTracker`, `onSubagentStart` handler, `onSubagentStop` handler, transcript watcher `onSidechainMessage` | `config.showSubagents: boolean` (default false); 3 conditional gates |
| Sticky dedup | `StatusMessage.initialize()`, `sessionStore.updateStatusMessageId()` | `initialize(existingMessageId?: number)` parameter; content comparison guard |
| Settings topic | `SessionStore`, `TopicManager`, `bot.ts` handler registration, `loadConfig()` | `SettingsStore` class, settings topic thread ID persistence, per-setting command handlers or inline keyboard |

---

## Key Technical Constraints

| Constraint | Impact on v4.0 |
|-----------|----------------|
| `icon_color` is immutable after `createForumTopic` | Color-coded status MUST use emoji-in-name approach; icon background color is not an option |
| `editForumTopic` supports `name` and `icon_custom_emoji_id` only | Using custom emoji sticker for status is possible but requires calling `getForumTopicIconStickers` first and managing sticker IDs — adds complexity. Emoji-in-name is simpler and sufficient. |
| `editForumTopic` is rate-limited | Status updates must be on state transitions only, never per-tool-call. Startup cleanup loop should add small delays between calls for large session counts. |
| Telegram topic name max 128 chars | Already handled in `TopicManager.editTopicName()`. Gray prefix `\u26AB` + name must stay under 128 chars. |
| `sessions.json` is the only persistent store | Settings topic thread ID must be stored somewhere. Either extend `sessions.json` with a "settings" key or create a separate `settings.json`. Separate file is cleaner. |

---

## Sources

- Telegram Bot API `createForumTopic` docs — `icon_color` allowed values: 7322096, 16766590, 13338331, 9367192, 16749490, 16478047. Confirmed via [aiogram docs](https://docs.aiogram.dev/en/latest/api/methods/create_forum_topic.html)
- Telegram Bot API `editForumTopic` — `icon_color` NOT available in edit call, confirmed via MTProto `channels.editForumTopic` docs and multiple framework docs
- Codebase audit (2026-03-02): `src/bot/topics.ts`, `src/monitoring/status-message.ts`, `src/monitoring/subagent-tracker.ts`, `src/index.ts`, `src/sessions/session-store.ts`, `src/types/sessions.ts`, `src/config.ts`, `src/types/config.ts`

---

*Feature research for: Claude Code Telegram Bridge v4.0 Status & Settings*
*Researched: 2026-03-02*

---

## Archived: v3.0 UX Overhaul Feature Research (2026-03-01)

<details>
<summary>Click to expand v3.0 research (shipped milestone, kept for reference)</summary>

**Domain:** Telegram bot UX for Claude Code monitoring and control
**Researched:** 2026-03-01
**Confidence:** HIGH

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Dependencies |
|---------|--------------|------------|-------------|
| **Compact tool output** | Terminal shows `Read(file)` not multi-line blocks. | MEDIUM | Existing `formatter.ts`, `verbosity.ts` |
| **Remove bot commentary** | Terminal has no emoji spam or narration filtering. | LOW | `isProceduralNarration()`, `formatSessionStart()` |
| **No permission timeout** | Current 5-min auto-deny is hostile for remote users. | LOW | `ApprovalManager` timeout setting |
| **/clear reuses topic** | Without this, /clear creates a new topic, cluttering the group. | MEDIUM | `handleSessionStart()` `source` field handling |

### Differentiators

| Feature | Value Proposition | Complexity | Dependencies |
|---------|-------------------|------------|-------------|
| **Expand/collapse inline buttons** | Terminal can't do this. Tap to see full content on demand. | MEDIUM | `editMessageText` + `InlineKeyboard` callbacks |
| **Permission modes** | Session-scoped graduated acceptance modes. | HIGH | New `PermissionModeManager` class |
| **Subagent visibility with agent identity** | Show subagent starts, stops, tool calls with labels. | HIGH | New `SubagentStart`/`SubagentStop` hook handlers |
| **Local permission visibility (stdout)** | Print auto-accepted permissions to local stdout. | LOW | `console.log` in permission mode handler |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Streaming tool output** | Real-time bash output | Telegram rate limits make constant edits infeasible | Post final output after tool completes |
| **Per-subagent Telegram topics** | Agent isolation | Ephemeral agents create massive topic clutter | Label messages with agent identity prefix |
| **Nested inline keyboards** | Deep navigation | 64-byte callback_data limit, rate limits on edits | Single-level expand/collapse only |
| **Multi-user approval** | Team voting | Single-user system by design | One user approves/denies |

</details>
