/**
 * Cross-Chain Trust Sync E2E Tests
 *
 * Tests for the complete cross-chain trust synchronization flow including:
 * - Trust score sync from primary to secondary chains
 * - Cache validation and staleness detection
 * - Multi-chain trust aggregation
 * - Request-response sync patterns
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { keccak256, toHex, parseUnits, type PublicClient, type WalletClient, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CrossChainTrustClient, type CrossChainConfig, type CachedTrustScore } from '../../src/crosschain.js';
import {
  TEST_CHAIN_ID,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_DIDS,
  createTestTrustScore,
} from './setup.js';

// =============================================================================
// Test Constants
// =============================================================================

const PRIMARY_CHAIN_ID = 8453; // Base Mainnet
const SECONDARY_CHAIN_ID = 84532; // Base Sepolia
const PRIMARY_ENDPOINT_ID = 30184;
const SECONDARY_ENDPOINT_ID = 40245;

const CROSS_CHAIN_SYNC_ADDRESS = '0x1234567890123456789012345678901234567890' as const;
const CHAIN_REGISTRY_ADDRESS = '0x2345678901234567890123456789012345678901' as const;

const CACHE_TTL_SECONDS = 86400; // 1 day

// =============================================================================
// Mock Infrastructure
// =============================================================================

interface MockChainState {
  cachedScores: Map<string, { trustScore: bigint; lastUpdated: bigint; exists: boolean }>;
  isPrimary: boolean;
  localTrustScores: Map<string, bigint>;
  supportedDestinations: number[];
}

function createMockChainState(isPrimary: boolean): MockChainState {
  return {
    cachedScores: new Map(),
    isPrimary,
    localTrustScores: new Map(),
    supportedDestinations: isPrimary ? [SECONDARY_ENDPOINT_ID] : [PRIMARY_ENDPOINT_ID],
  };
}

function createCrossChainMockPublicClient(state: MockChainState) {
  const mockClient = {
    readContract: vi.fn().mockImplementation(async ({ functionName, args }) => {
      switch (functionName) {
        case 'getCachedTrustScore': {
          const didHash = args[0] as string;
          const cached = state.cachedScores.get(didHash);
          if (!cached) {
            return [0n, 0n, false];
          }
          return [cached.trustScore, cached.lastUpdated, cached.exists];
        }

        case 'getAggregatedTrustScore': {
          const didHash = args[0] as string;
          // Return local score on primary, cached score on secondary
          if (state.isPrimary) {
            return state.localTrustScores.get(didHash) ?? 0n;
          }
          const cached = state.cachedScores.get(didHash);
          return cached?.trustScore ?? 0n;
        }

        case 'isCacheStale': {
          const didHash = args[0] as string;
          const cached = state.cachedScores.get(didHash);
          if (!cached || !cached.exists) {
            return true;
          }
          const now = BigInt(Math.floor(Date.now() / 1000));
          const age = now - cached.lastUpdated;
          return age > BigInt(CACHE_TTL_SECONDS);
        }

        case 'isPrimaryChain':
          return state.isPrimary;

        case 'getSupportedDestinations':
          return state.supportedDestinations.map(BigInt);

        case 'primaryChainId':
          return BigInt(PRIMARY_CHAIN_ID);

        case 'cacheTTL':
          return BigInt(CACHE_TTL_SECONDS);

        case 'quoteSyncFee':
          // Return a mock fee based on destination
          return parseUnits('0.001', 18); // 0.001 ETH

        case 'getChain': {
          const chainId = Number(args[0]);
          if (chainId === PRIMARY_CHAIN_ID) {
            return {
              chainId: BigInt(PRIMARY_CHAIN_ID),
              name: 'Base Mainnet',
              isTestnet: false,
              isActive: true,
              trustRegistry: '0x1111111111111111111111111111111111111111' as Address,
              usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
              endpoint: '0x1a44076050125825900e736c501f859c50fE728c' as Address,
            };
          } else if (chainId === SECONDARY_CHAIN_ID) {
            return {
              chainId: BigInt(SECONDARY_CHAIN_ID),
              name: 'Base Sepolia',
              isTestnet: true,
              isActive: true,
              trustRegistry: '0x2222222222222222222222222222222222222222' as Address,
              usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
              endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' as Address,
            };
          }
          throw new Error(`Unknown chain: ${chainId}`);
        }

        case 'getAllChains':
          return [BigInt(PRIMARY_CHAIN_ID), BigInt(SECONDARY_CHAIN_ID)];

        case 'isChainSupported': {
          const chainId = Number(args[0]);
          return chainId === PRIMARY_CHAIN_ID || chainId === SECONDARY_CHAIN_ID;
        }

        default:
          throw new Error(`Unhandled readContract: ${functionName}`);
      }
    }),

    // simulateContract should return the request for writeContract
    simulateContract: vi.fn().mockImplementation(async (params) => {
      return { request: params };
    }),
  };

  return mockClient;
}

function createCrossChainMockWalletClient(
  primaryState: MockChainState,
  secondaryState: MockChainState
) {
  return {
    account: privateKeyToAccount(TEST_PRIVATE_KEYS.client),
    writeContract: vi.fn().mockImplementation(async (request) => {
      // The request comes from simulateContract and contains the original params
      const { functionName, args } = request;
      const txHash = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}` as `0x${string}`;

      switch (functionName) {
        case 'syncTrustScore': {
          // Simulate syncing trust score from primary to secondary
          const destinationEid = Number(args[0]);
          const didHash = args[1] as string;
          const trustScore = args[2] as bigint;

          if (destinationEid === SECONDARY_ENDPOINT_ID) {
            // Update secondary chain's cached score
            secondaryState.cachedScores.set(didHash, {
              trustScore,
              lastUpdated: BigInt(Math.floor(Date.now() / 1000)),
              exists: true,
            });
          }
          break;
        }

        case 'requestTrustSync': {
          // Simulate requesting sync from secondary to primary
          const destinationEid = Number(args[0]);
          const didHash = args[1] as string;

          if (destinationEid === PRIMARY_ENDPOINT_ID) {
            // Get trust score from primary and update secondary cache
            const primaryScore = primaryState.localTrustScores.get(didHash) ?? 0n;
            secondaryState.cachedScores.set(didHash, {
              trustScore: primaryScore,
              lastUpdated: BigInt(Math.floor(Date.now() / 1000)),
              exists: true,
            });
          }
          break;
        }
      }

      return txHash;
    }),
  };
}

// =============================================================================
// Primary to Secondary Chain Sync
// =============================================================================

describe('Cross-Chain Trust Sync: Primary to Secondary', () => {
  let primaryClient: CrossChainTrustClient;
  let secondaryClient: CrossChainTrustClient;
  let primaryState: MockChainState;
  let secondaryState: MockChainState;

  beforeEach(() => {
    primaryState = createMockChainState(true);
    secondaryState = createMockChainState(false);

    const primaryPublicClient = createCrossChainMockPublicClient(primaryState);
    const secondaryPublicClient = createCrossChainMockPublicClient(secondaryState);
    const walletClient = createCrossChainMockWalletClient(primaryState, secondaryState);

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    primaryClient = new CrossChainTrustClient(
      primaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );

    secondaryClient = new CrossChainTrustClient(
      secondaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );
  });

  it('should sync trust score from primary to secondary chain', async () => {
    const testDid = TEST_DIDS.provider;
    const didHash = keccak256(toHex(testDid));
    const trustScore = 8500; // 85%

    // Set up trust score on primary chain
    primaryState.localTrustScores.set(didHash, BigInt(trustScore));

    // Verify secondary chain has no cached score
    const beforeCache = await secondaryClient.getCachedTrustScore(testDid);
    expect(beforeCache.exists).toBe(false);

    // Sync trust score from primary to secondary
    const result = await primaryClient.syncTrustScore({
      destinationEid: SECONDARY_ENDPOINT_ID,
      did: testDid,
      trustScore,
    });

    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify secondary chain now has cached score
    const afterCache = await secondaryClient.getCachedTrustScore(testDid);
    expect(afterCache.exists).toBe(true);
    expect(afterCache.trustScore).toBe(trustScore);
  });

  it('should update stale cache on secondary chain', async () => {
    const testDid = TEST_DIDS.provider;
    const didHash = keccak256(toHex(testDid));
    const oldScore = 7000;
    const newScore = 8500;

    // Set up old cached score (beyond TTL)
    const staleTimestamp = BigInt(Math.floor(Date.now() / 1000) - CACHE_TTL_SECONDS - 3600);
    secondaryState.cachedScores.set(didHash, {
      trustScore: BigInt(oldScore),
      lastUpdated: staleTimestamp,
      exists: true,
    });

    // Verify cache is stale
    const isStale = await secondaryClient.isCacheStale(testDid);
    expect(isStale).toBe(true);

    // Set new score on primary
    primaryState.localTrustScores.set(didHash, BigInt(newScore));

    // Sync new score
    await primaryClient.syncTrustScore({
      destinationEid: SECONDARY_ENDPOINT_ID,
      did: testDid,
      trustScore: newScore,
    });

    // Verify cache is updated
    const cache = await secondaryClient.getCachedTrustScore(testDid);
    expect(cache.trustScore).toBe(newScore);

    // Cache should no longer be stale
    const isStaleAfter = await secondaryClient.isCacheStale(testDid);
    expect(isStaleAfter).toBe(false);
  });

  it('should identify primary and secondary chains correctly', async () => {
    const isPrimary = await primaryClient.isPrimaryChain();
    expect(isPrimary).toBe(true);

    const isSecondary = await secondaryClient.isPrimaryChain();
    expect(isSecondary).toBe(false);
  });

  it('should return supported destinations from each chain', async () => {
    const primaryDests = await primaryClient.getSupportedDestinations();
    expect(primaryDests).toContain(SECONDARY_ENDPOINT_ID);

    const secondaryDests = await secondaryClient.getSupportedDestinations();
    expect(secondaryDests).toContain(PRIMARY_ENDPOINT_ID);
  });
});

// =============================================================================
// Secondary Chain Trust Request
// =============================================================================

describe('Cross-Chain Trust Sync: Secondary Requests from Primary', () => {
  let primaryClient: CrossChainTrustClient;
  let secondaryClient: CrossChainTrustClient;
  let primaryState: MockChainState;
  let secondaryState: MockChainState;

  beforeEach(() => {
    primaryState = createMockChainState(true);
    secondaryState = createMockChainState(false);

    const primaryPublicClient = createCrossChainMockPublicClient(primaryState);
    const secondaryPublicClient = createCrossChainMockPublicClient(secondaryState);
    const walletClient = createCrossChainMockWalletClient(primaryState, secondaryState);

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    primaryClient = new CrossChainTrustClient(
      primaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );

    secondaryClient = new CrossChainTrustClient(
      secondaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );
  });

  it('should request trust sync from secondary to primary chain', async () => {
    const testDid = TEST_DIDS.provider;
    const didHash = keccak256(toHex(testDid));
    const trustScore = 9000;

    // Set trust score on primary
    primaryState.localTrustScores.set(didHash, BigInt(trustScore));

    // Secondary requests sync
    const result = await secondaryClient.requestTrustSync({
      destinationEid: PRIMARY_ENDPOINT_ID,
      did: testDid,
    });

    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify secondary now has cached score from primary
    const cache = await secondaryClient.getCachedTrustScore(testDid);
    expect(cache.exists).toBe(true);
    expect(cache.trustScore).toBe(trustScore);
  });

  it('should handle request for unknown DID gracefully', async () => {
    const unknownDid = 'did:agoramesh:base:0x0000000000000000000000000000000000000000';

    // Request sync for unknown DID (primary has no score)
    const result = await secondaryClient.requestTrustSync({
      destinationEid: PRIMARY_ENDPOINT_ID,
      did: unknownDid,
    });

    // Request should succeed (transaction submitted)
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);

    // Cache should exist but with score 0
    const cache = await secondaryClient.getCachedTrustScore(unknownDid);
    expect(cache.exists).toBe(true);
    expect(cache.trustScore).toBe(0);
  });
});

// =============================================================================
// Multi-Agent Cross-Chain Sync
// =============================================================================

describe('Cross-Chain Trust Sync: Multi-Agent Batch Sync', () => {
  let primaryClient: CrossChainTrustClient;
  let secondaryClient: CrossChainTrustClient;
  let primaryState: MockChainState;
  let secondaryState: MockChainState;

  const agents = [
    { did: 'did:agoramesh:base:0x1111111111111111111111111111111111111111', score: 9500 },
    { did: 'did:agoramesh:base:0x2222222222222222222222222222222222222222', score: 8000 },
    { did: 'did:agoramesh:base:0x3333333333333333333333333333333333333333', score: 7500 },
    { did: 'did:agoramesh:base:0x4444444444444444444444444444444444444444', score: 6000 },
  ];

  beforeEach(() => {
    primaryState = createMockChainState(true);
    secondaryState = createMockChainState(false);

    const primaryPublicClient = createCrossChainMockPublicClient(primaryState);
    const secondaryPublicClient = createCrossChainMockPublicClient(secondaryState);
    const walletClient = createCrossChainMockWalletClient(primaryState, secondaryState);

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    primaryClient = new CrossChainTrustClient(
      primaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );

    secondaryClient = new CrossChainTrustClient(
      secondaryPublicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );

    // Set up all agent scores on primary
    for (const agent of agents) {
      const didHash = keccak256(toHex(agent.did));
      primaryState.localTrustScores.set(didHash, BigInt(agent.score));
    }
  });

  it('should sync multiple agents trust scores in batch', async () => {
    // Sync all agents
    const results = await Promise.all(
      agents.map((agent) =>
        primaryClient.syncTrustScore({
          destinationEid: SECONDARY_ENDPOINT_ID,
          did: agent.did,
          trustScore: agent.score,
        })
      )
    );

    // All syncs should succeed
    expect(results).toHaveLength(agents.length);
    results.forEach((result) => {
      expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    // Verify all scores are cached on secondary
    for (const agent of agents) {
      const cache = await secondaryClient.getCachedTrustScore(agent.did);
      expect(cache.exists).toBe(true);
      expect(cache.trustScore).toBe(agent.score);
    }
  });

  it('should aggregate trust scores correctly', async () => {
    // Sync all agents first
    for (const agent of agents) {
      await primaryClient.syncTrustScore({
        destinationEid: SECONDARY_ENDPOINT_ID,
        did: agent.did,
        trustScore: agent.score,
      });
    }

    // Check aggregated scores
    for (const agent of agents) {
      const aggregated = await secondaryClient.getAggregatedTrustScore(agent.did);
      expect(aggregated).toBe(agent.score);
    }
  });
});

// =============================================================================
// Chain Registry Integration
// =============================================================================

describe('Cross-Chain Trust Sync: Chain Registry', () => {
  let client: CrossChainTrustClient;
  let state: MockChainState;

  beforeEach(() => {
    state = createMockChainState(true);

    const publicClient = createCrossChainMockPublicClient(state);
    const walletClient = createCrossChainMockWalletClient(state, createMockChainState(false));

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    client = new CrossChainTrustClient(
      publicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );
  });

  it('should return chain info for Base Mainnet', async () => {
    const chainInfo = await client.getChainInfo(PRIMARY_CHAIN_ID);

    expect(chainInfo.chainId).toBe(PRIMARY_CHAIN_ID);
    expect(chainInfo.name).toBe('Base Mainnet');
    expect(chainInfo.isTestnet).toBe(false);
    expect(chainInfo.isActive).toBe(true);
  });

  it('should return chain info for Base Sepolia', async () => {
    const chainInfo = await client.getChainInfo(SECONDARY_CHAIN_ID);

    expect(chainInfo.chainId).toBe(SECONDARY_CHAIN_ID);
    expect(chainInfo.name).toBe('Base Sepolia');
    expect(chainInfo.isTestnet).toBe(true);
    expect(chainInfo.isActive).toBe(true);
  });

  it('should return all supported chains', async () => {
    const chains = await client.getSupportedChains();

    expect(chains).toContain(PRIMARY_CHAIN_ID);
    expect(chains).toContain(SECONDARY_CHAIN_ID);
    expect(chains).toHaveLength(2);
  });

  it('should check chain support correctly', async () => {
    const isBaseSupported = await client.isChainSupported(PRIMARY_CHAIN_ID);
    expect(isBaseSupported).toBe(true);

    const isSepoliaSupported = await client.isChainSupported(SECONDARY_CHAIN_ID);
    expect(isSepoliaSupported).toBe(true);

    const isUnknownSupported = await client.isChainSupported(999999);
    expect(isUnknownSupported).toBe(false);
  });
});

// =============================================================================
// Fee Estimation
// =============================================================================

describe('Cross-Chain Trust Sync: Fee Estimation', () => {
  let client: CrossChainTrustClient;
  let state: MockChainState;

  beforeEach(() => {
    state = createMockChainState(true);

    const publicClient = createCrossChainMockPublicClient(state);
    const walletClient = createCrossChainMockWalletClient(state, createMockChainState(false));

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    client = new CrossChainTrustClient(
      publicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );
  });

  it('should quote fee for trust sync operation', async () => {
    const fee = await client.quoteSyncFee({
      destinationEid: SECONDARY_ENDPOINT_ID,
      did: TEST_DIDS.provider,
      trustScore: 8500,
    });

    expect(fee).toBeGreaterThan(0n);
    // Expected fee should be around 0.001 ETH based on mock
    expect(fee).toBe(parseUnits('0.001', 18));
  });

  it('should return cache TTL configuration', async () => {
    const ttl = await client.getCacheTTL();

    expect(ttl).toBe(CACHE_TTL_SECONDS);
  });

  it('should return primary chain ID', async () => {
    const primaryChainId = await client.getPrimaryChainId();

    expect(primaryChainId).toBe(PRIMARY_CHAIN_ID);
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

describe('Cross-Chain Trust Sync: Helper Functions', () => {
  let client: CrossChainTrustClient;

  beforeEach(() => {
    const state = createMockChainState(true);
    const publicClient = createCrossChainMockPublicClient(state);
    const walletClient = createCrossChainMockWalletClient(state, createMockChainState(false));

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    client = new CrossChainTrustClient(
      publicClient as unknown as PublicClient,
      walletClient as unknown as WalletClient,
      config
    );
  });

  it('should convert DID to consistent hash', () => {
    const did = TEST_DIDS.provider;
    const hash1 = client.didToHash(did);
    const hash2 = client.didToHash(did);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should format trust score from basis points to percentage', () => {
    expect(client.formatTrustScore(10000)).toBe(100); // 100%
    expect(client.formatTrustScore(8500)).toBe(85);   // 85%
    expect(client.formatTrustScore(5000)).toBe(50);   // 50%
    expect(client.formatTrustScore(0)).toBe(0);       // 0%
  });

  it('should calculate time since last cache update', async () => {
    const oneHourAgo = BigInt(Math.floor(Date.now() / 1000) - 3600);

    // Manually set cached score with known timestamp
    const state = createMockChainState(true);
    const didHash = client.didToHash(TEST_DIDS.provider);
    state.cachedScores.set(didHash, {
      trustScore: 8500n,
      lastUpdated: oneHourAgo,
      exists: true,
    });

    const cachedScore: CachedTrustScore = {
      trustScore: 8500,
      lastUpdated: new Date(Number(oneHourAgo) * 1000),
      exists: true,
    };

    const timeSince = client.getTimeSinceLastUpdate(cachedScore);

    // Should be approximately 3600 seconds with some tolerance
    expect(timeSince).toBeGreaterThanOrEqual(3500);
    expect(timeSince).toBeLessThanOrEqual(3700);
  });
});
