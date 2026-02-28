# Phase 2: Monitoring - Context

**Gathered:** 2026-02-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Passive observation of Claude Code activity from Telegram. Users see every tool call, text response, and notification in their session topic, with a live-updating status indicator and periodic summaries. Verbosity is configurable. This phase is read-only observation — interactive control (approve/deny, text input) belongs in Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Message Verbosity & Filtering
- Three verbosity tiers: Minimal (edits/bash only), Normal (all except reads/globs), Verbose (everything)
- Default tier: Normal
- Fixed tier mapping — we define which tools go in which tier, not user-configurable
- Change verbosity via Telegram commands (/verbose, /normal, /quiet) in the session topic at runtime
- Env var sets the default verbosity, Telegram command overrides per-session
- Suppressed calls are tracked via silent counter — periodic summary reports "12 Read calls, 3 Glob calls suppressed"

### Live Status Indicator
- Pinned first message in each topic, updated in place with editMessageText
- Shows: context window usage (%), current tool being run, session duration, tool call count
- Updates on every PostToolUse event (real-time, no polling)
- Also update topic description with compact status (e.g., "Active | 45% ctx") via editForumTopic
- Context window data parsed from JSONL transcript file (extract token counts from API responses)

### Text Output & Transcript Parsing
- Post Claude's direct assistant messages (user-facing responses), skip internal thinking/tool-use reasoning
- Long text blocks: truncate to ~500 chars inline, attach full text as .txt if exceeded (same pattern as Phase 1)
- Watch transcript file with fs.watch + tail approach — event-driven, read new lines as appended
- Periodic summaries every ~5 minutes of activity: "Working on X — edited 3 files, ran 2 commands, 45% context used"

### Notification Style & Urgency
- Permission prompts use alert box style: bold header with warning emoji, tool name, what it wants to do — visually distinct from regular tool calls
- Three urgency levels with different emoji/formatting:
  - Info (context updates, status changes)
  - Warning (permission prompts, high context usage)
  - Error (crashes, timeouts, failures)
- Idle alerts: post notification after ~2 minutes of no activity — "Claude appears idle — may be waiting for input or thinking". Configurable timeout.
- Context usage warnings at 80% and 95% thresholds — separate notification messages, not just status update

### Claude's Discretion
- Exact JSONL transcript parsing implementation and which fields to extract
- fs.watch debounce strategy for rapid file changes
- Periodic summary message formatting and content aggregation
- How to handle transcript file rotation or unavailability
- editMessageText rate limiting strategy (separate from message sending rate limit)

</decisions>

<specifics>
## Specific Ideas

- Verbosity commands should respond with confirmation in the topic: "Verbosity set to quiet — showing edits and bash only"
- Periodic summaries should feel like a status update, not a wall of text — compact, scannable
- Permission prompt notifications should be clearly distinguishable at a glance from normal tool calls (Phase 3 will add interactive buttons to these)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-monitoring*
*Context gathered: 2026-02-28*
