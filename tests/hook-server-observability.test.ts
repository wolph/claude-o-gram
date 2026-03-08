import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHookServer } from '../src/hooks/server.js';
import type { HookHandlers } from '../src/hooks/handlers.js';
import type { AppConfig } from '../src/types/config.js';

describe('hook server observability callbacks', () => {
  let port = 0;
  let stopServer: (() => Promise<void>) | null = null;
  const events: string[] = [];
  const authFailures: string[] = [];

  beforeAll(async () => {
    const handlers = {
      async handleSessionStart() {},
      async handleSessionEnd() {},
      async handlePostToolUse() {},
      async handleNotification() {},
      async handlePreToolUse() {},
      async handleStop() {},
      async handleSubagentStart() {},
      async handleSubagentStop() {},
    } as unknown as HookHandlers;

    const server = await createHookServer(
      {} as AppConfig,
      handlers,
      'test-secret',
      undefined,
      {
        onHookReceived: (event) => events.push(event),
        onAuthFailure: (route) => authFailures.push(route),
      },
    );

    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    stopServer = () => server.close();
  });

  afterAll(async () => {
    if (stopServer) {
      await stopServer();
    }
  });

  it('reports received hook events', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/session-start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(events).toContain('SessionStart');
  });

  it('reports auth failures', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/session-end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(authFailures.length).toBeGreaterThan(0);
    expect(authFailures[authFailures.length - 1]).toContain('/hooks/session-end');
  });
});
