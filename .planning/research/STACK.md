# Stack Research

**Domain:** Telegram bot bridging Claude Code sessions (per-machine daemon with bidirectional communication)
**Researched:** 2026-02-28
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 25.x | Runtime | Already on-machine (v25.0.0). Native TypeScript strip-types support -- run `.ts` files directly without transpiler. Event-loop model is ideal for concurrent I/O: watching files, polling Telegram, handling HTTP hooks simultaneously |
| TypeScript | 5.9.x | Type safety | grammY is TypeScript-first with excellent type inference from the Telegram Bot API. Node 25 runs `.ts` natively (erasable syntax only -- no enums, no parameter properties). Use `const` objects or string unions instead of enums |
| grammY | 1.40.x | Telegram Bot API framework | The modern standard for Node.js Telegram bots. Superior TypeScript types vs Telegraf (which has "complex types that were too hard to understand"). First-class plugin ecosystem for rate limiting, menus, conversations. Actively maintained, tracks Bot API releases quickly (currently supports Bot API 9.4). 243+ npm dependents |
| Fastify | 5.7.x | Local HTTP server for hook communication | Claude Code supports HTTP hooks natively (`type: "http"`) -- the bot daemon runs a local HTTP server and Claude Code POSTs hook events directly to it. Fastify is the fastest Node.js HTTP framework, with schema validation built-in. Eliminates need for custom IPC |
| better-sqlite3 | 12.6.x | Local state persistence | Synchronous API is simpler and 2-5x faster than async `sqlite3`. Stores session-to-topic mappings, message queues, hook response state. Single-file database, zero config, perfect for per-machine daemon with no shared state |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @grammyjs/auto-retry | 2.0.x | Automatic rate limit handling | Always -- handles Telegram's 429 (Too Many Requests) responses transparently. Retries with proper backoff. Essential given 1 msg/sec per-chat limit |
| @grammyjs/runner | 2.0.x | Concurrent long polling | Use for production polling. Processes updates concurrently instead of sequentially. Not needed if using webhooks, but we use polling (no public endpoint) |
| @grammyjs/menu | 1.3.x | Interactive inline button menus | For Approve/Deny permission buttons. Handles button callbacks with type-safe menu definitions. Cleaner than raw `InlineKeyboardMarkup` for stateful buttons |
| @grammyjs/transformer-throttler | 1.2.x | Outbound rate limiting | Always -- proactively throttles outbound API calls to stay under Telegram's 30 msg/s global and 1 msg/s per-chat limits. Complementary to auto-retry (throttler prevents, auto-retry recovers) |
| chokidar | 5.0.x | File system watching | For monitoring Claude Code JSONL conversation logs at `~/.claude/projects/`. ESM-only, requires Node >= 20 (we have 25). Uses `fs.watch` internally, avoids polling overhead |
| zod | 4.3.x | Runtime schema validation | Validate hook JSON payloads from Claude Code stdin, validate Telegram callback data, validate config files. TypeScript types inferred from schemas |
| pino | 10.3.x | Structured logging | Fast JSON logger. Essential for daemon process -- logs to file, structured format for debugging. 5x faster than winston |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| tsx | 4.21.x | TypeScript execution (dev/fallback) | Node 25 handles `.ts` natively for erasable syntax. Use `tsx` only for development watch mode (`tsx watch`) and for files needing transform-types (enums). In production, run `.ts` directly with `node` |
| tsup | 8.5.x | Build/bundle for distribution | Bundle to single `.js` file for production deployment. Generates CJS+ESM if needed. Use for hook scripts that must be self-contained |
| vitest | Latest | Testing | Fast, TypeScript-native test runner. Compatible with our ESM setup. Use for unit tests on message formatting, hook parsing, session management |
| @biomejs/biome | Latest | Linting + formatting | Faster than ESLint + Prettier combined. Single tool, zero config for TypeScript. Formats and lints in one pass |

## Key Architecture Decisions in Stack

