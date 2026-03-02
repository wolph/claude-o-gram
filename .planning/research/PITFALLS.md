# Pitfalls Research: v4.0 Status & Settings

**Domain:** Adding color-coded topic status indicators, sub-agent suppression, sticky message deduplication, and a Telegram-native settings topic to an existing Claude Code Telegram bot bridge
**Researched:** 2026-03-02
**Confidence:** HIGH (Telegram Bot API constraints verified against official MTProto docs and grammY docs; integration pitfalls derived from direct codebase analysis)

---

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or require architectural changes to fix.

---

### Pitfall 1: icon_color Cannot Be Changed After Topic Creation

**What goes wrong:**
`editForumTopic` does not accept an `icon_color` parameter. The color is set only at `createForumTopic` time. Any implementation that tries to change topic color (green->yellow->red->gray to indicate status) by calling `editForumTopic` with `icon_color` will silently ignore the parameter or throw a type error. The Bot API endpoint and the underlying MTProto `channels.editForumTopic` only support `title` and `icon_emoji_id` as editable fields.

**Why it happens:**
The `ForumTopicCreated` event includes `icon_color` as a field, so developers assume it can be changed post-creation. The `editForumTopic` docs do not list `icon_color` as a parameter, but this is easily missed when reading the creation vs edit docs together. The colors are also six fixed RGB values — not arbitrary RGB — which further limits utility even if editing were possible.

