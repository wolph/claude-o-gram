# Phase 3: Control - Research

**Researched:** 2026-02-28
**Domain:** Claude Code PreToolUse HTTP hook blocking, grammY inline keyboards, tmux programmatic input, async pending promise pattern
**Confidence:** HIGH (CTRL-01, CTRL-03), MEDIUM (CTRL-02)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Approval Button UX**
- Show tool name, what it wants to do (file path, command), and a risk indicator (safe/caution/danger based on tool type)
- Include a compact preview of tool input: bash command text, file path + first few lines of edit, truncated to ~200 chars
- Just two buttons: Approve and Deny. No bulk approve or "allow for session" options.
- After tapping: update message in place — replace buttons with "Approved" or "Denied" text + who acted + timestamp

**Timeout & Expiry Behavior**
- Default timeout: 5 minutes before auto-deny. Configurable via env var (APPROVAL_TIMEOUT_MS)
- No reminder before timeout — initial message is enough
- On expiry: update message in place with "Expired — auto-denied after 5m" (same pattern as approved/denied)
- Buttons removed after expiry — no late actions allowed. The deny already happened.

**Text Input Flow**
- User replies to any bot message in the session topic. Reply text is fed to Claude Code as user input.
- Multi-line text supported — whatever user types is sent as-is, including newlines
- When text is sent but Claude Code isn't waiting for input: queue it. Deliver when Claude Code next asks for input.
- Brief inline confirmation when input is delivered: react with checkmark emoji or post brief "Input sent" reply

**Hook Blocking Mechanics**
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

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTRL-01 | PreToolUse hook blocks and posts permission questions to Telegram with inline Approve/Deny buttons | PreToolUse HTTP hook holds connection open (async Fastify handler + Promise.withResolvers()); decision returned via `hookSpecificOutput.permissionDecision: "allow"/"deny"`; grammY InlineKeyboard + callbackQuery handler; `editMessageText` after button press |
| CTRL-02 | User can reply with custom text input from Telegram that feeds back into Claude Code | tmux-based: capture TMUX_PANE at SessionStart via additionalContext hook; `tmux set-buffer + paste-buffer -p` for reliable injection; non-tmux sessions queue until user switches to terminal |
| CTRL-03 | Blocked hooks auto-deny after a configurable timeout if no response is received | `setTimeout(APPROVAL_TIMEOUT_MS)` rejects the pending promise; hook responds with `permissionDecision: "deny"` and reason "Auto-denied: approval timeout"; HTTP hook `timeout` config must exceed APPROVAL_TIMEOUT_MS |
</phase_requirements>

## Summary

Phase 3 adds bidirectional control: the Fastify HTTP server must now hold PreToolUse hook connections open while waiting for user approval via Telegram inline buttons, then return the decision through the hook response body. This is the async-blocking pattern: an HTTP handler creates a deferred promise (`Promise.withResolvers()`), sends an approval message to Telegram, and awaits the promise resolution (or timeout). When the user taps Approve/Deny, the grammY callback handler resolves the promise, the HTTP handler returns the appropriate JSON, and Claude Code proceeds accordingly.

The PreToolUse hook response format uses `hookSpecificOutput.permissionDecision` set to `"allow"` or `"deny"`, with `permissionDecisionReason` for the reason shown to Claude (for deny) or the user (for allow). The HTTP hook `timeout` field in the hook configuration must be set higher than `APPROVAL_TIMEOUT_MS` (e.g., 360 seconds for the 5-minute default) so Claude Code waits long enough. Connection failures and timeouts from Claude Code's side produce non-blocking errors that allow execution to continue — this is acceptable behavior since the bot will have already sent the auto-deny before the HTTP timeout fires.

Text input injection (CTRL-02) requires tmux. There is no official Claude Code API or hook for injecting new user prompts into an active interactive session from an external process. The only confirmed working mechanism is tmux programmatic input via `tmux set-buffer` + `paste-buffer -p` (bracketed paste), which bypasses the Ink autocomplete-Enter interference problem. The tmux pane reference must be captured at SessionStart time (from the `TMUX_PANE` environment variable available when Claude Code starts) and stored in the session. For sessions not running in tmux, text input can be queued and the user is notified that delivery requires tmux.

