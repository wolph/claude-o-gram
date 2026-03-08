import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/session-store.js';
import { createHookHandlers } from '../src/hooks/handlers.js';

describe('HookHandlers late session recovery', () => {
  it('backfills transcript when a startup session is auto-discovered', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hook-handlers-startup-'));
    try {
      const dataDir = join(tempDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      const sessionsPath = join(dataDir, 'sessions.json');
      const transcriptPath = join(tempDir, 'startup-transcript.jsonl');
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Please inspect app logs and explain the failure',
              },
            ],
          },
        }) + '\n' +
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'ls -la' },
              },
            ],
          },
        }) + '\n',
        'utf-8',
      );

      const store = new SessionStore(sessionsPath);
      const callbacks = {
        onSessionStart: vi.fn(async () => {}),
        onSessionEnd: vi.fn(async () => {}),
        onToolUse: vi.fn(async () => {}),
        onNotification: vi.fn(async () => {}),
        onPreToolUse: vi.fn(async () => {}),
        onStop: vi.fn(async () => {}),
        onBackfillSummary: vi.fn(async () => {}),
        onSubagentStart: vi.fn(async () => {}),
        onSubagentStop: vi.fn(async () => {}),
      };
      const handlers = createHookHandlers(store, callbacks);

      await handlers.handleSessionStart({
        session_id: 'startup-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/startup-project',
        permission_mode: 'default',
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'unknown',
      });

      const saved = store.get('startup-session');
      expect(saved).toBeDefined();
      expect(saved?.status).toBe('active');
      expect(saved?.toolCallCount).toBe(1);
      expect(callbacks.onSessionStart).toHaveBeenCalledTimes(1);
      expect(callbacks.onBackfillSummary).toHaveBeenCalledTimes(1);
      const summary = callbacks.onBackfillSummary.mock.calls[0][1] as string;
      expect(summary).toContain('Recent prompts');
      expect(summary).toContain('Please inspect app logs');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('auto-registers unknown session on SessionEnd and then closes it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hook-handlers-late-'));
    try {
      const dataDir = join(tempDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      const sessionsPath = join(dataDir, 'sessions.json');
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: { role: 'assistant', content: [] },
        }) + '\n',
        'utf-8',
      );

      const store = new SessionStore(sessionsPath);
      const callbacks = {
        onSessionStart: vi.fn(async () => {}),
        onSessionEnd: vi.fn(async () => {}),
        onToolUse: vi.fn(async () => {}),
        onNotification: vi.fn(async () => {}),
        onPreToolUse: vi.fn(async () => {}),
        onStop: vi.fn(async () => {}),
        onBackfillSummary: vi.fn(async () => {}),
        onSubagentStart: vi.fn(async () => {}),
        onSubagentStop: vi.fn(async () => {}),
      };
      const handlers = createHookHandlers(store, callbacks);

      await handlers.handleSessionEnd({
        session_id: 'late-end-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/late-end-project',
        permission_mode: 'default',
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit',
      });

      const saved = store.get('late-end-session');
      expect(saved).toBeDefined();
      expect(saved?.status).toBe('closed');
      expect(callbacks.onSessionStart).toHaveBeenCalledTimes(1);
      expect(callbacks.onBackfillSummary).toHaveBeenCalledTimes(1);
      expect(callbacks.onSessionEnd).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
