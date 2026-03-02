# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v3.0 — UX Overhaul

**Shipped:** 2026-03-02
**Phases:** 3 | **Plans:** 8 | **Commits:** 16 feat

### What Was Built
- Compact tool format with expand/collapse (LRU cache, 250-char truncation, inline editing)
- Terminal-fidelity output — removed all bot commentary, emoji labels, verbose formatting
- /clear topic reuse with separator, new pin, counter reset (filesystem watcher workaround for hook bug #6428)
- Permission modes (Accept All, Same Tool, Safe Only, Until Done) with dangerous command blocklist
- Subagent visibility with spawn/done announcements and agent-prefixed output

### What Worked
- Wave-based parallel execution: 2-wave plan structure (infrastructure then wiring) worked cleanly for both Phase 7 and Phase 8
- Plan verification loop caught no issues — plans were tight enough to pass first time
- UAT-driven UX fix: user feedback during live testing led to immediate keyboard layout improvement (all mode buttons visible by default instead of hidden behind Mode...)
- Shell script bridge pattern for command hooks → HTTP was reliable and reusable

### What Was Inefficient
- Phase 6 needed a 4th gap-closure plan (06-04) because upstream hook bug #6428 wasn't discovered until UAT — earlier integration testing would have caught this
- Permission mode bypass confusion during UAT: Claude Code's session-level `bypassPermissions` mode auto-approves before reaching the bot's approval manager, causing initial test failures until diagnosed
- ROADMAP.md plan checkboxes got stale (showed unchecked for completed plans) — needs automated updates

### Patterns Established
- Callback-based wiring: infrastructure plans export types/classes, wiring plans connect them via callbacks in index.ts
- Description stash-pop: PreToolUse stashes Agent description, SubagentStart pops it for display
- Fire-and-forget HTTP hooks: SubagentStart/Stop routes return 200 immediately, process async
- Mode keyboard layout: Accept/Deny on row 1, mode buttons on row 2, all visible by default

### Key Lessons
1. Test with the actual bot running early — permission mode bypass and hook timing issues only surface in live testing
2. Upstream bugs need filesystem-level workarounds — don't wait for fixes, build detection mechanisms
3. User feedback during UAT is more valuable than pre-planned test criteria — the keyboard layout fix came directly from user observation

### Cost Observations
- Model mix: ~80% opus (planning + execution), ~20% sonnet (verification + research)
- 8 plans executed in ~30min total wall time
- Notable: Wave parallelism had minimal benefit for 2-plan phases but architecture scales well

---

## Milestone: v4.0 — Status & Settings

**Shipped:** 2026-03-02
**Phases:** 4 | **Plans:** 6 | **Commits:** 10 feat

### What Was Built
- TopicStatusManager with four-state color-coded topic status (green/yellow/red/gray) and per-topic debounced editForumTopic calls
- Startup gray sweep setting all existing session topics to gray before reconnect
- Sub-agent suppression with 5 gated call sites silencing all output by default
- StatusMessage.reconnect() for adopting existing pinned messages on /clear and restart
- Settings topic with inline keyboard for sub-agent toggle and permission mode selection
- BotStateStore + RuntimeSettings mutable config layer with atomic JSON persistence

### What Worked
- Auto-advance (--auto) pipeline: discuss → plan → execute chained cleanly for all 4 phases with zero manual intervention
- Research phase discovered the critical editForumTopic icon_color limitation early — informed the emoji-prefix-in-name approach before any code was written
- Phase dependency graph (9→11, 10→12) kept each phase small and focused — no phase exceeded 2 plans
- Integration checker at audit caught no issues — phases wired together correctly on first pass
- Separation of concerns: TopicStatusManager, BotStateStore, RuntimeSettings, and SettingsTopic are each independent modules with clear boundaries

### What Was Inefficient
- UAT was skipped for phases 9-12 — color-coded status and settings topic require live bot testing that couldn't be automated in this session
- Phase 12 ROADMAP.md entry had a formatting inconsistency in the progress table (missing milestone column) — caught during audit but should have been caught by the executor
- REQUIREMENTS.md SETT-01..07 checkboxes weren't updated during Phase 12 execution — documentation gap caught at audit

### Patterns Established
- Mutable config pattern: RuntimeSettings wraps BotStateStore, AppConfig provides immutable defaults, BotStateStore persists mutations
- Settings callback pattern: `set_<prefix>:<action>` callback data format, auth guard before handler, inline edit for feedback
- Topic status pattern: debounced per-topic editForumTopic with in-memory cache for no-op elimination and sticky states (red doesn't get overridden by green/yellow)

### Key Lessons
1. Telegram API constraints must be discovered during research — editForumTopic limitations changed the entire approach from icon_color to emoji prefixes
2. Mutable vs immutable config needs explicit separation — mixing runtime-changeable settings into AppConfig would create confusion about what can change
3. Small focused phases (1-2 plans each) execute faster and integrate more cleanly than large multi-plan phases

### Cost Observations
- Model mix: ~70% opus (discuss + execute), ~30% sonnet (research + verification + integration check)
- 6 plans executed in ~20min total wall time
- Notable: --auto flag eliminated all user interaction overhead — entire milestone from discuss to audit ran in a single session

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 3 | 9 | Initial MVP — established hook server + transcript watcher architecture |
| v2.0 | 2 | 3 | SDK migration — replaced tmux with Agent SDK resume input |
| v3.0 | 3 | 8 | UX overhaul — compact output, permission modes, subagent visibility |
| v4.0 | 4 | 6 | Status & settings — color-coded topics, sub-agent suppression, settings topic |

### Top Lessons (Verified Across Milestones)

1. Incremental migration reduces risk — v2.0 only replaced input (not output), v3.0 only changed display (not transport), v4.0 added new capabilities without changing existing flows
2. UAT catches real issues that automated verification misses — both v2.0 and v3.0 had UAT-driven fixes (v4.0 deferred UAT to live testing)
3. Workarounds for upstream bugs are sometimes the right long-term solution (tmux double-turn bug → resume, hook bug #6428 → filesystem watcher)
4. API constraint discovery during research is critical — v4.0's editForumTopic icon_color limitation changed the entire approach before coding started
