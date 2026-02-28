# Project Research Summary

**Project:** Claude Code Telegram Bridge
**Domain:** Per-machine Telegram bot daemon bridging Claude Code CLI sessions (hooks, monitoring, bidirectional control)
**Researched:** 2026-02-28
**Confidence:** HIGH

## Executive Summary

This project is a lightweight, hook-native per-machine daemon that bridges Claude Code sessions to Telegram forum topics. Experts build tools in this category using official event hooks as the primary data channel — not terminal emulation, polling, or SDK wrapping. Three competing implementations exist (ccbot, RichardAtCT/claude-o-gram, Claude-Code-Remote), and all share a common flaw: they either require tmux, wrap the Claude SDK directly, or use terminal emulation (PTY). Our differentiating position is hook-native architecture on Node.js with zero additional infrastructure: Claude Code's `type: "http"` hooks POST directly to a local Fastify server, which is the same process as the Telegram bot. This eliminates an entire IPC layer that all competitors have to build and maintain.

The recommended approach is a single Node.js 25 process running grammY (long-polling) and Fastify (local HTTP) simultaneously. Claude Code hooks post to `localhost:4100`, the daemon routes events to Telegram forum topics (one topic per session), and approval requests use a Promise-based bridge that holds the HTTP response open until the user taps Approve/Deny in Telegram. The stack is already installed on this machine (Node v25.0.0 with native TypeScript support), the Telegram Bot API has stable forum topic support since Bot API 6.1, and all hook events needed are documented and verified. This is a well-understood integration with known-good patterns from the claude-code-hooks-multi-agent-observability project.

The primary risks are: (1) hook timeout behavior — a timed-out PreToolUse hook auto-approves the tool call unless the hook explicitly exits with code 2, so the internal timeout must always deny rather than rely on Claude Code's process kill; (2) Telegram rate limits — 20 messages per minute per group means message batching is mandatory once Claude executes more than a handful of tools; (3) bidirectional text input from Telegram to Claude has no clean mechanism in the hook system and must be deferred to a post-MVP phase. Everything else is straightforward and well-documented.

## Key Findings

### Recommended Stack

The stack decision is settled and high-confidence. Node.js 25 runs TypeScript natively (erasable syntax only — no enums), making the development experience clean without a build step during iteration. grammY is the clear choice for Telegram (typed, modern, active plugin ecosystem), Fastify for the local HTTP server (built-in schema validation, fast), and better-sqlite3 is optional but useful for session persistence across restarts. The most important architectural decision is using `type: "http"` hooks rather than `type: "command"` hooks — this eliminates shell scripts, IPC bridges, and socket management entirely.

**Core technologies:**
- **Node.js 25.x** — runtime, native TypeScript support, event loop handles concurrent polling + HTTP + file watching
- **TypeScript 5.9.x** — type safety; use `const` objects/string unions instead of enums (erasable syntax constraint)
- **grammY 1.40.x** — Telegram Bot API client; TypeScript-first, active, best plugin ecosystem; use with `@grammyjs/auto-retry` + `@grammyjs/transformer-throttler` for rate limit handling
- **Fastify 5.7.x** — local HTTP server for Claude Code HTTP hooks; schema validation built-in; eliminates all custom IPC code
- **better-sqlite3 12.6.x** — optional but recommended for session-map persistence across restarts; synchronous API is simpler
- **chokidar 5.0.x** — JSONL transcript file watcher for Claude's text output (not captured by hooks); ESM-only, requires Node >= 20
- **zod 4.3.x** — runtime validation of hook JSON payloads and config files

**Critical version notes:** chokidar 5.x is ESM-only (requires `"type": "module"` in package.json). TypeScript enums are unsupported with Node 25 native execution. Use `node --env-file=.env` instead of dotenv.

### Expected Features

Three tiers of features emerge from competitive analysis and hook system capabilities.

