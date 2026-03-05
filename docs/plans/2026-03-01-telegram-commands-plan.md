# Telegram Commands Auto-Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-detect all Claude Code commands and register them in Telegram's autocomplete menu, forwarding non-bot-native commands to the CLI via tmux.

**Architecture:** A `CommandRegistry` class scans `~/.claude/commands/`, enabled plugin command dirs, and a hardcoded built-in list to build a bidirectional name map (Telegram-safe `[a-z0-9_]` ↔ Claude original). It registers via `setMyCommands` on startup and provides `toClaudeName()` for reverse-mapping when commands arrive. A catch-all handler in `bot.ts` forwards unrecognized commands to the CLI session via `inputRouter.send()`.

**Tech Stack:** TypeScript, grammY (Telegram Bot API), Node.js `fs`, YAML frontmatter parsing (regex, no deps).

---

### Task 1: Create CommandRegistry — discovery and name mapping

**Files:**
- Create: `src/bot/command-registry.ts`

**Step 1: Create the CommandRegistry class with discovery logic**

```typescript
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/** A discovered command with Telegram-safe name and description */
export interface CommandEntry {
  /** Telegram-compatible name (lowercase, [a-z0-9_], max 32 chars) */
  telegramName: string;
  /** Original Claude Code command string (e.g., "gsd:progress") */
  claudeName: string;
  /** Short description for Telegram autocomplete (max 256 chars) */
  description: string;
  /** Source: 'builtin' | 'user' | 'plugin' */
  source: string;
}

/** Bot-native commands that are never forwarded to CLI */
const BOT_NATIVE_COMMANDS = new Set(['status', 'verbose', 'normal', 'quiet']);

/** Built-in Claude Code slash commands with descriptions */
const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'compact', description: 'Compact conversation to save context' },
  { name: 'config', description: 'View or modify configuration' },
  { name: 'cost', description: 'Show token usage and cost' },
  { name: 'diff', description: 'Show git diff of changes' },
  { name: 'doctor', description: 'Check Claude Code health' },
  { name: 'help', description: 'Show help information' },
  { name: 'init', description: 'Initialize CLAUDE.md in project' },
  { name: 'login', description: 'Log in to your account' },
  { name: 'logout', description: 'Log out of your account' },
  { name: 'memory', description: 'View or edit CLAUDE.md memory' },
  { name: 'model', description: 'Switch AI model' },
  { name: 'permissions', description: 'View or modify permissions' },
  { name: 'review', description: 'Review recent changes' },
  { name: 'terminal', description: 'Open terminal in working directory' },
  { name: 'think', description: 'Force extended thinking mode' },
  { name: 'tokens', description: 'Show token usage details' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'resume', description: 'Resume a previous session' },
  { name: 'fast', description: 'Toggle fast output mode' },
];

export class CommandRegistry {
  private entries: CommandEntry[] = [];
  /** Telegram name → Claude name for reverse lookup */
  private telegramToClaudeMap = new Map<string, string>();

  /** Discover all commands and build the registry */
  discover(): void {
    this.entries = [];
    this.telegramToClaudeMap.clear();

    // 1. Built-in commands
    for (const cmd of BUILTIN_COMMANDS) {
      this.addEntry(cmd.name, cmd.name, cmd.description, 'builtin');
    }

    // 2. User commands from ~/.claude/commands/
    const userCommandsDir = join(homedir(), '.claude', 'commands');
    this.scanCommandDir(userCommandsDir, 'user');

    // 3. Plugin commands from enabled plugins
    this.scanPluginCommands();
  }

  /** Get all registered command entries */
  getEntries(): CommandEntry[] {
    return this.entries;
  }

  /** Convert a Telegram command name back to Claude format. Returns null if not found. */
  toClaudeName(telegramName: string): string | null {
    return this.telegramToClaudeMap.get(telegramName) ?? null;
  }

  /** Check if a command is bot-native (handled by grammY, not forwarded) */
  isBotNative(name: string): boolean {
    return BOT_NATIVE_COMMANDS.has(name);
  }

  /** Convert a Claude command name to Telegram-safe format */
  private toTelegramName(claudeName: string): string {
    return claudeName
      .toLowerCase()
      .replace(/:/g, '_')
      .replace(/-/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 32);
  }

  /** Extract description from YAML frontmatter in a .md file */
  private extractFrontmatter(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return null;
      const yaml = match[1];
      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      return descMatch ? descMatch[1].trim().slice(0, 256) : null;
    } catch {
      return null;
    }
  }

  /** Add a command entry, skipping bot-native commands and duplicates */
  private addEntry(claudeName: string, telegramName: string, description: string, source: string): void {
    const tgName = this.toTelegramName(telegramName);
    if (BOT_NATIVE_COMMANDS.has(tgName)) return;
    if (this.telegramToClaudeMap.has(tgName)) return; // first-registered wins

    const entry: CommandEntry = { telegramName: tgName, claudeName, description, source };
    this.entries.push(entry);
    this.telegramToClaudeMap.set(tgName, claudeName);
  }

  /** Scan a directory for command .md files. Subdirectories become namespaces. */
  private scanCommandDir(dir: string, source: string): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Namespace directory (e.g., gsd/)
        const namespace = entry.name;
        const subdir = join(dir, namespace);
        for (const sub of readdirSync(subdir, { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.md')) {
            const cmdName = basename(sub.name, '.md');
            const claudeName = `${namespace}:${cmdName}`;
            const desc = this.extractFrontmatter(join(subdir, sub.name)) || claudeName;
            this.addEntry(claudeName, claudeName, desc, source);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Top-level command
        const cmdName = basename(entry.name, '.md');
        const desc = this.extractFrontmatter(join(dir, entry.name)) || cmdName;
        this.addEntry(cmdName, cmdName, desc, source);
      }
    }
  }

  /** Scan enabled plugin command directories */
  private scanPluginCommands(): void {
    const pluginsFile = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const settingsFile = join(homedir(), '.claude', 'settings.json');

    if (!existsSync(pluginsFile) || !existsSync(settingsFile)) return;

    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      const enabledPlugins: string[] = settings.enabledPlugins || [];

      const installed = JSON.parse(readFileSync(pluginsFile, 'utf-8'));
      const plugins: Record<string, Array<{ installPath: string }>> = installed.plugins || {};

      for (const pluginId of enabledPlugins) {
        const versions = plugins[pluginId];
        if (!versions || versions.length === 0) continue;
        const latest = versions[versions.length - 1];
        const commandsDir = join(latest.installPath, 'commands');
        this.scanCommandDir(commandsDir, 'plugin');
      }
    } catch (err) {
      console.warn('Failed to scan plugin commands:', err instanceof Error ? err.message : err);
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /home/cryptobot/workspace/claude-o-gram && npx tsc --noEmit src/bot/command-registry.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/bot/command-registry.ts
git commit -m "feat: add CommandRegistry for auto-detecting Claude Code commands"
```

