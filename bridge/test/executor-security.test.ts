import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeExecutor, ExecutorOptions } from '../src/executor.js';
import { ResolvedTaskInput } from '../src/types.js';
import * as childProcess from 'child_process';

// Mock child_process
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
    execSync: vi.fn(), // Mock 'which claude' check so mock mode is disabled
  };
});

const testOptions: ExecutorOptions = {
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  timeout: 60,
};

const createTask = (overrides: Partial<ResolvedTaskInput> = {}): ResolvedTaskInput => ({
  taskId: 'test-task-1',
  type: 'prompt',
  prompt: 'Write hello world',
  clientDid: 'did:test:client',
  timeout: 30,
  ...overrides,
});

// Helper to create a mock process that completes successfully
const createMockProcess = () => {
  const mockStdout = { on: vi.fn() };
  const mockStderr = { on: vi.fn() };
  const mockProcess = {
    stdout: mockStdout,
    stderr: mockStderr,
    on: vi.fn(),
    kill: vi.fn(),
  };

  mockStdout.on.mockImplementation((event, cb) => {
    if (event === 'data') {
      setTimeout(() => cb(Buffer.from('Success')), 10);
    }
  });
  mockStderr.on.mockImplementation(() => {});
  mockProcess.on.mockImplementation((event, cb) => {
    if (event === 'close') {
      setTimeout(() => cb(0), 20);
    }
  });

  return mockProcess;
};

describe('ClaudeExecutor Security', () => {
  let executor: ClaudeExecutor;

  beforeEach(() => {
    executor = new ClaudeExecutor(testOptions);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Command Injection Prevention', () => {
    it('rejects shell metacharacters in prompt (semicolon)', async () => {
      const maliciousPrompt = 'hello; rm -rf /';

      const result = await executor.execute(createTask({ prompt: maliciousPrompt }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid characters in prompt');
    });

    it('rejects shell metacharacters in prompt (pipe)', async () => {
      const maliciousPrompt = 'hello | cat /etc/passwd';

      const result = await executor.execute(createTask({ prompt: maliciousPrompt }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid characters in prompt');
    });

    it('rejects shell metacharacters in prompt (ampersand)', async () => {
      const maliciousPrompt = 'hello && rm -rf /';

      const result = await executor.execute(createTask({ prompt: maliciousPrompt }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid characters in prompt');
    });

    it('rejects backticks in prompt (command substitution)', async () => {
      const maliciousPrompt = 'hello `whoami`';

      const result = await executor.execute(createTask({ prompt: maliciousPrompt }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid characters in prompt');
    });

    it('allows $() in prompt since shell: false prevents interpretation', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      // With shell: false, $() is safe - the shell never interprets it
      const safePrompt = 'hello $(cat /etc/passwd)';

      const result = await executor.execute(createTask({ prompt: safePrompt }));

      expect(result.status).toBe('completed');
    });

    it('rejects shell redirection operators in prompt', async () => {
      const maliciousPrompt = 'hello > /etc/passwd';

      const result = await executor.execute(createTask({ prompt: maliciousPrompt }));

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid characters in prompt');
    });

    it('allows safe prompts with normal characters', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      const safePrompt = 'Write a function that calculates fibonacci numbers in Python. Use recursion.';

      const result = await executor.execute(createTask({ prompt: safePrompt }));

      expect(result.status).toBe('completed');
      expect(childProcess.spawn).toHaveBeenCalled();
    });

    it('allows prompts with common punctuation', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      const safePrompt = 'What\'s the best way to implement a REST API? I need: endpoints, authentication, error handling.';

      const result = await executor.execute(createTask({ prompt: safePrompt }));

      expect(result.status).toBe('completed');
    });

    it('allows prompts with parentheses (common in code descriptions)', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      // Parentheses are safe with shell: false and commonly used in prompts
      const safePrompt = 'Write a function foo(bar, baz) that returns (x + y) * 2';

      const result = await executor.execute(createTask({ prompt: safePrompt }));

      expect(result.status).toBe('completed');
    });

    it('does not use shell: true in spawn', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      await executor.execute(createTask({ prompt: 'safe prompt' }));

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          shell: false,
        })
      );
    });
  });

  describe('Path Traversal Prevention', () => {
    it('rejects workingDir with path traversal (..)', async () => {
      const result = await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace/../../../etc' },
        })
      );

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid working directory');
    });

    it('rejects workingDir with relative path traversal', async () => {
      const result = await executor.execute(
        createTask({
          context: { workingDir: '../outside-workspace' },
        })
      );

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid working directory');
    });

    it('rejects absolute path outside workspace', async () => {
      const result = await executor.execute(
        createTask({
          context: { workingDir: '/etc/passwd' },
        })
      );

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid working directory');
    });

    it('rejects workingDir that escapes workspace using encoded characters', async () => {
      // URL encoded ..
      const result = await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace/%2e%2e/etc' },
        })
      );

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Invalid working directory');
    });

    it('allows workingDir within workspace', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      const result = await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace/projects/myproject' },
        })
      );

      expect(result.status).toBe('completed');
      expect(childProcess.spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/tmp/test-workspace/projects/myproject',
        })
      );
    });

    it('allows workingDir equal to workspace', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      const result = await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace' },
        })
      );

      expect(result.status).toBe('completed');
    });

    it('normalizes paths before validation', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      // This path should normalize to /tmp/test-workspace/subdir
      const result = await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace/./subdir' },
        })
      );

      expect(result.status).toBe('completed');
    });

    it('uses workspace dir when workingDir not provided', async () => {
      vi.mocked(childProcess.spawn).mockReturnValue(createMockProcess() as any);

      const result = await executor.execute(createTask());

      expect(result.status).toBe('completed');
      expect(childProcess.spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/tmp/test-workspace',
        })
      );
    });
  });
});
