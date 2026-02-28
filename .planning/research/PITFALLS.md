# Pitfalls Research

**Domain:** Telegram bot bridging Claude Code CLI sessions (hooks, log monitoring, IPC, Telegram API)
**Researched:** 2026-02-28
**Confidence:** HIGH (verified against official Claude Code docs and Telegram Bot API docs)

## Critical Pitfalls

### Pitfall 1: Hook Timeout Kills the Blocking Bridge

**What goes wrong:**
A PreToolUse hook script blocks while waiting for a Telegram user to tap Approve/Deny. The user is AFK or distracted. Claude Code's default command hook timeout (600 seconds / 10 minutes) fires, the hook process is killed, and Claude Code treats it as a non-blocking error -- meaning the tool call **proceeds without permission**. The user thinks they have veto power, but in reality anything Claude wants to do just happens after 10 minutes of silence.

**Why it happens:**
The official docs state: command hooks default to 600s timeout. Any exit code other than 0 or 2 is a "non-blocking error" where "stderr is shown in verbose mode and execution continues." A killed process exits with signal-based codes (137/143), which fall into the "any other exit code" bucket, so execution continues. Developers assume a timeout means "block" but it actually means "allow."

**How to avoid:**
- Set the hook `timeout` to a very large value (e.g., 3600 seconds or more) in the hook configuration -- the field is configurable per handler.
- Implement an internal timeout in the hook script itself that returns exit code 2 (blocking error) with a stderr message like "Timed out waiting for Telegram approval" so Claude gets useful feedback instead of proceeding.
- Never rely on Claude Code's process-kill timeout as your safety net. Always have the hook script manage its own timeout and exit with code 2 to deny.

**Warning signs:**
- Tool calls executing without Approve buttons ever being shown in Telegram.
- Hook scripts being killed by SIGTERM during testing.
- Claude proceeding with operations while Telegram still shows a pending approval button.

**Phase to address:**
Phase 1 (core hook + IPC). This is the most architecturally critical decision -- get the timeout/exit-code contract right from day one.

---

### Pitfall 2: Bot Crash Leaves Hook Scripts Hanging Forever

**What goes wrong:**
The bot process crashes (unhandled exception, OOM, restart) while a PreToolUse hook script is blocking and waiting for a response over IPC (Unix domain socket, named pipe, or temp file). The hook script never receives a response. If the hook has no internal timeout, it blocks Claude Code indefinitely. If Claude Code eventually kills it via its timeout, the tool call proceeds without approval (see Pitfall 1).

**Why it happens:**
The IPC channel (Unix domain socket, FIFO, etc.) has no heartbeat or keepalive. The hook script opens a connection, sends the approval request, and calls a blocking read. When the bot crashes, the socket may or may not emit an error depending on implementation: Unix domain sockets will get an EOF/error on the read side if the server closes, but named pipes (FIFOs) will block indefinitely if no writer has the pipe open. Even with sockets, if the bot crashes mid-restart, there is a window where the hook reconnects to nothing.

**How to avoid:**
- Use Unix domain sockets (not FIFOs) for the IPC channel. Sockets deliver connection-refused or EOF on crash, making failure detectable.
- Implement a poll/timeout loop in the hook script: try to connect, send request, wait for response with a timeout. If connection fails or times out, exit 2 to deny.
- The bot should clean up stale socket files on startup. Check for and remove leftover `/tmp/claude-telegram-*.sock` files before binding.
- Design the hook script to be resilient: if the bot is unreachable, always deny (exit 2), never allow by default.

**Warning signs:**
- Claude Code sessions hanging indefinitely with no terminal output.
- Stale socket files in `/tmp` after bot restarts.
- `ps aux | grep hook` showing zombie hook processes.

**Phase to address:**
Phase 1 (IPC design). The IPC protocol and crash recovery must be designed before any feature code.

---

### Pitfall 3: Telegram Rate Limits Silently Drop Messages During Streaming

