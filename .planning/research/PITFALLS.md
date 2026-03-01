# Domain Pitfalls: Claude Agent SDK Migration

**Domain:** Migrating Telegram bot from hook-based architecture to Claude Agent SDK
**Researched:** 2026-03-01
**Confidence:** HIGH (verified against official SDK docs, GitHub issues, and changelog)

## Critical Pitfalls

Mistakes that cause rewrites, data loss, or architectural dead ends.

---

### Pitfall 1: Each SDK Session Spawns a Separate OS Process (~12s Cold Start, ~50-100MB RAM)

**What goes wrong:**
The Claude Agent SDK does not run as a library in your Node.js process. Each `query()` call spawns a new Claude Code CLI child process. This process takes ~12 seconds to initialize (loading CLI, connecting to API, setting up tools). With 2-3 concurrent sessions, that is 2-3 child processes consuming 50-100MB RAM each, plus the ~12-second startup delay every time a new session begins. Your bot process (grammY + Fastify) is the parent of all these children.

**Why it happens:**
The SDK is a wrapper around the Claude Code CLI, not a native library. It communicates with child processes via stdin/stdout JSON messages. There is no "daemon mode" or process pooling -- each session is a fresh process spawn. This is a fundamental architectural choice documented in GitHub issue #34 and confirmed by Anthropic's response recommending streaming input mode as the workaround for single-session latency.