### Why HTTP Hooks Over Command Hooks

Claude Code supports two hook types for our use case. The choice between them is the most important stack decision:

**Command hooks** (`type: "command"`): Claude Code spawns a new process for each hook event, passes JSON via stdin, reads stdout for response. The hook script must communicate with the bot daemon separately (via HTTP, Unix socket, or file).

**HTTP hooks** (`type: "http"`): Claude Code POSTs JSON directly to a URL. The bot daemon IS the HTTP server. No process spawning, no IPC bridge, no serialization overhead.

**Decision: Use HTTP hooks.** The bot daemon already runs as a long-lived process with Fastify. Claude Code posts directly to `http://localhost:<port>/hooks/pre-tool-use` etc. The response body contains permission decisions. This eliminates an entire communication layer. For async events (PostToolUse, Notification), the hook endpoint returns 200 immediately and processes asynchronously.

**Fallback: Command hooks with HTTP client.** Some hook events may not support HTTP hooks or we may want hooks that work without the daemon running. For these, use a tiny Node.js script that `fetch()`s the daemon's HTTP endpoint: `node .claude/hooks/bridge.js`. This script reads stdin, POSTs to localhost, writes response to stdout.

### Why Node.js Over Python

| Factor | Node.js | Python |
|--------|---------|--------|
| Runtime model | Single event loop handles file watching + HTTP server + Telegram polling concurrently without threads | Requires asyncio everywhere, easy to accidentally block the event loop |
| Telegram library | grammY -- TypeScript-first, excellent types, modern plugin system | python-telegram-bot or aiogram -- both good but weaker typing |
| Hook integration | Claude Code hooks run shell commands or HTTP -- Node.js HTTP client/server is native | Python HTTP works but adds aiohttp dependency |
| TypeScript | Native on Node 25, grammY designed for it | Type hints are optional, libraries inconsistently typed |
| File watching | chokidar is battle-tested, non-polling | watchdog works but less ergonomic for async |
| Already available | Node v25.0.0 is installed on this machine | Would need to verify Python + pip setup |
| Daemon management | Single `node` process handles everything | Would need similar setup, no advantage |

### Why SQLite Over No-Database or JSON Files

The daemon needs to persist: session-to-topic mappings, message edit history (for streaming updates), pending permission requests, and configuration. JSON files are fragile under concurrent writes (multiple Claude Code sessions trigger hooks simultaneously). SQLite handles concurrent reads with WAL mode, provides atomic writes, and querying is trivial. `better-sqlite3`'s synchronous API avoids callback complexity for simple lookups.

### Why Not a Message Queue (Redis, RabbitMQ)

Overkill. We have 2-3 machines each running 1-5 sessions. The bot daemon processes hook events synchronously (or with minimal async). SQLite's write throughput (50K+ writes/sec) far exceeds our needs. Adding Redis means another dependency to install and manage on each machine.

## Telegram Bot API Specifics

### Rate Limits (verified from official FAQ and Bot API docs)

| Limit | Value | Mitigation |
|-------|-------|------------|
| Per-chat messages | 1 msg/sec | `@grammyjs/transformer-throttler` queues messages; batch tool call updates via `editMessageText` instead of new messages |
| Global messages | 30 msg/sec per bot token | `@grammyjs/auto-retry` handles 429s with backoff |
| Inline keyboard buttons | Up to 8 per row, unlimited rows | Sufficient for Approve/Deny + custom options |
| Forum topic creation | Standard API rate limits apply | Create topic once per session, reuse `message_thread_id` |

### Forum Topic API (Bot API 6.1+, current: 9.4)

