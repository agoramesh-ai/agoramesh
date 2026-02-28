import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GracefulShutdown } from './graceful-shutdown.js';

describe('GracefulShutdown', () => {
  let shutdown: GracefulShutdown;

  beforeEach(() => {
    shutdown = new GracefulShutdown({ timeoutMs: 500 });
  });

  afterEach(async () => {
    // Ensure cleanup
    if (shutdown.isShuttingDown()) {
      // Force resolve if still waiting
    }
  });

  describe('initial state', () => {
    it('should not be shutting down initially', () => {
      expect(shutdown.isShuttingDown()).toBe(false);
    });

    it('should have zero active tasks initially', () => {
      expect(shutdown.activeTaskCount()).toBe(0);
    });
  });

  describe('task tracking', () => {
    it('should track registered tasks', () => {
      shutdown.registerTask('task-1');
      shutdown.registerTask('task-2');
      expect(shutdown.activeTaskCount()).toBe(2);
    });

    it('should untrack completed tasks', () => {
      shutdown.registerTask('task-1');
      shutdown.registerTask('task-2');
      shutdown.completeTask('task-1');
      expect(shutdown.activeTaskCount()).toBe(1);
    });

    it('should ignore completing unknown task', () => {
      shutdown.completeTask('nonexistent');
      expect(shutdown.activeTaskCount()).toBe(0);
    });
  });

  describe('shutdown initiation', () => {
    it('should set shutting down flag', () => {
      shutdown.initiateShutdown();
      expect(shutdown.isShuttingDown()).toBe(true);
    });

    it('should reject new tasks during shutdown', () => {
      shutdown.initiateShutdown();
      expect(shutdown.canAcceptTask()).toBe(false);
    });

    it('should accept tasks before shutdown', () => {
      expect(shutdown.canAcceptTask()).toBe(true);
    });
  });

  describe('draining', () => {
    it('should resolve immediately when no active tasks', async () => {
      const start = Date.now();
      const metrics = await shutdown.drain();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(metrics.tasksCompleted).toBe(0);
      expect(metrics.tasksCancelled).toBe(0);
      expect(metrics.timedOut).toBe(false);
    });

    it('should wait for active tasks to complete', async () => {
      shutdown.registerTask('task-1');
      shutdown.initiateShutdown();

      // Complete task after 50ms
      setTimeout(() => shutdown.completeTask('task-1'), 50);

      const metrics = await shutdown.drain();
      expect(metrics.tasksCompleted).toBe(1);
      expect(metrics.tasksCancelled).toBe(0);
      expect(metrics.timedOut).toBe(false);
    });

    it('should time out and report cancelled tasks', async () => {
      shutdown.registerTask('task-1');
      shutdown.registerTask('task-2');
      shutdown.initiateShutdown();

      // Only complete one task
      setTimeout(() => shutdown.completeTask('task-1'), 50);
      // task-2 never completes

      const metrics = await shutdown.drain();
      expect(metrics.tasksCompleted).toBe(1);
      expect(metrics.tasksCancelled).toBe(1);
      expect(metrics.timedOut).toBe(true);
      expect(metrics.shutdownDurationMs).toBeGreaterThanOrEqual(400); // near timeout
    });

    it('should call onCancel callback for timed-out tasks', async () => {
      const onCancel = vi.fn();
      shutdown = new GracefulShutdown({ timeoutMs: 200, onCancel });

      shutdown.registerTask('task-1');
      shutdown.initiateShutdown();

      await shutdown.drain();

      expect(onCancel).toHaveBeenCalledWith('task-1');
    });
  });

  describe('metrics', () => {
    it('should track shutdown duration', async () => {
      shutdown.registerTask('task-1');
      shutdown.initiateShutdown();

      setTimeout(() => shutdown.completeTask('task-1'), 100);

      const metrics = await shutdown.drain();
      expect(metrics.shutdownDurationMs).toBeGreaterThanOrEqual(80);
      expect(metrics.shutdownDurationMs).toBeLessThan(500);
    });
  });
});