---

### Task 2: Register commands with Telegram on bot startup

**Files:**
- Modify: `src/index.ts:85-88` (after InputRouter creation, before bot.start)

**Step 1: Import and wire CommandRegistry in index.ts**

Add import at top of `src/index.ts`:
```typescript
import { CommandRegistry } from './bot/command-registry.js';
```

After `const inputRouter = new InputRouter();` (line 85), add:
```typescript
  // 4b. Discover Claude Code commands for Telegram autocomplete
  const commandRegistry = new CommandRegistry();
  commandRegistry.discover();
  console.log(`Discovered ${commandRegistry.getEntries().length} Claude Code commands`);
```

Pass `commandRegistry` to `createBot`:
```typescript
  const bot = await createBot(config, sessionStore, approvalManager, inputRouter, commandRegistry);
```

After `bot.start();` (line 410), add Telegram command registration:
```typescript
  // 12b. Register discovered commands with Telegram autocomplete menu
  const botCommands = commandRegistry.getEntries().map((e) => ({
    command: e.telegramName,
    description: e.description.slice(0, 256),
  }));
  if (botCommands.length > 0 && botCommands.length <= 100) {
    try {
      await bot.api.setMyCommands(botCommands, {
        scope: { type: 'chat', chat_id: config.telegramChatId },
      });
      console.log(`Registered ${botCommands.length} commands with Telegram`);
    } catch (err) {
      console.warn('Failed to register Telegram commands:', err instanceof Error ? err.message : err);
    }
  }
```