**Must have (table stakes):**
- **Session-to-topic mapping** — `SessionStart` hook creates a Telegram forum topic; `SessionEnd` closes it. Foundation for everything else.
- **Tool call notifications** — `PostToolUse` hook posts tool name, file path, and truncated output to the session topic.
- **Permission request forwarding with inline Approve/Deny** — `PreToolUse` blocking hook posts tool details with inline keyboard; holds HTTP response open until user responds in Telegram.
- **Notification forwarding** — `Notification` hook (idle_prompt, permission_prompt) forwarded to session topic.
- **Timeout handling for blocked hooks** — internal timeout exits with code 2 (deny) before Claude Code's process-kill timeout fires.
- **HTML message formatting** — use `parse_mode: "HTML"` (not MarkdownV2), `<pre>` for code blocks, `<code>` for paths.

**Should have (competitive):**
- **Text output capture** — chokidar watches JSONL transcript file; parses new assistant message lines since last offset.
- **Custom text input from Telegram** — the hardest feature; requires deeper research on injection mechanism.
- **Smart message batching** — debounce PostToolUse events 2-3 seconds, batch into single messages; mandatory for rate limit compliance.
- **Configurable verbosity** — filter which events reach Telegram (suppress Read/Glob/Grep by default).
- **File sharing for large outputs** — outputs > 4096 chars sent as `.txt` document attachments.
- **Periodic summary updates** — aggregate tool activity into status messages every N tool calls or N seconds.

**Defer (v2+):**
- SubagentStart/Stop tracking (agent teams are still new in Claude Code)
- Session resume/reconnect after bot restart
- Multi-machine dashboard topic
- Message threading within topics

### Architecture Approach

The architecture is a single long-lived Node.js process with two entry points: a Fastify HTTP server (receives Claude Code hook POSTs) and a grammY bot (long-polls Telegram for messages and callback queries). These share in-process state — a session map (sessionId → topicId), an approval queue (Map of Promises keyed by requestId), and optionally a SQLite database for persistence. The key insight is that the HTTP response to a PreToolUse hook is held open using a Promise whose `resolve` function is stored in the approval queue; when the user taps Approve/Deny in Telegram, the callback_query handler resolves the Promise, and the HTTP handler returns the decision JSON to Claude Code. This Promise-bridging pattern is the architectural core of the blocking approval flow.

**Major components:**
1. **HTTP Server (Fastify)** — receives Claude Code hook POSTs at `/hooks/{event}`, routes to event handlers
2. **Session Manager** — in-memory `Map<sessionId, Session>` with reverse lookup `Map<topicId, sessionId>` for routing Telegram replies
3. **Telegram Client (grammY)** — creates/closes forum topics, sends messages to topics, handles callback queries and text messages
4. **Approval Queue** — `Map<requestId, PendingApproval>` with stored Promise resolvers; bridges synchronous HTTP with async Telegram callbacks
5. **Log Watcher (chokidar)** — tails JSONL transcript file per session, extracts assistant text messages not captured by hooks
6. **Message Formatter** — converts hook JSON to HTML-formatted Telegram messages; handles 4096-char limits via splitting or file upload

### Critical Pitfalls

1. **Hook timeout auto-approves instead of denying** — Claude Code's process-kill timeout exits with signal codes (137/143) which are treated as non-blocking errors, so execution proceeds. Fix: implement an internal timeout in the hook/daemon that always exits with code 2 to deny, fired before Claude Code's timeout.

2. **Telegram rate limits drop messages and block approvals** — 20 msg/min per group; rapid tool calls (10+ per minute is routine) will hit this. When rate-limited, ALL bot API calls fail, including approval buttons from other sessions. Fix: message batching with debounce from day one; circuit breaker pauses all output during `retry_after` window.

3. **MarkdownV2 parse failures silently drop messages** — arbitrary code output contains all 18+ MarkdownV2 special characters. Fix: use HTML parse mode exclusively; `<pre>` blocks do not require content escaping; add plain-text fallback if HTML parsing fails.

4. **Session isolation failure with concurrent sessions** — multiple Claude Code sessions share the same hook endpoints; without session_id-keyed routing, approval responses can be routed to the wrong session. Fix: extract `session_id` from every hook POST and use it as the routing key for all state.

