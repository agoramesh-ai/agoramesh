/**
 * A2A agent/describe and agent/status Tests
 *
 * Tests for the new A2A protocol methods.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'a2a-describe-test-agent',
  description: 'Test agent for A2A describe/status tests',
  skills: ['testing', 'coding'],
  pricePerTask: 1.5,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('A2A agent/describe', () => {
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

  it('returns agent capability card via POST /', async () => {
    const res = await request(app)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'desc-1',
        method: 'agent/describe',
      });

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe('desc-1');
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toBeDefined();
    expect(res.body.result.name).toBe('a2a-describe-test-agent');
    expect(res.body.result.description).toBe('Test agent for A2A describe/status tests');
    expect(res.body.result.skills).toBeDefined();
    expect(Array.isArray(res.body.result.skills)).toBe(true);
  });

  it('returns agent capability card via POST /a2a', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'desc-2',
        method: 'agent/describe',
      });

    expect(res.status).toBe(200);
    expect(res.body.result.name).toBe('a2a-describe-test-agent');
  });

  it('includes payment info in capability card', async () => {
    const res = await request(app)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'desc-3',
        method: 'agent/describe',
      });

    expect(res.body.result.payment).toBeDefined();
  });
});

describe('A2A agent/status', () => {
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

  it('returns status object with state and uptime', async () => {
    const res = await request(app)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'status-1',
        method: 'agent/status',
      });

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe('status-1');
    expect(res.body.error).toBeUndefined();
    expect(res.body.result).toBeDefined();
    expect(res.body.result.state).toBe('operational');
    expect(typeof res.body.result.uptimeSeconds).toBe('number');
    expect(res.body.result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('includes supported protocols', async () => {
    const res = await request(app)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'status-2',
        method: 'agent/status',
      });

    expect(res.body.result.protocols).toBeDefined();
    expect(Array.isArray(res.body.result.protocols)).toBe(true);
    expect(res.body.result.protocols).toContain('a2a');
    expect(res.body.result.protocols).toContain('rest');
    expect(res.body.result.protocols).toContain('websocket');
  });

  it('includes active task count', async () => {
    const res = await request(app)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'status-3',
        method: 'agent/status',
      });

    expect(typeof res.body.result.activeTasks).toBe('number');
  });

  it('works via POST /a2a', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'status-4',
        method: 'agent/status',
      });

    expect(res.status).toBe(200);
    expect(res.body.result.state).toBe('operational');
  });
});
