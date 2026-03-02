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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 3 | 9 | Initial MVP — established hook server + transcript watcher architecture |
| v2.0 | 2 | 3 | SDK migration — replaced tmux with Agent SDK resume input |
| v3.0 | 3 | 8 | UX overhaul — compact output, permission modes, subagent visibility |

### Top Lessons (Verified Across Milestones)

1. Incremental migration reduces risk — v2.0 only replaced input (not output), v3.0 only changed display (not transport)
2. UAT catches real issues that automated verification misses — both v2.0 and v3.0 had UAT-driven fixes
3. Workarounds for upstream bugs are sometimes the right long-term solution (tmux double-turn bug → resume, hook bug #6428 → filesystem watcher)
