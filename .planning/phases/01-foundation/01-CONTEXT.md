# Phase 1: Foundation - Context

**Gathered:** 2026-02-28
**Status:** Ready for planning

<domain>
## Phase Boundary

HTTP server receiving Claude Code hook POSTs, Telegram bot with forum topic lifecycle, session-to-topic routing, HTML message formatting, rate limit protection, and file attachment fallback for large outputs. This is the plumbing layer that all monitoring and control features (Phases 2-3) build on.

</domain>

<decisions>
## Implementation Decisions

### Topic Naming & Presentation
- Topic name uses session description if available, falls back to project directory name
- Machine name is implicit (the bot IS the machine identity in the group)
- Topic name updates if the user runs /rename in Claude Code
- Post a final summary message before closing topic (duration, files changed, tools used)
- Use status emojis as visual indicators (green circle active, checkmark done)

### Bot Setup Experience
- Configuration via both config file and environment variables — env vars override config file defaults
- Simple startup via `node src/index.js` — user manages how to keep it running (systemd, pm2, etc.)
- Bot auto-installs Claude Code hooks by writing hook config to Claude Code's settings on first run
- On first run with missing config, show clear error with setup steps (no interactive wizard)

### Message Style
- Tiered verbosity: compact one-liners for reads/searches, detailed structured blocks for edits/bash commands
- Smart output splitting: short output inline, medium in code block, long as .txt file attachment
- Use emojis per tool type (📝 edits, 👁 reads, 💻 bash, ✅ success, ❌ errors)
- Show diffs for file edits: old_string → new_string in code blocks

### Session Lifecycle
- On bot restart: reconnect to existing topics from saved session map + post "Bot restarted" notification in active topics
- On session resume (--resume): reuse the old topic — reopen it and continue posting there
- Health check via on-demand /status command sent to the bot (no periodic heartbeat spam)
- Duplicate sessions in same directory: append start timestamp for disambiguation, e.g. "my-project (14:32)"

### Claude's Discretion
- Exact HTML formatting templates and message structure
- Rate limit batching strategy (debounce timing, batch window size)
- Session map storage format and persistence mechanism
- Error handling for Telegram API failures

</decisions>

<specifics>
## Specific Ideas

- Each machine's bot appears as a distinct member in the shared Telegram group — the bot's name IS the machine identity
- HTTP hooks (`type: "http"`) POST directly to the bot's Fastify server — no shell scripts or IPC layer needed
- The bot daemon is a single process running both the Fastify HTTP server (for hooks) and the grammY Telegram bot
- Research found that Telegram rate limit is 20 msg/min per group — batching must be baked into the foundation, not added later

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-02-28*
