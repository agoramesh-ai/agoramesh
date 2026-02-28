/**
 * Graceful shutdown manager for the bridge server.
 *
 * Tracks active tasks and drains them on shutdown, with a configurable
 * timeout after which remaining tasks are forcibly cancelled.
 */

export interface ShutdownOptions {
  /** Maximum time to wait for tasks to drain (default: 30000ms) */
  timeoutMs?: number;
  /** Called for each task that is cancelled due to timeout */
  onCancel?: (taskId: string) => void;
}

export interface ShutdownMetrics {
  tasksCompleted: number;
  tasksCancelled: number;
  timedOut: boolean;
  shutdownDurationMs: number;
}

export class GracefulShutdown {
  private shuttingDown = false;
  private activeTasks = new Set<string>();
  private completedDuringDrain = 0;
  private timeoutMs: number;
  private onCancel?: (taskId: string) => void;
  private drainResolve?: (metrics: ShutdownMetrics) => void;
  private drainStartTime = 0;

  constructor(options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onCancel = options.onCancel;
  }

  /** Whether the server is in shutdown mode. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Whether new tasks can be accepted. */
  canAcceptTask(): boolean {
    return !this.shuttingDown;
  }

  /** Number of currently active (in-flight) tasks. */
  activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /** Register a task as active (in-flight). */
  registerTask(taskId: string): void {
    this.activeTasks.add(taskId);
  }

  /** Mark a task as completed and check if drain is done. */
  completeTask(taskId: string): void {
    if (!this.activeTasks.has(taskId)) return;
    this.activeTasks.delete(taskId);
    if (this.shuttingDown) {
      this.completedDuringDrain++;
      this.checkDrainComplete();
    }
  }

  /** Signal that shutdown has begun. No new tasks will be accepted. */
  initiateShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Drain active tasks. Returns metrics when all tasks complete or timeout.
   *
   * Should be called after initiateShutdown(). Resolves when:
   * - All active tasks complete, OR
   * - The timeout expires (remaining tasks are cancelled)
   */
  drain(): Promise<ShutdownMetrics> {
    this.shuttingDown = true;
    this.drainStartTime = Date.now();
    this.completedDuringDrain = 0;

    // No active tasks — resolve immediately
    if (this.activeTasks.size === 0) {
      return Promise.resolve({
        tasksCompleted: 0,
        tasksCancelled: 0,
        timedOut: false,
        shutdownDurationMs: 0,
      });
    }

    return new Promise<ShutdownMetrics>((resolve) => {
      this.drainResolve = resolve;

      // Force timeout
      setTimeout(() => {
        if (this.drainResolve) {
          const cancelled = this.activeTasks.size;
          // Call onCancel for each remaining task
          for (const taskId of this.activeTasks) {
            this.onCancel?.(taskId);
          }
          const metrics: ShutdownMetrics = {
            tasksCompleted: this.completedDuringDrain,
            tasksCancelled: cancelled,
            timedOut: true,
            shutdownDurationMs: Date.now() - this.drainStartTime,
          };
          this.drainResolve = undefined;
          this.activeTasks.clear();
          resolve(metrics);
        }
      }, this.timeoutMs);
    });
  }

  private checkDrainComplete(): void {
    if (this.activeTasks.size === 0 && this.drainResolve) {
      const metrics: ShutdownMetrics = {
        tasksCompleted: this.completedDuringDrain,
        tasksCancelled: 0,
        timedOut: false,
        shutdownDurationMs: Date.now() - this.drainStartTime,
      };
      const resolve = this.drainResolve;
      this.drainResolve = undefined;
      resolve(metrics);
    }
  }
}