**Step 2: Verify compilation**

Run: `cd /home/cryptobot/workspace/claude-o-gram && npx tsc --noEmit`
Expected: No errors (will fail until Task 3 updates `createBot` signature)

**Step 3: Commit** (combine with Task 3)

---

### Task 3: Add catch-all command handler and remove slash-skip

**Files:**
- Modify: `src/bot/bot.ts:27-32` (createBot signature)
- Modify: `src/bot/bot.ts:175-212` (text handler section)

**Step 1: Update createBot signature to accept CommandRegistry**

Add import:
```typescript
import type { CommandRegistry } from './command-registry.js';
```

Update function signature (line 27-32):
```typescript
export async function createBot(
  config: AppConfig,
  sessionStore: SessionStore,
  approvalManager: ApprovalManager,
  inputRouter: InputRouter,
  commandRegistry: CommandRegistry,
): Promise<Bot<BotContext>> {
```

**Step 2: Add catch-all command handler before the text handler**

Insert before the `bot.on('message:text')` handler (before line 179). This catches any `/command` that isn't handled by the specific `bot.command()` handlers above:

```typescript
  // --- CLI command forwarding (catch-all for non-bot-native commands) ---
  // Must be registered AFTER bot-native command handlers (/status, /verbose, etc.)
  // grammY processes handlers in registration order; bot.command() handlers above
  // will match first for bot-native commands.
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text.startsWith('/')) return next(); // Not a command, pass to text handler

    const threadId = ctx.message.message_thread_id;
    if (!threadId) return; // Not in a forum topic

    const session = sessionStore.getByThreadId(threadId);
    if (!session || session.status !== 'active') return;

    // Parse command: "/gsd_progress args" → command="gsd_progress", args="args"
    const match = text.match(/^\/([a-z0-9_]+)(?:\s+(.*))?$/i);
    if (!match) return;

    const [, tgCommand, args] = match;

    // Skip bot-native commands (already handled by bot.command() above)
    if (commandRegistry.isBotNative(tgCommand)) return;

    // Reverse-map to Claude name
    const claudeName = commandRegistry.toClaudeName(tgCommand);
    const cliCommand = claudeName
      ? `/${claudeName}${args ? ' ' + args : ''}`
      : `/${tgCommand}${args ? ' ' + args : ''}`;

    const result = await inputRouter.send(session.sessionId, cliCommand);

    if (result.status === 'sent') {
      try {
        await ctx.react('\u26A1');
      } catch {
        // Reaction not supported
      }
    } else {
      await ctx.reply(
        `\u274C Failed to send command: ${result.error}`,
        { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
      );
    }
  });
```

**Step 3: Remove the slash-skip from the text handler**

In the existing `bot.on('message:text')` handler (around line 189), remove:
```typescript
    // Skip bot commands (handled by command handlers above)
    if (ctx.message.text.startsWith('/')) return;
```

This line is no longer needed because:
- Bot-native commands are caught by `bot.command()` handlers (registered first)
- CLI commands are caught by the catch-all handler above
- The text handler only needs to handle non-command text

**Step 4: Verify compilation**

Run: `cd /home/cryptobot/workspace/claude-o-gram && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/bot/bot.ts src/bot/command-registry.ts src/index.ts
git commit -m "feat: forward CLI commands from Telegram and register autocomplete menu"
```

---

### Task 4: Build and test

**Step 1: Build the project**

Run: `cd /home/cryptobot/workspace/claude-o-gram && npm run build`
Expected: Clean compilation, no errors

**Step 2: Verify command discovery works**

Create a quick smoke test by adding a temporary log. Or just restart the bot and check console output for `Discovered N Claude Code commands` and `Registered N commands with Telegram`.

**Step 3: Restart the bot and verify in Telegram**

1. Kill the old bot process
2. Start the new bot: `node dist/index.js`
3. In the Telegram group, type `/` — the autocomplete menu should appear with all discovered commands
4. Try a CLI command like `/compact` in a session topic — should show lightning reaction and forward to Claude
5. Try a namespaced command like `/gsd_help` — should forward as `/gsd:help` to Claude

**Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during testing"
```