**Primary recommendation:** Implement the blocking approval flow as an `ApprovalManager` class that manages pending approvals keyed by `tool_use_id`. Use `Promise.withResolvers()` to create externally resolvable promises. For text input, use a `TextInputManager` that detects tmux pane IDs from session start data and uses bracketed paste for injection. Register a `bot.on("message:text")` handler that filters by `message_thread_id` to match session topics.

## Standard Stack

### Core (all already installed from Phase 1)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | 1.40.x | Telegram Bot framework | Already in use; `callbackQuery`, `editMessageText`, `InlineKeyboard` all built-in |
| fastify | 5.7.x | HTTP server for hook POSTs | Already in use; add new PreToolUse route with async handler |
| @grammyjs/auto-retry | latest | Auto-retry on 429 flood wait | Already configured |
| @grammyjs/transformer-throttler | latest | API request throttling | Already configured |

### Supporting (no new dependencies needed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process (execSync / spawnSync) | Node 20+ built-in | Run `tmux set-buffer` + `paste-buffer -p` commands | Text injection into active Claude Code terminal session via tmux |
| node:timers (setTimeout, clearTimeout) | Node 20+ built-in | Auto-deny after APPROVAL_TIMEOUT_MS | Timeout management for pending approvals |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Promise.withResolvers() | Manual deferred pattern (let resolve, reject) | withResolvers is cleaner but Node 22+ only; manual deferred works on Node 20+ |
| tmux paste-buffer for text input | tmux send-keys + Escape + Enter | Paste-buffer is more reliable; send-keys + Escape+Enter adds 400ms latency but also works |
| Storing pending approvals by tool_use_id | Storing by session_id | tool_use_id is more specific; allows concurrent approvals (though unlikely) |

**Installation:**
```bash
# No new dependencies needed - all libraries already installed in Phase 1
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── bot/
│   ├── bot.ts             # Add callbackQuery handlers for approve/deny
│   ├── formatter.ts       # Add formatApprovalRequest() and formatApprovalResult()
│   ├── rate-limiter.ts    # Existing
│   └── topics.ts          # Existing
├── control/
│   ├── approval-manager.ts  # NEW: pending approval state, promise resolution
│   └── input-manager.ts     # NEW: text input queue + tmux injection
├── hooks/
│   ├── server.ts          # Add /hooks/pre-tool-use route
│   └── handlers.ts        # Add handlePreToolUse method
├── types/
│   ├── hooks.ts           # Add PreToolUsePayload type
│   └── sessions.ts        # Add tmuxPane field to SessionInfo
└── utils/
    └── install-hooks.ts   # Add PreToolUse hook registration
```

### Pattern 1: Async-Blocking HTTP Handler (the core pattern)
**What:** The Fastify route for `/hooks/pre-tool-use` creates a deferred promise, sends the Telegram approval message, then `await`s the promise before returning the HTTP response.
**When to use:** Any time Claude Code must be held waiting for an external decision.
**Example:**
```typescript
// src/control/approval-manager.ts
// Source: Official docs - https://code.claude.com/docs/en/hooks (PreToolUse section)

interface PendingApproval {
  resolve: (decision: 'allow' | 'deny') => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  messageId: number;  // Telegram message ID to edit after decision
  threadId: number;   // Telegram thread for the edit call
  chatId: number;
}

export class ApprovalManager {
  // Keyed by tool_use_id (unique per tool call)
  private pending = new Map<string, PendingApproval>();
  private timeoutMs: number;
  private chatId: number;

  constructor(timeoutMs: number, chatId: number) {
    this.timeoutMs = timeoutMs;
    this.chatId = chatId;
  }

  /**
   * Create a pending approval and return a promise that resolves when
   * the user taps Approve/Deny or the timeout fires.
   */
  waitForDecision(
    toolUseId: string,
    sessionId: string,
    threadId: number,
    messageId: number
  ): Promise<'allow' | 'deny'> {
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        resolve('deny');  // auto-deny on timeout
      }, this.timeoutMs);

      this.pending.set(toolUseId, {
        resolve,
        reject,
        timer,
        sessionId,
        messageId,
        threadId,
        chatId: this.chatId,
      });
    });
  }

  /** Called by grammY callback handler when user taps a button */
  decide(toolUseId: string, decision: 'allow' | 'deny'): PendingApproval | null {
    const pending = this.pending.get(toolUseId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pending.delete(toolUseId);
    pending.resolve(decision);
    return pending;
  }

  /** True if an approval is currently pending for this tool_use_id */
  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }
}
```

