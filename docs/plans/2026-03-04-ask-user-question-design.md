# AskUserQuestion Telegram Forwarding Design

**Date**: 2026-03-04
**Status**: Approved

## Problem

Claude Code does not fire any hook event when AskUserQuestion is used. This is a known upstream gap (GitHub issues #13830, #15872, #12605). The `elicitation_dialog` notification type is for MCP elicitations only, not AskUserQuestion. As a result, when Claude asks the user a multiple-choice question, nothing appears in Telegram — the user must answer in the local terminal.

## Solution

Detect AskUserQuestion tool_use blocks in the transcript JSONL file (which the TranscriptWatcher already monitors) and forward them to Telegram as interactive inline keyboard prompts. Tapping an option in Telegram sends a keystroke via tmux to select it.

## Design

### 1. Detection in TranscriptWatcher

- Add optional `onAskUserQuestion` callback to TranscriptWatcher constructor.
- In `processEntry()`, after existing text/usage extraction, iterate content blocks for `tool_use` with `name === 'AskUserQuestion'`.
- Emit callback with `tool_use_id` and parsed question data.
- Detect in both main-chain and sidechain entries.

### 2. Telegram UI — Formatting and Buttons

**Message format:**
```
❓ Input Needed — Header text

What's the next thing you want to tackle?

[Option 1] [Option 2]
[Option 3] [Other →]
```

- Header and question text displayed as HTML.
- Each predefined option (2-4) becomes an inline keyboard button.
- An "Other →" button shows a toast: "Type your answer in the terminal."
- Callback data: `ask:<toolUseId_first8>:<option_index>` (64-byte limit).

**Button click:**
- Sends the option number key (1-4) via tmux to the session.
- Edits message: removes buttons, shows which option was selected.
- "Other →" shows toast only, no keystroke.

### 3. Duplicate Detection

- Track seen `tool_use_id`s per session to avoid posting the same question twice.
- Clean up on session end.

### 4. Resolution on Button Click

- When a Telegram button is tapped, immediately edit the message (remove buttons, show selection).
- If the user answers in terminal instead, buttons persist until session end — acceptable.

## Files to Modify

| File | Changes |
|------|---------|
| `src/monitoring/transcript-watcher.ts` | Add `onAskUserQuestion` callback, detect in `processEntry()` |
| `src/types/monitoring.ts` | Add `AskUserQuestionData` type |
| `src/bot/formatter.ts` | Add `formatAskUserQuestion()` |
| `src/bot/bot.ts` | Add `ask:` callback query handler |
| `src/index.ts` | Wire `onAskUserQuestion` callback in `initMonitoring()`, track seen IDs |
