# Phase 7: Permission Modes - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Tiered auto-accept modes for Telegram permission prompts. Users control how aggressively permissions are auto-approved, eliminating button-tap fatigue for trusted workflows while keeping destructive commands gated. Covers: mode activation UX, risk classification, mode lifecycle, and stop controls.

</domain>

<decisions>
## Implementation Decisions

### Mode Activation UX
- Each permission prompt shows [Accept] [Deny] [Mode...] buttons
- Tapping [Mode...] expands a second row with mode options: [Accept All] [Same Tool] [Safe Only] [Until Done]
- Auto-approved tools post immediately as compact `lightning Tool(args...)` lines (not batched)
- Every session starts in manual mode -- no configurable default

### Risk Classification
- Narrow dangerous command blocklist: only obviously destructive patterns (rm -rf /, sudo, curl|bash, git push --force)
- Blocked commands appear with a warning-styled prompt (visual indicator distinguishing them from normal prompts)
- Blocklist is fixed/hardcoded -- no user customization

### Mode Scope & Lifecycle
- Modes reset to manual on /clear (each context window starts fresh)
- Same Tool matches on tool name only (e.g., approving "Bash" auto-approves all future Bash calls)
- Until Done expires when Claude's current turn ends (goes idle waiting for user input)
- Sending a text message while a mode is active does NOT reset the mode -- only Stop button or /clear deactivates

### Claude's Discretion
- Until Done button placement within the mode menu layout
- Safe tool classification approach for Safe Only mode (tool name vs name+args heuristics based on hook capabilities)
- Mode change announcement style (inline message vs status-only)
- Stop button behavior for in-flight pending permissions
- Stop confirmation style (silent vs brief message)
- Auto-approved count display in status message

</decisions>

<specifics>
## Specific Ideas

- Stop button reuses the existing pinned status message infrastructure from Phase 6 -- update the status message to show active mode and Stop button rather than creating a new pinned message
- Warning-styled prompt for blocked commands should be visually distinct from normal permission prompts (prefix, bold, or similar)

</specifics>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 07-permission-modes*
*Context gathered: 2026-03-02*
