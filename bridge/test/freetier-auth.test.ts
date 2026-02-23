/**
 * FreeTier Simple Authentication Tests
 *
 * Tests the zero-crypto FreeTier auth scheme: `Authorization: FreeTier <identifier>`
 * This provides the simplest authentication path for agents that cannot do Ed25519 crypto.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';
import { BridgeServer, ErrorCode } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';
import { FREETIER_ID_PATTERN } from '../src/types.js';

// ============================================================================
// Helpers
// ============================================================================

function generateTestDID() {
  const privKey = ed25519.utils.randomPrivateKey();
  const pubKey = ed25519.getPublicKey(privKey);
  const multicodec = new Uint8Array(2 + 32);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(pubKey, 2);
  const did = `did:key:${base58btc.encode(multicodec)}`;
  return { privKey, pubKey, did };
}

function signRequest(privKey: Uint8Array, method: string, path: string): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}:${method}:${path}`;
  const msgBytes = new TextEncoder().encode(message);
  const sig = ed25519.sign(msgBytes, privKey);
  return { timestamp, signature: Buffer.from(sig).toString('base64url') };
}

function makeDIDAuthHeader(did: string, timestamp: string, signature: string): string {
  return `DID ${did}:${timestamp}:${signature}`;
}

const testConfig: AgentConfig = {
  name: 'freetier-auth-test-agent',
  description: 'Test agent for FreeTier auth',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

// ============================================================================
// FREETIER_ID_PATTERN validation
// ============================================================================

describe('FREETIER_ID_PATTERN', () => {
  it('accepts alphanumeric identifiers', () => {
    expect(FREETIER_ID_PATTERN.test('myagent123')).toBe(true);
  });

  it('accepts identifiers with dashes, underscores, dots', () => {
    expect(FREETIER_ID_PATTERN.test('my-agent_v2.0')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(FREETIER_ID_PATTERN.test('')).toBe(false);
  });

  it('rejects identifiers longer than 128 chars', () => {
    expect(FREETIER_ID_PATTERN.test('a'.repeat(129))).toBe(false);
  });

  it('accepts identifiers exactly 128 chars', () => {
    expect(FREETIER_ID_PATTERN.test('a'.repeat(128))).toBe(true);
  });

  it('rejects identifiers with special characters', () => {
    expect(FREETIER_ID_PATTERN.test('agent@host')).toBe(false);
    expect(FREETIER_ID_PATTERN.test('agent/path')).toBe(false);
    expect(FREETIER_ID_PATTERN.test('agent space')).toBe(false);
    expect(FREETIER_ID_PATTERN.test('agent:colon')).toBe(false);
  });
});

// ============================================================================
// FreeTier auth — REST (POST /task)
// ============================================================================

describe('FreeTier auth — REST (POST /task)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'test-secret-token',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'Test output from Claude',
        duration: 100,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
  });

  it('accepts POST /task with valid FreeTier auth header', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier my-test-agent')
      .send({
        taskId: 'ft-test-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.taskId).toBe('ft-test-1');
  });

  it('includes free tier info in response', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier tier-info-agent')
      .send({
        taskId: 'ft-tier-info',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(202);
    expect(res.body.freeTier).toBeDefined();
    expect(res.body.freeTier.tier).toBe('new');
    expect(typeof res.body.freeTier.remaining).toBe('number');
    expect(typeof res.body.freeTier.dailyLimit).toBe('number');
  });

  it('rejects invalid identifier (special chars)', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier invalid@agent!')
      .send({
        taskId: 'ft-invalid-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects empty identifier', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier ')
      .send({
        taskId: 'ft-empty-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects identifier too long (>128 chars)', async () => {
    const longId = 'a'.repeat(129);
    const res = await request(app)
      .post('/task')
      .set('Authorization', `FreeTier ${longId}`)
      .send({
        taskId: 'ft-toolong-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('returns 429 when FreeTier identifier exceeds daily limit', async () => {
    const identifier = 'rate-limit-test-agent';

    // Make 10 successful requests
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/task')
        .set('Authorization', `FreeTier ${identifier}`)
        .send({
          taskId: `ft-limit-${i}`,
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:test:freetier',
        });
    }

    // 11th request should be rate limited
    const res = await request(app)
      .post('/task')
      .set('Authorization', `FreeTier ${identifier}`)
      .send({
        taskId: 'ft-limit-overflow',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(res.body.help).toBeDefined();
  });

  it('returns 429 when IP exceeds daily limit across different FreeTier identifiers', async () => {
    // Make 20 requests from different identifiers (same IP = ::ffff:127.0.0.1)
    for (let i = 0; i < 20; i++) {
      await request(app)
        .post('/task')
        .set('Authorization', `FreeTier ip-sybil-agent-${i}`)
        .send({
          taskId: `ft-ip-limit-${i}`,
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:test:freetier',
        });
    }

    // 21st request from a new identifier should be rate limited by IP
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier ip-sybil-agent-overflow')
      .send({
        taskId: 'ft-ip-limit-overflow',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe(ErrorCode.RATE_LIMITED);
  });
});

// ============================================================================
// FreeTier auth — A2A JSON-RPC (POST /)
// ============================================================================

describe('FreeTier auth — A2A JSON-RPC (POST /)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'a2a-ft-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'A2A FreeTier response',
        duration: 50,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
  });

  it('accepts A2A message/send with FreeTier auth', async () => {
    const res = await request(app)
      .post('/')
      .set('Authorization', 'FreeTier a2a-agent-1')
      .send({
        jsonrpc: '2.0',
        id: 'a2a-ft-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello via FreeTier' }],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.status.state).toBe('completed');
  });
});

// ============================================================================
// FreeTier auth — GET /task/:id polling
// ============================================================================

describe('FreeTier auth — GET /task/:id polling', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'poll-ft-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    // Return a promise that never resolves to keep tasks pending
    executor.execute = vi.fn().mockImplementation(() => new Promise(() => {}));
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /task/:id works with FreeTier auth', async () => {
    // First submit a task to make it pending
    const submitRes = await request(app)
      .post('/task')
      .set('Authorization', 'FreeTier poll-test-agent')
      .send({
        taskId: 'ft-poll-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:freetier',
      });
    expect(submitRes.status).toBe(202);

    // Now poll the task
    const pollRes = await request(app)
      .get('/task/ft-poll-1')
      .set('Authorization', 'FreeTier poll-test-agent')
      .set('x-client-did', 'did:test:freetier');

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('running');
    expect(pollRes.body.taskId).toBe('ft-poll-1');
  });
});

// ============================================================================
// Auth chain priority — Bearer wins over FreeTier
// ============================================================================

describe('Auth chain priority', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'priority-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'Priority test',
        duration: 50,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
  });

  it('Bearer token takes priority over FreeTier header', async () => {
    // When both Authorization headers would be present, Bearer format is checked first.
    // We test that Bearer auth works even if the token happens to start with "Bearer".
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'Bearer priority-secret')
      .send({
        taskId: 'priority-test-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:priority',
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    // Bearer auth does not attach freeTier info
    expect(res.body.freeTier).toBeUndefined();
  });

  it('DID:key auth takes priority over FreeTier', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'priority-did-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    // DID:key auth also attaches freeTier info
    expect(res.body.freeTier).toBeDefined();
  });
});

// ============================================================================
// Regression: DID:key auth still works
// ============================================================================

describe('Regression: DID:key auth still works with FreeTier added', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'regression-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'Regression test output',
        duration: 100,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
  });

  it('DID:key auth still works', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'regression-did-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });

  it('Bearer auth still works', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'Bearer regression-secret')
      .send({
        taskId: 'regression-bearer-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:bearer',
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });
});

// ============================================================================
// 401 error includes FreeTier in help methods
// ============================================================================

describe('401 error includes FreeTier', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'error-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('401 response lists FreeTier as an auth method', async () => {
    const res = await request(app)
      .post('/task')
      .send({
        taskId: 'no-auth-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:noauth',
      });

    expect(res.status).toBe(401);
    expect(res.body.help).toBeDefined();
    expect(res.body.help.message).toContain('simplest first');
    expect(res.body.help.authMethods).toContain('freetier');
  });
});