| Method | Purpose | Notes |
|--------|---------|-------|
| `createForumTopic` | Create topic for new session | Returns `message_thread_id` for all subsequent messages. Bot needs `can_manage_topics` admin right |
| `closeForumTopic` | Archive topic when session ends | Closes the topic, users can still read but not reply |
| `reopenForumTopic` | Reopen if session resumes | For `--continue` / `--resume` scenarios |
| `deleteForumTopic` | Clean up old topics | Optional cleanup, topics can accumulate |
| `editForumTopic` | Update topic name/icon | Update with session status (active/idle/complete) |
| `sendMessage` with `message_thread_id` | Post to specific topic | All messages use this to target the correct session topic |

### Claude Code Hook Events We Use

| Event | How We Use It | Hook Type |
|-------|---------------|-----------|
| `SessionStart` | Create Telegram topic, register session | HTTP (POST to daemon) |
| `PreToolUse` | Post tool call to topic, block for Approve/Deny if configured | HTTP (synchronous response with permissionDecision) |
| `PostToolUse` | Post tool result to topic | HTTP (async, return 200 immediately) |
| `Notification` | Forward notifications to topic | HTTP (async) |
| `Stop` | Post session summary, close topic | HTTP (async) |
| `SessionEnd` | Final cleanup, close/archive topic | HTTP (async) |

### Claude Code Log Format (verified from community tools)

Logs are JSONL at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Each line is a JSON object with:
- `parentUuid`, `uuid` -- message threading
- `sessionId` -- session identifier
- `message.role` -- "user" | "assistant"
- `message.content[]` -- array of `{type: "text", text: "..."}` or `{type: "tool_use", name: "...", input: {...}}` or `{type: "tool_result", ...}`
- `timestamp` -- ISO-8601

The `transcript_path` field in hook input JSON points directly to this file, eliminating the need to discover it.

## Installation

