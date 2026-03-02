---
phase: 9
slug: color-coded-topic-status
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-02
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | None -- project has no automated test infrastructure |
| **Config file** | None |
| **Quick run command** | `npx tsc --noEmit` |
| **Full suite command** | `npx tsc --noEmit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit`
- **After every plan wave:** Run `npx tsc --noEmit` + manual smoke test
- **Before `/gsd:verify-work`:** Full UAT with all 6 requirements verified
- **Max feedback latency:** 5 seconds (TypeScript compilation only)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | STAT-06 | compilation | `npx tsc --noEmit` | N/A | pending |
| 09-01-02 | 01 | 1 | STAT-01,02,03,04 | compilation | `npx tsc --noEmit` | N/A | pending |
| 09-02-01 | 02 | 2 | STAT-01,03 | compilation | `npx tsc --noEmit` | N/A | pending |
| 09-02-02 | 02 | 2 | STAT-05 | compilation | `npx tsc --noEmit` | N/A | pending |

*Status: pending*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework setup needed -- this project relies on TypeScript compilation + manual UAT.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Green emoji on active sessions | STAT-01 | Requires live Telegram bot + forum topic | Start session, verify topic shows 🟢 prefix |
| Gray emoji on down sessions | STAT-02 | Requires bot restart observation | Restart bot, verify active topics switch to ⚪ |
| Yellow emoji during processing | STAT-03 | Requires observing live Claude Code turn | Send prompt, verify topic shows 🟡 during processing |
| Red emoji on context exhaustion | STAT-04 | Requires filling context window to 95% | Run long session, verify topic shows 🔴 at 95% |
| Startup gray sweep | STAT-05 | Requires bot restart with active sessions | Leave sessions active, restart bot, verify all show ⚪ |
| No rate limit errors | STAT-06 | Requires observing logs during rapid tool calls | Trigger rapid tool use, check logs for 429 errors |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: TypeScript compilation on every commit
- [x] Wave 0 covers all MISSING references (none needed)
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