5. **4096-character message limit breaks code blocks** — naive splitting breaks HTML tags, producing malformed messages or parse errors. Fix: formatting-aware splitter that closes tags before split points; fall back to file attachment for output > 12000 chars.

## Implications for Roadmap

Based on combined research, the architecture's dependency chain and pitfall-to-phase mapping from PITFALLS.md directly suggest a 6-phase build order.

### Phase 1: Foundation (HTTP Server + Bot Skeleton + Session Routing)

**Rationale:** Every other feature depends on the core plumbing: a running HTTP server, a Telegram bot that can send messages, and session_id-to-topic routing. The two critical pitfalls (hook timeout behavior and session isolation) must be designed correctly here — both are expensive to retrofit. This is the phase where the Promise-bridging pattern for approval flow is established.

**Delivers:** HTTP server receiving hook POSTs; Telegram bot initialized with long-polling; in-memory session map; basic PostToolUse events posted to a manually created topic; Claude Code hook configuration (`~/.claude/settings.json`) wired to localhost:4100.

**Addresses:** Session-to-topic mapping (table stakes), multi-session support (table stakes)

**Avoids:** Session isolation failure (Pitfall 5 — design session_id routing from day one), hook timeout auto-approve (Pitfall 1 — establish exit-code-2 contract immediately)

**Research flag:** Standard patterns. HTTP hooks are documented, grammY initialization is documented. Skip research-phase.

### Phase 2: Session Lifecycle + Message Formatting

**Rationale:** Once the plumbing exists, formalize session creation and teardown (createForumTopic / closeForumTopic) and establish the message formatting layer. Message formatting (HTML mode, splitting, file fallback) must come before any real output forwarding because MarkdownV2 failures silently drop messages. Rate limit handling also belongs here since it affects every outbound message.

**Delivers:** Auto-created forum topics on SessionStart; auto-closed topics on SessionEnd; HTML message formatter with 4096-char splitter and file-upload fallback; message batching/debouncing; grammY rate limit plugins configured.

**Addresses:** Topic lifecycle management, notification forwarding, basic message formatting, smart message batching

**Avoids:** MarkdownV2 parse failures (Pitfall 4), Telegram rate limits (Pitfall 3), 4096-char truncation (Pitfall 6), General topic thread_id bug

**Research flag:** Standard patterns. Forum topic API is stable (Bot API 6.1+, currently 9.4). Skip research-phase.

### Phase 3: Approval Flow (PreToolUse Blocking)

**Rationale:** The Promise-bridging approval queue is architecturally the most complex component. It needs the session map (Phase 1) and message formatting (Phase 2) before it can work. Building it as its own phase keeps the scope focused. Timeout handling (exit code 2 deny, button expiry editing) is critical correctness, not polish.

**Delivers:** PreToolUse hooks posting approval requests with inline Approve/Deny keyboard; Promise-based approval queue holding HTTP response open; timeout handling that denies via exit code 2 and edits buttons to "Expired"; callback_data validation (session_id + nonce).

**Addresses:** Permission request forwarding (P1 table stakes), timeout handling (P1 table stakes), inline keyboard system

**Avoids:** Hook timeout auto-approve (Pitfall 1), stale callback buttons after timeout (UX pitfall), callback_data forgery (security pitfall)

**Research flag:** May benefit from research-phase. The exact `hookSpecificOutput.permissionDecision` JSON schema and how Claude Code handles HTTP response latency vs. its own hook timeout need empirical verification.

### Phase 4: Text Output (Log Watcher)

**Rationale:** Claude's reasoning text is not captured by any hook — it only appears in the JSONL transcript file. This requires the chokidar watcher and JSONL parser. It depends on Phase 2 (session map provides `transcript_path`) and Phase 2 (message formatter handles the output). The JSONL format is community-documented (MEDIUM confidence), not formally stable, so this phase needs care with error handling.

**Delivers:** chokidar watching transcript file per session from `transcript_path`; incremental JSONL parsing from byte offset (not full file re-read); deduplication of events already forwarded via hooks; assistant text messages posted to session topic.

