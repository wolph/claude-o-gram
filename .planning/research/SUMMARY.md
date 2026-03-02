# Project Research Summary

**Project:** Claude Code Telegram Bridge v4.0 — Status & Settings
**Domain:** Telegram bot UX layer — status indicators, sub-agent suppression, sticky message deduplication, interactive settings topic
**Researched:** 2026-03-02
**Confidence:** HIGH

## Executive Summary

This is a subsequent milestone layered onto a fully operational v3.0 system. The v4.0 work is exclusively application-level UX polish — no new infrastructure, no new npm dependencies, no new Telegram API surfaces beyond what the existing codebase already uses. All four target features (color-coded topic status, sub-agent suppression, sticky message deduplication, settings topic) are achievable with the current stack: grammY 1.41.0, existing `InlineKeyboard` + callback patterns, the `TopicManager.editForumTopic` call already in use, and the atomic JSON write pattern from `SessionStore`.

The recommended approach is to build in strict dependency order. Color-coded status and sub-agent suppression are fully standalone and should ship first — both are low-risk config extensions of existing code paths. Sticky message deduplication is a targeted fix to `StatusMessage.initialize()` that requires understanding the session lifecycle stabilized in Phase 1. The settings topic is the most structurally significant feature: it introduces a new `RuntimeSettings` object (separating mutable runtime config from immutable env config), a new `settings/` module directory, and a new message routing priority in `bot.ts`. Building it last means the settings topic can immediately surface the sub-agent visibility toggle implemented in Phase 2.

The dominant risk across all four features is misuse of the Telegram `editForumTopic` API. `icon_color` cannot be changed after topic creation (confirmed against Telegram MTProto docs, aiogram, and python-telegram-bot) — the emoji-prefix-in-topic-name approach already used in the codebase is the only correct dynamic status mechanism. A secondary risk is calling `editForumTopic` too frequently: two independent code paths already exist that call this method per-topic (`StatusMessage.updateTopicDescription` and the new status indicator), and they must be consolidated into a single debounced path or the bot will produce a cascade of undocumented 429s. Both of these constraints have clear, well-defined solutions documented in research.

## Key Findings

### Recommended Stack

All v4.0 features are implementable with the existing dependency set. No new npm packages are required. The existing grammY `InlineKeyboard` + `bot.callbackQuery()` pattern (already used in 8+ handlers) handles the settings topic toggle UI. The existing `SessionStore` atomic JSON write pattern (write to `.tmp`, rename) is the correct persistence approach for the new `SettingsStore` and `bot-state.json`. The `transformer-throttler` and `auto-retry` plugins already active cover rate limit handling for the startup gray sweep.

Three new source files are needed — `src/types/topic-status.ts`, `src/settings/settings-store.ts`, and `src/settings/settings-topic.ts` — plus a new `src/settings/runtime-settings.ts` to hold the mutable config layer. Eight existing files require modification. One new environment variable (`SUBAGENT_VISIBLE`, default `false`) is added.

**Core technologies (no changes):**
- **grammY 1.41.0** — Telegram bot framework — all needed API methods present; `editForumTopic(name)` is the only method required for status updates
- **@grammyjs/transformer-throttler + auto-retry** — rate limit handling — already active; handles startup gray sweep queue
- **TypeScript 5.x** — language — all new modules follow existing patterns
- **Fastify 5.x + @anthropic-ai/claude-agent-sdk** — hook server and SDK input — unchanged
- **lru-cache** — expand/collapse cache — unchanged

**New modules (no new npm packages):**
- `src/types/topic-status.ts` — `TopicStatus` type + `STATUS_EMOJI` map (~15 lines)
- `src/settings/settings-store.ts` — atomic JSON persistence for bot settings (~80 lines)
- `src/settings/settings-topic.ts` — settings topic lifecycle, command parsing, keyboard builder
- `src/settings/runtime-settings.ts` — mutable config object separate from immutable `AppConfig`

### Expected Features

