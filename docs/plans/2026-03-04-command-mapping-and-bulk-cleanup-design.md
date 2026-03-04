# Command Mapping Fix + Bulk Button Cleanup Design

**Date**: 2026-03-04
**Status**: Approved

## Problem 1: Command Mapping

Plugin commands are registered in Telegram without the plugin name prefix. For example, `superpowers/commands/brainstorm.md` gets registered as `/brainstorm` in Telegram and forwarded as `/brainstorm` to Claude Code, but Claude Code requires `/superpowers:brainstorm` (with plugin prefix). The command fails with "Unknown skill."

### Root Cause

`scanPluginCommands()` in `command-registry.ts` calls `scanCommandDir(commandsDir, 'plugin')` without passing the plugin name. The method uses the filename as the `claudeName`, missing the required `{plugin}:{command}` namespace.

### Solution

1. Extract short plugin name from plugin ID: `"superpowers@claude-plugins-official"` → `"superpowers"`
2. Add optional `namespace` parameter to `scanCommandDir()`
3. When namespace is provided, prefix top-level files: `brainstorm` → `superpowers:brainstorm`
4. `toTelegramName()` already converts `:` to `_`, so Telegram gets `superpowers_brainstorm`

### Files to Modify

| File | Changes |
|------|---------|
| `src/bot/command-registry.ts` | Add namespace param to `scanCommandDir()`, pass plugin name from `scanPluginCommands()` |

---

## Problem 2: Bulk Button Cleanup

Old Accept/Deny buttons from before the persistent ApprovalManager were never tracked. The startup cleanup only removes tracked entries. Hundreds of orphaned buttons remain in Telegram threads.

### Constraint

Telegram Bot API has no `getChatHistory` — we cannot list messages in a thread. The only way to find orphaned keyboards is by known message IDs.

### Solution

Add a "Clean old buttons" action in the settings topic.

**When triggered:**
1. Collect known message IDs from session store (status messages) as anchors
2. For each anchor, try `editMessageReplyMarkup({ inline_keyboard: [] })` on IDs from `anchor` down to `anchor - 500`
3. Use 50ms delay between calls to avoid rate limits
4. Ignore all errors (wrong message, not ours, already edited, etc.)
5. Report count of successfully cleaned messages

### Files to Modify

| File | Changes |
|------|---------|
| `src/settings/settings-topic.ts` | Add "Clean old buttons" button to settings UI |
| `src/bot/bot.ts` | Add `set_rm:buttons` callback handler |
| `src/index.ts` | Wire the cleanup callback |
