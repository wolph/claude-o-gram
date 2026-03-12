<p align="center">
  <img src="docs/assets/banner.png" alt="Claude-o-Gram banner" width="600" />
</p>

<h1 align="center">Claude-o-Gram</h1>

<p align="center"><strong>The missing remote for Claude Code.</strong></p>

<p align="center">
  Every session. Every tool call. Every decision — live on Telegram.
</p>

<p align="center">
  <a href="https://github.com/wolph/claude-o-gram/actions/workflows/ci.yml"><img src="https://github.com/wolph/claude-o-gram/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/bot-grammY-009dca" alt="grammY" />
  <img src="https://img.shields.io/badge/server-Fastify-000000" alt="Fastify" />
</p>

---

## What You Get

| | Feature | Description |
|---|---|---|
| :red_circle: | **Live Sessions** | Every Claude Code session gets its own forum topic with real-time tool calls streaming in |
| :iphone: | **Remote Control** | Reply in Telegram to send text input straight back to Claude Code |
| :mag: | **Verbosity on Demand** | `/verbose`, `/normal`, `/quiet` — tune the noise level per session, any time |
| :robot: | **Sub-agent Tracking** | Spawn/complete visibility with live task checklists |
| :zap: | **Command Forwarding** | Slash commands typed in Telegram are forwarded to the CLI, auto-discovered |
| :lock: | **Locked Down** | Owner-only access, bearer-token auth, localhost-bound hook server |

## See It In Action

<p align="center">
  <img src="docs/assets/session-topic.png" alt="Live session topic with tool calls streaming" width="360" /><br />
  <em>Live session topic — tool calls stream in as they happen</em>
</p>

<p align="center">
  <img src="docs/assets/approval-prompt.png" alt="Approval prompt in Telegram" width="360" /><br />
  <em>Approval prompts — accept or deny tool calls from your phone</em>
</p>

<p align="center">
  <img src="docs/assets/status-message.png" alt="Pinned status message" width="360" /><br />
  <em>Pinned status — context usage, tool counts, files changed at a glance</em>
</p>

## Quickstart

> **You need:** Node.js >= 20, a Telegram bot token, a forum-enabled supergroup, and Claude Code on the machine.

```bash
git clone https://github.com/wolph/claude-o-gram.git
cd claude-o-gram
npm install
cp .env.example .env   # then fill in your tokens
npm run build
npm start
```

That's it. The bot generates its auth secret, installs Claude Code hooks, starts the HTTP server on `127.0.0.1:3456`, and begins polling Telegram. Fire up a Claude Code session and watch the forum topic appear.

> **Tip:** Run Claude Code inside tmux for full text-input support. The bot auto-detects the pane and injects your replies directly into the terminal.

## Deep Dive

<details>
<summary><strong>Detailed Setup Guide</strong></summary>

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Create a Forum Group

1. Create a new Telegram group (or use an existing one)
2. Go to Group Settings > Topics and enable topics
3. Add your bot to the group and make it an admin
4. Get the group's chat ID — add [@RawDataBot](https://t.me/RawDataBot) to the group, note the chat ID from its message, then remove it. The ID will be a negative number like `-1001234567890`.

### 3. Install and Configure