### Pattern 2: PreToolUse Fastify Route (holds connection open)
**What:** The `/hooks/pre-tool-use` endpoint awaits the approval promise before returning the HTTP response. This is what blocks Claude Code.
**When to use:** CTRL-01 blocking approval flow.
**Example:**
```typescript
// In src/hooks/server.ts — new route
// Source: Official docs - https://code.claude.com/docs/en/hooks (HTTP hooks section)
fastify.post<{ Body: PreToolUsePayload }>(
  '/hooks/pre-tool-use',
  async (request) => {
    const payload = request.body as PreToolUsePayload;

    // AUTO_APPROVE bypass: skip approval, return allow immediately
    if (process.env.AUTO_APPROVE === 'true') {
      return buildAllowResponse();
    }

    // If permission_mode is bypassPermissions or dontAsk, Claude auto-approves
    // We mirror that behavior: don't interrupt with approval prompts
    if (
      payload.permission_mode === 'bypassPermissions' ||
      payload.permission_mode === 'dontAsk'
    ) {
      return buildAllowResponse();
    }

    // Delegate to handler (which posts Telegram message + awaits approval)
    return handlers.handlePreToolUse(payload);
  }
);

// Build allow response JSON for Claude Code
function buildAllowResponse() {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
}

// Build deny response JSON for Claude Code
function buildDenyResponse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
```

### Pattern 3: grammY Inline Keyboard + Callback Handler
**What:** Send approval message with InlineKeyboard, handle button taps to resolve pending approval.
**When to use:** CTRL-01 button UI.
**Example:**
```typescript
// Source: grammy.dev/plugins/keyboard
import { InlineKeyboard } from 'grammy';

// Creating the approval keyboard
function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  // callback_data max 64 bytes; use shortened toolUseId
  const shortId = toolUseId.slice(0, 20);
  return new InlineKeyboard()
    .text('✅ Approve', `approve:${shortId}`)
    .text('❌ Deny', `deny:${shortId}`);
}

// In bot.ts — register callback handlers
// Pattern: "approve:" prefix + partial tool_use_id
bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCallbackQuery();  // dismiss loading spinner
  const pending = approvalManager.decideByShortId(shortId, 'allow');
  if (pending) {
    const who = ctx.from?.username || ctx.from?.first_name || 'User';
    const timestamp = new Date().toLocaleTimeString();
    await ctx.editMessageText(
      ctx.message?.text + `\n\n✅ <b>Approved</b> by @${escapeHtml(who)} at ${timestamp}`,
      { parse_mode: 'HTML', reply_markup: undefined }
    );
  }
});

bot.callbackQuery(/^deny:(.+)$/, async (ctx) => {
  const shortId = ctx.match[1];
  await ctx.answerCallbackQuery();
  const pending = approvalManager.decideByShortId(shortId, 'deny');
  if (pending) {
    const who = ctx.from?.username || ctx.from?.first_name || 'User';
    const timestamp = new Date().toLocaleTimeString();
    await ctx.editMessageText(
      ctx.message?.text + `\n\n❌ <b>Denied</b> by @${escapeHtml(who)} at ${timestamp}`,
      { parse_mode: 'HTML', reply_markup: undefined }
    );
  }
});
```

### Pattern 4: Text Input via tmux Bracketed Paste
**What:** Inject text into Claude Code's interactive terminal session using tmux's bracketed paste mechanism.
**When to use:** CTRL-02 text input delivery.
**Example:**
```typescript
// src/control/input-manager.ts
import { execSync } from 'node:child_process';

export class TextInputManager {
  // Per-session input queues (session_id -> queued text)
  private queues = new Map<string, string[]>();

  /**
   * Inject text into the tmux pane running Claude Code.
   * Uses bracketed paste to avoid autocomplete intercepting Enter.
   */
  inject(tmuxPane: string, text: string): void {
    // Set tmux buffer to the text, then paste with bracketed paste flag
    execSync(`tmux set-buffer ${JSON.stringify(text)}`);
    execSync(`tmux paste-buffer -p -t ${JSON.stringify(tmuxPane)}`);
    // Send Enter to submit after paste (bracketed paste + Enter)
    execSync(`tmux send-keys -t ${JSON.stringify(tmuxPane)} Enter`);
  }

  /**
   * Queue text for a session that isn't waiting for input yet.
   */
  queue(sessionId: string, text: string): void {
    const q = this.queues.get(sessionId) ?? [];
    q.push(text);
    this.queues.set(sessionId, q);
  }

  /**
   * Dequeue and return the next queued text for a session, or null if empty.
   */
  dequeue(sessionId: string): string | null {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return null;
    return q.shift() ?? null;
  }
}
```

