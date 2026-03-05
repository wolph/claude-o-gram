# Claude Code Telegram Bridge

A Telegram bot that mirrors Claude Code sessions to forum topics, giving you full remote monitoring and control from your phone.

Each Claude Code session gets its own forum topic. You see every tool call, every text response, and every notification — and you can approve or deny actions and send text input back, all from Telegram.

## Features

**Session Lifecycle** — Sessions auto-create forum topics when they start and close them when they end. Concurrent sessions get isolated topics. The bot reconnects to active sessions on restart.

**Monitoring** — Tool calls (file reads, edits, bash commands) are posted as they happen. Claude's text output is captured from JSONL transcripts. A pinned status message shows context window usage, tool counts, and files changed. Periodic summaries aggregate activity.

**Verbosity Control** — Three tiers: `/verbose` (everything), `/normal` (hide Read/Glob/Grep), `/quiet` (only Write/Edit/Bash). Change per-session at any time.

**Approval Flow** — When Claude Code requests a blocked tool call, an inline Approve/Deny button message appears in the topic. Tapping a button unblocks Claude Code with your decision. Unanswered prompts auto-deny after a configurable timeout.

**Text Input** — Reply with text in a session topic and it gets injected into Claude Code's terminal via tmux. If tmux isn't available, input is queued for later delivery.

## Prerequisites

- Node.js >= 20
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Telegram supergroup with **Topics enabled** (Group Settings > Topics)
- Your bot added as an **admin** in the group (needs permission to manage topics and pin messages)
- Claude Code installed on the machine

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
git clone https://github.com/your-username/claude-o-gram.git
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
```

### 4. Build and Run

```bash
npm run build
npm start
```

The bot will:
- Install Claude Code hooks into `~/.claude/settings.json` (idempotent, safe to re-run)
- Start the HTTP hook server on `127.0.0.1:3456`
- Start polling Telegram for updates

Now start a Claude Code session — a forum topic will appear automatically.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Forum group chat ID (negative number) |
| `HOOK_SERVER_PORT` | No | `3456` | Port for the Fastify hook server |
| `HOOK_SERVER_HOST` | No | `127.0.0.1` | Host for the hook server |
| `DATA_DIR` | No | `./data` | Directory for session persistence |
| `VERBOSITY_DEFAULT` | No | `normal` | Default verbosity: `minimal`, `normal`, or `verbose` |
| `SUMMARY_INTERVAL_MS` | No | `300000` | Periodic summary interval (5 min) |
| `APPROVAL_TIMEOUT_MS` | No | `300000` | Auto-deny timeout for approvals (5 min) |
| `AUTO_APPROVE` | No | `false` | Set to `true` to bypass all approval prompts |

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

1. **Fastify HTTP server** — Receives POST requests from Claude Code's hook system. Routes: `/hooks/session-start`, `/hooks/session-end`, `/hooks/post-tool-use`, `/hooks/notification`, `/hooks/pre-tool-use`.

2. **grammY Telegram bot** — Posts messages to forum topics, handles commands, button callbacks, and text input.

On startup, the bot auto-installs HTTP hooks into `~/.claude/settings.json`. These hooks tell Claude Code to POST events to the local Fastify server. The `PreToolUse` hook is blocking — Claude Code waits for the HTTP response before proceeding, which enables the approval flow.

### Approval Flow

When Claude Code encounters a tool call that needs permission (based on `permission_mode`), the `PreToolUse` hook fires and the HTTP connection stays open. The bot posts a message with Approve/Deny buttons. When you tap a button, the pending promise resolves and the HTTP response is sent back to Claude Code.

If `permission_mode` is `bypassPermissions` or `dontAsk`, or `AUTO_APPROVE=true`, the hook returns immediately without prompting.

Risk indicators on approval messages:
- **Safe** — Read, Glob, Grep, and other read-only tools
- **Caution** — Write, Edit, MultiEdit, NotebookEdit
- **Danger** — Bash, BashBackground

### Text Input

When you send a text message in a session topic, the bot injects it into Claude Code's terminal via tmux bracketed paste. This requires Claude Code to be running inside a tmux session. A `SessionStart` command hook captures the tmux pane ID automatically.

If tmux is not available, the input is queued and a notice is shown.

### Session Persistence

Session state is persisted to `DATA_DIR/sessions.json` using atomic writes. On restart, the bot reconnects to any sessions that were still active, sending a "Reconnected" notice to their topics.

## Running with tmux (Recommended)

For full text input support, run Claude Code inside tmux:

```bash
tmux new-session -s claude
claude  # start Claude Code inside tmux
```

The bot's `SessionStart` hook automatically captures the tmux pane ID. Text replies in Telegram will then be injected directly into the Claude Code terminal.

## Running as a Service

To keep the bot running in the background:

```bash
# Using tmux
tmux new-session -d -s telegram-bot 'cd /path/to/claude-o-gram && npm start'

# Or using systemd (create a service file)
# Or using pm2
pm2 start dist/index.js --name claude-telegram
```

## Development

```bash
# Watch mode for TypeScript compilation
npm run dev

# In another terminal, run the compiled output
npm start
```

## Architecture

```
src/
  index.ts              # Entry point — wires everything together
  config.ts             # Environment variable parsing and validation
  types/
    config.ts           # AppConfig interface
    hooks.ts            # Hook payload types
    sessions.ts         # SessionInfo interface
    monitoring.ts       # Monitoring types (verbosity, status, transcript)
  sessions/
    session-store.ts    # In-memory session map with JSON persistence
  hooks/
    server.ts           # Fastify HTTP server with hook routes
    handlers.ts         # Hook event handlers with callback delegation
  bot/
    bot.ts              # grammY bot setup, commands, callback handlers
    topics.ts           # Forum topic lifecycle (create/close/reopen/rename)
    formatter.ts        # HTML message formatting for all event types
    rate-limiter.ts     # Per-session message batching (2s debounce)
  monitoring/
    verbosity.ts        # Tool call filtering by verbosity tier
    transcript-watcher.ts  # JSONL transcript tailing with fs.watch
    status-message.ts   # Pinned status message with debounced updates
    summary-timer.ts    # Periodic activity summary generation
  control/
    approval-manager.ts # Deferred promise pattern for tool approval
    input-manager.ts    # tmux text injection with queue fallback
  utils/
    text.ts             # HTML escaping, truncation, message splitting
    install-hooks.ts    # Auto-install hooks into ~/.claude/settings.json
```

## License

MIT
