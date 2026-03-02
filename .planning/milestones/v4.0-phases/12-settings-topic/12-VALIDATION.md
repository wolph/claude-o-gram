---
phase: 12
slug: settings-topic
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-02
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | None (project uses manual UAT exclusively) |
| **Config file** | None |
| **Quick run command** | `npx tsc --noEmit` (type-check only) |
| **Full suite command** | `npx tsc --noEmit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc --noEmit`
- **After every plan wave:** Run `npx tsc --noEmit` + manual verification
- **Before `/gsd:verify-work`:** Full UAT walkthrough per success criteria
- **Max feedback latency:** 5 seconds (TypeScript compilation)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | 01 | 1 | SETT-06 | type-check | `npx tsc --noEmit` | N/A | pending |
| TBD | 02 | 2 | SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-07 | manual | Visual verification in Telegram | N/A | pending |

*Status: pending (pre-planning)*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework setup needed.

- TypeScript compiler (`tsc`) is already configured and catches type errors
- All behavioral verification is manual (Telegram Bot API interactions)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Settings topic created at startup | SETT-01 | Requires live Telegram group | Start bot, verify topic appears |
| Inline keyboard with buttons | SETT-02 | Requires Telegram UI | Open settings topic, verify buttons |
| Sub-agent toggle works | SETT-03 | Requires active session + subagent | Toggle, run session with subagent, verify output |
| Permission mode selection | SETT-04 | Requires Telegram UI | Tap mode button, verify message updates |
| Immediate effect | SETT-05 | Requires active session | Change setting, verify behavior changes |
| Persistence across restarts | SETT-06 | Requires bot restart | Change setting, restart, verify retained |
| Auth guard | SETT-07 | Requires two Telegram users | Non-owner taps button, verify rejection alert |

---

## Validation Sign-Off

- [x] All tasks have type-check verify or manual verification
- [x] Sampling continuity: TypeScript compile after every task
- [x] Wave 0 covers all MISSING references (none needed)
- [x] No watch-mode flags
- [x] Feedback latency < 5s (tsc --noEmit)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