### Pattern 5: Capturing tmux Pane at SessionStart
**What:** A SessionStart command hook reads `$TMUX_PANE` from the environment and passes it via `additionalContext` so the bot can store it.
**When to use:** CTRL-02 setup, run once per session.
**Example:**
```bash
#!/bin/bash
# ~/.claude/hooks/capture-tmux-pane.sh
# Runs as a SessionStart command hook (alongside the existing HTTP hook)
# Outputs additionalContext JSON so Claude's context includes the pane ID

if [ -n "$TMUX_PANE" ]; then
  # TMUX_PANE is set by tmux (e.g., "%5")
  # HTTP hook receives JSON but we're a command hook — stdout goes to Claude context
  # We use a separate channel: write pane ID to a known file path
  # Bot reads this file in handleSessionStart
  echo "$TMUX_PANE" > "/tmp/claude-tmux-pane-${CLAUDE_SESSION_ID}.txt" 2>/dev/null || true
fi
exit 0
```

**Alternative approach (simpler):** The bot reads `/tmp/claude-tmux-pane-${session_id}.txt` in `handleSessionStart` after the HTTP hook fires. Shell hook script writes the pane ID to that path. This avoids needing to pass it through HTTP payload.

### Anti-Patterns to Avoid
- **Awaiting approval in fire-and-forget**: The PreToolUse route MUST `await` the approval — it cannot be fire-and-forget. Claude Code holds the session until the HTTP response arrives.
- **Setting HTTP hook timeout too low**: If `timeout` in the hook config is less than `APPROVAL_TIMEOUT_MS`, Claude Code will timeout and allow the tool call (non-blocking failure). Set hook `timeout` to `APPROVAL_TIMEOUT_MS/1000 + 60` to leave a safety margin.
- **Resolving approval after Telegram edit**: Call `pending.resolve(decision)` before or during the Telegram message edit, not after. The HTTP response can go out immediately; no need to wait for Telegram to confirm the edit.
- **Using full tool_use_id in callback_data**: Telegram callback_data max is 64 bytes. A full UUID (36 chars) + prefix "approve:" = 44 chars — fits, but leave room for error. Use `approve:` (8) + UUID (36) = 44 bytes — acceptable.
- **Not calling answerCallbackQuery()**: Always call this immediately when a button is pressed. Clients display a loading spinner for up to 1 minute if not answered.
- **Late button actions after expiry**: After auto-deny fires, remove or disable buttons. Use `editMessageReplyMarkup` with null keyboard. If a late tap arrives for an already-resolved approval, the `pending.get(toolUseId)` call returns `null` — handle gracefully by calling `answerCallbackQuery("This approval has already expired.")`.
- **tmux injection without checking pane exists**: If tmux pane is not available (session not running in tmux), fall back to queuing and notify user that delivery requires tmux.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Callback data routing | String splitting / custom serialization | grammY `bot.callbackQuery(regex, ...)` with capture groups | Built-in, type-safe, handles all edge cases |
| Request timeout handling | Custom polling loop | `setTimeout` + `Promise.withResolvers()` | Native and minimal |
| Message editing after button press | Re-sending new message | `ctx.editMessageText()` | Inline edit preserves message context and avoids chat clutter |
| Inline keyboard removal | Complex markup manipulation | `{ reply_markup: undefined }` in `editMessageText` | grammY passes undefined to remove keyboard |
| Shell command execution for tmux | Node.js PTY binding or custom IPC | `node:child_process execSync` | Tmux CLI is the official interface; execSync is synchronous and simple for these short commands |

**Key insight:** The entire approval flow state machine can be managed with a single `Map<string, PendingApproval>` and JavaScript Promises. No external state store, no database, no Redis needed.

## Common Pitfalls

