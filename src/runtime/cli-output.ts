import { formatCliLine, renderDashboard, type CliLogLevel } from './cli-format.js';
import { RuntimeStatus } from './runtime-status.js';
import { format } from 'node:util';

type ModeSetting = 'auto' | 'on' | 'off';

interface CliOutputOptions {
  colorMode?: ModeSetting;
  dashboardMode?: ModeSetting;
  logLevel?: CliLogLevel;
  refreshIntervalMs?: number;
  stdout?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

const LOG_LEVEL_WEIGHT: Record<CliLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMode(mode: ModeSetting, tty: boolean): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return tty;
}

function parseMode(value: string | undefined, fallback: ModeSetting): ModeSetting {
  if (value === 'on' || value === 'off' || value === 'auto') return value;
  return fallback;
}

function parseLevel(value: string | undefined): CliLogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

export class CliOutput {
  private readonly status: RuntimeStatus;
  private readonly stdout: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
  private readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  private readonly colorEnabled: boolean;
  private readonly dashboardEnabled: boolean;
  private readonly minLogLevel: CliLogLevel;
  private readonly refreshIntervalMs: number;

  private dashboardTimer: ReturnType<typeof setInterval> | null = null;
  private dashboardVisible = false;
  private dashboardLineCount = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private consoleCaptured = false;
  private originalConsoleLog: typeof console.log | null = null;
  private originalConsoleWarn: typeof console.warn | null = null;
  private originalConsoleError: typeof console.error | null = null;

  constructor(status: RuntimeStatus, options: CliOutputOptions = {}) {
    this.status = status;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 1000;
    this.minLogLevel = parseLevel(options.logLevel ?? process.env.CLI_LOG_LEVEL);

    const tty = !!this.stdout.isTTY;
    const colorMode = parseMode(options.colorMode ?? process.env.CLI_COLOR, 'auto');
    const dashboardMode = parseMode(options.dashboardMode ?? process.env.CLI_DASHBOARD, 'auto');
    this.colorEnabled = resolveMode(colorMode, tty);
    this.dashboardEnabled = resolveMode(dashboardMode, tty);
  }

  start(): void {
    if (!this.dashboardEnabled || this.dashboardTimer) return;
    this.refreshDashboard();
    this.dashboardTimer = setInterval(() => {
      this.refreshDashboard();
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.dashboardTimer) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = null;
    }
    this.enqueueWrite(() => {
      const clear = this.consumeDashboardClearSequence();
      if (clear) {
        this.stdout.write(clear);
      }
    });
    this.restoreConsole();
  }

  debug(component: string, message: string, fields?: Record<string, unknown>): void {
    this.log('debug', component, message, fields);
  }

  info(component: string, message: string, fields?: Record<string, unknown>): void {
    this.log('info', component, message, fields);
  }

  warn(component: string, message: string, fields?: Record<string, unknown>): void {
    this.status.noteWarning(message);
    this.log('warn', component, message, fields);
  }

  error(component: string, message: string, fields?: Record<string, unknown>): void {
    this.status.noteError(message);
    this.log('error', component, message, fields);
  }

  refreshDashboard(): void {
    if (!this.dashboardEnabled) return;
    this.enqueueWrite(() => {
      this.renderDashboardNow();
    });
  }

  captureConsole(): void {
    if (this.consoleCaptured) return;
    this.consoleCaptured = true;
    this.originalConsoleLog = console.log;
    this.originalConsoleWarn = console.warn;
    this.originalConsoleError = console.error;

    console.log = (...args: unknown[]) => {
      this.info('APP', format(...args));
    };
    console.warn = (...args: unknown[]) => {
      this.warn('APP', format(...args));
    };
    console.error = (...args: unknown[]) => {
      this.error('APP', format(...args));
    };
  }

  restoreConsole(): void {
    if (!this.consoleCaptured) return;
    if (this.originalConsoleLog) console.log = this.originalConsoleLog;
    if (this.originalConsoleWarn) console.warn = this.originalConsoleWarn;
    if (this.originalConsoleError) console.error = this.originalConsoleError;
    this.consoleCaptured = false;
    this.originalConsoleLog = null;
    this.originalConsoleWarn = null;
    this.originalConsoleError = null;
  }

  private log(level: CliLogLevel, component: string, message: string, fields?: Record<string, unknown>): void {
    if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[this.minLogLevel]) return;
    const lines = message.split(/\r?\n/).filter((line, index, all) => line.length > 0 || all.length === 1);
    for (let i = 0; i < lines.length; i += 1) {
      const lineMessage = i === 0 ? lines[i] : `-> ${lines[i]}`;
      const lineFields = i === 0 ? fields : undefined;
      this.enqueueWrite(() => {
        this.writeLogLine(level, component, lineMessage, lineFields);
      });
    }
  }

  private writeLogLine(
    level: CliLogLevel,
    component: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const line = formatCliLine(
      { level, component, message, fields, at: new Date() },
      { color: this.colorEnabled },
    );
    this.status.noteEvent(`[${component}] ${message}`);

    if (this.dashboardEnabled) {
      const clear = this.consumeDashboardClearSequence();
      const snapshot = this.status.snapshot();
      const block = renderDashboard(snapshot, { color: this.colorEnabled });
      this.stdout.write(`${clear}${line}\n${block}\n`);
      this.dashboardLineCount = block.split('\n').length;
      this.dashboardVisible = true;
      return;
    }

    const target = level === 'error' ? this.stderr : this.stdout;
    target.write(`${line}\n`);
  }

  private renderDashboardNow(): void {
    if (!this.dashboardEnabled) return;
    const clear = this.consumeDashboardClearSequence();
    const snapshot = this.status.snapshot();
    const block = renderDashboard(snapshot, { color: this.colorEnabled });
    this.stdout.write(`${clear}${block}\n`);
    this.dashboardLineCount = block.split('\n').length;
    this.dashboardVisible = true;
  }

  private consumeDashboardClearSequence(): string {
    if (!this.dashboardEnabled || !this.dashboardVisible || this.dashboardLineCount <= 0) return '';
    const lines = this.dashboardLineCount;
    this.dashboardVisible = false;
    this.dashboardLineCount = 0;
    return `\x1b[${lines}A\x1b[0J`;
  }

  private enqueueWrite(fn: () => void): void {
    this.writeQueue = this.writeQueue
      .then(() => {
        fn();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.stderr.write(`[cli-output] write failure: ${message}\n`);
      });
  }
}
