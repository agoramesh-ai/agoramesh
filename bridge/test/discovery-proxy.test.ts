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

// Mock global fetch for P2P node proxy tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Discovery Proxy', () => {
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

  describe('GET /discovery/agents', () => {
    it('proxies semantic search to P2P node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ did: 'did:test:1', name: 'Agent 1', score: 0.9 }],
      });

      const res = await request(app).get('/discovery/agents?q=translate&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].did).toBe('did:test:1');
      expect(res.body.source).toBe('network');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/semantic?q=translate&limit=5'),
        expect.any(Object),
      );
    });

    it('passes minTrust and maxPrice to node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await request(app).get('/discovery/agents?q=code&minTrust=0.8&maxPrice=0.05');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('minTrust=0.8'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('maxPrice=0.05'),
        expect.any(Object),
      );
    });

    it('returns 503 when P2P node is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 502 when P2P node returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('BAD_GATEWAY');
    });

    it('does not require authentication', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(200);
    });
  });

  describe('GET /discovery/agents/:did', () => {
    it('proxies agent lookup to P2P node', async () => {
      const card = { did: 'did:test:1', name: 'Agent 1', skills: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => card,
      });

      const res = await request(app).get('/discovery/agents/did:test:1');

      expect(res.status).toBe(200);
      expect(res.body.did).toBe('did:test:1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/did:test:1'),
        expect.any(Object),
      );
    });

    it('returns 404 when agent not found on node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const res = await request(app).get('/discovery/agents/did:test:unknown');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /discovery/search', () => {
    it('maps JSON body to semantic search', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ did: 'did:test:1', score: 0.95 }],
      });

      const res = await request(app)
        .post('/discovery/search')
        .send({ query: 'translate legal docs', minTrust: 0.8, maxPrice: '0.05', limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/semantic?q=translate+legal+docs'),
        expect.any(Object),
      );
    });

    it('returns 400 when query is missing', async () => {
      const res = await request(app)
        .post('/discovery/search')
        .send({ minTrust: 0.8 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('Discovery Proxy — no nodeUrl configured', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer(testConfig); // no nodeUrl
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns 503 when nodeUrl is not configured', async () => {
    const res = await request(app).get('/discovery/agents?q=test');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.help.message).toContain('not configured');
  });
});
