# Command Visibility & Usage-Driven Defaults — Design

**Date:** 2026-03-09
**Status:** Approved

---

## Problem

The current command management system only supports namespace-level direct/submenu toggling. Users need per-command visibility control and automatic defaults driven by real usage data from Claude logs.

---

## Goals

1. Per-command visibility: `direct` | `submenu` | `hidden`
2. Namespace-level default visibility for commands without explicit settings
3. Parse `~/.claude/history.jsonl` at startup to seed real usage counts
4. "Top Commands" button applies usage-driven defaults up to a configurable cutoff
5. `/commands` drill-down shows commands sorted by usage with inline visibility toggles
6. Namespace submenu entry auto-hides when all its commands are `hidden`
7. `direct` commands appear in both Telegram autocomplete AND the namespace submenu keyboard

---

## Data Model

### `CommandSetting`
```typescript
type CommandVisibility = 'direct' | 'submenu' | 'hidden';

interface CommandSetting {
  visibility: CommandVisibility; // replaces enabled: boolean
  usageCount: number;            // seeded from history.jsonl, incremented in-session
  lastUsedAt?: number;           // unix ms
}
```

### `NamespaceSetting`
```typescript
interface NamespaceSetting {
  defaultVisibility: CommandVisibility; // default for commands without explicit setting
}
```

### `CommandSettingsData`
```typescript
interface CommandSettingsData {
  version: 2;                                    // bumped from 1
  directCutoff: number;                          // max commands in direct Telegram menu (default 30)
  namespaces: Record<string, NamespaceSetting>;
  commands: Record<string, CommandSetting>;
}
```

### Migration (v1 → v2)
- `enabled: true` → `visibility: 'submenu'` (was accessible but not direct)
- `enabled: false` → `visibility: 'hidden'`
- `NamespaceSetting.mode` field dropped (subsumed by per-command visibility)
- `directCutoff` defaults to 30

---

## Auto-Defaults (applied once per new command/namespace)

1. Parse `~/.claude/history.jsonl` at startup → `Map<claudeName, count>`
2. Sort all discovered commands by count descending
3. Top-N commands (N = `directCutoff`) with count > 0 → `visibility: 'direct'`
4. All others → `visibility: 'submenu'`
5. Namespace `defaultVisibility` = mode of its commands (whichever appears most)

---

## Registration Logic (`buildTelegramCommandList`)

- `direct` commands → registered individually in `setMyCommands`
- `submenu` commands → appear only in inline keyboard, not in autocomplete
- `hidden` commands → not registered anywhere
- Namespace submenu entry registered only if ≥1 command has `visibility !== 'hidden'`
- `direct` commands also appear in the namespace submenu keyboard (accessible both ways)

---

## History Parser

New file: `src/monitoring/history-parser.ts`

```typescript
function parseHistoryUsage(historyPath: string): Map<string, number>
```

- Reads `~/.claude/history.jsonl` line by line
- Extracts `display` field; if starts with `/`, takes first token as command name
- Strips leading `/`, normalizes `_` → `:` for Telegram-style names
- Returns map of `claudeName → count`
- Called once in `main()` before `commandSettingsStore.applyDefaults()`

---

## `/commands` UI

### Overview message
```
📋 Commands — 23 direct, 94 total

[📊 Top Commands]   [✏️ Cutoff: 30]

gsd (45)        [drill down →]
superpowers (31)   [drill down →]
user (9)        [drill down →]
builtin (20)    [drill down →]
```

**Top Commands** (`cmd_top`): applies directCutoff — sets top-N by usage to `direct`, rest to `submenu`. Re-renders overview in-place. Re-registers commands with Telegram.

**Cutoff** (`cmd_cutoff`): cycles through presets 10 → 20 → 30 → 50 → 10. Stored in `CommandSettingsStore.directCutoff`.

### Namespace drill-down (`nslist:<ns>:<page>`)

Sent as a new message (not editing the overview). Paginated (8 per page), sorted by usage count descending.

```
📁 gsd — 45 commands  (page 1/6)

● gsd:progress      847  [direct]  [submenu]  [hidden]
● gsd:execute-phase 312  [direct]  [submenu]  [hidden]
○ gsd:cleanup         0            [submenu]  [hidden]

[← Prev]  [Next →]
```

Active state highlighted with ●/○. Callback: `cmdvis:<claudeName>:<visibility>` — updates setting, re-renders page in-place.

---

## New Callbacks

| Callback | Action |
|----------|--------|
| `cmd_top` | Apply top-N defaults, re-register, re-render overview |
| `cmd_cutoff` | Cycle cutoff preset, re-render overview |
| `nslist:<ns>:<page>` | Send/edit namespace drill-down message |
| `cmdvis:<name>:<vis>` | Set per-command visibility, re-render drill-down page |

---

## Files to Create / Modify

**New:**
- `src/monitoring/history-parser.ts` — `parseHistoryUsage()`

**Modified:**
- `src/settings/command-settings.ts` — `CommandVisibility` type, updated interfaces, migration, `directCutoff`, `applyDefaults()` accepts usage map
- `src/bot/bot.ts` — new callbacks, updated `/commands` overview, drill-down message
- `src/index.ts` — call `parseHistoryUsage()` before `applyDefaults()`, pass counts; update `buildTelegramCommandList()` to use `visibility` field

---

## Verification

1. Start bot → `directCutoff` most-used commands appear directly in Telegram autocomplete
2. `/gsd` → submenu shows all non-hidden gsd commands (including direct ones)
3. `/commands` → overview with Top Commands and Cutoff buttons
4. Tap **Top Commands** → visibility updated, Telegram menu re-registered
5. Tap **Cutoff: 30** → cycles to 10, tap again → 20, etc.
6. Tap **gsd [drill down →]** → paginated list sorted by usage with 3-way toggles
7. Toggle a command to `hidden` → disappears from submenu keyboard
8. Hide all commands in a namespace → namespace submenu entry disappears from Telegram menu
9. Restart bot → settings persist, usage counts preserved
