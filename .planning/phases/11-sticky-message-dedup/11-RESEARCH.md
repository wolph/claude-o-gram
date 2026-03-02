# Phase 11: Sticky Message Dedup - Research

**Researched:** 2026-03-02
**Domain:** Telegram Bot API message editing, StatusMessage lifecycle
**Confidence:** HIGH

## Summary

Phase 11 eliminates duplicate pinned status messages created on /clear and bot restart. Currently, `initMonitoring()` always calls `statusMsg.initialize()`, which sends a new message and pins it -- even when the session already has a valid `statusMessageId`. The fix is straightforward: add a `reconnect(existingMessageId)` method to `StatusMessage` that adopts an existing message ID without sending a new one, and wire `initMonitoring()` to use it when `session.statusMessageId > 0`.

The codebase has all the necessary infrastructure: `session.statusMessageId` is already persisted, `clearPending` already stores `statusMessageId`, and the `/clear` handler in `handlers.ts` already copies the prior session's data (including `statusMessageId`) to the new session. The only missing piece is the conditional path in `initMonitoring()` and the `reconnect()` method on `StatusMessage`.

**Primary recommendation:** Add `StatusMessage.reconnect(messageId)` to adopt an existing message, and branch `initMonitoring()` on `session.statusMessageId > 0`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- On /clear, adopt the existing message via `reconnect(existingMessageId)` -- no content comparison needed, always adopt if `statusMessageId > 0`
- `StatusMessage` gets a `reconnect(existingMessageId)` method that sets `this.messageId` WITHOUT sending a new message or pinning
- After reconnect, normal `requestUpdate()` flow updates the content in-place
- On restart, `session.statusMessageId` from sessions.json feeds the same `reconnect()` path
- `initMonitoring(session)` branches: if `session.statusMessageId > 0` call `reconnect()`, else call `initialize()`
- `handleClearDetected()` needs to inherit `statusMessageId` from old session (currently sets 0)
- Brand new sessions (statusMessageId === 0) use existing `initialize()` path unchanged

### Claude's Discretion
- Whether `reconnect()` is a separate method or an optional parameter to `initialize(existingMessageId?)`
- Whether to immediately trigger an update after reconnect to clear stale data
- Error recovery if the adopted message ID is invalid (deleted message)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| STKY-01 | On /clear, existing pinned message is reused if content matches | `clearPending` already stores `statusMessageId`; `handleSessionStart(source='clear')` in handlers.ts copies prior session data including `statusMessageId` to new session; `initMonitoring()` just needs to branch on it |
| STKY-02 | On bot restart/reconnect, existing pinned message is adopted from stored statusMessageId | `session.statusMessageId` is already persisted in sessions.json; the reconnect loop at line 886 calls `initMonitoring(session)` -- session already carries `statusMessageId` |
| STKY-03 | New sticky messages are only created for brand new sessions or when content differs | Brand new sessions have `statusMessageId: 0`; the existing `initialize()` path handles this; `reconnect()` covers all non-zero cases |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | (existing) | Telegram Bot API | Already used; `editMessageText` for in-place updates |
| Node.js | (existing) | Runtime | Single-threaded event loop, no concurrency issues |

### Supporting
No new libraries needed. This is a pure logic change using existing APIs.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Separate `reconnect()` method | Optional `existingMessageId?` param on `initialize()` | Optional param is simpler but muddies the initialize contract |

**Installation:** None -- no new dependencies.

## Architecture Patterns

### Pattern 1: StatusMessage.reconnect(messageId)
**What:** A new method on StatusMessage that adopts an existing message ID without sending/pinning
**When to use:** Called when `session.statusMessageId > 0`
**Example:**
```typescript
// Source: Existing StatusMessage class pattern
async reconnect(existingMessageId: number): Promise<number> {
  this.messageId = existingMessageId;
  this.lastUpdateTime = Date.now();
  // Don't set lastSentText -- forces first requestUpdate() to actually send
  return this.messageId;
}
```

### Pattern 2: Conditional initMonitoring
**What:** Branch in `initMonitoring()` based on whether session already has a status message
**When to use:** Every time `initMonitoring()` is called
**Example:**
```typescript
// In initMonitoring(session):
if (session.statusMessageId > 0) {
  void statusMsg.reconnect(session.statusMessageId).then(() => {
    // Trigger immediate update to refresh stale content
    const latestSession = sessionStore.get(session.sessionId);
    if (latestSession) {
      statusMsg.requestUpdate(buildStatusData(latestSession, 'Starting...'));
    }
  });
} else {
  void statusMsg.initialize().then((statusMessageId) => {
    sessionStore.updateStatusMessageId(session.sessionId, statusMessageId);
    sessionStore.updateVerbosity(session.sessionId, config.defaultVerbosity);
  }).catch(/* existing error handling */);
}
```

### Pattern 3: Inherit statusMessageId in handleClearDetected
**What:** Pass the old session's `statusMessageId` through to the new session in the ClearDetector path
**When to use:** When filesystem-detected /clear creates a new session
**Example:**
```typescript
// In handleClearDetected(), the new session object:
statusMessageId: oldSession?.statusMessageId ?? pending?.statusMessageId ?? 0,
```