**What goes wrong:**
Claude Code makes rapid tool calls (e.g., reading 10 files in sequence, running multiple bash commands). Each triggers a PostToolUse hook that sends a message to the Telegram topic. Telegram's rate limit of ~20 messages per minute per group kicks in, returns HTTP 429 with a `retry_after` value of 30-60 seconds. During that window, **all** bot API calls fail -- not just for that topic, but for the entire bot across all groups and topics. Approval buttons from other sessions are also blocked. If you naively retry without respecting `retry_after`, the ban escalates.

**Why it happens:**
Telegram enforces ~1 message/second per chat and ~20 messages/minute per group. Claude Code can easily generate 20+ tool calls in under a minute. Additionally, `editMessageText` is rate-limited at ~5 edits per message per minute (empirically observed, not officially documented). Developers often use message editing for "streaming" updates, which hits this limit fast.

**How to avoid:**
- Implement a per-group message queue with rate limiting. Target 1 message per 3 seconds as a safe baseline.
- Batch rapid tool calls into a single message update instead of one message per tool call. Accumulate events for 2-3 seconds, then send one combined message.
- For streaming output, use a single message that gets edited at most once every 12 seconds (staying well under the 5-edits/minute empirical limit).
- Always parse and respect the `retry_after` field from 429 responses. Add 10% jitter to avoid thundering herd on retry.
- Use a circuit breaker: if you get a 429, pause ALL outbound messages (not just the one that failed) for the `retry_after` duration.
- Consider sending large outputs as document attachments instead of messages (file uploads have separate, more generous limits).

**Warning signs:**
- Messages appearing out of order in Telegram topics.
- Gaps in the tool call log visible in Telegram.
- HTTP 429 errors in bot logs.
- Approval buttons failing to appear while the bot is sending status updates.

**Phase to address:**
Phase 2 (Telegram integration). Must be in place before any real output streaming is implemented.

---

### Pitfall 4: MarkdownV2 Parsing Failures Crash Message Delivery

