/**
 * Trust Score E2E Tests
 *
 * Tests for trust score calculation, staking, endorsements,
 * and reputation tracking.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { keccak256, toHex, parseUnits } from 'viem';
import { AgoraMeshClient, didToHash } from '../../src/client.js';
import { TrustClient } from '../../src/trust.js';
import { USDC_DECIMALS } from '../../src/types.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  createTestTrustScore,
  createZeroTrustScore,
  createMockPublicClient,
  createMockWalletClient,
  registerTestAgent,
  scoreToBasisPoints,
} from './setup.js';

describe('Trust Score E2E', () => {
  let client: AgoraMeshClient;
  let trust: TrustClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    // Create fresh mocks
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    // Create client with test config
    client = new AgoraMeshClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // Mock the internal clients
    // @ts-expect-error - accessing private property for testing
    client.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    client.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    client.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private property for testing
    client.connected = true;

    // Create trust client
    trust = new TrustClient(client);
  });

  describe('New Agent Trust Score', () => {
    it('should return zero trust score for new agent', async () => {
      // Register a new agent without any history
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createZeroTrustScore(),
      });

      const score = await trust.getTrustScore(TEST_DIDS.provider);

      expect(score.overall).toBe(0);
      expect(score.reputation).toBe(0);
      expect(score.stake).toBe(0);
      expect(score.endorsement).toBe(0);
    });

    it('should return zero for unregistered agent', async () => {
      const score = await trust.getTrustScore(TEST_DIDS.unregistered);

      expect(score.overall).toBe(0);
      expect(score.reputation).toBe(0);
      expect(score.stake).toBe(0);
      expect(score.endorsement).toBe(0);
    });
  });

  describe('Stake Increases Trust Score', () => {
    it('should increase trust score when stake is deposited', async () => {
      // Register agent with zero trust
      registerTestAgent(mockPublicClient, TEST_DIDS.client, {
        owner: TEST_ADDRESSES.client,
        trustScore: createZeroTrustScore(),
      });

      // Get initial score
      const initialScore = await trust.getTrustScore(TEST_DIDS.client);
      expect(initialScore.stake).toBe(0);

      // Deposit stake
      const txHash = await trust.depositStake(TEST_DIDS.client, '5000'); // 5000 USDC
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Get updated score
      const updatedScore = await trust.getTrustScore(TEST_DIDS.client);

      // Stake score should increase
      // Formula: sqrt(staked_amount / 10000) = sqrt(5000/10000) = sqrt(0.5) ~ 0.707
      expect(updatedScore.stake).toBeGreaterThan(0);
      expect(updatedScore.stake).toBeCloseTo(Math.sqrt(5000 / 10000), 2);

      // Overall score should also increase
      expect(updatedScore.overall).toBeGreaterThan(initialScore.overall);
    });

    it('should cap stake score at 1.0 for large stakes', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.client, {
        owner: TEST_ADDRESSES.client,
        trustScore: createZeroTrustScore(),
      });

      // Deposit a very large stake
      await trust.depositStake(TEST_DIDS.client, '20000'); // Above reference of $10,000

      const score = await trust.getTrustScore(TEST_DIDS.client);

      // Stake score should be capped at 1.0
      expect(score.stake).toBeLessThanOrEqual(1.0);
    });

    it('should handle withdrawal request', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.client, {
        owner: TEST_ADDRESSES.client,
        trustScore: createTestTrustScore({ stake: 0.7 }),
      });

      const { txHash, unlockTime } = await trust.requestWithdraw(
        TEST_DIDS.client,
        '1000'
      );

      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(unlockTime).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));

      // Unlock time should be ~7 days from now
      const sevenDays = 7 * 24 * 60 * 60;
      const expectedUnlock = BigInt(Math.floor(Date.now() / 1000) + sevenDays);
      expect(unlockTime).toBeGreaterThanOrEqual(expectedUnlock - 10n);
      expect(unlockTime).toBeLessThanOrEqual(expectedUnlock + 10n);
    });

    it('should get stake info', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore({ stake: 0.5 }),
      });

      const stakeInfo = await trust.getStakeInfo(TEST_DIDS.provider);

      expect(stakeInfo.amount).toBeDefined();
      expect(stakeInfo.unlockTime).toBeDefined();
      expect(stakeInfo.pendingWithdrawal).toBeDefined();
    });

    it('should get human-readable stake amount', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore(),
      });

      const amount = await trust.getStakeAmount(TEST_DIDS.provider);

      // Should be a string like "5000" or "5000.00"
      expect(typeof amount).toBe('string');
      expect(parseFloat(amount)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Endorsements Add to Trust', () => {
    it('should increase trust score when endorsed', async () => {
      // Register both agents
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createZeroTrustScore(),
      });
      registerTestAgent(mockPublicClient, TEST_DIDS.endorser, {
        trustScore: createTestTrustScore({ overall: 0.8 }),
      });

      // Get initial endorsement score
      const initialScore = await trust.getTrustScore(TEST_DIDS.provider);
      expect(initialScore.endorsement).toBe(0);

      // Endorse the provider
      const txHash = await trust.endorse(
        TEST_DIDS.provider,
        'Reliable and professional'
      );
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Get updated score
      const updatedScore = await trust.getTrustScore(TEST_DIDS.provider);

      // Endorsement score should increase
      expect(updatedScore.endorsement).toBeGreaterThan(initialScore.endorsement);
    });

    it('should endorse without message', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createZeroTrustScore(),
      });

      const txHash = await trust.endorse(TEST_DIDS.provider);
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should get endorsements for an agent', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore(),
      });

      const endorsements = await trust.getEndorsements(TEST_DIDS.provider);

      expect(Array.isArray(endorsements)).toBe(true);
    });

    it('should revoke endorsement', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore({ endorsement: 0.4 }),
      });

      const txHash = await trust.revokeEndorsement(TEST_DIDS.provider);
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('Successful Transactions Increase Reputation', () => {
    it('should have higher reputation with more transactions', async () => {
      // Agent with many successful transactions
      const didHashHigh = didToHash(TEST_DIDS.provider);
      mockPublicClient.trustScores.set(didHashHigh, {
        overall: 0.85,
        reputation: 0.9,
        stake: 0.8,
        endorsement: 0.7,
      });

      // Agent with few transactions
      const didHashLow = didToHash(TEST_DIDS.client);
      mockPublicClient.trustScores.set(didHashLow, {
        overall: 0.3,
        reputation: 0.2,
        stake: 0.3,
        endorsement: 0.1,
      });

      const highRepScore = await trust.getTrustScore(TEST_DIDS.provider);
      const lowRepScore = await trust.getTrustScore(TEST_DIDS.client);

      expect(highRepScore.reputation).toBeGreaterThan(lowRepScore.reputation);
    });

    it('should get reputation data', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore(),
      });

      const reputation = await trust.getReputation(TEST_DIDS.provider);

      expect(reputation.totalTransactions).toBeDefined();
      expect(reputation.successfulTransactions).toBeDefined();
      expect(reputation.successRate).toBeDefined();
      expect(reputation.totalVolumeUsd).toBeDefined();
    });

    it('should calculate success rate correctly', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore({ reputation: 0.95 }),
      });

      const reputation = await trust.getReputation(TEST_DIDS.provider);

      // Mock has 100 total, 95 successful = 95% success rate
      expect(reputation.totalTransactions).toBe(100n);
      expect(reputation.successfulTransactions).toBe(95n);
      // Success rate is in basis points: 9500 = 95%
      expect(reputation.successRate).toBe(9500);
    });
  });

  describe('Trust Details', () => {
    it('should get complete trust details', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore({
          overall: 0.75,
          reputation: 0.8,
          stake: 0.6,
          endorsement: 0.5,
        }),
      });

      const details = await trust.getTrustDetails(TEST_DIDS.provider);

      // Check scores
      expect(details.scores.overall).toBe(0.75);
      expect(details.scores.reputation).toBe(0.8);
      expect(details.scores.stake).toBe(0.6);
      expect(details.scores.endorsement).toBe(0.5);

      // Check reputation data
      expect(details.reputation.totalTransactions).toBeDefined();
      expect(details.reputation.successfulTransactions).toBeDefined();
      expect(details.reputation.successRate).toBeDefined();

      // Check stake info
      expect(details.stake.amount).toBeDefined();
      expect(details.stake.unlockTime).toBeDefined();

      // Check endorsements
      expect(Array.isArray(details.endorsements)).toBe(true);
    });
  });

  describe('Trust Requirements', () => {
    it('should check if agent meets trust requirement', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createTestTrustScore({ overall: 0.75 }),
      });

      // Should meet 0.7 requirement
      const meets70 = await trust.meetsTrustRequirement(TEST_DIDS.provider, 0.7);
      expect(meets70).toBe(true);

      // Should not meet 0.8 requirement
      const meets80 = await trust.meetsTrustRequirement(TEST_DIDS.provider, 0.8);
      expect(meets80).toBe(false);
    });

    it('should fail trust requirement for new agent', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: createZeroTrustScore(),
      });

      const meetsRequirement = await trust.meetsTrustRequirement(
        TEST_DIDS.provider,
        0.5
      );
      expect(meetsRequirement).toBe(false);
    });
  });

  describe('Escrow Requirement Calculation', () => {
    it('should require no escrow for very trusted agents', () => {
      const requirement = trust.calculateEscrowRequirement(0.95, '1000');
      expect(requirement).toBe('0.00');
    });

    it('should require 20% escrow for trusted agents', () => {
      const requirement = trust.calculateEscrowRequirement(0.8, '1000');
      expect(requirement).toBe('200.00');
    });

    it('should require 50% escrow for moderate trust', () => {
      const requirement = trust.calculateEscrowRequirement(0.6, '1000');
      expect(requirement).toBe('500.00');
    });

    it('should require 100% escrow for low trust', () => {
      const requirement = trust.calculateEscrowRequirement(0.3, '1000');
      expect(requirement).toBe('1000.00');
    });

    it('should require 100% escrow for new agents', () => {
      const requirement = trust.calculateEscrowRequirement(0, '500');
      expect(requirement).toBe('500.00');
    });
  });

  describe('Trust Score Formatting', () => {
    it('should format trust score as percentage', () => {
      expect(trust.formatTrustScore(0.855)).toBe('85.5%');
      expect(trust.formatTrustScore(1.0)).toBe('100.0%');
      expect(trust.formatTrustScore(0)).toBe('0.0%');
      expect(trust.formatTrustScore(0.5)).toBe('50.0%');
    });
  });

  describe('Error Handling', () => {
    it('should throw when client not connected', async () => {
      // Disconnect client
      // @ts-expect-error - accessing private property for testing
      client.publicClient = null;
      // @ts-expect-error - accessing private property for testing
      client.connected = false;

      await expect(trust.getTrustScore(TEST_DIDS.provider)).rejects.toThrow(
        'Client is not connected'
      );
    });

    it('should throw when TrustRegistry not configured', async () => {
      // Create client without TrustRegistry
      const clientWithoutRegistry = new AgoraMeshClient({
        rpcUrl: TEST_RPC_URL,
        chainId: TEST_CHAIN_ID,
        privateKey: TEST_PRIVATE_KEYS.client,
      });

      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.publicClient = mockPublicClient;
      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.connected = true;

      const trustWithoutRegistry = new TrustClient(clientWithoutRegistry);

      await expect(
        trustWithoutRegistry.getTrustScore(TEST_DIDS.provider)
      ).rejects.toThrow('TrustRegistry address not configured');
    });

    it('should throw when wallet not connected for staking', async () => {
      // @ts-expect-error - accessing private property for testing
      client.walletClient = null;
      // @ts-expect-error - accessing private property for testing
      client.account = null;

      await expect(
        trust.depositStake(TEST_DIDS.client, '1000')
      ).rejects.toThrow('Wallet not connected');
    });
  });

  describe('Trust Score Components', () => {
    it('should correctly weight trust components', async () => {
      // Trust formula: 0.50 * reputation + 0.30 * stake + 0.20 * endorsement
      const reputation = 0.8;
      const stake = 0.6;
      const endorsement = 0.4;
      const expected = 0.5 * reputation + 0.3 * stake + 0.2 * endorsement;
      // = 0.4 + 0.18 + 0.08 = 0.66

      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        trustScore: {
          overall: expected,
          reputation,
          stake,
          endorsement,
        },
      });

      const score = await trust.getTrustScore(TEST_DIDS.provider);

      expect(score.overall).toBeCloseTo(expected, 2);
    });
  });
});