```bash
# Core
npm install grammy @grammyjs/auto-retry @grammyjs/runner @grammyjs/menu @grammyjs/transformer-throttler
npm install fastify better-sqlite3 chokidar zod pino

# Dev dependencies
npm install -D tsx tsup vitest @biomejs/biome @types/better-sqlite3
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| grammY 1.40 | Telegraf 4.x | Only if migrating existing Telegraf codebase. Telegraf lags behind Bot API versions, weaker types, less active development |
| grammY 1.40 | node-telegram-bot-api | Never -- "code bases with more than 50 lines end up being a terrible mess of spaghetti-like cross-references" (grammY docs). No middleware, no plugins |
| grammY 1.40 | GramIO | Too new, small ecosystem. Worth watching but not production-ready for our use case |
| Fastify 5.x | Express 5.x | Only if team is deeply familiar with Express. Fastify is faster and has built-in schema validation |
| Fastify 5.x | Node.js native `http` | Only for the simplest hook endpoint. Loses schema validation, routing, error handling |
| better-sqlite3 | node:sqlite (Node 25 built-in) | Promising but still experimental in Node 25. better-sqlite3 is battle-tested and faster in benchmarks. Revisit when node:sqlite stabilizes |
| better-sqlite3 | JSON files | Never for concurrent access. Multiple Claude Code sessions write simultaneously. JSON files corrupt under concurrent writes |
| chokidar 5 | Node.js `fs.watch` | Only for watching a single known file. `fs.watch` is unreliable: duplicate events, missing filenames on macOS, no recursive watching on some platforms |
| pino 10 | winston | Only if you need winston's transport ecosystem. Pino is 5x faster for JSON logging |
| HTTP hooks | Command hooks | When you need hooks that work without the daemon running (fallback/offline mode). Command hook scripts are simpler to test in isolation |
| Biome | ESLint + Prettier | Only if you need ESLint plugins not available in Biome. For pure TypeScript projects, Biome is faster and simpler |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| TypeScript `enum` | Not supported by Node 25 native TypeScript (requires transform, not just strip). Breaks `node file.ts` execution | `const` objects with `as const` or string union types |
| `namespace` declarations | Same reason -- non-erasable TypeScript syntax | Regular modules and imports |
| `node-ipc` | Maintainer controversy (malicious code incident in 2022). Unnecessary when Claude Code supports HTTP hooks natively | Fastify HTTP server with Claude Code HTTP hooks |
| `ts-node` | Slower than `tsx`, more configuration required, worse ESM support | `tsx` for dev, native `node` for production |
| `dotenv` | Node 25 supports `--env-file` natively | `node --env-file=.env` or inline environment variables |
| Webhook mode (for Telegram) | Requires public URL / ngrok / reverse proxy. Per-machine daemon has no public endpoint | Long polling via `@grammyjs/runner` |
| Redis / message queue | Overkill for 2-3 machines with 1-5 sessions each. Adds ops burden | SQLite + in-process queues |
| Socket.io / WebSocket | No client on Telegram side. Hooks use HTTP. Adds complexity without benefit | HTTP endpoints via Fastify |

## Stack Patterns by Variant

**If adding more machines later (5+):**
- The per-machine architecture still works at 10+ machines
- Each machine independently polls Telegram, posts to shared group
- No central coordination needed -- Telegram group IS the shared state
- Consider unique topic naming to avoid collisions: `[hostname] Session abc123`

**If Claude Code drops HTTP hook support (unlikely but possible):**
- Fall back to command hooks with a bridge script
- Bridge script: `node .claude/hooks/bridge.js` reads stdin, POSTs to daemon's HTTP endpoint
- Same daemon architecture, just different entry point

**If needing real-time streaming of Claude output:**
- Monitor JSONL log file with chokidar for `change` events
- Parse new lines from last-known offset
- Post delta text to Telegram via `editMessageText` (update in place)
- Respect 1 msg/sec rate limit by debouncing edits to 1-2 second intervals

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| grammy@1.40.x | Node >= 18 | Uses standard fetch API, ESM-ready |
| chokidar@5.0.x | Node >= 20 | ESM-only as of v5, requires `"type": "module"` in package.json |
| better-sqlite3@12.x | Node >= 18 | Native addon, needs build tools (python3, make, gcc). Usually pre-built binaries available |
| fastify@5.7.x | Node >= 20 | ESM-first, full TypeScript support |
| Node 25 TypeScript | TypeScript 5.7+ | Only erasable syntax (no enums, no parameter properties, no `namespace`) |

## Sources

- [grammY official site](https://grammy.dev/) -- framework overview, plugin list (HIGH confidence)
- [grammY comparison page](https://grammy.dev/resources/comparison) -- vs Telegraf, NTBA analysis (HIGH confidence)
- [Telegram Bot API docs](https://core.telegram.org/bots/api) -- Bot API 9.4, forum topic methods (HIGH confidence)
- [Telegram Bots FAQ](https://core.telegram.org/bots/faq) -- rate limits: 30 msg/s global, 1 msg/s per chat (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- hook events, HTTP hooks, JSON schemas, PreToolUse decision control (HIGH confidence)
- [grammY flood control docs](https://grammy.dev/advanced/flood) -- rate limit handling patterns (HIGH confidence)
- [npm registry](https://www.npmjs.com/package/grammy) -- grammY v1.40.1 current (HIGH confidence, verified via `npm view`)
- [chokidar GitHub](https://github.com/paulmillr/chokidar) -- v5 ESM-only, Node >= 20 (HIGH confidence)
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3) -- sync API faster than async sqlite3 (HIGH confidence)
- [Node.js TypeScript docs](https://nodejs.org/en/learn/typescript/run-natively) -- native type stripping, erasable-only syntax (HIGH confidence)
- [Claude Code log format](https://github.com/daaain/claude-code-log) -- JSONL structure with message content arrays (MEDIUM confidence, community tool)
- [kent gigger blog](https://kentgigger.com/posts/claude-code-conversation-history) -- `~/.claude/projects/` log paths, session index (MEDIUM confidence)
- Local verification: Node v25.0.0 confirmed TypeScript runs natively, enum syntax rejected (HIGH confidence, tested on-machine)

---
*Stack research for: Claude Code Telegram Bridge*
*Researched: 2026-02-28*
