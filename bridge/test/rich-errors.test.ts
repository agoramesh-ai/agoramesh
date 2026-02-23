/**
 * Rich Error Response Tests
 *
 * Tests that error responses include machine-readable codes,
 * human messages, and actionable help guidance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BridgeServer, ErrorCode } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'rich-errors-test-agent',
  description: 'Test agent for rich error tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('Rich Error Responses', () => {
  describe('401 Unauthorized', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        requireAuth: true,
        apiToken: 'test-token-secret',
        rateLimit: { enabled: false },
      });
      app = (server as any).app;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('returns structured error with code UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'test-1', type: 'prompt', prompt: 'hello', clientDid: 'did:test:123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('includes help.agentCard pointing to agent card URL', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'test-2', type: 'prompt', prompt: 'hello', clientDid: 'did:test:123' });

      expect(res.body.help).toBeDefined();
      expect(res.body.help.agentCard).toBe('/.well-known/agent.json');
    });

    it('includes help.authMethods listing supported auth', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'test-3', type: 'prompt', prompt: 'hello', clientDid: 'did:test:123' });

      expect(res.body.help.authMethods).toEqual(expect.arrayContaining(['bearer', 'x402']));
    });

    it('includes help.message with human-readable guidance', async () => {
      const res = await request(app)
        .post('/task')
        .send({ taskId: 'test-4', type: 'prompt', prompt: 'hello', clientDid: 'did:test:123' });

      expect(typeof res.body.help.message).toBe('string');
      expect(res.body.help.message.length).toBeGreaterThan(0);
    });
  });

  describe('404 Not Found', () => {
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

    it('GET /task/:taskId returns code NOT_FOUND for unknown task', async () => {
      const res = await request(app).get('/task/nonexistent-task');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('DELETE /task/:taskId returns code NOT_FOUND for unknown task', async () => {
      const res = await request(app).delete('/task/nonexistent-task');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('403 Forbidden', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        rateLimit: { enabled: false },
      });
      app = (server as any).app;

      // Directly insert a pending task into the map so it stays pending
      const pendingTasks = (server as any).pendingTasks as Map<string, unknown>;
      pendingTasks.set('pending-task-1', {
        taskId: 'pending-task-1',
        type: 'prompt',
        prompt: 'hello world',
        clientDid: 'did:test:owner',
        timeout: 60,
      });
      // Also insert owner for the new taskOwners-based auth check
      const taskOwners = (server as any).taskOwners as Map<string, string>;
      taskOwners.set('pending-task-1', 'did:test:owner');
    });

    afterAll(async () => {
      await server.stop();
    });

    it('GET /task/:taskId returns help about DID header on 403', async () => {
      const res = await request(app)
        .get('/task/pending-task-1')
        .set('x-client-did', 'did:test:wrong-client');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.FORBIDDEN);
      expect(res.body.help).toBeDefined();
      expect(res.body.help.message).toContain('x-client-did');
    });

    it('DELETE /task/:taskId returns help about DID header on 403', async () => {
      const res = await request(app)
        .delete('/task/pending-task-1')
        .set('x-client-did', 'did:test:wrong-client');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.FORBIDDEN);
      expect(res.body.help.message).toContain('x-client-did');
    });
  });
});
