---
status: diagnosed
trigger: "/clear separator not appearing in Telegram topic"
created: 2026-03-02T00:00:00Z
updated: 2026-03-02T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - Claude Code does not fire SessionEnd(reason=clear) on /clear, so the clearPending bridge is never populated, and SessionStart(source=clear) cannot find the pending data to post the separator
test: Verified via GitHub issue anthropics/claude-code#6428 and code trace
expecting: n/a - root cause confirmed
next_action: Return diagnosis

## Symptoms

expected: After /clear in Claude Code, a visual separator "--- context cleared at HH:MM ---" appears in the Telegram topic
actual: No separator appears
errors: none reported
reproduction: Run /clear in Claude Code and observe Telegram topic
started: After phase 06-03 implementation

## Eliminated

- hypothesis: Code not implemented in source files
  evidence: Full /clear lifecycle code exists in index.ts (lines 279-312 for onSessionStart source=clear, lines 350-371 for onSessionEnd reason=clear), handlers.ts (lines 225-251 for source=clear handling), and session-store.ts (resetCounters and getRecentlyClosedByCwd methods). TypeScript compiles cleanly.
  timestamp: 2026-03-02

- hypothesis: Wiring between handlers and index.ts is broken
  evidence: HookCallbacks interface correctly has source:'new'|'resume'|'clear' on onSessionStart and reason:string on onSessionEnd. handleSessionEnd passes payload.reason to callback. handleSessionStart has explicit source==='clear' branch. All wired correctly.
  timestamp: 2026-03-02

## Evidence

- timestamp: 2026-03-02
  checked: Full code trace of /clear lifecycle across index.ts, handlers.ts, session-store.ts, server.ts, hooks.ts types
  found: All /clear code is correctly implemented and compiles. The design relies on a TWO-STEP flow: (1) SessionEnd(reason=clear) populates clearPending map, (2) SessionStart(source=clear) consumes clearPending to post separator
  implication: If step 1 never fires, clearPending is never populated, and step 2 has no pending data

- timestamp: 2026-03-02
  checked: GitHub issue anthropics/claude-code#6428 - "SessionEnd hook does not fire with /clear as documentation states"
  found: Known Claude Code bug. SessionEnd hook does NOT fire when user runs /clear. Only SessionStart fires (with source=clear). Issue is labeled 'bug', 'has repro', 'area:core'. Reported August 2025, still open. One commenter confirmed fix in v2.0.50 but another reported same issue on v2.1.9 (Windows). Current installed version is v2.1.63.
  implication: The entire /clear lifecycle design is built on receiving BOTH SessionEnd(reason=clear) AND SessionStart(source=clear), but Claude Code only sends SessionStart(source=clear). The clearPending bridge never gets populated.

- timestamp: 2026-03-02
  checked: Code path when SessionStart(source=clear) fires WITHOUT preceding SessionEnd(reason=clear)
  found: In index.ts onSessionStart, when source==='clear', it reads clearPending.get(session.cwd). Since SessionEnd never fired, clearPending is empty. The code enters the if(pending) block = FALSE, skips separator posting, skips unpin, skips counter reset. Falls through to initMonitoring only.
  implication: The separator, unpin, and counter reset are all inside the if(pending) guard and are all skipped

- timestamp: 2026-03-02
  checked: handlers.ts handleSessionStart source=clear path
  found: Uses getRecentlyClosedByCwd(payload.cwd) to find the old session. But since SessionEnd never fired, the old session was never marked 'closed' - it's still 'active'. getRecentlyClosedByCwd filters for status==='closed', so it returns undefined. Falls through to "new session" path, creating a NEW topic instead of reusing the existing one.
  implication: Not only is the separator missing, but the entire topic reuse is broken. A new topic is created on /clear instead of reusing the existing one.

## Resolution

root_cause: Claude Code does not fire SessionEnd(reason=clear) when user runs /clear (known bug: anthropics/claude-code#6428). The implementation assumes a two-step flow (SessionEnd then SessionStart) but only SessionStart(source=clear) arrives. This means: (1) clearPending map is never populated, so separator/unpin/reset are skipped, (2) old session is never marked 'closed', so getRecentlyClosedByCwd finds nothing, (3) falls through to new-session path creating a duplicate topic.
fix: Restructure the /clear handling to work with SessionStart(source=clear) ALONE, without requiring a preceding SessionEnd. The SessionStart(source=clear) handler in handlers.ts should look for an ACTIVE session by cwd (getActiveByCwd) not just recently closed ones. The index.ts onSessionStart(source=clear) handler should retrieve threadId and statusMessageId from the existing active session directly, not from the clearPending map.
verification:
files_changed: []
