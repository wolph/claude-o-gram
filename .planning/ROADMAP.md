# Roadmap: Claude Code Telegram Bridge

## Milestones

- [x] **v1.0 MVP** — Phases 1-3 (shipped 2026-03-01)
- [x] **v2.0 SDK Input Migration** — Phases 4-5 (shipped 2026-03-01)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-3) — SHIPPED 2026-03-01</summary>

- [x] **Phase 1: Foundation** — HTTP server, Telegram bot, session-to-topic lifecycle, message formatting, and rate limiting
- [x] **Phase 2: Monitoring** — Tool call forwarding, text output capture, notifications, status dashboard, summaries, and verbosity filtering
- [x] **Phase 3: Control** — Blocking approval flow with inline buttons, timeout handling, and bidirectional text input from Telegram

</details>

<details>
<summary>v2.0 SDK Input Migration (Phases 4-5) — SHIPPED 2026-03-01</summary>

- [x] **Phase 4: SDK Resume Input** (2/2 plans) — Replace tmux text injection with SDK query({ resume }) for reliable cross-platform input
- [x] **Phase 5: tmux Cleanup** (1/1 plan) — Remove all tmux injection code, pane capture hook, and session type fields

</details>

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 4/4 | Complete | 2026-02-28 |
| 2. Monitoring | v1.0 | 3/3 | Complete | 2026-03-01 |
| 3. Control | v1.0 | 2/2 | Complete | 2026-03-01 |
| 4. SDK Resume Input | v2.0 | 2/2 | Complete | 2026-03-01 |
| 5. tmux Cleanup | v2.0 | 1/1 | Complete | 2026-03-01 |
