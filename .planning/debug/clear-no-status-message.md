---
status: diagnosed
trigger: "/clear not posting new status message in Telegram topic"
created: 2026-03-02T00:00:00Z
updated: 2026-03-02T00:00:00Z
---

## Current Focus

hypothesis: SessionEnd with reason=clear may not fire reliably in Claude Code, preventing the clearPending bridge from being populated
test: Traced full code path + checked upstream Claude Code issue tracker
expecting: If SessionEnd(reason=clear) does not fire, clearPending is never set, so onSessionStart(clear) cannot find pending data
next_action: Return diagnosis

## Symptoms

expected: After running /clear in Claude Code, a fresh new status message should be posted and pinned in the Telegram topic
actual: No new status message is posted after /clear
errors: None reported (silent failure)
reproduction: Run /clear in Claude Code, observe Telegram topic
started: After 06-03 implementation

## Eliminated

- hypothesis: Code not wired (missing implementation)
  evidence: Full /clear lifecycle IS implemented in handlers.ts and index.ts -- onSessionEnd(clear) populates clearPending, onSessionStart(clear) reads it, calls initMonitoring which creates and pins StatusMessage
  timestamp: 2026-03-02

- hypothesis: StatusMessage.initialize() broken
  evidence: initialize() correctly calls sendMessage with message_thread_id and pins it; same code works for new sessions
  timestamp: 2026-03-02

- hypothesis: session.threadId wrong during clear flow
  evidence: handleSessionStart(clear) spreads recentClosed (which has threadId) into new session; threadId is preserved correctly
  timestamp: 2026-03-02

## Evidence

- timestamp: 2026-03-02
  checked: Full code path from HTTP hook -> handleSessionEnd -> onSessionEnd(clear) -> clearPending -> handleSessionStart(clear) -> onSessionStart(clear) -> initMonitoring -> StatusMessage.initialize()
  found: Implementation is complete and logically correct in all files
  implication: Bug is not in the implementation logic itself

- timestamp: 2026-03-02
  checked: GitHub issue anthropics/claude-code#6428 "SessionEnd hook does not fire with /clear as documentation states"
  found: Known issue. Originally reported, confirmed fixed in v2.0.50, but reopened -- recent comments (Jan/Feb 2026) report it still broken on some platforms. Issue is still OPEN.
  implication: The /clear lifecycle depends on SessionEnd(reason=clear) firing FIRST to populate clearPending, then SessionStart(source=clear) reading it. If SessionEnd doesn't fire, clearPending is empty.

- timestamp: 2026-03-02
  checked: Claude Code version on this system
  found: v2.1.63
  implication: Running a version where SessionEnd/clear may or may not fire reliably

- timestamp: 2026-03-02
  checked: What happens in onSessionStart(clear) when clearPending is empty
  found: Lines 281-299 of index.ts -- if pending is null, the separator/unpin/reset block is SKIPPED, but initMonitoring(session) at line 302 is still called regardless
  implication: Even if SessionEnd doesn't fire, IF SessionStart(source=clear) fires, a new status message SHOULD still be created. The separator and unpin would be skipped, but the status message should still appear.

- timestamp: 2026-03-02
  checked: What happens if SessionEnd(reason=clear) does NOT fire but SessionStart(source=clear) DOES fire
  found: In handleSessionStart (handlers.ts line 225-251), source=clear tries getRecentlyClosedByCwd(). If SessionEnd never fired, the OLD session is still status=active. getRecentlyClosedByCwd() looks for status=closed sessions -- it will NOT find one. Falls through to the "Fallback" comment at line 249, which falls through to the normal new-session path.
  implication: THIS IS THE ROOT CAUSE. If SessionEnd doesn't fire, there's no closed session to find, so the clear path falls through to the new-session path which creates a NEW topic instead of reusing the existing one. The new status message IS created but in a NEW topic, not the existing one.

- timestamp: 2026-03-02
  checked: Alternative scenario -- what if NEITHER SessionEnd nor SessionStart fires with clear?
  found: If neither fires, no code runs at all, so no status message.
  implication: Two possible failure modes depending on which hooks actually fire.

## Resolution

root_cause: The /clear lifecycle implementation depends on SessionEnd(reason=clear) firing before SessionStart(source=clear) to bridge the old session's threadId to the new session. There are two compounding issues:

1. **Upstream bug (primary):** Claude Code's SessionEnd hook may not fire reliably on /clear (GitHub issue anthropics/claude-code#6428, still OPEN as of Feb 2026). Without SessionEnd(reason=clear), the old session is never marked as closed, and clearPending is never populated.

2. **Missing fallback in handleSessionStart (secondary):** When source=clear arrives but no recently-closed session exists (because SessionEnd didn't fire), the code falls through to the new-session path (creates a new topic) instead of detecting the still-active session for the same cwd and reusing its topic. The getRecentlyClosedByCwd() lookup fails because the session is still status=active, and getActiveByCwd() is only checked in the resume path, not the clear path.

fix: (not applied)
verification: (not verified)
files_changed: []
