# Claude Code Telegram Bridge

## What This Is

A per-machine Telegram bot that bridges Claude Code sessions to a shared Telegram group, giving you full remote visibility and bidirectional control over Claude Code from any device. Each machine runs its own bot (appearing as a separate group member), and each active Claude Code session gets its own topic thread in the group. Text input from Telegram is delivered to Claude Code via the Agent SDK for reliable, cross-platform delivery.

## Core Value

See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## Current State: v2.0 Shipped

Shipped v2.0 SDK Input Migration on 2026-03-01. Replaced tmux text injection with Claude Agent SDK `query({ resume })` for cross-platform input delivery, then removed all tmux code from the codebase.

**Tech stack:** TypeScript, grammY, Fastify, @anthropic-ai/claude-agent-sdk
**Codebase:** ~3,500 LOC TypeScript
**Architecture:** HTTP hook server + transcript watcher + SDK resume input

## Requirements

### Validated

- ✓ Each machine runs a local Telegram bot that auto-registers in a shared group — v1.0
- ✓ Each active Claude Code session gets a dedicated Telegram topic, auto-created on session start — v1.0
- ✓ Topics are closed/archived when the Claude Code session ends — v1.0
- ✓ Tool calls (file reads, edits, bash commands) are posted to the session's topic as they happen — v1.0
- ✓ Claude's text output is captured and posted to the topic — v1.0
- ✓ Periodic summary updates posted to the topic — v1.0
- ✓ Permission questions posted to Telegram with inline Approve/Deny buttons — v1.0
- ✓ User can reply with custom text input from Telegram that feeds back into Claude Code — v1.0
- ✓ Each machine's bot appears as a distinct member in the Telegram group — v1.0
- ✓ Bot auto-discovers and tracks new Claude Code sessions starting on the machine — v1.0
- ✓ Text input delivered via SDK query({ resume }) instead of tmux injection — v2.0
- ✓ SDK input works cross-platform (no tmux dependency) — v2.0
- ✓ Quoted message context included when replying to specific bot messages — v2.0
- ✓ Reliable text submission with message reaction confirmation — v2.0
- ✓ All tmux code removed (hook installer, TextInputManager, tmuxPane field) — v2.0

### Active

(None — next milestone not started)

### Out of Scope

- Starting new Claude Code sessions from Telegram — deferred to v2.1
- Central server or serverless architecture — each machine runs its own bot directly
- Multi-machine dashboard — deferred to v2.1
- Subagent tracking — deferred to v2.1
- Multi-user access control — single-user system, the bot owner controls everything
- Full SDK session management (bot-controlled sessions) — deferred to v2.1
- Removing Fastify hook server — still needed for session discovery and tool call events
- Removing transcript watcher — still needed for Claude text output capture
- SDK streaming output — deferred to v2.1
- SDK canUseTool callback — deferred to v2.1

## Context

- Claude Code has a hook system (PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit) that fires shell commands on events
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides streaming input/output, native tool approval via `canUseTool`, and session management
- v2.0 uses SDK `query({ resume })` for text input — one-shot per message, per-session serialized, 5-min timeout
- v2.0 keeps HTTP hook server (Fastify) for session discovery and tool call events
- v2.0 keeps JSONL transcript file watching for Claude's text output capture
- Telegram supergroups support "Topics" (forum mode) which map perfectly to per-session threads
- Target scale is 2-3 machines, each potentially running multiple concurrent Claude Code sessions
- Known SDK limitation: double-turn bug (#207) prevents streaming input mode, one-shot+resume is the workaround

## Constraints

- **Agent SDK**: Must use `@anthropic-ai/claude-agent-sdk` V1 API — V2 preview is unstable (#176)
- **Telegram API**: Must respect Telegram's rate limits (especially for streaming tool calls and text output)
- **Bot per machine**: Architecture is decentralized — no shared state between machines beyond the Telegram group itself
- **Backward compatibility**: All existing Telegram UX must be preserved (topics, formatting, reactions, verbosity)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| One bot per machine (not centralized) | Simpler deployment, no server infra, each machine is self-contained | ✓ Good |
| Hooks for output, log parsing for text | Hooks capture structured events; log parsing fills gaps for text output | ⚠️ Revisit — SDK could replace both in v2.1 |
| PreToolUse blocking for approvals | Only reliable way to inject decisions without wrappers or pipe mode | ⚠️ Revisit — SDK provides canUseTool in v2.1 |
| Telegram Topics for sessions | Natural mapping — each session is an isolated conversation thread | ✓ Good |
| Separate BotFather tokens per machine | Each bot appears as a distinct group member, natural identity per machine | ✓ Good |
| SDK query({ resume }) for text input (v2.0) | Official cross-platform API; eliminates tmux dependency for input delivery | ✓ Good |
| One-shot+resume (not streaming input) (v2.0) | Double-turn bug #207 doubles token costs with streaming input | ✓ Good — workaround endorsed by Anthropic |
| Keep hook server + transcript watcher (v2.0) | Only replace tmux injection in v2.0, keep working output infrastructure | ✓ Good — incremental migration reduces risk |

---
*Last updated: 2026-03-01 after v2.0 milestone completion*
