/**
 * TrustClient Utility Methods Tests
 *
 * Tests for the pure utility methods on TrustClient:
 * - calculateEscrowRequirement (trust-based escrow percentage calculation)
 * - formatTrustScore (display formatting)
 *
 * These test critical business logic for the payment/trust system.
 */

import { describe, it, expect, vi } from 'vitest';
import { TrustClient } from '../../src/trust.js';
import type { AgoraMeshClient } from '../../src/client.js';

// =============================================================================
// Setup
// =============================================================================

function createMinimalMockClient(): AgoraMeshClient {
  return {
    getPublicClient: vi.fn(() => null),
    getWalletClient: vi.fn(() => null),
    getContractAddresses: vi.fn(() => ({})),
    getAddress: vi.fn(() => null),
  } as unknown as AgoraMeshClient;
}

// =============================================================================
// calculateEscrowRequirement Tests
// =============================================================================

describe('TrustClient.calculateEscrowRequirement', () => {
  const trust = new TrustClient(createMinimalMockClient());

  describe('trust score tiers', () => {
    it('should require 0% escrow for trust > 0.9', () => {
      expect(trust.calculateEscrowRequirement(0.91, '100')).toBe('0.00');
      expect(trust.calculateEscrowRequirement(0.95, '1000')).toBe('0.00');
      expect(trust.calculateEscrowRequirement(1.0, '500')).toBe('0.00');
    });

    it('should require 20% escrow for trust 0.7-0.9', () => {
      expect(trust.calculateEscrowRequirement(0.71, '100')).toBe('20.00');
      expect(trust.calculateEscrowRequirement(0.8, '1000')).toBe('200.00');
      expect(trust.calculateEscrowRequirement(0.9, '500')).toBe('100.00');
    });

    it('should require 50% escrow for trust 0.5-0.7', () => {
      expect(trust.calculateEscrowRequirement(0.51, '100')).toBe('50.00');
      expect(trust.calculateEscrowRequirement(0.6, '1000')).toBe('500.00');
      expect(trust.calculateEscrowRequirement(0.7, '500')).toBe('250.00');
    });

    it('should require 100% escrow for trust <= 0.5', () => {
      expect(trust.calculateEscrowRequirement(0.5, '100')).toBe('100.00');
      expect(trust.calculateEscrowRequirement(0.3, '1000')).toBe('1000.00');
      expect(trust.calculateEscrowRequirement(0.0, '500')).toBe('500.00');
    });
  });

  describe('edge cases', () => {
    it('should handle zero task value', () => {
      expect(trust.calculateEscrowRequirement(0.5, '0')).toBe('0.00');
      expect(trust.calculateEscrowRequirement(0.8, '0')).toBe('0.00');
    });

    it('should handle fractional task values', () => {
      expect(trust.calculateEscrowRequirement(0.5, '0.50')).toBe('0.50');
      expect(trust.calculateEscrowRequirement(0.8, '0.10')).toBe('0.02');
    });

    it('should handle boundary trust scores exactly', () => {
      // Exactly at 0.9 boundary (> 0.9 required for 0%)
      expect(trust.calculateEscrowRequirement(0.9, '100')).not.toBe('0.00'); // 0.9 is not > 0.9
      // Exactly at 0.7 boundary (> 0.7 required for 20%)
      expect(trust.calculateEscrowRequirement(0.7, '100')).not.toBe('20.00'); // 0.7 is not > 0.7
      // Exactly at 0.5 boundary (> 0.5 required for 50%)
      expect(trust.calculateEscrowRequirement(0.5, '100')).not.toBe('50.00'); // 0.5 is not > 0.5
    });

    it('should use integer arithmetic for precision', () => {
      // This tests that we don't get floating-point errors
      // e.g., 0.1 + 0.2 !== 0.3 in floating point
      const result = trust.calculateEscrowRequirement(0.8, '0.10');
      // 20% of $0.10 = $0.02 exactly
      expect(result).toBe('0.02');
    });
  });
});

// =============================================================================
// formatTrustScore Tests
// =============================================================================

describe('TrustClient.formatTrustScore', () => {
  const trust = new TrustClient(createMinimalMockClient());

  it('should format zero score', () => {
    expect(trust.formatTrustScore(0)).toBe('0.0%');
  });

  it('should format perfect score', () => {
    expect(trust.formatTrustScore(1.0)).toBe('100.0%');
  });

  it('should format typical scores with one decimal', () => {
    expect(trust.formatTrustScore(0.855)).toBe('85.5%');
    expect(trust.formatTrustScore(0.5)).toBe('50.0%');
    expect(trust.formatTrustScore(0.333)).toBe('33.3%');
  });

  it('should round correctly', () => {
    // 0.8555 * 100 = 85.55, toFixed(1) produces '85.5' or '85.6' depending on
    // IEEE 754 representation. Use values with clear rounding direction.
    expect(trust.formatTrustScore(0.8556)).toBe('85.6%'); // rounds up
    expect(trust.formatTrustScore(0.8544)).toBe('85.4%'); // rounds down
  });
});
