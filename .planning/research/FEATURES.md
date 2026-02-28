# Feature Research

**Domain:** Remote developer tool monitoring / Claude Code Telegram bridge
**Researched:** 2026-02-28
**Confidence:** HIGH

## Competitive Landscape

Three existing projects occupy this space, each with different design philosophies:

| Project | Approach | Strengths | Weaknesses |
|---------|----------|-----------|------------|
| [ccbot](https://github.com/six-ddc/ccbot) | tmux + JSONL polling + hooks | Terminal as source of truth; 1 topic = 1 session; persistent state | Requires tmux; polls every 2s (latency); Go binary |
| [claude-o-gram](https://github.com/RichardAtCT/claude-o-gram) | Claude SDK wrapper | Full agentic mode; rich UI; webhook API | Not a monitor -- it IS the Claude interface; Python/FastAPI; heavy |
| [Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | Hooks + PTY/tmux injection | Multi-platform (Email, Telegram, LINE, Discord); PTY mode | Multi-platform dilutes Telegram UX; token-based command syntax |

**Our differentiating position:** Hook-native, lightweight, per-machine bot with zero dependencies beyond Node.js. No tmux requirement, no SDK wrapping, no terminal emulation. Pure Claude Code hooks as the data channel.

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Session-to-topic mapping** | Core mental model: 1 session = 1 Telegram topic. ccbot already does this. | MEDIUM | Use `SessionStart` hook to create topic via `createForumTopic`, `SessionEnd` to close it. Store mapping in local JSON. |
| **Tool call notifications** | The entire point of monitoring. Users need to see what Claude is doing without being at the terminal. | MEDIUM | `PostToolUse` hook fires after every tool. Post tool name, file path, command, and truncated output to the session topic. |
| **Permission request forwarding** | PreToolUse blocking is the primary input channel per PROJECT.md. Without this, the bot is read-only. | HIGH | `PreToolUse` hook blocks, posts to Telegram with inline keyboard (Approve/Deny), waits for callback, returns JSON decision. Critical path -- must handle timeouts. |
| **Text output capture** | Users want to read Claude's reasoning and responses, not just tool calls. | MEDIUM | Parse JSONL transcript files at `transcript_path` (provided in every hook input). Track byte offset per session to avoid duplicates. ccbot does this with 2s polling. |
| **Inline keyboard for approvals** | Telegram's standard interaction pattern. Text-based approve/deny is unacceptable UX. | LOW | `InlineKeyboardMarkup` with callback buttons. Telegram handles state; bot answers via `answerCallbackQuery`. Max 64 bytes per `callback_data`. |
| **Message formatting** | Raw text dumps are unreadable. Code blocks, bold tool names, structured output are expected. | LOW | Use Telegram's HTML mode (`parse_mode: "HTML"`). Safer than MarkdownV2 which requires aggressive escaping. Wrap commands in `<pre>`, paths in `<code>`. |
| **Session auto-discovery** | Users should not manually register sessions. The bot must detect new sessions automatically. | MEDIUM | `SessionStart` hook (matcher: `startup`) auto-fires on every new session. Hook posts session info to bot, bot creates topic. No polling needed -- hooks ARE the discovery mechanism. |
| **Topic lifecycle management** | Topics should open when sessions start and close when they end. Stale open topics create clutter. | LOW | `SessionEnd` hook calls `closeForumTopic`. Optionally archive after configurable delay. Topic ID stored in session map. |
| **Notification forwarding** | Claude's "needs attention" alerts must reach the user on their phone -- that's the whole value prop. | LOW | `Notification` hook fires with type (`permission_prompt`, `idle_prompt`). Forward directly to Telegram topic. |
| **Multi-session support** | Users run multiple Claude Code sessions concurrently. Each needs its own topic. | MEDIUM | Session ID from hook input (`session_id`) keys the session map. Each session gets a unique topic. Forum topics in Telegram supergroups support this natively. |

### Differentiators (Competitive Advantage)

Features that set the product apart from ccbot, Claude-Code-Remote, and RichardAtCT's bot.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Custom text input from Telegram** | Bidirectional: not just approve/deny but full text responses to Claude. ccbot does this via tmux send-keys; we do it via `UserPromptSubmit` hook or direct JSONL injection. | HIGH | PROJECT.md lists this as a requirement. Hardest feature: need to intercept Claude's "waiting for input" state and inject text. May require writing to a named pipe or using the hook's `additionalContext` return value on `UserPromptSubmit`. Needs deeper research in implementation phase. |
| **Periodic summary updates** | "Working on task X, 3 files edited" -- high-level status without reading every tool call. No competitor does this well. | MEDIUM | Aggregate `PostToolUse` events over a time window. Count files edited, commands run, errors encountered. Post summary every N minutes or N tool calls. |
| **Zero-dependency architecture** | No tmux, no Python, no FastAPI, no SDK wrapper. Just Node.js + Claude Code hooks. Installs in 2 minutes. | LOW | This is an architectural decision, not a feature to build. But it IS a differentiator vs. every competitor. |
| **Per-machine bot identity** | Each machine appears as a distinct bot in the group. Natural "who's doing what" visibility across machines. | LOW | Separate BotFather token per machine. Each bot has a custom name (e.g., "DevBox-1", "Laptop"). Trivial to implement but powerful for multi-machine workflows. |
| **Smart message batching** | Telegram rate limit is 20 msg/min per group. Claude can fire 10+ tool calls in seconds. Batching prevents rate limit errors AND reduces notification spam. | MEDIUM | Queue messages, batch into single updates, respect 20 msg/min group limit. Edit existing messages to append content rather than sending new ones. Use `editMessageText` to update a running "activity log" message. |
| **SubagentStart/Stop tracking** | Claude Code now supports subagents (multi-agent). No competitor tracks subagent lifecycle. Show when subagents spawn and finish in the topic. | LOW | `SubagentStart` and `SubagentStop` hooks. Post to topic: "Subagent spawned: [type]" / "Subagent finished: [type]". Future-proofs the bot for agent teams. |
| **Hook-native (no polling)** | ccbot polls JSONL every 2 seconds. We get real-time events pushed by Claude Code's hook system. Zero latency, zero wasted CPU. | LOW | Architectural advantage. All data flows through hooks -- no file watchers, no polling loops, no transcript parsing for event detection. |
| **Configurable verbosity** | Not everyone wants every Read/Glob logged. Let users choose: errors-only, tool-calls-only, everything. | LOW | Filter which `PostToolUse` matchers are active. Could be per-session or global. Store in config. |
| **File sharing for diffs/outputs** | Send large command outputs or file diffs as Telegram documents instead of truncated messages. | MEDIUM | When `PostToolUse` output exceeds Telegram's 4096 char limit, send as a `.txt` document via `sendDocument`. Particularly useful for test output and build logs. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems. Explicitly NOT building these.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Starting Claude Code sessions from Telegram** | "Full remote control" sounds appealing | Massively increases scope and security risk. Must manage working directories, environment, authentication. RichardAtCT's bot does this and is 10x more complex as a result. PROJECT.md explicitly marks this out of scope. | Monitor and control existing sessions only. Start sessions at the terminal or via SSH. |
| **Real-time streaming of Claude's output** | "See what Claude is typing as it happens" | Telegram rate limits (20 msg/min per group, 30 msg/s global) make true streaming impossible. Would require constant `editMessageText` calls that hit rate limits instantly. ccbot's 2s polling is actually a reasonable compromise. | Batch text output into periodic updates (every 5-10 seconds). Post complete assistant turns, not token-by-token streaming. |
| **Central server / shared state** | "What if I want one dashboard for all machines?" | Adds server infrastructure, deployment complexity, networking concerns. Defeats the "each machine is self-contained" architecture. PROJECT.md explicitly excludes this. | The Telegram group IS the shared view. Each machine's bot posts to the same group. No central server needed. |
| **Multi-user access control** | "My team should have different permissions" | Adds authentication, authorization, role management. PROJECT.md says single-user system. | Bot owner controls everything. Use Telegram group admin settings to control who can see the group. |
| **Web dashboard** | "A nice UI to see all sessions" | Requires serving a web app, WebSocket connections, auth. The Telegram client IS the dashboard. | Telegram's forum topic view already provides a per-session organized view. Add inline keyboards for interaction. |
| **Database for persistence** | "SQLite for session history, message logs" | Adds complexity. Session data is ephemeral -- topics in Telegram persist the history. Local JSON files suffice for session maps. | Use JSON files for session mapping (`session_map.json`). Telegram itself stores message history. |
| **Wrapping Claude Code in a PTY/pipe** | "Capture all terminal output" | Fragile, breaks on Claude Code updates, conflicts with hook system. Claude-Code-Remote does this and it's messy. | Use hooks for events and JSONL transcript parsing for text. These are official, stable APIs. |
| **Plugin/extension system** | "Let users add custom hooks" | Premature abstraction. Build the core well first. | Expose configuration for verbosity and notification preferences. Extensibility can come later if needed. |

## Feature Dependencies

```
[SessionStart hook integration]
    |-- creates --> [Session-to-topic mapping]
    |                   |-- enables --> [Tool call notifications (PostToolUse)]
    |                   |-- enables --> [Permission request forwarding (PreToolUse)]
    |                   |-- enables --> [Text output capture (transcript parsing)]
    |                   |-- enables --> [Notification forwarding]
    |                   |-- enables --> [Custom text input from Telegram]
    |                   |-- enables --> [Periodic summary updates]
    |
    |-- closes --> [Topic lifecycle (SessionEnd)]

[Inline keyboard system]
    |-- required by --> [Permission request forwarding]
    |-- enhances --> [Custom text input from Telegram]

[Message formatting (HTML)]
    |-- required by --> [Tool call notifications]
    |-- required by --> [Text output capture]
    |-- required by --> [Notification forwarding]

[Smart message batching]
    |-- required by --> [Tool call notifications] (at scale)
    |-- required by --> [Text output capture] (at scale)

[File sharing for large outputs]
    |-- enhances --> [Tool call notifications]
```

### Dependency Notes

- **Session-to-topic mapping is the foundation.** Every other feature depends on knowing which Telegram topic corresponds to which Claude Code session. Build this first.
- **Inline keyboards are required before permission forwarding.** The approval UX needs callback buttons. Inline keyboards are simple to implement but must exist before PreToolUse blocking makes sense.
- **Message formatting is trivial but pervasive.** Every feature that posts to Telegram needs HTML formatting. Establish the formatting utilities early.
- **Smart message batching is not needed for MVP** but becomes critical once PostToolUse events fire rapidly. Can be added as an enhancement without changing the core architecture.
- **Custom text input is the hardest feature** and depends on understanding Claude Code's input mechanisms. May need to use `UserPromptSubmit` hook's `additionalContext` or find another injection point. Defer detailed design to implementation phase.

## MVP Definition

### Launch With (v1)

Minimum viable product -- what's needed to validate the concept.

- [ ] **Session-to-topic mapping** -- SessionStart hook creates a topic, SessionEnd closes it. This is the skeleton everything hangs on.
- [ ] **Tool call notifications** -- PostToolUse hook posts tool name + summary to the session topic. Proves the monitoring value.
- [ ] **Notification forwarding** -- Notification hook forwards "needs attention" alerts. Proves the remote awareness value.
- [ ] **Permission request forwarding with inline Approve/Deny** -- PreToolUse hook blocks, posts question, waits for callback. Proves the remote control value.
- [ ] **Basic message formatting** -- HTML mode, code blocks for commands, bold for tool names. Makes output readable.
- [ ] **Timeout handling for blocked hooks** -- Auto-approve or auto-deny after configurable timeout. Prevents Claude from hanging forever.

### Add After Validation (v1.x)

Features to add once core is working and the hook integration is proven stable.

- [ ] **Text output capture** -- Parse JSONL transcripts for assistant messages. Adds the "read Claude's thinking" dimension.
- [ ] **Custom text input from Telegram** -- Reply to Claude with free-form text. Completes bidirectional communication.
- [ ] **Smart message batching** -- Queue and batch messages to stay under Telegram rate limits during rapid tool execution.
- [ ] **Periodic summary updates** -- Aggregate tool activity into periodic status messages.
- [ ] **File sharing for large outputs** -- Send outputs exceeding 4096 chars as documents.
- [ ] **Configurable verbosity** -- Let users filter which events get posted to Telegram.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **SubagentStart/Stop tracking** -- Monitor multi-agent workflows. Defer because agent teams are still new in Claude Code.
- [ ] **Message threading within topics** -- Reply to specific tool calls with threaded messages. Telegram topics don't support nested threads, so this would need creative workarounds.
- [ ] **Session resume/reconnect** -- Handle bot restarts gracefully by re-reading session_map.json and reconnecting to active sessions.
- [ ] **Multi-machine dashboard topic** -- A pinned "status" topic showing all active sessions across all machines.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Session-to-topic mapping | HIGH | MEDIUM | P1 |
| Tool call notifications | HIGH | MEDIUM | P1 |
| Permission request forwarding (Approve/Deny) | HIGH | HIGH | P1 |
| Notification forwarding | HIGH | LOW | P1 |
| Basic message formatting (HTML) | MEDIUM | LOW | P1 |
| Timeout handling for blocked hooks | HIGH | MEDIUM | P1 |
| Text output capture | HIGH | MEDIUM | P2 |
| Custom text input | HIGH | HIGH | P2 |
| Smart message batching | MEDIUM | MEDIUM | P2 |
| Periodic summary updates | MEDIUM | MEDIUM | P2 |
| File sharing for large outputs | LOW | LOW | P2 |
| Configurable verbosity | LOW | LOW | P2 |
| SubagentStart/Stop tracking | LOW | LOW | P3 |
| Session resume/reconnect | MEDIUM | MEDIUM | P3 |
| Multi-machine dashboard topic | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch -- validates the core concept
- P2: Should have, add when core is stable
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | ccbot | RichardAtCT/claude-o-gram | Claude-Code-Remote | Our Approach |
|---------|-------|----------------------------------|-------------------|--------------|
| Session discovery | SessionStart hook | SDK-managed | Hooks | SessionStart hook (same as ccbot) |
| Topic mapping | 1 topic = 1 tmux window | Project threads | Per-platform | 1 topic = 1 session (hook-native, no tmux) |
| Tool notifications | JSONL polling (2s) | Real-time SDK events | Hook events | PostToolUse hooks (real-time, no polling) |
| Permission control | Inline keyboard | Inline keyboard | Button-based | Inline keyboard via PreToolUse blocking hook |
| Text input | tmux send-keys | Direct SDK input | PTY/tmux injection | UserPromptSubmit hook or named pipe |
| Text output | JSONL transcript parsing | SDK stream | Terminal monitoring | JSONL transcript parsing (like ccbot) |
| Message batching | Not documented | Verbosity levels | Not documented | Queue + batch + editMessageText |
| Multi-machine | Not supported | Not applicable | Multi-platform | Per-machine bot tokens in shared group |
| Dependencies | Go + tmux | Python + FastAPI + SQLite | Python + hooks | Node.js only |
| Subagent tracking | No | No | No | Yes (SubagentStart/Stop hooks) |

## Technical Constraints Affecting Features

### Telegram API Rate Limits
- **20 messages per minute per group chat** -- This is the hard constraint. With rapid tool calls, we WILL hit this without batching.
- **30 messages per second global per bot** -- Less of a concern for single-user, but matters for multi-session.
- **4096 character limit per message** -- Long outputs need truncation or file upload.
- **64 bytes per callback_data** -- Inline keyboard buttons can store session_id + action, but not much more.
- **100 buttons max per inline keyboard** -- More than enough for our use case.

### Claude Code Hook Constraints
- **Hooks block synchronously** -- PreToolUse hooks block Claude Code while waiting. Must handle timeouts.
- **10 minute default timeout** -- Generous, but should auto-resolve faster (30-60 seconds for approval).
- **stdin/stdout/stderr only** -- No direct API calls from hooks. Communication is via JSON on stdio.
- **Exit code semantics** -- Exit 0 = proceed, Exit 2 = block. Other exits = non-blocking error.
- **Parallel hook execution** -- All matching hooks run in parallel. Our hooks should be the only registered hooks for each event to avoid conflicts.

### Hook Input Data Available
- **Common fields on every event:** `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`
- **PreToolUse/PostToolUse:** `tool_name`, `tool_input`, `tool_use_id`
- **Notification:** notification type (matcher: `permission_prompt`, `idle_prompt`, `auth_success`)
- **SessionStart:** `source` (startup/resume/clear/compact), `model`
- **Stop:** `stop_hook_active` (to prevent infinite loops)
- **UserPromptSubmit:** `prompt` text

## Sources

- [Telegram Bot API](https://core.telegram.org/bots/api) -- Official API reference (HIGH confidence)
- [Telegram Forum Topics API](https://core.telegram.org/api/forum) -- Forum/topics documentation (HIGH confidence)
- [Telegram Bot FAQ - Rate Limits](https://core.telegram.org/bots/faq) -- 20 msg/min per group, 30 msg/s global (HIGH confidence)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide) -- Official hooks tutorial (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- Full event schemas, input/output formats (HIGH confidence)
- [ccbot (six-ddc)](https://github.com/six-ddc/ccbot) -- Closest competitor, tmux-based Telegram bridge (MEDIUM confidence)
- [claude-o-gram (RichardAtCT)](https://github.com/RichardAtCT/claude-o-gram) -- SDK-wrapper Telegram bot (MEDIUM confidence)
- [Claude-Code-Remote (JessyTsui)](https://github.com/JessyTsui/Claude-Code-Remote) -- Multi-platform remote control (MEDIUM confidence)
- [claude-code-hooks-multi-agent-observability (disler)](https://github.com/disler/claude-code-hooks-multi-agent-observability) -- Hook-based observability dashboard (MEDIUM confidence)

---
*Feature research for: Claude Code Telegram Bridge*
*Researched: 2026-02-28*
