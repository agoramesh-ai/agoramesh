import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-agent',
  description: 'Test agent for unit tests',
  skills: ['coding', 'debugging'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('BridgeServer', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer(testConfig);
    // Access the express app for testing
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('does not expose agent name for unauthenticated requests (L-3)', async () => {
      const res = await request(app).get('/health');

      // L-3: Unauthenticated health check only returns status
      expect(res.body.agent).toBeUndefined();
    });

    it('does not expose mode for unauthenticated requests (L-3)', async () => {
      const res = await request(app).get('/health');

      expect(res.body.mode).toBeUndefined();
    });

    it('does not expose pending tasks count', async () => {
      const res = await request(app).get('/health');

      expect(res.body.pendingTasks).toBeUndefined();
    });
  });

  describe('GET /.well-known/agent.json', () => {
    it('returns capability card with agent name', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('test-agent');
    });

    it('returns capability card with description', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.description).toBe('Test agent for unit tests');
    });

    it('returns capability card with skills as A2A v1.0 objects', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.skills).toEqual([
        { id: 'coding', name: 'coding' },
        { id: 'debugging', name: 'debugging' },
      ]);
    });

    it('returns payment info with defaultPricing', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.payment.defaultPricing.model).toBe('per_request');
      expect(res.body.payment.defaultPricing.amount).toBe('0.01');
      expect(res.body.payment.defaultPricing.currency).toBe('USDC');
    });

    it('returns protocolVersion', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.protocolVersion).toBe('1.0');
    });

    it('returns version', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.version).toBe('1.0.0');
    });
  });

  describe('POST /task', () => {
    it('accepts task without taskId and auto-generates one', async () => {
      const res = await request(app)
        .post('/task')
        .send({ type: 'prompt', prompt: 'test', clientDid: 'did:test:123' });

      expect(res.status).toBe(202);
      expect(res.body.taskId).toMatch(/^task-\d+-[a-f0-9]+$/);
    });

    it('rejects invalid task without type', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'task-1', prompt: 'test', clientDid: 'did:test:123' });

      expect(res.status).toBe(400);
    });

    it('rejects invalid task without prompt', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'task-1', type: 'prompt', clientDid: 'did:test:123' });

      expect(res.status).toBe(400);
    });

    it('accepts task without clientDid and auto-fills anonymous', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'task-1', type: 'prompt', prompt: 'test' });

      expect(res.status).toBe(202);
      expect(res.body.taskId).toBe('task-1');
    });

    it('rejects invalid task type', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'task-1', type: 'invalid', prompt: 'test', clientDid: 'did:test:123' });

      expect(res.status).toBe(400);
    });

    it('accepts valid task and returns acknowledgement', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-valid-1',
          type: 'prompt',
          prompt: 'Write hello world',
          clientDid: 'did:test:client',
        });

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(res.body.taskId).toBe('task-valid-1');
    });

    it('returns estimated time based on config timeout', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-valid-2',
          type: 'prompt',
          prompt: 'Write hello world',
          clientDid: 'did:test:client',
        });

      expect(res.body.estimatedTime).toBe(60);
    });
  });

  describe('GET /task/:taskId', () => {
    it('returns 404 for unknown task', async () => {
      const res = await request(app).get('/task/unknown-task');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    });
  });

  describe('DELETE /task/:taskId', () => {
    it('returns 404 for unknown task', async () => {
      const res = await request(app).delete('/task/unknown-task');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Task not found');
    });
  });
});

// ========== H-6: Localhost Binding Tests ==========

describe('BridgeServer localhost binding', () => {
  it('binds to 127.0.0.1 by default', async () => {
    const server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    await server.start(0);
    const address = (server as any).server.address();
    expect(address.address).toBe('127.0.0.1');
    await server.stop();
  });

  it('accepts custom host via config', async () => {
    const server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      host: '127.0.0.1',
    });
    await server.start(0);
    const address = (server as any).server.address();
    expect(address.address).toBe('127.0.0.1');
    await server.stop();
  });
});