**Consequences:**
- 12-second delay before a new Claude Code session can respond in Telegram
- 2-3 concurrent sessions = 150-300MB additional RAM on top of the bot process
- Orphaned child processes if the bot crashes (issue #142 -- NOT FIXED as of March 2026)
- Node.js parent process must manage child process lifecycle (SIGTERM, SIGKILL)

**Prevention:**
- Use streaming input mode (AsyncIterable prompt) for long-lived sessions -- keeps the process alive between messages, reducing subsequent message latency to 2-3 seconds
- Budget for the 12-second cold start in UX: show "Starting session..." in Telegram immediately, update when ready
- Implement periodic orphan process cleanup: scan for Claude CLI processes whose parent PID no longer exists
- Set `maxTurns` to prevent runaway sessions consuming memory indefinitely
- Monitor RSS of child processes and implement a hard kill if any exceeds a threshold (e.g., 200MB)

**Warning signs:**
- Increasing memory usage over time with active sessions
- `ps aux | grep claude` showing more processes than expected active sessions
- 12-second gaps between session start and first Telegram message

**Phase to address:**
Phase 1 (SDK integration foundation). The process lifecycle management must be designed before any feature work. This is the single most impactful architectural difference from the v1.0 hook-based approach.

---

### Pitfall 2: AsyncIterable Prompt Mode Doubles Token Costs (Issue #207 -- NOT FIXED)

**What goes wrong:**
When using streaming input mode (the recommended approach for multi-turn conversations), every user message triggers TWO complete AI turns instead of one. The SDK sends the user message, Claude responds (turn 1), then the CLI interprets the still-open stdin as "more input may come" and runs a redundant second turn (turn 2). This doubles your Anthropic API costs and doubles the messages you need to process for Telegram output.

**Why it happens:**
The `streamInput()` function immediately loops back to await the next message from the AsyncIterable after writing a message. Because the stdin stays open (it is a persistent stream), the CLI runs another agentic turn before the next user message arrives. String prompts close stdin after the first result, which is why single-shot mode does not have this problem.

**Consequences:**
- 2x token consumption per user interaction
- 2x the streaming output to process and forward to Telegram
- Duplicate `result` messages that must be filtered
- With 7+ agents handling ~1000 messages/month: $140-$700/month in wasted tokens (per reporter's estimate)

**Prevention:**
- **Workaround A (recommended for our use case):** Use one-shot `query()` with `resume: sessionId` for each user message. This avoids the double-turn bug entirely. Downside: 3-12 second cold start per message (the 12-second overhead from Pitfall 1 applies).
- **Workaround B:** Use streaming input but filter output to only process the FIRST `result` message per user turn. Tokens are still wasted but UX is correct.
- **Workaround C:** Set `maxTurns: 1` per query. This prevents the second turn but also prevents Claude from using tools and then responding (Claude needs at least 2 turns for tool-use workflows). UNSUITABLE for our use case.
- Track this issue (#207) and switch to streaming input once fixed.

**Warning signs:**
- Telegram topics showing duplicate Claude responses per user message
- API cost bills doubling compared to v1.0 hook-based approach
- Two `result` messages per query in SDK output logs

**Phase to address:**
Phase 1 (SDK session management). The session interaction pattern (one-shot+resume vs streaming) must be decided early and consistently applied.

---

### Pitfall 3: V2 Preview API Silently Ignores Critical Options (Issue #176 -- NOT FIXED)

**What goes wrong:**
The new V2 interface (`unstable_v2_createSession`) silently ignores `permissionMode`, `cwd`, `allowedTools`, `disallowedTools`, `mcpServers`, and `settingSources`. These are hardcoded in the internal `SessionImpl` constructor. Your bot creates a session with `permissionMode: 'default'` and `canUseTool` callback, but the session actually runs with hardcoded defaults, bypassing your permission logic entirely.

**Why it happens:**
The V2 API is an **unstable preview** (all exports prefixed with `unstable_v2_`). The `ProcessTransport` initialization hardcodes values instead of reading from the options object. This is explicitly documented as a preview limitation.

**Consequences:**
- `canUseTool` callback never fires (or fires with wrong context)
- Sessions run in wrong directory, reading wrong project files
- No tool restrictions applied -- Claude can use any tool
- Silent failure: no error thrown, just wrong behavior
- Session forking is not available in V2 at all

**Prevention:**
- **Do NOT use the V2 preview API for production.** Use the V1 `query()` API exclusively.
- If you prototype with V2, verify every option takes effect by checking the `system` init message (`message.type === "system" && message.subtype === "init"`)
- The V2 API is appealing because `send()`/`stream()` is simpler than AsyncIterable generators. But the V1 API is the only one that actually works correctly for our use case.
- Track issues #176, #154, #160, #171 for when options passthrough is fixed.

**Warning signs:**
- Session init message showing unexpected `permissionMode`, `cwd`, or `tools`
- `canUseTool` callback never being invoked
- Sessions accessing files outside the expected project directory

**Phase to address:**
Phase 1 (technology decision). Decide V1 vs V2 on day one. Use V1.

---

### Pitfall 4: canUseTool Callback Blocks the Entire Agent Loop

**What goes wrong:**
The `canUseTool` callback is invoked every time Claude wants to use a tool that requires permission. Your bot must send a Telegram message with Approve/Deny buttons, then WAIT for the user to respond. During this wait, the entire Claude agent loop is blocked -- no other tools execute, no text streams, no progress happens. If you have a 5-minute approval timeout, Claude sits idle for 5 minutes per tool call.

**Why it happens:**
This is by design. The `canUseTool` callback returns a Promise that the SDK awaits before proceeding. Unlike the v1.0 HTTP hook approach where the HTTP response was the blocking mechanism, the SDK callback blocks the internal agent loop directly. The async nature means the Node.js event loop is NOT blocked (grammY still processes updates), but the specific Claude session is paused.

**Consequences:**
- User sees "Using Bash..." in Telegram, waits for approval, but no other session activity happens during the wait
- If approval timeout is long, Claude may hit API timeouts or internal session timeouts
- Multiple pending approvals in the same session are impossible -- they are sequential
- The `signal: AbortSignal` in the callback options can fire if the query is interrupted, but this is easy to miss

**Prevention:**
- Keep approval timeouts short (60-120 seconds, not 5+ minutes)
- Use `permissionMode: 'acceptEdits'` for low-risk operations so only dangerous tools (Bash with destructive commands) need approval
- Implement a "fast-track" in `canUseTool`: auto-approve Read, Glob, Grep without sending to Telegram
- Show a "Waiting for approval..." status in the Telegram topic so the user knows Claude is blocked
- Handle the AbortSignal: if it fires while waiting for Telegram approval, resolve with deny immediately
- Consider using the `PermissionRequest` hook (fires before `canUseTool`) to send notifications while still allowing programmatic decisions

**Warning signs:**
- Claude sessions appearing "stuck" for long periods
- Telegram approval buttons that expire frequently because Claude's internal timeout fires before the user responds
- High latency between tool calls in sessions with approval enabled

**Phase to address:**
Phase 2 (approval integration). The approval UX must be redesigned for the SDK's blocking callback model, which is fundamentally different from v1.0's HTTP request/response model.

---

### Pitfall 5: Bot Crash Orphans Claude CLI Child Processes (Issue #142 -- NOT FIXED)

**What goes wrong:**
If the bot process (Node.js parent) crashes or is killed with SIGKILL, all spawned Claude CLI child processes become orphans. These orphaned processes continue running indefinitely, each consuming 50-100MB RAM. Over 24 hours of normal usage with occasional crashes, 47 orphaned processes were observed consuming ~3GB RAM (per issue #142 reporter).

**Why it happens:**
The SDK relies on the parent process being alive to send abort signals to children. There is no `PR_SET_PDEATHSIG` (Linux) or equivalent mechanism to auto-terminate children when the parent dies. The child processes have no heartbeat to the parent. When the parent vanishes, children just keep running.

**Consequences:**
- Memory leak proportional to crash frequency times active sessions
- Orphaned processes may hold file locks or API connections
- Multiple bot restarts compound the problem (each restart leaves a generation of orphans)
- Eventually triggers OOM on the host machine

**Prevention:**
- On bot startup, scan for orphaned Claude CLI processes and kill them:
  ```bash
  # Kill Claude CLI processes whose parent is init (PID 1 = orphaned)
  pgrep -P 1 -f "claude" | xargs kill -9
  ```
- Implement a watchdog that periodically checks for processes spawned by this bot's PID tree
- Use systemd or a process manager that kills the entire cgroup on restart (ensures children die with parent)
- On Linux, set `PR_SET_PDEATHSIG` on child processes via the `spawnClaudeCodeProcess` option:
  ```typescript
  options: {
    spawnClaudeCodeProcess: (spawnOpts) => {
      // Custom spawn that sets death signal
    }
  }
  ```
- Store PIDs of all spawned SDK processes in a file; on startup, kill any still-running PIDs from the file

**Warning signs:**
- `ps aux | grep claude` showing processes with PPID=1 (orphans)
- Gradually increasing memory usage even when no sessions are active
- Host machine running out of memory after extended bot operation

**Phase to address:**
Phase 1 (process lifecycle). Orphan cleanup must be implemented from day one, before multi-session support.

---

### Pitfall 6: grammY Event Loop and SDK Async Generator Interference

**What goes wrong:**
grammY runs on the Node.js event loop processing Telegram updates via long polling. The SDK's streaming output is consumed via `for await...of` on an AsyncGenerator. If the streaming loop does not yield control frequently, grammY's update processing stalls -- approval button presses are not received, text input from Telegram is delayed, and the bot appears unresponsive.

**Why it happens:**
Both grammY and the SDK compete for the same Node.js event loop. The `for await` loop over SDK messages is async but may process many messages in a tight loop (especially during tool streaming with `includePartialMessages: true`). If the loop body does synchronous work (formatting, string manipulation) without yielding, grammY's middleware cannot run until the current microtask completes.

**Consequences:**
- User taps "Approve" but the bot does not process the callback query for seconds
- Telegram shows the spinning loader on buttons for 10+ seconds
- Multiple sessions interfere with each other -- one session's streaming output delays another session's approval processing
- Under heavy streaming, the bot may fail to answer callback queries within Telegram's timeout, causing permanent spinners

**Prevention:**
- Process SDK messages asynchronously: do NOT do heavy synchronous work in the `for await` loop body. Enqueue messages to a buffer and process them in a separate async task.
- Use `setImmediate()` or `setTimeout(fn, 0)` periodically in the streaming loop to yield to the event loop
- Consider running each SDK session's message consumer in a separate "micro-task chain" that explicitly yields between messages
- Keep grammY's callback query handler (`bot.callbackQuery(...)`) as lightweight as possible -- just resolve the deferred promise, do not await Telegram API calls
- Monitor event loop lag (e.g., `perf_hooks.monitorEventLoopDelay()`) and log warnings if lag exceeds 100ms

**Warning signs:**
- Callback queries timing out (Telegram shows spinning button)
- Approval responses taking 5+ seconds to register
- One session's activity visibly delaying another session's Telegram messages

**Phase to address:**
Phase 1 (architecture). The SDK message consumption pattern must be designed to coexist with grammY from the start. Retrofitting event loop management is extremely difficult.

---

## Moderate Pitfalls

Mistakes that cause significant rework or degraded UX but are recoverable.

---

### Pitfall 7: Streaming Output Volume Overwhelms Telegram Rate Limits

**What goes wrong:**
With `includePartialMessages: true`, the SDK emits dozens of `stream_event` messages per second (one per text chunk, one per tool input chunk). If you naively forward each chunk to Telegram via `editMessageText`, you hit Telegram's ~5 edits/minute/message limit and the ~20 messages/minute/group limit within seconds. All bot API calls fail with 429 for 30-60 seconds, blocking approval messages for ALL sessions.

**Why it happens:**
The SDK streams at API token speed. Telegram rate limits are designed for human-speed interaction. The mismatch is 100x or more. The v1.0 architecture had a natural throttle because hooks only fired on tool completion (not mid-stream). The SDK gives you everything, and you must filter aggressively.

**Prevention:**
- Do NOT use `includePartialMessages` for Telegram output. Use the default mode where you receive complete `SDKAssistantMessage` objects after each turn.
- If you want progress indicators, track `content_block_start` events (tool starts) and `content_block_stop` events (tool ends) only -- these are low-frequency.
- Reuse the v1.0 MessageBatcher pattern: accumulate messages for 2-3 seconds, then send one combined update.
- Separate approval messages from informational messages -- approval messages bypass the queue and send immediately.
- Consider a dedicated "status message" per session that gets edited at most once every 10 seconds with a summary of current activity.

**Phase to address:**
Phase 2 (Telegram output forwarding). The v1.0 batching infrastructure should be preserved and adapted.

---

### Pitfall 8: Session Resume After Bot Restart Requires Stored Session IDs

**What goes wrong:**
In v1.0, the bot auto-discovered sessions via hook events. With the SDK, the bot CREATES sessions via `query()`. If the bot restarts, it has no SDK session handles -- it must `resume` each active session using the stored `sessionId`. If the session ID was not persisted (only held in memory), the bot cannot reconnect to any active Claude Code sessions. The sessions keep running as orphaned child processes (Pitfall 5) while the bot creates new, disconnected sessions.

**Why it happens:**
SDK sessions are stateful processes. The session ID is returned in the `system` init message and must be captured and stored. The v1.0 hook architecture was stateless -- hooks fired for any active session, and the bot just had to be listening. The SDK requires explicit session ownership.

**Prevention:**
- Capture `session_id` from the first `SDKSystemMessage` (type: "system", subtype: "init") and persist it to the SessionStore immediately
- On bot restart, iterate all active sessions from the store and call `query({ prompt: "continue", options: { resume: sessionId } })` for each
- Consider `persistSession: true` (the default) so the SDK saves session state to disk, enabling resume even after process crashes
- The `listSessions({ dir: cwd })` function can discover sessions that were persisted -- use it as a fallback if the session store is corrupted

**Phase to address:**
Phase 1 (session management). Session persistence must be designed before multi-session support.

---

### Pitfall 9: canUseTool and Hooks Have Different Execution Order

**What goes wrong:**
You implement approval logic in both `canUseTool` callback AND `PreToolUse` hooks, expecting them to work together. In reality, hooks execute BEFORE `canUseTool`. If a `PreToolUse` hook returns `{ decision: "approve" }`, the `canUseTool` callback is never called. If the hook returns `{ continue: true }` (pass-through), then `canUseTool` fires. If you put logging in hooks and approval in `canUseTool`, your logs say "approved" (from the hook) but the user was never asked.

**Why it happens:**
The SDK has two permission layers: hooks (inherited from CLI architecture) and `canUseTool` (SDK-specific callback). The hook system short-circuits if it returns a decision. The `canUseTool` is the fallback. This is documented but easy to misconfigure.

**Prevention:**
- Use `canUseTool` for ALL interactive approval logic (sending to Telegram, waiting for user response)
- Use hooks ONLY for logging, metrics, and non-blocking side effects (PostToolUse, Notification, etc.)
- Do NOT return `{ decision: "approve" }` from PreToolUse hooks unless you intentionally want to bypass user approval
- In Python, `canUseTool` requires a dummy PreToolUse hook that returns `{ continue: true }` to keep the stream open (documented quirk). In TypeScript, this is not required.
- Test by checking: does the `canUseTool` callback fire for every tool call that should require approval?

**Phase to address:**
Phase 2 (approval flow). Decide hook vs canUseTool responsibilities before implementing approval.

---

### Pitfall 10: SDK Settings Isolation Breaks Existing Claude Code Configuration

**What goes wrong:**
By default, the SDK does NOT load filesystem settings (`CLAUDE.md`, `.claude/settings.json`, user settings). This means your existing v1.0 hooks configuration, allowed tools, and project instructions are silently ignored. Claude Code sessions started by the SDK behave differently from sessions started via the CLI in the same project.

**Why it happens:**
This is an intentional breaking change in Agent SDK v0.1.0 (documented in migration guide). The `settingSources` option defaults to `[]` (empty array) instead of loading all sources. This provides isolation for SDK applications but is a trap for developers migrating from hook-based setups.

**Prevention:**
- Explicitly set `settingSources: ['user', 'project', 'local']` if you want Claude Code CLI-equivalent behavior
- Or better: programmatically configure everything via SDK options (cleaner, no filesystem dependency):
  - `systemPrompt: { type: 'preset', preset: 'claude_code' }` for Claude Code system prompt
  - `allowedTools: [...]` instead of settings.json allowed tools
  - `hooks: {...}` instead of filesystem hook definitions
- Do NOT mix filesystem hooks and SDK hooks -- the SDK hooks take precedence when `settingSources` includes 'project'
- Test by comparing: start a session via CLI, start another via SDK, verify they behave identically for the same prompt

**Phase to address:**
Phase 1 (SDK configuration). Must decide the configuration strategy (programmatic vs filesystem) early.

---

### Pitfall 11: Streaming Output Incompatible with Extended Thinking

**What goes wrong:**
You enable `includePartialMessages: true` for real-time output, then also set `maxThinkingTokens` (or use a model that defaults to extended thinking). The SDK silently stops emitting `stream_event` messages. You only receive complete `AssistantMessage` objects after each turn -- effectively losing the streaming benefit. Your Telegram output goes from real-time to delayed, with no error or warning.

**Why it happens:**
This is a documented limitation: "When you explicitly set `max_thinking_tokens`, `StreamEvent` messages are not emitted." The Claude API's extended thinking feature is incompatible with content streaming. The SDK degrades silently to non-streaming mode.

**Prevention:**
- Do not set `maxThinkingTokens` if you need streaming events
- Use the default `thinking: { type: 'adaptive' }` which does NOT trigger this incompatibility
- If you need extended thinking for complex tasks, accept non-streaming output and use a polling-style update pattern for Telegram
- Test: enable `includePartialMessages`, run a query, verify `stream_event` messages appear. Then enable thinking and verify the behavior change.

**Phase to address:**
Phase 2 (output streaming). Document the constraint and ensure configuration does not accidentally enable both.

---

## Minor Pitfalls

Issues that cause confusion or minor bugs but are quickly fixable.

---

### Pitfall 12: SDKRateLimitEvent Type Missing from Exports (Issue #184)

**What goes wrong:**
You try to handle `SDKRateLimitEvent` messages in TypeScript with proper type checking. The type resolves to `any` because it is referenced in the `SDKMessage` union but not exported from the package.

**Prevention:**
- Use string literal checks (`message.type === "rate_limit"`) instead of type guards until the export is fixed
- Track issue #184 for the fix

---

### Pitfall 13: session.close() Must Be Called Explicitly

**What goes wrong:**
You let a `query()` AsyncGenerator go out of scope without calling `.close()` or consuming all messages. The child process keeps running indefinitely because the generator's `return()` method is never called. This is a subtle memory/process leak.

**Prevention:**
- Always use `try/finally` around `for await` loops with `query.close()` in the `finally` block
- Or use the V2 `await using session = ...` pattern (TypeScript 5.2+) for automatic cleanup (but see Pitfall 3 about V2 limitations)
- Or consume the generator to completion (iterate until `ResultMessage`)

---

### Pitfall 14: Zod Version Conflict

**What goes wrong:**
The SDK requires `zod ^3.24.1` for tool schema definitions. If your project uses Zod 4 (released in 2025), the SDK's internal Zod validation may conflict with your project's Zod imports. The `tool()` helper claims to support "Zod 3 and Zod 4" but edge cases in schema coercion differ between versions.

**Prevention:**
- Pin Zod 3.x in your project for now: `npm install zod@3`
- If you need Zod 4 features, keep SDK tools on Zod 3 schemas and use Zod 4 elsewhere
- Test tool schema validation after any Zod version change

---

### Pitfall 15: Fastify HTTP Server Becomes Unnecessary (But Must Be Removed Carefully)

**What goes wrong:**
After migrating to the SDK, the Fastify HTTP hook server is no longer needed (the SDK handles hooks via callbacks, not HTTP POST). Developers leave the Fastify server running "just in case" or because removing it feels risky. The unused server consumes a port, adds dependencies, and confuses the architecture. Worse: if the old hook configuration in `~/.claude/settings.json` still points to the HTTP server, externally-launched Claude Code sessions (not managed by the SDK) will post to it, creating ghost events.

**Prevention:**
- Remove Fastify and its hook routes after the SDK migration is complete, not during
- Remove the hook installation code (`installHooks()`) that writes HTTP hook config to settings.json
- Clean up `~/.claude/settings.json` to remove any HTTP hook entries
- Phase the removal: first add SDK, verify it works, THEN remove Fastify in a separate phase

**Phase to address:**
Final migration phase (cleanup). Only after SDK integration is fully verified.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| SDK session creation | 12s cold start (Pitfall 1) | Show "Starting..." in Telegram, use streaming input for subsequent messages |
| Streaming input mode | Double token cost (Pitfall 2) | Use one-shot + resume pattern until #207 is fixed |
| V1 vs V2 API choice | V2 ignores options (Pitfall 3) | Use V1 API only |
| Tool approval flow | canUseTool blocks agent (Pitfall 4) | Short timeouts, auto-approve safe tools |
| Process management | Orphaned processes (Pitfall 5) | Startup cleanup, systemd cgroup, PID tracking |
| Event loop integration | grammY stalls during streaming (Pitfall 6) | Yield control, async message queue |
| Telegram output | Rate limit overwhelm (Pitfall 7) | Reuse v1.0 batching, avoid partial messages |
| Bot restart | Lost session IDs (Pitfall 8) | Persist session IDs immediately on capture |
| Hook vs canUseTool | Wrong execution order (Pitfall 9) | canUseTool for approvals, hooks for logging |
| Settings loading | Silent config ignore (Pitfall 10) | Explicit settingSources or programmatic config |
| Thinking + streaming | Silent degradation (Pitfall 11) | Do not combine maxThinkingTokens with streaming |
| Migration cleanup | Ghost hook events (Pitfall 15) | Remove Fastify and hook config only after full verification |

## "Looks Done But Isn't" Checklist

- [ ] **Session cold start:** Sessions create successfully, but did you measure the 12-second startup? Users will report the bot as "slow to start."
- [ ] **canUseTool fires:** Approval buttons appear, but does `canUseTool` actually fire for EVERY tool that needs approval? Check that no PreToolUse hook is short-circuiting it.
- [ ] **Session resume works:** Bot restarts and resumes sessions, but are the session IDs persisted to disk? Kill the bot process and verify it resumes.
- [ ] **Orphan cleanup:** Sessions start and stop cleanly, but crash the bot mid-session. Are child processes cleaned up on restart?
- [ ] **Double-turn filtered:** Streaming mode works, but are you seeing duplicate AI responses? Check token costs against expected single-turn costs.
- [ ] **Event loop yields:** One session streams output correctly, but start two sessions simultaneously. Does the approval button in session A still respond instantly while session B streams?
- [ ] **Telegram batching:** Tool calls post to Telegram, but trigger 30 rapid tool calls in one session. Does the bot hit 429 rate limits?
- [ ] **Settings loaded:** Claude behaves correctly in SDK sessions, but compare with CLI sessions. Are project CLAUDE.md instructions applied in both?
- [ ] **Graceful shutdown:** Bot stops cleanly with SIGTERM, but all child SDK processes also terminate? Check `ps aux | grep claude` after shutdown.
- [ ] **Memory stable:** Bot runs for 4+ hours with active sessions. Is RSS stable or growing?

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Orphaned processes (5) | LOW | Kill orphans on restart. Add PID tracking. No data loss. |
| Double token cost (2) | MEDIUM | Switch to one-shot+resume pattern. Refund not possible for wasted tokens. |
| V2 options ignored (3) | LOW | Switch to V1 API. Minimal code change if caught early. |
| canUseTool not firing (9) | MEDIUM | Restructure hook/canUseTool boundary. May need to rewrite approval flow. |
| Lost session IDs (8) | HIGH | Sessions cannot be resumed. Must restart all active Claude Code work. Prevent by persisting immediately. |
| Event loop blocking (6) | HIGH | Requires architectural refactor of message consumption pattern. Must be right from the start. |
| Settings not loaded (10) | LOW | Add settingSources option. One-line fix once diagnosed. |
| Fastify ghost events (15) | LOW | Remove old hook config. One-time cleanup. |

## Sources

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- HIGH confidence. Official V1 API documentation.
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- HIGH confidence. Architecture and capabilities.
- [Streaming Input Documentation](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- HIGH confidence. Streaming vs single mode, AsyncIterable usage.
- [Streaming Output Documentation](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- HIGH confidence. includePartialMessages, event types, thinking incompatibility.
- [Handle Approvals and User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- HIGH confidence. canUseTool callback, PermissionResult types, AskUserQuestion.
- [Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions) -- HIGH confidence. Session IDs, resume, fork, persistence.
- [Hosting the Agent SDK](https://platform.claude.com/docs/en/agent-sdk/hosting) -- HIGH confidence. Resource requirements, deployment patterns, process management.
- [Migration Guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide) -- HIGH confidence. Breaking changes from claude-code-sdk to claude-agent-sdk.
- [V2 Preview Documentation](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) -- HIGH confidence. Unstable API warnings, feature gaps.
- [GitHub Issue #207: AsyncIterable double turn](https://github.com/anthropics/claude-agent-sdk-typescript/issues/207) -- HIGH confidence. Detailed analysis, reproducible, workarounds documented.
- [GitHub Issue #176: V2 ignores options](https://github.com/anthropics/claude-agent-sdk-typescript/issues/176) -- HIGH confidence. Root cause identified, workaround provided.
- [GitHub Issue #142: Orphaned processes](https://github.com/anthropics/claude-agent-sdk-typescript/issues/142) -- HIGH confidence. Production impact documented, multiple workarounds.
- [GitHub Issue #34: 12-second overhead](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) -- HIGH confidence. Benchmarks provided, Anthropic acknowledged.
- [GitHub Issue #173: SIGTERM during cleanup](https://github.com/anthropics/claude-agent-sdk-typescript/issues/173) -- MEDIUM confidence. Python-specific but SIGTERM handling applies to TypeScript too.
- [SDK Changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) -- HIGH confidence. Version history, bug fixes, breaking changes. Latest: v0.2.63.
- [Claudegram (Grammy + SDK integration)](https://github.com/NachoSEO/claudegram) -- MEDIUM confidence. Real-world integration patterns, request queuing, session isolation.
- [GitHub Issue #333 (Python): Multi-instance performance](https://github.com/anthropics/claude-agent-sdk-python/issues/333) -- MEDIUM confidence. Python-specific but documents the 20-30s startup issue.

---
*Pitfalls research for: Claude Agent SDK Migration (v2.0)*
*Researched: 2026-03-01*
