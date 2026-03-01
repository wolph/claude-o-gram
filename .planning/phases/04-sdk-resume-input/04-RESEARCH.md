# Phase 4: SDK Resume Input - Research

**Researched:** 2026-03-01
**Domain:** Claude Agent SDK `query()` + `resume` for replacing tmux text injection
**Confidence:** HIGH

## Summary

Phase 4 replaces the tmux text injection mechanism (`TextInputManager.inject()` via `tmux send-keys/paste-buffer`) with SDK-based input using the `query({ prompt, options: { resume: sessionId } })` pattern. This is the narrowest possible v2.0 change: only the text input path changes. The Fastify hook server, transcript watcher, approval flow, and all monitoring components remain untouched in Phase 4. Phase 5 handles the cleanup of tmux code.

The critical architectural decision -- already locked in STATE.md -- is to use **one-shot `query()` with `resume: sessionId`** per user message rather than the AsyncIterable streaming input mode. This avoids the double-turn bug (#207, still UNFIXED as of SDK v0.2.63), which would double API token costs. The tradeoff is latency: each resume call spawns a new Claude Code child process with ~12-second cold start overhead. This is acceptable because: (1) human reply latency in Telegram naturally exceeds 12 seconds, (2) the bot shows a "sending..." reaction immediately, and (3) the alternative (2x token costs) is far worse for production use.

The implementation requires: (a) installing the SDK package + zod peer dep, (b) creating a new `SdkInputManager` class that wraps `query({ prompt: text, options: { resume: sessionId } })`, (c) modifying the bot's text message handler to call the new manager instead of the tmux-based `TextInputManager`, (d) adding `sdkSessionId` to the session type for resume targeting, and (e) capturing the SDK session ID from the system init message when sessions start via hooks. Crucially, sessions are still STARTED externally (via Claude Code CLI) and discovered via HTTP hooks -- Phase 4 does NOT change session initiation. It only changes how follow-up text input is delivered.

**Primary recommendation:** Install `@anthropic-ai/claude-agent-sdk` and `zod`, create `SdkInputManager` that calls `query({ prompt, options: { resume } })` per message, wire it into the existing bot text handler, and react with checkmark on success.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SDK-01 | Text input from Telegram is delivered to Claude Code via SDK `query({ resume })` instead of tmux injection | Core deliverable: SdkInputManager wraps `query()` with `resume` option. See Architecture Pattern 1 and Code Examples. |
| SDK-02 | SDK input works cross-platform (no tmux dependency for text delivery) | Automatic: SDK `query()` is pure Node.js, no OS-specific dependencies. The tmux code path is bypassed (not removed -- that's Phase 5). |
| SDK-03 | Quoted message context is included when user replies to a specific bot message | Existing quote-prepending logic in `bot.ts` text handler stays unchanged. The `[Quoting: "..."]` prefix is passed to `query()` as part of the prompt string. |
| REL-01 | Text input reliably submits (no more "flash and disappear" tmux issues) | SDK `query()` either completes or throws -- no silent failures like tmux injection. Error handling wraps the call and reports failures to the user. |
| REL-02 | Input delivery confirms success via message reaction | Bot reacts with checkmark after `query()` returns its first `SDKSystemMessage` or `SDKResultMessage`, confirming the input was accepted. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.63 | SDK `query()` function for resume-based input delivery | Official Anthropic SDK; only programmatic way to send input to Claude Code sessions |
| `zod` | ^4.0.0 | Required peer dependency of the Agent SDK | SDK will not install without it; not used directly in bot code |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `grammy` | ^1.40.1 | Telegram bot (EXISTING, unchanged) | All Telegram interactions |
| `dotenv` | ^17.3.1 | Env var loading (EXISTING, unchanged) | Loads `ANTHROPIC_API_KEY` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| One-shot+resume | AsyncIterable streaming input | Streaming avoids 12s cold start per message but triggers double-turn bug (#207), doubling token costs. Use one-shot+resume until #207 is fixed. |
| One-shot+resume | V2 `unstable_v2_createSession` + `send()` | V2 API silently ignores `permissionMode`, `cwd`, `allowedTools` (#176). Use V1 `query()` only. |

**Installation:**
```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

**New environment variable:**
```
ANTHROPIC_API_KEY=sk-ant-...  # Required by SDK for API authentication
```

## Architecture Patterns

### Recommended Project Structure (Phase 4 additions)
```
src/
  sdk/
    input-manager.ts     # NEW: SdkInputManager - wraps query()+resume for text input
  control/
    input-manager.ts     # EXISTING: TextInputManager - tmux code KEPT (Phase 5 removes)
  bot/
    bot.ts               # MODIFIED: text handler calls SdkInputManager instead of TextInputManager
  types/
    sessions.ts          # MODIFIED: add sdkSessionId field
  hooks/
    handlers.ts          # MODIFIED: capture sdkSessionId on SessionStart
  config.ts              # MODIFIED: validate ANTHROPIC_API_KEY
  index.ts               # MODIFIED: instantiate SdkInputManager, pass to bot
```

### Pattern 1: One-Shot Resume Input
**What:** Each user text message triggers a new `query()` call with `resume: sessionId` and the text as a string prompt. The query processes the input, Claude responds, and the query completes. The SDK persists session state to disk, so the next resume picks up full conversation history.

**When to use:** Every time a user sends a text message in a session topic.

**Key insight:** This spawns a new child process per message (~12s cold start). The process runs, delivers the input, Claude responds, and the process exits. This is NOT a long-lived streaming session -- it is fire-and-forget per message.

**Important:** The `query()` output (Claude's response) is already captured by the existing TranscriptWatcher and hook server. Phase 4 does NOT need to process the query's output stream for Telegram display. The only purpose of the `query()` call is to deliver user input. The response output flows through the existing v1 infrastructure (hooks + transcript watcher).

**Example:**
```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/sessions
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

async function sendInput(sdkSessionId: string, text: string, cwd: string): Promise<void> {
  const q = query({
    prompt: text,
    options: {
      resume: sdkSessionId,
      cwd,
      // Let the existing external Claude Code session handle permissions
      // The SDK resume just delivers the text, the running session handles the rest
    },
  });

  // Consume the query to completion -- we need the process to run
  // but the output is already captured by the hook server + transcript watcher
  for await (const message of q) {
    // Minimal processing: just drain the stream
    if (message.type === "result") {
      break; // Query complete
    }
  }
}
```

### Pattern 2: Session ID Capture on Hook Event
**What:** When a SessionStart hook fires (externally-launched Claude Code session), the bot needs to know the SDK session ID for later resume calls. The session ID is available in the hook payload's `session_id` field -- this is ALREADY captured and stored in `SessionInfo.sessionId`. The existing `sessionId` from hooks IS the SDK session ID needed for `resume`.

**When to use:** No new code needed -- the existing `session_id` from hook payloads is the same UUID used by `options.resume`.

**Key insight:** The hook payload's `session_id` and the SDK's `resume` session ID are the same thing. Claude Code sessions have a single UUID that is used both for hook identification and SDK session management. No additional ID capture is needed.

### Pattern 3: Parallel Output Channels
**What:** When `query({ resume })` runs, the Claude Code CLI subprocess generates output. This output is also visible to the existing hook server (PostToolUse, Notification hooks) and transcript watcher (JSONL file). There are now TWO output channels: the SDK `query()` async generator AND the existing hook/transcript infrastructure.

**When to use:** Phase 4 design must account for this dual-output scenario.

**Resolution:** Ignore the SDK query output for display purposes. The existing hook server and transcript watcher already handle all output forwarding to Telegram. The SDK `query()` call's purpose is solely input delivery. Drain the query stream (consume to completion) but do not route its messages to Telegram -- they would be duplicates of what the hook server already sends.

**Critical caveat:** Verify empirically that `query({ resume })` output IS captured by the running session's hooks. If the resume creates a SEPARATE session context that does not trigger hooks on the original session, then the query output must be processed. This is the key open question for Phase 4 validation.

### Anti-Patterns to Avoid
- **Processing SDK query output for Telegram display:** The existing hook server + transcript watcher already captures Claude's responses. Processing the `query()` output would create duplicate messages in Telegram.
- **Replacing the hook server in Phase 4:** Phase 4 ONLY replaces text input. The hook server stays until a future phase.
- **Using AsyncIterable streaming input:** Triggers double-turn bug (#207), doubling token costs. Use string prompt with resume.
- **Removing TextInputManager in Phase 4:** Keep the old code as fallback. Phase 5 removes it.
- **Trying to reuse an existing child process:** Each `query()` call spawns a fresh process. There is no process reuse in one-shot mode. This is by design.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session state persistence | Custom conversation history storage | SDK's built-in `persistSession: true` (default) | SDK automatically saves session state to `~/.claude/projects/` for resume |
| Input delivery to Claude Code | Custom IPC, stdin piping, named pipes | `query({ prompt, options: { resume } })` | SDK handles process spawn, input delivery, and session context loading |
| Session ID tracking | Custom session discovery/enumeration | Existing hook payload `session_id` | Already captured and stored in SessionStore |
| Cross-platform input | Platform-specific terminal injection | SDK `query()` | Works on Linux, macOS, Windows -- pure Node.js |

**Key insight:** Phase 4 is intentionally narrow. The only "new" code is a thin wrapper around `query()` that maps Telegram text messages to SDK resume calls. Everything else (session lifecycle, output capture, approval flow, monitoring) continues through existing v1 infrastructure.

## Common Pitfalls

### Pitfall 1: 12-Second Cold Start Per Resume Call
**What goes wrong:** Each `query({ resume })` spawns a fresh Claude Code child process. Users experience 12-second delays between sending a message and seeing Claude's response begin.
**Why it happens:** The SDK does not support hot process reuse for one-shot queries. Each call initializes the CLI, loads session context, connects to the API.
**How to avoid:** (1) React with a "sending" indicator immediately so the user knows input was received. (2) The 12s delay is for the response to START -- input delivery is the first thing the process does. (3) Accept this as a known tradeoff vs. the double-turn bug. (4) Human reply cadence in Telegram naturally exceeds 12s.
**Warning signs:** Users complaining about "slow" input delivery. Monitor the time between message send and first Claude response.

### Pitfall 2: Orphaned Child Processes from Resume Calls
**What goes wrong:** Each `query({ resume })` spawns a child process. If the bot crashes mid-query, or if the query hangs, orphaned processes accumulate.
**Why it happens:** SDK issue #142 (UNFIXED). Child processes have no parent death signal.
**How to avoid:** (1) Always consume the query to completion in a try/finally with `q.close()` in finally. (2) Set `maxTurns` to prevent runaway sessions. (3) Use AbortController with a timeout (e.g., 300 seconds). (4) On bot startup, clean up orphaned Claude processes.
**Warning signs:** `ps aux | grep claude` showing processes with PPID=1.

### Pitfall 3: Duplicate Output from Resume Query
**What goes wrong:** The resume `query()` generates output (Claude's response). The existing hook server and transcript watcher ALSO capture the same output. If both are routed to Telegram, every Claude response appears twice.
**Why it happens:** Two independent output channels exist simultaneously.
**How to avoid:** Do NOT process the SDK query output for Telegram display. Drain the stream silently. The existing infrastructure handles output forwarding.
**Warning signs:** Messages appearing twice in Telegram topics after Phase 4 is deployed.

### Pitfall 4: SDK Session ID vs Hook Session ID Mismatch
**What goes wrong:** The `session_id` from a `query({ resume })` init message differs from the original session's `session_id` in the hook payload.
**Why it happens:** This SHOULD NOT happen -- the resume option explicitly continues the same session. But the SDK docs note that `forkSession: true` (which is NOT the default) would create a new ID.
**How to avoid:** Always use `forkSession: false` (the default). Verify in testing that `query({ resume: id })` produces a system init message with the SAME `session_id`.
**Warning signs:** SessionStore lookups by session ID failing after resume.

### Pitfall 5: ANTHROPIC_API_KEY Billing Model Change
**What goes wrong:** v1.0 used the user's existing Claude Code CLI auth (Claude.ai subscription, free for Pro users). SDK `query()` requires `ANTHROPIC_API_KEY` which bills per-token via the Anthropic API. Users are surprised by API charges.
**Why it happens:** Fundamental difference between CLI auth and API auth.
**How to avoid:** Document the billing model change clearly. Validate `ANTHROPIC_API_KEY` at startup with a clear error message.
**Warning signs:** Users reporting unexpected Anthropic API charges.

### Pitfall 6: Resume Fails When Session Not Persisted
**What goes wrong:** `query({ resume: sessionId })` fails or creates a new session instead of resuming because the original session was not persisted to disk.
**Why it happens:** SDK's `persistSession` defaults to `true`, but if the original Claude Code CLI session was started with `--no-persist-session` or if session files were cleaned up, resume will fail.
**How to avoid:** Verify resume works in testing with a real external CLI session. If resume fails, provide a clear error message: "Cannot deliver input -- session not found for resume."
**Warning signs:** SDK `query()` throwing errors about missing session files, or starting a fresh session instead of resuming.

## Code Examples

Verified patterns from official sources:

### SdkInputManager Class
```typescript
// Source: Synthesized from https://platform.claude.com/docs/en/agent-sdk/sessions
// and https://platform.claude.com/docs/en/agent-sdk/typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export class SdkInputManager {
  /**
   * Send text input to a Claude Code session via SDK resume.
   * Each call spawns a new query() with resume, delivering the text as a user prompt.
   *
   * @param sdkSessionId The session ID to resume (from hook payload session_id)
   * @param text The user's text input
   * @param cwd The session's working directory
   * @returns 'sent' if input delivered, 'failed' with error message
   */
  async send(
    sdkSessionId: string,
    text: string,
    cwd: string,
  ): Promise<{ status: 'sent' } | { status: 'failed'; error: string }> {
    const abortController = new AbortController();
    // Safety timeout: 5 minutes max per resume call
    const timeout = setTimeout(() => abortController.abort(), 300_000);

    try {
      const q = query({
        prompt: text,
        options: {
          resume: sdkSessionId,
          cwd,
          abortController,
          // Do not load filesystem settings -- the external CLI session has its own
          settingSources: [],
        },
      });

      // Drain the query stream to completion
      // Output is captured by existing hook server + transcript watcher
      try {
        for await (const message of q) {
          if (message.type === "result") {
            break;
          }
        }
      } finally {
        q.close();
      }

      return { status: 'sent' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`SDK resume input failed for session ${sdkSessionId}:`, errorMsg);
      return { status: 'failed', error: errorMsg };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Clean up (no-op for now; may track active queries in future) */
  cleanup(_sessionId: string): void {
    // No persistent state to clean up -- each query() is independent
  }
}
```

### Modified Bot Text Handler
```typescript
// Source: Existing src/bot/bot.ts pattern, adapted for SDK input
bot.on('message:text', async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  if (!threadId) return;

  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;
  if (session.status !== 'active') return;
  if (ctx.message.text.startsWith('/')) return;

  // Build input text with quoted context (existing logic, unchanged)
  let text = ctx.message.text;
  const replied = ctx.message.reply_to_message;
  if (replied && 'text' in replied && replied.text) {
    text = `[Quoting: "${replied.text}"]\n\n${text}`;
  }

  // Try SDK input first (Phase 4), fall back to tmux (legacy)
  const result = await sdkInputManager.send(
    session.sessionId, // This IS the SDK session ID
    text,
    session.cwd,
  );

  if (result.status === 'sent') {
    try {
      await ctx.react('\u2705'); // Checkmark reaction (REL-02)
    } catch {
      // Reaction not supported -- ignore
    }
  } else {
    // SDK input failed -- fall back to tmux if available
    const tmuxResult = inputManager.send(session.tmuxPane, session.sessionId, text);
    switch (tmuxResult) {
      case 'sent':
        try { await ctx.react('\u{1F44D}'); } catch { /* ignore */ }
        break;
      case 'queued':
        await ctx.reply('\u{1F4E5} Input queued -- SDK delivery failed, tmux fallback queued');
        break;
      case 'failed':
        await ctx.reply(`\u274C Failed to send input: ${result.error}`);
        break;
    }
  }
});
```

### ANTHROPIC_API_KEY Validation
```typescript
// Source: Existing config.ts pattern
// In loadConfig():
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  throw new Error(
    'ANTHROPIC_API_KEY is required for SDK text input delivery. '
    + 'Get an API key at https://console.anthropic.com/'
  );
}
```

### Session Type Update
```typescript
// Source: Existing src/types/sessions.ts
export interface SessionInfo {
  // ... existing fields ...

  // Phase 4: SDK session ID is the same as sessionId (from hook payload)
  // No new field needed -- session_id from hooks IS the SDK session ID
  // This comment documents the intentional reuse.
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tmux `send-keys` / `paste-buffer` | SDK `query({ resume })` | Phase 4 (this phase) | Cross-platform, reliable, no terminal dependency |
| Direct terminal injection | Programmatic API call | Phase 4 | Input delivery is an async function call, not shell exec |
| Linux-only (tmux required) | Any OS with Node.js 18+ | Phase 4 | Windows, macOS, Linux all work |

**Deprecated/outdated (Phase 5 will remove):**
- `TextInputManager.inject()` -- tmux injection code
- `tmuxPane` field on `SessionInfo`
- `capture-tmux-pane.sh` hook script
- `tryReadTmuxPane()` helper function

## Open Questions

1. **Does `query({ resume })` output trigger hooks on the original session?**
   - What we know: The resume call creates a child process that loads the session context and sends the input. The running Claude Code CLI session (started externally) has its own hooks configured.
   - What's unclear: Does the resume process trigger the SAME hooks (PostToolUse, etc.) that the original CLI process does? If so, the existing hook server will capture the output. If not, the `query()` output must be processed for Telegram.
   - Recommendation: Test empirically in Phase 4 Wave 1. Start an external Claude Code session, send input via `query({ resume })`, and verify hooks fire on the hook server. If they do NOT fire, add minimal output processing from the query stream.
   - **NOTE:** There is a subtlety here. `query({ resume })` spawns its OWN Claude Code process. It is NOT sending input to the EXISTING process. It is RESUMING the session in a NEW process. This means: the original process may still be running (conflicting), OR the original process may have ended (resume picks up where it left off). Phase 4 assumes the user sends text AFTER Claude has responded and is waiting for input (i.e., the original process has hit a `result` and exited). If the user sends text while Claude is STILL processing, behavior is undefined.

2. **Can two `query()` calls resume the same session concurrently?**
   - What we know: The SDK docs don't explicitly address concurrent resume.
   - What's unclear: If user sends two rapid messages, the second `query({ resume })` may start before the first finishes. This could corrupt session state.
   - Recommendation: Queue messages. Only allow one active `query({ resume })` per session at a time. The second message waits until the first completes.

3. **Resume latency: exactly how long?**
   - What we know: Cold start for `query()` is ~12 seconds (issue #34, benchmarked). Resume loads session context from disk, which may add 1-3 seconds on top.
   - What's unclear: Whether resume with a large session (many turns) is significantly slower than resume with a small session.
   - Recommendation: Accept 12-15s latency. Show immediate "sending" feedback in Telegram. Benchmark during implementation.

4. **Does `resume` interact correctly with `settingSources: []`?**
   - What we know: SDK defaults to `settingSources: []` (no filesystem settings loaded). The external CLI session has its own settings.
   - What's unclear: If the resume call uses `settingSources: []`, does it still pick up the session's previous settings from the persisted session state? Or do settings need to be re-specified?
   - Recommendation: Start with `settingSources: []` since we are only delivering input, not configuring the session. Test that Claude's behavior in the resumed turn matches the original session's configuration.

## Sources

### Primary (HIGH confidence)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- complete V1 API: `query()`, `Options` (resume field), `SDKMessage` types, `Query` object methods
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- session IDs, resume pattern, fork vs continue, code examples
- [Streaming vs Single-Turn Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- one-shot string prompt vs AsyncIterable, resume use case
- [Hosting the Agent SDK](https://platform.claude.com/docs/en/agent-sdk/hosting) -- process lifecycle, 1GiB RAM recommendation, container patterns

### Secondary (MEDIUM confidence)
- [GitHub Issue #207: AsyncIterable double turn](https://github.com/anthropics/claude-agent-sdk-typescript/issues/207) -- OPEN, unfixed. Confirms one-shot+resume is the recommended workaround.
- [GitHub Issue #34: 12-second overhead](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) -- CLOSED. Benchmarks: 12s cold start per `query()`. Streaming input mode resolves for same-session, but one-shot+resume has full cold start.
- [GitHub Issue #142: Orphaned processes](https://github.com/anthropics/claude-agent-sdk-typescript/issues/142) -- OPEN, unfixed. Each `query()` spawns a child process that can leak.
- [GitHub Issue #176: V2 ignores options](https://github.com/anthropics/claude-agent-sdk-typescript/issues/176) -- OPEN, unfixed. Confirms V2 API is unsuitable.
- [npm: @anthropic-ai/claude-agent-sdk v0.2.63](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- latest version, peer deps confirmed

### Tertiary (LOW confidence)
- Resume interaction with concurrent external sessions -- needs empirical validation
- `settingSources` behavior during resume -- needs empirical validation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - SDK package verified on npm, resume API documented with examples
- Architecture: HIGH for one-shot+resume pattern, MEDIUM for dual-output-channel behavior
- Pitfalls: HIGH - all pitfalls verified against GitHub issues and official docs

**Research date:** 2026-03-01
**Valid until:** 2026-03-15 (SDK updates every 1-3 days; re-check issue #207 status before implementation)
