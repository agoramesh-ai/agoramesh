/**
 * Rate Limit Persistence Tests
 *
 * Tests for file-based persistence of rate limit counters across restarts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitStore } from '../src/rate-limit-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Create a temp directory for each test
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agoramesh-rl-test-'));
  storePath = path.join(tempDir, 'rate-limits.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('RateLimitStore', () => {
  // =========================================================================
  // Save and load
  // =========================================================================

  describe('save and load', () => {
    it('saves counts to file', () => {
      const store = new RateLimitStore(storePath);
      store.setEntry('did:key:z6MkTest', 'did', 5, Date.now() + 86400000);
      store.save();

      expect(fs.existsSync(storePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      expect(data.did['did:key:z6MkTest']).toBeDefined();
      expect(data.did['did:key:z6MkTest'].count).toBe(5);
    });

    it('loads counts from file', () => {
      const resetAt = Date.now() + 86400000;
      const data = {
        did: { 'did:key:z6MkTest': { count: 7, resetAt } },
        ip: { '1.2.3.4': { count: 3, resetAt } },
      };
      fs.writeFileSync(storePath, JSON.stringify(data));

      const store = new RateLimitStore(storePath);
      store.load();

      const didEntry = store.getEntry('did:key:z6MkTest', 'did');
      expect(didEntry).toBeDefined();
      expect(didEntry!.count).toBe(7);

      const ipEntry = store.getEntry('1.2.3.4', 'ip');
      expect(ipEntry).toBeDefined();
      expect(ipEntry!.count).toBe(3);
    });

    it('handles missing file gracefully on load', () => {
      const store = new RateLimitStore(storePath);
      // Should not throw
      store.load();
      expect(store.getEntry('did:key:z6MkTest', 'did')).toBeUndefined();
    });

    it('handles corrupted file gracefully on load', () => {
      fs.writeFileSync(storePath, 'not valid json');

      const store = new RateLimitStore(storePath);
      // Should not throw
      store.load();
      expect(store.getEntry('did:key:z6MkTest', 'did')).toBeUndefined();
    });
  });

  // =========================================================================
  // Expired entry cleanup
  // =========================================================================

  describe('expired entry cleanup', () => {
    it('does not load expired entries', () => {
      const expired = Date.now() - 1000; // already expired
      const data = {
        did: { 'did:key:z6MkExpired': { count: 5, resetAt: expired } },
        ip: { '1.2.3.4': { count: 3, resetAt: expired } },
      };
      fs.writeFileSync(storePath, JSON.stringify(data));

      const store = new RateLimitStore(storePath);
      store.load();

      expect(store.getEntry('did:key:z6MkExpired', 'did')).toBeUndefined();
      expect(store.getEntry('1.2.3.4', 'ip')).toBeUndefined();
    });

    it('removes expired entries during cleanup', () => {
      const store = new RateLimitStore(storePath);
      const expired = Date.now() - 1000;
      const valid = Date.now() + 86400000;

      store.setEntry('did:key:z6MkExpired', 'did', 5, expired);
      store.setEntry('did:key:z6MkValid', 'did', 3, valid);

      store.cleanup();

      expect(store.getEntry('did:key:z6MkExpired', 'did')).toBeUndefined();
      expect(store.getEntry('did:key:z6MkValid', 'did')).toBeDefined();
    });
  });

  // =========================================================================
  // File permissions
  // =========================================================================

  describe('file permissions', () => {
    it('creates file with 0600 permissions', () => {
      const store = new RateLimitStore(storePath);
      store.setEntry('did:key:z6MkTest', 'did', 1, Date.now() + 86400000);
      store.save();

      const stats = fs.statSync(storePath);
      // 0600 = owner read/write only (octal 33152 on some systems)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  // =========================================================================
  // Directory creation
  // =========================================================================

  describe('directory creation', () => {
    it('creates parent directory if it does not exist', () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'rate-limits.json');
      const store = new RateLimitStore(nestedPath);
      store.setEntry('did:key:z6MkTest', 'did', 1, Date.now() + 86400000);
      store.save();

      expect(fs.existsSync(nestedPath)).toBe(true);
    });
  });

  // =========================================================================
  // Round-trip
  // =========================================================================

  describe('round-trip persistence', () => {
    it('survives save and reload cycle', () => {
      const resetAt = Date.now() + 86400000;

      // Instance 1: write data
      const store1 = new RateLimitStore(storePath);
      store1.setEntry('did:key:z6MkA', 'did', 5, resetAt);
      store1.setEntry('10.0.0.1', 'ip', 12, resetAt);
      store1.save();

      // Instance 2: read data back
      const store2 = new RateLimitStore(storePath);
      store2.load();

      expect(store2.getEntry('did:key:z6MkA', 'did')!.count).toBe(5);
      expect(store2.getEntry('10.0.0.1', 'ip')!.count).toBe(12);
    });
  });
});