```bash
git clone https://github.com/wolph/claude-o-gram.git
cd claude-o-gram
npm install
```

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_CHAT_ID=-1001234567890
BOT_OWNER_ID=your-telegram-user-id
```

### 4. Build and Run

```bash
npm run build
npm start
```

The bot will:
- Generate a hook authentication secret (stored at `~/.claude-o-gram/hook-secret`)
- Install Claude Code hooks into `~/.claude/settings.json` (idempotent, safe to re-run)
- Start the HTTP hook server on `127.0.0.1:3456`
- Start polling Telegram for updates

Now start a Claude Code session — a forum topic will appear automatically.

</details>

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Forum group chat ID (negative number) |
| `BOT_OWNER_ID` | Yes | — | Your Telegram user ID (only this user can interact with the bot) |
| `HOOK_SERVER_PORT` | No | `3456` | Port for the Fastify hook server |
| `HOOK_SERVER_HOST` | No | `127.0.0.1` | Host for the hook server |
| `DATA_DIR` | No | `./data` | Directory for session persistence |
| `VERBOSITY_DEFAULT` | No | `normal` | Default verbosity: `minimal`, `normal`, or `verbose` |
| `APPROVAL_TIMEOUT_MS` | No | `300000` | Auto-deny timeout for approvals (5 min) |
| `INACTIVE_STALE_HOURS` | No | `6` | Treat active sessions with no hook activity older than this as inactive during settings cleanup |
| `AUTO_APPROVE` | No | `false` | Set to `true` to bypass all approval prompts |
| `CLI_COLOR` | No | `auto` | CLI log color mode: `auto`, `on`, `off` |
| `CLI_DASHBOARD` | No | `auto` | Live CLI status panel mode: `auto`, `on`, `off` |
| `CLI_LOG_LEVEL` | No | `info` | CLI minimum log level: `debug`, `info`, `warn`, `error` |

</details>

<details>
<summary><strong>Bot Commands</strong></summary>

Run these in any session topic:

| Command | Description |
|---------|-------------|
| `/status` | Show bot uptime and active session count |
| `/verbose` | Show all tool calls |
| `/normal` | Hide Read, Glob, Grep (default) |
| `/quiet` | Show only Write, Edit, and Bash |

</details>

<details>
<summary><strong>How It Works</strong></summary>

The bot runs a single process with two components:

1. **Fastify HTTP server** — Receives POST requests from Claude Code's hook system. All hook routes require Bearer token authentication.

2. **grammY Telegram bot** — Posts messages to forum topics, handles commands, button callbacks, and text input.

On startup, the bot auto-installs HTTP hooks into `~/.claude/settings.json` with Bearer token headers. These hooks tell Claude Code to POST events to the local Fastify server.

### Text Input Routing

When you send a text message in a session topic, the bot routes it to Claude Code using the best available method:

1. **tmux** (preferred) — Injects text via `send-keys` into the Claude Code terminal pane. Requires Claude Code to be running inside tmux. The pane ID is auto-detected on session start.
2. **FIFO** — Writes to a named pipe at `~/.claude-o-gram/input/<session-id>.fifo`. For headless/automated setups.
3. **SDK resume** (fallback) — Uses the Claude Agent SDK to resume an idle session with the text as a prompt. Only works when the CLI process has exited.

### Session Persistence

Session state is persisted to `DATA_DIR/sessions.json` using atomic writes. On restart, the bot reconnects to any sessions that were still active, sending a "Reconnected" notice to their topics.

</details>

<details>
<summary><strong>Running as a Service</strong></summary>

For full text input support, run Claude Code inside tmux:

```bash
tmux new-session -s claude
claude  # start Claude Code inside tmux
```

The bot automatically detects the tmux pane. Text replies in Telegram will be injected directly into the Claude Code terminal.

To keep the bot itself running in the background:

```bash
# Using tmux
tmux new-session -d -s telegram-bot 'cd /path/to/claude-o-gram && npm start'

# Or using pm2
pm2 start dist/index.js --name claude-telegram
```

</details>

<details>
<summary><strong>CLI Observability</strong></summary>

The bot process includes a rich terminal UX for operational visibility:

- **Colorful structured logs** for startup, session lifecycle, hook/auth activity, permission flow, and subagent lifecycle.
- **Live status dashboard** (TTY mode) that refreshes in place and shows:
  - Uptime
  - Active sessions
  - Pending approvals
  - Hook throughput totals
  - Auth failures
  - Active/completed subagents
  - Warning/error counts
  - Last significant runtime event

Use environment flags to tune behavior:

- `CLI_COLOR=auto|on|off`
- `CLI_DASHBOARD=auto|on|off`
- `CLI_LOG_LEVEL=debug|info|warn|error`

Examples:

```bash
# Full observability — colors, dashboard, debug events
CLI_COLOR=on CLI_DASHBOARD=on CLI_LOG_LEVEL=debug npm start