**Addresses:** Text output capture (P2 feature), periodic summary updates (P2 feature)

**Avoids:** Re-reading entire JSONL on each poll (performance trap), partial line reads from concurrent writes (integration gotcha), sync file I/O blocking event loop (performance trap)

**Research flag:** Needs research-phase. JSONL format is MEDIUM confidence (community-documented, not stable API). Verify exact schema fields and whether `transcript_path` in hook input reliably points to the correct file.

### Phase 5: Bidirectional Text Input

**Rationale:** Sending arbitrary text from Telegram to Claude is the hardest unsolved problem. Architecture research rates this LOW confidence because the hook system is designed as an event listener, not a bidirectional channel. The Stop hook's `decision: "block"` approach provides limited feedback injection when Claude pauses but does not support mid-session text injection. This phase needs dedicated research before implementation.

**Delivers:** Telegram text messages in a session topic routed to Claude Code; at minimum, Stop-hook-based feedback injection when Claude pauses; ideally a cleaner injection mechanism if one is discovered.

**Addresses:** Custom text input from Telegram (P2 feature, highest complexity)

**Research flag:** Requires research-phase. This is the only feature with LOW confidence architecture. Investigate: `UserPromptSubmit` hook's `additionalContext` mechanism, any input file/pipe mechanism added in recent Claude Code releases, whether the Stop hook `decision: "block"` approach is reliable for feedback injection.

### Phase 6: Polish + Robustness

**Rationale:** After core functionality is proven, add configurable verbosity, session resume/reconnect after bot restart, subagent tracking, and operational hardening (process manager setup, secret scrubbing, health check endpoint). This is the "looks done but isn't" phase where the checklist from PITFALLS.md is worked through systematically.

**Delivers:** Configurable verbosity (filter event types); session map persistence to JSON/SQLite for restart recovery; SubagentStart/Stop tracking; secret scrubbing before Telegram forwarding; bot admin validation at startup (can_manage_topics check); operational setup (systemd/pm2 configuration).

**Addresses:** Configurable verbosity (P2), session resume (P3), subagent tracking (P3)

**Avoids:** Bot restart loses session map, orphaned topics after crash, token leakage in logs, bot lacking topic permissions (silent failure)

**Research flag:** Standard patterns. Skip research-phase.

### Phase Ordering Rationale

- **Phases 1 and 2 first** because session routing and message formatting are load-bearing for every subsequent feature. Skipping them creates expensive retrofits.
- **Phase 3 before Phase 4** because approval flow (PreToolUse blocking) is the highest-value, highest-risk feature. It must be stable before adding more complexity.
- **Phase 4 before Phase 5** because the log watcher uses session state from Phase 1-2, and its patterns (offset tracking, deduplication) inform how text input routing should work.
- **Phase 5 isolated** because the architecture gap in bidirectional text input means this phase may require a research spike before any code is written. Isolating it prevents it from blocking Phases 1-4.
- **Phase 6 last** because operational hardening and polish should not precede feature completeness.

### Research Flags

Phases requiring `/gsd:research-phase` during planning:
- **Phase 3:** Verify exact `permissionDecision` JSON schema, HTTP hook timeout interaction with slow responses, exit code 2 behavior edge cases
- **Phase 4:** Verify JSONL transcript format field names and stability; confirm `transcript_path` in hook input is reliable
- **Phase 5:** Critical — architecture for Telegram-to-Claude text injection is LOW confidence; research before planning this phase

