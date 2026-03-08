import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CommandSetting {
  enabled: boolean;
  usageCount: number;
  lastUsedAt?: number; // unix ms
}

export interface NamespaceSetting {
  mode: 'direct' | 'submenu'; // direct = register each cmd; submenu = one entry → inline menu
}

export interface CommandSettingsData {
  version: 1;
  namespaces: Record<string, NamespaceSetting>; // "gsd" → { mode: "submenu" }
  commands: Record<string, CommandSetting>;      // "gsd:progress" → { enabled, usageCount }
}

const DEFAULTS: CommandSettingsData = {
  version: 1,
  namespaces: {},
  commands: {},
};

/**
 * Persists per-command and per-namespace settings to disk.
 *
 * Auto-defaults:
 * - Namespace with ≥ 5 commands → mode: 'submenu'
 * - Namespace with < 5 commands → mode: 'direct'
 * - All commands → enabled: true, usageCount: 0
 *
 * Persistence: atomic tmp+rename, 500ms debounce.
 */
export class CommandSettingsStore {
  private data: CommandSettingsData;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS, namespaces: {}, commands: {} };
    this.load();
  }

  /**
   * Apply auto-defaults for all entries discovered from the command registry.
   * Namespaces and commands not yet in the data store get their defaults.
   * @param commandsByNamespace Map of namespace → array of claudeNames in that namespace
   */
  applyDefaults(commandsByNamespace: Map<string, string[]>): void {
    let dirty = false;

    for (const [ns, cmds] of commandsByNamespace) {
      // Namespace default
      if (!(ns in this.data.namespaces)) {
        this.data.namespaces[ns] = { mode: cmds.length >= 5 ? 'submenu' : 'direct' };
        dirty = true;
      }
      // Per-command defaults
      for (const claudeName of cmds) {
        if (!(claudeName in this.data.commands)) {
          this.data.commands[claudeName] = { enabled: true, usageCount: 0 };
          dirty = true;
        }
      }
    }

    if (dirty) this.scheduleSave();
  }

  /** Get namespace setting, returning a default if not set */
  getNamespaceSetting(ns: string): NamespaceSetting {
    return this.data.namespaces[ns] ?? { mode: 'direct' };
  }

  /** Set namespace setting and persist */
  setNamespaceSetting(ns: string, setting: NamespaceSetting): void {
    this.data.namespaces[ns] = setting;
    this.scheduleSave();
  }

  /** Get command setting, returning a default if not set */
  getCommandSetting(claudeName: string): CommandSetting {
    return this.data.commands[claudeName] ?? { enabled: true, usageCount: 0 };
  }

  /** Set command setting and persist */
  setCommandSetting(claudeName: string, setting: CommandSetting): void {
    this.data.commands[claudeName] = setting;
    this.scheduleSave();
  }

  /** Increment usage count for a command */
  recordUse(claudeName: string): void {
    const current = this.getCommandSetting(claudeName);
    this.data.commands[claudeName] = {
      ...current,
      usageCount: current.usageCount + 1,
      lastUsedAt: Date.now(),
    };
    this.scheduleSave();
  }

  /** Get all namespace → setting pairs */
  getAllNamespaces(): Map<string, NamespaceSetting> {
    return new Map(Object.entries(this.data.namespaces));
  }

  /** Get all command → setting pairs */
  getAllCommands(): Map<string, CommandSetting> {
    return new Map(Object.entries(this.data.commands));
  }

  /** Flush pending save and clear timer (call on shutdown) */
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
    const json = JSON.stringify(this.data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CommandSettingsData>;
      if (parsed.namespaces) this.data.namespaces = parsed.namespaces;
      if (parsed.commands) this.data.commands = parsed.commands;
    } catch (err) {
      console.warn(
        `Warning: Failed to load command settings from ${this.filePath}, using defaults.`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
