/**
 * Trust Store — Progressive Trust for DID:key Free Tier
 *
 * Tracks agent reputation and promotes DIDs through trust tiers based on
 * successful task completions, account age, and failure rate.
 * No blockchain required — purely server-side tracking with JSON persistence.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export enum TrustTier {
  NEW = 'new',
  FAMILIAR = 'familiar',
  ESTABLISHED = 'established',
  TRUSTED = 'trusted',
}

export interface TrustProfile {
  did: string;
  tier: TrustTier;
  firstSeen: number;
  completedTasks: number;
  failedTasks: number;
  lastActivity: number;
}

/** Limits for each trust tier */
const TIER_LIMITS: Record<TrustTier, { dailyLimit: number; outputLimit: number }> = {
  [TrustTier.NEW]:         { dailyLimit: 10,  outputLimit: 2000 },
  [TrustTier.FAMILIAR]:    { dailyLimit: 25,  outputLimit: 5000 },
  [TrustTier.ESTABLISHED]: { dailyLimit: 50,  outputLimit: 0 },    // 0 = unlimited
  [TrustTier.TRUSTED]:     { dailyLimit: 100, outputLimit: 0 },
};

/** Promotion thresholds */
const FAMILIAR_MIN_DAYS = 7;
const FAMILIAR_MIN_COMPLETIONS = 5;

const ESTABLISHED_MIN_DAYS = 30;
const ESTABLISHED_MIN_COMPLETIONS = 20;
const ESTABLISHED_MAX_FAILURE_RATE = 0.20;

const TRUSTED_MIN_DAYS = 90;
const TRUSTED_MIN_COMPLETIONS = 50;
const TRUSTED_MAX_FAILURE_RATE = 0.10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Maximum number of trust profiles to keep in memory (LRU eviction) */
export const MAX_TRUST_PROFILES = 10000;

export class TrustStore {
  private profiles: Map<string, TrustProfile> = new Map();
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.load();
  }

  /**
   * Get the trust profile for a DID. Creates a default NEW profile if unknown.
   * Also re-evaluates the tier based on current stats.
   */
  getProfile(did: string): TrustProfile {
    let profile = this.profiles.get(did);
    if (!profile) {
      // Enforce MAX_TRUST_PROFILES with LRU eviction before adding new entry
      if (this.profiles.size >= MAX_TRUST_PROFILES) {
        this.evictLRU();
      }
      profile = {
        did,
        tier: TrustTier.NEW,
        firstSeen: Date.now(),
        completedTasks: 0,
        failedTasks: 0,
        lastActivity: Date.now(),
      };
      this.profiles.set(did, profile);
    } else {
      // Move to end of Map iteration order (LRU refresh)
      this.profiles.delete(did);
      this.profiles.set(did, profile);
    }
    // Always re-evaluate tier
    profile.tier = this.evaluateTier(profile);
    return profile;
  }

  /**
   * Evict the least recently used profile (first entry in Map iteration order).
   */
  private evictLRU(): void {
    const firstKey = this.profiles.keys().next().value;
    if (firstKey !== undefined) {
      this.profiles.delete(firstKey);
    }
  }

  /**
   * Record a successful task completion for a DID.
   */
  recordCompletion(did: string): void {
    const profile = this.getProfile(did);
    profile.completedTasks++;
    profile.lastActivity = Date.now();
    profile.tier = this.evaluateTier(profile);
  }

  /**
   * Record a failed task for a DID.
   */
  recordFailure(did: string): void {
    const profile = this.getProfile(did);
    profile.failedTasks++;
    profile.lastActivity = Date.now();
    profile.tier = this.evaluateTier(profile);
  }

  /**
   * Get the rate limits for a DID based on their trust tier.
   */
  getLimitsForDID(did: string): { dailyLimit: number; outputLimit: number } {
    const profile = this.getProfile(did);
    return { ...TIER_LIMITS[profile.tier] };
  }

  /**
   * Persist all profiles to the JSON file.
   */
  save(): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const data: Record<string, TrustProfile> = {};
      for (const [did, profile] of this.profiles) {
        data[did] = profile;
      }
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[TrustStore] Failed to save: ${err}`);
    }
  }

  /**
   * Evaluate which trust tier a profile qualifies for.
   * Checks from highest to lowest tier.
   */
  private evaluateTier(profile: TrustProfile): TrustTier {
    const ageDays = (Date.now() - profile.firstSeen) / MS_PER_DAY;
    const total = profile.completedTasks + profile.failedTasks;
    const failureRate = total > 0 ? profile.failedTasks / total : 0;

    // Check TRUSTED
    if (
      ageDays >= TRUSTED_MIN_DAYS &&
      profile.completedTasks >= TRUSTED_MIN_COMPLETIONS &&
      failureRate < TRUSTED_MAX_FAILURE_RATE
    ) {
      return TrustTier.TRUSTED;
    }

    // Check ESTABLISHED
    if (
      ageDays >= ESTABLISHED_MIN_DAYS &&
      profile.completedTasks >= ESTABLISHED_MIN_COMPLETIONS &&
      failureRate < ESTABLISHED_MAX_FAILURE_RATE
    ) {
      return TrustTier.ESTABLISHED;
    }

    // Check FAMILIAR
    if (
      ageDays >= FAMILIAR_MIN_DAYS &&
      profile.completedTasks >= FAMILIAR_MIN_COMPLETIONS
    ) {
      return TrustTier.FAMILIAR;
    }

    return TrustTier.NEW;
  }

  /** DID format validation — prevents prototype pollution via malicious keys */
  private static readonly DID_KEY_PATTERN = /^(did:[a-z]+:[a-zA-Z0-9._:%-]+|[a-zA-Z0-9._-]{1,128})$/;

  /**
   * Load profiles from the persistence file.
   * Uses Object.create(null) to prevent prototype pollution from JSON keys.
   */
  private load(): void {
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      // Parse into a null-prototype object to prevent __proto__ pollution
      const data: Record<string, TrustProfile> = Object.assign(
        Object.create(null),
        JSON.parse(raw),
      );
      for (const did of Object.keys(data)) {
        // H-4: Skip keys that could cause prototype pollution or aren't valid identifiers
        if (!TrustStore.DID_KEY_PATTERN.test(did)) {
          continue;
        }
        const profile = data[did];
        if (profile && typeof profile === 'object' && profile.did) {
          this.profiles.set(did, profile);
        }
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }
  }
}