Phases with standard patterns (skip research-phase):
- **Phase 1:** HTTP hooks, grammY initialization, session maps are well-documented
- **Phase 2:** Forum topic API (Bot API 6.1+ stable), HTML parse mode, rate limit plugins documented
- **Phase 6:** Session persistence, process management, secret scrubbing are standard patterns

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All libraries verified against official docs; Node 25 native TypeScript tested on-machine; grammY v1.40.1 confirmed via npm. Only gap: `node:sqlite` built-in not yet stable enough to replace better-sqlite3. |
| Features | HIGH | Competitive analysis from 3 existing projects; table stakes confirmed by competitor implementations; differentiators validated against Claude Code hook event schema. Rate limit numbers verified from official Telegram FAQ. |
| Architecture | HIGH (with one LOW exception) | HTTP hook pattern verified in official Claude Code docs and by claude-code-hooks-multi-agent-observability project. Promise-bridging approval queue is a standard Node.js async pattern. EXCEPTION: bidirectional text input (Telegram → Claude) is LOW confidence — the hook system has no clean mechanism for this. |
| Pitfalls | HIGH | Critical pitfalls (hook timeout, rate limits, message formatting, session isolation) verified against official docs. IPC gotchas verified from Node.js docs and Telegram API docs. Empirical limits (editMessage rate) verified from community projects. |

**Overall confidence:** HIGH

### Gaps to Address

- **Bidirectional text input mechanism** — the architecture research section explicitly rates this LOW confidence. Before Phase 5 planning, a focused research spike should examine: `UserPromptSubmit` hook `additionalContext` field behavior, whether recent Claude Code versions added any input injection mechanism, and whether the Stop hook `decision: "block"` with reason text is a viable workaround for the MVP.

- **JSONL transcript format stability** — community-documented, not a stable API. The exact field names (`parentUuid`, `uuid`, `message.content[]`) are used by multiple tools but could change with Claude Code updates. Add defensive parsing with explicit error handling for unknown formats.

- **HTTP hook timeout behavior under slow responses** — the docs confirm the timeout field is configurable, but the interaction between Claude Code's timeout and a slow HTTP server response (waiting 4+ minutes for Telegram approval) needs empirical testing. Specifically: does Claude Code use a connection timeout (fails immediately if HTTP handshake is slow) or a response timeout (waits for full response)?

- **Bot admin permission requirement** — the bot requires `can_manage_topics` admin permission in the Telegram supergroup. This is an installation prerequisite that must be validated at startup with a clear error message (not a silent failure on first SessionStart).

## Sources

### Primary (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — hook events, HTTP hook type, JSON schemas, PreToolUse decision control, exit code semantics
- [Telegram Bot API](https://core.telegram.org/bots/api) — Bot API 9.4, forum topic methods (createForumTopic, closeForumTopic, etc.)
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq) — rate limits: 30 msg/s global, 20 msg/min per group, 1 msg/s per chat
- [grammY official docs](https://grammy.dev/) — framework overview, plugin list, flood control
- [npm registry](https://www.npmjs.com/package/grammy) — grammY v1.40.1 current version confirmed
- [Node.js TypeScript docs](https://nodejs.org/en/learn/typescript/run-natively) — native type stripping, erasable-only syntax constraint

### Secondary (MEDIUM confidence)
- [ccbot (six-ddc)](https://github.com/six-ddc/ccbot) — closest competitor; validates 1-topic-per-session pattern and JSONL polling approach
- [claude-o-gram (RichardAtCT)](https://github.com/RichardAtCT/claude-o-gram) — SDK-wrapper approach; validates approval flow UX patterns
- [Claude-Code-Remote (JessyTsui)](https://github.com/JessyTsui/Claude-Code-Remote) — multi-platform; validates hook-based architecture
- [claude-code-hooks-multi-agent-observability (disler)](https://github.com/disler/claude-code-hooks-multi-agent-observability) — validates HTTP POST to localhost hook pattern
- [grammY Flood Control docs](https://grammy.dev/advanced/flood) — empirical editMessage rate limit (~5 edits/min/message)
- [Claude Code JSONL format community analysis](https://kentgigger.com/posts/claude-code-conversation-history) — transcript file path, JSONL structure

### Tertiary (LOW confidence)
- [Claude Code Session Isolation Blog Post](https://jonroosevelt.com/blog/claude-code-session-isolation-hooks) — concurrent session bugs; validates session_id scoping requirement
- Community JSONL schema inference from multiple tools (claude-code-log, claude-JSONL-browser) — field names not formally documented by Anthropic

---
*Research completed: 2026-02-28*
*Ready for roadmap: yes*
