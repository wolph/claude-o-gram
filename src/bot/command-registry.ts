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
  /**
   * Parameter hint from frontmatter. null/undefined = show generic prompt;
   * "none" = skip prompt and run immediately; "<hint>" = show hint string.
   */
  parameters?: string | null;
}

/** Bot-native commands that are never forwarded to CLI */
const BOT_NATIVE_COMMANDS = new Set(['status', 'verbose', 'normal', 'quiet', 'commands']);

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

    // 3. User skills from ~/.claude/skills/
    const userSkillsDir = join(homedir(), '.claude', 'skills');
    this.scanSkillDir(userSkillsDir, 'user');

    // 4. Plugin commands and skills from enabled plugins
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

  /** Look up a CommandEntry by its Claude name. Returns null if not found. */
  getByClaudeName(claudeName: string): CommandEntry | null {
    return this.entries.find((e) => e.claudeName === claudeName) ?? null;
  }

  /**
   * Build a map of namespace → array of claudeNames in that namespace.
   * Top-level commands (no colon) are grouped under the empty string key "".
   */
  getCommandsByNamespace(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const entry of this.entries) {
      const colonIdx = entry.claudeName.indexOf(':');
      const ns = colonIdx >= 0 ? entry.claudeName.slice(0, colonIdx) : '';
      const list = map.get(ns) ?? [];
      list.push(entry.claudeName);
      map.set(ns, list);
    }
    return map;
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

  /** Extract description and parameters from YAML frontmatter in a .md file */
  private extractFrontmatter(filePath: string): { description: string | null; parameters?: string | null } {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return { description: null };
      const yaml = match[1];
      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      const paramMatch = yaml.match(/^parameters:\s*(.+)$/m);
      return {
        description: descMatch ? descMatch[1].trim().slice(0, 256) : null,
        parameters: paramMatch ? paramMatch[1].trim() : undefined,
      };
    } catch {
      return { description: null };
    }
  }

  /** Add a command entry, skipping bot-native commands and duplicates */
  private addEntry(claudeName: string, telegramName: string, description: string, source: string, parameters?: string | null): void {
    const tgName = this.toTelegramName(telegramName);
    if (tgName.length === 0) return; // skip invalid names
    if (BOT_NATIVE_COMMANDS.has(tgName)) return;
    if (this.telegramToClaudeMap.has(tgName)) return; // first-registered wins

    const entry: CommandEntry = { telegramName: tgName, claudeName, description, source, parameters };
    this.entries.push(entry);
    this.telegramToClaudeMap.set(tgName, claudeName);
  }

  /** Scan a directory for command .md files. Subdirectories become namespaces. */
  private scanCommandDir(dir: string, source: string, namespace?: string): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Namespace directory (e.g., gsd/)
        const subNamespace = entry.name;
        const subdir = join(dir, subNamespace);
        let subEntries: import('node:fs').Dirent[];
        try {
          subEntries = readdirSync(subdir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith('.md')) {
            const cmdName = basename(sub.name, '.md');
            const prefix = namespace || subNamespace;
            const claudeName = `${prefix}:${cmdName}`;
            const fm = this.extractFrontmatter(join(subdir, sub.name));
            this.addEntry(claudeName, claudeName, fm.description || claudeName, source, fm.parameters);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Top-level command
        const cmdName = basename(entry.name, '.md');
        const claudeName = namespace ? `${namespace}:${cmdName}` : cmdName;
        const fm = this.extractFrontmatter(join(dir, entry.name));
        this.addEntry(claudeName, claudeName, fm.description || claudeName, source, fm.parameters);
      }
    }
  }

  /** Scan a directory for skill subdirectories containing SKILL.md files */
  private scanSkillDir(dir: string, source: string, namespace?: string): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const skillName = entry.name;
      const claudeName = namespace ? `${namespace}:${skillName}` : skillName;
      const fm = this.extractFrontmatter(skillFile);
      this.addEntry(claudeName, claudeName, fm.description || claudeName, source, fm.parameters);
    }
  }

  /** Scan enabled plugin command directories */
  private scanPluginCommands(): void {
    const pluginsFile = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const settingsFile = join(homedir(), '.claude', 'settings.json');

    if (!existsSync(pluginsFile) || !existsSync(settingsFile)) return;

    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      // enabledPlugins can be an array of strings or an object { pluginId: true }
      const rawEnabled = settings.enabledPlugins;
      const enabledPlugins: string[] = Array.isArray(rawEnabled)
        ? rawEnabled
        : (rawEnabled && typeof rawEnabled === 'object'
          ? Object.keys(rawEnabled).filter((k) => rawEnabled[k])
          : []);

      const installed = JSON.parse(readFileSync(pluginsFile, 'utf-8'));
      const plugins: Record<string, Array<{ installPath: string }>> = installed.plugins || {};

      for (const pluginId of enabledPlugins) {
        const versions = plugins[pluginId];
        if (!versions || versions.length === 0) continue;
        const latest = versions[versions.length - 1];
        // Extract short plugin name: "superpowers@claude-plugins-official" → "superpowers"
        const pluginName = pluginId.split('@')[0];
        const commandsDir = join(latest.installPath, 'commands');
        this.scanCommandDir(commandsDir, 'plugin', pluginName);
        const skillsDir = join(latest.installPath, 'skills');
        this.scanSkillDir(skillsDir, 'plugin', pluginName);
      }
    } catch (err) {
      console.warn('Failed to scan plugin commands:', err instanceof Error ? err.message : err);
    }
  }
}
