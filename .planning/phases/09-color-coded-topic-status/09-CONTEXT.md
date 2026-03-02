# Phase 9: Color-Coded Topic Status - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Add four-state color-coded emoji indicators to Telegram topic names (green=ready, yellow=busy, red=error, gray=down) and sweep all active topics to gray on bot startup. This replaces the current green-only topic prefix with a dynamic status system. Does NOT include settings topic or sub-agent suppression (other phases).

</domain>

<decisions>
## Implementation Decisions

### Status transitions
- **Green (🟢)**: Session is waiting for user input — Claude is idle, awaiting a prompt or permission decision
- **Yellow (🟡)**: Claude is actively processing — generating output, running tools, thinking. Stays yellow for the entire turn, not per-tool
- **Red (🔴)**: Context window exhaustion at 95%+ threshold (only reliable error signal currently available)
- **Gray (⚪)**: Session is down/offline — bot restarted, session crashed, or session not yet reconnected
- Transition frequency: green↔yellow flips per Claude turn (not per tool call) to reduce editForumTopic calls

### Topic name format
- Format: `{emoji} {project-name}` — clean, no context% in topic name
- Context percentage stays exclusively in the pinned status message (where it already lives)
- Removes the current `🟢 project-name | 45% ctx` pattern from `StatusMessage.updateTopicDescription()`
- This eliminates one of the two independent `editForumTopic` call paths, reducing rate limit risk

### Session end behavior
- Normal session end: keep ✅ prefix (existing behavior) — means "completed normally"
- Gray means "down/disconnected/crashed" — different semantic from "done"
- Two inactive states: ✅ = completed, ⚪ = down. Green/yellow = alive.

### Startup gray sweep
- On bot startup, sweep only sessions marked 'active' in sessions.json — set their topic names to gray prefix
- Leave properly closed (✅) topics untouched
- Sequential sweep with brief delay between calls (not Promise.all) to avoid rate limits
- After sweep, proceed with normal reconnect logic (restart monitoring for sessions that are still actually alive)

### editForumTopic consolidation
- All topic name changes (status transitions, renames) must flow through a single debounced path
- Add `topicStatusCache` (Map<threadId, status>) to skip no-op API calls when status hasn't changed
- Remove `StatusMessage.updateTopicDescription()` — topic name updates move to a centralized method in TopicManager or a new TopicStatusManager

### Claude's Discretion
- Debounce interval for editForumTopic calls (research suggests 3-5 seconds minimum)
- Whether to use a separate TopicStatusManager class or extend TopicManager
- Exact gray emoji choice (⚪ vs ⬜ vs other gray variant)
- Error handling for failed editForumTopic calls during status transitions

</decisions>

<specifics>
## Specific Ideas

- User's original words: "green bubble in the topic is ready/waiting for input. Yellow is busy with something. Red is error. Gray is down."
- "At startup clean up old topics by setting them all to gray status" — gray sweep is explicitly requested as startup behavior
- The "waiting for input" distinction is key — green means Claude is blocked on the user, not just "session exists"

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TopicManager` (`src/bot/topics.ts`): Already has `createTopic()` with 🟢, `closeTopic()` with ✅, `reopenTopic()` with 🟢, `editTopicName()` for raw name edits
- `StatusMessage` (`src/monitoring/status-message.ts`): Has `updateTopicDescription()` calling `editForumTopic` (to be removed/consolidated), has 3-second debounce pattern for `editMessageText`
- `SessionStore.getActiveSessions()` (`src/sessions/session-store.ts`): Returns sessions with status 'active' — used for startup sweep
- `formatStatus()` in `status-message.ts` already uses green/yellow/red emoji in the pinned message body

### Established Patterns
- Emoji prefix in topic name (`🟢 name`) — established and working, extend to 4 states
- Debounce pattern in StatusMessage (3-second MIN_UPDATE_INTERVAL_MS) — reuse for topic status
- `editForumTopic` is called from `TopicManager.editTopicName()`, `TopicManager.closeTopic()`, `TopicManager.reopenTopic()`, `TopicManager.renameTopic()`, and `StatusMessage.updateTopicDescription()` — 5 call sites total
- Session reconnect loop in `index.ts` lines 816-838: iterates active sessions, restarts monitoring

### Integration Points
- `onSessionStart` (index.ts:427): Currently calls `topicManager.createTopic()` or `reopenTopic()` with hardcoded 🟢
- `onSessionEnd` (index.ts:535): Currently calls `topicManager.closeTopic()` with hardcoded ✅
- `onToolUse` (index.ts:594): Currently calls `statusMessage.updateTopicDescription()` — this is where yellow status would be set
- `initMonitoring` (index.ts:289): Initializes StatusMessage — status should be set to green after monitoring starts
- Startup reconnect (index.ts:816-838): Gray sweep would happen HERE, before reconnecting
- `onPreToolUse` (index.ts:665): Approval wait — when this resolves, status should flip back to yellow (processing)
- Hook callbacks for detecting "waiting for input" state: `onStop` hook fires at end of Claude's turn, approval waits block until user responds

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-color-coded-topic-status*
*Context gathered: 2026-03-02*
