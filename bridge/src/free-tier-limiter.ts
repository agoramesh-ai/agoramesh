/**
 * Free Tier Rate Limiter
 *
 * Enforces per-DID and per-IP daily request limits for the DID:key free tier.
 * Limits reset at midnight UTC each day. In-memory storage with periodic cleanup.
 */

import {
  FREE_TIER_DAILY_LIMIT,
  FREE_TIER_IP_DAILY_LIMIT,
} from './types.js';

interface UsageEntry {
  count: number;
  resetAt: number; // Unix timestamp (ms) of next midnight UTC
}

/** Calculate next midnight UTC from the current time */
function nextMidnightUTC(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

export class FreeTierLimiter {
  private didCounts: Map<string, UsageEntry> = new Map();
  private ipCounts: Map<string, UsageEntry> = new Map();

  /**
   * Check whether a request from a DID/IP combination is allowed.
   *
   * @param did - The agent's DID:key
   * @param ip - The client IP address
   * @param didDailyLimit - Custom per-DID daily limit (default: FREE_TIER_DAILY_LIMIT)
   * @returns Whether the request is allowed, and the reason if not
   */
  canProceed(
    did: string,
    ip: string,
    didDailyLimit: number = FREE_TIER_DAILY_LIMIT,
  ): { allowed: boolean; reason?: string } {
    const now = Date.now();

    // Check DID limit
    const didEntry = this.didCounts.get(did);
    if (didEntry) {
      if (now >= didEntry.resetAt) {
        // Expired — allow and will be reset on next recordUsage
      } else if (didEntry.count >= didDailyLimit) {
        return {
          allowed: false,
          reason: `DID daily limit reached (${didDailyLimit}/day). Upgrade to paid tier for unlimited access.`,
        };
      }
    }

    // Check IP limit
    const ipEntry = this.ipCounts.get(ip);
    if (ipEntry) {
      if (now >= ipEntry.resetAt) {
        // Expired — allow
      } else if (ipEntry.count >= FREE_TIER_IP_DAILY_LIMIT) {
        return {
          allowed: false,
          reason: `IP daily limit reached (${FREE_TIER_IP_DAILY_LIMIT}/day). Use a different IP or upgrade to paid tier.`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a request from a DID/IP combination.
   * Call this after successfully processing a request.
   */
  recordUsage(did: string, ip: string): void {
    const now = Date.now();
    const resetAt = nextMidnightUTC();

    // Update DID counter
    const didEntry = this.didCounts.get(did);
    if (!didEntry || now >= didEntry.resetAt) {
      this.didCounts.set(did, { count: 1, resetAt });
    } else {
      didEntry.count++;
    }

    // Update IP counter
    const ipEntry = this.ipCounts.get(ip);
    if (!ipEntry || now >= ipEntry.resetAt) {
      this.ipCounts.set(ip, { count: 1, resetAt });
    } else {
      ipEntry.count++;
    }
  }

  /**
   * Get remaining daily quota for a DID.
   *
   * @param did - The agent's DID:key
   * @param dailyLimit - Custom daily limit (default: FREE_TIER_DAILY_LIMIT)
   * @returns Number of remaining requests for today
   */
  getRemainingQuota(
    did: string,
    dailyLimit: number = FREE_TIER_DAILY_LIMIT,
  ): number {
    const didEntry = this.didCounts.get(did);
    if (!didEntry || Date.now() >= didEntry.resetAt) {
      return dailyLimit;
    }
    return Math.max(0, dailyLimit - didEntry.count);
  }

  /**
   * Remove expired entries from both maps.
   * Call periodically to prevent memory growth.
   */
  cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.didCounts) {
      if (now >= entry.resetAt) {
        this.didCounts.delete(key);
      }
    }

    for (const [key, entry] of this.ipCounts) {
      if (now >= entry.resetAt) {
        this.ipCounts.delete(key);
      }
    }
  }
}