### Pitfall 1: HTTP Hook Timeout Race Condition
**What goes wrong:** Claude Code's HTTP hook timeout fires before the user responds, causing Claude Code to continue (non-blocking failure). The bot then receives a button tap for an already-timed-out approval.
**Why it happens:** The HTTP hook `timeout` field in the hook config defaults to 30 seconds for HTTP hooks in examples, but the actual documented default for command hooks is 600 seconds. HTTP default is not explicitly documented.
**How to avoid:** Explicitly set `timeout` in the installed hook config to be larger than `APPROVAL_TIMEOUT_MS` (e.g., if approval timeout is 300s, set hook timeout to 360s). Update `install-hooks.ts` to set this.
**Warning signs:** Claude Code proceeds with tool execution even though the bot shows the approval as still pending.

### Pitfall 2: callback_data Length Limit
**What goes wrong:** Telegram rejects inline keyboard buttons with callback_data exceeding 64 bytes, resulting in an API error when posting the approval message.
**Why it happens:** UUIDs are 36 chars. With prefix `approve:` that's 44 bytes — fine. But if using full session_id + tool_use_id, it easily exceeds 64 bytes.
**How to avoid:** Use only the `tool_use_id` in callback_data. tool_use_id from Claude Code is a UUID (36 chars). `approve:` prefix (8 chars) + UUID (36 chars) = 44 bytes — within limit.
**Warning signs:** `TelegramError: Bad Request: BUTTON_DATA_INVALID` when posting approval messages.

### Pitfall 3: answerCallbackQuery Not Called
**What goes wrong:** Telegram shows a loading spinner on the button for up to 1 minute after the user taps it.
**Why it happens:** Telegram requires every callback query to be answered within 10 seconds. If not answered, the client keeps showing the loading state.
**How to avoid:** Call `await ctx.answerCallbackQuery()` as the FIRST thing in every `bot.callbackQuery()` handler, before any async operations.
**Warning signs:** Users complain about buttons showing loading indicators after tapping.

### Pitfall 4: Stale Approval After Auto-Deny
**What goes wrong:** User taps Approve/Deny after the timeout has already fired and auto-denied the tool call. The bot tries to edit a message with buttons that were already replaced.
**Why it happens:** Network delay between auto-deny firing and Telegram updating the message. User might tap the button in that window.
**How to avoid:** When `decide()` returns null (approval not found in map), call `ctx.answerCallbackQuery({ text: "This approval has already expired.", show_alert: true })` to inform the user without error.
**Warning signs:** `TelegramError: Bad Request: message is not modified` when trying to edit already-edited messages.

### Pitfall 5: tmux Pane Not Available
**What goes wrong:** Bot tries to inject text into a tmux pane but the session is running in a non-tmux terminal (VS Code, plain terminal). `execSync('tmux set-buffer...')` throws.
**Why it happens:** `TMUX_PANE` environment variable is only set when running inside tmux. The shell hook script that captures it produces no output outside tmux.
**How to avoid:** Check if tmux pane ID was captured for the session before attempting injection. If not available, queue the text and notify user: "Input queued — waiting for Claude Code to be running in tmux for delivery."
**Warning signs:** `Error: Command failed: tmux set-buffer` in logs when user sends text.

### Pitfall 6: editMessageText "Message is not modified" Error
**What goes wrong:** Auto-deny fires and tries to edit the message, but the same edit was also attempted by a concurrent button press.
**Why it happens:** Race condition between timeout firing and user tapping a button at the same millisecond.
**How to avoid:** Since `decide()` removes the entry from the map atomically, only one path can win. The other path gets null from `decide()` and should skip the edit. The map operation is synchronous in single-threaded Node.js — no race condition possible.
**Warning signs:** This actually cannot happen in practice due to single-threaded execution. If errors appear, investigate the promise resolution order.

### Pitfall 7: PreToolUse Hook Installation Conflict
**What goes wrong:** The bot installs a PreToolUse hook with `matcher: ""` (match all), but the user has existing PreToolUse hooks for specific tools. The bot's catch-all hook intercepts everything including tools the user's hooks handle.
**Why it happens:** The `install-hooks.ts` merge logic uses spread `{...existingHooks, ...hookConfig}` which overwrites existing PreToolUse configuration.
**How to avoid:** For PreToolUse, APPEND to existing array rather than replacing. Read existing `hooks.PreToolUse`, prepend the bot's hook, and write back.
**Warning signs:** User's existing PreToolUse hooks stop working after bot installation.

## Code Examples