The FEATURES.md research treats this milestone as a UX refinement pass on a shipped system. The four P1 features are table stakes for the milestone to feel complete; the P2 features are validated additions once P1 is stable.

**Must have for v4.0 (P1):**
- **Color-coded topic names (green/gray)** — gray offline state added to complement existing green active and checkmark done; emoji prefix in topic name is the only viable dynamic mechanism
- **Startup cleanup** — on bot start, set all active-session topics to gray; prevents stale-green confusion after restart
- **Sub-agent silence by default** — `SUBAGENT_VISIBLE=false` env default; gates three call sites (`onSubagentStart`, `onSubagentStop`, `onSidechainMessage`); tracker state maintained unconditionally
- **Sticky message deduplication** — `StatusMessage.initialize()` accepts optional `existingMessageId`; prevents duplicate pins on `/clear` and restart

**Should have after P1 validation (P2):**
- **Settings topic** — dedicated Telegram topic for runtime config changes without `.env` edits or bot restart; exposes sub-agent visibility toggle via inline keyboard
- **Per-session sub-agent visibility toggle** (`/agents` in session topic) — power user override of global default

**Defer to v5+ (P3):**
- **Yellow (busy) topic status** — rate limit risk if updated per-tool; gated on confirming safe `editForumTopic` call frequency at scale
- **Red (approval-pending) topic status** — requires tracking approval state at topic level; scope beyond v4.0

**Anti-features to avoid:**
- `icon_color` manipulation — not editable post-creation (Telegram API hard constraint)
- Per-session forum topic per sub-agent — topic list clutter, rate limit cascade
- Settings stored in Telegram messages — unreliable, unreadable by bot

### Architecture Approach

The v3.0 architecture is a clean three-layer system: Claude Code process (hooks + JSONL transcript) feeds a Fastify hook server, which wires into an `index.ts` orchestration layer, which drives the Telegram layer (grammY bot, TopicManager, MessageBatcher, StatusMessage). V4.0 extends each layer minimally. The key structural addition is a new `settings/` module directory with three classes (`RuntimeSettings`, `SettingsStore`, `SettingsTopic`) that together introduce a mutable config layer sitting between `AppConfig` (env-derived, immutable) and the live hook handlers. Message routing in `bot.ts` gains a priority check: settings topic messages are intercepted before session routing.

The critical architectural constraint is that all `editForumTopic` calls for a given topic must flow through a single debounced code path. The existing `StatusMessage.updateTopicDescription()` method is the correct consolidation point — status icon updates should extend this method, not create a parallel call path.

**Major components:**
1. **TopicManager (modified)** — gains `setTopicStatus(threadId, name, status)` with in-memory `topicStatusCache` dedup; one consolidated `editForumTopic` call path per topic
2. **StatusMessage (modified)** — `initialize(existingMessageId?)` overload; adopt existing message ID on resume instead of always creating a new pinned message
3. **RuntimeSettings (new)** — mutable config object initialized from env defaults, overridable at runtime by SettingsTopic; read by `index.ts` hook handlers instead of immutable `AppConfig`
4. **SettingsStore (new)** — atomic JSON persistence for `bot-state.json`; stores `settingsTopicId`, `subagentOutput`, `defaultVerbosity`, `summaryIntervalMs`
5. **SettingsTopic (new)** — singleton topic lifecycle (create-once, persist threadId); `InlineKeyboard` toggle buttons; command handler routing; bot owner auth guard on callbacks
6. **index.ts (modified)** — startup gray sweep (sequential, active sessions only); subagent output gate at three call sites; pass `statusMessageId` to `initMonitoring` on resume

### Critical Pitfalls

1. **`editForumTopic` with `icon_color` (silent no-op)** — `icon_color` is only settable at `createForumTopic` time. Use unicode circle emoji prefix in the topic name (`🟢/🟡/🔴/⬜`). This is already the correct pattern in the codebase — extend it, do not attempt to use the API `icon_color` field.

