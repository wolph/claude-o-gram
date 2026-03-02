---
phase: 11
slug: sticky-message-dedup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-02
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | None -- no test framework configured |
| **Config file** | none |
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
| 11-01-01 | 01 | 1 | STKY-01, STKY-02, STKY-03 | manual-only | `npx tsc --noEmit` (type-check) | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. TypeScript compilation serves as automated validation. All functional requirements are manual-only (Telegram API interactions).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| /clear reuses pinned message | STKY-01 | Requires live Telegram bot + group | 1. Start session, note pinned message ID. 2. Send /clear. 3. Verify same message ID, no new pin. |
| Bot restart adopts stored message | STKY-02 | Requires live Telegram bot restart | 1. Start session with pinned message. 2. Restart bot. 3. Verify no new pinned message, existing one updates. |
| New sessions get new pin | STKY-03 | Requires live Telegram bot + group | 1. Start fresh session (new cwd). 2. Verify new pinned message created. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
