# Claude-o-Gram

A Telegram bot that mirrors Claude Code sessions to forum topics, giving you full remote monitoring and control from your phone.

Each Claude Code session gets its own forum topic. You see every tool call, every text response, and every notification — and you can send text input back, all from Telegram.

## Features

**Session Lifecycle** — Sessions auto-create forum topics when they start and close them when they end. Concurrent sessions get isolated topics. New sessions in the same directory reuse recently closed topics. The bot reconnects to active sessions on restart.

**Real-time Monitoring** — Tool calls (file reads, edits, bash commands) are posted as they happen. Claude's text output is captured from JSONL transcripts. A pinned status message shows context window usage, tool counts, and files changed.

**Verbosity Control** — Three tiers: `/verbose` (everything), `/normal` (hide Read/Glob/Grep), `/quiet` (only Write/Edit/Bash). Change per-session at any time.

**Text Input** — Reply with text in a session topic and it gets delivered to Claude Code. Input is routed automatically via tmux (preferred), named pipe (FIFO), or SDK resume (fallback).

**Sub-agent Tracking** — Sub-agent spawns and completions are tracked with optional visibility toggle. Task checklists show live progress.

**Command Forwarding** — Claude Code slash commands (e.g., `/commit`, `/review-pr`) typed in a session topic are forwarded to the CLI. The bot auto-discovers available commands and skills for Telegram autocomplete.

## Prerequisites

- Node.js >= 20
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram supergroup with **Topics enabled** (Group Settings > Topics)
- Your bot added as an **admin** in the group (needs permission to manage topics and pin messages)
- Claude Code installed on the machine
- Your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Create a Forum Group

1. Create a new Telegram group (or use an existing one)
2. Go to Group Settings > Topics and enable topics
3. Add your bot to the group and make it an admin
4. Get the group's chat ID — the easiest way is to add [@RawDataBot](https://t.me/RawDataBot) to the group, note the chat ID from its message, then remove it. The ID will be a negative number like `-1001234567890`.

### 3. Install and Configure

```bash
git clone https://github.com/nicobailon/claude-o-gram.git
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

## Environment Variables

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

## Bot Commands

Run these in any session topic:

| Command | Description |
|---------|-------------|
| `/status` | Show bot uptime and active session count |
| `/verbose` | Show all tool calls |
| `/normal` | Hide Read, Glob, Grep (default) |
| `/quiet` | Show only Write, Edit, and Bash |

## How It Works

The bot runs a single process with two components:

1. **Fastify HTTP server** — Receives POST requests from Claude Code's hook system. All hook routes require Bearer token authentication.

2. **grammY Telegram bot** — Posts messages to forum topics, handles commands, button callbacks, and text input.

On startup, the bot auto-installs HTTP hooks into `~/.claude/settings.json` with Bearer token headers. These hooks tell Claude Code to POST events to the local Fastify server.

### Text Input

When you send a text message in a session topic, the bot routes it to Claude Code using the best available method:

1. **tmux** (preferred) — Injects text via `send-keys` into the Claude Code terminal pane. Requires Claude Code to be running inside tmux. The pane ID is auto-detected on session start.
2. **FIFO** — Writes to a named pipe at `~/.claude-o-gram/input/<session-id>.fifo`. For headless/automated setups.
3. **SDK resume** (fallback) — Uses the Claude Agent SDK to resume an idle session with the text as a prompt. Only works when the CLI process has exited.

### Session Persistence

Session state is persisted to `DATA_DIR/sessions.json` using atomic writes. On restart, the bot reconnects to any sessions that were still active, sending a "Reconnected" notice to their topics.

## Running with tmux (Recommended)

For full text input support, run Claude Code inside tmux:

```bash
tmux new-session -s claude
claude  # start Claude Code inside tmux
```

The bot automatically detects the tmux pane. Text replies in Telegram will be injected directly into the Claude Code terminal.

## Running as a Service

To keep the bot running in the background:

```bash
# Using tmux
tmux new-session -d -s telegram-bot 'cd /path/to/claude-o-gram && npm start'

# Or using pm2
pm2 start dist/index.js --name claude-telegram
```

## CLI Runtime Observability

The bot process now includes a richer terminal UX for operational visibility:

- **Colorful structured logs** for startup, session lifecycle, hook/auth activity, permission flow, and subagent lifecycle.
- **Live status dashboard** (TTY mode) that refreshes in place and shows:
  - uptime
  - active sessions
  - pending approvals
  - hook throughput totals
  - auth failures
  - active/completed subagents
  - warning/error counts
  - last significant runtime event

Use environment flags to tune behavior:

- `CLI_COLOR=auto|on|off`
- `CLI_DASHBOARD=auto|on|off`
- `CLI_LOG_LEVEL=debug|info|warn|error`

Examples:

```bash
# Always show colors + dashboard, include debug events
CLI_COLOR=on CLI_DASHBOARD=on CLI_LOG_LEVEL=debug npm start

# Plain logs only (no in-place dashboard)
CLI_COLOR=off CLI_DASHBOARD=off CLI_LOG_LEVEL=info npm start
```

## Security

The bot has two authentication layers:

**Telegram access control** — A global middleware checks every incoming Telegram update against `BOT_OWNER_ID`. Updates from any other user are silently dropped. This is enforced before all commands, callback queries, and text messages. `BOT_OWNER_ID` is a required environment variable — the bot will not start without it.

**Hook server authentication** — On first startup, the bot generates a random 256-bit secret and stores it at `~/.claude-o-gram/hook-secret` (mode `0600`, owner-only). This secret is:
- Set as `CLAUDE_CODE_TELEGRAM_SECRET` in the process environment
- Written into `~/.claude/settings.json` as `env.CLAUDE_CODE_TELEGRAM_SECRET`
- Referenced in hook HTTP headers via Claude Code's `allowedEnvVars` mechanism
- Validated by a Fastify `onRequest` hook on all `/hooks/*` routes (returns 401 on mismatch)

The hook server binds to `127.0.0.1` by default (localhost only, not exposed to the network).

**Secret leak prevention** — The repository enforces secret scanning in two places:
- **CI:** GitHub Actions runs `gitleaks` on every push/PR and fails the workflow if leaks are detected.
- **Local pre-commit hook:** Run `npm run hooks:install` once per clone to enable `.githooks/pre-commit`, which scans staged changes before each commit.

## Development

```bash
npm run dev        # Watch mode with tsx
npm run typecheck  # Type-check without emitting
npm run lint       # ESLint
npm test           # Run all tests
npm run hooks:install     # Install repository git hooks (run once per clone)
npm run secrets:scan      # Full-history secret scan
npm run secrets:scan:staged  # Scan staged changes (used by pre-commit)
```

## Architecture

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

## License

BSD 3-Clause. See [LICENSE](LICENSE).
