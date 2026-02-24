/**
 * A2A JSON-RPC 2.0 Endpoint Tests
 *
 * Tests for POST / with JSON-RPC 2.0 protocol.
 * Methods: message/send, tasks/get, tasks/cancel
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer, ErrorCode } from '../src/server.js';
import { A2A_ERRORS } from '../src/a2a.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'a2a-test-agent',
  description: 'Test agent for A2A JSON-RPC tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('A2A JSON-RPC 2.0 — POST /', () => {
  describe('without auth (requireAuth: false)', () => {
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

    describe('envelope validation', () => {
      it('rejects request without jsonrpc field', async () => {
        const res = await request(app)
          .post('/')
          .send({ id: 1, method: 'message/send' });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_REQUEST.code);
      });

      it('rejects request without id field', async () => {
        const res = await request(app)
          .post('/')
          .send({ jsonrpc: '2.0', method: 'message/send' });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_REQUEST.code);
      });

      it('rejects request without method field', async () => {
        const res = await request(app)
          .post('/')
          .send({ jsonrpc: '2.0', id: 1 });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_REQUEST.code);
      });

      it('returns correct jsonrpc version in response', async () => {
        const res = await request(app)
          .post('/')
          .send({ jsonrpc: '2.0', id: 42, method: 'tasks/get', params: { id: 'nonexistent' } });

        expect(res.body.jsonrpc).toBe('2.0');
        expect(res.body.id).toBe(42);
      });
    });

    describe('method: message/send', () => {
      it('executes task and returns A2A Task object', async () => {
        // Mock the executor to return a result
        const executor = (server as any).executor;
        const originalExecute = executor.execute.bind(executor);
        executor.execute = vi.fn().mockResolvedValueOnce({
          taskId: 'mock-a2a-task',
          status: 'completed',
          output: 'Hello from Claude!',
          duration: 500,
        });

        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-1',
            method: 'message/send',
            params: {
              message: {
                role: 'user',
                parts: [{ type: 'text', text: 'Say hello' }],
              },
            },
          });

        expect(res.status).toBe(200);
        expect(res.body.result).toBeDefined();
        expect(res.body.result.id).toMatch(/^a2a-/);
        expect(res.body.result.status.state).toBe('completed');
        expect(res.body.result.artifacts).toBeDefined();
        expect(res.body.result.artifacts[0].parts[0].text).toBe('Hello from Claude!');
        expect(res.body.error).toBeUndefined();

        executor.execute = originalExecute;
      });

      it('rejects message without params.message', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-2',
            method: 'message/send',
            params: {},
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
      });

      it('rejects message without text parts', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-3',
            method: 'message/send',
            params: {
              message: {
                role: 'user',
                parts: [{ type: 'image', url: 'http://example.com/img.png' }],
              },
            },
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
      });
    });

    describe('method: tasks/get', () => {
      it('returns working status for pending task', async () => {
        // Directly insert a pending task so it stays in the map
        const pendingTasks = (server as any).pendingTasks as Map<string, unknown>;
        pendingTasks.set('a2a-lookup-task', {
          taskId: 'a2a-lookup-task',
          type: 'prompt',
          prompt: 'test',
          clientDid: 'did:test:a2a',
          timeout: 60,
        });

        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-get-1',
            method: 'tasks/get',
            params: { id: 'a2a-lookup-task' },
          });

        expect(res.body.result).toBeDefined();
        expect(res.body.result.id).toBe('a2a-lookup-task');
        expect(res.body.result.status.state).toBe('working');

        // Cleanup
        pendingTasks.delete('a2a-lookup-task');
      });

      it('returns TASK_NOT_FOUND for unknown task', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-get-2',
            method: 'tasks/get',
            params: { id: 'does-not-exist' },
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND.code);
      });

      it('rejects without params.id', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-get-3',
            method: 'tasks/get',
            params: {},
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
      });
    });

    describe('method: tasks/cancel', () => {
      it('returns TASK_NOT_CANCELLABLE for unknown task', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-cancel-1',
            method: 'tasks/cancel',
            params: { id: 'nonexistent-task' },
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.TASK_NOT_CANCELLABLE.code);
      });

      it('rejects without params.id', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-cancel-2',
            method: 'tasks/cancel',
            params: {},
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
      });
    });

    describe('unknown method', () => {
      it('returns METHOD_NOT_FOUND error', async () => {
        const res = await request(app)
          .post('/')
          .send({
            jsonrpc: '2.0',
            id: 'req-unknown',
            method: 'bogus/method',
          });

        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(A2A_ERRORS.METHOD_NOT_FOUND.code);
      });
    });
  });

  describe('A2A discoverability', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        rateLimit: { enabled: false },
        a2a: {
          endpoint: '/a2a',
          methods: ['message/send', 'tasks/get', 'tasks/cancel'],
        },
      });
      app = (server as any).app;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('serves /.well-known/a2a.json as alias for agent card', async () => {
      const agentRes = await request(app).get('/.well-known/agent.json');
      const a2aRes = await request(app).get('/.well-known/a2a.json');

      expect(a2aRes.status).toBe(200);
      expect(a2aRes.body.name).toBe(agentRes.body.name);
    });

    it('agent card includes a2a section with methods', async () => {
      const res = await request(app).get('/.well-known/agent.json');

      expect(res.body.a2a).toBeDefined();
      expect(res.body.a2a.endpoint).toBe('/a2a');
      expect(res.body.a2a.methods).toContain('message/send');
      expect(res.body.a2a.methods).toContain('tasks/get');
      expect(res.body.a2a.methods).toContain('tasks/cancel');
    });
  });

  describe('with auth (requireAuth: true)', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        requireAuth: true,
        apiToken: 'a2a-test-secret',
        rateLimit: { enabled: false },
      });
      app = (server as any).app;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('returns 401 with rich error when unauthenticated', async () => {
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 'req-auth-1',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: 'hello' }],
            },
          },
        });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(res.body.help).toBeDefined();
      expect(res.body.help.agentCard).toBe('/.well-known/agent.json');
    });

    it('succeeds with valid Bearer token', async () => {
      const executor = (server as any).executor;
      const originalExecute = executor.execute.bind(executor);
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'mock-auth-task',
        status: 'completed',
        output: 'Authenticated!',
        duration: 100,
      });

      const res = await request(app)
        .post('/')
        .set('Authorization', 'Bearer a2a-test-secret')
        .send({
          jsonrpc: '2.0',
          id: 'req-auth-2',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: 'hello' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.status.state).toBe('completed');

      executor.execute = originalExecute;
    });
  });
});

describe('A2A JSON-RPC 2.0 — POST /a2a (agent card endpoint)', () => {
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

  it('returns valid JSON-RPC response for message/send', async () => {
    const executor = (server as any).executor;
    const originalExecute = executor.execute.bind(executor);
    executor.execute = vi.fn().mockResolvedValueOnce({
      taskId: 'mock-a2a-endpoint-task',
      status: 'completed',
      output: 'Hello from /a2a!',
      duration: 200,
    });

    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'a2a-req-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Say hello via /a2a' }],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe('a2a-req-1');
    expect(res.body.result).toBeDefined();
    expect(res.body.result.id).toMatch(/^a2a-/);
    expect(res.body.result.status.state).toBe('completed');
    expect(res.body.result.artifacts).toBeDefined();
    expect(res.body.result.artifacts[0].parts[0].text).toBe('Hello from /a2a!');
    expect(res.body.error).toBeUndefined();

    executor.execute = originalExecute;
  });

  it('returns JSON-RPC error for invalid request', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({ id: 1, method: 'message/send' });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_REQUEST.code);
  });

  it('returns METHOD_NOT_FOUND for unknown method', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'a2a-req-unknown',
        method: 'bogus/method',
      });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(A2A_ERRORS.METHOD_NOT_FOUND.code);
  });

  it('handles tasks/get via /a2a endpoint', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'a2a-req-get',
        method: 'tasks/get',
        params: { id: 'nonexistent-task' },
      });

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe('a2a-req-get');
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND.code);
  });

  it('handles tasks/cancel via /a2a endpoint', async () => {
    const res = await request(app)
      .post('/a2a')
      .send({
        jsonrpc: '2.0',
        id: 'a2a-req-cancel',
        method: 'tasks/cancel',
        params: { id: 'nonexistent-task' },
      });

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe('a2a-req-cancel');
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(A2A_ERRORS.TASK_NOT_CANCELLABLE.code);
  });
});
