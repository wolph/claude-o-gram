# Roadmap: Claude Code Telegram Bridge

## Overview

This roadmap delivers a per-machine Telegram bot that bridges Claude Code sessions to a shared Telegram group. Phase 1 builds the entire plumbing layer: HTTP server receiving hook POSTs, Telegram bot with forum topic lifecycle, session routing, message formatting, and rate limit handling. Phase 2 layers on monitoring -- forwarding tool calls, capturing Claude's text output from JSONL transcripts, posting notifications, status updates, and periodic summaries, with configurable verbosity. Phase 3 adds bidirectional control: the blocking approval flow (PreToolUse with inline Approve/Deny buttons and timeout handling) and text input from Telegram back to Claude Code.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation** - HTTP server, Telegram bot, session-to-topic lifecycle, message formatting, and rate limiting
- [ ] **Phase 2: Monitoring** - Tool call forwarding, text output capture, notifications, status dashboard, summaries, and verbosity filtering
- [ ] **Phase 3: Control** - Blocking approval flow with inline buttons, timeout handling, and bidirectional text input from Telegram

## Phase Details

### Phase 1: Foundation
**Goal**: Users can start and stop Claude Code sessions and see them appear and disappear as dedicated Telegram forum topics, with properly formatted messages and rate limit protection
**Depends on**: Nothing (first phase)
**Requirements**: SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, MNTR-04, UX-01, UX-02
**Success Criteria** (what must be TRUE):
  1. Starting a Claude Code session on any configured machine auto-creates a named forum topic in the Telegram group
  2. Ending a Claude Code session auto-closes its forum topic
  3. Multiple concurrent sessions on the same machine each get their own isolated topic with no message cross-talk
  4. Messages posted to Telegram use HTML formatting with code blocks and bold tool names, and outputs over 4096 characters arrive as .txt file attachments
  5. Rapid message bursts are batched and queued so the bot never hits Telegram's 20 msg/min rate limit
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD

### Phase 2: Monitoring
**Goal**: Users can passively observe everything Claude Code is doing from Telegram -- every tool call, every text response, every notification, with a live status indicator and periodic summaries
**Depends on**: Phase 1
**Requirements**: MNTR-01, MNTR-02, MNTR-03, MNTR-05, MNTR-06, UX-03
**Success Criteria** (what must be TRUE):
  1. Every tool call (file read, edit, bash command) appears in the session topic as it happens, with tool name and relevant details
  2. Claude's text output (reasoning, explanations) is captured from JSONL transcript files and posted to the topic
  3. Notification events (permission prompts, idle alerts) are forwarded to the session topic
  4. A live-updating status message in each topic shows context window and quota usage
  5. Users can configure verbosity to suppress noisy events (e.g., hide Read/Glob/Grep tool calls)
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Control
**Goal**: Users can approve or deny Claude Code's tool calls from Telegram and send text input back to Claude Code, making the Telegram group a full remote control interface
**Depends on**: Phase 2
**Requirements**: CTRL-01, CTRL-02, CTRL-03
**Success Criteria** (what must be TRUE):
  1. When Claude Code requests a blocked tool call, an approval message with inline Approve/Deny buttons appears in the session topic, and tapping a button unblocks Claude Code with the chosen decision
  2. If no response is received within the configured timeout, the tool call is auto-denied (not auto-approved) and the approval buttons are replaced with an "Expired" indicator
  3. User can reply with text in the session topic and that text is fed back into the Claude Code session as input
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/0 | Not started | - |
| 2. Monitoring | 0/0 | Not started | - |
| 3. Control | 0/0 | Not started | - |
