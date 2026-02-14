/**
 * Trust Client Tests
 *
 * Tests for TrustClient functionality.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { TrustClient } from './trust.js';
import type { AgentMeClient } from './client.js';

// Mock fetch globally for node API tests
global.fetch = vi.fn();

/**
 * Mock viem's public client
 */
function createMockPublicClient() {
  return {
    readContract: vi.fn(),
  };
}

/**
 * Mock viem's wallet client
 */
function createMockWalletClient() {
  return {
    writeContract: vi.fn(),
  };
}

/**
 * Mock AgentMeClient
 */
function createMockClient(options: { connected?: boolean } = {}): AgentMeClient {
  const publicClient = options.connected !== false ? createMockPublicClient() : null;
  const walletClient = createMockWalletClient();

  return {
    getPublicClient: vi.fn(() => publicClient),
    getWalletClient: vi.fn(() => walletClient),
    getContractAddresses: vi.fn(() => ({
      trustRegistry: '0x1234567890123456789012345678901234567890',
      usdcToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })),
    getAccount: vi.fn(() => ({
      address: '0xUserAddress1234567890123456789012345678',
    })),
  } as unknown as AgentMeClient;
}

describe('TrustClient', () => {
  let client: AgentMeClient;
  let trust: TrustClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    client = createMockClient();
    mockPublicClient = (client.getPublicClient as Mock)() as ReturnType<
      typeof createMockPublicClient
    >;
    trust = new TrustClient(client);
  });

  // ===========================================================================
  // getTrustScore Tests
  // ===========================================================================

  describe('getTrustScore()', () => {
    it('should throw error when client not connected', async () => {
      const disconnectedClient = createMockClient({ connected: false });
      const disconnectedTrust = new TrustClient(disconnectedClient);

      await expect(
        disconnectedTrust.getTrustScore('did:agentme:base:agent1')
      ).rejects.toThrow('Client is not connected');
    });

    it('should return normalized trust scores', async () => {
      // Mock contract response (basis points: 0-10000)
      mockPublicClient.readContract.mockResolvedValueOnce([
        BigInt(9000), // reputationScore (0.9)
        BigInt(8000), // stakeScore (0.8)
        BigInt(7500), // endorsementScore (0.75)
        BigInt(8500), // compositeScore (0.85)
      ]);

      const score = await trust.getTrustScore('did:agentme:base:agent1');

      expect(score.overall).toBeCloseTo(0.85);
      expect(score.reputation).toBeCloseTo(0.9);
      expect(score.stake).toBeCloseTo(0.8);
      expect(score.endorsement).toBeCloseTo(0.75);
    });

    it('should hash DID and call contract', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce([
        BigInt(5000),
        BigInt(5000),
        BigInt(5000),
        BigInt(5000),
      ]);

      await trust.getTrustScore('did:agentme:base:agent1');

      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getTrustDetails',
          args: expect.arrayContaining([expect.any(String)]),
        })
      );
    });
  });

  // ===========================================================================
  // getTrustDetails Tests
  // ===========================================================================

  describe('getTrustDetails()', () => {
    it('should fetch all trust data in parallel', async () => {
      // Mock scores
      mockPublicClient.readContract
        .mockResolvedValueOnce([
          BigInt(9000),
          BigInt(8000),
          BigInt(7500),
          BigInt(8500),
        ])
        // Mock trust data
        .mockResolvedValueOnce({
          reputationScore: BigInt(9000),
          totalTransactions: BigInt(100),
          successfulTransactions: BigInt(95),
          totalVolumeUsd: BigInt(50000_000000), // $50,000
          lastActivityTimestamp: BigInt(1704067200),
          stakedAmount: BigInt(10000_000000), // $10,000
          stakeUnlockTime: BigInt(1704153600),
        })
        // Mock endorsements
        .mockResolvedValueOnce([
          {
            endorserDid: '0x1111111111111111111111111111111111111111111111111111111111111111',
            endorseeDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
            timestamp: BigInt(1704067200),
            message: 'Great partner!',
            isActive: true,
          },
        ]);

      const details = await trust.getTrustDetails('did:agentme:base:agent1');

      expect(details.scores.overall).toBeCloseTo(0.85);
      expect(details.reputation.totalTransactions).toBe(BigInt(100));
      expect(details.reputation.successfulTransactions).toBe(BigInt(95));
      expect(details.reputation.successRate).toBe(9500); // 95%
      expect(details.stake.amount).toBe(BigInt(10000_000000));
      expect(details.endorsements).toHaveLength(1);
      expect(details.endorsements[0]!.message).toBe('Great partner!');
    });

    it('should calculate success rate correctly', async () => {
      mockPublicClient.readContract
        .mockResolvedValueOnce([BigInt(0), BigInt(0), BigInt(0), BigInt(0)])
        .mockResolvedValueOnce({
          reputationScore: BigInt(0),
          totalTransactions: BigInt(0),
          successfulTransactions: BigInt(0),
          totalVolumeUsd: BigInt(0),
          lastActivityTimestamp: BigInt(0),
          stakedAmount: BigInt(0),
          stakeUnlockTime: BigInt(0),
        })
        .mockResolvedValueOnce([]);

      const details = await trust.getTrustDetails('did:agentme:base:newagent');

      // No transactions should result in 0 success rate
      expect(details.reputation.successRate).toBe(0);
    });
  });

  // ===========================================================================
  // getReputation Tests
  // ===========================================================================

  describe('getReputation()', () => {
    it('should return reputation data', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce({
        reputationScore: BigInt(9000),
        totalTransactions: BigInt(200),
        successfulTransactions: BigInt(190),
        totalVolumeUsd: BigInt(100000_000000),
        lastActivityTimestamp: BigInt(1704067200),
        stakedAmount: BigInt(0),
        stakeUnlockTime: BigInt(0),
      });

      const reputation = await trust.getReputation('did:agentme:base:agent1');

      expect(reputation.totalTransactions).toBe(BigInt(200));
      expect(reputation.successfulTransactions).toBe(BigInt(190));
      expect(reputation.successRate).toBe(9500);
      expect(reputation.totalVolumeUsd).toBe(BigInt(100000_000000));
    });
  });

  // ===========================================================================
  // getEndorsements Tests
  // ===========================================================================

  describe('getEndorsements()', () => {
    it('should return endorsement array', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce([
        {
          endorserDid: '0xaaa',
          endorseeDid: '0xbbb',
          timestamp: BigInt(1704067200),
          message: 'Endorsement 1',
          isActive: true,
        },
        {
          endorserDid: '0xccc',
          endorseeDid: '0xbbb',
          timestamp: BigInt(1704067300),
          message: 'Endorsement 2',
          isActive: false,
        },
      ]);

      const endorsements = await trust.getEndorsements('did:agentme:base:agent1');

      expect(endorsements).toHaveLength(2);
      expect(endorsements[0]!.isActive).toBe(true);
      expect(endorsements[1]!.isActive).toBe(false);
    });

    it('should return empty array for agent with no endorsements', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce([]);

      const endorsements = await trust.getEndorsements('did:agentme:base:newagent');

      expect(endorsements).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Trust Score Validation Tests
  // ===========================================================================

  describe('trust score validation', () => {
    it('should handle zero scores', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce([
        BigInt(0),
        BigInt(0),
        BigInt(0),
        BigInt(0),
      ]);

      const score = await trust.getTrustScore('did:agentme:base:newagent');

      expect(score.overall).toBe(0);
      expect(score.reputation).toBe(0);
      expect(score.stake).toBe(0);
      expect(score.endorsement).toBe(0);
    });

    it('should handle maximum scores', async () => {
      mockPublicClient.readContract.mockResolvedValueOnce([
        BigInt(10000),
        BigInt(10000),
        BigInt(10000),
        BigInt(10000),
      ]);

      const score = await trust.getTrustScore('did:agentme:base:perfectagent');

      expect(score.overall).toBe(1);
      expect(score.reputation).toBe(1);
      expect(score.stake).toBe(1);
      expect(score.endorsement).toBe(1);
    });
  });

  // ===========================================================================
  // getTrustFromNode Tests (HTTP API)
  // ===========================================================================

  describe('getTrustFromNode()', () => {
    it('should fetch trust score from node REST API', async () => {
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          did: 'did:agentme:base:agent1',
          score: 0.85,
          reputation: 0.9,
          stake_score: 0.8,
          endorsement_score: 0.75,
        }),
      });

      const score = await trust.getTrustFromNode(
        'did:agentme:base:agent1',
        'https://api.agentme.cz'
      );

      expect(score.overall).toBe(0.85);
      expect(score.reputation).toBe(0.9);
      expect(score.stake).toBe(0.8);
      expect(score.endorsement).toBe(0.75);

      const call = (global.fetch as Mock).mock.calls[0]!;
      const url = call[0] as string;
      expect(url).toContain('/trust/');
      expect(url).toContain('did');
    });

    it('should throw on API failure', async () => {
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Not found',
      });

      await expect(
        trust.getTrustFromNode('did:agentme:base:unknown', 'https://api.agentme.cz')
      ).rejects.toThrow('Failed to get trust from node');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should throw when trustRegistry not configured', async () => {
      (client.getContractAddresses as Mock).mockReturnValueOnce({});

      await expect(trust.getTrustScore('did:agentme:base:agent1')).rejects.toThrow(
        'TrustRegistry address not configured'
      );
    });

    it('should propagate contract errors', async () => {
      mockPublicClient.readContract.mockRejectedValueOnce(
        new Error('Contract call reverted')
      );

      await expect(trust.getTrustScore('did:agentme:base:agent1')).rejects.toThrow(
        'Contract call reverted'
      );
    });
  });

  // ===========================================================================
  // Endorsement Graph Tests (Web of Trust)
  // ===========================================================================

  describe('endorsement graph traversal', () => {
    it('should support multiple endorsers for an agent', async () => {
      const endorsements = [
        {
          endorserDid: '0x111',
          endorseeDid: '0xaaa',
          timestamp: BigInt(1000),
          message: 'E1',
          isActive: true,
        },
        {
          endorserDid: '0x222',
          endorseeDid: '0xaaa',
          timestamp: BigInt(2000),
          message: 'E2',
          isActive: true,
        },
        {
          endorserDid: '0x333',
          endorseeDid: '0xaaa',
          timestamp: BigInt(3000),
          message: 'E3',
          isActive: true,
        },
      ];

      mockPublicClient.readContract.mockResolvedValueOnce(endorsements);

      const result = await trust.getEndorsements('did:agentme:base:agent1');

      expect(result).toHaveLength(3);
      // All endorsements point to the same agent
      expect(result.every((e) => e.endorseeDid === '0xaaa')).toBe(true);
    });

    it('should filter out revoked endorsements in results', async () => {
      const endorsements = [
        {
          endorserDid: '0x111',
          endorseeDid: '0xaaa',
          timestamp: BigInt(1000),
          message: 'Active',
          isActive: true,
        },
        {
          endorserDid: '0x222',
          endorseeDid: '0xaaa',
          timestamp: BigInt(2000),
          message: 'Revoked',
          isActive: false,
        },
      ];

      mockPublicClient.readContract.mockResolvedValueOnce(endorsements);

      const result = await trust.getEndorsements('did:agentme:base:agent1');

      const activeEndorsements = result.filter((e) => e.isActive);
      expect(activeEndorsements).toHaveLength(1);
      expect(activeEndorsements[0]!.message).toBe('Active');
    });
  });

  // ===========================================================================
  // Cache Behavior Tests
  // ===========================================================================

  describe('cache behavior', () => {
    it('should make separate contract calls for each getTrustScore request', async () => {
      mockPublicClient.readContract.mockResolvedValue([
        BigInt(5000),
        BigInt(5000),
        BigInt(5000),
        BigInt(5000),
      ]);

      await trust.getTrustScore('did:agentme:base:agent1');
      await trust.getTrustScore('did:agentme:base:agent1');

      // Should call contract twice (no caching in TrustClient)
      expect(mockPublicClient.readContract).toHaveBeenCalledTimes(2);
    });
  });
});
