export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PostToolUse',
  'Notification',
  'PreToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface RuntimeStatusSnapshot {
  uptimeSeconds: number;
  activeSessions: number;
  pendingApprovals: number;
  hookCounts: Record<HookEvent, number>;
  totalHooks: number;
  authFailures: number;
  subagentsActive: number;
  subagentsCompleted: number;
  warnings: number;
  errors: number;
  lastEvent: string;
  lastEventAt: number;
}

interface RuntimeStatusOptions {
  getActiveSessions: () => number;
  getPendingApprovals: () => number;
}

function emptyHookCounts(): Record<HookEvent, number> {
  return {
    SessionStart: 0,
    SessionEnd: 0,
    PostToolUse: 0,
    Notification: 0,
    PreToolUse: 0,
    Stop: 0,
    SubagentStart: 0,
    SubagentStop: 0,
  };
}

export class RuntimeStatus {
  private readonly startedAt = Date.now();
  private readonly getActiveSessions: () => number;
  private readonly getPendingApprovals: () => number;

  private readonly hookCounts = emptyHookCounts();
  private authFailures = 0;
  private subagentsActive = 0;
  private subagentsCompleted = 0;
  private warnings = 0;
  private errors = 0;
  private lastEvent = 'initializing';
  private lastEventAt = this.startedAt;

  constructor(options: RuntimeStatusOptions) {
    this.getActiveSessions = options.getActiveSessions;
    this.getPendingApprovals = options.getPendingApprovals;
  }

  noteHook(event: HookEvent): void {
    this.hookCounts[event] += 1;
    this.noteEvent(`hook=${event}`);
  }

  noteAuthFailure(route: string): void {
    this.authFailures += 1;
    this.noteEvent(`auth-failure route=${route}`);
  }

  noteSubagentStart(): void {
    this.subagentsActive += 1;
    this.noteEvent('subagent-start');
  }

  noteSubagentStop(): void {
    if (this.subagentsActive > 0) {
      this.subagentsActive -= 1;
    }
    this.subagentsCompleted += 1;
    this.noteEvent('subagent-stop');
  }

  noteWarning(message: string): void {
    this.warnings += 1;
    this.noteEvent(`warning=${message}`);
  }

  noteError(message: string): void {
    this.errors += 1;
    this.noteEvent(`error=${message}`);
  }

  noteEvent(message: string): void {
    this.lastEvent = message;
    this.lastEventAt = Date.now();
  }

  snapshot(): RuntimeStatusSnapshot {
    const totalHooks = HOOK_EVENTS.reduce((sum, event) => sum + this.hookCounts[event], 0);
    return {
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
      activeSessions: this.getActiveSessions(),
      pendingApprovals: this.getPendingApprovals(),
      hookCounts: { ...this.hookCounts },
      totalHooks,
      authFailures: this.authFailures,
      subagentsActive: this.subagentsActive,
      subagentsCompleted: this.subagentsCompleted,
      warnings: this.warnings,
      errors: this.errors,
      lastEvent: this.lastEvent,
      lastEventAt: this.lastEventAt,
    };
  }
}
