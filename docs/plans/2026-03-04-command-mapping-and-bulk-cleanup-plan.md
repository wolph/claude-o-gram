# Command Mapping Fix + Bulk Button Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix plugin command namespace mapping so Telegram commands correctly forward to Claude Code, and add a bulk cleanup mechanism for orphaned approval buttons.

**Architecture:** Fix `scanPluginCommands()` to extract the plugin short name and pass it as a namespace to `scanCommandDir()`. Add a "Clean old buttons" button to the settings topic that brute-forces `editMessageReplyMarkup` on a range of message IDs near known anchors.

**Tech Stack:** TypeScript, grammY Bot API (`editMessageReplyMarkup`), Telegram Bot API

---

### Task 1: Fix plugin command namespace in CommandRegistry

**Files:**
- Modify: `src/bot/command-registry.ts`

**Step 1: Modify `scanCommandDir` to accept an optional namespace**

Currently `scanCommandDir(dir, source)` registers top-level `.md` files using just the filename. Add a third optional `namespace` parameter. When provided, top-level command files get prefixed.

In `src/bot/command-registry.ts`, change the method signature at line 119 from:

```typescript
private scanCommandDir(dir: string, source: string): void {
```

to:

```typescript
private scanCommandDir(dir: string, source: string, namespace?: string): void {
```

Then change the top-level file handling block (lines 141-147). Currently:

```typescript
} else if (entry.isFile() && entry.name.endsWith('.md')) {
  // Top-level command
  const cmdName = basename(entry.name, '.md');
  const desc = this.extractFrontmatter(join(dir, entry.name)) || cmdName;
  this.addEntry(cmdName, cmdName, desc, source);
}
```

Change to:

```typescript
} else if (entry.isFile() && entry.name.endsWith('.md')) {
  // Top-level command
  const cmdName = basename(entry.name, '.md');
  const claudeName = namespace ? `${namespace}:${cmdName}` : cmdName;
  const desc = this.extractFrontmatter(join(dir, entry.name)) || claudeName;
  this.addEntry(claudeName, claudeName, desc, source);
}
```

This ensures that when a namespace is provided (plugin context), the `claudeName` becomes `superpowers:brainstorm` instead of just `brainstorm`. The `addEntry` method calls `toTelegramName()` which converts `:` to `_`, producing `superpowers_brainstorm` for Telegram.

**Step 2: Modify `scanPluginCommands` to extract and pass the plugin short name**

In `scanPluginCommands()` (line 151), modify the loop body. Currently at lines 170-176:

```typescript
for (const pluginId of enabledPlugins) {
  const versions = plugins[pluginId];
  if (!versions || versions.length === 0) continue;
  const latest = versions[versions.length - 1];
  const commandsDir = join(latest.installPath, 'commands');
  this.scanCommandDir(commandsDir, 'plugin');
}
```

Change to:

```typescript
for (const pluginId of enabledPlugins) {
  const versions = plugins[pluginId];
  if (!versions || versions.length === 0) continue;
  const latest = versions[versions.length - 1];
  const commandsDir = join(latest.installPath, 'commands');
  // Extract short plugin name: "superpowers@claude-plugins-official" → "superpowers"
  const pluginName = pluginId.split('@')[0];
  this.scanCommandDir(commandsDir, 'plugin', pluginName);
}
```

**Step 3: Also handle namespace for subdirectory commands in plugins**

In `scanCommandDir`, the subdirectory handling (lines 122-139) already creates `claudeName = \`${namespace}:${cmdName}\`` using the subdirectory name as namespace. But for plugins, we want the plugin name as the prefix, not the subdirectory name. Currently:

```typescript
if (entry.isDirectory()) {
  const namespace = entry.name;
  // ...
  const claudeName = `${namespace}:${cmdName}`;
```

This creates a conflict: the local variable `namespace` shadows the parameter. Rename the local variable:

```typescript
if (entry.isDirectory()) {
  const subNamespace = entry.name;
  const subdir = join(dir, subNamespace);
  // ...
  for (const sub of subEntries) {
    if (sub.isFile() && sub.name.endsWith('.md')) {
      const cmdName = basename(sub.name, '.md');
      const prefix = namespace || subNamespace;
      const claudeName = `${prefix}:${cmdName}`;
      const desc = this.extractFrontmatter(join(subdir, sub.name)) || claudeName;
      this.addEntry(claudeName, claudeName, desc, source);
    }
  }
}
```

If a plugin namespace is provided, subdirectory commands get the plugin prefix. If no namespace (user commands), subdirectory name is used as before.

**Step 4: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Verify command mapping is correct**