2. **Sub-agent suppression skipping `SubagentTracker.start()/stop()` calls** — Suppression must operate at the display layer only. If `subagentTracker.start()` is skipped when output is hidden, `isSubagentActive()` returns false and subagent tool calls leak into main-chain display. Always call tracker methods unconditionally; wrap only `batcher.enqueueImmediate()` in the suppression guard.

3. **Two independent `editForumTopic` paths racing per topic** — The existing `StatusMessage.updateTopicDescription()` already calls `editForumTopic` per tool event. Adding a second status-update path creates a 429 cascade during active tool use. Consolidate: one `editForumTopic` call per topic per debounce window, combining both name prefix and context percentage in a single call.

4. **Settings topic `threadId` not persisted (multiple topics created on restart)** — The settings topic is permanent; its `threadId` must survive restarts. Store it in a separate `data/bot-state.json` (not `sessions.json` which is ephemeral session data) using the same atomic write pattern.

5. **Startup gray sweep using `Promise.all()` over all sessions** — Concurrent `editForumTopic` calls for all historical sessions hits undocumented Telegram flood limits. Use a sequential `for...of` with `await` and 300ms minimum gap. Scope sweep to active sessions only (`getActiveSessions()`, not `getAllSessions()`).

## Implications for Roadmap

Based on combined research, four phases are suggested in strict dependency order. The first two are independently buildable low-risk wins; the third is a targeted fix that benefits from the session lifecycle stability established in Phase 1; the fourth is the most structural and builds on Phase 2 being complete.

### Phase 1: Color-Coded Topic Status + Startup Cleanup

**Rationale:** Standalone, high-visibility improvement with no risk to existing behavior. Extends `TopicManager.editTopicName()` which is already battle-tested. Must come first because Phase 3 (dedup) touches session lifecycle and needs Phase 1's status model defined.

**Delivers:** Four-state topic status machine (ready/busy/error/down) visible in topic list; gray sweep on startup eliminates stale-green topics after restarts.

**Addresses:** P1 features — color-coded topic names, startup cleanup.

**Avoids:**
- Pitfall 1: No `icon_color` in `editForumTopic` — emoji prefix in topic name only
- Pitfall 4: Startup sweep scoped to active sessions, sequential with 300ms gap
- Pitfall 5: Consolidate `editForumTopic` into single debounced path per topic
- Pitfall 11: `closeTopic()` must use consistent gray prefix for visual coherence

**Build order within phase:** `types/topic-status.ts` → `sessions/session-store.ts` (add `updateTopicStatus`) → `bot/topics.ts` (add `setTopicStatus` with cache) → `index.ts` (wire hooks + startup sweep)

### Phase 2: Sub-Agent Suppression by Default

**Rationale:** Config-only gate on existing behavior — lowest structural risk of all four features. Independent of Phase 1. Sub-agent suppression being done first also means the settings topic (Phase 4) can expose a working toggle button rather than a no-op.

**Delivers:** Sub-agent spawn/done/output silenced by default (`SUBAGENT_VISIBLE=false`); `SubagentTracker` state maintained correctly; no change to main-chain tool display.

**Addresses:** P1 feature — sub-agent silence by default.

**Avoids:**
- Pitfall 2: `subagentTracker.start()/stop()` called unconditionally; only `batcher.enqueueImmediate()` wrapped in suppression guard
- Pitfall 9: `SUBAGENT_VISIBLE` env default is `false`; persistence deferred to Phase 4 (SettingsStore)

**Build order within phase:** `types/config.ts` (add `subagentOutput` field) → `src/config.ts` (parse env var) → `index.ts` (gate three call sites)

### Phase 3: Sticky Message Deduplication

**Rationale:** Depends on understanding the session lifecycle changes stabilized in Phase 1 (specifically, how `statusMessageId` flows through session start/resume/restart). The fix is small — 15-20 lines in `StatusMessage.initialize()` and `index.ts` — but correctness depends on Phase 1's session state model being settled. Independent of Phase 2.

**Delivers:** No duplicate pinned status messages on `/clear` or bot restart; existing pins reused when session already has a `statusMessageId`.

