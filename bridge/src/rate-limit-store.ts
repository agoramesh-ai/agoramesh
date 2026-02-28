/**
 * Rate Limit Persistence Store
 *
 * File-based persistence for rate limit counters to survive restarts.
 * Stores DID and IP daily counts to ~/.agoramesh/rate-limits.json.
 *
 * Features:
 * - Saves to file periodically (every 60s) and on shutdown
 * - Loads from file on startup
 * - Automatically cleans up expired entries
 * - File permissions set to 0600 (owner read/write only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StoredEntry {
  count: number;
  resetAt: number; // Unix timestamp (ms) of next midnight UTC
}

interface StoreData {
  did: Record<string, StoredEntry>;
  ip: Record<string, StoredEntry>;
}

export class RateLimitStore {
  private readonly filePath: string;
  private didEntries: Map<string, StoredEntry> = new Map();
  private ipEntries: Map<string, StoredEntry> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load rate limit data from the persistence file.
   * Silently ignores missing or corrupted files.
   * Discards expired entries during load.
   */
  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data: StoreData = JSON.parse(raw);
      const now = Date.now();

      this.loadEntries(data.did, this.didEntries, now);
      this.loadEntries(data.ip, this.ipEntries, now);
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }
  }

  private loadEntries(
    source: Record<string, StoredEntry> | undefined,
    target: Map<string, StoredEntry>,
    now: number,
  ): void {
    if (!source || typeof source !== 'object') return;
    for (const [key, entry] of Object.entries(source)) {
      if (entry && typeof entry.count === 'number' && typeof entry.resetAt === 'number') {
        if (entry.resetAt > now) {
          target.set(key, entry);
        }
      }
    }
  }

  /**
   * Save current rate limit data to the persistence file.
   * Creates parent directories if they don't exist.
   * Sets file permissions to 0600.
   */
  save(): void {
    const data: StoreData = {
      did: Object.fromEntries(this.didEntries),
      ip: Object.fromEntries(this.ipEntries),
    };

    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const content = JSON.stringify(data);
    fs.writeFileSync(this.filePath, content, { mode: 0o600 });
  }

  /**
   * Get an entry from the store.
   */
  getEntry(key: string, type: 'did' | 'ip'): StoredEntry | undefined {
    const map = type === 'did' ? this.didEntries : this.ipEntries;
    return map.get(key);
  }

  /**
   * Set or update an entry in the store.
   */
  setEntry(key: string, type: 'did' | 'ip', count: number, resetAt: number): void {
    const map = type === 'did' ? this.didEntries : this.ipEntries;
    map.set(key, { count, resetAt });
  }

  /**
   * Remove expired entries from both maps.
   */
  cleanup(): void {
    const now = Date.now();

    for (const [key, entry] of this.didEntries) {
      if (now >= entry.resetAt) {
        this.didEntries.delete(key);
      }
    }

    for (const [key, entry] of this.ipEntries) {
      if (now >= entry.resetAt) {
        this.ipEntries.delete(key);
      }
    }
  }

  /**
   * Get all DID entries (for syncing with FreeTierLimiter).
   */
  getAllDidEntries(): Map<string, StoredEntry> {
    return this.didEntries;
  }

  /**
   * Get all IP entries (for syncing with FreeTierLimiter).
   */
  getAllIpEntries(): Map<string, StoredEntry> {
    return this.ipEntries;
  }
}
