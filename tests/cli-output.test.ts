import { describe, it, expect } from 'vitest';
import { formatCliLine, renderDashboard } from '../src/runtime/cli-format.js';
import { RuntimeStatus } from '../src/runtime/runtime-status.js';
import { CliOutput } from '../src/runtime/cli-output.js';

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CLI formatting', () => {
  it('formats a plain structured log line without ANSI color', () => {
    const line = formatCliLine(
      {
        level: 'info',
        component: 'HOOK',
        message: 'hook received',
        fields: { event: 'SessionStart', session: 'abc123' },
        at: new Date('2026-03-05T12:34:56.000Z'),
      },
      { color: false },
    );

    expect(line).toContain('INFO');
    expect(line).toContain('HOOK');
    expect(line).toContain('hook received');
    expect(line).toContain('event=SessionStart');
    expect(line).toContain('session=abc123');
    expect(line).not.toContain('\x1b[');
  });

  it('formats a colorized structured log line when color is enabled', () => {
    const line = formatCliLine(
      {
        level: 'warn',
        component: 'CORE',
        message: 'slow network',
        at: new Date('2026-03-05T12:34:56.000Z'),
      },
      { color: true },
    );

    expect(line).toContain('WARN');
    expect(line).toContain('CORE');
    expect(line).toContain('slow network');
    expect(line).toContain('\x1b[');
  });
});

describe('CLI dashboard rendering', () => {
  it('renders a detailed status block', () => {
    const dashboard = renderDashboard({
      uptimeSeconds: 3665,
      activeSessions: 3,
      pendingApprovals: 2,
      hookCounts: {
        SessionStart: 4,
        SessionEnd: 3,
        PostToolUse: 21,
        Notification: 7,
        PreToolUse: 12,
        Stop: 3,
        SubagentStart: 2,
        SubagentStop: 2,
      },
      totalHooks: 54,
      authFailures: 1,
      subagentsActive: 1,
      subagentsCompleted: 5,
      warnings: 2,
      errors: 1,
      lastEvent: 'session ended cleanly',
      lastEventAt: Date.now(),
    }, { color: false });

    expect(dashboard).toContain('Runtime Status');
    expect(dashboard).toContain('Uptime');
    expect(dashboard).toContain('Active Sessions: 3');
    expect(dashboard).toContain('Pending Approvals: 2');
    expect(dashboard).toContain('Hooks: total=54');
    expect(dashboard).toContain('Auth Failures: 1');
    expect(dashboard).toContain('Subagents: active=1');
    expect(dashboard).toContain('Last Event: session ended cleanly');
  });
});

describe('RuntimeStatus', () => {
  it('tracks counters and supplies live snapshot values', () => {
    const status = new RuntimeStatus({
      getActiveSessions: () => 5,
      getPendingApprovals: () => 2,
    });

    status.noteHook('SessionStart');
    status.noteHook('SessionEnd');
    status.noteHook('PreToolUse');
    status.noteAuthFailure('/hooks/session-end');
    status.noteSubagentStart();
    status.noteSubagentStop();
    status.noteWarning('retrying send');
    status.noteError('send failed');
    status.noteEvent('hook server started');

    const snapshot = status.snapshot();

    expect(snapshot.activeSessions).toBe(5);
    expect(snapshot.pendingApprovals).toBe(2);
    expect(snapshot.totalHooks).toBe(3);
    expect(snapshot.hookCounts.SessionStart).toBe(1);
    expect(snapshot.hookCounts.SessionEnd).toBe(1);
    expect(snapshot.hookCounts.PreToolUse).toBe(1);
    expect(snapshot.authFailures).toBe(1);
    expect(snapshot.subagentsActive).toBe(0);
    expect(snapshot.subagentsCompleted).toBe(1);
    expect(snapshot.warnings).toBe(1);
    expect(snapshot.errors).toBe(1);
    expect(snapshot.lastEvent).toContain('hook server started');
    expect(snapshot.lastEventAt).toBeGreaterThan(0);
  });
});

describe('CliOutput console capture', () => {
  it('routes console.log through structured logger output', async () => {
    let out = '';
    const status = new RuntimeStatus({
      getActiveSessions: () => 0,
      getPendingApprovals: () => 0,
    });
    const cli = new CliOutput(status, {
      colorMode: 'off',
      dashboardMode: 'off',
      logLevel: 'debug',
      stdout: {
        isTTY: false,
        write: (chunk: string) => {
          out += chunk;
          return true;
        },
      },
      stderr: {
        write: () => true,
      },
    });

    cli.captureConsole();
    try {
      console.log('hook install %s', 'started');
      await flushWrites();
    } finally {
      cli.stop();
    }

    expect(out).toContain('INFO');
    expect(out).toContain('APP');
    expect(out).toContain('hook install started');
  });
});

describe('CliOutput stream discipline', () => {
  it('writes error logs to stdout when dashboard is enabled to avoid stream interleaving', async () => {
    let out = '';
    let err = '';
    const status = new RuntimeStatus({
      getActiveSessions: () => 0,
      getPendingApprovals: () => 0,
    });
    const cli = new CliOutput(status, {
      colorMode: 'off',
      dashboardMode: 'on',
      logLevel: 'debug',
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          out += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          err += chunk;
          return true;
        },
      },
    });

    cli.error('CORE', 'failure');
    await flushWrites();
    cli.stop();

    expect(out).toContain('ERROR');
    expect(out).toContain('Runtime Status');
    expect(err).toBe('');
  });

  it('splits multiline messages into separate structured rows', async () => {
    let out = '';
    const status = new RuntimeStatus({
      getActiveSessions: () => 0,
      getPendingApprovals: () => 0,
    });
    const cli = new CliOutput(status, {
      colorMode: 'off',
      dashboardMode: 'off',
      logLevel: 'debug',
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          out += chunk;
          return true;
        },
      },
      stderr: {
        write: () => true,
      },
    });

    cli.info('APP', 'line one\nline two');
    await flushWrites();
    cli.stop();

    expect(out).toContain('line one');
    expect(out).toContain('-> line two');
    expect(out.match(/INFO/g)?.length ?? 0).toBe(2);
  });
});
