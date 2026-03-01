# Claude Code Telegram Bridge

## What This Is

A per-machine Telegram bot that bridges Claude Code sessions to a shared Telegram group, giving you full remote visibility and bidirectional control over Claude Code from any device. Each machine runs its own bot (appearing as a separate group member), and each active Claude Code session gets its own topic thread in the group.

## Core Value

See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## Current Milestone: v2.0 SDK Migration

**Goal:** Replace the fragile tmux injection + HTTP hook server architecture with the Claude Agent SDK for reliable, cross-platform programmatic control.

**Target features:**
- Agent SDK streaming input replaces tmux text injection
- SDK event callbacks replace HTTP hook server
- SDK streaming output replaces JSONL transcript file watching
- SDK `canUseTool` callback replaces deferred-promise approval flow
- Bot manages Claude Code sessions directly (not attaching to externally-launched ones)
- Cross-platform support (no tmux dependency)

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

### Active

(Defined in REQUIREMENTS.md for v2.0)

### Out of Scope

- Starting new Claude Code sessions from Telegram — deferred to v2.1
- Central server or serverless architecture — each machine runs its own bot directly
- Multi-machine dashboard — deferred to v2.1
- Subagent tracking — deferred to v2.1
- Multi-user access control — single-user system, the bot owner controls everything

## Context

- Claude Code has a hook system (PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit) that fires shell commands on events
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides streaming input/output, native tool approval via `canUseTool`, and session management
- v1.0 used tmux `send-keys`/`paste-buffer` for text injection — fragile, Linux-only, fails with Ink's bracketed paste handling
- v1.0 used HTTP hook server (Fastify) receiving hook POST requests — functional but adds architectural complexity
- v1.0 used JSONL transcript file watching for Claude's text output — works but couples to internal file format
- Telegram supergroups support "Topics" (forum mode) which map perfectly to per-session threads
- Target scale is 2-3 machines, each potentially running multiple concurrent Claude Code sessions

## Constraints

- **Agent SDK**: Must use `@anthropic-ai/claude-agent-sdk` streaming API — the officially supported programmatic interface
- **Telegram API**: Must respect Telegram's rate limits (especially for streaming tool calls and text output)
- **Bot per machine**: Architecture is decentralized — no shared state between machines beyond the Telegram group itself
- **Backward compatibility**: All existing Telegram UX must be preserved (topics, formatting, reactions, verbosity)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| One bot per machine (not centralized) | Simpler deployment, no server infra, each machine is self-contained | ✓ Good |
| Hooks for output, log parsing for text (v1.0) | Hooks capture structured events; log parsing fills gaps for text output | ⚠️ Revisit — SDK replaces both |
| PreToolUse blocking for input (v1.0) | Only reliable way to inject decisions without wrappers or pipe mode | ⚠️ Revisit — SDK provides canUseTool |
| Telegram Topics for sessions | Natural mapping — each session is an isolated conversation thread | ✓ Good |
| Separate BotFather tokens per machine | Each bot appears as a distinct group member, natural identity per machine | ✓ Good |
| tmux text injection (v1.0) | No SDK available at time of v1.0 development | ⚠️ Revisit — fragile, SDK replaces |
| Migrate to Claude Agent SDK (v2.0) | Official cross-platform API; eliminates tmux dependency, HTTP server, transcript watching | — Pending |

---
*Last updated: 2026-03-01 after v2.0 milestone start*
