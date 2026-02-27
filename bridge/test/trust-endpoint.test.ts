import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-agent',
  description: 'Test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Trust Endpoint', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({ ...testConfig, nodeUrl: 'https://api.agoramesh.ai' });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('GET /trust/:did', () => {
    it('returns local trust data for known DID', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app).get('/trust/did:key:z6MkTest');

      expect(res.status).toBe(200);
      expect(res.body.did).toBe('did:key:z6MkTest');
      expect(res.body.local).toBeDefined();
      expect(res.body.local.tier).toBe('new');
      expect(res.body.local.completions).toBe(0);
      expect(res.body.local.dailyLimit).toBe(10);
    });

    it('returns both local and network trust when P2P node is available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          did: 'did:key:z6MkTest2',
          score: 0.72,
          reputation: 0.8,
          stake_score: 0.6,
          endorsement_score: 0.5,
        }),
      });

      const res = await request(app).get('/trust/did:key:z6MkTest2');

      expect(res.status).toBe(200);
      expect(res.body.local).toBeDefined();
      expect(res.body.network).toBeDefined();
      expect(res.body.network.overall).toBe(0.72);
      expect(res.body.network.reputation).toBe(0.8);
      expect(res.body.network.stake).toBe(0.6);
      expect(res.body.network.endorsement).toBe(0.5);
    });

    it('returns network: null when P2P node is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app).get('/trust/did:key:z6MkTest3');

      expect(res.status).toBe(200);
      expect(res.body.local).toBeDefined();
      expect(res.body.network).toBeNull();
    });

    it('does not require authentication', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      const res = await request(app).get('/trust/did:key:z6MkAnon');

      expect(res.status).toBe(200);
    });
  });
});

describe('Trust Endpoint — no nodeUrl', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer(testConfig);
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns only local trust data when nodeUrl not configured', async () => {
    const res = await request(app).get('/trust/did:key:z6MkLocal');

    expect(res.status).toBe(200);
    expect(res.body.local).toBeDefined();
    expect(res.body.network).toBeNull();
  });
});
