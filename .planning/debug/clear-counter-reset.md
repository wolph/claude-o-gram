---
status: diagnosed
trigger: "/clear not resetting status message counters"
created: 2026-03-02T00:00:00Z
updated: 2026-03-02T00:00:00Z
---

## Current Focus

hypothesis: The /clear counter reset code IS implemented and wired correctly. The counters not visually resetting is a symptom of a separate issue (new status message not being posted/visible).
test: Trace the full code path from SessionEnd(reason=clear) through SessionStart(source=clear)
expecting: Code exists for counter reset but depends on new status message being posted
next_action: Return diagnosis

## Symptoms

expected: After /clear, status message shows "0 calls | 0 files", "0% ctx", duration resets
actual: Counters not resetting visually
errors: None reported
reproduction: Run /clear in Claude Code, observe Telegram topic
started: Since /clear lifecycle was implemented

## Eliminated

- hypothesis: resetCounters method missing from SessionStore
  evidence: Method exists at session-store.ts:184-194, zeros toolCallCount, filesChanged, suppressedCounts, contextPercent, resets startedAt
  timestamp: 2026-03-02

- hypothesis: resetCounters not called during /clear flow
  evidence: Called in two places - (1) handlers.ts:230-240 zeros counters when creating new session entry, (2) index.ts:298 calls sessionStore.resetCounters(session.sessionId) explicitly
  timestamp: 2026-03-02

- hypothesis: onSessionEnd not passing reason parameter
  evidence: handlers.ts:304 passes payload.reason to callback; HookCallbacks interface at line 24 accepts reason:string
  timestamp: 2026-03-02

- hypothesis: onSessionStart not handling source='clear'
  evidence: handlers.ts:225-251 has explicit source==='clear' branch; index.ts:279-313 has explicit source==='clear' branch
  timestamp: 2026-03-02

## Evidence

- timestamp: 2026-03-02
  checked: SessionStore.resetCounters method (session-store.ts:184-194)
  found: Method exists and correctly resets toolCallCount=0, filesChanged=new Set(), suppressedCounts={}, contextPercent=0, startedAt=now, lastActivityAt=now
  implication: Counter reset logic is implemented correctly

- timestamp: 2026-03-02
  checked: handlers.ts handleSessionStart for source==='clear' (lines 225-251)
  found: Creates new session entry with zeroed counters (toolCallCount:0, filesChanged:new Set(), suppressedCounts:{}, contextPercent:0)
  implication: Counter data is reset in the session store during /clear

- timestamp: 2026-03-02
  checked: index.ts onSessionStart for source==='clear' (lines 279-313)
  found: Calls sessionStore.resetCounters() AND calls initMonitoring(session) which creates a NEW StatusMessage instance and calls initialize() which posts "0 calls | 0 files"
  implication: A new status message with zeroed counters IS created

- timestamp: 2026-03-02
  checked: index.ts onSessionEnd for reason==='clear' (lines 350-372)
  found: Destroys old monitor (including StatusMessage), stores threadId+statusMessageId in clearPending map, does NOT close topic
  implication: Old status message is properly cleaned up

- timestamp: 2026-03-02
  checked: StatusMessage.initialize() (status-message.ts:39-71)
  found: Creates new message with initialData showing contextPercent:0, toolCallCount:0, filesChanged:0, sessionDuration:'0m', status:'active'. Also pins the message.
  implication: New status message starts with all-zero counters

- timestamp: 2026-03-02
  checked: Full /clear lifecycle end-to-end wiring
  found: The entire chain is wired: SessionEndPayload.reason -> handleSessionEnd -> onSessionEnd(reason='clear') -> clearPending -> SessionStartPayload.source='clear' -> handleSessionStart -> onSessionStart(source='clear') -> resetCounters + initMonitoring -> new StatusMessage with zeros
  implication: The counter reset code path is complete and correct

## Resolution

root_cause: The counter reset logic IS fully implemented and wired. The visual symptom of "counters not resetting" is entirely dependent on the related gap: "no new status message being posted." If a new status message is not appearing in the Telegram topic, the user sees the OLD status message (which has stale counters). The old status message IS destroyed (StatusMessage.destroy() called), and a new one IS created (initMonitoring called), but visibility depends on the new message actually appearing in Telegram -- which is the separate "new status message not posted" issue.

fix: No fix needed for counter reset logic itself. This issue resolves when the "new status message not posted" gap is fixed. The code at index.ts:298 (resetCounters) and index.ts:302 (initMonitoring -> StatusMessage.initialize) correctly resets and displays zero counters.

verification: Code trace confirms complete implementation
files_changed: []
