# Requirements: Claude Code Telegram Bridge

**Defined:** 2026-03-01
**Core Value:** See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## v3.0 Requirements

Requirements for v3.0 UX Overhaul. Each maps to roadmap phases.

### Output Formatting

- [ ] **OUT-01**: Tool calls displayed as `Tool(args...)` single-line, max 250 chars
- [ ] **OUT-02**: Tool calls exceeding 250 chars truncated with expand button
- [ ] **OUT-03**: Expand button edits message in-place showing full content with collapse button
- [ ] **OUT-04**: Expand content stored in LRU cache (evicted after session end or size limit)
- [ ] **OUT-05**: Bot commentary removed (no "waiting for input", no emoji status labels)
- [ ] **OUT-06**: Claude's text output posted directly without extra formatting
- [ ] **OUT-07**: Pinned status message uses compact format (no emoji)

### Permissions

- [ ] **PERM-01**: No permission timeout — wait indefinitely for user decision
- [ ] **PERM-02**: Accept All mode — auto-approve everything until manually stopped
- [ ] **PERM-03**: Same Tool mode — auto-approve only matching tool name until stopped
- [ ] **PERM-04**: Safe Only mode — auto-approve green-risk tools, prompt for yellow/red
- [ ] **PERM-05**: Until Done mode — auto-approve everything until Claude's turn ends
- [ ] **PERM-06**: Sticky control message with Stop button when any auto-accept mode is active
- [ ] **PERM-07**: Auto-approved permissions shown as compact `⚡ Tool(args...)` line
- [ ] **PERM-08**: Permissions visible locally via stdout before and after decision
- [ ] **PERM-09**: Dangerous command blocklist prevents auto-accept of destructive patterns (rm -rf, sudo, curl|bash)

### Session Management

- [ ] **SESS-01**: /clear reuses existing topic instead of creating new one
- [ ] **SESS-02**: Visual separator posted on /clear: `─── context cleared ───`
- [ ] **SESS-03**: New pinned status message posted after /clear
- [ ] **SESS-04**: Old status message unpinned on /clear
- [ ] **SESS-05**: Session counters (tools, files, duration) reset on /clear
- [ ] **SESS-06**: SessionEnd with reason=clear keeps topic open (no close/archive)

### Subagent Visibility

- [ ] **AGENT-01**: SubagentStart/SubagentStop hooks registered in hook installer
- [ ] **AGENT-02**: Subagent spawn shown: `▶ Agent(name) spawned — "description"` with type
- [ ] **AGENT-03**: Subagent completion shown: `✓ Agent(name) done`
- [ ] **AGENT-04**: Subagent tool calls tagged with agent prefix: `▸ [name] Tool(args...)`
- [ ] **AGENT-05**: Subagent text output tagged with agent prefix: `▸ [name] text...`
- [ ] **AGENT-06**: Nested subagents use stacked prefix: `▸▸ [inner]` (max 2 levels)

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### SDK Migration

- **SDK-01**: Replace hook server with SDK streaming output
- **SDK-02**: Replace PreToolUse hooks with SDK canUseTool callback
- **SDK-03**: Remove Fastify dependency (SDK handles all I/O)

### Remote Control

- **CTRL-01**: Start new Claude Code sessions from Telegram
- **CTRL-02**: Multi-machine dashboard
- **CTRL-03**: Full SDK session management (bot-controlled sessions)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| SDK streaming output | Separate migration milestone (v4.0) |
| SDK canUseTool callback | Separate migration milestone (v4.0) |
| Starting sessions from Telegram | Different feature domain, deferred |
| Multi-machine dashboard | Different feature domain, deferred |
| Multi-user access control | Single-user system by design |
| Central server architecture | Each machine runs its own bot |
| Transcript watcher removal | Still needed for text output capture |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| OUT-01 | Phase 6 | Pending |
| OUT-02 | Phase 6 | Pending |
| OUT-03 | Phase 6 | Pending |
| OUT-04 | Phase 6 | Pending |
| OUT-05 | Phase 6 | Pending |
| OUT-06 | Phase 6 | Pending |
| OUT-07 | Phase 6 | Pending |
| PERM-01 | Phase 7 | Pending |
| PERM-02 | Phase 7 | Pending |
| PERM-03 | Phase 7 | Pending |
| PERM-04 | Phase 7 | Pending |
| PERM-05 | Phase 7 | Pending |
| PERM-06 | Phase 7 | Pending |
| PERM-07 | Phase 7 | Pending |
| PERM-08 | Phase 7 | Pending |
| PERM-09 | Phase 7 | Pending |
| SESS-01 | Phase 8 | Pending |
| SESS-02 | Phase 8 | Pending |
| SESS-03 | Phase 8 | Pending |
| SESS-04 | Phase 8 | Pending |
| SESS-05 | Phase 8 | Pending |
| SESS-06 | Phase 8 | Pending |
| AGENT-01 | Phase 9 | Pending |
| AGENT-02 | Phase 9 | Pending |
| AGENT-03 | Phase 9 | Pending |
| AGENT-04 | Phase 9 | Pending |
| AGENT-05 | Phase 9 | Pending |
| AGENT-06 | Phase 9 | Pending |

**Coverage:**
- v3.0 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---
*Requirements defined: 2026-03-01*
*Last updated: 2026-03-01 after roadmap creation*
