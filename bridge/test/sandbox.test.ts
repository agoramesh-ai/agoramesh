/**
 * Sandbox Endpoint Tests
 *
 * Tests for POST /sandbox — no auth required, rate-limited,
 * 500-char prompt/output limits.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'sandbox-test-agent',
  description: 'Test agent for sandbox tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('POST /sandbox — basic behavior', () => {
  let server: BridgeServer;
  let app: any;

  // Each describe block gets its own server so sandbox rate limiter is fresh
  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('succeeds without authentication', async () => {
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: 'Say hello' });

    // Should not be 401/403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('returns sandbox response with expected shape', async () => {
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: 'Say hello again' });

    expect(res.body.taskId).toMatch(/^sandbox-/);
    expect(res.body.sandbox).toBe(true);
    expect(res.body.limits).toBeDefined();
    expect(res.body.limits.promptMaxChars).toBe(500);
    expect(res.body.limits.outputMaxChars).toBe(500);
    expect(res.body.limits.requestsPerHour).toBe(3);
    expect(typeof res.body.duration).toBe('number');
  });
});

describe('POST /sandbox — validation', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('rejects prompt over 500 characters', async () => {
    const longPrompt = 'a'.repeat(501);
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: longPrompt });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects empty prompt', async () => {
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: '' });

    expect(res.status).toBe(400);
  });

  it('rejects missing prompt', async () => {
    const res = await request(app)
      .post('/sandbox')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /sandbox — output truncation', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    // Mock the executor to return a long output
    const executor = (server as any).executor;
    executor.execute = vi.fn().mockResolvedValue({
      taskId: 'mock-task',
      status: 'completed',
      output: 'x'.repeat(1000),
      duration: 100,
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('truncates output to 500 chars', async () => {
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: 'Generate long output' });

    expect(res.body.output).toBeDefined();
    expect(res.body.output.length).toBeLessThanOrEqual(500);
    expect(res.body.status).toBe('completed');
  });
});

describe('Sandbox rate limiting', () => {
  it('returns 429 with rich error after exceeding limit', async () => {
    const server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    const app = (server as any).app;

    // The sandbox limiter allows 3 requests per hour
    // Make 3 requests (should all succeed)
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/sandbox')
        .send({ prompt: `Request ${i + 1}` });
    }

    // 4th request should be rate-limited
    const res = await request(app)
      .post('/sandbox')
      .send({ prompt: 'One too many' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.help).toBeDefined();
    expect(res.body.help.authMethods).toEqual(expect.arrayContaining(['bearer', 'x402']));

    await server.stop();
  });
});
