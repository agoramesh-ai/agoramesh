import { spawn, ChildProcess, execSync } from 'child_process';
import { resolve, normalize } from 'path';
import { ResolvedTaskInput, TaskResult } from './types.js';

export interface ExecutorOptions {
  workspaceDir: string;
  allowedCommands: string[];
  timeout: number;
}

/**
 * Dangerous shell metacharacters that could enable command injection.
 * With shell: false as the primary defense, we only block characters that
 * are actual shell metacharacters for command chaining/substitution/redirection:
 * - ; | & - command chaining (defense in depth)
 * - ` - command substitution
 * - < > - redirections
 *
 * Characters like $, {, }, !, \ are safe with shell: false and commonly
 * appear in legitimate prompts (e.g., "$variable", "if (x) { ... }", "don't!").
 */
const DANGEROUS_SHELL_CHARS = /[;|&`<>]/;

/**
 * Executor pro spouštění Claude Code a dalších příkazů
 */
export class ClaudeExecutor {
  private options: ExecutorOptions;
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private mockMode: boolean = false;

  /** Whether the executor is running in mock/demo mode (claude CLI not found). */
  get isDemoMode(): boolean {
    return this.mockMode;
  }

  constructor(options: ExecutorOptions) {
    this.options = options;

    // Detect if claude CLI is available
    try {
      execSync('which claude', { stdio: 'ignore' });
    } catch {
      this.mockMode = true;
      console.log('[Bridge] Running in mock mode (claude CLI not found)');
    }
  }

  /**
   * Validates that a prompt does not contain dangerous shell metacharacters.
   * Returns an error message if invalid, null if valid.
   */
  private validatePrompt(prompt: string): string | null {
    if (DANGEROUS_SHELL_CHARS.test(prompt)) {
      return 'Invalid characters in prompt: shell metacharacters are not allowed';
    }
    return null;
  }

  /**
   * Validates that a working directory is within the workspace.
   * Returns the normalized absolute path if valid, or throws an error.
   */
  private validateWorkingDir(workDir: string): string {
    // Decode URL-encoded characters first to prevent bypass
    const decoded = decodeURIComponent(workDir);

    // Resolve to absolute path (handles relative paths and ..)
    const resolvedPath = resolve(this.options.workspaceDir, decoded);

    // Normalize the workspace path as well
    const normalizedWorkspace = normalize(this.options.workspaceDir);

    // Check if resolved path starts with workspace (with trailing separator for safety)
    // This prevents /tmp/test-workspace-evil from matching /tmp/test-workspace
    const workspaceWithSep = normalizedWorkspace.endsWith('/')
      ? normalizedWorkspace
      : normalizedWorkspace + '/';

    const isWithinWorkspace =
      resolvedPath === normalizedWorkspace ||
      resolvedPath.startsWith(workspaceWithSep);

    if (!isWithinWorkspace) {
      throw new Error('Invalid working directory: path must be within workspace');
    }

    return resolvedPath;
  }

  /**
   * Spustí Claude Code s daným promptem
   */
  async execute(task: ResolvedTaskInput): Promise<TaskResult> {
    const startTime = Date.now();

    // Mock mode: return template response when claude CLI is not available
    if (this.mockMode) {
      return this.buildMockResponse(task, startTime);
    }

    // Validace
    if (!this.isCommandAllowed('claude')) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: 'Claude command not allowed',
        duration: 0,
      };
    }

    // Validate prompt for shell metacharacters (command injection prevention)
    const promptError = this.validatePrompt(task.prompt);
    if (promptError) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: promptError,
        duration: 0,
      };
    }

    // Validate and resolve working directory (path traversal prevention)
    let workDir: string;
    try {
      workDir = this.validateWorkingDir(
        task.context?.workingDir || this.options.workspaceDir
      );
    } catch (error) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Invalid working directory',
        duration: 0,
      };
    }

    const timeout = Math.min(task.timeout, this.options.timeout) * 1000;

    try {
      const output = await this.runClaudeCode(task.taskId, task.prompt, workDir, timeout);
      
      return {
        taskId: task.taskId,
        status: 'completed',
        output,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timeout');
      
      return {
        taskId: task.taskId,
        status: isTimeout ? 'timeout' : 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Spustí claude CLI s promptem
   */
  private runClaudeCode(taskId: string, prompt: string, cwd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Spustí: claude -p "prompt" --output-format text --max-turns 30
      // SECURITY: shell: false prevents command injection via prompt
      // stdio: stdin must be 'ignore' to prevent claude from waiting for EOF
      const proc = spawn('claude', [
        '-p', prompt,
        '--output-format', 'text',
        '--max-turns', '30',
      ], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: 'true',
        },
      });

      this.runningProcesses.set(taskId, proc);

      let stdout = '';
      let stderr = '';
      const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10 MB

      proc.stdout?.on('data', (data) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += data.toString();
        }
      });

      proc.stderr?.on('data', (data) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += data.toString();
        }
      });

      // Timeout
      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Task timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        this.runningProcesses.delete(taskId);

        if (code === 0) {
          resolve(stdout);
        } else {
          if (stderr) {
            console.error(`[Bridge] Claude stderr for task ${taskId}:`, stderr);
          }
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        this.runningProcesses.delete(taskId);
        reject(err);
      });
    });
  }

  /**
   * Zruší běžící task
   */
  cancelTask(taskId: string): boolean {
    const proc = this.runningProcesses.get(taskId);
    if (proc) {
      proc.kill('SIGTERM');
      this.runningProcesses.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * Builds a mock response when claude CLI is not available.
   * Echoes back task metadata so callers can verify routing works.
   */
  private buildMockResponse(task: ResolvedTaskInput, startTime: number): TaskResult {
    const promptPreview = task.prompt.slice(0, 100);
    const output = [
      `[mock response — bridge is running in demo mode, claude CLI not installed]`,
      ``,
      `Task: ${task.type}`,
      `Prompt: ${promptPreview}${task.prompt.length > 100 ? '...' : ''}`,
      ``,
      `This is a placeholder response. Install Claude CLI in the bridge container to get real results.`,
    ].join('\n');

    return {
      taskId: task.taskId,
      status: 'completed',
      output,
      duration: Date.now() - startTime,
      mock: true,
    };
  }

  /**
   * Kontrola povoleného příkazu
   */
  private isCommandAllowed(cmd: string): boolean {
    return this.options.allowedCommands.includes(cmd);
  }
}
