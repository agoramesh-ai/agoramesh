/**
 * CrossChainTrustClient Tests
 *
 * TDD tests for the cross-chain trust synchronization client.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { parseUnits, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CrossChainTrustClient, CrossChainConfig } from './crosschain.js';

// Mock client interface for tests
interface MockPublicClient {
  readContract: Mock;
  simulateContract: Mock;
}

interface MockWalletClient {
  writeContract: Mock;
  account: ReturnType<typeof privateKeyToAccount>;
}

// =============================================================================
// Test Setup
// =============================================================================

// Mock contract addresses (would be real deployed addresses in integration tests)
const CROSS_CHAIN_SYNC_ADDRESS = '0x1234567890123456789012345678901234567890' as const;
const CHAIN_REGISTRY_ADDRESS = '0x2345678901234567890123456789012345678901' as const;

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_DID = 'did:agoramesh:base:0x1111111111111111111111111111111111111111';

describe('CrossChainTrustClient', () => {
  let client: CrossChainTrustClient;
  let mockPublicClient: MockPublicClient;
  let mockWalletClient: MockWalletClient;

  beforeEach(() => {
    // Create mock clients
    mockPublicClient = {
      readContract: vi.fn(),
      simulateContract: vi.fn(),
    };

    mockWalletClient = {
      writeContract: vi.fn(),
      account: privateKeyToAccount(TEST_PRIVATE_KEY),
    };

    const config: CrossChainConfig = {
      crossChainSyncAddress: CROSS_CHAIN_SYNC_ADDRESS,
      chainRegistryAddress: CHAIN_REGISTRY_ADDRESS,
    };

    client = new CrossChainTrustClient(
      mockPublicClient as unknown as PublicClient,
      mockWalletClient as unknown as WalletClient,
      config
    );
  });

  // ============ Constructor Tests ============

  describe('constructor', () => {
    it('should create client with valid config', () => {
      expect(client).toBeDefined();
    });

    it('should store config addresses', () => {
      expect(client.crossChainSyncAddress).toBe(CROSS_CHAIN_SYNC_ADDRESS);
      expect(client.chainRegistryAddress).toBe(CHAIN_REGISTRY_ADDRESS);
    });
  });

  // ============ Query Tests ============

  describe('getCachedTrustScore', () => {
    it('should return cached trust score for DID', async () => {
      const mockResult = {
        trustScore: 7500n,
        lastUpdated: BigInt(Math.floor(Date.now() / 1000) - 3600), // 1 hour ago
        exists: true,
      };

      mockPublicClient.readContract.mockResolvedValue([
        mockResult.trustScore,
        mockResult.lastUpdated,
        mockResult.exists,
      ]);

      const result = await client.getCachedTrustScore(TEST_DID);

      expect(result).toEqual({
        trustScore: 7500,
        lastUpdated: expect.any(Date),
        exists: true,
      });
      expect(mockPublicClient.readContract).toHaveBeenCalled();
    });

    it('should return exists=false for non-cached DID', async () => {
      mockPublicClient.readContract.mockResolvedValue([0n, 0n, false]);

      const result = await client.getCachedTrustScore(TEST_DID);

      expect(result.exists).toBe(false);
      expect(result.trustScore).toBe(0);
    });
  });

  describe('getAggregatedTrustScore', () => {
    it('should return aggregated trust score', async () => {
      mockPublicClient.readContract.mockResolvedValue(8500n);

      const score = await client.getAggregatedTrustScore(TEST_DID);

      expect(score).toBe(8500);
    });

    it('should return 0 for unknown DID', async () => {
      mockPublicClient.readContract.mockResolvedValue(0n);

      const score = await client.getAggregatedTrustScore(TEST_DID);

      expect(score).toBe(0);
    });
  });

  describe('isCacheStale', () => {
    it('should return true for stale cache', async () => {
      mockPublicClient.readContract.mockResolvedValue(true);

      const isStale = await client.isCacheStale(TEST_DID);

      expect(isStale).toBe(true);
    });

    it('should return false for fresh cache', async () => {
      mockPublicClient.readContract.mockResolvedValue(false);

      const isStale = await client.isCacheStale(TEST_DID);

      expect(isStale).toBe(false);
    });
  });

  describe('isPrimaryChain', () => {
    it('should return true on primary chain', async () => {
      mockPublicClient.readContract.mockResolvedValue(true);

      const isPrimary = await client.isPrimaryChain();

      expect(isPrimary).toBe(true);
    });

    it('should return false on secondary chain', async () => {
      mockPublicClient.readContract.mockResolvedValue(false);

      const isPrimary = await client.isPrimaryChain();

      expect(isPrimary).toBe(false);
    });
  });

  describe('getSupportedDestinations', () => {
    it('should return list of supported chain endpoint IDs', async () => {
      const mockEids = [30184n, 40245n, 30111n]; // Base, Base Sepolia, Optimism
      mockPublicClient.readContract.mockResolvedValue(mockEids);

      const destinations = await client.getSupportedDestinations();

      expect(destinations).toEqual([30184, 40245, 30111]);
    });

    it('should return empty array if no peers configured', async () => {
      mockPublicClient.readContract.mockResolvedValue([]);

      const destinations = await client.getSupportedDestinations();

      expect(destinations).toEqual([]);
    });
  });

  describe('getPrimaryChainId', () => {
    it('should return the primary chain ID', async () => {
      mockPublicClient.readContract.mockResolvedValue(8453n); // Base Mainnet

      const chainId = await client.getPrimaryChainId();

      expect(chainId).toBe(8453);
    });
  });

  describe('getCacheTTL', () => {
    it('should return cache TTL in seconds', async () => {
      mockPublicClient.readContract.mockResolvedValue(86400n); // 1 day

      const ttl = await client.getCacheTTL();

      expect(ttl).toBe(86400);
    });
  });

  // ============ Fee Estimation Tests ============

  describe('quoteSyncFee', () => {
    it('should return fee estimate for sync operation', async () => {
      const mockFee = parseUnits('0.001', 18); // 0.001 ETH
      mockPublicClient.readContract.mockResolvedValue(mockFee);

      const fee = await client.quoteSyncFee({
        destinationEid: 30184,
        did: TEST_DID,
        trustScore: 8000,
      });

      expect(fee).toBe(mockFee);
    });
  });

  // ============ Sync Operations Tests ============

  describe('requestTrustSync', () => {
    it('should initiate trust sync to destination chain', async () => {
      const mockTxHash = '0xabc123';
      mockPublicClient.readContract.mockResolvedValue(parseUnits('0.001', 18)); // Fee quote
      mockPublicClient.simulateContract.mockResolvedValue({ request: {} });
      mockWalletClient.writeContract.mockResolvedValue(mockTxHash);

      const result = await client.requestTrustSync({
        destinationEid: 30184,
        did: TEST_DID,
      });

      expect(result.hash).toBe(mockTxHash);
    });
  });

  describe('syncTrustScore', () => {
    it('should send trust score to destination chain', async () => {
      const mockTxHash = '0xdef456';
      mockPublicClient.readContract.mockResolvedValue(parseUnits('0.001', 18)); // Fee quote
      mockPublicClient.simulateContract.mockResolvedValue({ request: {} });
      mockWalletClient.writeContract.mockResolvedValue(mockTxHash);

      const result = await client.syncTrustScore({
        destinationEid: 30184,
        did: TEST_DID,
        trustScore: 8500,
      });

      expect(result.hash).toBe(mockTxHash);
    });
  });

  // ============ Chain Registry Tests ============

  describe('getChainInfo', () => {
    it('should return chain information', async () => {
      const mockChainInfo = {
        chainId: 8453n,
        name: 'Base Mainnet',
        isTestnet: false,
        isActive: true,
        trustRegistry: '0x1111111111111111111111111111111111111111',
        usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        endpoint: '0x1a44076050125825900e736c501f859c50fE728c',
      };

      mockPublicClient.readContract.mockResolvedValue(mockChainInfo);

      const info = await client.getChainInfo(8453);

      expect(info.chainId).toBe(8453);
      expect(info.name).toBe('Base Mainnet');
      expect(info.isTestnet).toBe(false);
    });
  });

  describe('getSupportedChains', () => {
    it('should return list of all supported chain IDs', async () => {
      mockPublicClient.readContract.mockResolvedValue([8453n, 84532n]);

      const chains = await client.getSupportedChains();

      expect(chains).toEqual([8453, 84532]);
    });
  });

  describe('isChainSupported', () => {
    it('should return true for supported chain', async () => {
      mockPublicClient.readContract.mockResolvedValue(true);

      const isSupported = await client.isChainSupported(8453);

      expect(isSupported).toBe(true);
    });

    it('should return false for unsupported chain', async () => {
      mockPublicClient.readContract.mockResolvedValue(false);

      const isSupported = await client.isChainSupported(999999);

      expect(isSupported).toBe(false);
    });
  });

  // ============ Helper Function Tests ============

  describe('didToHash', () => {
    it('should convert DID string to bytes32 hash', () => {
      const hash = client.didToHash(TEST_DID);
      expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    it('should return consistent hash for same DID', () => {
      const hash1 = client.didToHash(TEST_DID);
      const hash2 = client.didToHash(TEST_DID);
      expect(hash1).toBe(hash2);
    });
  });

  describe('formatTrustScore', () => {
    it('should format basis points to percentage', () => {
      expect(client.formatTrustScore(10000)).toBe(100);
      expect(client.formatTrustScore(7500)).toBe(75);
      expect(client.formatTrustScore(5000)).toBe(50);
    });
  });

  describe('getTimeSinceLastUpdate', () => {
    it('should calculate time since last cache update', async () => {
      const oneHourAgo = BigInt(Math.floor(Date.now() / 1000) - 3600);
      mockPublicClient.readContract.mockResolvedValue([8500n, oneHourAgo, true]);

      const cachedScore = await client.getCachedTrustScore(TEST_DID);
      const timeSince = client.getTimeSinceLastUpdate(cachedScore);

      // Should be approximately 3600 seconds (1 hour), with some tolerance
      expect(timeSince).toBeGreaterThanOrEqual(3500);
      expect(timeSince).toBeLessThanOrEqual(3700);
    });
  });
});
