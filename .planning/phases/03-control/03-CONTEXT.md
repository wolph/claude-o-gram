# Phase 3: Control - Context

**Gathered:** 2026-02-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Remote control of Claude Code from Telegram. Users can approve or deny tool calls via inline buttons, send text input back to Claude Code via topic replies, and unanswered approvals auto-deny after timeout. This makes the Telegram group a full remote control interface. This phase does NOT add new monitoring capabilities or change session lifecycle — those are Phase 1 and 2.

</domain>

<decisions>
## Implementation Decisions

### Approval Button UX
- Show tool name, what it wants to do (file path, command), and a risk indicator (safe/caution/danger based on tool type)
- Include a compact preview of tool input: bash command text, file path + first few lines of edit, truncated to ~200 chars
- Just two buttons: Approve and Deny. No bulk approve or "allow for session" options.
- After tapping: update message in place — replace buttons with "Approved" or "Denied" text + who acted + timestamp

### Timeout & Expiry Behavior
- Default timeout: 5 minutes before auto-deny. Configurable via env var (APPROVAL_TIMEOUT_MS)
- No reminder before timeout — initial message is enough
- On expiry: update message in place with "Expired — auto-denied after 5m" (same pattern as approved/denied)
- Buttons removed after expiry — no late actions allowed. The deny already happened.

### Text Input Flow
- User replies to any bot message in the session topic. Reply text is fed to Claude Code as user input.
- Multi-line text supported — whatever user types is sent as-is, including newlines
- When text is sent but Claude Code isn't waiting for input: queue it. Deliver when Claude Code next asks for input.
- Brief inline confirmation when input is delivered: react with checkmark emoji or post brief "Input sent" reply

### Hook Blocking Mechanics
- Only tools that Claude Code itself would prompt for (based on session's permission_mode) trigger approval. If Claude Code auto-allows it, so does the bot.
- PreToolUse HTTP hook holds the connection open until user responds or timeout. Returns appropriate decision response.
- Denied tool calls include fixed reason: "Denied by user via Telegram" for manual denials, "Auto-denied: approval timeout" for timeouts
- AUTO_APPROVE=true env var bypasses all approval prompts. For trusted/local environments. Off by default.

### Claude's Discretion
- Exact risk indicator classification (which tools are safe/caution/danger)
- How to map PreToolUse hook response format to Claude Code's expected schema
- Queue implementation for text input when Claude isn't waiting
- How to detect if Claude Code is waiting for input vs just running
- Inline keyboard button layout and callback data format

</decisions>

<specifics>
## Specific Ideas

- The approval message should feel like a security prompt — clear, scannable, actionable in 2 seconds
- Expired approvals should look definitively closed — no ambiguity about whether the action happened
- Text input via reply-to is the most natural Telegram interaction pattern — use it as the primary method
- The AUTO_APPROVE env var is for when the user trusts the environment and just wants monitoring without interruption

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-control*
*Context gathered: 2026-02-28*
