# Requirements: Claude Code Telegram Bridge

**Defined:** 2026-02-28
**Core Value:** See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Session Management

- [ ] **SESS-01**: Bot auto-creates a Telegram forum topic when a Claude Code session starts (via SessionStart hook)
- [ ] **SESS-02**: Bot auto-closes the topic when the Claude Code session ends (via SessionEnd hook)
- [ ] **SESS-03**: Bot auto-discovers new sessions without manual registration
- [ ] **SESS-04**: Concurrent sessions each get their own topic with isolated message routing
- [x] **SESS-05**: Each machine runs its own bot with a separate BotFather token, appearing as a distinct group member

### Monitoring

- [ ] **MNTR-01**: Tool calls (file reads, edits, bash commands) are posted to the session topic via PostToolUse hook
- [ ] **MNTR-02**: Claude's text output is captured by parsing JSONL transcript files and posted to the topic
- [ ] **MNTR-03**: Notification hook events (permission prompts, idle alerts) are forwarded to the topic
- [ ] **MNTR-04**: Messages are batched and queued to stay under Telegram's 20 msg/min rate limit
- [ ] **MNTR-05**: A live-updating status message in each topic shows remaining context window and quota usage (updated via editMessageText)
- [ ] **MNTR-06**: Periodic summary updates aggregate activity ("Working on X, 3 files edited")

### Control

- [ ] **CTRL-01**: PreToolUse hook blocks and posts permission questions to Telegram with inline Approve/Deny buttons
- [ ] **CTRL-02**: User can reply with custom text input from Telegram that feeds back into Claude Code
- [ ] **CTRL-03**: Blocked hooks auto-deny after a configurable timeout if no response is received

### UX

- [ ] **UX-01**: Messages use HTML formatting with code blocks for commands, bold for tool names
- [ ] **UX-02**: Outputs exceeding 4096 characters are sent as .txt document attachments
- [ ] **UX-03**: Users can configure verbosity to filter which events get posted to Telegram

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Multi-Agent

- **AGNT-01**: SubagentStart/Stop hooks tracked and posted to session topic
- **AGNT-02**: Subagent activity shown nested under parent session

### Resilience

- **RSLC-01**: Bot persists session state across restarts and reconnects to active sessions
- **RSLC-02**: Multi-machine dashboard topic showing all active sessions across all machines

## Out of Scope

| Feature | Reason |
|---------|--------|
| Starting Claude Code sessions from Telegram | Massively increases scope and security risk; monitor/control only |
| Central server / shared state | Each machine is self-contained; Telegram group IS the shared view |
| Multi-user access control | Single-user system; bot owner controls everything |
| Web dashboard | Telegram client IS the dashboard |
| Wrapping Claude Code in PTY/pipe | Fragile, breaks on updates; hooks + JSONL are the stable APIs |
| Real-time token-by-token streaming | Telegram rate limits (20 msg/min) make true streaming impossible |
| Plugin/extension system | Premature abstraction; build core first |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SESS-01 | Phase 1 | Pending |
| SESS-02 | Phase 1 | Pending |
| SESS-03 | Phase 1 | Pending |
| SESS-04 | Phase 1 | Pending |
| SESS-05 | Phase 1 | Complete |
| MNTR-01 | Phase 2 | Pending |
| MNTR-02 | Phase 2 | Pending |
| MNTR-03 | Phase 2 | Pending |
| MNTR-04 | Phase 1 | Pending |
| MNTR-05 | Phase 2 | Pending |
| MNTR-06 | Phase 2 | Pending |
| CTRL-01 | Phase 3 | Pending |
| CTRL-02 | Phase 3 | Pending |
| CTRL-03 | Phase 3 | Pending |
| UX-01 | Phase 1 | Pending |
| UX-02 | Phase 1 | Pending |
| UX-03 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-02-28 after roadmap creation*