Verified patterns from official sources:

### PreToolUse Response Format (CTRL-01)
```typescript
// Source: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
// Allow: returns this JSON as HTTP response body
const allowResponse = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'Approved by user via Telegram',
  },
};

// Deny: returns this JSON as HTTP response body
const denyResponse = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Denied by user via Telegram',  // shown to Claude
  },
};

// Auto-deny with timeout reason
const timeoutDenyResponse = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Auto-denied: approval timeout',
  },
};
```

### InlineKeyboard with Approve/Deny Buttons
```typescript
// Source: grammy.dev/plugins/keyboard
import { InlineKeyboard } from 'grammy';

function makeApprovalKeyboard(toolUseId: string): InlineKeyboard {
  // tool_use_id is a UUID (36 chars), prefix is 8 chars = 44 bytes total — within 64 byte limit
  return new InlineKeyboard()
    .text('✅ Approve', `approve:${toolUseId}`)
    .text('❌ Deny', `deny:${toolUseId}`);
}
```

### Callback Query Handler with Regex Match
```typescript
// Source: grammy.dev/plugins/keyboard
// Matches "approve:" followed by any characters, captures the ID
bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();  // MUST be called first
  const toolUseId = ctx.match[1];
  // ... handle approval
});
```

### editMessageText to Remove Keyboard
```typescript
// Source: grammy.dev/ref/core/context
// Pass undefined (or omit) reply_markup to remove inline keyboard
await ctx.editMessageText(newText, {
  parse_mode: 'HTML',
  reply_markup: new InlineKeyboard(),  // empty keyboard removes buttons
});
// OR use editMessageReplyMarkup with empty InlineKeyboard
await bot.api.editMessageReplyMarkup(chatId, messageId, {
  reply_markup: new InlineKeyboard(),
});
```

### Text Input Detection in Forum Topics
```typescript
// Source: grammy.dev/guide/filter-queries
// Listen for text messages in any forum topic we manage
bot.on('message:text', async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  if (!threadId) return;  // not in a forum topic

  // Find session for this topic
  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;  // not a managed session topic

  // Don't respond to bot commands (/verbose, /normal, /quiet, /status)
  if (ctx.message.text.startsWith('/')) return;

  // Feed text to Claude Code or queue it
  await inputManager.handleIncomingText(session, ctx.message.text, ctx);
});
```

### tmux Bracketed Paste Injection
```typescript
// Confirmed working pattern from https://github.com/anthropics/claude-code/issues/15553
import { execSync } from 'node:child_process';

function injectViaTmux(tmuxPane: string, text: string): void {
  // Use bracketed paste to avoid autocomplete intercepting Enter
  // $TMUX_PANE format: "%5" (tmux's pane ID)
  execSync(`tmux set-buffer ${shellQuote(text)}`);
  execSync(`tmux paste-buffer -p -t ${shellQuote(tmuxPane)}`);
  // Send Enter after the paste completes
  execSync(`tmux send-keys -t ${shellQuote(tmuxPane)} Enter`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
```

