# Roadmap: Claude Code Telegram Bridge

## Milestones

- [x] **v1.0 MVP** - Phases 1-3 (shipped 2026-03-01)
- [ ] **v2.0 SDK Input Migration** - Phases 4-5 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-3) - SHIPPED 2026-03-01</summary>

- [x] **Phase 1: Foundation** - HTTP server, Telegram bot, session-to-topic lifecycle, message formatting, and rate limiting
- [x] **Phase 2: Monitoring** - Tool call forwarding, text output capture, notifications, status dashboard, summaries, and verbosity filtering
- [x] **Phase 3: Control** - Blocking approval flow with inline buttons, timeout handling, and bidirectional text input from Telegram

</details>

**Phase Numbering:**
- Integer phases (4, 5): Planned milestone work
- Decimal phases (4.1, 4.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 4: SDK Resume Input** - Replace tmux text injection with SDK `query({ resume })` for reliable cross-platform input
- [ ] **Phase 5: tmux Cleanup** - Remove all tmux injection code, pane capture hook, and session type fields

## Phase Details

### Phase 4: SDK Resume Input
**Goal**: Users can send text input to Claude Code sessions via Telegram using the SDK resume API instead of tmux injection
**Depends on**: Phase 3 (v1.0 complete)
**Requirements**: SDK-01, SDK-02, SDK-03, REL-01, REL-02
**Success Criteria** (what must be TRUE):
  1. User sends a text message in a session topic and it arrives in Claude Code as a user prompt (via SDK resume, not tmux)
  2. User replies to a specific bot message and the quoted context is included in the input delivered to Claude Code
  3. Bot reacts to the user's message with a checkmark after input is successfully delivered
  4. Input works on any OS where Node.js runs (no tmux or terminal emulator dependency)
**Plans:** 2 plans
Plans:
- [x] 04-01-PLAN.md -- Install SDK deps, add API key config, create SdkInputManager
- [ ] 04-02-PLAN.md -- Wire SDK input into bot text handler and application lifecycle

### Phase 5: tmux Cleanup
**Goal**: All tmux-related code is removed so the codebase has no dead paths or unused dependencies
**Depends on**: Phase 4
**Requirements**: CLN-01, CLN-02, CLN-03
**Success Criteria** (what must be TRUE):
  1. The hook installer no longer references `capture-tmux-pane.sh` or installs any tmux-related hooks
  2. TextInputManager contains no tmux `send-keys` or `paste-buffer` code paths
  3. Session types and session store have no `tmuxPane` field
  4. The project builds cleanly and all existing functionality (topics, output, approvals, input) works after removal
**Plans:** 1 plan
Plans:
- [ ] 05-01-PLAN.md -- Remove all tmux code: types, store, handlers, hook installer, TextInputManager, bot fallback, index wiring

## Progress

**Execution Order:**
Phases execute in numeric order: 4 -> 5

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 4/4 | Complete | 2026-02-28 |
| 2. Monitoring | v1.0 | 3/3 | Complete | 2026-03-01 |
| 3. Control | v1.0 | 2/2 | Complete | 2026-03-01 |
| 4. SDK Resume Input | v2.0 | 1/2 | In progress | - |
| 5. tmux Cleanup | v2.0 | 0/1 | Not started | - |
