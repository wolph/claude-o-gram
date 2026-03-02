# Phase 9: Color-Coded Topic Status - Research

**Researched:** 2026-03-02
**Domain:** Telegram Bot API editForumTopic, real-time status indicators
**Confidence:** HIGH

## Summary

Phase 9 replaces the static green emoji prefix on topic names with a four-state color system (green/yellow/red/gray) that reflects session lifecycle in real time. The key technical challenges are: (1) consolidating all `editForumTopic` calls through a single debounced path to avoid rate limits, (2) correctly mapping Claude Code hook events to status transitions (especially "waiting for input" vs "processing"), and (3) implementing a startup gray sweep that sequentially updates all stale active topics.

The existing codebase already has a strong pattern for debounced API calls (`StatusMessage` with 3-second intervals) and topic name editing (`TopicManager.editTopicName`). The main work is centralizing the five existing `editForumTopic` call sites into a single `TopicStatusManager` class with a status cache and debounce, then wiring hook callbacks to trigger appropriate status transitions.

**Primary recommendation:** Create a dedicated `TopicStatusManager` class that owns all topic name mutations, with a `Map<threadId, status>` cache and configurable debounce. Wire it into the existing hook callback chain at well-defined transition points.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Green (🟢)**: Session is waiting for user input -- Claude is idle, awaiting a prompt or permission decision
- **Yellow (🟡)**: Claude is actively processing -- generating output, running tools, thinking. Stays yellow for the entire turn, not per-tool
- **Red (🔴)**: Context window exhaustion at 95%+ threshold (only reliable error signal currently available)
- **Gray (⚪)**: Session is down/offline -- bot restarted, session crashed, or session not yet reconnected
- Transition frequency: green<->yellow flips per Claude turn (not per tool call) to reduce editForumTopic calls
- Format: `{emoji} {project-name}` -- clean, no context% in topic name
- Context percentage stays exclusively in the pinned status message
- Removes the current `🟢 project-name | 45% ctx` pattern from `StatusMessage.updateTopicDescription()`
- Normal session end: keep ✅ prefix (existing behavior) -- means "completed normally"
- Gray means "down/disconnected/crashed" -- different semantic from "done"
- Two inactive states: ✅ = completed, ⚪ = down. Green/yellow = alive.
- Startup gray sweep: only sessions marked 'active' in sessions.json -- set their topic names to gray prefix
- Leave properly closed (✅) topics untouched
- Sequential sweep with brief delay between calls (not Promise.all) to avoid rate limits
- After sweep, proceed with normal reconnect logic
- All topic name changes must flow through a single debounced path
- Add `topicStatusCache` (Map<threadId, status>) to skip no-op API calls
- Remove `StatusMessage.updateTopicDescription()` -- topic name updates move to centralized method

### Claude's Discretion
- Debounce interval for editForumTopic calls (research recommends 3-5 seconds)
- Whether to use a separate TopicStatusManager class or extend TopicManager
- Exact gray emoji choice (⚪ vs ⬜ vs other gray variant)
- Error handling for failed editForumTopic calls during status transitions

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| STAT-01 | Active/ready sessions display green emoji prefix in topic name | TopicStatusManager.setStatus(threadId, 'green') called on session start, on Stop hook (turn ends), and after approval resolves |
| STAT-02 | Down/offline sessions display gray emoji prefix in topic name | Startup gray sweep sets all 'active' sessions to gray before reconnect; crash/disconnect leaves topic in last pre-crash state, which the NEXT startup sweep will gray-ify |
| STAT-03 | Busy sessions display yellow emoji prefix when processing tools | Status set to yellow on first PreToolUse/PostToolUse of a turn; stays yellow until Stop hook fires |
| STAT-04 | Error sessions display red emoji prefix in topic name | Red triggered when contextPercent >= 95 (from transcript watcher usage callback) |
| STAT-05 | On bot startup, all existing session topics are set to gray status | Sequential loop over getActiveSessions() with per-call delay, before reconnect logic |
| STAT-06 | Status emoji changes are debounced to prevent editForumTopic rate limits | TopicStatusManager with 3-second debounce interval and status cache to skip no-op calls |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | ^1.40.1 | Telegram Bot API | Already in use; `bot.api.editForumTopic()` is the only API needed for topic name changes |
| @grammyjs/auto-retry | ^2.0.2 | Transparent 429 handling | Already configured as Layer 1 rate limiting; will handle editForumTopic retries |
| @grammyjs/transformer-throttler | ^1.2.1 | Bottleneck-based API throttling | Already configured; editForumTopic calls pass through this layer |