**What goes wrong:**
Tool output contains special characters (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`). You send it via `sendMessage` with `parse_mode: "MarkdownV2"`. Telegram returns "Bad Request: can't parse entities" and the message is never delivered. The user sees nothing. If this happens on an approval request message, the hook blocks indefinitely waiting for a button press that was never shown.

**Why it happens:**
MarkdownV2 requires escaping 18+ special characters. Code output, file paths, error messages, and bash output are full of these characters. A single unescaped `.` or `-` in normal text breaks the entire message. Nested code blocks with backticks inside backticks are especially treacherous.

**How to avoid:**
- Use `parse_mode: "HTML"` instead of MarkdownV2. HTML only requires escaping `<`, `>`, and `&` -- far simpler and more robust for arbitrary code output.
- Build a robust escaping function and unit test it against real Claude Code output (file paths with dots, bash errors with brackets, stack traces with parentheses).
- Always wrap the `sendMessage` call in error handling. If parsing fails, retry with the message stripped of all formatting (plain text fallback).
- For code output, always wrap in `<pre>` tags (HTML) which provides a code block that does not require entity escaping of the content.

**Warning signs:**
- Telegram API returning 400 errors with "can't parse entities" in bot logs.
- Messages silently disappearing -- sent but never visible.
- Approval buttons not appearing for certain tool calls (ones with special chars in their description).

**Phase to address:**
Phase 2 (message formatting). Decide on HTML parse mode early and build the escaping/formatting layer before any feature messages.

---

### Pitfall 5: Session Isolation Failure with Concurrent Claude Code Sessions

**What goes wrong:**
Two Claude Code sessions run simultaneously in the same project directory. Both trigger PreToolUse hooks. The hook script uses a single shared IPC endpoint (one socket path, one temp file). An approval response meant for Session A gets routed to Session B, approving the wrong tool call. Or worse: Session B's approval request overwrites Session A's pending request, and Session A blocks forever.

**Why it happens:**
Hooks fire for **every** session in the project. The official docs confirm: "Direct edits to hooks... Claude Code captures a snapshot of hooks at startup." All sessions sharing the same `.claude/settings.json` get the same hooks. If the hook script uses a fixed IPC path (e.g., `/tmp/claude-telegram.sock`), both sessions talk to the same bot endpoint with no session discrimination.

**How to avoid:**
- The hook JSON input includes `session_id` on every event. Extract it and use it to namespace ALL IPC communication.
- Use session-scoped IPC paths: `/tmp/claude-telegram-${session_id}.sock` or include session_id in every IPC message as a routing key.
- The bot must maintain a map of `session_id -> Telegram topic`. When an approval request arrives, it must be routed to the correct topic and the response must be routed back to the correct session's hook process.
- Store NO session state in shared files. Every state file must include the session_id in its filename.
- Test with 2+ concurrent sessions from day one.

**Warning signs:**
- Approval buttons appearing in the wrong Telegram topic.
- One session completing while another hangs.
- Wrong tool call being approved/denied.

**Phase to address:**
Phase 1 (IPC protocol design). The session_id routing must be baked into the IPC protocol from the start. Retrofitting session isolation is a rewrite.

---

### Pitfall 6: 4096-Character Message Limit Truncates Critical Output

**What goes wrong:**
A tool call produces output longer than 4096 characters (common for: file reads, bash output, diff output, error stack traces). The message is silently rejected by Telegram, or the bot's splitting logic breaks a code block in half, producing malformed formatting that triggers a parse error (see Pitfall 4). The user sees a partial message or nothing at all, missing context needed to make approval decisions.

**Why it happens:**
Telegram enforces a hard 4096-character limit per message (after entity parsing). This is the post-parsing limit -- formatting entities count toward it. A `<pre>` code block with 4000 characters of content plus the tags themselves may exceed the limit.

**How to avoid:**
- Build a message-splitting utility from the start. It must be formatting-aware: if splitting inside a `<pre>` block, close the tag before the split and reopen it after.
- Count characters after formatting/entity expansion, not before.
- For very long output (>12000 chars), send as a file attachment (`.txt` document) instead of multiple messages. This avoids rate limit pressure and provides a better UX.
- Set a maximum of 3-4 split messages. Beyond that, always fall back to file attachment.
- For approval messages, keep the message short (tool name, truncated command preview) with a "Full details" expandable or file attachment for the full input.

**Warning signs:**
- Empty or missing messages in Telegram topics after tool calls with large output.
- Messages with broken formatting (unclosed code blocks).
- "Message is too long" errors in bot logs.

**Phase to address:**
Phase 2 (message formatting layer). Build the splitter/file-fallback before implementing any output forwarding.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Polling temp files instead of Unix sockets for IPC | Simpler implementation, no socket management | Race conditions on read/write, no connection state awareness, no crash detection | Never -- sockets are only marginally harder and much more robust |
| Single `sendMessage` per tool call (no batching) | Simpler code, real-time feel | Hits rate limits after 20 tool calls/min, blocks approval buttons | MVP only with <5 tool calls per session expected |
| Parsing JSONL log files by reading entire file each poll | Works for small files | O(n) on every poll, memory spikes on large sessions, slow for 10K+ line transcripts | Never -- use file offset tracking with `fs.read` at last position |
| Hardcoded 4096-char message split without formatting awareness | Quick to implement | Breaks code blocks, triggers MarkdownV2/HTML parse errors, confusing partial messages | Never -- the formatting-aware splitter is not much harder |
| Using `getUpdates` (polling) for Telegram instead of webhooks | No public URL needed, simpler dev setup | Higher latency, can not scale, 409 conflict if accidentally run two instances | Acceptable for this project's scale (2-3 machines, single bot per machine) |
| Storing session-topic mapping only in memory | No database dependency | Lost on bot restart, orphaned topics | MVP only -- persist to a JSON file at minimum |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Telegram Forum Topics | Sending `message_thread_id=1` for the General topic -- Telegram returns "Message thread not found" | The General topic (ID 1) is implicit. Set `message_thread_id` to `null`/omit it when targeting General. Only pass the thread ID for non-General topics |
| Telegram Forum Topics | Bot cannot create topics because it lacks `can_manage_topics` permission | Ensure the bot is added as admin with "Manage Topics" permission before any topic creation code runs. Fail loudly if permission is missing at startup |
| Telegram Forum Topics | Trying to send a message to a closed/deleted topic | Always handle 400 "TOPIC_CLOSED" or "TOPIC_DELETED" errors. Recreate the topic or fall back to General |
| Claude Code Hooks | Assuming hook JSON arrives as command-line arguments | Hook input is delivered via **stdin** as JSON, not as CLI args. Read from stdin, pipe to `jq`, or parse in your script |
| Claude Code Hooks | Using `async: true` on PreToolUse hooks expecting to block | Async hooks run in the background and cannot block. PreToolUse hooks that need to approve/deny MUST be synchronous (default). The `async` field must be `false` or omitted |
| Claude Code Hooks | Printing debug output to stdout alongside JSON | Claude Code parses stdout for JSON on exit 0. Any non-JSON text (debug prints, shell profile banners) corrupts the output. Use stderr for debug output |
| Claude Code JSONL Logs | Reading the transcript file listed in `transcript_path` while Claude Code is writing to it | Partial line reads are possible. Always handle incomplete JSON lines at the end of the file. Read up to the last complete newline and buffer any trailing partial line |
| Telegram Callback Queries | Not calling `answerCallbackQuery` after handling a button press | Telegram shows a perpetual loading spinner on the button for ~30 seconds. Always answer callback queries, even if you have nothing to display |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Re-reading entire JSONL transcript on every poll cycle | Increasing CPU/memory, lag in posting updates | Track file byte offset with `fs.stat()` and `fs.read()` from last position. Only parse new bytes | Transcript exceeds ~5MB (typical after 30-60 min intensive session) |
| Creating a new Telegram message for every tool call instead of editing | Hits 20 msg/min group rate limit, topics become unreadable walls of text | Batch tool calls into periodic summary edits (every 3-5 seconds) | More than 20 tool calls per minute (very common with file reads) |
| Synchronous file I/O in the bot's main event loop | Bot becomes unresponsive to Telegram updates while reading large files | Use async `fs.promises` or `fs.createReadStream` for all file operations | Log files exceed ~1MB |
| Opening a new IPC connection per hook invocation | Connection overhead, stale sockets accumulate | Use persistent connections with reconnection logic, or use a single socket per session with message framing | More than 10 hook invocations per minute (routine in active sessions) |
| Storing full tool output in memory for all active sessions | Memory grows unbounded during long sessions | Stream output to Telegram with a bounded buffer (keep only last N KB), discard after sending | 3+ concurrent sessions with verbose output |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging or forwarding Telegram bot token in error messages | Token leak allows anyone to control the bot | Scrub tokens from all log output. Store in env vars, never in hook scripts or config files |
| Forwarding raw tool output to Telegram without sanitization | Secrets in environment variables, `.env` files, or credentials shown in file reads can be posted to the Telegram group | Implement a secret scrubber that redacts patterns matching API keys, tokens, passwords before sending to Telegram |
| Using the bot token in the IPC socket path | Exposes the token in `ps` output and `/tmp` directory listings | Use a hash of the token or a random identifier for socket naming |
| Not validating `callback_query` data before acting on it | Other bots/users in the group could craft callback data to approve malicious tool calls | Encode the session_id and a nonce in callback_data. Verify both before processing any approval |
| Running hook scripts as root or with elevated privileges | Hook scripts inherit the Claude Code process's permissions -- if running as a privileged user, IPC bugs could allow command injection | Run Claude Code and the bot as an unprivileged user. Validate all data received over IPC before acting on it |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Flooding the topic with one message per tool call | The topic becomes an unreadable firehose of messages. User cannot find the approval request among dozens of status messages | Batch non-interactive updates into periodic summaries (every 5-10 seconds). Only send individual messages for things requiring user action (approvals) |
| Showing full tool input/output for file reads | Massive walls of code in Telegram. User has to scroll endlessly on mobile | Show a 1-line summary (tool name, file path, first/last 3 lines of output). Provide "Full output" as a file attachment |
| No visual distinction between status messages and approval requests | User misses critical approval buttons buried among status updates | Use distinct formatting: approval messages get inline keyboard buttons AND a different message format (e.g., bold header, warning emoji). Regular updates are plain text |
| Approval buttons that stay active after the hook times out | User taps "Approve" 15 minutes later, nothing happens but they think it worked | Edit the message to show "Expired -- auto-denied" when the hook times out. Remove or disable the inline keyboard |
| No indication of what Claude is currently doing between messages | User sees the last update from 2 minutes ago and wonders if Claude is stuck | Send periodic heartbeat messages or edit the session's pinned status message with a "Last active: X seconds ago, currently: [thinking/executing tool/waiting for approval]" |
| Topic names that do not identify the session purpose | Topics named "Session abc123" are meaningless | Use the initial prompt or task summary as the topic name, truncated to Telegram's limit. E.g., "Fix auth bug in login.ts" |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **PreToolUse blocking:** Works in testing but does not handle the case where the bot is not running. Verify: start a Claude Code session without the bot running. The hook should time out and deny (not hang forever, not auto-approve).
- [ ] **Message delivery:** Messages send successfully but were you checking for 429 responses? Verify: send 30 messages in 60 seconds and confirm all 30 eventually arrive (with proper queuing/retry).
- [ ] **Session tracking:** New sessions get topics created, but do ended sessions get cleaned up? Verify: start and stop 5 sessions, confirm topics are closed/archived and the session map is cleaned up.
- [ ] **Bot restart recovery:** Bot restarts cleanly, but does it recover in-flight approval requests? Verify: start a hook blocking on approval, kill the bot, restart it, confirm the hook gets denied (not approved, not stuck forever).
- [ ] **Concurrent sessions:** Works with one session, but have you tested two? Verify: run two Claude Code sessions simultaneously, trigger approvals in both, confirm responses route to the correct session.
- [ ] **Message splitting:** Short messages send fine, but does a 10,000-character bash output render correctly? Verify: trigger a tool call that produces 10K+ chars of output, confirm it arrives as properly formatted split messages or a file attachment.
- [ ] **Log file monitoring:** Works with fresh log files, but what about a resumed session with an existing 5MB transcript? Verify: resume a long session and confirm the monitor does not re-process the entire file.
- [ ] **Callback query handling:** Approve/Deny buttons work, but do expired buttons get disabled? Verify: let a hook timeout, then tap the button -- it should show "expired" not trigger an action.
- [ ] **Topic creation:** Topics are created on session start, but what if the bot lacks `can_manage_topics` permission? Verify: remove the permission, start a session, confirm a clear error message (not a silent failure).

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Hook timeout auto-approves dangerous operation | HIGH | No automatic recovery possible. The tool call already executed. Add logging of all auto-approved operations for audit. Implement the internal timeout + exit 2 pattern to prevent recurrence |
| Bot crash with hanging hooks | MEDIUM | Restart bot. All pending hooks will eventually timeout. With proper exit-2-on-timeout, they will deny. Fix: add health check endpoint and process monitor (systemd, pm2) |
| Rate limit ban from Telegram | LOW | Wait for `retry_after` duration (typically 30-60s). Queue messages during ban. Fix: implement proper message batching/queuing |
| Message formatting failure | LOW | Re-send as plain text (no parse_mode). Fix: switch to HTML mode with proper escaping, add plain-text fallback |
| Session isolation breach (wrong approval) | HIGH | Cannot undo an incorrect approval after execution. Add session_id validation to IPC protocol. Log all approval decisions with session context for audit |
| Orphaned topics after crash | LOW | On bot startup, scan for topics with no active session. Archive/close them. Persist session-topic mapping to disk |
| JSONL partial line read | LOW | Buffer the partial line, re-read on next poll cycle. Ensure the buffer is per-file and persisted across poll cycles |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Hook timeout auto-approves (Pitfall 1) | Phase 1: Core IPC + Hook Design | Unit test: hook with no bot running exits 2 within configured timeout. Integration test: hook timeout sends deny, not allow |
| Bot crash leaves hooks hanging (Pitfall 2) | Phase 1: Core IPC + Hook Design | Kill bot during active approval, verify hook exits 2 within 30s. Restart bot, verify socket cleanup |
| Telegram rate limits (Pitfall 3) | Phase 2: Telegram Integration | Load test: trigger 50 tool calls in 60 seconds, verify no 429 errors reach the user and all messages eventually deliver |
| MarkdownV2 parse failures (Pitfall 4) | Phase 2: Message Formatting | Test with output containing all 18+ special characters. Verify zero parse errors across 100 random tool outputs |
| Session isolation failure (Pitfall 5) | Phase 1: IPC Protocol Design | Run 2 concurrent sessions, trigger simultaneous approvals, verify correct routing. Run 3 sessions, stop one, verify others unaffected |
| 4096-char message truncation (Pitfall 6) | Phase 2: Message Formatting | Send 10K, 50K, and 100K character outputs. Verify all arrive intact (split or as file) with correct formatting |
| General topic message_thread_id=1 bug | Phase 2: Topic Management | Create a topic, send to it, then try General. Verify no "thread not found" errors |
| Stdout JSON corruption from debug prints | Phase 1: Hook Script Design | Hook scripts must use stderr for all debug output. CI lint: grep for echo/console.log that writes to stdout outside JSON |
| Stale callback buttons after timeout | Phase 3: UX Polish | Let approval timeout, tap button, verify "expired" response and no action taken |
| Bot restart loses session map | Phase 2: State Persistence | Kill bot, restart, verify all active sessions are re-associated with their topics |

## Sources

- [Claude Code Hooks Reference (Official)](https://code.claude.com/docs/en/hooks) -- HIGH confidence. Exit code behavior, timeout defaults, JSON input/output format, event lifecycle.
- [Telegram Bot API (Official)](https://core.telegram.org/bots/api) -- HIGH confidence. Rate limits, message limits, forum topic API.
- [Telegram Bot API FAQ (Official)](https://core.telegram.org/bots/faq) -- HIGH confidence. Rate limit numbers (30 msg/s global, 20 msg/min per group).
- [grammY Flood Limits Guide](https://grammy.dev/advanced/flood) -- MEDIUM confidence. Empirical editMessage limit (~5/min/msg), retry_after behavior.
- [GramIO Rate Limits Guide](https://gramio.dev/rate-limits) -- MEDIUM confidence. 429 handling patterns, retry strategies.
- [Claude Code Session Isolation Blog Post](https://jonroosevelt.com/blog/claude-code-session-isolation-hooks) -- MEDIUM confidence. Real-world concurrent session bugs, session_id scoping pattern.
- [python-telegram-bot Issue #4739](https://github.com/python-telegram-bot/python-telegram-bot/issues/4739) -- HIGH confidence. General topic message_thread_id=1 bug confirmed by maintainers.
- [Node.js net module docs](https://nodejs.org/api/net.html) -- HIGH confidence. Unix domain socket IPC, connection error handling.
- [Chokidar GitHub Issue #1112](https://github.com/paulmillr/chokidar/issues/1112) -- MEDIUM confidence. Race conditions in directory watching.
- [Claude Code Bug #24327](https://github.com/anthropics/claude-code/issues/24327) -- MEDIUM confidence. Exit code 2 causing Claude to stop instead of processing feedback.

---
*Pitfalls research for: Claude Code Telegram Bridge*
*Researched: 2026-02-28*
