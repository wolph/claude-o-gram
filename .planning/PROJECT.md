# Claude Code Telegram Bridge

## What This Is

A per-machine Telegram bot that bridges Claude Code sessions to a shared Telegram group, giving you full remote visibility and bidirectional control over Claude Code from any device. Each machine runs its own bot (appearing as a separate group member), and each active Claude Code session gets its own topic thread in the group. Output is compact and terminal-faithful, permissions are controllable via tiered modes, and subagent activity is fully visible.

## Core Value

See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## Current State

**Shipped:** v3.0 UX Overhaul (2026-03-02)
**Tech stack:** TypeScript, grammY, Fastify, @anthropic-ai/claude-agent-sdk
**Codebase:** ~5,760 LOC TypeScript
**Architecture:** HTTP hook server + transcript watcher + SDK resume input + permission mode manager + subagent tracker

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
- ✓ Compact tool format with expand/collapse (250-char limit, LRU cache) — v3.0
- ✓ Terminal-fidelity output (no bot commentary, no emoji labels) — v3.0
- ✓ /clear reuses topic with separator, new pin, reset counters — v3.0
- ✓ Permission modes: Accept All, Same Tool, Safe Only, Until Done — v3.0
- ✓ No permission timeout (wait indefinitely for user decision) — v3.0
- ✓ Permissions visible locally via stdout with [PERM] prefix — v3.0
- ✓ Subagent visibility: spawn/done announcements, agent-prefixed output — v3.0

### Active

(None — ready for next milestone requirements)

### Out of Scope

- Starting new Claude Code sessions from Telegram — deferred
- Central server or serverless architecture — each machine runs its own bot directly
- Multi-machine dashboard — deferred
- Multi-user access control — single-user system, the bot owner controls everything
- Full SDK session management (bot-controlled sessions) — deferred
- Removing Fastify hook server — still needed for session discovery and tool call events
- Removing transcript watcher — still needed for Claude text output capture
- SDK streaming output — deferred (would replace hook server)
- SDK canUseTool callback — deferred (would replace PreToolUse blocking)

## Context

- Claude Code has a hook system (PreToolUse, PostToolUse, Notification, Stop, SubagentStart, SubagentStop, UserPromptSubmit) that fires shell commands on events
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) provides streaming input/output, native tool approval via `canUseTool`, and session management
- v2.0+ uses SDK `query({ resume })` for text input — one-shot per message, per-session serialized, 5-min timeout
- v3.0 added SubagentStart (command hook → shell script bridge → HTTP) and SubagentStop (HTTP hook) for agent lifecycle tracking
- v3.0 added PermissionModeManager with 5 modes and dangerous command blocklist
- Telegram supergroups support "Topics" (forum mode) which map perfectly to per-session threads
- Target scale is 2-3 machines, each potentially running multiple concurrent Claude Code sessions
- Known SDK limitation: double-turn bug (#207) prevents streaming input mode, one-shot+resume is the workaround
- Known limitation: PostToolUse hooks lack agent_id — subagent tool attribution uses temporal heuristic

## Constraints

- **Agent SDK**: Must use `@anthropic-ai/claude-agent-sdk` V1 API — V2 preview is unstable (#176)
- **Telegram API**: Must respect Telegram's rate limits (especially for streaming tool calls and text output)
- **Bot per machine**: Architecture is decentralized — no shared state between machines beyond the Telegram group itself

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| One bot per machine (not centralized) | Simpler deployment, no server infra, each machine is self-contained | ✓ Good |
| Hooks for output, log parsing for text | Hooks capture structured events; log parsing fills gaps for text output | ⚠️ Revisit — SDK could replace both |
| PreToolUse blocking for approvals | Only reliable way to inject decisions without wrappers or pipe mode | ⚠️ Revisit — SDK provides canUseTool |
| Telegram Topics for sessions | Natural mapping — each session is an isolated conversation thread | ✓ Good |
| Separate BotFather tokens per machine | Each bot appears as a distinct group member, natural identity per machine | ✓ Good |
| SDK query({ resume }) for text input (v2.0) | Official cross-platform API; eliminates tmux dependency for input delivery | ✓ Good |
| One-shot+resume (not streaming input) (v2.0) | Double-turn bug #207 doubles token costs with streaming input | ✓ Good — workaround endorsed by Anthropic |
| Keep hook server + transcript watcher (v2.0) | Only replace tmux injection in v2.0, keep working output infrastructure | ✓ Good — incremental migration reduces risk |
| Compact tool format with expand/collapse (v3.0) | Terminal-fidelity output, reduce noise, inline expand for long content | ✓ Good — clean UX confirmed by UAT |
| Permission modes with tiered auto-accept (v3.0) | Replace binary approve/deny with flexible acceptance modes | ✓ Good — eliminates button-tap fatigue |
| Full subagent visibility (v3.0) | Users need to see what subagents are doing, not just main chain | ✓ Good — agent-prefixed output works well |
| Shell script bridge for SubagentStart (v3.0) | Command hooks can't POST to HTTP directly; shell script reads stdin JSON and curls | ✓ Good — reliable bridging pattern |
| /clear via filesystem watcher (v3.0) | Upstream hook bug #6428 prevents SessionEnd from firing on /clear | ✓ Good — workaround confirmed working |

---
*Last updated: 2026-03-02 after v3.0 milestone completion*
