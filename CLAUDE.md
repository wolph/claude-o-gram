# Claude-o-Gram — Developer Guide

## Quick Reference

```bash
npm run dev          # Watch mode (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm test             # Vitest (all tests)
npm run test:watch   # Vitest in watch mode
```

## Architecture

Single-process daemon with two main components:

1. **Fastify HTTP server** (`src/hooks/server.ts`) — receives POST requests from Claude Code hooks. All routes require Bearer token auth except `/health`.
2. **grammY Telegram bot** (`src/bot/bot.ts`) — posts to forum topics, handles commands and callbacks. Global middleware restricts access to `BOT_OWNER_ID`.

### Source Layout

```
src/
  index.ts                  # Entry point, wiring
  config.ts                 # Env var parsing/validation
  types/                    # TypeScript interfaces
  hooks/
    server.ts               # Fastify routes + auth
    handlers.ts             # Hook event handlers
  bot/
    bot.ts                  # grammY bot, commands, callbacks
    topics.ts               # Forum topic lifecycle
    formatter.ts            # HTML message formatting
    rate-limiter.ts         # Per-session message batching
    command-registry.ts     # Claude Code command discovery
  input/
    input-router.ts         # Routes input to tmux/FIFO/SDK
    tmux-input.ts           # tmux send-keys
    fifo-input.ts           # Named pipe writes
    sdk-resume-input.ts     # Claude Agent SDK resume
  sessions/
    session-store.ts        # In-memory map + JSON persistence
  monitoring/               # Transcript watching, status, verbosity
  control/                  # Approval manager, permission modes
  settings/                 # Runtime settings, bot state
  utils/
    text.ts                 # HTML escaping, markdown conversion
    hook-secret.ts          # Bearer token generation/storage
    install-hooks.ts        # Auto-install hooks into Claude settings
```

### Key Patterns

- **Hook payloads** arrive via HTTP POST, are handled async (fire-and-forget for most, awaited for SessionStart/End)
- **Message batching** — tool calls within a 2-second window are combined into single Telegram messages
- **Session lifecycle** — SessionStart creates topics, SessionEnd closes them, resume/clear reuse existing topics
- **Input delivery** — detected per-session: tmux > FIFO > SDK-resume fallback

## Security Model

Two auth layers:
1. **Telegram side** — global middleware checks `ctx.from.id === config.botOwnerId` before processing any update
2. **Hook server side** — Bearer token in `Authorization` header, validated on all `/hooks/*` routes. Token auto-generated and stored at `~/.claude-o-gram/hook-secret`

## Conventions

- TypeScript strict mode, ESM modules
- No default exports
- Errors in hook handlers are caught and logged but never block Claude Code (always return 200)
- Atomic file writes via tmp+rename for persistence files
- HTML escaping via `escapeHtml()` for all user content in Telegram messages