### Hook Configuration for PreToolUse (install-hooks.ts update)
```typescript
// Source: https://code.claude.com/docs/en/hooks (HTTP hook fields)
// Timeout must be > APPROVAL_TIMEOUT_MS (default 300s) to prevent premature timeout
// Using 360 seconds = 6 minutes for 5-minute default approval timeout
const approvalTimeoutSec = Math.ceil((approvalTimeoutMs / 1000) + 60);

const preToolUseHook = {
  matcher: '',  // match all tools
  hooks: [
    {
      type: 'http',
      url: `${baseUrl}/hooks/pre-tool-use`,
      timeout: approvalTimeoutSec,
    },
  ],
};

// IMPORTANT: Append to existing PreToolUse array, don't replace
const existingPreToolUse = (existingHooks.PreToolUse as unknown[]) || [];
hookConfig.PreToolUse = [...existingPreToolUse, preToolUseHook];
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `decision: "approve"/"block"` in PreToolUse response | `hookSpecificOutput.permissionDecision: "allow"/"deny"` | Late 2024 | Old format deprecated but still works; use new format |
| Hard-coded 60s hook timeout | Configurable `timeout` field per hook | v1.0.41 (July 2025) | Must explicitly set timeout for long-running approval flows |
| HTTP hooks: separate response code for blocking | HTTP hooks: always 2xx, use JSON body for decisions | Current | Non-2xx HTTP responses are non-blocking errors — cannot block via status code |

**Deprecated/outdated:**
- `decision: "approve"` in PreToolUse hook output: Replaced by `hookSpecificOutput.permissionDecision: "allow"`. Still maps but flagged as deprecated.
- `decision: "block"` in PreToolUse hook output: Replaced by `hookSpecificOutput.permissionDecision: "deny"`. Still maps but deprecated.

## Open Questions

1. **HTTP hook default timeout for HTTP type**
   - What we know: Official docs list "Defaults: 600 for command, 30 for prompt, 60 for agent" — no explicit HTTP default listed. Example shows `timeout: 30` for HTTP hook.
   - What's unclear: Whether HTTP hooks default to 30s (as suggested by examples) or 600s (command default)
   - Recommendation: Explicitly set `timeout` in the hook config regardless of default. Use `Math.ceil(APPROVAL_TIMEOUT_MS / 1000) + 60` seconds.

2. **Permission mode gating for PreToolUse**
   - What we know: CONTEXT.md says "Only tools that Claude Code itself would prompt for (based on session's permission_mode) trigger approval."
   - What's unclear: The exact logic for which tools prompt in each permission mode is not publicly documented as a list
   - Recommendation: Mirror the `permission_mode` field from the PreToolUse payload. If `permission_mode === 'bypassPermissions'` or `'dontAsk'`, return allow immediately. For `'default'` and `'acceptEdits'`, show approval prompt.

3. **tmux availability detection**
   - What we know: `$TMUX_PANE` is set by tmux when running inside it. Can be captured by a SessionStart command hook.
   - What's unclear: The most reliable way to pass it to the HTTP hook server (file vs. additionalContext vs. separate endpoint)
   - Recommendation: Use a temp file approach: SessionStart command hook writes `$TMUX_PANE` to `/tmp/claude-tmux-pane-${session_id}.txt`; the HTTP hook server reads it during `handleSessionStart`. Clean up on session end.

4. **Concurrent approvals for the same session**
   - What we know: Claude Code's agentic loop runs one tool at a time, so concurrent approvals for the same session are unlikely in normal operation.
   - What's unclear: Whether multiple tool calls can be queued for approval simultaneously in some edge case
   - Recommendation: The `Map<tool_use_id, PendingApproval>` keying supports multiple concurrent approvals per session naturally. No special handling needed.

## Sources

### Primary (HIGH confidence)
- `https://code.claude.com/docs/en/hooks` — Complete PreToolUse hook documentation: request/response format, `permissionDecision` field, HTTP hook fields, timeout configuration, blocking behavior
- `grammy.dev/plugins/keyboard` — InlineKeyboard, callback_query handling, answerCallbackQuery, editMessageText patterns
- `grammy.dev/guide/filter-queries` — `bot.on("message:text")`, message_thread_id filtering

### Secondary (MEDIUM confidence)
- `github.com/anthropics/claude-code/issues/4362` — Confirmed PreToolUse hook properly blocks execution; correct format is `hookSpecificOutput.permissionDecision`
- `github.com/anthropics/claude-code/issues/2803` — Hook timeout was hardcoded 60s before v1.0.41; now configurable via `timeout` field
- `github.com/anthropics/claude-code/issues/15553` — Confirmed tmux bracketed paste (`tmux set-buffer` + `paste-buffer -p`) as working mechanism for programmatic Claude Code input
- WebSearch verification of Telegram callback_data 64-byte limit

### Tertiary (LOW confidence)
- Exact HTTP hook default timeout (not explicitly stated in docs for HTTP type specifically)
- Permission mode → tool prompt behavior mapping (which tools show prompts in which modes)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use from Phase 1, no new dependencies
- CTRL-01 (approval flow): HIGH — PreToolUse HTTP hook format fully documented, grammY callbacks fully documented
- CTRL-03 (auto-deny timeout): HIGH — simple setTimeout + Promise pattern, well established
- CTRL-02 (text input): MEDIUM — tmux mechanism confirmed working by community but requires tmux to be present; no official hook-based alternative exists
- Architecture: HIGH — extends existing Phase 1 patterns cleanly

**Research date:** 2026-02-28
**Valid until:** 2026-03-30 (30 days — stable APIs; Claude Code hooks API may evolve)
