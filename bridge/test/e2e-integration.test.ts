/**
 * End-to-End Integration Tests
 *
 * Tests the full task lifecycle through the BridgeServer:
 * - REST API task submission with x402 payment
 * - WebSocket task submission with authentication
 * - Escrow validation integration (mock escrow client)
 * - Rate limiting behavior across multiple rapid requests
 * - Error cascades (invalid payment then valid payment)
 * - Agent card + health check integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { generatePrivateKey } from 'viem/accounts';
import { BridgeServer, type BridgeServerConfig } from '../src/server.js';
import { EscrowClient, EscrowState, type EscrowValidation } from '../src/escrow.js';
import {
  createX402Middleware,
  createSignedPaymentPayload,
  createTestPaymentPayload,
  _resetUsedNonces,
  X402_HEADERS,
  type X402Config,
} from '../src/middleware/x402.js';
import type { AgentConfig } from '../src/types.js';

// =============================================================================
// Shared test configuration
// =============================================================================

const baseAgentConfig: AgentConfig = {
  name: 'e2e-test-agent',
  description: 'Integration test agent for end-to-end workflows',
  skills: ['coding', 'debugging', 'testing'],
  pricePerTask: 0.01,
  privateKey: '0xdeadbeef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 30,
};

const x402Config: X402Config = {
  payTo: '0x1234567890123456789012345678901234567890',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  priceUsdc: 0.01,
  network: 'eip155:8453',
  validityPeriod: 300,
};

function createValidTask(overrides?: Record<string, unknown>) {
  return {
    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'prompt',
    prompt: 'Write hello world in TypeScript',
    clientDid: 'did:agoramesh:base:0xabc123',
    ...overrides,
  };
}

// =============================================================================
// 1. Full task lifecycle via REST API
// =============================================================================

describe('E2E: REST API task lifecycle', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('submits a valid task and receives acknowledgement', async () => {
    const task = createValidTask();
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.taskId).toBe(task.taskId);
    expect(res.body.estimatedTime).toBe(30);
  });

  it('queries task status after submission', async () => {
    const task = createValidTask();
    await request(app).post('/task').send(task);

    const res = await request(app)
      .get(`/task/${task.taskId}`)
      .set('x-client-did', task.clientDid);

    // Task may already be running or completed; we just check it's accessible
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.taskId).toBe(task.taskId);
      expect(res.body.status).toBe('running');
    }
  });

  it('rejects task status query with wrong clientDid', async () => {
    const task = createValidTask();
    await request(app).post('/task').send(task);

    const res = await request(app)
      .get(`/task/${task.taskId}`)
      .set('x-client-did', 'did:agoramesh:base:0xwrongclient');

    // Should return 403 (forbidden) if the task is still pending, or 404 if already completed
    expect([403, 404]).toContain(res.status);
  });

  it('rejects task status query without clientDid header', async () => {
    const task = createValidTask();
    await request(app).post('/task').send(task);

    const res = await request(app).get(`/task/${task.taskId}`);

    expect([403, 404]).toContain(res.status);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app)
      .get('/task/nonexistent-task-id')
      .set('x-client-did', 'did:agoramesh:base:0xabc');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found or completed');
  });

  it('rejects task with missing required fields', async () => {
    const res = await request(app)
      .post('/task')
      .send({ taskId: 'test-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects task with invalid type', async () => {
    const task = createValidTask({ type: 'malicious-type' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(400);
  });

  it('rejects task with oversized prompt', async () => {
    const task = createValidTask({ prompt: 'x'.repeat(200000) });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(400);
  });

  it('rejects task with invalid taskId characters', async () => {
    const task = createValidTask({ taskId: 'task/../../../etc/passwd' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(400);
  });

  it('rejects task with invalid DID format', async () => {
    const task = createValidTask({ clientDid: 'not-a-did' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(400);
  });
});

// =============================================================================
// 2. Full task lifecycle via WebSocket with auth
// =============================================================================

describe('E2E: WebSocket task lifecycle with auth', () => {
  let server: BridgeServer;
  let port: number;
  const WS_AUTH_TOKEN = 'test-secret-token-12345';

  beforeAll(async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      wsAuthToken: WS_AUTH_TOKEN,
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('rejects WebSocket connection without auth token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve) => {
      let rejected = false;
      ws.on('error', () => {
        rejected = true;
      });
      ws.on('close', () => {
        // Connection was rejected by verifyClient callback.
        // The ws client sees 1006 (abnormal close) because the HTTP upgrade
        // is rejected before the WebSocket handshake completes.
        expect(rejected).toBe(true);
        resolve();
      });
    });
  });

  it('rejects WebSocket connection with wrong auth token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });

    await new Promise<void>((resolve) => {
      let rejected = false;
      ws.on('error', () => {
        rejected = true;
      });
      ws.on('close', () => {
        expect(rejected).toBe(true);
        resolve();
      });
    });
  });

  it('accepts WebSocket connection with valid auth token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${WS_AUTH_TOKEN}` },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('submits task via WebSocket and receives error response', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${WS_AUTH_TOKEN}` },
    });

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket response timeout'));
      }, 10000);

      ws.on('open', () => {
        const task = createValidTask();
        ws.send(JSON.stringify({
          type: 'task',
          payload: task,
        }));
      });

      ws.on('message', (data) => {
        clearTimeout(timeout);
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // The task will fail because claude is not available in tests,
    // but we verify the full message round-trip
    expect(response.type).toMatch(/^(result|error)$/);
  });

  it('returns validation error for malformed WebSocket message', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${WS_AUTH_TOKEN}` },
    });

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket response timeout'));
      }, 5000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'task',
          payload: { taskId: 'bad-task' }, // Missing required fields
        }));
      });

      ws.on('message', (data) => {
        clearTimeout(timeout);
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(response.type).toBe('error');
    expect(response.code).toBeDefined();
  });

  it('rejects non-JSON WebSocket message gracefully', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${WS_AUTH_TOKEN}` },
    });

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket response timeout'));
      }, 5000);

      ws.on('open', () => {
        ws.send('not-json-at-all');
      });

      ws.on('message', (data) => {
        clearTimeout(timeout);
        const msg = JSON.parse(data.toString());
        ws.close();
        resolve(msg);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(response.type).toBe('error');
  });
});

// =============================================================================
// 3. Escrow validation integration (mock escrow client)
// =============================================================================

describe('E2E: Escrow validation integration', () => {
  let server: BridgeServer;
  let app: any;

  function createMockEscrowClient(overrides?: Partial<EscrowClient>) {
    return {
      validateEscrow: vi.fn().mockResolvedValue({ valid: true }),
      confirmDelivery: vi.fn().mockResolvedValue('0xtxhash'),
      getEscrow: vi.fn().mockResolvedValue(null),
      getEscrowResult: vi.fn().mockResolvedValue({ success: false }),
      ...overrides,
    } as unknown as EscrowClient;
  }

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('accepts task with valid escrow', async () => {
    const mockEscrow = createMockEscrowClient({
      validateEscrow: vi.fn().mockResolvedValue({ valid: true }),
    });

    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      escrowClient: mockEscrow,
      providerDid: '0xprovider123',
    });
    app = (server as any).app;

    const task = createValidTask({ escrowId: '42' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(mockEscrow.validateEscrow).toHaveBeenCalledWith(
      42n,
      '0xprovider123',
    );

    await server.stop();
  });

  it('rejects task when escrow is not funded', async () => {
    const mockEscrow = createMockEscrowClient({
      validateEscrow: vi.fn().mockResolvedValue({
        valid: false,
        error: 'Invalid escrow state: AWAITING_DEPOSIT. Expected: FUNDED',
      }),
    });

    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      escrowClient: mockEscrow,
      providerDid: '0xprovider123',
    });
    app = (server as any).app;

    const task = createValidTask({ escrowId: '99' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('Escrow Validation Failed');
    expect(res.body.message).toContain('AWAITING_DEPOSIT');

    await server.stop();
  });

  it('rejects task when escrow provider DID mismatches', async () => {
    const mockEscrow = createMockEscrowClient({
      validateEscrow: vi.fn().mockResolvedValue({
        valid: false,
        error: 'Provider DID mismatch',
      }),
    });

    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      escrowClient: mockEscrow,
      providerDid: '0xprovider123',
    });
    app = (server as any).app;

    const task = createValidTask({ escrowId: '50' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(402);
    expect(res.body.message).toContain('Provider DID mismatch');

    await server.stop();
  });

  it('rejects task when escrow deadline has passed', async () => {
    const mockEscrow = createMockEscrowClient({
      validateEscrow: vi.fn().mockResolvedValue({
        valid: false,
        error: 'Escrow deadline has passed',
      }),
    });

    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      escrowClient: mockEscrow,
      providerDid: '0xprovider123',
    });
    app = (server as any).app;

    const task = createValidTask({ escrowId: '77' });
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(402);
    expect(res.body.message).toContain('deadline');

    await server.stop();
  });

  it('accepts task without escrowId even when escrow client is configured', async () => {
    const mockEscrow = createMockEscrowClient();

    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      escrowClient: mockEscrow,
      providerDid: '0xprovider123',
    });
    app = (server as any).app;

    const task = createValidTask(); // No escrowId
    const res = await request(app).post('/task').send(task);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    // validateEscrow should NOT be called when no escrowId provided
    expect(mockEscrow.validateEscrow).not.toHaveBeenCalled();

    await server.stop();
  });

  it('accepts task with escrowId when no escrow client is configured', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      // No escrowClient - escrow validation is skipped
    });
    app = (server as any).app;

    const task = createValidTask({ escrowId: '42' });
    const res = await request(app).post('/task').send(task);

    // Should accept since no escrow client to validate against
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    await server.stop();
  });
});

// =============================================================================
// 4. Rate limiting behavior across multiple rapid requests
// =============================================================================

describe('E2E: Rate limiting behavior', () => {
  let server: BridgeServer;
  let app: any;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('allows requests under the rate limit', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: {
        enabled: true,
        maxRequests: 10,
        windowMs: 60000,
      },
    });
    app = (server as any).app;

    // Send 5 requests (under the limit of 10)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app).post('/task').send(createValidTask({ taskId: `rate-ok-${i}` }))
      ),
    );

    // All should be accepted
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    await server.stop();
  });

  it('rejects requests exceeding rate limit', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: {
        enabled: true,
        maxRequests: 3,
        windowMs: 60000,
      },
    });
    app = (server as any).app;

    // Send 5 requests (over the limit of 3)
    const results: request.Response[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/task')
        .send(createValidTask({ taskId: `rate-limited-${i}` }));
      results.push(res);
    }

    // First 3 should succeed, rest should be rate limited
    const successCount = results.filter((r) => r.status === 200).length;
    const rateLimitedCount = results.filter((r) => r.status === 429).length;

    expect(successCount).toBe(3);
    expect(rateLimitedCount).toBe(2);

    await server.stop();
  });

  it('does not rate limit health endpoint', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: {
        enabled: true,
        maxRequests: 2,
        windowMs: 60000,
      },
    });
    app = (server as any).app;

    // Send many health checks - should all pass
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get('/health')),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    }

    await server.stop();
  });

  it('returns rate limit headers', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: {
        enabled: true,
        maxRequests: 100,
        windowMs: 60000,
      },
    });
    app = (server as any).app;

    const res = await request(app)
      .post('/task')
      .send(createValidTask());

    // express-rate-limit sets standard headers
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();

    await server.stop();
  });
});

// =============================================================================
// 5. Error cascades: invalid payment then retry with valid payment
// =============================================================================

describe('E2E: x402 payment error cascade and retry', () => {
  let server: BridgeServer;
  let app: any;

  beforeEach(() => {
    _resetUsedNonces();
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('returns 402 without payment, then accepts with valid signed payment', async () => {
    // Create a server that just uses x402 middleware (not BridgeServer)
    // to test the payment flow in isolation
    const express = (await import('express')).default;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(createX402Middleware(x402Config));
    testApp.post('/task', (req, res) => {
      res.json({ success: true, taskId: req.body.taskId });
    });

    // Step 1: Request without payment -> 402
    const noPaymentRes = await request(testApp)
      .post('/task')
      .send(createValidTask());

    expect(noPaymentRes.status).toBe(402);
    expect(noPaymentRes.body.error).toBe('Payment Required');
    expect(noPaymentRes.body.paymentInfo).toBeDefined();
    expect(noPaymentRes.body.paymentInfo.payTo).toBe(x402Config.payTo);

    // Step 2: Retry with valid signed payment -> 200
    const privateKey = generatePrivateKey();
    const payment = await createSignedPaymentPayload(x402Config, privateKey);
    const encodedPayment = Buffer.from(JSON.stringify(payment)).toString('base64');

    const validPaymentRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, encodedPayment)
      .send(createValidTask());

    expect(validPaymentRes.status).toBe(200);
    expect(validPaymentRes.body.success).toBe(true);
  });

  it('rejects with malformed payment, then accepts with valid payment', async () => {
    const express = (await import('express')).default;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(createX402Middleware(x402Config));
    testApp.post('/task', (req, res) => {
      res.json({ success: true });
    });

    // Step 1: Malformed payment -> 400
    const badRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, 'not-base64!!!')
      .send(createValidTask());

    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toBe('Invalid Payment');

    // Step 2: Valid payment -> 200
    const privateKey = generatePrivateKey();
    const payment = await createSignedPaymentPayload(x402Config, privateKey);
    const encoded = Buffer.from(JSON.stringify(payment)).toString('base64');

    const goodRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, encoded)
      .send(createValidTask());

    expect(goodRes.status).toBe(200);
  });

  it('rejects insufficient payment, then accepts with correct amount', async () => {
    const express = (await import('express')).default;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(createX402Middleware(x402Config));
    testApp.post('/task', (req, res) => {
      res.json({ success: true });
    });

    // Step 1: Insufficient amount (use test payload which has mock signature)
    const lowPayment = createTestPaymentPayload({ ...x402Config, priceUsdc: 0.001 });
    lowPayment.amount = '1'; // 0.000001 USDC - way too low
    const lowEncoded = Buffer.from(JSON.stringify(lowPayment)).toString('base64');

    const lowRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, lowEncoded)
      .send(createValidTask());

    expect(lowRes.status).toBe(402);
    expect(lowRes.body.error).toBe('Payment Invalid');

    // Step 2: Correct amount with real signature -> 200
    const privateKey = generatePrivateKey();
    const payment = await createSignedPaymentPayload(x402Config, privateKey);
    const encoded = Buffer.from(JSON.stringify(payment)).toString('base64');

    const goodRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, encoded)
      .send(createValidTask());

    expect(goodRes.status).toBe(200);
  });

  it('rejects expired payment, then accepts with fresh payment', async () => {
    const express = (await import('express')).default;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(createX402Middleware(x402Config));
    testApp.post('/task', (req, res) => {
      res.json({ success: true });
    });

    // Step 1: Expired payment
    const expiredPayment = createTestPaymentPayload(x402Config);
    expiredPayment.timestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const expiredEncoded = Buffer.from(JSON.stringify(expiredPayment)).toString('base64');

    const expiredRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, expiredEncoded)
      .send(createValidTask());

    expect(expiredRes.status).toBe(402);
    expect(expiredRes.body.message).toContain('expired');

    // Step 2: Fresh payment -> 200
    const privateKey = generatePrivateKey();
    const freshPayment = await createSignedPaymentPayload(x402Config, privateKey);
    const freshEncoded = Buffer.from(JSON.stringify(freshPayment)).toString('base64');

    const freshRes = await request(testApp)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, freshEncoded)
      .send(createValidTask());

    expect(freshRes.status).toBe(200);
  });
});

// =============================================================================
// 6. Agent card + health check integration
// =============================================================================

describe('E2E: Agent card and health check', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns health status with agent name', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.agent).toBe('e2e-test-agent');
  });

  it('does not expose pendingTasks in health response', async () => {
    const res = await request(app).get('/health');

    expect(res.body.pendingTasks).toBeUndefined();
  });

  it('returns well-formed capability card at standard endpoint', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('e2e-test-agent');
    expect(res.body.description).toBe('Integration test agent for end-to-end workflows');
    expect(res.body.skills).toEqual([
      { id: 'coding', name: 'coding' },
      { id: 'debugging', name: 'debugging' },
      { id: 'testing', name: 'testing' },
    ]);
    expect(res.body.payment.defaultPricing.model).toBe('per_request');
    expect(res.body.payment.defaultPricing.amount).toBe('0.01');
    expect(res.body.payment.defaultPricing.currency).toBe('USDC');
    expect(res.body.protocolVersion).toBe('1.0');
    expect(res.body.version).toBe('1.0.0');
  });

  it('returns correct content-type for agent card', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('can retrieve agent card and health in parallel', async () => {
    const [healthRes, cardRes] = await Promise.all([
      request(app).get('/health'),
      request(app).get('/.well-known/agent.json'),
    ]);

    expect(healthRes.status).toBe(200);
    expect(cardRes.status).toBe(200);
    expect(healthRes.body.agent).toBe(cardRes.body.name);
  });

  it('returns security headers (helmet)', async () => {
    const res = await request(app).get('/health');

    // helmet sets various security headers
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

// =============================================================================
// 7. WebSocket origin validation
// =============================================================================

describe('E2E: WebSocket origin validation', () => {
  let server: BridgeServer;
  let port: number;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('rejects WebSocket connection from disallowed origin', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      allowedOrigins: ['http://localhost:3402'],
    });
    await server.start(0);
    port = server.getPort();

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: 'http://evil.example.com' },
    });

    await new Promise<void>((resolve) => {
      let rejected = false;
      ws.on('error', () => {
        rejected = true;
      });
      ws.on('close', () => {
        // verifyClient rejects before handshake completes
        expect(rejected).toBe(true);
        resolve();
      });
    });

    await server.stop();
  });
});

// =============================================================================
// 8. Task cancellation via REST
// =============================================================================

describe('E2E: Task cancellation', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns 404 for cancellation of unknown task', async () => {
    const res = await request(app)
      .delete('/task/unknown-task-id')
      .set('x-client-did', 'did:agoramesh:base:0xabc');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  it('rejects cancellation without clientDid', async () => {
    const task = createValidTask();
    await request(app).post('/task').send(task);

    const res = await request(app).delete(`/task/${task.taskId}`);

    // Should return 403 (forbidden) or 404 (task already completed)
    expect([403, 404]).toContain(res.status);
  });

  it('rejects cancellation with wrong clientDid', async () => {
    const task = createValidTask();
    await request(app).post('/task').send(task);

    const res = await request(app)
      .delete(`/task/${task.taskId}`)
      .set('x-client-did', 'did:agoramesh:base:0xwrongclient');

    // Should return 403 (forbidden) or 404 (task already completed)
    expect([403, 404]).toContain(res.status);
  });
});

// =============================================================================
// 9. Body size limit enforcement
// =============================================================================

describe('E2E: Body size limits', () => {
  let server: BridgeServer;
  let app: any;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('rejects requests exceeding body size limit', async () => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
      bodyLimit: '1kb',
    });
    app = (server as any).app;

    // Send a very large body
    const res = await request(app)
      .post('/task')
      .send({
        taskId: 'large-body-test',
        type: 'prompt',
        prompt: 'x'.repeat(2000),
        clientDid: 'did:agoramesh:base:0xabc',
      });

    // Should be rejected by express body parser (413) or validation (400)
    expect([400, 413]).toContain(res.status);

    await server.stop();
  });
});

// =============================================================================
// 10. Multiple concurrent task submissions
// =============================================================================

describe('E2E: Concurrent task submissions', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer({
      ...baseAgentConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('accepts multiple concurrent tasks with unique IDs', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      createValidTask({ taskId: `concurrent-${i}` })
    );

    const results = await Promise.all(
      tasks.map((task) => request(app).post('/task').send(task)),
    );

    for (let i = 0; i < results.length; i++) {
      expect(results[i].status).toBe(200);
      expect(results[i].body.accepted).toBe(true);
      expect(results[i].body.taskId).toBe(`concurrent-${i}`);
    }
  });
});