### Anti-Patterns to Avoid
- **Creating new messages and comparing content:** The user explicitly rejected content comparison. Always adopt if statusMessageId > 0.
- **Modifying initialize() to accept optional params:** Keeps initialize() clean for the "brand new" path.
- **Deleting old pinned message before creating new one:** Loses the pinned position and creates visual churn.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message content dedup | Content hash comparison | Adopt by ID, let `flush()` dedup content naturally | `flush()` already skips identical content via `lastSentText` check |
| Rate limiting edits | Custom rate limiter | StatusMessage's existing 3-second debounce | Already handles rate limiting for `editMessageText` |

## Common Pitfalls

### Pitfall 1: Reconnecting to a Deleted Message
**What goes wrong:** User manually deletes the pinned status message, then /clear happens. `editMessageText` will fail on the stale messageId.
**Why it happens:** Telegram does not notify bots when users delete messages.
**How to avoid:** The existing error handling in `flush()` already catches and logs `editMessageText` failures. If the reconnected message ID is invalid, `flush()` will warn and continue. The status message won't display, but the session continues working. Optionally, could fall back to `initialize()` on error.
**Warning signs:** Console warning "StatusMessage: failed to update status" after reconnect.

### Pitfall 2: handleClearDetected vs onSessionStart(source='clear') Race
**What goes wrong:** Two paths handle /clear: the `handleClearDetected` (filesystem watcher) and `onSessionStart(source='clear')` (HTTP hook). Both create new sessions.
**Why it happens:** Bug #6428 means SessionEnd doesn't fire on /clear, so both paths may trigger.
**How to avoid:** Both paths already have dedup logic (checking for active sessions). The fix needs to apply `statusMessageId` inheritance in BOTH paths consistently.
**Warning signs:** Duplicate monitoring instances for the same session.

### Pitfall 3: statusMessageId Not Propagated on /clear in handlers.ts
**What goes wrong:** The `handleSessionStart(source='clear')` path in `handlers.ts` spreads the prior session data into the new session. This already includes `statusMessageId`. However, `handleClearDetected()` in `index.ts` hardcodes `statusMessageId: 0`.
**Why it happens:** `handleClearDetected()` was written before dedup was considered.
**How to avoid:** Change `handleClearDetected()` to inherit `statusMessageId` from the old session or pending data.
**Warning signs:** /clear via filesystem watcher creates duplicate status messages, but /clear via HTTP hooks does not.

## Code Examples

### Current initMonitoring (unchanged lines for reference)
```typescript
// Source: src/index.ts line 293
function initMonitoring(session: SessionInfo): void {
  const statusMsg = new StatusMessage(bot, config.telegramChatId, session.threadId);
  // ... watcher and timer setup ...
  void statusMsg.initialize().then((statusMessageId) => {
    sessionStore.updateStatusMessageId(session.sessionId, statusMessageId);
    sessionStore.updateVerbosity(session.sessionId, config.defaultVerbosity);
  }).catch(/* ... */);
  // ... start watchers ...
}
```

### Current handleClearDetected (the hardcoded 0)
```typescript
// Source: src/index.ts line 222
const newSessionData: SessionInfo = {
  // ...
  statusMessageId: 0,  // <-- THIS is what needs to change
  // ...
};
```

### clearPending already stores statusMessageId
```typescript
// Source: src/index.ts line 572
clearPending.set(latest.cwd, {
  threadId: latest.threadId,
  statusMessageId: latest.statusMessageId,
});
```

### handlers.ts clear path already spreads prior data
```typescript
// Source: src/hooks/handlers.ts line 244
this.sessionStore.set(payload.session_id, {
  ...prior,  // <-- prior.statusMessageId is already included
  sessionId: payload.session_id,
  // ... overrides ...
  // statusMessageId is NOT overridden here, so prior value passes through
});
```

## State of the Art

No external technology changes needed. This is a pure internal logic improvement.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None -- no test directory or framework configured |
| Config file | none |
| Quick run command | `npx tsc --noEmit` (type-check only) |
| Full suite command | `npx tsc --noEmit` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STKY-01 | /clear reuses existing pinned message | manual-only | Manual: trigger /clear in Telegram, verify no duplicate pin | N/A |
| STKY-02 | Restart adopts stored statusMessageId | manual-only | Manual: restart bot, verify existing pin is reused | N/A |
| STKY-03 | New messages only for brand-new sessions | manual-only | Manual: start fresh session, verify new pin created | N/A |

**Justification for manual-only:** All three requirements involve Telegram API interactions (sendMessage, pinChatMessage, editMessageText) that cannot be tested without a live bot instance and Telegram group. No mock infrastructure exists.

### Sampling Rate
- **Per task commit:** `npx tsc --noEmit`
- **Per wave merge:** `npx tsc --noEmit`
- **Phase gate:** Manual UAT in Telegram

### Wave 0 Gaps
None -- no test infrastructure to set up. TypeScript compilation is the automated validation.

## Open Questions

1. **Should reconnect trigger an immediate update?**
   - What we know: After reconnect, the message shows stale data from the previous session
   - What's unclear: Whether the latency before the next natural `requestUpdate()` is acceptable
   - Recommendation: Yes, trigger an immediate `requestUpdate()` after reconnect with reset counters to clear stale data promptly

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis: `src/monitoring/status-message.ts`, `src/index.ts`, `src/hooks/handlers.ts`, `src/sessions/session-store.ts`, `src/types/sessions.ts`
- All findings verified against actual source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, pure internal change
- Architecture: HIGH - all integration points identified from source code
- Pitfalls: HIGH - race conditions and error paths analyzed from existing code

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable -- internal codebase only)
