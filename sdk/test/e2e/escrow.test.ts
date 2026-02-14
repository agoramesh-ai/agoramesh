/**
 * Escrow E2E Tests
 *
 * Tests for the full escrow lifecycle including happy path,
 * timeout refunds, and dispute resolution.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { keccak256, toHex, parseUnits } from 'viem';
import { AgentMeClient, didToHash } from '../../src/client.js';
import { PaymentClient } from '../../src/payment.js';
import { EscrowState, USDC_DECIMALS } from '../../src/types.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  createTestEscrow,
  createMockPublicClient,
  createMockWalletClient,
  createFundedEscrow,
  advanceTime,
} from './setup.js';

describe('Escrow E2E', () => {
  let client: AgentMeClient;
  let payment: PaymentClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    // Create fresh mocks
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    // Create client with test config
    client = new AgentMeClient({
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

    // Create payment client
    payment = new PaymentClient(client, TEST_DIDS.client);
  });

  describe('Happy Path: Create -> Fund -> Deliver -> Release', () => {
    it('should complete full escrow lifecycle', async () => {
      // Step 1: Create escrow
      const escrowId = await payment.createEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '100', // 100 USDC
        taskHash: keccak256(toHex('Translate document from English to Spanish')),
        deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      });

      expect(escrowId).toBe(1n);

      // Verify escrow was created in AWAITING_DEPOSIT state
      let escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.AWAITING_DEPOSIT);
      expect(escrow.amount).toBe(parseUnits('100', USDC_DECIMALS));

      // Step 2: Fund escrow
      const fundTxHash = await payment.fundEscrow(escrowId);
      expect(fundTxHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify escrow is now FUNDED
      escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.FUNDED);

      // Step 3: Provider confirms delivery
      const outputHash = keccak256(toHex('Translated document content'));
      const deliveryTxHash = await payment.confirmDelivery(escrowId, outputHash);
      expect(deliveryTxHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify escrow is now DELIVERED
      escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.DELIVERED);
      expect(escrow.outputHash).toBe(outputHash);
      expect(escrow.deliveredAt).toBeGreaterThan(0n);

      // Step 4: Client releases funds
      const releaseTxHash = await payment.releaseEscrow(escrowId);
      expect(releaseTxHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify escrow is now RELEASED
      escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.RELEASED);
    });

    it('should create and fund escrow in one call', async () => {
      const escrowId = await payment.createAndFundEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '50',
        taskHash: keccak256(toHex('Test task')),
        deadline: Date.now() + 3600 * 1000, // 1 hour
      });

      // Verify escrow is already FUNDED
      const escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.FUNDED);
    });
  });

  describe('Timeout Refund Flow', () => {
    it('should allow client to claim refund after deadline', async () => {
      // Create a funded escrow with a short deadline
      const escrowId = createFundedEscrow(mockPublicClient, {
        clientDid: didToHash(TEST_DIDS.client),
        clientAddress: TEST_ADDRESSES.client,
        providerDid: didToHash(TEST_DIDS.provider),
        providerAddress: TEST_ADDRESSES.provider,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
      });

      // Initially, cannot claim timeout
      let canClaim = await payment.canClaimTimeout(escrowId);
      expect(canClaim).toBe(false);

      // Advance time past deadline
      advanceTime(mockPublicClient, escrowId, 7200); // 2 hours past deadline

      // Now should be able to claim
      canClaim = await payment.canClaimTimeout(escrowId);
      expect(canClaim).toBe(true);

      // Claim timeout refund
      const txHash = await payment.claimTimeout(escrowId);
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify escrow is now REFUNDED
      const escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.REFUNDED);
    });

    it('should not allow timeout claim before deadline', async () => {
      const escrowId = createFundedEscrow(mockPublicClient, {
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400), // 24 hours
      });

      const canClaim = await payment.canClaimTimeout(escrowId);
      expect(canClaim).toBe(false);

      const timeRemaining = await payment.getTimeUntilDeadline(escrowId);
      expect(timeRemaining).toBeGreaterThan(0);
    });

    it('should not allow timeout claim for non-funded escrow', async () => {
      // Create escrow but don't fund it
      const escrowId = await payment.createEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '100',
        taskHash: keccak256(toHex('Test')),
        deadline: Date.now() - 1000, // Already past deadline
      });

      const canClaim = await payment.canClaimTimeout(escrowId);
      expect(canClaim).toBe(false); // Must be in FUNDED state
    });
  });

  describe('Dispute Resolution Flow', () => {
    it('should allow client to initiate dispute', async () => {
      // Create and fund escrow
      const escrowId = createFundedEscrow(mockPublicClient);

      // Initiate dispute with evidence
      const evidence = toHex('Provider did not deliver as promised');
      const txHash = await payment.initiateDispute(
        escrowId,
        evidence as `0x${string}`
      );
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify escrow is now DISPUTED
      const escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.DISPUTED);
    });

    it('should allow dispute without evidence', async () => {
      const escrowId = createFundedEscrow(mockPublicClient);

      // Initiate dispute without evidence
      const txHash = await payment.initiateDispute(escrowId);
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      const escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.DISPUTED);
    });
  });

  describe('Escrow Queries', () => {
    it('should get escrow details', async () => {
      const escrowId = createFundedEscrow(mockPublicClient, {
        amount: parseUnits('250', USDC_DECIMALS),
      });

      const escrow = await payment.getEscrow(escrowId);

      expect(escrow.id).toBe(escrowId);
      expect(escrow.amount).toBe(parseUnits('250', USDC_DECIMALS));
      expect(escrow.state).toBe(EscrowState.FUNDED);
      expect(escrow.clientDid).toBeDefined();
      expect(escrow.providerDid).toBeDefined();
    });

    it('should get human-readable escrow amount', async () => {
      const escrowId = createFundedEscrow(mockPublicClient, {
        amount: parseUnits('123.45', USDC_DECIMALS),
      });

      const amount = await payment.getEscrowAmount(escrowId);

      expect(amount).toBe('123.45');
    });

    it('should get human-readable state name', async () => {
      const escrowId = createFundedEscrow(mockPublicClient);

      const stateName = await payment.getEscrowStateName(escrowId);

      expect(stateName).toBe('Funded');
    });

    it('should calculate time until deadline', async () => {
      const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
      const escrowId = createFundedEscrow(mockPublicClient, {
        deadline: futureDeadline,
      });

      const timeRemaining = await payment.getTimeUntilDeadline(escrowId);

      // Should be close to 3600 seconds (1 hour)
      expect(timeRemaining).toBeGreaterThan(3500);
      expect(timeRemaining).toBeLessThanOrEqual(3600);
    });

    it('should return negative time for past deadline', async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const escrowId = createFundedEscrow(mockPublicClient, {
        deadline: pastDeadline,
      });

      const timeRemaining = await payment.getTimeUntilDeadline(escrowId);

      expect(timeRemaining).toBeLessThan(0);
    });
  });

  describe('Role Checks', () => {
    it('should identify client role', async () => {
      const escrowId = createFundedEscrow(mockPublicClient, {
        clientAddress: TEST_ADDRESSES.client,
        providerAddress: TEST_ADDRESSES.provider,
      });

      const isClient = await payment.isClient(escrowId);
      const isProvider = await payment.isProvider(escrowId);

      expect(isClient).toBe(true);
      expect(isProvider).toBe(false);
    });

    it('should identify provider role', async () => {
      // Create a payment client as the provider
      const providerClient = new AgentMeClient({
        rpcUrl: TEST_RPC_URL,
        chainId: TEST_CHAIN_ID,
        privateKey: TEST_PRIVATE_KEYS.provider,
        trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
        escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
        usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
      });

      // @ts-expect-error - accessing private property for testing
      providerClient.publicClient = mockPublicClient;
      // @ts-expect-error - accessing private property for testing
      providerClient.walletClient = mockWalletClient;
      // @ts-expect-error - accessing private property for testing
      providerClient.account = { address: TEST_ADDRESSES.provider };
      // @ts-expect-error - accessing private property for testing
      providerClient.connected = true;

      const providerPayment = new PaymentClient(providerClient, TEST_DIDS.provider);

      const escrowId = createFundedEscrow(mockPublicClient, {
        clientAddress: TEST_ADDRESSES.client,
        providerAddress: TEST_ADDRESSES.provider,
      });

      const isClient = await providerPayment.isClient(escrowId);
      const isProvider = await providerPayment.isProvider(escrowId);

      expect(isClient).toBe(false);
      expect(isProvider).toBe(true);
    });
  });

  describe('Escrow Formatting', () => {
    it('should format escrow for display', async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);
      const escrow = createTestEscrow({
        id: 42n,
        amount: parseUnits('999.99', USDC_DECIMALS),
        state: EscrowState.FUNDED,
        deadline,
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.id).toBe('42');
      expect(formatted.amount).toBe('999.99');
      expect(formatted.state).toBe('Funded');
      expect(formatted.deadline).toBeInstanceOf(Date);
      expect(formatted.isOverdue).toBe(false);
    });

    it('should identify overdue escrow', () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const escrow = createTestEscrow({
        state: EscrowState.FUNDED,
        deadline: pastDeadline,
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.isOverdue).toBe(true);
    });

    it('should not mark delivered escrow as overdue', () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const escrow = createTestEscrow({
        state: EscrowState.DELIVERED,
        deadline: pastDeadline,
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.isOverdue).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should throw when wallet not connected', async () => {
      // Disconnect wallet
      // @ts-expect-error - accessing private property for testing
      client.walletClient = null;
      // @ts-expect-error - accessing private property for testing
      client.account = null;

      await expect(
        payment.createEscrow({
          providerDid: TEST_DIDS.provider,
          providerAddress: TEST_ADDRESSES.provider,
          amount: '100',
          taskHash: keccak256(toHex('Test')),
          deadline: Date.now() + 3600000,
        })
      ).rejects.toThrow('Wallet not connected');
    });

    it('should throw when escrow contract not configured', async () => {
      // Create client without escrow address
      const clientWithoutEscrow = new AgentMeClient({
        rpcUrl: TEST_RPC_URL,
        chainId: TEST_CHAIN_ID,
        privateKey: TEST_PRIVATE_KEYS.client,
        trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      });

      // @ts-expect-error - accessing private property for testing
      clientWithoutEscrow.publicClient = mockPublicClient;
      // @ts-expect-error - accessing private property for testing
      clientWithoutEscrow.walletClient = mockWalletClient;
      // @ts-expect-error - accessing private property for testing
      clientWithoutEscrow.account = { address: TEST_ADDRESSES.client };
      // @ts-expect-error - accessing private property for testing
      clientWithoutEscrow.connected = true;

      const paymentWithoutEscrow = new PaymentClient(
        clientWithoutEscrow,
        TEST_DIDS.client
      );

      await expect(
        paymentWithoutEscrow.createEscrow({
          providerDid: TEST_DIDS.provider,
          providerAddress: TEST_ADDRESSES.provider,
          amount: '100',
          taskHash: keccak256(toHex('Test')),
          deadline: Date.now() + 3600000,
        })
      ).rejects.toThrow('Escrow address not configured');
    });

    it('should throw when getting non-existent escrow', async () => {
      await expect(payment.getEscrow(999n)).rejects.toThrow('Escrow 999 not found');
    });
  });

  describe('Multiple Escrows', () => {
    it('should handle multiple concurrent escrows', async () => {
      // Create multiple escrows
      const escrow1 = await payment.createAndFundEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '100',
        taskHash: keccak256(toHex('Task 1')),
        deadline: Date.now() + 3600000,
      });

      const escrow2 = await payment.createAndFundEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '200',
        taskHash: keccak256(toHex('Task 2')),
        deadline: Date.now() + 7200000,
      });

      const escrow3 = await payment.createAndFundEscrow({
        providerDid: TEST_DIDS.provider,
        providerAddress: TEST_ADDRESSES.provider,
        amount: '300',
        taskHash: keccak256(toHex('Task 3')),
        deadline: Date.now() + 10800000,
      });

      // All should have unique IDs
      expect(escrow1).toBe(1n);
      expect(escrow2).toBe(2n);
      expect(escrow3).toBe(3n);

      // All should be independently manageable
      const e1 = await payment.getEscrow(escrow1);
      const e2 = await payment.getEscrow(escrow2);
      const e3 = await payment.getEscrow(escrow3);

      expect(e1.amount).toBe(parseUnits('100', USDC_DECIMALS));
      expect(e2.amount).toBe(parseUnits('200', USDC_DECIMALS));
      expect(e3.amount).toBe(parseUnits('300', USDC_DECIMALS));

      // Release one without affecting others
      await payment.confirmDelivery(escrow2, keccak256(toHex('Output 2')));
      await payment.releaseEscrow(escrow2);

      expect((await payment.getEscrow(escrow1)).state).toBe(EscrowState.FUNDED);
      expect((await payment.getEscrow(escrow2)).state).toBe(EscrowState.RELEASED);
      expect((await payment.getEscrow(escrow3)).state).toBe(EscrowState.FUNDED);
    });
  });
});
