/**
 * Retry with Exponential Backoff
 *
 * Utility for retrying on-chain transactions (escrow confirmations)
 * with exponential backoff delays: 1s, 2s, 4s, 8s, 16s.
 */

export interface RetryOptions {
  /** Maximum number of attempts (default: 5) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000). Delay doubles each retry. */
  baseDelayMs?: number;
  /** Called on each retry with (attempt number, error) */
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Error thrown when all retry attempts are exhausted.
 */
export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`Failed after ${attempts} attempts: ${lastError.message}`);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * Delays: baseDelayMs * 2^(attempt-1)
 * Default: 1s, 2s, 4s, 8s (4 retries after first attempt).
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the function on success
 * @throws RetryError if all attempts are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 1000, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        onRetry?.(attempt, lastError);
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw new RetryError(maxAttempts, lastError!);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
