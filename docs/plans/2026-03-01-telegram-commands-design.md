# Telegram Commands Auto-Detection Design

**Date**: 2026-03-01
**Status**: Approved

## Problem

Claude Code has ~77 slash commands (built-in + user + plugin) that are invisible in Telegram. Users must know command names by heart. Telegram's autocomplete menu (`setMyCommands`) can surface these commands, and the bot can forward them to the CLI session.

## Architecture

New `src/bot/command-registry.ts` module:
1. Scans filesystem for all Claude Code commands on bot startup
2. Maps names to Telegram-compatible format (`gsd:progress` → `gsd_progress`)
3. Registers via `bot.api.setMyCommands()` scoped to the group chat
4. Provides reverse-mapping for routing received commands back to CLI format

## Command Discovery Sources

| Source | Location | Namespace |
|--------|----------|-----------|
| Built-in | Hardcoded list | none |
| User commands | `~/.claude/commands/**/*.md` | directory name (e.g., `gsd`) |
| Plugin commands | `~/.claude/plugins/cache/*/commands/*.md` | plugin name |

YAML frontmatter in `.md` files provides `name` and `description`.

## Name Mapping

Telegram commands: `[a-z0-9_]`, max 32 chars.

| Claude format | Telegram format | Reverse |
|---------------|----------------|---------|
| `gsd:progress` | `gsd_progress` | first `_` → `:` when namespace known |
| `release-notes` | `release_notes` | lookup from registry map |
| `commit` | `commit` | unchanged |

A bidirectional map (telegram name ↔ claude name) handles conversion.

## Routing

```
/command received in Telegram topic
  ├── Bot-native? (/status, /verbose, /normal, /quiet)
  │     └── Handle locally (existing grammY handlers)
  └── CLI command (everything else)
        └── Reverse-map name → Claude format
        └── Forward "/{claude_command} {args}" via inputRouter.send()
```

## Registration

- **When**: Bot startup, after command discovery
- **Scope**: `BotCommandScopeChat` for `config.telegramChatId` only
- **Limit**: Telegram allows max 100 commands; current count ~77
- **Descriptions**: Truncated to 256 chars from YAML frontmatter

## Bot-Native Commands (Priority Override)

These 4 commands are always handled by the bot, never forwarded:
- `/status` — bot uptime and session count
- `/verbose` — set session verbosity to verbose
- `/normal` — set session verbosity to normal
- `/quiet` — set session verbosity to minimal

## Session Targeting

Commands sent in a forum topic are routed to the session mapped to that topic's `threadId` (same as text input routing). Commands outside a topic are ignored for CLI forwarding.

## Files to Create/Modify

- **Create**: `src/bot/command-registry.ts` — CommandRegistry class
- **Modify**: `src/bot/bot.ts` — add catch-all command handler for CLI forwarding, remove the `startsWith('/')` skip in text handler
- **Modify**: `src/index.ts` — wire CommandRegistry, call registration on startup
