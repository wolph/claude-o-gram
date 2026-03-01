# Milestones

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
