/**
 * A2A SSE Streaming Tests
 *
 * Tests for SendStreamingMessage and SubscribeToTask methods
 * which return Server-Sent Events (text/event-stream) responses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import { A2A_ERRORS, toWireState } from '../src/a2a.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'streaming-test-agent',
  description: 'Test agent for A2A SSE streaming tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

/** Parse SSE event data from raw response text */
function parseSSEEvents(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

describe('A2A SSE Streaming — POST /', () => {
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

  describe('SendStreamingMessage', () => {
    it('returns text/event-stream content type', async () => {
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'stream-task-1',
        status: 'completed',
        output: 'Streamed result',
        duration: 100,
      });

      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Hello streaming' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
    });

    it('emits submitted, working, artifactUpdate, and completed events', async () => {
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'stream-task-2',
        status: 'completed',
        output: 'Task output text',
        duration: 200,
      });

      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Do something' }],
            },
          },
        });

      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(4);

      // Event 1: submitted status
      const submitted = events[0] as any;
      expect(submitted.type).toBe('statusUpdate');
      expect(submitted.status.state).toBe(toWireState('submitted'));
      expect(submitted.final).toBe(false);

      // Event 2: working status
      const working = events[1] as any;
      expect(working.type).toBe('statusUpdate');
      expect(working.status.state).toBe(toWireState('working'));
      expect(working.final).toBe(false);

      // Event 3: artifact update
      const artifact = events[2] as any;
      expect(artifact.type).toBe('artifactUpdate');
      expect(artifact.artifact.parts[0].text).toBe('Task output text');
      expect(artifact.lastChunk).toBe(true);

      // Event 4: completed status
      const completed = events[3] as any;
      expect(completed.type).toBe('statusUpdate');
      expect(completed.status.state).toBe(toWireState('completed'));
      expect(completed.final).toBe(true);
    });

    it('emits failed status on task failure', async () => {
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'stream-task-3',
        status: 'failed',
        error: 'Something went wrong',
        duration: 50,
      });

      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Failing task' }],
            },
          },
        });

      const events = parseSSEEvents(res.text);
      // submitted, working, failed (no artifact for failed tasks with no output)
      const finalEvent = events[events.length - 1] as any;
      expect(finalEvent.type).toBe('statusUpdate');
      expect(finalEvent.status.state).toBe(toWireState('failed'));
      expect(finalEvent.status.message).toBe('Something went wrong');
      expect(finalEvent.final).toBe(true);
    });

    it('returns JSON-RPC error for missing params', async () => {
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'SendStreamingMessage',
          params: {},
        });

      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(1);
      const error = events[0] as any;
      expect(error.error).toBeDefined();
      expect(error.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
    });

    it('returns JSON-RPC error for missing text part', async () => {
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'data', data: { key: 'value' } }],
            },
          },
        });

      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(1);
      const error = events[0] as any;
      expect(error.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
    });

    it('includes filesChanged in artifact data parts', async () => {
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'stream-task-files',
        status: 'completed',
        output: 'Modified files',
        duration: 300,
        filesChanged: ['src/index.ts', 'src/utils.ts'],
      });

      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Change some files' }],
            },
          },
        });

      const events = parseSSEEvents(res.text);
      const artifact = events.find((e: any) => e.type === 'artifactUpdate') as any;
      expect(artifact).toBeDefined();
      expect(artifact.artifact.parts).toHaveLength(2);
      expect(artifact.artifact.parts[1].type).toBe('data');
      expect(artifact.artifact.parts[1].data.filesChanged).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('works on /a2a endpoint too', async () => {
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'stream-a2a-endpoint',
        status: 'completed',
        output: 'A2A endpoint result',
        duration: 100,
      });

      const res = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'SendStreamingMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Test /a2a' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(4);
    });
  });

  describe('SubscribeToTask', () => {
    it('returns completed task immediately if already done', async () => {
      // First submit a task via SendMessage to populate completedTasks
      const executor = (server as any).executor;
      executor.execute = vi.fn().mockResolvedValueOnce({
        taskId: 'subscribe-test-1',
        status: 'completed',
        output: 'Already done',
        duration: 50,
      });

      // Submit via normal SendMessage first
      await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 100,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ type: 'text', text: 'Quick task' }],
            },
          },
        });

      // Get the taskId from the completed task map
      const completedTasks = (server as any).completedTasks as Map<string, any>;
      const taskId = Array.from(completedTasks.keys()).pop();
      expect(taskId).toBeDefined();

      // Subscribe to it — should return immediately with result
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 101,
          method: 'SubscribeToTask',
          params: { id: taskId },
        });

      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = parseSSEEvents(res.text);
      expect(events.length).toBeGreaterThanOrEqual(1);

      // Should have artifact + completed status
      const finalEvent = events[events.length - 1] as any;
      expect(finalEvent.type).toBe('statusUpdate');
      expect(finalEvent.final).toBe(true);
    });

    it('returns error for non-existent task', async () => {
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 102,
          method: 'SubscribeToTask',
          params: { id: 'nonexistent-task-id' },
        });

      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(1);
      const error = events[0] as any;
      expect(error.error).toBeDefined();
      expect(error.error.code).toBe(A2A_ERRORS.TASK_NOT_FOUND.code);
    });

    it('returns error for missing params.id', async () => {
      const res = await request(app)
        .post('/')
        .send({
          jsonrpc: '2.0',
          id: 103,
          method: 'SubscribeToTask',
          params: {},
        });

      const events = parseSSEEvents(res.text);
      expect(events.length).toBe(1);
      const error = events[0] as any;
      expect(error.error.code).toBe(A2A_ERRORS.INVALID_PARAMS.code);
    });
  });

  describe('envelope validation for streaming', () => {
    it('returns JSON error for invalid jsonrpc field', async () => {
      const res = await request(app)
        .post('/')
        .send({ id: 1, method: 'SendStreamingMessage' });

      // Non-streaming envelope errors return regular JSON
      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(A2A_ERRORS.INVALID_REQUEST.code);
    });
  });

  describe('capabilities.streaming in agent card', () => {
    it('includes streaming: true in agent card', async () => {
      const res = await request(app)
        .get('/.well-known/agent.json');

      expect(res.status).toBe(200);
      expect(res.body.capabilities).toBeDefined();
      expect(res.body.capabilities.streaming).toBe(true);
    });
  });
});
