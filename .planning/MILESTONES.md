# Milestones

## v4.0 Status & Settings (Shipped: 2026-03-02)

**Phases:** 9-12 (4 phases, 6 plans, 10 feat commits)
**Audit:** Passed — 19/19 requirements, 4/4 E2E flows
**Stats:** 10 files changed, +812/-109 lines, 6,499 LOC TypeScript

**Key accomplishments:**
- Color-coded topic status: four-state emoji prefixes (green/yellow/red/gray) with per-topic debounced editForumTopic calls
- Startup gray sweep: all existing session topics automatically set to gray on bot startup before reconnect
- Sub-agent suppression: 5 gated call sites silence all sub-agent output by default (SUBAGENT_VISIBLE=true to restore)
- Sticky message dedup: StatusMessage.reconnect() adopts existing pinned messages on /clear and restart
- Settings topic: dedicated Telegram topic with inline keyboard for sub-agent visibility toggle and permission mode selection
- RuntimeSettings + BotStateStore: mutable config layer with atomic persistence, enabling immediate settings changes without restart

**Tech debt:** SettingsTopic.refresh() dead code (low severity)

**Archive:** [milestones/v4.0-ROADMAP.md](milestones/v4.0-ROADMAP.md)

---

## v3.0 UX Overhaul (Shipped: 2026-03-02)

**Phases:** 6-8 (3 phases, 8 plans, 16 feat commits)
**Audit:** Passed — 28/28 requirements, 5/5 E2E flows
**UAT:** Phase 7 (10/10 pass), Phase 8 (6/6 pass)
**Stats:** 45 files changed, +7,461/-408 lines, 5,760 LOC TypeScript

**Key accomplishments:**
- Compact tool format with expand/collapse: tool calls display as `Tool(args...)` one-liners with LRU-cached expand/collapse buttons
- Terminal-fidelity output: removed all bot commentary, emoji labels, and verbose formatting
- /clear topic reuse: running /clear reuses existing topic with separator, new pin, and reset counters (works around upstream hook bug #6428)
- Permission modes: Accept All, Same Tool, Safe Only, Until Done with persistent Stop button and dangerous command blocklist
- Subagent visibility: spawn/done announcements, agent-prefixed tool calls and text output, nested subagent support up to 2 levels

**Archive:** [milestones/v3.0-ROADMAP.md](milestones/v3.0-ROADMAP.md)

---

## v2.0 SDK Input Migration (Shipped: 2026-03-01)

**Phases:** 4-5 (2 phases, 3 plans, 6 tasks)
**Audit:** Passed — 8/8 requirements satisfied, 3 tech debt items

**Key accomplishments:**
- Replaced tmux text injection with Claude Agent SDK `query({ resume })` for reliable cross-platform input delivery
- Created SdkInputManager with per-session serialization and 5-minute AbortController timeouts
- Rewired bot text handler to SDK-only path with message reaction confirmation
- Removed all tmux code: TextInputManager, tmuxPane field, command hook installer
- Zero tmux references remain in `src/` — project builds clean

**Tech debt accepted:**
- README.md still describes tmux architecture
- .env.example missing ANTHROPIC_API_KEY
- config.anthropicApiKey field stored but unused (SDK reads env directly)

**Archive:** [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

---

## v1.0 MVP (Shipped: 2026-03-01)

**Phases:** 1-3 (3 phases, 9 plans)

**Key accomplishments:**
- HTTP hook server with session-to-topic lifecycle
- Tool call forwarding with verbosity filtering
- Text output capture via transcript watching
- Blocking approval flow with inline Telegram buttons
- Bidirectional text input from Telegram

---