### Supporting
No new libraries needed. All functionality builds on existing grammY stack.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom TopicStatusManager | Extend TopicManager directly | Separate class is cleaner: TopicManager handles CRUD, TopicStatusManager handles status transitions + debounce. Mixing concerns would bloat TopicManager |
| 3-second debounce | Lower interval (1s) | Telegram rate limits for editForumTopic are approximately 1 call/3 seconds per topic in groups. 3 seconds matches the existing StatusMessage.MIN_UPDATE_INTERVAL_MS pattern |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── monitoring/
│   ├── status-message.ts       # MODIFIED: remove updateTopicDescription()
│   └── topic-status.ts         # NEW: TopicStatusManager class
├── bot/
│   └── topics.ts               # MODIFIED: remove hardcoded emoji prefixes
└── index.ts                    # MODIFIED: wire TopicStatusManager into callbacks
```

### Pattern 1: Centralized Status Manager with Debounce
**What:** A `TopicStatusManager` class that owns all topic name status updates, with per-topic debounce and a no-op cache.
**When to use:** Any time the topic name's emoji prefix needs to change.
**Example:**
```typescript
// Source: Modeled on existing StatusMessage debounce pattern (status-message.ts:82-93)
type TopicStatus = 'green' | 'yellow' | 'red' | 'gray';

class TopicStatusManager {
  private static readonly DEBOUNCE_MS = 3000;
  private statusCache = new Map<number, TopicStatus>();
  private pendingStatus = new Map<number, TopicStatus>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private topicNames = new Map<number, string>();

  constructor(private bot: Bot, private chatId: number) {}

  setStatus(threadId: number, status: TopicStatus): void {
    // Skip no-op
    if (this.statusCache.get(threadId) === status) return;

    this.pendingStatus.set(threadId, status);

    // Debounce: only flush after DEBOUNCE_MS of quiet
    const existing = this.timers.get(threadId);
    if (existing) clearTimeout(existing);

    this.timers.set(threadId, setTimeout(() => {
      void this.flush(threadId);
    }, TopicStatusManager.DEBOUNCE_MS));
  }

  private async flush(threadId: number): Promise<void> {
    const status = this.pendingStatus.get(threadId);
    if (!status) return;
    this.pendingStatus.delete(threadId);
    this.timers.delete(threadId);

    // Double-check cache after debounce
    if (this.statusCache.get(threadId) === status) return;

    const emoji = STATUS_EMOJIS[status];
    const name = this.topicNames.get(threadId) ?? '';
    const fullName = `${emoji} ${name}`;

    try {
      await this.bot.api.editForumTopic(this.chatId, threadId, {
        name: fullName.slice(0, 128),
      });
      this.statusCache.set(threadId, status);
    } catch (err) {
      console.warn('TopicStatus: failed to update:', err instanceof Error ? err.message : err);
    }
  }
}

