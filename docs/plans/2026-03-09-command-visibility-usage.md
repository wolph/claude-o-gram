# Command Visibility & Usage-Driven Defaults — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the namespace-only direct/submenu toggle with per-command three-state visibility (`direct | submenu | hidden`) seeded from `~/.claude/history.jsonl` usage counts, with a configurable cutoff and drill-down UI in `/commands`.

**Architecture:** Four sequential changes — (1) new history parser, (2) updated data store, (3) updated registration logic in index.ts, (4) updated bot UI. Each change is independently compilable and tested before the next.

**Tech Stack:** TypeScript strict/ESM, grammY, Vitest, Node.js readline for streaming JSONL.

---

## Task 1: Create `src/monitoring/history-parser.ts`

**Files:**
- Create: `src/monitoring/history-parser.ts`
- Create: `tests/history-parser.test.ts`

### Step 1: Write the failing test

```typescript
// tests/history-parser.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHistoryUsage } from '../src/monitoring/history-parser.js';

describe('parseHistoryUsage', () => {
  let dir: string;
  let historyPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `history-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    historyPath = join(dir, 'history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map for missing file', async () => {
    const result = await parseHistoryUsage(join(dir, 'missing.jsonl'));
    expect(result.size).toBe(0);
  });

  it('counts slash commands from display field', async () => {
    const lines = [
      JSON.stringify({ display: '/gsd:progress some args', timestamp: 1 }),
      JSON.stringify({ display: '/gsd:progress', timestamp: 2 }),
      JSON.stringify({ display: '/clear', timestamp: 3 }),
      JSON.stringify({ display: 'not a command', timestamp: 4 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.get('gsd:progress')).toBe(2);
    expect(result.get('clear')).toBe(1);
    expect(result.has('not a command')).toBe(false);
  });

  it('skips lines starting with //', async () => {
    const lines = [
      JSON.stringify({ display: '//not-a-command', timestamp: 1 }),
      JSON.stringify({ display: '/real', timestamp: 2 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.has('not-a-command')).toBe(false);
    expect(result.get('real')).toBe(1);
  });

  it('skips malformed JSON lines gracefully', async () => {
    const lines = [
      'not json',
      JSON.stringify({ display: '/good', timestamp: 1 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.get('good')).toBe(1);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run tests/history-parser.test.ts
```
Expected: FAIL — `Cannot find module '../src/monitoring/history-parser.js'`

### Step 3: Write the implementation

```typescript
// src/monitoring/history-parser.ts
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Parse ~/.claude/history.jsonl to count command usage.
 *
 * Each line is a JSON object with a `display` field. Lines where
 * `display` starts with `/` (but not `//`) are commands. The first
 * whitespace-delimited token is the command name (strip leading `/`).
 *
 * @returns Map of claudeName → invocation count
 */
export async function parseHistoryUsage(historyPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (!existsSync(historyPath)) return counts;

  const rl = createInterface({
    input: createReadStream(historyPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { display?: string };
      const display = entry.display ?? '';
      if (!display.startsWith('/') || display.startsWith('//')) continue;
      const raw = display.split(/\s+/)[0].slice(1); // strip leading /
      if (!raw) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    } catch {
      // skip malformed lines
    }
  }

  return counts;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run tests/history-parser.test.ts
```
Expected: 4 tests passing.

### Step 5: Commit

```bash
git add src/monitoring/history-parser.ts tests/history-parser.test.ts
git commit -m "feat: add history parser for command usage counts"
```

---

## Task 2: Update `src/settings/command-settings.ts`

Replace `enabled: boolean` + `mode: 'direct'|'submenu'` with three-state `visibility`, add `directCutoff`, and v1→v2 migration.

**Files:**
- Modify: `src/settings/command-settings.ts`
- Create: `tests/command-settings.test.ts`

### Step 1: Write the failing tests

```typescript
// tests/command-settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandSettingsStore } from '../src/settings/command-settings.js';

describe('CommandSettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `cmd-settings-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, 'command-settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults new commands to submenu visibility', () => {
    const store = new CommandSettingsStore(filePath);
    expect(store.getCommandSetting('gsd:progress').visibility).toBe('submenu');
  });

  it('defaults directCutoff to 30', () => {
    const store = new CommandSettingsStore(filePath);
    expect(store.getDirectCutoff()).toBe(30);
  });

  it('applyDefaults sets top-N by usage to direct', () => {
    const store = new CommandSettingsStore(filePath);
    const ns = new Map([['gsd', ['gsd:progress', 'gsd:plan', 'gsd:execute']]]);
    const usage = new Map([['gsd:progress', 50], ['gsd:plan', 30]]);
    store.setDirectCutoff(2);
    store.applyDefaults(ns, usage);

    expect(store.getCommandSetting('gsd:progress').visibility).toBe('direct');
    expect(store.getCommandSetting('gsd:plan').visibility).toBe('direct');
    expect(store.getCommandSetting('gsd:execute').visibility).toBe('submenu');
  });

  it('applyDefaults seeds usageCount from usage map', () => {
    const store = new CommandSettingsStore(filePath);
    const ns = new Map([['gsd', ['gsd:progress']]]);
    const usage = new Map([['gsd:progress', 42]]);
    store.applyDefaults(ns, usage);
    expect(store.getCommandSetting('gsd:progress').usageCount).toBe(42);
  });

  it('applyDefaults does not overwrite existing command settings', () => {
    const store = new CommandSettingsStore(filePath);
    store.setCommandSetting('gsd:progress', { visibility: 'hidden', usageCount: 99 });
    const ns = new Map([['gsd', ['gsd:progress']]]);
    store.applyDefaults(ns, new Map([['gsd:progress', 100]]));
    // Still hidden — applyDefaults only sets commands not yet in the store
    expect(store.getCommandSetting('gsd:progress').visibility).toBe('hidden');
  });

  it('migrates v1 data: enabled:true → submenu, enabled:false → hidden', () => {
    const v1Data = {
      version: 1,
      namespaces: { gsd: { mode: 'submenu' } },
      commands: {
        'gsd:progress': { enabled: true, usageCount: 5 },
        'gsd:old': { enabled: false, usageCount: 0 },
      },
    };
    writeFileSync(filePath, JSON.stringify(v1Data));
    const store = new CommandSettingsStore(filePath);
    expect(store.getCommandSetting('gsd:progress').visibility).toBe('submenu');
    expect(store.getCommandSetting('gsd:old').visibility).toBe('hidden');
    expect(store.getCommandSetting('gsd:progress').usageCount).toBe(5);
  });

  it('setDirectCutoff persists and is readable', () => {
    const store = new CommandSettingsStore(filePath);
    store.setDirectCutoff(10);
    expect(store.getDirectCutoff()).toBe(10);
  });

  it('applyTopDefaults reassigns visibility by current usageCount', () => {
    const store = new CommandSettingsStore(filePath);
    store.setCommandSetting('a', { visibility: 'hidden', usageCount: 100 });
    store.setCommandSetting('b', { visibility: 'direct', usageCount: 1 });
    store.setDirectCutoff(1);
    store.applyTopDefaults(['a', 'b']);
    expect(store.getCommandSetting('a').visibility).toBe('direct');
    expect(store.getCommandSetting('b').visibility).toBe('submenu');
  });

  it('recordUse increments usageCount and sets lastUsedAt', () => {
    const store = new CommandSettingsStore(filePath);
    store.setCommandSetting('gsd:progress', { visibility: 'direct', usageCount: 5 });
    store.recordUse('gsd:progress');
    const s = store.getCommandSetting('gsd:progress');
    expect(s.usageCount).toBe(6);
    expect(s.lastUsedAt).toBeGreaterThan(0);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
npx vitest run tests/command-settings.test.ts
```
Expected: multiple failures (wrong types, missing methods).

### Step 3: Rewrite `src/settings/command-settings.ts`

```typescript
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type CommandVisibility = 'direct' | 'submenu' | 'hidden';

export interface CommandSetting {
  visibility: CommandVisibility;
  usageCount: number;
  lastUsedAt?: number; // unix ms
}

export interface NamespaceSetting {
  defaultVisibility: CommandVisibility;
}

export interface CommandSettingsData {
  version: 2;
  directCutoff: number;
  namespaces: Record<string, NamespaceSetting>;
  commands: Record<string, CommandSetting>;
}

/**
 * Persists per-command visibility and usage to disk.
 *
 * Three-state visibility per command:
 * - 'direct':  registered in Telegram autocomplete AND shown in submenu keyboard
 * - 'submenu': shown only in the inline submenu keyboard
 * - 'hidden':  not shown anywhere
 *
 * directCutoff: how many top-usage commands to mark 'direct' when applying defaults.
 * Persistence: atomic tmp+rename, 500ms debounce.
 */
export class CommandSettingsStore {
  private data: CommandSettingsData;
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { version: 2, directCutoff: 30, namespaces: {}, commands: {} };
    this.load();
  }

  getDirectCutoff(): number {
    return this.data.directCutoff;
  }

  setDirectCutoff(cutoff: number): void {
    this.data.directCutoff = cutoff;
    this.scheduleSave();
  }

  getNamespaceSetting(ns: string): NamespaceSetting {
    return this.data.namespaces[ns] ?? { defaultVisibility: 'submenu' };
  }

  setNamespaceSetting(ns: string, setting: NamespaceSetting): void {
    this.data.namespaces[ns] = setting;
    this.scheduleSave();
  }

  getCommandSetting(claudeName: string): CommandSetting {
    return this.data.commands[claudeName] ?? { visibility: 'submenu', usageCount: 0 };
  }

  setCommandSetting(claudeName: string, setting: CommandSetting): void {
    this.data.commands[claudeName] = setting;
    this.scheduleSave();
  }

  setCommandVisibility(claudeName: string, visibility: CommandVisibility): void {
    const current = this.getCommandSetting(claudeName);
    this.data.commands[claudeName] = { ...current, visibility };
    this.scheduleSave();
  }

  recordUse(claudeName: string): void {
    const current = this.getCommandSetting(claudeName);
    this.data.commands[claudeName] = {
      ...current,
      usageCount: current.usageCount + 1,
      lastUsedAt: Date.now(),
    };
    this.scheduleSave();
  }

  /**
   * Apply defaults for first-seen namespaces and commands.
   * Commands already in the store are NOT modified.
   * New commands are set based on top-N usage from the provided map.
   */
  applyDefaults(
    commandsByNamespace: Map<string, string[]>,
    usageCounts: Map<string, number> = new Map(),
  ): void {
    const allCommands = [...commandsByNamespace.values()].flat();
    const cutoff = this.data.directCutoff;

    // Build sorted list of new (unseen) commands by usage to assign defaults
    const newCommands = allCommands.filter((cn) => !(cn in this.data.commands));
    const sorted = newCommands
      .map((cn) => ({ cn, count: usageCounts.get(cn) ?? 0 }))
      .sort((a, b) => b.count - a.count);

    // How many direct slots remain (already-direct commands use some slots)
    const alreadyDirect = Object.values(this.data.commands).filter(
      (s) => s.visibility === 'direct',
    ).length;
    let directRemaining = Math.max(0, cutoff - alreadyDirect);

    let dirty = false;

    for (const [ns] of commandsByNamespace) {
      if (!(ns in this.data.namespaces)) {
        this.data.namespaces[ns] = { defaultVisibility: 'submenu' };
        dirty = true;
      }
    }

    for (const { cn, count } of sorted) {
      const visibility: CommandVisibility =
        count > 0 && directRemaining > 0 ? 'direct' : 'submenu';
      if (visibility === 'direct') directRemaining--;
      this.data.commands[cn] = { visibility, usageCount: count };
      dirty = true;
    }

    if (dirty) this.scheduleSave();
  }

  /**
   * Re-apply top-N defaults to ALL known commands based on current usageCount.
   * Overwrites existing visibility. Called when user taps "Top Commands".
   */
  applyTopDefaults(allCommandNames: string[]): void {
    const cutoff = this.data.directCutoff;
    const sorted = allCommandNames
      .map((cn) => ({ cn, count: this.getCommandSetting(cn).usageCount }))
      .sort((a, b) => b.count - a.count);

    for (let i = 0; i < sorted.length; i++) {
      const { cn, count } = sorted[i];
      const current = this.getCommandSetting(cn);
      const visibility: CommandVisibility =
        count > 0 && i < cutoff ? 'direct' : 'submenu';
      this.data.commands[cn] = { ...current, visibility };
    }
    this.scheduleSave();
  }

  getAllNamespaces(): Map<string, NamespaceSetting> {
    return new Map(Object.entries(this.data.namespaces));
  }

  getAllCommands(): Map<string, CommandSetting> {
    return new Map(Object.entries(this.data.commands));
  }

  shutdown(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSync();
    }, 500);
  }

  private saveSync(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(raw) as any;

      // v1 → v2 migration
      if (!parsed.version || parsed.version === 1) {
        for (const [ns] of Object.entries(parsed.namespaces ?? {})) {
          this.data.namespaces[ns] = { defaultVisibility: 'submenu' };
        }
        for (const [cn, s] of Object.entries(parsed.commands ?? {})) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const old = s as any;
          this.data.commands[cn] = {
            visibility: old.enabled === false ? 'hidden' : 'submenu',
            usageCount: old.usageCount ?? 0,
            lastUsedAt: old.lastUsedAt,
          };
        }
        this.data.directCutoff = parsed.directCutoff ?? 30;
        return;
      }

      // v2: load as-is
      if (parsed.namespaces) this.data.namespaces = parsed.namespaces;
      if (parsed.commands) this.data.commands = parsed.commands;
      if (typeof parsed.directCutoff === 'number') this.data.directCutoff = parsed.directCutoff;
    } catch (err) {
      console.warn(
        `Warning: Failed to load command settings from ${this.filePath}, using defaults.`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
```

### Step 4: Run tests

```bash
npx vitest run tests/command-settings.test.ts
```
Expected: 8 tests passing.

### Step 5: Run full test suite to catch regressions

```bash
npm test
```
Expected: all tests pass. TypeScript errors expected in `bot.ts` and `index.ts` — those are fixed in later tasks.

### Step 6: Fix TypeScript errors from callers (bot.ts and index.ts reference old API)

```bash
npm run typecheck 2>&1 | grep "error TS"
```

In `src/bot/bot.ts`, every reference to `.enabled` needs updating — do a targeted replace:
- `.getCommandSetting(cn).enabled` → `.getCommandSetting(cn).visibility !== 'hidden'`
- `commandSettingsStore.setNamespaceSetting(ns, { mode: newMode })` — remove (callback deleted in Task 4)

In `src/index.ts`:
- `.getCommandSetting(cn).enabled` → `.getCommandSetting(cn).visibility === 'direct'`
- `setting.mode === 'submenu'` → remove (logic replaced in Task 3)
- `{ mode: ... }` namespace setting arg → remove (unused after Task 3)

Apply minimal fixes now so it compiles; full rewrites happen in Tasks 3 and 4.

### Step 7: Confirm it compiles

```bash
npm run typecheck
```
Expected: no errors.

### Step 8: Commit

```bash
git add src/settings/command-settings.ts tests/command-settings.test.ts src/bot/bot.ts src/index.ts
git commit -m "feat: three-state command visibility with v1 migration and directCutoff"
```

---

## Task 3: Update `src/index.ts` — history parsing + new registration logic

Wire `parseHistoryUsage` and rewrite `buildTelegramCommandList` for the new visibility model.

**Files:**
- Modify: `src/index.ts`

### Step 1: Import history parser at top of file

After the existing imports in `src/index.ts`, add:
```typescript
import { parseHistoryUsage } from './monitoring/history-parser.js';
import { join } from 'node:path';  // already imported — skip if present
import { homedir } from 'node:os'; // already imported — skip if present
```

### Step 2: Call parseHistoryUsage before applyDefaults

Find the block that calls `commandSettingsStore.applyDefaults(...)` (~line 158) and replace:

```typescript
  // Parse ~/.claude/history.jsonl once at startup for usage-seeded defaults
  const historyPath = join(homedir(), '.claude', 'history.jsonl');
  const usageCounts = await parseHistoryUsage(historyPath);
  cli.info('CORE', 'Parsed command usage history', { commands: usageCounts.size });

  commandSettingsStore.applyDefaults(commandRegistry.getCommandsByNamespace(), usageCounts);
```

### Step 3: Rewrite buildTelegramCommandList

Replace the entire `buildTelegramCommandList` function body (~lines 165-225):

```typescript
  function buildTelegramCommandList(): Array<{ command: string; description: string }> {
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const result: Array<{ command: string; description: string }> = [];
    const registeredNs = new Set<string>(); // prevent duplicate namespace entries

    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) {
        // Top-level commands: register 'direct' ones individually
        for (const cn of claudeNames) {
          if (commandSettingsStore.getCommandSetting(cn).visibility === 'direct') {
            const e = allEntries.find((x) => x.claudeName === cn);
            if (e) result.push({ command: e.telegramName, description: e.description.slice(0, 256) });
          }
        }
        continue;
      }

      const tgNs = ns.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 32);
      if (!tgNs) continue;

      const directCmds = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct',
      );
      const visibleCmds = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden',
      );

      // Register each 'direct' command individually (also shows in submenu)
      for (const cn of directCmds) {
        const e = allEntries.find((x) => x.claudeName === cn);
        if (e) result.push({ command: e.telegramName, description: e.description.slice(0, 256) });
      }

      // Register namespace submenu entry if ≥1 non-hidden command exists
      if (visibleCmds.length > 0 && !registeredNs.has(tgNs)) {
        registeredNs.add(tgNs);
        const descriptions = visibleCmds
          .slice(0, 3)
          .map((cn) => allEntries.find((x) => x.claudeName === cn)?.description || cn)
          .join(', ');
        result.push({
          command: tgNs,
          description: `${visibleCmds.length} commands: ${descriptions}`.slice(0, 256),
        });
      }
    }

    if (result.length > 100) {
      const priorityScore = (cmd: string): number => {
        const e = allEntries.find((x) => x.telegramName === cmd || x.claudeName === cmd);
        if (!e) return 0;
        if (e.source === 'builtin') return 3;
        if (e.source === 'user') return 2;
        return 1;
      };
      cli.warn('TELEGRAM', 'Command list exceeds limit after grouping, truncating', {
        count: result.length,
        limit: 100,
      });
      return result.sort((a, b) => priorityScore(b.command) - priorityScore(a.command)).slice(0, 100);
    }

    return result;
  }
```

### Step 4: Verify compilation

```bash
npm run typecheck
```
Expected: no errors.

### Step 5: Run tests

```bash
npm test
```
Expected: all pass.

### Step 6: Commit

```bash
git add src/index.ts
git commit -m "feat: wire history parser and rewrite buildTelegramCommandList for three-state visibility"
```

---

## Task 4: Update `src/bot/bot.ts` — new UI callbacks

Replace the `/commands` overview and all command-management callbacks with the new design.

**Files:**
- Modify: `src/bot/bot.ts`

### Step 1: Update `buildSubmenuKeyboard` to filter by visibility

Find `buildSubmenuKeyboard` (~line 463). The function already takes a pre-filtered `entries` array, so the filtering needs to happen at the call site. In `registerSubmenuHandlers`, update the filter:

Replace:
```typescript
      .filter((e) => commandSettingsStore.getCommandSetting(e.claudeName).enabled);
```
With:
```typescript
      .filter((e) => commandSettingsStore.getCommandSetting(e.claudeName).visibility !== 'hidden');
```

Also sort by usageCount descending:
```typescript
      .sort((a, b) =>
        commandSettingsStore.getCommandSetting(b.claudeName).usageCount -
        commandSettingsStore.getCommandSetting(a.claudeName).usageCount,
      );
```

Do the same in the `subp` pagination callback where entries are re-fetched.

### Step 2: Add `buildNsListPage` helper function

Add this function inside `createBot`, after `buildSubmenuText`:

```typescript
  const NS_DRILL_PAGE_SIZE = 6;

  async function sendNsListPage(
    ctx: Context,
    ns: string,
    page: number,
    edit: boolean,
    threadId?: number,
  ): Promise<void> {
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const claudeNames = nsByMode.get(ns) ?? [];
    const allEntries = commandRegistry.getEntries();

    const items = claudeNames
      .map((cn) => ({
        cn,
        entry: allEntries.find((x) => x.claudeName === cn),
        setting: commandSettingsStore.getCommandSetting(cn),
      }))
      .filter((x) => x.entry !== undefined)
      .sort((a, b) => b.setting.usageCount - a.setting.usageCount);

    const totalPages = Math.max(1, Math.ceil(items.length / NS_DRILL_PAGE_SIZE));
    const safePage = Math.min(page, totalPages - 1);
    const pageItems = items.slice(safePage * NS_DRILL_PAGE_SIZE, (safePage + 1) * NS_DRILL_PAGE_SIZE);

    const lines: string[] = [
      `\uD83D\uDCC1 <b>${escapeHtml(ns)}</b> \u2014 ${items.length} commands (page ${safePage + 1}/${totalPages})\n`,
    ];
    const kb = new InlineKeyboard();

    for (const { cn, setting } of pageItems) {
      const count = setting.usageCount;
      const vis = setting.visibility;
      // Short name: strip namespace prefix
      const label = cn.includes(':') ? cn.split(':').slice(1).join(':') : cn;
      const indicator = vis !== 'hidden' ? '\u25CF' : '\u25CB';
      lines.push(`${indicator} <code>${escapeHtml(label)}</code>  ${count}`);
      // 3-way toggle buttons — active state prefixed with ✓
      // Callback data: cmdvis:<claudeName>:<vis_char>  (d/s/h to stay within 64 bytes)
      const cbBase = `cmdvis:${cn.slice(0, 50)}`;
      kb.text(vis === 'direct' ? '\u2713direct' : 'direct', `${cbBase}:d`);
      kb.text(vis === 'submenu' ? '\u2713submenu' : 'submenu', `${cbBase}:s`);
      kb.text(vis === 'hidden' ? '\u2713hidden' : 'hidden', `${cbBase}:h`);
      kb.row();
    }

    // Pagination row
    if (totalPages > 1) {
      if (safePage > 0) kb.text('\u2190 Prev', `nslist:${ns}:${safePage - 1}`);
      kb.text(`${safePage + 1}/${totalPages}`, 'subp_noop');
      if (safePage < totalPages - 1) kb.text('Next \u2192', `nslist:${ns}:${safePage + 1}`);
    }

    const text = lines.join('\n');
    try {
      if (edit) {
        await ctx.editMessageText(text, { reply_markup: kb });
      } else {
        await ctx.reply(text, { reply_markup: kb, message_thread_id: threadId });
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('nslist error:', err instanceof Error ? err.message : err);
      }
    }
  }
```

### Step 3: Replace `sendCommandsOverview`

Replace the entire `sendCommandsOverview` function:

```typescript
  async function sendCommandsOverview(ctx: Context, threadId?: number): Promise<void> {
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const totalCount = allEntries.length;
    const cutoff = commandSettingsStore.getDirectCutoff();

    let directCount = 0;
    const nsLines: string[] = [];
    const kb = new InlineKeyboard();

    // Top-level commands
    const topLevel = nsByMode.get('') ?? [];
    if (topLevel.length > 0) {
      const d = topLevel.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct',
      ).length;
      directCount += d;
      nsLines.push(`<b>(top-level)</b> (${topLevel.length}) \u2014 ${d} direct`);
    }

    let rowItems = 0;
    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) continue;
      const d = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct',
      ).length;
      const visible = claudeNames.filter(
        (cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden',
      ).length;
      directCount += d;
      // Namespace submenu entry itself counts as 1 in the menu (if it has visible commands)
      if (visible > 0) directCount += 1;
      nsLines.push(
        `<b>${escapeHtml(ns)}</b> (${claudeNames.length}) \u2014 ${d} direct, ${visible} visible`,
      );
      kb.text(`${ns} \u2192`, `nslist:${ns}:0`);
      rowItems++;
      if (rowItems % 2 === 0) kb.row();
    }

    kb.row();
    kb.text('\uD83D\uDCCA Top Commands', 'cmd_top');
    kb.text(`\u270F\uFE0F Cutoff: ${cutoff}`, 'cmd_cutoff');
    kb.row();
    kb.text('\uD83D\uDD04 Refresh Menu', 'cmd_refresh');

    const header =
      `\uD83D\uDCCB <b>Commands</b> \u2014 ${directCount} in menu (${totalCount} total)\n\n` +
      nsLines.join('\n');

    try {
      await ctx.reply(header, { reply_markup: kb, message_thread_id: threadId });
    } catch (err) {
      console.warn('Failed to send /commands overview:', err instanceof Error ? err.message : err);
    }
  }
```

### Step 4: Remove old callbacks, add new ones

**Remove** the entire `nsmode` callback handler block (it was `bot.callbackQuery(/^nsmode:...$/)`).

**Add** after the `cmd_refresh` handler:

```typescript
  // --- cmd_top: apply top-N usage defaults ---
  bot.callbackQuery('cmd_top', async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Applying top commands...' });
    const allNames = commandRegistry.getEntries().map((e) => e.claudeName);
    commandSettingsStore.applyTopDefaults(allNames);
    try { await onRefreshMenu?.(); } catch { /* best-effort */ }
    // Edit the overview in-place
    const nsByMode = commandRegistry.getCommandsByNamespace();
    const allEntries = commandRegistry.getEntries();
    const totalCount = allEntries.length;
    const cutoff = commandSettingsStore.getDirectCutoff();
    let directCount = 0;
    const nsLines: string[] = [];
    const kb = new InlineKeyboard();
    const topLevel = nsByMode.get('') ?? [];
    if (topLevel.length > 0) {
      const d = topLevel.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct').length;
      directCount += d;
      nsLines.push(`<b>(top-level)</b> (${topLevel.length}) \u2014 ${d} direct`);
    }
    let rowItems = 0;
    for (const [ns, claudeNames] of nsByMode) {
      if (!ns) continue;
      const d = claudeNames.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility === 'direct').length;
      const visible = claudeNames.filter((cn) => commandSettingsStore.getCommandSetting(cn).visibility !== 'hidden').length;
      directCount += d + (visible > 0 ? 1 : 0);
      nsLines.push(`<b>${escapeHtml(ns)}</b> (${claudeNames.length}) \u2014 ${d} direct, ${visible} visible`);
      kb.text(`${ns} \u2192`, `nslist:${ns}:0`);
      rowItems++;
      if (rowItems % 2 === 0) kb.row();
    }
    kb.row();
    kb.text('\uD83D\uDCCA Top Commands', 'cmd_top');
    kb.text(`\u270F\uFE0F Cutoff: ${cutoff}`, 'cmd_cutoff');
    kb.row();
    kb.text('\uD83D\uDD04 Refresh Menu', 'cmd_refresh');
    const header = `\uD83D\uDCCB <b>Commands</b> \u2014 ${directCount} in menu (${totalCount} total)\n\n` + nsLines.join('\n');
    try {
      await ctx.editMessageText(header, { reply_markup: kb });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('message is not modified'))) {
        console.warn('cmd_top edit error:', err instanceof Error ? err.message : err);
      }
    }
  });

  // --- cmd_cutoff: cycle through presets ---
  const CUTOFF_PRESETS = [10, 20, 30, 50];
  bot.callbackQuery('cmd_cutoff', async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
      return;
    }
    const current = commandSettingsStore.getDirectCutoff();
    const idx = CUTOFF_PRESETS.indexOf(current);
    const next = CUTOFF_PRESETS[(idx + 1) % CUTOFF_PRESETS.length];
    commandSettingsStore.setDirectCutoff(next);
    await ctx.answerCallbackQuery({ text: `Cutoff set to ${next}` });
    // Edit button text in-place by re-rendering keyboard
    try {
      const msg = ctx.callbackQuery.message;
      if (msg && 'text' in msg) {
        const existingKb = msg.reply_markup?.inline_keyboard ?? [];
        // Rebuild keyboard with updated cutoff label
        const rebuilt = new InlineKeyboard();
        for (const row of existingKb) {
          for (const btn of row) {
            if ('callback_data' in btn && btn.callback_data === 'cmd_cutoff') {
              rebuilt.text(`\u270F\uFE0F Cutoff: ${next}`, 'cmd_cutoff');
            } else if ('callback_data' in btn) {
              rebuilt.text(btn.text, btn.callback_data);
            }
          }
          rebuilt.row();
        }
        await ctx.editMessageReplyMarkup({ reply_markup: rebuilt });
      }
    } catch { /* best-effort */ }
  });

  // --- nslist: namespace drill-down ---
  bot.callbackQuery(/^nslist:([^:]+):(\d+)$/, async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
      return;
    }
    const ns = ctx.match[1];
    const page = parseInt(ctx.match[2], 10);
    await ctx.answerCallbackQuery();
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    await sendNsListPage(ctx, ns, page, false, threadId);
  });

  // --- cmdvis: per-command visibility toggle ---
  bot.callbackQuery(/^cmdvis:(.+):(d|s|h)$/, async (ctx) => {
    if (!isSettingsAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
      return;
    }
    const claudeName = ctx.match[1];
    const visChar = ctx.match[2];
    const visMap: Record<string, CommandVisibility> = { d: 'direct', s: 'submenu', h: 'hidden' };
    const visibility = visMap[visChar];
    commandSettingsStore.setCommandVisibility(claudeName, visibility);
    await ctx.answerCallbackQuery({ text: `${claudeName}: ${visibility}` });
    // Re-render the drill-down page
    const msg = ctx.callbackQuery.message;
    // Extract current ns and page from message text (first line contains ns name)
    // Find ns by scanning all namespaces for one containing this command
    const nsByMode = commandRegistry.getCommandsByNamespace();
    let foundNs = '';
    for (const [ns, names] of nsByMode) {
      if (names.includes(claudeName)) { foundNs = ns; break; }
    }
    if (!foundNs) { return; }
    // Get current page from message text
    const pageMatch = (msg && 'text' in msg ? msg.text : '').match(/page (\d+)\//);
    const currentPage = pageMatch ? parseInt(pageMatch[1], 10) - 1 : 0;
    await sendNsListPage(ctx, foundNs, currentPage, true);
    // Re-register Telegram commands in background
    try { await onRefreshMenu?.(); } catch { /* best-effort */ }
  });
```

Also add at the top of `bot.ts` imports:
```typescript
import type { CommandVisibility } from '../settings/command-settings.js';
```

### Step 5: Verify compilation

```bash
npm run typecheck
```
Expected: no errors.

### Step 6: Run full test suite

```bash
npm test
```
Expected: all tests pass.

### Step 7: Commit

```bash
git add src/bot/bot.ts
git commit -m "feat: per-command visibility UI with drill-down, top commands, and cutoff controls"
```

---

## Final Verification

Restart the bot and manually verify:

1. `npm run dev` starts without `BOT_COMMAND_INVALID`
2. Log shows `Parsed command usage history commands=N` at startup
3. Most-used commands (from `~/.claude/history.jsonl`) appear directly in Telegram autocomplete
4. `/gsd` → submenu shows non-hidden gsd commands sorted by usage, including `direct` ones
5. `/commands` → overview with namespace rows, Top Commands, Cutoff buttons
6. **Top Commands** → visibility reassigned, Telegram menu re-registered
7. **Cutoff: 30** → tap → Cutoff: 10 → tap → Cutoff: 20 (cycles)
8. **gsd →** → drill-down list sorted by usage with ✓direct / submenu / hidden toggles
9. Toggle a command to `hidden` → disappears from `/gsd` submenu keyboard
10. Hide all commands in a namespace → namespace entry disappears from Telegram menu
11. Restart → settings persist, usage counts preserved
12. `npm test` → all green
