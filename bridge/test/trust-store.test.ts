/**
 * Trust Store Tests
 *
 * Tests for progressive trust — reputation-based limits that grow
 * with successful task completions.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TrustStore, TrustTier } from '../src/trust-store.js';

describe('TrustStore', () => {
  let store: TrustStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trust-store-test-'));
    store = new TrustStore(join(tempDir, 'trust.json'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Default profile
  // ==========================================================================

  describe('default profile', () => {
    it('returns NEW tier for unknown DID', () => {
      const profile = store.getProfile('did:key:z6MkUnknown');

      expect(profile.tier).toBe(TrustTier.NEW);
      expect(profile.completedTasks).toBe(0);
      expect(profile.failedTasks).toBe(0);
    });

    it('returns default limits for NEW tier', () => {
      const limits = store.getLimitsForDID('did:key:z6MkUnknown');

      expect(limits.dailyLimit).toBe(10);
      expect(limits.outputLimit).toBe(2000);
    });
  });

  // ==========================================================================
  // Task recording
  // ==========================================================================

  describe('task recording', () => {
    it('increments completedTasks on success', () => {
      store.recordCompletion('did:key:z6MkRecordA');
      store.recordCompletion('did:key:z6MkRecordA');

      const profile = store.getProfile('did:key:z6MkRecordA');
      expect(profile.completedTasks).toBe(2);
      expect(profile.failedTasks).toBe(0);
    });

    it('increments failedTasks on failure', () => {
      store.recordFailure('did:key:z6MkRecordB');

      const profile = store.getProfile('did:key:z6MkRecordB');
      expect(profile.completedTasks).toBe(0);
      expect(profile.failedTasks).toBe(1);
    });

    it('updates lastActivity timestamp', () => {
      const before = Date.now();
      store.recordCompletion('did:key:z6MkActivity');
      const after = Date.now();

      const profile = store.getProfile('did:key:z6MkActivity');
      expect(profile.lastActivity).toBeGreaterThanOrEqual(before);
      expect(profile.lastActivity).toBeLessThanOrEqual(after);
    });
  });

  // ==========================================================================
  // Tier promotion
  // ==========================================================================

  describe('tier promotion', () => {
    it('stays NEW with less than 5 completions', () => {
      for (let i = 0; i < 4; i++) {
        store.recordCompletion('did:key:z6MkStayNew');
      }

      expect(store.getProfile('did:key:z6MkStayNew').tier).toBe(TrustTier.NEW);
    });

    it('promotes to FAMILIAR after 5+ completions and 7+ days', () => {
      const did = 'did:key:z6MkFamiliar';

      // Set firstSeen 8 days ago
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(eightDaysAgo);
      store.recordCompletion(did); // creates profile with firstSeen = 8 days ago

      vi.useRealTimers();
      // Add 4 more completions (total 5)
      for (let i = 0; i < 4; i++) {
        store.recordCompletion(did);
      }

      expect(store.getProfile(did).tier).toBe(TrustTier.FAMILIAR);
    });

    it('does not promote to FAMILIAR if less than 7 days old', () => {
      const did = 'did:key:z6MkTooSoon';

      for (let i = 0; i < 10; i++) {
        store.recordCompletion(did);
      }

      // firstSeen is now, not 7 days ago
      expect(store.getProfile(did).tier).toBe(TrustTier.NEW);
    });

    it('promotes to ESTABLISHED after 20+ completions, 30+ days, <20% failure', () => {
      const did = 'did:key:z6MkEstablished';

      // Set firstSeen 31 days ago
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(thirtyOneDaysAgo);
      store.recordCompletion(did);

      vi.useRealTimers();
      // Add 19 more completions (total 20) and 3 failures (3/23 ≈ 13% < 20%)
      for (let i = 0; i < 19; i++) {
        store.recordCompletion(did);
      }
      for (let i = 0; i < 3; i++) {
        store.recordFailure(did);
      }

      expect(store.getProfile(did).tier).toBe(TrustTier.ESTABLISHED);
    });

    it('does not promote to ESTABLISHED if failure rate >= 20%', () => {
      const did = 'did:key:z6MkHighFailure';

      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(thirtyOneDaysAgo);
      store.recordCompletion(did);

      vi.useRealTimers();
      for (let i = 0; i < 19; i++) {
        store.recordCompletion(did);
      }
      // 6 failures → 6/26 ≈ 23% > 20%
      for (let i = 0; i < 6; i++) {
        store.recordFailure(did);
      }

      // Should be FAMILIAR (has 7+ days, 5+ completions) but not ESTABLISHED
      expect(store.getProfile(did).tier).toBe(TrustTier.FAMILIAR);
    });

    it('promotes to TRUSTED after 50+ completions, 90+ days, <10% failure', () => {
      const did = 'did:key:z6MkTrusted';

      const ninetyOneDaysAgo = Date.now() - 91 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(ninetyOneDaysAgo);
      store.recordCompletion(did);

      vi.useRealTimers();
      for (let i = 0; i < 49; i++) {
        store.recordCompletion(did);
      }
      // 4 failures → 4/54 ≈ 7.4% < 10%
      for (let i = 0; i < 4; i++) {
        store.recordFailure(did);
      }

      expect(store.getProfile(did).tier).toBe(TrustTier.TRUSTED);
    });
  });

  // ==========================================================================
  // Tier-based limits
  // ==========================================================================

  describe('tier-based limits', () => {
    it('returns FAMILIAR limits: 25/day, 5000 output', () => {
      const did = 'did:key:z6MkFamLimits';
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(eightDaysAgo);
      store.recordCompletion(did);
      vi.useRealTimers();
      for (let i = 0; i < 4; i++) store.recordCompletion(did);

      const limits = store.getLimitsForDID(did);
      expect(limits.dailyLimit).toBe(25);
      expect(limits.outputLimit).toBe(5000);
    });

    it('returns ESTABLISHED limits: 50/day, unlimited output', () => {
      const did = 'did:key:z6MkEstLimits';
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(thirtyOneDaysAgo);
      store.recordCompletion(did);
      vi.useRealTimers();
      for (let i = 0; i < 19; i++) store.recordCompletion(did);

      const limits = store.getLimitsForDID(did);
      expect(limits.dailyLimit).toBe(50);
      expect(limits.outputLimit).toBe(0); // 0 = unlimited
    });

    it('returns TRUSTED limits: 100/day, unlimited output', () => {
      const did = 'did:key:z6MkTrustLimits';
      const ninetyOneDaysAgo = Date.now() - 91 * 24 * 60 * 60 * 1000;
      vi.setSystemTime(ninetyOneDaysAgo);
      store.recordCompletion(did);
      vi.useRealTimers();
      for (let i = 0; i < 49; i++) store.recordCompletion(did);

      const limits = store.getLimitsForDID(did);
      expect(limits.dailyLimit).toBe(100);
      expect(limits.outputLimit).toBe(0);
    });
  });

  // ==========================================================================
  // Persistence
  // ==========================================================================

  describe('persistence', () => {
    it('persists profiles to JSON file', () => {
      store.recordCompletion('did:key:z6MkPersist');
      store.save();

      expect(existsSync(join(tempDir, 'trust.json'))).toBe(true);
      const data = JSON.parse(readFileSync(join(tempDir, 'trust.json'), 'utf-8'));
      expect(data['did:key:z6MkPersist']).toBeDefined();
      expect(data['did:key:z6MkPersist'].completedTasks).toBe(1);
    });

    it('loads profiles from existing JSON file', () => {
      store.recordCompletion('did:key:z6MkLoad');
      store.recordCompletion('did:key:z6MkLoad');
      store.save();

      // Create a new store from the same file
      const store2 = new TrustStore(join(tempDir, 'trust.json'));
      const profile = store2.getProfile('did:key:z6MkLoad');

      expect(profile.completedTasks).toBe(2);
    });

    it('handles missing persistence file gracefully', () => {
      const store2 = new TrustStore(join(tempDir, 'nonexistent.json'));
      const profile = store2.getProfile('did:key:z6MkMissing');

      expect(profile.tier).toBe(TrustTier.NEW);
    });

    it('handles corrupted persistence file gracefully', () => {
      const { writeFileSync } = require('node:fs');
      writeFileSync(join(tempDir, 'corrupt.json'), 'not json!');

      const store2 = new TrustStore(join(tempDir, 'corrupt.json'));
      const profile = store2.getProfile('did:key:z6MkCorrupt');

      expect(profile.tier).toBe(TrustTier.NEW);
    });
  });
});
