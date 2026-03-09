import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandSettingsStore } from '../src/settings/command-settings.js';

describe('CommandSettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmd-settings-test-'));
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

  it('setDirectCutoff persists and is readable after reload', () => {
    const store = new CommandSettingsStore(filePath);
    store.setDirectCutoff(10);
    store.shutdown(); // flush to disk
    const reloaded = new CommandSettingsStore(filePath);
    expect(reloaded.getDirectCutoff()).toBe(10);
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

  it('applyDefaults respects global directCutoff cap (already-direct commands reduce available slots)', () => {
    const store = new CommandSettingsStore(filePath);
    // Pre-populate with 2 existing direct commands
    store.setCommandSetting('existing:a', { visibility: 'direct', usageCount: 0 });
    store.setCommandSetting('existing:b', { visibility: 'direct', usageCount: 0 });
    store.setDirectCutoff(2);
    // New high-usage command — but cutoff is already full
    const ns = new Map([['new', ['new:cmd']]]);
    store.applyDefaults(ns, new Map([['new:cmd', 999]]));
    // Should be submenu because the 2 slots are taken
    expect(store.getCommandSetting('new:cmd').visibility).toBe('submenu');
  });

  it('applyTopDefaults only reassigns visibility for passed command names', () => {
    const store = new CommandSettingsStore(filePath);
    store.setCommandSetting('cmd:included', { visibility: 'hidden', usageCount: 50 });
    store.setCommandSetting('cmd:excluded', { visibility: 'direct', usageCount: 0 });
    store.setDirectCutoff(1);
    store.applyTopDefaults(['cmd:included']); // 'cmd:excluded' not passed
    expect(store.getCommandSetting('cmd:included').visibility).toBe('direct');
    expect(store.getCommandSetting('cmd:excluded').visibility).toBe('direct'); // unchanged
  });

  it('persists command settings and reloads them correctly (round-trip)', () => {
    const store = new CommandSettingsStore(filePath);
    store.setCommandSetting('gsd:progress', { visibility: 'direct', usageCount: 42, lastUsedAt: 1000 });
    store.setDirectCutoff(15);
    store.shutdown(); // flush to disk

    const reloaded = new CommandSettingsStore(filePath);
    const s = reloaded.getCommandSetting('gsd:progress');
    expect(s.visibility).toBe('direct');
    expect(s.usageCount).toBe(42);
    expect(s.lastUsedAt).toBe(1000);
    expect(reloaded.getDirectCutoff()).toBe(15);
  });

  it('migrates versionless (legacy) data the same as v1', () => {
    const versionlessData = {
      // no version field
      namespaces: { gsd: { mode: 'direct' } },
      commands: {
        'gsd:legacy': { enabled: true, usageCount: 3 },
      },
    };
    writeFileSync(filePath, JSON.stringify(versionlessData));
    const store = new CommandSettingsStore(filePath);
    expect(store.getCommandSetting('gsd:legacy').visibility).toBe('submenu');
    expect(store.getCommandSetting('gsd:legacy').usageCount).toBe(3);
  });
});
