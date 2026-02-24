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
    execSync: vi.fn(), // Mock 'which claude' check so mock mode is disabled by default
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

describe('ClaudeExecutor', () => {
  let executor: ClaudeExecutor;

  beforeEach(() => {
    executor = new ClaudeExecutor(testOptions);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('returns failed status when claude command is not allowed', async () => {
      const restrictedExecutor = new ClaudeExecutor({
        ...testOptions,
        allowedCommands: [], // claude not allowed
      });

      const result = await restrictedExecutor.execute(createTask());

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Claude command not allowed');
      expect(result.duration).toBe(0);
    });

    it('returns completed status with output on success', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      // Simulate stdout data
      mockStdout.on.mockImplementation((event, cb) => {
        if (event === 'data') {
          setTimeout(() => cb(Buffer.from('Hello, World!')), 10);
        }
      });

      mockStderr.on.mockImplementation(() => {});

      // Simulate process close with success
      mockProcess.on.mockImplementation((event, cb) => {
        if (event === 'close') {
          setTimeout(() => cb(0), 20);
        }
      });

      const result = await executor.execute(createTask());

      expect(result.status).toBe('completed');
      expect(result.output).toBe('Hello, World!');
      expect(result.taskId).toBe('test-task-1');
    });

    it('returns failed status on non-zero exit code', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation((event, cb) => {
        if (event === 'data') {
          setTimeout(() => cb(Buffer.from('Error: something went wrong')), 10);
        }
      });

      // Simulate process close with error
      mockProcess.on.mockImplementation((event, cb) => {
        if (event === 'close') {
          setTimeout(() => cb(1), 20);
        }
      });

      const result = await executor.execute(createTask());

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Claude exited with code 1');
    });

    it('returns timeout status when task exceeds timeout', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation(() => {});
      mockProcess.on.mockImplementation(() => {});

      // Use very short timeout
      const shortTimeoutExecutor = new ClaudeExecutor({
        ...testOptions,
        timeout: 0.01, // 10ms
      });

      const result = await shortTimeoutExecutor.execute(createTask({ timeout: 0.01 }));

      expect(result.status).toBe('timeout');
      expect(result.error).toContain('timeout');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('uses task working directory when provided (within workspace)', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation(() => {});
      mockProcess.on.mockImplementation((event, cb) => {
        if (event === 'close') {
          setTimeout(() => cb(0), 10);
        }
      });

      // Working directory must be within workspace (security fix)
      await executor.execute(
        createTask({
          context: { workingDir: '/tmp/test-workspace/project' },
        })
      );

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-workspace/project' })
      );
    });

    it('sets CI environment variable', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation(() => {});
      mockProcess.on.mockImplementation((event, cb) => {
        if (event === 'close') {
          setTimeout(() => cb(0), 10);
        }
      });

      await executor.execute(createTask());

      expect(childProcess.spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ CI: 'true' }),
        })
      );
    });

    it('records duration in milliseconds', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation(() => {});
      mockProcess.on.mockImplementation((event, cb) => {
        if (event === 'close') {
          setTimeout(() => cb(0), 50);
        }
      });

      const result = await executor.execute(createTask());

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('mock mode', () => {
    it('returns mock response with prompt echo when in mock mode', async () => {
      const mockExecutor = new ClaudeExecutor(testOptions);
      (mockExecutor as any).mockMode = true;

      const result = await mockExecutor.execute(createTask({ prompt: 'Write fibonacci in Python' }));

      expect(result.status).toBe('completed');
      expect(result.output).toContain('mock');
      expect(result.output).toContain('fibonacci');
      expect((result as any).mock).toBe(true);
    });

    it('mock response includes the task type', async () => {
      const mockExecutor = new ClaudeExecutor(testOptions);
      (mockExecutor as any).mockMode = true;

      const result = await mockExecutor.execute(createTask({ type: 'code-review', prompt: 'Review this code' }));

      expect(result.status).toBe('completed');
      expect(result.output).toContain('code-review');
      expect((result as any).mock).toBe(true);
    });

    it('mock response truncates long prompts', async () => {
      const mockExecutor = new ClaudeExecutor(testOptions);
      (mockExecutor as any).mockMode = true;

      const longPrompt = 'x'.repeat(200);
      const result = await mockExecutor.execute(createTask({ prompt: longPrompt }));

      expect(result.status).toBe('completed');
      expect(result.output).toContain('...');
    });
  });

  describe('cancelTask', () => {
    it('returns false for unknown task', () => {
      const result = executor.cancelTask('unknown-task');

      expect(result).toBe(false);
    });

    it('kills the process and returns true for running task', async () => {
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockReturnValue(mockProcess as any);

      mockStdout.on.mockImplementation(() => {});
      mockStderr.on.mockImplementation(() => {});

      // Don't complete the process - keep it running
      mockProcess.on.mockImplementation(() => {});

      // Start task but don't await
      executor.execute(createTask({ taskId: 'running-task' }));

      // Give it time to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const result = executor.cancelTask('running-task');

      expect(result).toBe(true);
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});
