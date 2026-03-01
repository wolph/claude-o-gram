# Requirements: Claude Code Telegram Bridge v2.0

**Defined:** 2026-03-01
**Core Value:** See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## v2.0 Requirements

Replace tmux text injection with Claude Agent SDK for reliable, cross-platform input delivery.

### SDK Input

- [ ] **SDK-01**: Text input from Telegram is delivered to Claude Code via SDK `query({ resume })` instead of tmux injection
- [ ] **SDK-02**: SDK input works cross-platform (no tmux dependency for text delivery)
- [ ] **SDK-03**: Quoted message context is included when user replies to a specific bot message

### Reliability

- [ ] **REL-01**: Text input reliably submits (no more "flash and disappear" tmux issues)
- [ ] **REL-02**: Input delivery confirms success via message reaction

### Cleanup

- [ ] **CLN-01**: tmux pane capture hook (`capture-tmux-pane.sh`) removed from hook installer
- [ ] **CLN-02**: TextInputManager tmux injection code removed
- [ ] **CLN-03**: tmuxPane field removed from session types and store

## Future Requirements

Deferred to v2.1+.

### Full SDK Migration

- **FSDK-01**: Bot manages Claude Code sessions directly via SDK `query()`
- **FSDK-02**: SDK streaming output replaces JSONL transcript file watching
- **FSDK-03**: SDK event callbacks replace HTTP hook server
- **FSDK-04**: SDK `canUseTool` callback replaces deferred-promise approval flow

### New Features

- **FEAT-01**: Start Claude Code sessions from Telegram
- **FEAT-02**: Multi-machine dashboard topic
- **FEAT-03**: Subagent tracking (SubagentStart/Stop hooks)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full SDK session management | Deferred to v2.1 — keep external session model for now |
| Removing Fastify hook server | Still needed for session discovery and tool call events |
| Removing transcript watcher | Still needed for Claude text output capture |
| V2 preview API (`unstable_v2_*`) | Unstable, silently ignores critical options (#176) |
| Streaming input mode | Double-turn bug (#207) doubles token costs |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SDK-01 | TBD | Pending |
| SDK-02 | TBD | Pending |
| SDK-03 | TBD | Pending |
| REL-01 | TBD | Pending |
| REL-02 | TBD | Pending |
| CLN-01 | TBD | Pending |
| CLN-02 | TBD | Pending |
| CLN-03 | TBD | Pending |

**Coverage:**
- v2.0 requirements: 8 total
- Mapped to phases: 0 (pending roadmap)
- Unmapped: 8

---
*Requirements defined: 2026-03-01*
*Last updated: 2026-03-01 after initial definition*
