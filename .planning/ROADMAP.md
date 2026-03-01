# Roadmap: Claude Code Telegram Bridge

## Milestones

- [x] **v1.0 MVP** -- Phases 1-3 (shipped 2026-03-01)
- [x] **v2.0 SDK Input Migration** -- Phases 4-5 (shipped 2026-03-01)
- [ ] **v3.0 UX Overhaul** -- Phases 6-8 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-3) -- SHIPPED 2026-03-01</summary>

- [x] **Phase 1: Foundation** -- HTTP server, Telegram bot, session-to-topic lifecycle, message formatting, and rate limiting
- [x] **Phase 2: Monitoring** -- Tool call forwarding, text output capture, notifications, status dashboard, summaries, and verbosity filtering
- [x] **Phase 3: Control** -- Blocking approval flow with inline buttons, timeout handling, and bidirectional text input from Telegram

</details>

<details>
<summary>v2.0 SDK Input Migration (Phases 4-5) -- SHIPPED 2026-03-01</summary>

- [x] **Phase 4: SDK Resume Input** (2/2 plans) -- Replace tmux text injection with SDK query({ resume }) for reliable cross-platform input
- [x] **Phase 5: tmux Cleanup** (1/1 plan) -- Remove all tmux injection code, pane capture hook, and session type fields

</details>

### v3.0 UX Overhaul (In Progress)

**Milestone Goal:** Make Telegram output match Claude Code's terminal experience -- compact, clean, and controllable.

- [ ] **Phase 6: Compact Output & Session UX** - Terminal-fidelity tool display with expand/collapse, content store, clean status, and /clear topic reuse
- [ ] **Phase 7: Permission Modes** - Tiered auto-accept modes replacing binary approve/deny
- [ ] **Phase 8: Subagent Visibility** - Subagent lifecycle messages and agent-prefixed output

## Phase Details

### Phase 6: Compact Output & Session UX
**Goal**: Users see tool calls as clean terminal-matching one-liners with on-demand expand, no bot commentary, and /clear reuses the existing topic with a fresh status
**Depends on**: Phase 5 (existing output infrastructure)
**Requirements**: OUT-01, OUT-02, OUT-03, OUT-04, OUT-05, OUT-06, OUT-07, SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06
**Success Criteria** (what must be TRUE):
  1. Tool calls appear as single-line `Tool(args...)` messages, never multi-line verbose blocks; long calls truncate at 250 chars with an Expand button that edits in-place to show full content with Collapse
  2. No emoji status labels, no "waiting for input" commentary, no extra formatting around Claude's text output; pinned status uses compact format
  3. Expanded content is retrievable via LRU cache for the lifetime of the session
  4. Running /clear in Claude Code reuses the existing Telegram topic -- a visual separator appears, a new status message is pinned (old one unpinned), and session counters reset to zero
  5. SessionEnd with reason=clear keeps the topic open instead of closing/archiving it
**Plans:** 3 plans

Plans:
- [ ] 06-01-PLAN.md -- Compact formatter, expand cache module, batcher upgrade
- [ ] 06-02-PLAN.md -- Expand/collapse wiring, bot commentary cleanup, compact status
- [ ] 06-03-PLAN.md -- /clear session lifecycle with topic reuse

### Phase 7: Permission Modes
**Goal**: Users control how aggressively permissions are auto-approved, eliminating button-tap fatigue for trusted workflows
**Depends on**: Phase 6 (compact format for auto-approved permission display, ContentStore callback pattern)
**Requirements**: PERM-01, PERM-02, PERM-03, PERM-04, PERM-05, PERM-06, PERM-07, PERM-08, PERM-09
**Success Criteria** (what must be TRUE):
  1. Permission prompts wait indefinitely -- no auto-deny timeout surprises the user
  2. User can activate Accept All, Same Tool, Safe Only, or Until Done modes from Telegram, and the bot auto-approves matching tool calls without prompting
  3. A persistent Stop button is visible whenever any auto-accept mode is active, and tapping it returns to manual approval
  4. Auto-approved tool calls appear as compact `lightning Tool(args...)` lines (not silent) so the user sees what was approved; destructive commands (rm -rf, sudo, curl|bash) always prompt regardless of mode
  5. Permissions are visible locally via stdout before and after the decision
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Subagent Visibility
**Goal**: Users see when subagents spawn, what they do, and when they finish -- no more invisible background work
**Depends on**: Phase 7 (stable permission flow; Phase 6 compact format for agent-prefixed lines)
**Requirements**: AGENT-01, AGENT-02, AGENT-03, AGENT-04, AGENT-05, AGENT-06
**Success Criteria** (what must be TRUE):
  1. SubagentStart/SubagentStop hooks are registered; subagent spawn and completion are announced in the topic with agent name, type, and description
  2. Tool calls made during an active subagent are visually tagged with the agent's name prefix
  3. Subagent text output is visually tagged with the agent's name prefix
  4. Nested subagents (agent spawning agent) show stacked prefixes up to 2 levels deep
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 6 -> 7 -> 8

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 4/4 | Complete | 2026-02-28 |
| 2. Monitoring | v1.0 | 3/3 | Complete | 2026-03-01 |
| 3. Control | v1.0 | 2/2 | Complete | 2026-03-01 |
| 4. SDK Resume Input | v2.0 | 2/2 | Complete | 2026-03-01 |
| 5. tmux Cleanup | v2.0 | 1/1 | Complete | 2026-03-01 |
| 6. Compact Output & Session UX | v3.0 | 0/3 | Planned | - |
| 7. Permission Modes | v3.0 | 0/? | Not started | - |
| 8. Subagent Visibility | v3.0 | 0/? | Not started | - |
