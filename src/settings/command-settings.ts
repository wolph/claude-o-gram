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

    // Seed usage counts from history for existing commands (migration path)
    for (const cn of allCommands) {
      if (cn in this.data.commands) {
        const historyCount = usageCounts.get(cn) ?? 0;
        if (historyCount > this.data.commands[cn].usageCount) {
          this.data.commands[cn].usageCount = historyCount;
          dirty = true;
        }
      }
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