**Addresses:** P1 feature — sticky message deduplication.

**Avoids:**
- Pitfall 7: Reconnect path in `index.ts` passes `session.statusMessageId` to `initMonitoring`; add `StatusMessage.reconnect(existingMessageId)` for adopt-without-send path
- Pitfall 12: Full string comparison (`text === lastSentText`), never length comparison

**Build order within phase:** `monitoring/status-message.ts` (add `initialize(existingMessageId?)` overload) → `index.ts` (pass `statusMessageId` on resume path)

### Phase 4: Settings Topic with Interactive Configuration

**Rationale:** Most structurally significant feature — new directory, new classes, new message routing priority. Build last so it can immediately expose working settings (Phase 2's sub-agent toggle). Requires `RuntimeSettings` object as foundation before any settings UI is built.

**Delivers:** Dedicated Telegram "Settings" topic with inline toggle buttons for sub-agent visibility and default verbosity; changes take effect immediately in-process; settings persisted to `bot-state.json`; bot owner auth enforced on callbacks.

**Addresses:** P2 features — settings topic with runtime config; exposes Phase 2's sub-agent visibility toggle.

**Avoids:**
- Pitfall 3: `settingsTopicId` persisted in `data/bot-state.json` with atomic write; identified by stored ID not topic name search
- Pitfall 5 (config mutation): `RuntimeSettings` object separate from immutable `AppConfig`; components read runtime config from `RuntimeSettings`
- Pitfall 6: Settings topic threadId guard added to `bot.ts` text handler before session routing
- Pitfall 8: All `editMessageText` calls for settings include `reply_markup`; use `editMessageWithKeyboard()` wrapper
- Pitfall 10: All settings callback handlers check `ctx.from?.id === config.botOwnerId`; unauthorized taps get `show_alert` error

**Build order within phase:** `settings/runtime-settings.ts` → `settings/settings-store.ts` → `settings/settings-topic.ts` → `types/config.ts` (add `settingsTopicId`) → `index.ts` (startup init) → `bot/bot.ts` (routing priority + callback handlers)

### Phase Ordering Rationale

- Phase 1 before Phase 3: Phase 3 touches `StatusMessage.initialize()` and the session resume path. Phase 1 must stabilize the session lifecycle (startup sweep, `topicStatus` field in `SessionInfo`) before Phase 3 makes additional assumptions about session state.
- Phase 2 before Phase 4: The settings topic is more useful if it can toggle a working Phase 2 sub-agent suppression flag rather than implementing suppression and settings simultaneously in one complex phase.
- Phase 4 last: Introduces the most new code structure (`settings/` directory, `RuntimeSettings`, new routing priority). All P1 features are shipped and validated before taking on this structural addition.
- Phases 1 and 2 are independently buildable — no inter-dependency. If parallelism is desired, both can be executed simultaneously.

### Research Flags

Phases with standard, well-documented patterns (no additional research needed):
- **Phase 1:** `editForumTopic(name)` is already used in `topics.ts`; the four status emoji are standard Unicode; the `topicStatusCache` debounce is a simple map lookup. No research needed.
- **Phase 2:** Sub-agent suppression is a boolean guard on three existing call sites. Pattern is explicit in the codebase. No research needed.
- **Phase 3:** `StatusMessage.initialize()` modification is well-understood; the `reconnect()` pattern is described precisely in PITFALLS.md. No research needed.

Phases that may benefit from focused research during planning:
- **Phase 4:** The `RuntimeSettings` / `AppConfig` split and how it threads through all consumers in `index.ts` could benefit from a focused architecture review before coding. The bot owner auth pattern (`BOT_OWNER_ID` env var) should be confirmed against how `TELEGRAM_ALLOWED_USERS` is currently handled in `config.ts` to avoid duplication or conflict.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All features map to existing grammY API methods already in use; no new libraries required; verified against current codebase |
| Features | HIGH | Four P1 features have explicit integration points mapped to code; P2 features have clear dependency on P1; all anti-features have confirmed API constraints |
| Architecture | HIGH | Based on direct codebase analysis of `src/bot/topics.ts`, `src/monitoring/status-message.ts`, `src/monitoring/subagent-tracker.ts`, `src/sessions/session-store.ts`, `src/index.ts` |
| Pitfalls | HIGH | 13 pitfalls identified with prevention strategies; critical pitfalls verified against Telegram MTProto docs, aiogram 3.24, python-telegram-bot v21.6, grammY flood docs |

**Overall confidence:** HIGH

### Gaps to Address

- **`BOT_OWNER_ID` auth strategy:** PITFALLS.md recommends checking `ctx.from?.id === config.botOwnerId` in settings callbacks. The current `config.ts` uses `TELEGRAM_ALLOWED_USERS` for access control. During Phase 4 planning, confirm whether `botOwnerId` should be the first entry in `TELEGRAM_ALLOWED_USERS` or a new dedicated env var. Minor config design question, not a blocker.

- **`closeTopic` visual consistency:** PITFALLS.md notes a minor conflict between the existing `✅ proj-name (done)` close pattern and the new gray status system. During Phase 1 planning, decide whether `closeTopic()` should switch from the checkmark pattern to the gray circle pattern. This is a product decision (affects existing UX) not a technical decision.

- **`getForumTopicIconStickers` necessity:** STACK.md recommends emoji-prefix-in-name (no `icon_custom_emoji_id` needed) while PITFALLS.md Pitfall 1 mentions `icon_custom_emoji_id` as an alternative. These are in mild tension. The emoji-prefix-in-name approach (STACK.md recommendation) is simpler, already established in the codebase, and requires no additional API calls. Confirm during Phase 1 planning. Recommendation: emoji prefix in name only.

## Sources

### Primary (HIGH confidence)
- [Telegram MTProto — channels.editForumTopic](https://core.telegram.org/method/channels.editForumTopic) — confirmed `icon_color` not editable, only `title` and `icon_emoji_id`
- [aiogram 3.24 — editForumTopic](https://docs.aiogram.dev/en/latest/api/methods/edit_forum_topic.html) — confirmed `icon_color` NOT a parameter for edit
- [python-telegram-bot ForumTopic v21.6](https://docs.python-telegram-bot.org/en/v21.6/telegram.forumtopic.html) — `ForumIconColor` constants are read-only, creation-time only
- [grammY — Scaling Up IV: Flood Limits](https://grammy.dev/advanced/flood) — `editForumTopic` has undocumented per-topic rate limits not covered by throttler
- [grammY — transformer-throttler plugin](https://grammy.dev/plugins/transformer-throttler) — "undocumented rate limits NOT accounted for by throttler"
- [Telegram Bot API — getForumTopicIconStickers](https://core.telegram.org/bots/api#getforumtopiciconstickers) — valid emoji IDs for topic icons
- Direct codebase analysis (2026-03-02) — `src/bot/topics.ts`, `src/monitoring/status-message.ts`, `src/monitoring/subagent-tracker.ts`, `src/sessions/session-store.ts`, `src/index.ts`

### Secondary (MEDIUM confidence)
- [Telegram API — Forum Topics](https://core.telegram.org/api/forum) — icon_color is a 6-value enum, settable at creation only
- [Telegram Desktop bug — keyboard markup cleared on edit](https://github.com/telegramdesktop/tdesktop/issues/29501) — confirmed cross-platform inconsistency; must always pass `reply_markup` on edits with keyboards
- [@grammyjs/menu npm v1.3.1](https://www.npmjs.com/package/@grammyjs/menu) — evaluated and rejected for single-screen settings panel; multi-page navigation overhead not needed
- [@grammyjs/storage-file npm v2.5.1](https://www.npmjs.com/package/@grammyjs/storage-file) — evaluated and rejected; custom atomic JSON store is simpler for this use case

---
*Research completed: 2026-03-02*
*Ready for roadmap: yes*
