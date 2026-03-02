---
phase: 10
slug: sub-agent-suppression
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-02
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | TypeScript compiler (tsc) — no test runner |
| **Config file** | tsconfig.json |
| **Quick run command** | `npx tsc --noEmit` |
| **Full suite command** | `npx tsc --noEmit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit`
- **After every plan wave:** Run `npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | AGNT-01, AGNT-02, AGNT-03 | manual | `npx tsc --noEmit` (type check) | N/A | pending |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework setup needed — this phase modifies existing TypeScript code and validation is type-checking + manual UAT.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Sub-agent output suppressed by default | AGNT-01 | Requires running bot with real Claude Code sub-agent | 1. Start bot with default env 2. Trigger sub-agent via Claude Code 3. Verify no sub-agent output in Telegram topic |
| Sub-agents don't create own topics | AGNT-02 | Already working; requires live Telegram verification | 1. Trigger sub-agent 2. Verify no new topic created in Telegram group |
| Toggle via SUBAGENT_VISIBLE=true | AGNT-03 | Requires restart with env change and live verification | 1. Set SUBAGENT_VISIBLE=true 2. Restart bot 3. Trigger sub-agent 4. Verify output appears with agent prefixes |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
