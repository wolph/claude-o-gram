# Roadmap: Claude Code Telegram Bridge

## Milestones

- ✅ **v1.0 MVP** — Phases 1-3 (shipped 2026-03-01)
- ✅ **v2.0 SDK Input Migration** — Phases 4-5 (shipped 2026-03-01)
- ✅ **v3.0 UX Overhaul** — Phases 6-8 (shipped 2026-03-02)
- **v4.0 Status & Settings** — Phases 9-12 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-3) — SHIPPED 2026-03-01</summary>

- [x] **Phase 1: Foundation** (4/4 plans) — HTTP server, Telegram bot, session-to-topic lifecycle, message formatting, and rate limiting
- [x] **Phase 2: Monitoring** (3/3 plans) — Tool call forwarding, text output capture, notifications, status dashboard, summaries, and verbosity filtering
- [x] **Phase 3: Control** (2/2 plans) — Blocking approval flow with inline buttons, timeout handling, and bidirectional text input from Telegram

</details>

<details>
<summary>✅ v2.0 SDK Input Migration (Phases 4-5) — SHIPPED 2026-03-01</summary>

- [x] **Phase 4: SDK Resume Input** (2/2 plans) — Replace tmux text injection with SDK query({ resume }) for reliable cross-platform input
- [x] **Phase 5: tmux Cleanup** (1/1 plan) — Remove all tmux injection code, pane capture hook, and session type fields

</details>

<details>
<summary>✅ v3.0 UX Overhaul (Phases 6-8) — SHIPPED 2026-03-02</summary>

- [x] **Phase 6: Compact Output & Session UX** (4/4 plans) — Terminal-fidelity tool display with expand/collapse, content store, clean status, and /clear topic reuse
- [x] **Phase 7: Permission Modes** (2/2 plans) — Tiered auto-accept modes replacing binary approve/deny
- [x] **Phase 8: Subagent Visibility** (2/2 plans) — Subagent lifecycle messages and agent-prefixed output

</details>

### v4.0 Status & Settings (In Progress)

**Milestone Goal:** Replace text-based status messages with color-coded topic indicators, suppress sub-agent noise by default, deduplicate sticky messages, and add a Telegram-native settings topic for runtime configuration.

- [x] **Phase 9: Color-Coded Topic Status** (2/2 plans) - Emoji status prefixes in topic names with startup cleanup and debounced updates
- [x] **Phase 10: Sub-Agent Suppression** (1/1 plans) - Sub-agent output silenced by default with toggleable visibility (completed 2026-03-02)
- [x] **Phase 11: Sticky Message Dedup** - Reuse existing pinned messages on /clear and bot restart (completed 2026-03-02)
- [ ] **Phase 12: Settings Topic** - Dedicated Telegram topic for interactive runtime configuration

## Phase Details

### Phase 9: Color-Coded Topic Status
**Goal**: Users can see session state at a glance from the Telegram topic list without opening any topic
**Depends on**: Phase 8 (v3.0 complete)
**Requirements**: STAT-01, STAT-02, STAT-03, STAT-04, STAT-05, STAT-06
**Success Criteria** (what must be TRUE):
  1. Active sessions show a green circle prefix in their topic name; down/offline sessions show gray
  2. When a session is processing tools, its topic name shows a yellow prefix; errors show red
  3. On bot startup, all previously-active session topics switch to gray status
  4. Rapid status changes (e.g., tool bursts) do not produce Telegram API rate limit errors
**Plans**: 2/2 complete
  - Plan 01: TopicStatusManager class with debounced status, STATUS_EMOJIS constant, clean TopicManager
  - Plan 02: Wire into hook callbacks, startup gray sweep, shutdown cleanup

### Phase 10: Sub-Agent Suppression
**Goal**: Users see only main-chain output by default, with sub-agent noise eliminated unless explicitly enabled
**Depends on**: Phase 8 (v3.0 complete, independent of Phase 9)
**Requirements**: AGNT-01, AGNT-02, AGNT-03
**Success Criteria** (what must be TRUE):
  1. Sub-agent spawn/done announcements, tool calls, and text output do not appear in the session topic by default
  2. Sub-agents do not create their own Telegram topics by default
  3. Sub-agent visibility can be toggled on (verified after Phase 12 delivers settings UI)
**Plans**: 1 plan
  - Plan 01: Config field + 5 gated call sites for sub-agent output suppression

### Phase 11: Sticky Message Dedup
**Goal**: Users never see duplicate pinned status messages after /clear or bot restart
**Depends on**: Phase 9 (session lifecycle and status model stabilized)
**Requirements**: STKY-01, STKY-02, STKY-03
**Success Criteria** (what must be TRUE):
  1. Running /clear in a session topic reuses the existing pinned message if content matches
  2. After bot restart, the existing pinned message is adopted from stored state instead of creating a new one
  3. New sticky messages are only created for brand-new sessions or when content has actually changed
**Plans**: TBD

### Phase 12: Settings Topic
**Goal**: Users can change bot settings from Telegram without editing .env files or restarting the bot
**Depends on**: Phase 10 (sub-agent toggle is the first setting to expose)
**Requirements**: SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06, SETT-07
**Success Criteria** (what must be TRUE):
  1. A dedicated "Settings" topic exists in the Telegram group with inline keyboard toggle buttons
  2. Toggling sub-agent visibility in settings immediately affects whether sub-agent output appears in session topics
  3. Changing permission mode in settings takes effect immediately without bot restart
  4. Settings survive bot restarts (persisted to disk)
  5. Only the bot owner can modify settings; unauthorized users see an error alert
**Plans**: TBD

## Progress

**Execution Order:**
Phases 9 and 10 are independently buildable. Phase 11 depends on 9. Phase 12 depends on 10.
Recommended: 9 -> 10 -> 11 -> 12

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 4/4 | Complete | 2026-02-28 |
| 2. Monitoring | v1.0 | 3/3 | Complete | 2026-03-01 |
| 3. Control | v1.0 | 2/2 | Complete | 2026-03-01 |
| 4. SDK Resume Input | v2.0 | 2/2 | Complete | 2026-03-01 |
| 5. tmux Cleanup | v2.0 | 1/1 | Complete | 2026-03-01 |
| 6. Compact Output & Session UX | v3.0 | 4/4 | Complete | 2026-03-02 |
| 7. Permission Modes | v3.0 | 2/2 | Complete | 2026-03-02 |
| 8. Subagent Visibility | v3.0 | 2/2 | Complete | 2026-03-02 |
| 9. Color-Coded Topic Status | v4.0 | 2/2 | Complete | 2026-03-02 |
| 10. Sub-Agent Suppression | v4.0 | 1/1 | Complete | 2026-03-02 |
| 11. Sticky Message Dedup | 1/1 | Complete    | 2026-03-02 | - |
| 12. Settings Topic | v4.0 | 0/? | Not started | - |
