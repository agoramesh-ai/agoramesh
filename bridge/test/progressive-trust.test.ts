/**
 * Progressive Trust Integration Tests
 *
 * Tests that TrustStore is wired into the server: tier info in responses,
 * higher limits for trusted agents, completion/failure recording.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';
import { BridgeServer } from '../src/server.js';
import { TrustStore, TrustTier } from '../src/trust-store.js';
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

function signRequest(privKey: Uint8Array, method: string, path: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}:${method}:${path}`;
  const msgBytes = new TextEncoder().encode(message);
  const sig = ed25519.sign(msgBytes, privKey);
  return { timestamp, signature: Buffer.from(sig).toString('base64url') };
}

function makeDIDAuthHeader(did: string, timestamp: string, signature: string) {
  return `DID ${did}:${timestamp}:${signature}`;
}

const testConfig: AgentConfig = {
  name: 'progressive-trust-test-agent',
  description: 'Test agent for progressive trust',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

// ============================================================================
// Progressive trust wiring
// ============================================================================

describe('Progressive trust — server integration', () => {
  let server: BridgeServer;
  let app: any;
  let trustStore: TrustStore;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'progressive-trust-test-'));

    server = new BridgeServer({
      ...testConfig,
      requireAuth: true,
      apiToken: 'trust-test-secret',
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
    trustStore = (server as any).trustStore;

    // Mock executor
    const executor = (server as any).executor;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'completed',
        output: 'Test output',
        duration: 100,
      }),
    );
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes trust tier in freeTier response info', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'trust-tier-info-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    expect(res.status).toBe(200);
    expect(res.body.freeTier).toBeDefined();
    expect(res.body.freeTier.tier).toBeDefined();
    expect(typeof res.body.freeTier.remaining).toBe('number');
    expect(typeof res.body.freeTier.dailyLimit).toBe('number');
  });

  it('records completion in trust store after task succeeds', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'trust-record-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    // Wait a bit for async task execution to complete
    await new Promise((r) => setTimeout(r, 200));

    const profile = trustStore.getProfile(did);
    expect(profile.completedTasks).toBe(1);
  });

  it('records failure in trust store after task fails', async () => {
    // Override executor to return failure
    const executor = (server as any).executor;
    const savedExecute = executor.execute;
    executor.execute = vi.fn().mockImplementation((task: any) =>
      Promise.resolve({
        taskId: task.taskId,
        status: 'failed',
        error: 'Something went wrong',
        duration: 50,
      }),
    );

    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'trust-record-fail-1',
        type: 'prompt',
        prompt: 'Hello world',
        clientDid: did,
      });

    await new Promise((r) => setTimeout(r, 200));

    const profile = trustStore.getProfile(did);
    expect(profile.failedTasks).toBe(1);

    executor.execute = savedExecute;
  });

  it('uses trust-based daily limit instead of hardcoded 10', async () => {
    const { privKey, did } = generateTestDID();

    // Manually set this DID as FAMILIAR in the trust store (25/day limit)
    // by faking the firstSeen and adding completions
    const profile = trustStore.getProfile(did);
    profile.firstSeen = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    profile.completedTasks = 10;

    // Verify it's FAMILIAR tier with 25/day limit
    const limits = trustStore.getLimitsForDID(did);
    expect(limits.dailyLimit).toBe(25);

    // Make 11 requests (would fail at 10 for NEW tier)
    for (let i = 0; i < 11; i++) {
      const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
      const authHeader = makeDIDAuthHeader(did, timestamp, signature);

      const res = await request(app)
        .post('/task')
        .set('Authorization', authHeader)
        .send({
          taskId: `trust-limit-${i}`,
          type: 'prompt',
          prompt: 'Hello',
          clientDid: did,
        });

      expect(res.status).toBe(200);
    }

    // The 12th request should still succeed (under 25)
    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'trust-limit-extra',
        type: 'prompt',
        prompt: 'Hello',
        clientDid: did,
      });

    expect(res.status).toBe(200);
    expect(res.body.freeTier.dailyLimit).toBe(25);
  });

  it('includes tier name in freeTier response for familiar agent', async () => {
    const { privKey, did } = generateTestDID();

    // Make this DID familiar
    const profile = trustStore.getProfile(did);
    profile.firstSeen = Date.now() - 8 * 24 * 60 * 60 * 1000;
    profile.completedTasks = 10;

    const { timestamp, signature } = signRequest(privKey, 'POST', '/task');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    const res = await request(app)
      .post('/task')
      .set('Authorization', authHeader)
      .send({
        taskId: 'trust-tier-name-1',
        type: 'prompt',
        prompt: 'Hello',
        clientDid: did,
      });

    expect(res.body.freeTier.tier).toBe('familiar');
  });

  it('A2A endpoint also records trust after task', async () => {
    const { privKey, did } = generateTestDID();
    const { timestamp, signature } = signRequest(privKey, 'POST', '/');
    const authHeader = makeDIDAuthHeader(did, timestamp, signature);

    await request(app)
      .post('/')
      .set('Authorization', authHeader)
      .send({
        jsonrpc: '2.0',
        id: 'a2a-trust-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
          },
        },
      });

    await new Promise((r) => setTimeout(r, 200));

    const profile = trustStore.getProfile(did);
    expect(profile.completedTasks).toBeGreaterThanOrEqual(1);
  });
});
