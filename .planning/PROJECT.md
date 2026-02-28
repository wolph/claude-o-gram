# Claude Code Telegram Bridge

## What This Is

A per-machine Telegram bot that bridges Claude Code sessions to a shared Telegram group, giving you full remote visibility and bidirectional control over Claude Code from any device. Each machine runs its own bot (appearing as a separate group member), and each active Claude Code session gets its own topic thread in the group.

## Core Value

See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Each machine runs a local Telegram bot that auto-registers in a shared group
- [ ] Each active Claude Code session gets a dedicated Telegram topic, auto-created on session start
- [ ] Topics are closed/archived when the Claude Code session ends
- [ ] Tool calls (file reads, edits, bash commands) are posted to the session's topic as they happen
- [ ] Claude's text output is captured by parsing Claude Code's conversation log files and posted to the topic
- [ ] Periodic summary updates posted to the topic (e.g., "Working on task X, 3 files edited")
- [ ] PreToolUse hook blocks and posts permission questions to Telegram with inline Approve/Deny buttons
- [ ] User can reply with custom text input from Telegram that feeds back into Claude Code
- [ ] Each machine's bot appears as a distinct member in the Telegram group (separate BotFather tokens)
- [ ] Bot auto-discovers and tracks new Claude Code sessions starting on the machine

### Out of Scope

- Starting new Claude Code sessions from Telegram — monitor/control only
- Central server or serverless architecture — each machine runs its own bot directly
- Claude Code's Remote Control feature (tied to claude.ai/code Max plans, not programmatic)
- Mobile app — Telegram IS the mobile interface
- Multi-user access control — single-user system, the bot owner controls everything

## Context

- Claude Code has a hook system (PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit) that fires shell commands on events
- PreToolUse hooks can block execution and return approve/deny decisions — this is the input channel
- Claude Code stores conversation logs locally that can be parsed for text output
- Telegram supergroups support "Topics" (forum mode) which map perfectly to per-session threads
- Each machine needs its own bot token registered via BotFather, all bots added to the same group
- Target scale is 2-3 machines, each potentially running multiple concurrent Claude Code sessions

## Constraints

- **Hook system**: Must work within Claude Code's hook architecture — no wrappers, no pipe mode, no pty injection
- **Telegram API**: Must respect Telegram's rate limits (especially for streaming tool calls and text output)
- **Bot per machine**: Architecture is decentralized — no shared state between machines beyond the Telegram group itself
- **Blocking hooks**: PreToolUse hooks block Claude Code execution while waiting for Telegram response — need timeout handling

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| One bot per machine (not centralized) | Simpler deployment, no server infra, each machine is self-contained | — Pending |
| Hooks for output, log parsing for text | Hooks capture structured events; log parsing fills gaps for text output | — Pending |
| PreToolUse blocking for input | Only reliable way to inject decisions without wrappers or pipe mode | — Pending |
| Telegram Topics for sessions | Natural mapping — each session is an isolated conversation thread | — Pending |
| Separate BotFather tokens per machine | Each bot appears as a distinct group member, natural identity per machine | — Pending |

---
*Last updated: 2026-02-28 after initialization*
