import type { RuntimeStatusSnapshot } from './runtime-status.js';

export type CliLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CliLogEntry {
  level: CliLogLevel;
  component: string;
  message: string;
  fields?: Record<string, unknown>;
  at?: Date;
}

interface CliFormatOptions {
  color: boolean;
}

const RESET = '\x1b[0m';
const COLORS = {
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  bold: '\x1b[1m',
} as const;

function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${code}${text}${RESET}`;
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatField(key: string, value: unknown, enabled: boolean): string {
  const keyText = colorize(key, COLORS.blue, enabled);
  const valueText = colorize(formatFieldValue(value), COLORS.green, enabled);
  return `${keyText}=${valueText}`;
}

function levelColor(level: CliLogLevel): string {
  switch (level) {
    case 'debug':
      return COLORS.gray;
    case 'info':
      return COLORS.cyan;
    case 'warn':
      return COLORS.yellow;
    case 'error':
      return COLORS.red;
  }
}

export function formatCliLine(entry: CliLogEntry, options: CliFormatOptions): string {
  const at = entry.at ?? new Date();
  const levelText = entry.level.toUpperCase().padEnd(5, ' ');
  const componentText = entry.component.toUpperCase().padEnd(10, ' ');
  const timePart = colorize(`[${formatTime(at)}]`, COLORS.gray, options.color);
  const levelPart = colorize(levelText, levelColor(entry.level), options.color);
  const componentPart = colorize(componentText, COLORS.magenta, options.color);
  const messagePart = colorize(entry.message, COLORS.bold, options.color);

  const fields: string[] = [];
  if (entry.fields) {
    for (const [key, value] of Object.entries(entry.fields)) {
      fields.push(formatField(key, value, options.color));
    }
  }

  return [timePart, levelPart, componentPart, messagePart, ...fields].join(' ').trim();
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function emphasis(value: string, color: string, enabled: boolean): string {
  return colorize(value, `${COLORS.bold}${color}`, enabled);
}

function label(value: string, enabled: boolean): string {
  return colorize(value, COLORS.cyan, enabled);
}

function count(value: number, enabled: boolean, highlightColor: string = COLORS.green): string {
  if (value === 0) {
    return colorize('0', COLORS.gray, enabled);
  }
  return emphasis(String(value), highlightColor, enabled);
}

export function renderDashboard(snapshot: RuntimeStatusSnapshot, options: CliFormatOptions): string {
  const line1 =
    `${emphasis('Runtime Status', COLORS.blue, options.color)} | ` +
    `${label('Uptime', options.color)}: ${emphasis(formatDuration(snapshot.uptimeSeconds), COLORS.green, options.color)}`;
  const line2 =
    `${label('Active Sessions', options.color)}: ${count(snapshot.activeSessions, options.color)} | ` +
    `${label('Pending Approvals', options.color)}: ${count(snapshot.pendingApprovals, options.color, COLORS.yellow)}`;
  const line3 =
    `${label('Hooks', options.color)}: ` +
    `${colorize('total', COLORS.magenta, options.color)}=${count(snapshot.totalHooks, options.color)} ` +
    `${colorize('start', COLORS.magenta, options.color)}=${count(snapshot.hookCounts.SessionStart, options.color)} ` +
    `${colorize('end', COLORS.magenta, options.color)}=${count(snapshot.hookCounts.SessionEnd, options.color)} ` +
    `${colorize('pre', COLORS.magenta, options.color)}=${count(snapshot.hookCounts.PreToolUse, options.color)} ` +
    `${colorize('post', COLORS.magenta, options.color)}=${count(snapshot.hookCounts.PostToolUse, options.color)} ` +
    `${colorize('notify', COLORS.magenta, options.color)}=${count(snapshot.hookCounts.Notification, options.color)}`;
  const line4 =
    `${label('Auth Failures', options.color)}: ` +
    `${count(snapshot.authFailures, options.color, COLORS.red)} | ` +
    `${label('Subagents', options.color)}: ` +
    `${colorize('active', COLORS.magenta, options.color)}=${count(snapshot.subagentsActive, options.color, COLORS.yellow)} ` +
    `${colorize('completed', COLORS.magenta, options.color)}=${count(snapshot.subagentsCompleted, options.color)}`;
  const line5 =
    `${label('Warnings', options.color)}: ${count(snapshot.warnings, options.color, COLORS.yellow)} | ` +
    `${label('Errors', options.color)}: ${count(snapshot.errors, options.color, COLORS.red)}`;
  const line6 = `${label('Last Event', options.color)}: ${colorize(snapshot.lastEvent, COLORS.bold, options.color)}`;

  return [line1, line2, line3, line4, line5, line6].join('\n');
}
