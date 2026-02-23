/**
 * Free Tier Rate Limiter Tests
 *
 * Tests for per-DID and per-IP rate limiting with daily quotas.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FreeTierLimiter } from '../src/free-tier-limiter.js';

describe('FreeTierLimiter', () => {
  let limiter: FreeTierLimiter;

  beforeEach(() => {
    limiter = new FreeTierLimiter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Basic quota
  // ==========================================================================

  describe('basic quota', () => {
    it('allows first request from a new DID', () => {
      const result = limiter.canProceed('did:key:z6MkTestA', '1.2.3.4');
      expect(result.allowed).toBe(true);
    });

    it('tracks usage and decrements remaining quota', () => {
      limiter.recordUsage('did:key:z6MkTestA', '1.2.3.4');
      const remaining = limiter.getRemainingQuota('did:key:z6MkTestA');
      expect(remaining).toBe(9); // 10 - 1
    });

    it('returns full quota for unknown DID', () => {
      const remaining = limiter.getRemainingQuota('did:key:z6MkUnknown');
      expect(remaining).toBe(10);
    });
  });

  // ==========================================================================
  // Per-DID limits
  // ==========================================================================

  describe('per-DID limits', () => {
    it('blocks after 10 requests from the same DID', () => {
      const did = 'did:key:z6MkTestB';
      for (let i = 0; i < 10; i++) {
        expect(limiter.canProceed(did, `10.0.0.${i}`).allowed).toBe(true);
        limiter.recordUsage(did, `10.0.0.${i}`);
      }

      const result = limiter.canProceed(did, '10.0.0.99');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/daily limit/i);
    });

    it('allows a different DID after first DID is exhausted', () => {
      const did1 = 'did:key:z6MkTestC';
      const did2 = 'did:key:z6MkTestD';

      for (let i = 0; i < 10; i++) {
        limiter.recordUsage(did1, '1.2.3.4');
      }

      expect(limiter.canProceed(did1, '1.2.3.4').allowed).toBe(false);
      expect(limiter.canProceed(did2, '5.6.7.8').allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Per-IP limits (Sybil resistance)
  // ==========================================================================

  describe('per-IP limits', () => {
    it('blocks after 20 requests from the same IP across different DIDs', () => {
      const ip = '192.168.1.1';

      for (let i = 0; i < 20; i++) {
        const did = `did:key:z6MkIP${i}`;
        expect(limiter.canProceed(did, ip).allowed).toBe(true);
        limiter.recordUsage(did, ip);
      }

      const result = limiter.canProceed('did:key:z6MkIP20', ip);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/IP.*limit/i);
    });

    it('allows a different IP after first IP is exhausted', () => {
      const ip1 = '192.168.1.1';
      const ip2 = '192.168.1.2';

      for (let i = 0; i < 20; i++) {
        limiter.recordUsage(`did:key:z6MkIPalt${i}`, ip1);
      }

      expect(limiter.canProceed('did:key:z6MkIPalt20', ip1).allowed).toBe(false);
      expect(limiter.canProceed('did:key:z6MkIPalt20', ip2).allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Daily reset
  // ==========================================================================

  describe('daily reset', () => {
    it('resets DID quota at midnight UTC', () => {
      const did = 'did:key:z6MkResetTest';

      for (let i = 0; i < 10; i++) {
        limiter.recordUsage(did, '1.2.3.4');
      }
      expect(limiter.canProceed(did, '1.2.3.4').allowed).toBe(false);

      // Advance time past midnight UTC
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 1, 0); // 00:00:01 UTC tomorrow
      vi.setSystemTime(tomorrow);

      expect(limiter.canProceed(did, '1.2.3.4').allowed).toBe(true);
      expect(limiter.getRemainingQuota(did)).toBe(10);
    });

    it('resets IP quota at midnight UTC', () => {
      const ip = '10.20.30.40';

      for (let i = 0; i < 20; i++) {
        limiter.recordUsage(`did:key:z6MkReset2_${i}`, ip);
      }
      expect(limiter.canProceed('did:key:z6MkReset2_20', ip).allowed).toBe(false);

      // Advance time past midnight UTC
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 1, 0);
      vi.setSystemTime(tomorrow);

      expect(limiter.canProceed('did:key:z6MkReset2_20', ip).allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Custom limits (for trust store integration)
  // ==========================================================================

  describe('custom limits', () => {
    it('respects custom DID daily limit', () => {
      const result = limiter.canProceed('did:key:z6MkCustom', '1.2.3.4', 25);
      expect(result.allowed).toBe(true);

      for (let i = 0; i < 25; i++) {
        limiter.recordUsage('did:key:z6MkCustom', '1.2.3.4');
      }

      // Should still be blocked at 25 with custom limit
      expect(limiter.canProceed('did:key:z6MkCustom', '1.2.3.4', 25).allowed).toBe(false);
      // But would be blocked at 10 with default limit
      expect(limiter.canProceed('did:key:z6MkCustom', '1.2.3.4').allowed).toBe(false);
    });

    it('getRemainingQuota reflects custom limit', () => {
      limiter.recordUsage('did:key:z6MkCustom2', '1.2.3.4');
      expect(limiter.getRemainingQuota('did:key:z6MkCustom2', 25)).toBe(24);
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  describe('cleanup', () => {
    it('removes expired entries on cleanup', () => {
      limiter.recordUsage('did:key:z6MkCleanup', '1.2.3.4');

      // Advance time past midnight UTC
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 1, 0);
      vi.setSystemTime(tomorrow);

      limiter.cleanup();

      // Internal maps should be empty (we verify by checking quota is full)
      expect(limiter.getRemainingQuota('did:key:z6MkCleanup')).toBe(10);
    });
  });
});