Run:
```bash
node -e "
const { CommandRegistry } = require('./dist/bot/command-registry.js');
const r = new CommandRegistry();
r.discover();
for (const e of r.getEntries().filter(e => e.source === 'plugin')) {
  console.log('TG: /' + e.telegramName + '  ->  Claude: /' + e.claudeName);
}
"
```

Expected output should show namespaced commands:
```
TG: /superpowers_brainstorm  ->  Claude: /superpowers:brainstorm
TG: /commit_commands_commit  ->  Claude: /commit-commands:commit
```

**Step 6: Commit**

```bash
git add src/bot/command-registry.ts
git commit -m "fix: namespace plugin commands with plugin name prefix"
```

---

### Task 2: Add "Clean old buttons" to settings topic

**Files:**
- Modify: `src/settings/settings-topic.ts`
- Modify: `src/bot/bot.ts`
- Modify: `src/index.ts`

**Step 1: Add the button to the settings keyboard**

In `src/settings/settings-topic.ts`, modify `buildSettingsKeyboard()` (line 34). After the inactive topics button block (lines 53-57), add a new row for the cleanup button:

```typescript
// Bulk cleanup button for orphaned approval buttons
kb.row();
kb.text('\u{1F9F9} Clean old approval buttons', 'set_rm:buttons');
```

This goes right before the `return kb;` at line 58.

**Step 2: Add the callback handler in bot.ts**

In `src/bot/bot.ts`, after the existing `set_rm:inactive` callback handler (around line 328), add:

```typescript
// Bulk cleanup: remove orphaned approval buttons by brute-force ID range
bot.callbackQuery('set_rm:buttons', async (ctx) => {
  if (!isSettingsAuthorized(ctx)) {
    await ctx.answerCallbackQuery({
      text: 'Only the bot owner can change settings',
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Cleaning old buttons... this may take a minute.' });
  const cleaned = await onCleanupOldButtons?.() ?? 0;
  console.log(`[SETTINGS] Cleaned ${cleaned} old approval button(s)`);
  // No need to refresh settings — nothing changed
});
```

**Step 3: Add the `onCleanupOldButtons` parameter to `createBot`**

In the `createBot` function signature (line 30), add a new optional parameter after `refreshSettings`:

```typescript
export async function createBot(
  config: AppConfig,
  sessionStore: SessionStore,
  approvalManager: ApprovalManager,
  inputRouter: InputRouter,
  commandRegistry: CommandRegistry,
  _permissionModeManager: PermissionModeManager,
  runtimeSettings: RuntimeSettings,
  onCleanupInactiveTopics?: () => Promise<number>,
  refreshSettings?: () => void,
  onCleanupOldButtons?: () => Promise<number>,
): Promise<Bot<BotContext>> {
```

**Step 4: Wire the cleanup callback in index.ts**

In `src/index.ts`, create the callback function before the `createBot` call. Add it after the `refreshSettings` lambda (around line 150):

```typescript
const onCleanupOldButtons = async (): Promise<number> => {
  // Collect known message ID anchors from all sessions
  const allSessions = sessionStore.getAllSessions();
  const anchors = new Set<number>();
  for (const s of allSessions) {
    if (s.statusMessageId > 0) {
      anchors.add(s.statusMessageId);
    }
  }

  if (anchors.size === 0) {
    console.log('[CLEANUP] No message ID anchors found');
    return 0;
  }

  let cleaned = 0;
  for (const anchor of anchors) {
    // Try message IDs in a range below the anchor
    const start = Math.max(1, anchor - 500);
    for (let msgId = anchor; msgId >= start; msgId--) {
      try {
        await bot.api.editMessageReplyMarkup(
          config.telegramChatId,
          msgId,
          { reply_markup: { inline_keyboard: [] } },
        );
        cleaned++;
      } catch {
        // Ignore: wrong message, not ours, already edited, etc.
      }
      // Rate limit: 50ms between calls
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  console.log(`[CLEANUP] Removed keyboards from ${cleaned} message(s)`);
  return cleaned;
};
```

Then pass it to `createBot` as the last argument. The current call (around line 152) is:

```typescript
const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry, permissionModeManager, runtimeSettings, onCleanupInactiveTopics, refreshSettings);
```

Change to:

```typescript
const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry, permissionModeManager, runtimeSettings, onCleanupInactiveTopics, refreshSettings, onCleanupOldButtons);
```

**Step 5: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add src/settings/settings-topic.ts src/bot/bot.ts src/index.ts
git commit -m "feat: add bulk cleanup for orphaned approval buttons"
```

---

### Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Fix plugin command namespace mapping | `src/bot/command-registry.ts` |
| 2 | Add bulk button cleanup to settings | `src/settings/settings-topic.ts`, `src/bot/bot.ts`, `src/index.ts` |