**How to avoid:**
Use `icon_custom_emoji_id` (not `icon_color`) for dynamic status. On startup, call `getForumTopicIconStickers` to get the set of allowed free-tier emoji IDs (Telegram's default topic icon emoji pack contains colored circle variants). Map the four status states (ready/busy/error/down) to specific emoji IDs from that sticker set. When status changes, call `editForumTopic` with `icon_custom_emoji_id: <emojiId>`. Cache the emoji IDs in memory — do not call `getForumTopicIconStickers` per status update.

**Warning signs:**
- Any code that passes `icon_color` to `editForumTopic`
- Topic icons staying the same despite status changes
- TypeScript grammY types showing `icon_custom_emoji_id` but not `icon_color` on the edit method payload type

**Phase to address:**
Phase implementing color-coded topic status. Must call `getForumTopicIconStickers` before assuming any specific emoji ID is valid.

---

### Pitfall 2: Sub-Agent Suppression Breaks the SubagentTracker State Machine

**What goes wrong:**
The current `SubagentTracker` maintains a per-session stack of active agents (`sessionAgentStack`). If sub-agent output is suppressed by default (v4.0 feature), the naive implementation skips calling `subagentTracker.start()` and `subagentTracker.stop()` when visibility is off. The session stack then diverges from reality. The `getActiveAgent()` function — which is used to prefix tool calls from sub-agents (`[Explore] Read(file.ts)`) — returns stale or null agents after sub-agent ends. This corrupts tool attribution for the main agent chain.

**Why it happens:**
Suppression is natural to implement as "don't post to Telegram." The easy mistake is treating suppression as "ignore the hook entirely." The SubagentTracker is also used for: (1) tool prefix labeling in `onToolUse`, (2) depth-based indentation, and (3) temporal attribution in `onPreToolUse`. Skipping tracker updates breaks all three.

**How to avoid:**
Suppression must operate exclusively at the display layer. Always call `subagentTracker.start()` on SubagentStart and `subagentTracker.stop()` on SubagentStop regardless of the sub-agent visibility setting. The suppression check should wrap only the `batcher.enqueueImmediate(spawnHtml)` and `batcher.enqueueImmediate(doneHtml)` calls in the `onSubagentStart` and `onSubagentStop` callbacks. The tracker update calls remain unconditional.

**Warning signs:**
- Tool calls after a sub-agent completes being incorrectly prefixed with `[AgentName]`
- `SubagentStop for unknown agent` warnings in logs
- `getActiveAgent()` returning a non-null agent after all sub-agents have finished
- Main-chain tool calls appearing indented when no sub-agent is running

**Phase to address:**
Phase implementing sub-agent silence by default. The suppression flag must wrap only the `batcher.enqueueImmediate` calls — not the `subagentTracker` calls.

---

### Pitfall 3: Settings Topic Thread ID Not Persisted Across Restarts

**What goes wrong:**
The settings topic is a permanent forum topic, unlike session topics which are ephemeral. If the settings topic `threadId` is not persisted, the bot will create a new settings topic on every restart. Multiple "Bot Settings" topics accumulate in the Telegram group. Settings applied via the previous topic's inline buttons are associated with the old `threadId` and cannot be retrieved. Users are confused about which topic to use.

**Why it happens:**
The existing `sessions.json` is optimized for ephemeral per-session data. Adding a permanent settings topic to `sessions.json` is wrong because sessions.json gets cleaned up and overwritten. Developers either forget to persist it entirely (storing `settingsTopicThreadId` only in memory), or they use the session store inappropriately.

**How to avoid:**
Persist the settings topic `threadId` in a separate `data/bot-state.json` file using atomic write (temp file + rename, same pattern as `session-store.ts`). On startup: (1) read `bot-state.json`, (2) if `settingsTopicThreadId` is present, verify the topic still exists by sending a test message or using `getForumTopicIconStickers` indirectly (prefer a lightweight probe), (3) if topic is gone (group admin deleted it), recreate and update `bot-state.json`, (4) if topic does not exist in `bot-state.json`, create it on first startup and store the `threadId`. Never identify the settings topic by name — always by stored `threadId`.

**Warning signs:**
- Multiple "Bot Settings" topics appearing in the group
- Settings reverting on every bot restart
- Log messages creating a new settings topic despite one already existing

**Phase to address:**
Phase implementing the settings topic. `bot-state.json` persistence infrastructure must be built first, before creating the topic itself.

---

### Pitfall 4: Startup Gray Sweep Rate-Limiting on editForumTopic

**What goes wrong:**
The v4.0 feature "set all old topics to gray on bot startup" means calling `editForumTopic` for each session in the store that has `status === 'closed'` (or all sessions if we want all non-active sessions gray). If the session store has accumulated many sessions over weeks of use, calling `editForumTopic` for 20-30 topics in a tight loop triggers undocumented Telegram flood limits. The `transformer-throttler` plugin explicitly warns: "Telegram implements unspecified and undocumented rate limits for some API calls. These undocumented limits are NOT accounted for by the throttler." The bot receives a cascade of 429 responses, startup stalls, and some topics are not updated.

**Why it happens:**
Developers use `Promise.all()` to update all topics concurrently (fast, parallelizable). The `auto-retry` plugin handles 429s by waiting and retrying, but with 20 concurrent requests all retrying simultaneously, the retry queue grows large and startup takes many minutes.

**How to avoid:**
Limit the startup sweep to sessions with `status === 'active'` only — not all sessions. Active sessions at this project's scale (2-3 machines, a few sessions each) number in the single digits. Use a sequential `for...of` loop with `await` between each `editForumTopic` call, not `Promise.all`. Add a minimum 300ms gap between consecutive calls. Wrap each call in try/catch so a single 429 does not abort the sweep. Accept that historical (closed) sessions are not swept — they are already gray if they were properly closed, or they can be swept lazily on next bot start.

**Warning signs:**
- Bot startup taking more than 10 seconds with many sessions in the store
- Multiple 429 errors in the startup log before "Startup complete"
- Some topics remaining non-gray after startup sweep

**Phase to address:**
Phase implementing startup cleanup / boot-time status reset. Sweep logic must be sequential and scoped to active sessions only.

---

### Pitfall 5: editForumTopic Race Condition with Existing updateTopicDescription Calls

**What goes wrong:**
The existing `onToolUse` callback already calls `monitor.statusMessage.updateTopicDescription()` (which calls `editForumTopic`) on every tool call, updating the topic name to include context percentage (`🟢 proj-name | 45% ctx`). If the new color-coded status feature also calls `editForumTopic` to update the icon emoji, two separate code paths fire `editForumTopic` for the same topic in rapid succession. Telegram's undocumented limit for `editForumTopic` on the same topic is approximately 1-2 per second. Double-firing produces 429 responses.

**Why it happens:**
`StatusMessage.updateTopicDescription()` has no debounce. It fires on every tool call. The color update path (status: busy/ready/error) fires on session state changes. During active tool use, both triggers overlap. The `transformer-throttler` global rate limiter does not serialize these calls per-topic.

**How to avoid:**
Consolidate all `editForumTopic` calls for a given topic into a single debounced code path. Specifically: extend the existing `updateTopicDescription` method (or its caller) to also accept the new icon emoji ID. One `editForumTopic` call updates both the `name` (with color emoji prefix + project name + context %) and `icon_custom_emoji_id`. A single debounce of 3 seconds (matching the `StatusMessage.MIN_UPDATE_INTERVAL_MS`) prevents over-calling. Do not add a second independent code path for icon updates.

**Warning signs:**
- "Failed to edit topic name" warnings appearing in logs during active tool-use phases
- Topic name and icon getting visually out of sync
- 429 errors keyed to the same topic in rapid succession

**Phase to address:**
Phase implementing color-coded topic status. Must audit all existing `editForumTopic` call sites before adding new ones. The existing call in `updateTopicDescription` is the one to extend — do not add a new parallel call.

---

### Pitfall 6: Settings Topic Routing Conflict with Session Topic Message Handler

**What goes wrong:**
The bot's text message handler (`bot.on('message:text')`) routes messages to Claude Code sessions by looking up `threadId` via `sessionStore.getByThreadId(threadId)`. If the settings topic's `threadId` is not explicitly guarded, text typed in the settings topic silently falls through to `getByThreadId` (returning `undefined`, doing nothing), and commands like `/set_verbosity verbose` are never processed. Worse: if a session topic happens to be using the same `threadId` as the settings topic — impossible in practice but the code must be explicit — the user's settings command gets sent as input to Claude Code.

**Why it happens:**
The existing command routing was designed for session topics only. The settings topic is a new concept. Developers add settings topic handlers but forget to add the guard in the existing text/command handlers that routes away from the settings topic before falling through to session routing.

**How to avoid:**
At startup, load `settingsTopicThreadId` from `bot-state.json` into a module-level variable accessible by all bot handlers. In the existing `bot.on('message:text')` handler and the CLI command forwarding handler, add an early return if `threadId === settingsTopicThreadId` (handle as a settings command or ignore). Register settings-specific commands with `bot.command()` and check `ctx.message.message_thread_id === settingsTopicThreadId` inside the handler before processing. The settings topic needs its own handler registered before the catch-all text handler.

**Warning signs:**
- Commands typed in the settings topic having no effect
- Text typed in the settings topic causing unexpected behavior in a session
- Settings commands working in the main group chat but not in the settings topic

**Phase to address:**
Phase implementing the settings topic. The settings `threadId` guard must be in place in the text handler before the settings topic is surfaced to users.

---

## Moderate Pitfalls

Mistakes that cause significant rework or degraded UX but are recoverable without rewriting.

---

### Pitfall 7: Sticky Message Deduplication Fails After Bot Restart

**What goes wrong:**
The sticky message dedup check ("skip creating new sticky if content matches existing") relies on `StatusMessage.lastSentText` which is an in-memory field. After a bot restart, `lastSentText` is reset to `''` in the new `StatusMessage` instance. The reconnect path in `index.ts` calls `initMonitoring(session)` for each active session, which creates a new `StatusMessage` and calls `statusMsg.initialize()` — which sends a new status message and pins it. This happens even if the session already had a pinned status message from before the restart. The result: two pinned messages in the topic (old stale one + new one from restart).

**Why it happens:**
The `initMonitoring()` function always calls `statusMsg.initialize()` (send + pin), regardless of whether `session.statusMessageId` is already non-zero. The design is "always create fresh on monitoring init" but the reconnect case needs "reuse existing if available."

**How to avoid:**
In the reconnect path (the `activeSessions` loop in `index.ts`), do not call `statusMsg.initialize()` if `session.statusMessageId > 0`. Instead, initialize the `StatusMessage` instance with `messageId` pre-set and `lastSentText` initialized to a sentinel that will cause the next real update to flush. Add a `StatusMessage.reconnect(existingMessageId)` method that sets `this.messageId = existingMessageId` without sending a new message. The dedup check (comparing `lastSentText`) then only needs to work within a single process lifetime, which the existing `3-second debounce + content comparison` already handles correctly.

**Warning signs:**
- Multiple pinned messages in a topic after every bot restart
- "Failed to pin" warnings appearing consistently at startup (Telegram pin limit per topic)
- Topic status message showing "Starting..." instead of the previous tool/context state

**Phase to address:**
Phase implementing sticky message deduplication. Must audit the reconnect path in `index.ts` and add `StatusMessage.reconnect()`.

---

### Pitfall 8: Settings Inline Keyboard Markup Cleared on Message Edit (Telegram Desktop Bug)

**What goes wrong:**
The settings topic displays current settings with inline keyboard buttons for changing them. When the bot edits a settings message (e.g., to reflect a changed value), the message edit call must include `reply_markup` to preserve the buttons. If `reply_markup` is omitted from `editMessageText`, Telegram Desktop clears the buttons while Telegram Mobile preserves them. This is a confirmed client-side inconsistency. The bot's `TopicManager.editMessage()` method does not forward `reply_markup` — it passes `undefined`, which removes buttons on Telegram Desktop.

**Why it happens:**
The `editMessage` method was designed for status message text updates, which never have inline keyboards. Developers reuse it for settings messages without noticing the missing `reply_markup` parameter. The bug is invisible on mobile testing but immediately visible to desktop users.

**How to avoid:**
Add a `editMessageWithKeyboard(messageId, html, keyboard)` method to `TopicManager` that explicitly passes `reply_markup` to `editMessageText`. When updating settings display, always use this method. Alternatively, instead of editing the settings message, delete and resend it — but this changes the message position in the topic and disrupts the UX. The correct fix is always passing `reply_markup` on edit.

**Warning signs:**
- Settings buttons disappearing after the first settings change on Telegram Desktop
- Users reporting buttons visible on mobile but not on desktop
- `editMessageText` calls in settings logic that do not include `reply_markup`

**Phase to address:**
Phase implementing the settings topic. Keyboard preservation must be in the TopicManager API before settings messages are implemented.

---

### Pitfall 9: Sub-Agent Suppression Configuration Not Persisted

**What goes wrong:**
The settings topic allows toggling sub-agent visibility (silent vs verbose). If this setting is stored only in memory, it resets to the default on every bot restart. If the default is "silent" (the v4.0 goal), then verbose mode — which a user might have specifically enabled — silently reverts. The user does not notice until they run a complex multi-agent task and wonder why sub-agent output appears (or doesn't appear).

**Why it happens:**
Feature-specific settings added via inline buttons tend to be stored as module-level variables for simplicity. The `config.ts` pattern for environment variables does not handle runtime changes. Developers add the variable but forget to connect it to the persistence layer.

**How to avoid:**
All runtime-configurable settings (sub-agent visibility, notification levels, default verbosity) must be stored in `bot-state.json`. When a setting changes via a Telegram button tap, write `bot-state.json` atomically immediately. On startup, read `bot-state.json` and apply stored settings before registering hook handlers. The `AppConfig` type in `config.ts` should be split: `EnvConfig` (from environment variables, read-only) and `RuntimeConfig` (from `bot-state.json`, read-write). Do not mix the two.

**Warning signs:**
- Settings changes via the settings topic taking effect immediately but reverting after restart
- Settings topic showing correct values but behavior being controlled by environment variables
- No write to `bot-state.json` triggered on settings button tap

**Phase to address:**
Phase implementing sub-agent silence by default and the settings topic. `bot-state.json` runtime config layer must be designed first.

---

### Pitfall 10: Settings Auth Not Enforced on Callback Queries

**What goes wrong:**
The settings topic inline buttons fire callback queries. The callback query handler (registered via `bot.callbackQuery(...)`) does not verify `ctx.from?.id` against an authorized user ID. Any Telegram user who can see the settings message and tap its buttons can change bot configuration. In a shared group where the bot owner has invited team members, any member can toggle sub-agent visibility, change verbosity, or reconfigure the bot.

**Why it happens:**
The existing approval keyboard handlers (`approve:`, `deny:`, mode buttons) do not verify `ctx.from.id` either — the approval design is intentionally per-group (any trusted group member can approve a tool call). Developers carry this assumption into the settings topic without realizing settings changes are more sensitive than one-off approvals.

**How to avoid:**
Add a `botOwnerId` field to `AppConfig` (from a `BOT_OWNER_ID` environment variable, or auto-populated on first successful command). In all settings callback query handlers, check `ctx.from?.id !== config.botOwnerId` and answer with `show_alert: true` if the check fails: "Only the bot owner can change settings." This check is one line per handler and prevents unauthorized reconfiguration.

**Warning signs:**
- Settings callback handlers without an `if (ctx.from?.id !== config.botOwnerId)` guard
- No `BOT_OWNER_ID` or equivalent in `config.ts`
- Settings commands working for any group member who taps a button

**Phase to address:**
Phase implementing the settings topic. Auth check must be in the callback handler from the first implementation.

---

## Minor Pitfalls

Issues that cause confusion or minor bugs but are quickly fixable.

---

### Pitfall 11: Gray Status Emoji Conflicting with "Closed" Text in Topic Name

**What goes wrong:**
The existing `closeTopic()` method in `TopicManager` sets the topic name to `✅ proj-name (done)` and closes the topic. The new color-coded status adds a gray emoji (e.g., ⚫) for "down/inactive" topics. On startup sweep, if the bot sets a closed topic's icon to gray but the topic name still says `✅ proj-name (done)`, the visual signals conflict: gray icon (implies "offline bot") + green check (implies "session done"). Users misread topic state.

**Why it happens:**
The startup gray sweep calls `editForumTopic` on the icon without considering the current topic name. The `closeTopic` path and the gray sweep path are independent code paths that do not coordinate on the full visual state of the topic.

**How to avoid:**
When setting a topic to gray during the startup sweep, also update the `name` to remove the emoji prefix and replace it with the gray emoji. The name update and icon update happen in the same `editForumTopic` call (both `name` and `icon_custom_emoji_id` are in one request). Alternatively, use the gray emoji in the `closeTopic()` method itself so topics are gray from the moment they close — making the startup sweep unnecessary for most topics.

**Warning signs:**
- Topics showing conflicting visual signals (gray icon + green check name, or vice versa)
- `editForumTopic` calls that update only the icon but not the name prefix

**Phase to address:**
Phase implementing color-coded topic status. The color state encoding (emoji prefix + icon emoji) must be consistent across all code paths that modify topic appearance.

---

### Pitfall 12: Sticky Message deduplication Using Length Instead of Content

**What goes wrong:**
A simple dedup implementation checks `if (newContent.length === lastSentText.length) skip`. Two status messages with the same length but different context percentages (e.g., "45% ctx" and "55% ctx" — same number of digits) would be considered identical. The status message is not updated, and the displayed context percentage is stale.

**Why it happens:**
Length comparison is faster and simpler than string comparison. Developers optimize early without considering real-world collision frequency.

**How to avoid:**
Always compare full string content: `if (text === this.lastSentText) return`. The `StatusMessage.flush()` already does this correctly. The sticky message dedup for the new pin-on-create case should use the same pattern. String comparison for a 150-character status message is negligible overhead.

**Warning signs:**
- Status message occasionally showing stale context percentage
- Content length check instead of content equality in dedup logic
- Unit tests using identical-length but different-content strings, all passing

**Phase to address:**
Phase implementing sticky message deduplication. Enforce full string comparison from the start.

---

### Pitfall 13: getForumTopicIconStickers Called Per Status Update Instead of Once

**What goes wrong:**
`getForumTopicIconStickers` returns the set of valid emoji IDs for forum topic icons. If called on every status change (session start, tool call, session end), the bot makes dozens of unnecessary API calls per session, consuming rate limit budget and adding latency to status updates. The sticker set is stable — Telegram does not change it frequently.

**Why it happens:**
Developers call `getForumTopicIconStickers` in the status update function to "always get fresh data." The function is async and the emoji ID map is not cached at the module level.

**How to avoid:**
Call `getForumTopicIconStickers` once at startup. Store the emoji ID mapping in a module-level constant: `const TOPIC_ICON_EMOJIS = { ready: '...', busy: '...', error: '...', down: '...' }`. Log the resolved IDs at startup. If the API call fails at startup, fall back to hardcoded known-good IDs with a warning. Do not call this method again during normal operation.

**Warning signs:**
- `getForumTopicIconStickers` appearing in code paths that run per tool call
- API call logs showing `getForumTopicIconStickers` being called more than once per bot process lifetime

**Phase to address:**
Phase implementing color-coded topic status. Emoji ID resolution must be in the startup/init path, not the hot path.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcode emoji IDs for status colors instead of calling `getForumTopicIconStickers` | Simpler implementation, no async startup call | Breaks silently if Telegram retires an emoji ID; no way to know valid alternatives | Never — one startup call is cheap and self-documenting |
| Store settings topic ID in `sessions.json` instead of `bot-state.json` | Avoid adding a new file | Settings get lost if sessions are reset; semantically wrong (settings are not sessions) | Never |
| Skip `subagentTracker.start()`/`.stop()` when suppressing output | Simpler suppression code (one fewer call) | Corrupts tool attribution for main agent, breaks subagent depth tracking | Never |
| `Promise.all()` for the startup gray sweep | Faster sweep | Undocumented `editForumTopic` rate limits cause cascading 429s that stall startup | Never |
| Compare sticky message content by length instead of full text | Slightly faster comparison | Length collisions cause stale status display | Never — full string comparison is negligible cost |
| Store runtime settings in environment variables only | No new persistence needed | Settings not configurable at runtime via Telegram; defeats the purpose of the settings topic | Never for settings that the user should be able to change |
| `bot-state.json` written on every settings change without atomic write | Simpler implementation | Corrupt file on crash leaves bot unable to start (no settings topic, missing config) | Never — always use temp+rename |

---

## Integration Gotchas

Common mistakes when connecting to external services and APIs.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Telegram `editForumTopic` | Pass `icon_color` to change status color | Use `icon_custom_emoji_id` — `icon_color` is set once at creation and is not editable |
| Telegram `editForumTopic` | Call per tool event without debounce | Debounce to minimum 3 seconds per topic; consolidate name + icon into one call |
| Telegram `getForumTopicIconStickers` | Call on every status update | Call once at startup; cache emoji IDs in module-level constants |
| Telegram `pinChatMessage` | Pin a new status message without unpinning the old one | Forum topics accumulate pinned messages; unpin old before pinning new, or edit in place |
| Telegram inline keyboard edit | Edit message text without re-sending `reply_markup` | Telegram Desktop removes buttons when `reply_markup` is omitted on edit |
| `SubagentTracker` | Skip `start()`/`stop()` when suppressing sub-agent output | Always update tracker state; suppress only the Telegram `batcher.enqueueImmediate()` call |
| `sessions.json` | Store permanent settings topic ID alongside ephemeral sessions | Use separate `bot-state.json` with atomic write for permanent bot state |
| Settings callback handlers | Apply to any Telegram user | Always check `ctx.from?.id === config.botOwnerId` before applying settings changes |
| grammY `apiThrottler` | Assume it protects against ALL rate limits including `editForumTopic` | The transformer-throttler only handles documented limits; `editForumTopic` has undocumented per-topic limits |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Startup sweep over all sessions (not just active) | Startup takes 30+ seconds, multiple 429 errors | Only sweep `getActiveSessions()`, not `getAllSessions()` | Any run after 1+ weeks of use (dozens of historical sessions) |
| Parallel `editForumTopic` calls on startup | 429 cascade, stalled startup, some topics not updated | Sequential `for...of` with `await`, 300ms minimum gap | More than ~3 concurrent calls |
| Two independent `editForumTopic` paths for same topic | 429s during active tool use, topic name/icon desync | Consolidate into one debounced path per topic | Immediately during any active session |
| `getForumTopicIconStickers` called per status update | Rate limit budget consumed, status updates slower | Call once at startup, cache results | After ~30 status updates in a session |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Settings callback handlers accessible to all group members | Unauthorized configuration changes (sub-agent visibility, verbosity, permissions) | Check `ctx.from?.id === config.botOwnerId` in every settings callback handler |
| `bot-state.json` stored world-readable | Settings readable by any local user on the machine | Store in `data/` with 0600 permissions; document this in setup instructions |
| Settings topic commands not scoped to settings topic threadId | Settings commands typed in session topics or general group processed as settings | Guard all settings handlers with `ctx.message.message_thread_id === settingsTopicThreadId` |
| Sub-agent suppression state not persisted | User enables verbose sub-agent mode for security review; bot restarts; mode silently resets to silent | Persist all settings in `bot-state.json` with explicit confirmation on change |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Startup sweep sets all topics gray simultaneously | All topics flash gray at startup even if sessions are still active | Set topics gray only for `status === 'closed'` sessions; never touch topics of running sessions during sweep |
| Sub-agent suppression with no summary | User has no idea multi-agent work happened | Post a single summary line on SubagentStop even in silent mode: "Agent finished in 3.2s" (one line, no topic, no expansion) |
| New pin on every /clear without unpinning old | Topic accumulates pinned messages; Telegram shows multiple pins at top | Unpin old status message before pinning new one in /clear and restart paths |
| Settings changes requiring bot restart to take effect | User changes sub-agent visibility, nothing changes | All settings must take effect in-process immediately; update in-memory config as well as `bot-state.json` |
| Settings topic silent to commands typed outside it | `/set_verbosity` in session topic does nothing, no error message | Either accept the command anywhere (with topic guard) or respond with "use the Bot Settings topic" |
| Color status "gray = down" confused with Telegram's default gray | Users think gray means "topic not configured" | Use a distinct non-gray emoji for "bot offline" state; consider ⚪ (white) or ☁️ instead |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Color-coded topic status:** Verify `getForumTopicIconStickers` is called exactly once at startup and emoji IDs are logged. Test that all four states (ready/busy/error/down) produce visually distinct topic icons in Telegram. Test on both mobile and desktop clients.

- [ ] **Color-coded topic status:** Verify `editForumTopic` is not called more than once per 3-second window per topic during a tool-heavy session. Check logs for absence of "Failed to edit topic name" warnings under load.

- [ ] **Startup gray sweep:** Verify sweep only touches `getActiveSessions()`, not `getAllSessions()`. Run with 20+ closed sessions in the store; measure startup time and confirm no 429 errors.

- [ ] **Sub-agent suppression:** Verify `subagentTracker.start()` and `subagentTracker.stop()` are still called even when display is suppressed. Verify tool attribution is correct during and after a suppressed sub-agent run.

- [ ] **Sub-agent suppression:** Verify the setting persists across bot restart. Change to verbose, restart, confirm verbose is active.

- [ ] **Sticky dedup:** After a bot restart, verify a session with an existing `statusMessageId` does NOT create a new pinned status message. Exactly one pin per topic after restart.

- [ ] **Sticky dedup:** Verify a second identical status update within the same session does NOT call `editMessageText`. Confirm by checking API call logs.

- [ ] **Settings topic persistence:** Verify `bot-state.json` is written atomically (temp+rename). Verify on restart the bot reads `settingsTopicThreadId` before registering handlers. Verify exactly one "Bot Settings" topic exists after 3 restarts.

- [ ] **Settings topic isolation:** Text typed in the settings topic does NOT route to any Claude Code session. Commands typed in session topics do NOT trigger settings changes.

- [ ] **Settings auth:** A non-owner user tapping a settings button receives an error alert, not a settings change.

- [ ] **editForumTopic consolidation:** There is exactly one code path per topic that calls `editForumTopic`. Grep for `editForumTopic` and `editTopicName` across the codebase and count call sites.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Multiple settings topics created | LOW | Close/delete duplicate topics in Telegram group; update `bot-state.json` with correct `threadId`; restart bot |
| icon_color passed to editForumTopic (feature silently broken) | LOW | Replace with `icon_custom_emoji_id` approach; test emoji ID resolution; one-time code change |
| Sub-agent tracker state corrupted by skipped calls | MEDIUM | Restart bot (tracker resets in memory); fix the suppression logic to keep tracker calls; monitor for "SubagentStop for unknown agent" warnings |
| Old status messages accumulating as pins after restarts | LOW | Manually unpin old messages in affected topics via Telegram UI; add `reconnect()` path to prevent recurrence |
| `bot-state.json` corrupt after unclean shutdown | LOW | Delete corrupt file; bot recreates settings topic on next start (users must re-apply settings via the topic) |
| Startup sweep hitting 429s and stalling | LOW | Restart bot; add sequential sweep with delay; reduce sweep scope to active-only |
| Settings buttons cleared on Telegram Desktop after edit | MEDIUM | Add `reply_markup` to all `editMessageText` calls in settings paths; existing messages need delete+resend to restore buttons |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| icon_color not editable post-creation (1) | Phase: Color-coded topic status | Test that `editForumTopic` with emoji ID changes topic icon visually; verify no icon_color param in codebase |
| Sub-agent suppression breaks tracker (2) | Phase: Sub-agent silence by default | Run suppressed sub-agent task; verify tool attribution correct after agent ends |
| Settings topic ID not persisted (3) | Phase: Settings topic | Restart 3x; verify single settings topic, all settings retained |
| Startup sweep rate-limiting (4) | Phase: Startup cleanup | Run with 20+ sessions; startup completes in under 5 seconds; zero 429 errors |
| editForumTopic race condition (5) | Phase: Color-coded topic status | High tool-use session; zero "Failed to edit topic name" warnings in logs |
| Settings topic routing conflict (6) | Phase: Settings topic | Type text in settings topic; confirm not routed to any session |
| Sticky dedup fails after restart (7) | Phase: Sticky message deduplication | Restart mid-session; confirm single pin, no new status message sent |
| Keyboard markup cleared on Desktop (8) | Phase: Settings topic | Edit settings message; confirm buttons persist on Telegram Desktop |
| Sub-agent visibility setting not persisted (9) | Phase: Sub-agent silence + settings topic | Change to verbose; restart; verify verbose active without user intervention |
| Settings auth not enforced (10) | Phase: Settings topic | Non-owner taps button; verify error alert, no config change |
| Gray/closed emoji conflict (11) | Phase: Color-coded topic status | Close a session; verify topic shows consistent gray icon + gray name prefix |
| Sticky dedup uses length not content (12) | Phase: Sticky message deduplication | Status updates with same-length but different content; verify each triggers edit |
| getForumTopicIconStickers called per update (13) | Phase: Color-coded topic status | Check logs for single `getForumTopicIconStickers` call at startup only |

---

## Sources

- [Telegram MTProto — channels.editForumTopic](https://core.telegram.org/method/channels.editForumTopic) — HIGH confidence. Confirmed: only `title` and `icon_emoji_id` are editable fields. No `icon_color`.
- [Telegram API — Forum Topics](https://core.telegram.org/api/forum) — HIGH confidence. icon_color must be one of 6 fixed RGB values; set at creation only.
- [grammY — Scaling Up IV: Flood Limits](https://grammy.dev/advanced/flood) — HIGH confidence. Rate limits are unspecified; auto-retry is the correct approach; do not pre-throttle.
- [grammY — transformer-throttler plugin](https://grammy.dev/plugins/transformer-throttler) — HIGH confidence. Confirmed: "undocumented rate limits are NOT accounted for by the throttler." Global limits: 30/sec, 20/min per group.
- [Telegram Desktop bug — inline keyboard markup cleared on edit](https://github.com/telegramdesktop/tdesktop/issues/29501) — MEDIUM confidence. Confirmed cross-platform inconsistency; must always pass `reply_markup` on edit.
- [Telegram Bot API — getForumTopicIconStickers](https://core.telegram.org/bots/api#getforumtopiciconstickers) — HIGH confidence. Returns Sticker array of valid topic icon emoji.
- [Telegram Bot API — pinChatMessage](https://core.telegram.org/api/pin) — HIGH confidence. Topics have per-topic pin lists; multiple pins accumulate.
- Direct codebase analysis: `src/monitoring/subagent-tracker.ts` (tracker state machine), `src/monitoring/status-message.ts` (debounce + lastSentText), `src/sessions/session-store.ts` (persistence), `src/bot/topics.ts` (editForumTopic call sites), `src/index.ts` (reconnect path and initMonitoring) — HIGH confidence.

---
*Pitfalls research for: Claude Code Telegram Bridge v4.0 (color-coded status, sub-agent suppression, sticky dedup, settings topic)*
*Researched: 2026-03-02*
