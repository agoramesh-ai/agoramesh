import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'integration-test-agent',
  description: 'Integration test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Agent Feedback Integration — all new endpoints', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({ ...testConfig, nodeUrl: 'https://api.agoramesh.ai' });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /discovery/agents returns agents from network', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ did: 'did:test:1', name: 'Agent 1' }],
    });

    const res = await request(app).get('/discovery/agents?q=test');
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
    expect(res.body.source).toBe('network');
  });

  it('POST /discovery/search works with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ did: 'did:test:2' }],
    });

    const res = await request(app)
      .post('/discovery/search')
      .send({ query: 'translate documents' });
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
  });

  it('GET /trust/:did returns trust data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ score: 0.85, reputation: 0.9, stake_score: 0.8, endorsement_score: 0.7 }),
    });

    const res = await request(app).get('/trust/did:key:z6MkIntegration');
    expect(res.status).toBe(200);
    expect(res.body.local).toBeDefined();
    expect(res.body.network).toBeDefined();
    expect(res.body.network.overall).toBe(0.85);
  });

  it('existing endpoints still work', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const card = await request(app).get('/.well-known/agent.json');
    expect(card.status).toBe(200);

    const llms = await request(app).get('/llms.txt');
    expect(llms.status).toBe(200);
  });
});
