/**
 * Escrow Retry Logic Tests
 *
 * Tests for exponential backoff retry utility used for
 * on-chain escrow confirmations.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryWithBackoff, RetryError } from '../src/retry.js';

describe('retryWithBackoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Success cases
  // =========================================================================

  describe('success cases', () => {
    it('returns result on first attempt success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries and succeeds on second attempt', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries and succeeds on last attempt', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockRejectedValueOnce(new Error('fail 4'))
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });

  // =========================================================================
  // Failure cases
  // =========================================================================

  describe('failure cases', () => {
    it('throws RetryError after max attempts exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always fails'));

      await expect(
        retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1 }),
      ).rejects.toThrow(RetryError);

      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('RetryError includes attempt count and last error', async () => {
      const lastError = new Error('final failure');
      const fn = vi.fn().mockRejectedValue(lastError);

      try {
        await retryWithBackoff(fn, { maxAttempts: 2, baseDelayMs: 1 });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RetryError);
        const retryErr = err as RetryError;
        expect(retryErr.attempts).toBe(2);
        expect(retryErr.lastError).toBe(lastError);
      }
    });
  });

  // =========================================================================
  // Backoff timing
  // =========================================================================

  describe('backoff timing', () => {
    it('applies increasing delays between retries', async () => {
      const delays: number[] = [];
      let lastCall = Date.now();

      const fn = vi.fn().mockImplementation(async () => {
        const now = Date.now();
        if (fn.mock.calls.length > 1) {
          delays.push(now - lastCall);
        }
        lastCall = now;
        if (fn.mock.calls.length < 4) {
          throw new Error('fail');
        }
        return 'ok';
      });

      // Use tiny delays for fast test
      const result = await retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 10 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(4);
      // Each delay should be >= previous delay (exponential)
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });
  });

  // =========================================================================
  // onRetry callback
  // =========================================================================

  describe('onRetry callback', () => {
    it('calls onRetry with attempt number and error', async () => {
      const onRetry = vi.fn();
      const error1 = new Error('fail 1');
      const error2 = new Error('fail 2');
      const fn = vi.fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockResolvedValue('ok');

      await retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, error1);
      expect(onRetry).toHaveBeenCalledWith(2, error2);
    });

    it('does not call onRetry on first-attempt success', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn().mockResolvedValue('ok');

      await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 1, onRetry });

      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Default options
  // =========================================================================

  describe('defaults', () => {
    it('defaults to 5 max attempts', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try {
        await retryWithBackoff(fn, { baseDelayMs: 1 });
      } catch {
        // expected
      }

      expect(fn).toHaveBeenCalledTimes(5);
    });
  });
});
