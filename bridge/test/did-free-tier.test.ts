/**
 * DID:key Free Tier — End-to-end Integration Tests
 *
 * Tests DID:key authentication flowing through the actual server
 * for both REST (POST /task) and A2A JSON-RPC (POST /) endpoints.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';
import { BridgeServer, ErrorCode } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

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
  name: 'did-free-tier-test-agent',
  description: 'Test agent for DID free tier',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

// ============================================================================
// REST endpoint (POST /task) with DID:key auth
// ============================================================================

describe('DID:key free tier — REST (POST /task)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    // requireAuth: true but ONLY x402 (no apiToken) → DID auth is the only non-paid path
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'test-secret-token',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    // Mock executor to return quickly
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

  it('accepts POST /task with valid DID:key auth header', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'did-test-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.taskId).toBe('did-test-1');
  });

  it('rejects DID auth with expired timestamp', async () => {
    const { privKey, did } = generateTestDID();
    // Sign with timestamp 10 minutes ago
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const message = `${timestamp}:POST:/task`;
    const msgBytes = new TextEncoder().encode(message);
    const sig = ed25519.sign(msgBytes, privKey);
    const signature = Buffer.from(sig).toString('base64url');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'did-test-expired',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects DID auth with invalid signature', async () => {
    const { did } = generateTestDID();
    const otherKey = ed25519.utils.randomPrivateKey();
    const { timestamp, signature } = signRequest(otherKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'did-test-invalid-sig',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('returns 429 when DID exceeds daily limit', async () => {
    const { privKey, did } = generateTestDID();

    // Make 10 successful requests
    for (let i = 0; i < 10; i++) {
      const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
      const authHeader = makeDIDAuthHeader(did, timestamp, signature);

      await request(app)
        .post('/task')
        .set('Authorization', authHeader)
        .send({
          taskId: `did-limit-test-${i}`,
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: did,
        });
    }

    // 11th request should be rate limited
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'did-limit-test-overflow',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(res.body.help).toBeDefined();
  });

  it('still allows Bearer token auth alongside DID auth', async () => {
    const res = await request(app)
      .post('/task')
      .set('Authorization', 'Bearer test-secret-token')
      .send({
        taskId: 'bearer-alongside-did',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:bearer',
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });

  it('includes free tier info in response', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'did-tier-info',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(202);
    expect(res.body.freeTier).toBeDefined();
    expect(res.body.freeTier.tier).toBe('new');
    expect(typeof res.body.freeTier.remaining).toBe('number');
  });
});

// ============================================================================
// A2A JSON-RPC (POST /) with DID:key auth
// ============================================================================

describe('DID:key free tier — A2A JSON-RPC (POST /)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'a2a-did-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'A2A response',
        duration: 50,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
  });

  it('accepts A2A message/send with DID:key auth', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/')
      .set('Authorization', authHeader)
      .send({
        jsonrpc: '2.0',
        id: 'a2a-did-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello via DID' }],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(res.body.result.status.state).toBe('completed');
  });

  it('rejects A2A request with invalid DID auth', async () => {
    const { did } = generateTestDID();
    const authHeader = `DID ${did}:0:invalid_signature`;

    const res = await request(app)
      .post('/')
      .set('Authorization', authHeader)
      .send({
        jsonrpc: '2.0',
        id: 'a2a-did-invalid',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
          },
        },
      });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
  });
});

// ============================================================================
// No auth mode — DID auth not needed
// ============================================================================

describe('DID:key free tier — no auth mode', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      requireAuth: false,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('POST /task works without any auth when requireAuth is false', async () => {
    const executor = (server as any).executor;
    executor.execute = vi.fn().mockResolvedValueOnce({
      taskId: 'no-auth-task',
      status: 'completed',
      output: 'No auth needed',
      duration: 50,
    });

    const res = await request(app)
      .post('/task')
      .send({
        taskId: 'no-auth-task',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: 'did:test:noauth',
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });
});
