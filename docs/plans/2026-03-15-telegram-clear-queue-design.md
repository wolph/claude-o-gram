# Design: Durable Telegram Conversation + /clear Queueing

**Date:** 2026-03-15
**Status:** Approved

## Problem

Two coupled problems exist in the Telegram bridge:

1. **Inputs can be silently dropped around `/clear`.**
   The current flow treats the Claude Code `sessionId` as the primary unit of routing.
   When the old session is marked closed before the replacement clear-session is fully
   attached, Telegram messages in that gap are read by the bot but are not routed into
   Claude or explicitly rejected.

2. **Telegram ingress is not immediately observable.**
   The bot mirrors `You` messages from Claude transcripts after Claude writes them, but
   it does not always show, at receipt time, what Telegram sent and which input target
   the bot chose.

The user expectation is different:

- A Telegram topic is the durable visible session.
- `/clear` is only a context reset for the LLM, not the end of the visible session.
- Messages sent during the clear transition must be queued and replayed automatically.
- The local bot console must always show what was received from Telegram and where it
  was routed.

## Goals

- Keep one visible Telegram topic as the ongoing conversation across `/clear`.
- Never silently drop Telegram text or commands during a clear transition.
- Queue inbound messages while the replacement Claude session is being attached.
- Drain queued messages in strict FIFO order after the new session is routable.
- Add immediate local-console observability for receipt, routing, queueing, draining,
  and failure.
- Preserve transcript-based `You` echoes as the proof that Claude actually received
  the input.

## Non-Goals

- Changing how Claude transcripts are formatted in Telegram beyond existing separators
  and optional queue/failure notices.
- Creating a new Telegram topic for clear transitions.
- Reworking unrelated session summary, tool formatting, or approval flows.

## Design

### 1. Durable conversation record

Introduce a durable conversation record keyed by Telegram `threadId` or equivalent
topic identity. This record represents the visible Telegram session.

The conversation survives `/clear` and owns:

- `threadId`
- `cwd`
- `topicName`
- `statusMessageId`
- `state`: `active` or `transitioning`
- `currentSessionId`
- `currentTranscriptPath`
- `currentInputMethod`
- `permissionMode`
- ordered ingress queue
- timestamps/metadata needed for persistence and recovery

Claude runtime state becomes a replaceable binding under that conversation instead of
being the top-level unit of routing.

### 2. Unified Telegram ingress

Both plain text and forwarded slash commands pass through one ingress path.

Each inbound Telegram item is normalized into an `InboundMessage` record containing:

- `threadId`
- `telegramMessageId`
- `kind` (`text` or `command`)
- raw Telegram text
- transformed text actually sent to Claude
- timestamp
- queue metadata

Ingress always performs these steps in order:

1. Log receipt to the local bot console.
2. Resolve the durable conversation for the topic.
3. If conversation is `active`, route immediately to the current binding.
4. If conversation is `transitioning`, queue the message and acknowledge buffering.

### 3. Immediate observability

Every inbound Telegram message should produce local-console logs even before Claude
acknowledges it in the transcript.

Recommended log shapes:

- `RECV thread=123 msg=456 kind=text preview="..."`  
- `ROUTE thread=123 state=active session=abcd1234 via=tmux target=%12`
- `QUEUE thread=123 reason=clear-transition depth=2`
- `DRAIN thread=123 session=efgh5678 via=tmux queued_for=1.8s`
- `FAIL stage=send thread=123 session=efgh5678 error="..."`

Telegram topic behavior remains quiet on success. Only exceptional conditions should
emit topic notices, such as:

- `Queued while context is clearing; will send automatically.`
- `Failed to deliver queued message; still buffered.`

### 4. `/clear` transition model

When `/clear` is detected:

1. Mark the durable conversation `transitioning(clear)` immediately.
2. Freeze delivery to the old Claude binding.
3. Keep accepting Telegram inputs into the ordered queue.
4. Post the existing separator: `context cleared at HH:MM`.
5. Attach the new Claude binding as soon as either the hook path or filesystem fallback
   confirms the replacement session.
6. Re-detect input transport for the new binding.
7. Flip the conversation back to `active`.
8. Drain the queue through the same sender path used for live messages.

This removes the current race where the old session can be `closed` before the new
session is routable.

### 5. Queue drain rules

- Preserve strict FIFO order across text and commands.
- Drain only after the new binding is fully routable:
  `currentSessionId`, transcript watcher, and input method must all be ready.
- Send one queued item at a time.
- If one queued item fails, stop draining, keep the remaining queue intact, and surface
  the failure instead of dropping or reordering anything.

### 6. Failure handling

- If the replacement session never appears within a timeout, keep the queue persisted
  and emit explicit warnings in Telegram and the local console.
- If input transport changes across the clear, drain using the new transport.
- If the bot restarts mid-transition, restore the conversation and queued inputs from
  persisted state, then resume binding attachment and draining.
- If duplicate clear signals arrive from both hooks and the filesystem detector, dedupe
  them at the durable conversation layer so rebinding and drain happen once.

## Component impact

- `src/sessions/session-store.ts`
  Existing per-Claude-session storage likely remains for historical/session-summary use,
  but it should no longer be the sole source of Telegram routing truth.

- New durable conversation store
  Add a first-class store for topic-level conversation state and queue persistence.

- `src/bot/bot.ts`
  Stop resolving incoming Telegram text directly to an active `SessionInfo` by thread.
  Route through the durable conversation and unified ingress path instead.

- `src/index.ts`
  Rotate bindings during `/clear`, attach/detach monitoring, and trigger queue drain
  after the replacement binding is ready.

- `src/input/input-router.ts`
  Continue to own transport selection, but expose enough information for route logs.

## Testing

Add coverage for:

- conversation state transitions (`active`, `transitioning`, rebound, timeout)
- queue ordering and drain stop-on-failure behavior
- no silent drops during the existing clear gap
- duplicate clear dedupe
- restart persistence and recovery of queued inputs
- local-console receipt/routing/queue/drain logs

## Acceptance criteria

- After `/clear`, messages sent in the same Telegram topic are never lost.
- The Telegram topic remains the visible ongoing session; only a clear separator marks
  the context reset.
- The local bot console always shows what was received from Telegram and exactly where
  it was routed or queued.
- If the replacement Claude session is late or broken, the user sees explicit buffering
  or failure instead of silent reads.
- Transcript-based `You` echoes still mean “Claude actually received this,” while receipt
  and route logs provide immediate transport truth.
