/**
 * Task Polling & Sync Mode Tests
 *
 * Tests for:
 * - Task result store (completedTasks map with TTL)
 * - POST /task returns 202 + Location + Retry-After
 * - POST /task?wait=true sync mode
 * - GET /task/:id returns running/completed/failed/404
 * - Owner verification on GET /task/:id
 * - TTL expiry and cleanup
 * - WebSocket broadcast regression
 * - A2A tasks/get returns completed results
 * - Multiple concurrent tasks tracked independently
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { BridgeServer, ErrorCode } from '../src/server.js';
import { A2A_ERRORS } from '../src/a2a.js';
import type { AgentConfig, TaskResult } from '../src/types.js';
import { TASK_RESULT_TTL, TASK_SYNC_TIMEOUT } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'polling-test-agent',
  description: 'Test agent for task polling tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

const validTask = (id: string) => ({
  taskId: id,
  type: 'prompt',
  prompt: 'Write hello world',
  clientDid: 'did:test:client1',
});

describe('Task polling & sync mode', () => {
  let server: BridgeServer;
  let app: any;
  let mockExecute: ReturnType<typeof vi.fn>;
  let resolvers: Map<string, { resolve: (v: TaskResult) => void; reject: (e: Error) => void }>;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;

    // Replace executor with controllable mock
    resolvers = new Map();
    const executor = (server as any).executor;
    mockExecute = vi.fn().mockImplementation((task: any) => {
      return new Promise<TaskResult>((resolve, reject) => {
        resolvers.set(task.taskId, { resolve, reject });
      });
    });
    executor.execute = mockExecute;
  });

  afterAll(async () => {
    // Resolve any pending tasks to avoid hanging
    for (const [, { resolve }] of resolvers) {
      resolve({ taskId: 'cleanup', status: 'completed', output: '', duration: 0 });
    }
    await server.stop();
  });

  // ============================
  // POST /task — 202 + headers
  // ============================

  describe('POST /task returns 202 with Location and Retry-After', () => {
    it('returns 202 status code', async () => {
      const res = await request(app)
        .post('/task')
        .send(validTask('poll-test-1'));

      expect(res.status).toBe(202);
    });

    it('includes Location header pointing to task status', async () => {
      const res = await request(app)
        .post('/task')
        .send(validTask('poll-test-2'));

      expect(res.headers.location).toBe('/task/poll-test-2');
    });

    it('includes Retry-After header', async () => {
      const res = await request(app)
        .post('/task')
        .send(validTask('poll-test-3'));

      expect(res.headers['retry-after']).toBe('5');
    });

    it('still returns accepted: true in body', async () => {
      const res = await request(app)
        .post('/task')
        .send(validTask('poll-test-4'));

      expect(res.body.accepted).toBe(true);
      expect(res.body.taskId).toBe('poll-test-4');
    });
  });

  // ============================
  // POST /task?wait=true — sync mode
  // ============================

  describe('POST /task?wait=true sync mode', () => {
    it('returns 200 with completed result when task finishes', async () => {
      const taskId = 'sync-test-1';

      // Start the request and the polling concurrently
      const [res] = await Promise.all([
        request(app)
          .post('/task?wait=true')
          .send(validTask(taskId)),
        // Poll until executor mock is called, then resolve it
        (async () => {
          // Wait for the mock executor to be called
          while (!resolvers.has(taskId)) {
            await new Promise((r) => setTimeout(r, 5));
          }
          resolvers.get(taskId)!.resolve({
            taskId,
            status: 'completed',
            output: 'Hello World!',
            duration: 100,
          });
        })(),
      ]);

      expect(res.status).toBe(200);
      expect(res.body.taskId).toBe(taskId);
      expect(res.body.status).toBe('completed');
      expect(res.body.output).toBe('Hello World!');
    });

    it('returns 200 with failed result when task fails', async () => {
      const taskId = 'sync-fail-1';

      const [res] = await Promise.all([
        request(app)
          .post('/task?wait=true')
          .send(validTask(taskId)),
        (async () => {
          while (!resolvers.has(taskId)) {
            await new Promise((r) => setTimeout(r, 5));
          }
          resolvers.get(taskId)!.resolve({
            taskId,
            status: 'failed',
            error: 'Something went wrong',
            duration: 50,
          });
        })(),
      ]);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('Something went wrong');
    });

    it('returns 202 on timeout with Location fallback', async () => {
      // Override TASK_SYNC_TIMEOUT for test by using a short timeout
      const originalTimeout = (server as any)._syncTimeout;
      (server as any)._syncTimeout = 100; // 100ms timeout for test

      const taskId = 'sync-timeout-1';
      const res = await request(app)
        .post('/task?wait=true')
        .send(validTask(taskId));

      // Task never resolved, should time out
      expect(res.status).toBe(202);
      expect(res.headers.location).toBe(`/task/${taskId}`);
      expect(res.body.accepted).toBe(true);

      // Restore and resolve the dangling task
      (server as any)._syncTimeout = originalTimeout;
      const resolver = resolvers.get(taskId);
      if (resolver) {
        resolver.resolve({ taskId, status: 'completed', output: '', duration: 0 });
      }
    });
  });

  // ============================
  // GET /task/:id — polling
  // ============================

  describe('GET /task/:id returns running status for pending task', () => {
    it('returns running status with task type', async () => {
      const taskId = 'running-test-1';
      // Submit a task that stays pending
      await request(app).post('/task').send(validTask(taskId));

      const res = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:client1');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('running');
      expect(res.body.taskId).toBe(taskId);
      expect(res.body.type).toBe('prompt');
    });
  });

  describe('GET /task/:id returns completed result after task finishes', () => {
    it('returns the full TaskResult', async () => {
      const taskId = 'complete-poll-1';

      // Submit task
      await request(app).post('/task').send(validTask(taskId));

      // Resolve it
      const resolver = resolvers.get(taskId);
      expect(resolver).toBeDefined();
      resolver!.resolve({
        taskId,
        status: 'completed',
        output: 'Done!',
        duration: 200,
      });

      // Small delay for the .then() callback to fire
      await new Promise((r) => setTimeout(r, 50));

      const res = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:client1');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.output).toBe('Done!');
      expect(res.body.duration).toBe(200);
      expect(res.body.taskId).toBe(taskId);
    });
  });

  describe('GET /task/:id returns failed result', () => {
    it('returns error details for failed task', async () => {
      const taskId = 'failed-poll-1';

      await request(app).post('/task').send(validTask(taskId));

      const resolver = resolvers.get(taskId);
      resolver!.resolve({
        taskId,
        status: 'failed',
        error: 'Claude crashed',
        duration: 50,
      });

      await new Promise((r) => setTimeout(r, 50));

      const res = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:client1');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('Claude crashed');
    });
  });

  describe('GET /task/:id returns 404 for unknown task', () => {
    it('returns 404 with error message', async () => {
      const res = await request(app)
        .get('/task/nonexistent-task')
        .set('x-client-did', 'did:test:client1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('GET /task/:id returns 404 after TTL expires', () => {
    it('removes completed task after TTL', async () => {
      const taskId = 'ttl-expire-1';

      await request(app).post('/task').send(validTask(taskId));

      const resolver = resolvers.get(taskId);
      resolver!.resolve({
        taskId,
        status: 'completed',
        output: 'Temporary',
        duration: 10,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Verify it exists first
      const exists = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:client1');
      expect(exists.status).toBe(200);

      // Manually expire the entry
      const completedTasks = (server as any).completedTasks as Map<string, { result: TaskResult; expiresAt: number }>;
      const entry = completedTasks.get(taskId);
      expect(entry).toBeDefined();
      entry!.expiresAt = Date.now() - 1; // Expire it

      // Now it should be 404
      const expired = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:client1');
      expect(expired.status).toBe(404);
    });
  });

  describe('GET /task/:id returns 403 for wrong identity', () => {
    it('rejects request from different client DID', async () => {
      const taskId = 'auth-test-1';

      await request(app).post('/task').send(validTask(taskId));

      const res = await request(app)
        .get(`/task/${taskId}`)
        .set('x-client-did', 'did:test:wrong-client');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  // ============================
  // Cleanup
  // ============================

  describe('Completed tasks are cleaned up after TTL', () => {
    it('periodic cleanup removes expired entries', async () => {
      const completedTasks = (server as any).completedTasks as Map<string, { result: TaskResult; expiresAt: number }>;

      // Insert an expired entry directly
      completedTasks.set('expired-1', {
        result: { taskId: 'expired-1', status: 'completed', output: 'old', duration: 0 },
        expiresAt: Date.now() - 1000,
      });
      // Insert a fresh entry
      completedTasks.set('fresh-1', {
        result: { taskId: 'fresh-1', status: 'completed', output: 'new', duration: 0 },
        expiresAt: Date.now() + 60000,
      });

      // Also insert task owner entries
      const taskOwners = (server as any).taskOwners as Map<string, string>;
      taskOwners.set('expired-1', 'did:test:someone');
      taskOwners.set('fresh-1', 'did:test:someone');

      // Trigger cleanup
      (server as any).cleanupCompletedTasks();

      expect(completedTasks.has('expired-1')).toBe(false);
      expect(completedTasks.has('fresh-1')).toBe(true);
      expect(taskOwners.has('expired-1')).toBe(false);
      expect(taskOwners.has('fresh-1')).toBe(true);
    });
  });

  // ============================
  // WebSocket broadcast regression
  // ============================

  describe('POST /task still broadcasts result via WebSocket', () => {
    it('broadcastResult is called after task completes', async () => {
      const taskId = 'ws-broadcast-1';
      const broadcastSpy = vi.spyOn(server as any, 'broadcastResult');

      await request(app).post('/task').send(validTask(taskId));

      const resolver = resolvers.get(taskId);
      resolver!.resolve({
        taskId,
        status: 'completed',
        output: 'Broadcasted!',
        duration: 50,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, status: 'completed' })
      );
      broadcastSpy.mockRestore();
    });
  });

  // ============================
  // A2A tasks/get returns completed results
  // ============================

  describe('A2A tasks/get returns completed results', () => {
    it('returns completed task via JSON-RPC', async () => {
      const taskId = 'a2a-poll-1';

      // Submit via REST and resolve
      await request(app).post('/task').send(validTask(taskId));
      const resolver = resolvers.get(taskId);
      resolver!.resolve({
        taskId,
        status: 'completed',
        output: 'A2A result',
        duration: 75,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Query via A2A tasks/get
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 'a2a-get-1',
          method: 'tasks/get',
          params: { id: taskId },
        });

      expect(res.body.result).toBeDefined();
      expect(res.body.result.id).toBe(taskId);
      expect(res.body.result.status.state).toBe('completed');
      expect(res.body.result.artifacts).toBeDefined();
      expect(res.body.result.artifacts[0].parts[0].text).toBe('A2A result');
    });
  });

  // ============================
  // Optional taskId and clientDid
  // ============================

  describe('optional taskId and clientDid', () => {
    it('accepts task without taskId and auto-generates one', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          type: 'prompt',
          prompt: 'Write hello world',
        });

      expect(res.status).toBe(202);
      expect(res.body.taskId).toBeDefined();
      expect(res.body.taskId).toMatch(/^task-\d+-[a-f0-9]+$/);
    });

    it('accepts task without clientDid and uses auth identity', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          type: 'prompt',
          prompt: 'Write hello world',
          taskId: 'no-client-did-test',
        });

      expect(res.status).toBe(202);
    });

    it('still accepts task with explicit taskId and clientDid', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'explicit-id',
          type: 'prompt',
          prompt: 'Write hello world',
          clientDid: 'did:test:explicit',
        });

      expect(res.status).toBe(202);
      expect(res.body.taskId).toBe('explicit-id');
    });

    it('auto-generates unique taskIds for concurrent tasks', async () => {
      const [res1, res2] = await Promise.all([
        request(app).post('/task').send({ type: 'prompt', prompt: 'Task 1' }),
        request(app).post('/task').send({ type: 'prompt', prompt: 'Task 2' }),
      ]);

      expect(res1.body.taskId).not.toBe(res2.body.taskId);
    });
  });

  // ============================
  // Multiple concurrent tasks
  // ============================

  describe('Multiple concurrent tasks tracked independently', () => {
    it('tracks two tasks with different states', async () => {
      const task1 = 'concurrent-1';
      const task2 = 'concurrent-2';

      // Submit both
      await request(app).post('/task').send(validTask(task1));
      await request(app).post('/task').send(validTask(task2));

      // Complete task1 only
      const resolver1 = resolvers.get(task1);
      resolver1!.resolve({
        taskId: task1,
        status: 'completed',
        output: 'First done',
        duration: 100,
      });

      await new Promise((r) => setTimeout(r, 50));

      // task1 should be completed
      const res1 = await request(app)
        .get(`/task/${task1}`)
        .set('x-client-did', 'did:test:client1');
      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('completed');

      // task2 should still be running
      const res2 = await request(app)
        .get(`/task/${task2}`)
        .set('x-client-did', 'did:test:client1');
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('running');

      // Clean up task2
      const resolver2 = resolvers.get(task2);
      resolver2!.resolve({ taskId: task2, status: 'completed', output: '', duration: 0 });
    });
  });
});

// ============================
// Constants exported correctly
// ============================

describe('Task polling constants', () => {
  it('TASK_RESULT_TTL is 1 hour', () => {
    expect(TASK_RESULT_TTL).toBe(3600000);
  });

  it('TASK_SYNC_TIMEOUT is 60 seconds', () => {
    expect(TASK_SYNC_TIMEOUT).toBe(60000);
  });
});

describe('Sync mode race condition (M-3)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    app = (server as any).app;
    // Set short sync timeout for faster tests
    (server as any)._syncTimeout = 5000;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('handles fast-completing tasks in sync mode without missing results', async () => {
    // Mock executor to resolve instantly
    const executor = (server as any).executor;
    const originalExecute = executor.execute.bind(executor);
    executor.execute = vi.fn().mockResolvedValue({
      taskId: 'fast-sync-task',
      status: 'completed',
      output: 'instant result',
      duration: 1,
    });

    try {
      const res = await request(app)
        .post('/task?wait=true')
        .send({
          taskId: 'fast-sync-task',
          type: 'prompt',
          prompt: 'fast task',
          clientDid: 'did:test:sync-race',
        });

      // Should get the result, not a 202 timeout
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.output).toBe('instant result');
    } finally {
      executor.execute = originalExecute;
    }
  });
});
