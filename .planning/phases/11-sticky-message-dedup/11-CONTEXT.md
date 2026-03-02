# Phase 11: Sticky Message Dedup - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Prevent duplicate pinned status messages on /clear and bot restart. When a session already has a statusMessageId, adopt the existing message instead of creating a new one. New sticky messages are only created for brand-new sessions. Does NOT include settings topic or any new UI (other phases).

</domain>

<decisions>
## Implementation Decisions

### /clear behavior
- On /clear, the old session's `statusMessageId` is available via `clearPending` map or session data
- Adopt the existing message: pass `statusMessageId` through to `initMonitoring()` and into `StatusMessage`
- `StatusMessage` gets a `reconnect(existingMessageId)` method that sets `this.messageId` WITHOUT sending a new message or pinning
- After reconnect, the normal `requestUpdate()` flow updates the content in-place (counters are reset to 0 by /clear)
- No content comparison needed — always adopt if `statusMessageId > 0`

### Bot restart/reconnect behavior
- On restart, `session.statusMessageId` is already persisted in sessions.json
- Pass it through `initMonitoring()` to `StatusMessage`
- Same `reconnect()` path: adopt existing message, update content via `requestUpdate()`
- The reconnected message may show stale data briefly — the next `requestUpdate()` fixes it
- If the old message was deleted (by user or Telegram), `editMessageText` will fail silently (existing error handling catches this)

### Brand new session behavior
- When `statusMessageId` is 0 (no prior message), use the existing `initialize()` path
- `initialize()` sends a new message, pins it, returns the message ID — unchanged

### initMonitoring signature change
- `initMonitoring(session)` gains awareness of `session.statusMessageId`
- If `session.statusMessageId > 0`: call `statusMsg.reconnect(session.statusMessageId)` instead of `statusMsg.initialize()`
- If `session.statusMessageId === 0`: call `statusMsg.initialize()` as before
- Both paths still call `sessionStore.updateStatusMessageId()` to persist the ID

### Claude's Discretion
- Whether `reconnect()` is a separate method or an optional parameter to `initialize(existingMessageId?)`
- Whether to immediately trigger an update after reconnect to clear stale data
- Error recovery if the adopted message ID is invalid (deleted message)

</decisions>

<specifics>
## Specific Ideas

- User's original words: "Upon telegram startup it should not create a new sticky message if the old sticky message has the same values. Only create a new sticky message upon clear or a brand new session."
- The key intent: no duplicate pinned messages cluttering the topic
- On /clear with reset counters, the initial content IS the same — reusing the message avoids a useless new pin

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `StatusMessage` (`src/monitoring/status-message.ts`): Has `initialize()` (send + pin), `requestUpdate()` (debounced edit), `flush()` (content dedup via `lastSentText`)
- `clearPending` map (index.ts line 165): Already stores `{ threadId, statusMessageId }` from old session on /clear
- `session.statusMessageId` field in `SessionInfo`: Persisted in sessions.json, available on reconnect

### Established Patterns
- `StatusMessage.flush()` already deduplicates content via `text === this.lastSentText` check
- `editMessageText` errors are already handled (catches "message is not modified")
- The reconnect loop (index.ts ~line 816) already iterates active sessions with `session.threadId > 0`

### Integration Points
1. **`initMonitoring()`** (index.ts line 293): Currently always calls `statusMsg.initialize()` — needs conditional path
2. **`clearPending` consumption** (index.ts line 456): Already reads `statusMessageId` but doesn't pass it forward — needs wiring
3. **`handleClearDetected()`** (index.ts line 194): Creates new session with `statusMessageId: 0` — needs to inherit from old session
4. **`onSessionStart(source='clear')`** (index.ts line 428): Calls `initMonitoring(session)` — session should carry `statusMessageId`
5. **Reconnect loop** (index.ts line 816): Calls `initMonitoring(session)` — session already has `statusMessageId` from store

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-sticky-message-dedup*
*Context gathered: 2026-03-02*
