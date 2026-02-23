/**
 * AgoraMesh SDK Utilities
 *
 * Shared utility functions for the AgoraMesh SDK.
 *
 * @packageDocumentation
 */

import { parseUnits, formatUnits } from 'viem';

import { USDC_DECIMALS } from './types.js';

// =============================================================================
// USDC Formatting
// =============================================================================

/**
 * Convert a human-readable USDC amount to contract format (6 decimals).
 *
 * @param amount - Human-readable amount (e.g., "100.50")
 * @returns Amount in wei (6 decimals)
 *
 * @example
 * ```typescript
 * const wei = parseUSDC("100.50"); // 100500000n
 * ```
 */
export function parseUSDC(amount: string): bigint {
  return parseUnits(amount, USDC_DECIMALS);
}

/**
 * Convert a USDC amount (6 decimals) to a human-readable string.
 *
 * @param amount - Amount in wei (6 decimals)
 * @returns Human-readable amount (e.g., "100.5")
 *
 * @example
 * ```typescript
 * const readable = formatUSDC(100500000n); // "100.5"
 * ```
 */
export function formatUSDC(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

// =============================================================================
// Timestamp Conversion
// =============================================================================

/**
 * Convert a deadline (Date or timestamp) to Unix timestamp.
 *
 * @param time - Date object or Unix timestamp (seconds or milliseconds)
 * @returns Unix timestamp as bigint (seconds)
 *
 * @example
 * ```typescript
 * const ts = toUnixTimestamp(new Date());
 * const ts2 = toUnixTimestamp(Date.now() + 3600000); // 1 hour from now
 * ```
 */
export function toUnixTimestamp(time: number | Date): bigint {
  if (time instanceof Date) {
    return BigInt(Math.floor(time.getTime() / 1000));
  }
  // Heuristic: values > 1e12 are likely milliseconds (valid until year 33658)
  if (time > 1e12) {
    return BigInt(Math.floor(time / 1000));
  }
  return BigInt(Math.floor(time));
}

// =============================================================================
// Elapsed Time Calculation
// =============================================================================

/**
 * Calculate elapsed time for a time-bounded operation.
 *
 * Returns 0 if before start, duration if after end, otherwise actual elapsed.
 *
 * @param startTime - Start time as bigint (Unix seconds)
 * @param endTime - End time as bigint (Unix seconds)
 * @param now - Current time as bigint (Unix seconds), defaults to current time
 * @returns Elapsed time in seconds as bigint
 */
export function calculateElapsedTime(
  startTime: bigint,
  endTime: bigint,
  now?: bigint
): bigint {
  const currentTime = now ?? BigInt(Math.floor(Date.now() / 1000));
  const duration = endTime - startTime;

  if (currentTime < startTime) {
    return 0n;
  }
  if (currentTime > endTime) {
    return duration;
  }
  return currentTime - startTime;
}
