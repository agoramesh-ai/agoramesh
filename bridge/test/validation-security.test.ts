/**
 * Input Validation Security Tests for Bridge
 *
 * Tests for TaskInputSchema validation to prevent security vulnerabilities:
 * - Prompt max length (100KB) to prevent DoS
 * - TaskId format validation to prevent injection
 * - Files array max length to prevent memory exhaustion
 * - Timeout min/max to prevent resource abuse
 *
 * TDD Phase: RED - These tests should FAIL initially
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import { TaskInputSchema } from '../src/types.js';
import { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'validation-test-agent',
  description: 'Test agent for validation security tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

// =============================================================================
// TaskInputSchema Direct Validation Tests
// =============================================================================

describe('TaskInputSchema Validation', () => {
  describe('prompt validation', () => {
    it('rejects prompt longer than 100KB', () => {
      const longPrompt = 'a'.repeat(100001); // 100KB + 1 byte

      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: longPrompt,
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('prompt');
        expect(result.error.issues[0].message).toMatch(/too_big|maximum|100000/i);
      }
    });

    it('accepts prompt at exactly 100KB', () => {
      const maxPrompt = 'a'.repeat(100000); // exactly 100KB

      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: maxPrompt,
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(true);
    });

    it('rejects empty prompt', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: '',
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('prompt');
      }
    });
  });

  describe('taskId validation', () => {
    it('rejects taskId with special characters (injection prevention)', () => {
      const invalidIds = [
        'task-1; DROP TABLE tasks;--',
        'task<script>alert(1)</script>',
        '../../../etc/passwd',
        'task\n\r\t',
        'task with spaces',
        'task@special!chars',
        'task#$%^&*()',
      ];

      for (const invalidId of invalidIds) {
        const result = TaskInputSchema.safeParse({
          taskId: invalidId,
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
        });

        expect(result.success, `Should reject taskId: ${invalidId}`).toBe(false);
      }
    });

    it('accepts valid taskId formats', () => {
      const validIds = [
        'task-1',
        'task_1',
        'Task123',
        'a1b2c3',
        'TASK-ABC-123',
        'task_with_underscores',
        'TaskWithCamelCase',
      ];

      for (const validId of validIds) {
        const result = TaskInputSchema.safeParse({
          taskId: validId,
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
        });

        expect(result.success, `Should accept taskId: ${validId}`).toBe(true);
      }
    });

    it('rejects taskId longer than 128 characters', () => {
      const longId = 'a'.repeat(129);

      const result = TaskInputSchema.safeParse({
        taskId: longId,
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(false);
    });

    it('rejects empty taskId', () => {
      const result = TaskInputSchema.safeParse({
        taskId: '',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('files array validation', () => {
    it('rejects files array with more than 100 items', () => {
      const tooManyFiles = Array.from({ length: 101 }, (_, i) => `/path/to/file${i}.ts`);

      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        context: {
          files: tooManyFiles,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const filesError = result.error.issues.find((issue) =>
          issue.path.includes('files')
        );
        expect(filesError).toBeDefined();
      }
    });

    it('accepts files array with exactly 100 items', () => {
      const maxFiles = Array.from({ length: 100 }, (_, i) => `/path/to/file${i}.ts`);

      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        context: {
          files: maxFiles,
        },
      });

      expect(result.success).toBe(true);
    });

    it('accepts empty files array', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        context: {
          files: [],
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('timeout validation', () => {
    it('rejects timeout less than 1 second', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        timeout: 0,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('timeout');
      }
    });

    it('rejects negative timeout', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        timeout: -10,
      });

      expect(result.success).toBe(false);
    });

    it('rejects timeout greater than 3600 seconds (1 hour)', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        timeout: 3601,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('timeout');
      }
    });

    it('accepts timeout at exactly 3600 seconds', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        timeout: 3600,
      });

      expect(result.success).toBe(true);
    });

    it('accepts timeout at exactly 1 second', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
        timeout: 1,
      });

      expect(result.success).toBe(true);
    });

    it('uses default timeout of 300 when not provided', () => {
      const result = TaskInputSchema.safeParse({
        taskId: 'task-1',
        type: 'prompt',
        prompt: 'test prompt',
        clientDid: 'did:agoramesh:base:test123',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(300);
      }
    });
  });
});

// =============================================================================
// HTTP API Validation Tests
// =============================================================================

describe('BridgeServer Input Validation', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false }, // Disable rate limiting for tests
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('POST /task prompt validation', () => {
    it('returns 400 for prompt longer than 100KB', async () => {
      const longPrompt = 'a'.repeat(100001);

      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-1',
          type: 'prompt',
          prompt: longPrompt,
          clientDid: 'did:agoramesh:base:test123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /task taskId validation', () => {
    it('returns 400 for taskId with special characters', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-1; DROP TABLE--',
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 400 for taskId with path traversal attempt', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: '../../../etc/passwd',
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /task files array validation', () => {
    it('returns 400 for files array with more than 100 items', async () => {
      const tooManyFiles = Array.from({ length: 101 }, (_, i) => `/file${i}.ts`);

      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-1',
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
          context: {
            files: tooManyFiles,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /task timeout validation', () => {
    it('returns 400 for timeout less than 1', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-1',
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
          timeout: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 400 for timeout greater than 3600', async () => {
      const res = await request(app)
        .post('/task')
        .send({
          taskId: 'task-1',
          type: 'prompt',
          prompt: 'test prompt',
          clientDid: 'did:agoramesh:base:test123',
          timeout: 3601,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });
});