# Plain logs only — no in-place dashboard
CLI_COLOR=off CLI_DASHBOARD=off CLI_LOG_LEVEL=info npm start
```

</details>

<details>
<summary><strong>Security</strong></summary>

Two authentication layers keep everything locked down.

**Telegram access control** — A global middleware checks every incoming Telegram update against `BOT_OWNER_ID`. Updates from any other user are silently dropped. This is enforced before all commands, callback queries, and text messages. `BOT_OWNER_ID` is a required environment variable — the bot will not start without it.

**Hook server authentication** — On first startup, the bot generates a random 256-bit secret and stores it at `~/.claude-o-gram/hook-secret` (mode `0600`, owner-only). This secret is:
- Set as `CLAUDE_CODE_TELEGRAM_SECRET` in the process environment
- Written into `~/.claude/settings.json` as `env.CLAUDE_CODE_TELEGRAM_SECRET`
- Referenced in hook HTTP headers via Claude Code's `allowedEnvVars` mechanism
- Validated by a Fastify `onRequest` hook on all `/hooks/*` routes (returns 401 on mismatch)

The hook server binds to `127.0.0.1` by default — localhost only, not exposed to the network.

**Secret leak prevention** — The repository enforces secret scanning via [lefthook](https://github.com/evilmartians/lefthook):
- **CI:** GitHub Actions runs `npx lefthook run quality` which includes a full-history gitleaks scan.
- **Local pre-commit hook:** Installed automatically by `npm install` (via the `prepare` script). Runs lint, typecheck, tests, and staged secrets scan in parallel before each commit.

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
npm run dev                  # Watch mode with tsx
npm run typecheck            # Type-check without emitting
npm run lint                 # ESLint
npm test                     # Run all tests
npx lefthook run quality     # Full quality gate (lint + typecheck + test + secrets)
npm run secrets:scan         # Full-history secret scan
npm run secrets:scan:staged  # Scan staged changes (used by pre-commit)
```

</details>

<details>
<summary><strong>Architecture</strong></summary>

```
src/
  index.ts                  # Entry point, wiring
  config.ts                 # Env var parsing/validation
  types/
    config.ts               # AppConfig interface
    hooks.ts                # Hook payload types
    sessions.ts             # SessionInfo interface
    monitoring.ts           # Monitoring types
  hooks/
    server.ts               # Fastify routes + Bearer auth
    handlers.ts             # Hook event handlers
  bot/
    bot.ts                  # grammY bot, commands, callbacks
    topics.ts               # Forum topic lifecycle
    formatter.ts            # HTML message formatting
    rate-limiter.ts         # Per-session message batching
    command-registry.ts     # Command/skill discovery
    expand-cache.ts         # Expand/collapse message cache
  input/
    input-router.ts         # Routes input to tmux/FIFO/SDK
    tmux-input.ts           # tmux send-keys delivery
    fifo-input.ts           # Named pipe delivery
    sdk-resume-input.ts     # SDK resume delivery
    types.ts                # InputSender interface
  sessions/
    session-store.ts        # In-memory map + JSON persistence
  monitoring/
    verbosity.ts            # Tool call filtering by tier
    transcript-watcher.ts   # JSONL transcript tailing
    status-message.ts       # Pinned status with debounced updates
    subagent-tracker.ts     # Sub-agent lifecycle tracking
    task-checklist.ts       # Live task progress display
    topic-status.ts         # Color-coded topic emoji prefixes
    clear-detector.ts       # Context clear detection
  control/
    approval-manager.ts     # Deferred promise for tool approval
    bypass-batcher.ts       # Auto-approved tool batching
    permission-modes.ts     # Permission mode management
  settings/
    runtime-settings.ts     # Live-configurable settings
    bot-state-store.ts      # Persistent bot-level state
    settings-topic.ts       # Settings forum topic UI
  runtime/
    runtime-status.ts       # Process counters + status snapshot model
    cli-format.ts           # ANSI log formatting + dashboard rendering
    cli-output.ts           # Structured logger + live terminal dashboard
  utils/
    text.ts                 # HTML escaping, markdown, truncation
    hook-secret.ts          # Bearer token generation/storage
    install-hooks.ts        # Auto-install hooks into settings
```

</details>

## License

[BSD 3-Clause](LICENSE)
