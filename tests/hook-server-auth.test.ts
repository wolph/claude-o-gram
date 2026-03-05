import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

describe('hook server authentication', () => {
  let fastify: FastifyInstance;
  let port: number;
  let secret: string;

  beforeAll(async () => {
    secret = randomBytes(32).toString('hex');
    fastify = Fastify({ logger: false });

    // Replicate the auth hook from src/hooks/server.ts
    fastify.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/hooks/')) return;
      const auth = request.headers.authorization;
      if (!auth || auth !== `Bearer ${secret}`) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
    });

    fastify.post('/hooks/test', async () => ({ ok: true }));
    fastify.get('/health', async () => ({ status: 'ok' }));

    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = fastify.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await fastify.close();
  });

  const hookUrl = () => `http://127.0.0.1:${port}/hooks/test`;
  const healthUrl = () => `http://127.0.0.1:${port}/health`;

  it('rejects requests with no Authorization header', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with empty Bearer', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with extra characters in token', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}extra`,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with truncated token', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret.slice(0, -1)}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct Bearer token', async () => {
    const res = await fetch(hookUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('allows /health without authentication', async () => {
    const res = await fetch(healthUrl());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