const STATUS_EMOJIS: Record<TopicStatus, string> = {
  green: '\u{1F7E2}',  // 🟢
  yellow: '\u{1F7E1}', // 🟡
  red: '\u{1F534}',    // 🔴
  gray: '\u26AA',      // ⚪
};
```

### Pattern 2: Status Transition State Machine
**What:** Clear mapping of hook events to status transitions.
**When to use:** Every hook callback must know which status to set.

| Event | Current Status | New Status | Why |
|-------|---------------|------------|-----|
| SessionStart (new/resume) | - | green | Session starts ready for input |
| SessionStart (clear) | - | green | Same as new -- fresh context |
| PostToolUse / PreToolUse | green/yellow | yellow | Claude is working (stays yellow for entire turn) |
| Stop hook | yellow | green | Turn complete, waiting for next user input |
| PreToolUse approval wait | yellow | green | Blocked on user decision = waiting for input |
| Approval resolved | green | yellow | Back to processing after user decides |
| Context >= 95% | any active | red | Error state (from transcript watcher) |
| SessionEnd (normal) | any | (keep ✅) | Handled by TopicManager.closeTopic() |
| Bot startup (gray sweep) | any active | gray | Mark all as offline until proven alive |
| Reconnect after sweep | gray | green | Session confirmed alive |

### Pattern 3: Startup Gray Sweep
**What:** Sequential iteration over active sessions on startup with delay between API calls.
**When to use:** Once during `main()` initialization, before reconnect loop.
**Example:**
```typescript
// In main(), BEFORE the existing reconnect loop (line 816)
const activeSessions = sessionStore.getActiveSessions();
for (const session of activeSessions) {
  if (session.threadId > 0) {
    await topicStatusManager.setStatusImmediate(session.threadId, 'gray', session.topicName);
    // Brief delay to avoid rate limits during sequential sweep
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
// THEN proceed with existing reconnect loop
```

### Anti-Patterns to Avoid
- **Updating topic name on every tool call:** Would cause 10-100x more API calls than needed. Yellow should be set once at the START of a turn, not per-tool.
- **Promise.all for gray sweep:** Parallel API calls to editForumTopic would trigger rate limits immediately with >3 active sessions.
- **Splitting editForumTopic across TopicManager and StatusMessage:** The current dual-path (TopicManager.editTopicName + StatusMessage.updateTopicDescription) is what causes the consolidation need. Don't add a third path.
- **Using icon_color for topics:** Telegram API does not support changing icon_color after topic creation. Only the topic name can be edited. This is listed in the project's Out of Scope requirements.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| API rate limiting | Custom rate limiter for editForumTopic | grammY auto-retry + transformer-throttler (already configured) | Layer 1 handles 429s transparently; our debounce is Layer 2 (reducing call volume) |
| Timer management | Custom timer tracking | setTimeout/clearTimeout pattern from StatusMessage | Proven in production, matches existing codebase style |

## Common Pitfalls

### Pitfall 1: editForumTopic Rate Limits
**What goes wrong:** Telegram returns 429 Too Many Requests when editForumTopic is called too frequently for the same topic.
**Why it happens:** editForumTopic has stricter rate limits than sendMessage. In groups, roughly 1 call per 3 seconds per topic.
**How to avoid:** Debounce at 3 seconds per topic + no-op cache. The grammY auto-retry plugin handles occasional 429s transparently.
**Warning signs:** "Too Many Requests: retry after N" errors in logs.

### Pitfall 2: Status Race Conditions During Turn Transitions
**What goes wrong:** Yellow status arrives AFTER the Stop hook has already set green, causing the topic to show yellow when Claude is actually idle.
**Why it happens:** PostToolUse events may be queued/in-flight when Stop fires. The debounce timer from the last PostToolUse could flush after the Stop handler sets green.
**How to avoid:** When setting green (on Stop), cancel any pending yellow debounce timer first. The `setStatus` method already replaces pending status, so the last writer wins. But ensure Stop hook sets status synchronously (not debounced) to avoid the window.
**Warning signs:** Topic shows yellow when Claude is idle.

### Pitfall 3: Gray Emoji Selection
**What goes wrong:** Using ⬜ (white large square U+2B1C) or other variants that render differently across platforms.
**Why it happens:** Emoji rendering varies across iOS/Android/desktop Telegram clients.
**How to avoid:** Use ⚪ (U+26AA, "medium white circle") -- it's a standard emoji that renders consistently as a gray/white circle across all platforms. It contrasts well with 🟢🟡🔴 in the topic list.
**Warning signs:** Emoji appears as a square or different shape on some clients.

### Pitfall 4: Topic Name Prefix Stripping
**What goes wrong:** When updating status, the old emoji prefix isn't properly stripped, leading to accumulating emojis like "🟡 🟢 project-name".
**Why it happens:** The topic name stored in sessions.json may or may not include the emoji prefix depending on when it was saved.
**How to avoid:** Store the CLEAN topic name (without emoji) in `topicNames` map inside TopicStatusManager. Always construct the full name as `${emoji} ${cleanName}`. Never parse existing topic names to extract the prefix.
**Warning signs:** Topic names growing longer with each status change.

### Pitfall 5: Red Status Conflicts with Yellow/Green Transitions
**What goes wrong:** Context hits 95%, topic goes red, but then Stop hook sets it back to green.
**Why it happens:** The 95% threshold triggers in the transcript watcher callback, but the session lifecycle continues normally.
**How to avoid:** Red is a "sticky" status -- once set, only green (from next turn start after user acknowledges) or gray (from shutdown) should override it. Add a `stickyRed` flag per thread that prevents green/yellow transitions until the next turn starts.
**Warning signs:** Topic flickers between red and green/yellow rapidly.

## Code Examples

### Example 1: TopicStatusManager Integration Points

```typescript
// In index.ts onSessionStart callback:
topicStatusManager.registerTopic(session.threadId, session.topicName);
topicStatusManager.setStatus(session.threadId, 'green');

// In onToolUse callback (replaces updateTopicDescription call):
topicStatusManager.setStatus(session.threadId, 'yellow');

// In onStop callback:
topicStatusManager.setStatus(session.threadId, 'green');

// In onPreToolUse (when waiting for user approval):
topicStatusManager.setStatus(session.threadId, 'green'); // Blocked = waiting

// In transcript watcher (95% context):
topicStatusManager.setStatus(session.threadId, 'red');

// In onSessionEnd:
// Don't set status -- closeTopic() handles the ✅ prefix
topicStatusManager.unregisterTopic(session.threadId);
```

### Example 2: Removing updateTopicDescription from StatusMessage

```typescript
// BEFORE (in onToolUse callback, index.ts ~line 644-648):
monitor.statusMessage.updateTopicDescription(
  `🟢 ${latestSession.topicName} | ${ctx}% ctx`,
);

// AFTER: Remove these lines entirely.
// Topic status is now handled by topicStatusManager.setStatus()
// Context percentage remains in the pinned status message only
```

### Example 3: Modifying TopicManager to Accept Emoji Parameter

```typescript
// BEFORE: Hardcoded 🟢 in createTopic
async createTopic(name: string): Promise<number> {
  const topic = await this.bot.api.createForumTopic(this.chatId, '🟢 ' + name);
  return topic.message_thread_id;
}

// AFTER: Accept optional emoji override, default to no prefix (TopicStatusManager handles it)
async createTopic(name: string, statusEmoji?: string): Promise<number> {
  const prefix = statusEmoji ? statusEmoji + ' ' : '';
  const topic = await this.bot.api.createForumTopic(this.chatId, prefix + name);
  return topic.message_thread_id;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static 🟢 prefix on all active topics | Dynamic 4-state emoji status | This phase | Users see session state without opening topics |
| Context % in topic name (`🟢 name \| 45% ctx`) | Context % only in pinned message | This phase | Reduces editForumTopic calls, cleaner topic names |
| Multiple editForumTopic call paths (5 sites) | Single centralized TopicStatusManager | This phase | Eliminates rate limit risk from competing callers |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None currently -- no test infrastructure exists |
| Config file | None |
| Quick run command | N/A |
| Full suite command | N/A |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STAT-01 | Green emoji on active/ready sessions | manual | Visual check: start session, verify topic shows 🟢 | N/A |
| STAT-02 | Gray emoji on down/offline sessions | manual | Visual check: restart bot, verify topics show ⚪ | N/A |
| STAT-03 | Yellow emoji when processing | manual | Visual check: send prompt, verify topic shows 🟡 during processing | N/A |
| STAT-04 | Red emoji on context exhaustion | manual | Visual check: fill context to 95%, verify topic shows 🔴 | N/A |
| STAT-05 | Startup gray sweep | manual | Visual check: restart bot with active sessions | N/A |
| STAT-06 | Debounced status changes | manual | Visual check: rapid tool calls don't cause rate limit errors in logs | N/A |

### Sampling Rate
- **Per task commit:** TypeScript compilation (`npx tsc --noEmit`)
- **Per wave merge:** Build + manual smoke test
- **Phase gate:** Full UAT with all 6 requirements verified

### Wave 0 Gaps
None -- this project has no automated test infrastructure. All validation is manual UAT + TypeScript compilation. No test framework setup needed.

## Sources

### Primary (HIGH confidence)
- Codebase analysis of `src/bot/topics.ts` (5 editForumTopic call sites identified)
- Codebase analysis of `src/monitoring/status-message.ts` (debounce pattern, updateTopicDescription method)
- Codebase analysis of `src/index.ts` (all hook callbacks, startup reconnect loop, monitoring initialization)
- Codebase analysis of `src/hooks/handlers.ts` (session lifecycle event flow)

### Secondary (MEDIUM confidence)
- Telegram Bot API: editForumTopic rate limits (~1 call/3 seconds per topic based on community experience and existing code using 3-second debounce)
- grammY documentation: auto-retry and transformer-throttler handle 429s at Layer 1

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, builds entirely on existing grammY stack
- Architecture: HIGH -- patterns directly extend existing StatusMessage debounce approach
- Pitfalls: HIGH -- rate limit concern is the primary technical risk, well-understood from existing code
- Status transitions: HIGH -- hook events are well-documented in the codebase

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable domain, no external dependencies changing)
