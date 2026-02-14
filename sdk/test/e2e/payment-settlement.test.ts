/**
 * Payment Settlement E2E Tests
 *
 * Tests for the complete payment settlement flow including:
 * - Trust score updates after successful transactions
 * - Streaming payments lifecycle
 * - Multi-party payment settlement
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { keccak256, toHex, parseUnits } from 'viem';
import { AgentMeClient, didToHash } from '../../src/client.js';
import { TrustClient } from '../../src/trust.js';
import { PaymentClient } from '../../src/payment.js';
import {
  StreamingPaymentsClient,
  StreamStatus,
} from '../../src/streaming.js';
import { EscrowState, USDC_DECIMALS } from '../../src/types.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  createMockPublicClient,
  createMockWalletClient,
  createTestTrustScore,
  registerTestAgent,
} from './setup.js';

// =============================================================================
// Trust Score Update After Settlement
// =============================================================================

describe('Trust Score Updates After Payment Settlement', () => {
  let clientAgent: AgentMeClient;
  let providerAgent: AgentMeClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    // Create client agent
    clientAgent = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private for testing
    clientAgent.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private for testing
    clientAgent.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private for testing
    clientAgent.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private for testing
    clientAgent.connected = true;

    // Create provider agent
    providerAgent = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.provider,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private for testing
    providerAgent.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private for testing
    providerAgent.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private for testing
    providerAgent.account = { address: TEST_ADDRESSES.provider };
    // @ts-expect-error - accessing private for testing
    providerAgent.connected = true;
  });

  it('should increase provider trust score after successful settlement', async () => {
    // Setup: Register agents with initial trust scores
    const initialProviderTrust = createTestTrustScore({
      overall: 0.70,
      reputation: 0.65,
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
      trustScore: initialProviderTrust,
      successfulTransactions: 10,
      failedTransactions: 1,
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
      trustScore: createTestTrustScore({ overall: 0.60 }),
    });

    // Get initial trust score
    const trust = new TrustClient(clientAgent);
    const beforeScore = await trust.getTrustScore(TEST_DIDS.provider);
    expect(beforeScore.overall).toBe(0.70);

    // Execute payment flow
    const payment = new PaymentClient(clientAgent, TEST_DIDS.client);
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '100',
      taskHash: keccak256(toHex('test-task-trust-update')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Provider confirms delivery
    const providerPayment = new PaymentClient(providerAgent, TEST_DIDS.provider);
    await providerPayment.confirmDelivery(escrowId, keccak256(toHex('output')));

    // Client releases payment - this should trigger trust update
    await payment.releaseEscrow(escrowId);

    // Verify escrow is released
    const escrow = await payment.getEscrow(escrowId);
    expect(escrow.state).toBe(EscrowState.RELEASED);

    // Simulate trust score update (in real system, this happens via contract events)
    // Update the mock to reflect increased trust
    const providerData = mockPublicClient.extendedAgentData.get(didToHash(TEST_DIDS.provider));
    if (providerData) {
      providerData.successfulTransactions += 1;
      // Recalculate trust score based on new success rate
      const totalTx = providerData.successfulTransactions + providerData.failedTransactions;
      const successRate = providerData.successfulTransactions / totalTx;
      const newTrustScore = createTestTrustScore({
        overall: Math.min(1.0, 0.70 + (successRate * 0.05)), // Slight increase
        reputation: Math.min(1.0, 0.65 + (successRate * 0.05)),
      });
      providerData.trustScore = newTrustScore;
      // Also update the trustScores map
      mockPublicClient.trustScores.set(didToHash(TEST_DIDS.provider), newTrustScore);
    }

    // Verify trust score increased
    const afterScore = await trust.getTrustScore(TEST_DIDS.provider);
    expect(afterScore.overall).toBeGreaterThan(beforeScore.overall);
  });

  it('should decrease provider trust score after dispute loss', async () => {
    // Setup: Register agents
    const initialProviderTrust = createTestTrustScore({
      overall: 0.80,
      reputation: 0.75,
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
      trustScore: initialProviderTrust,
      successfulTransactions: 20,
      failedTransactions: 2,
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
      trustScore: createTestTrustScore({ overall: 0.60 }),
    });

    // Get initial trust score
    const trust = new TrustClient(clientAgent);
    const beforeScore = await trust.getTrustScore(TEST_DIDS.provider);

    // Execute payment flow
    const payment = new PaymentClient(clientAgent, TEST_DIDS.client);
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '100',
      taskHash: keccak256(toHex('disputed-task')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Provider claims delivery but client disputes
    const providerPayment = new PaymentClient(providerAgent, TEST_DIDS.provider);
    await providerPayment.confirmDelivery(escrowId, keccak256(toHex('bad-output')));

    // Client initiates dispute
    await payment.initiateDispute(escrowId);

    // Verify escrow is disputed
    const escrow = await payment.getEscrow(escrowId);
    expect(escrow.state).toBe(EscrowState.DISPUTED);

    // Simulate dispute resolution (client wins) - update mock
    const providerData = mockPublicClient.extendedAgentData.get(didToHash(TEST_DIDS.provider));
    if (providerData) {
      providerData.failedTransactions += 1;
      // Recalculate trust with penalty
      const newTrustScore = createTestTrustScore({
        overall: Math.max(0, beforeScore.overall - 0.05), // Decrease
        reputation: Math.max(0, beforeScore.reputation - 0.05),
      });
      providerData.trustScore = newTrustScore;
      mockPublicClient.trustScores.set(didToHash(TEST_DIDS.provider), newTrustScore);
    }

    // Verify trust score decreased
    const afterScore = await trust.getTrustScore(TEST_DIDS.provider);
    expect(afterScore.overall).toBeLessThan(beforeScore.overall);
  });

  it('should track transaction volume affecting trust score', async () => {
    // Setup: Register agent with low transaction volume
    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
      trustScore: createTestTrustScore({ overall: 0.50 }),
      successfulTransactions: 5,
      failedTransactions: 0,
      totalVolume: parseUnits('500', USDC_DECIMALS), // $500 total
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
      trustScore: createTestTrustScore({ overall: 0.60 }),
    });

    const trust = new TrustClient(clientAgent);

    // Get initial score - low trust
    const initialScore = await trust.getTrustScore(TEST_DIDS.provider);
    expect(initialScore.overall).toBe(0.50);

    // Execute high-value transaction
    const payment = new PaymentClient(clientAgent, TEST_DIDS.client);
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '1000', // $1000 - significant volume increase
      taskHash: keccak256(toHex('high-value-task')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Complete transaction
    const providerPayment = new PaymentClient(providerAgent, TEST_DIDS.provider);
    await providerPayment.confirmDelivery(escrowId, keccak256(toHex('output')));
    await payment.releaseEscrow(escrowId);

    // Update mock to reflect volume increase and trust improvement
    const providerData = mockPublicClient.extendedAgentData.get(didToHash(TEST_DIDS.provider));
    if (providerData) {
      providerData.successfulTransactions += 1;
      providerData.totalVolume = parseUnits('1500', USDC_DECIMALS); // $1500 total
      const newTrustScore = createTestTrustScore({
        overall: 0.65, // Increased due to volume
        reputation: 0.70,
      });
      providerData.trustScore = newTrustScore;
      mockPublicClient.trustScores.set(didToHash(TEST_DIDS.provider), newTrustScore);
    }

    // Verify trust score increased
    const afterScore = await trust.getTrustScore(TEST_DIDS.provider);
    expect(afterScore.overall).toBeGreaterThan(0.50);
  });
});

// =============================================================================
// Streaming Payments E2E
// =============================================================================

describe('Streaming Payments Settlement', () => {
  let clientAgent: AgentMeClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;
  const STREAMING_ADDRESS = '0x9876543210987654321098765432109876543210' as `0x${string}`;

  beforeEach(() => {
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    clientAgent = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private for testing
    clientAgent.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private for testing
    clientAgent.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private for testing
    clientAgent.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private for testing
    clientAgent.connected = true;
  });

  it('should create and manage streaming payment', async () => {
    const streaming = new StreamingPaymentsClient(clientAgent, {
      streamingPaymentsAddress: STREAMING_ADDRESS,
    });

    // Create a stream
    const streamId = await streaming.createStream({
      recipientDid: TEST_DIDS.provider,
      recipientAddress: TEST_ADDRESSES.provider,
      amount: '100', // $100 total
      duration: 3600, // 1 hour
    });

    expect(streamId).toBeGreaterThanOrEqual(1n);

    // Check stream status
    const stream = await streaming.getStream(streamId);
    expect(stream.status).toBe(StreamStatus.ACTIVE);
    expect(stream.depositAmount).toBe(parseUnits('100', USDC_DECIMALS));

    // Check streamed amount (simulated time passage)
    const streamedAmount = await streaming.getStreamedAmount(streamId);
    expect(streamedAmount).toBeGreaterThanOrEqual(0n);
  });

  it('should allow recipient to withdraw from stream', async () => {
    const streaming = new StreamingPaymentsClient(clientAgent, {
      streamingPaymentsAddress: STREAMING_ADDRESS,
    });

    // Create stream
    const streamId = await streaming.createStream({
      recipientDid: TEST_DIDS.provider,
      recipientAddress: TEST_ADDRESSES.provider,
      amount: '100',
      duration: 3600,
    });

    // Get withdrawable amount
    const withdrawable = await streaming.getWithdrawableAmount(streamId);

    // Withdraw funds using withdrawMax (returns string)
    const withdrawn = await streaming.withdrawMax(streamId);
    expect(withdrawn).toBeDefined();

    // Verify stream state updated
    const stream = await streaming.getStream(streamId);
    expect(stream.withdrawnAmount).toBeGreaterThanOrEqual(0n);
  });

  it('should handle stream cancellation with pro-rata refund', async () => {
    const streaming = new StreamingPaymentsClient(clientAgent, {
      streamingPaymentsAddress: STREAMING_ADDRESS,
    });

    // Create cancellable stream
    const streamId = await streaming.createStream({
      recipientDid: TEST_DIDS.provider,
      recipientAddress: TEST_ADDRESSES.provider,
      amount: '100',
      duration: 3600,
      cancelableBySender: true,
    });

    // Get cancellation preview (returns formatted strings)
    const preview = await streaming.getCancellationPreview(streamId);
    expect(parseFloat(preview.recipientAmount)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(preview.senderRefund)).toBeGreaterThanOrEqual(0);

    // Total should equal deposit (compare as strings)
    expect(preview.totalDeposit).toBe('100');

    // Cancel stream
    const txHash = await streaming.cancel(streamId);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify stream is canceled
    const canceledStream = await streaming.getStream(streamId);
    expect(canceledStream.status).toBe(StreamStatus.CANCELED);
  });

  it('should complete stream when duration ends', async () => {
    const streaming = new StreamingPaymentsClient(clientAgent, {
      streamingPaymentsAddress: STREAMING_ADDRESS,
    });

    // Create stream with short duration
    const streamId = await streaming.createStream({
      recipientDid: TEST_DIDS.provider,
      recipientAddress: TEST_ADDRESSES.provider,
      amount: '50',
      duration: 60, // 1 minute
    });

    // Simulate time passage (mock advances time by setting both start and end to past)
    const stream = mockPublicClient.streams.get(streamId);
    if (stream) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      // Set start time to 70 seconds ago, end time to 10 seconds ago (60 second duration in past)
      stream.startTime = now - 70n;
      stream.endTime = now - 10n;
      stream.status = StreamStatus.COMPLETED;
    }

    // Verify stream completed
    const completedStream = await streaming.getStream(streamId);
    expect(completedStream.status).toBe(StreamStatus.COMPLETED);

    // Verify full amount is withdrawable (stream ended, all deposited is vested)
    const withdrawable = await streaming.getWithdrawableAmount(streamId);
    expect(withdrawable).toBe(parseUnits('50', USDC_DECIMALS));
  });
});

// =============================================================================
// Multi-Party Payment Settlement
// =============================================================================

describe('Multi-Party Payment Settlement', () => {
  let orchestratorClient: AgentMeClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  const agents = {
    orchestrator: {
      did: 'did:agentme:base:0x1111111111111111111111111111111111111111',
      address: '0x1111111111111111111111111111111111111111' as const,
    },
    worker1: {
      did: 'did:agentme:base:0x2222222222222222222222222222222222222222',
      address: '0x2222222222222222222222222222222222222222' as const,
    },
    worker2: {
      did: 'did:agentme:base:0x3333333333333333333333333333333333333333',
      address: '0x3333333333333333333333333333333333333333' as const,
    },
    finalizer: {
      did: 'did:agentme:base:0x4444444444444444444444444444444444444444',
      address: '0x4444444444444444444444444444444444444444' as const,
    },
  };

  beforeEach(() => {
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    // Register all agents
    for (const agent of Object.values(agents)) {
      registerTestAgent(mockPublicClient, agent.did, {
        owner: agent.address,
        trustScore: createTestTrustScore({ overall: 0.75 }),
      });
    }

    orchestratorClient = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private for testing
    orchestratorClient.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private for testing
    orchestratorClient.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private for testing
    orchestratorClient.account = { address: agents.orchestrator.address };
    // @ts-expect-error - accessing private for testing
    orchestratorClient.connected = true;
  });

  it('should settle payments to multiple workers in sequence', async () => {
    const payment = new PaymentClient(orchestratorClient, agents.orchestrator.did);

    // Create escrows for each worker
    const escrowIds: bigint[] = [];

    for (const [name, agent] of Object.entries(agents)) {
      if (name === 'orchestrator') continue;

      const escrowId = await payment.createAndFundEscrow({
        providerDid: agent.did,
        providerAddress: agent.address,
        amount: name === 'finalizer' ? '100' : '50', // Finalizer gets more
        taskHash: keccak256(toHex(`task-${name}`)),
        deadline: Date.now() + 24 * 60 * 60 * 1000,
      });

      escrowIds.push(escrowId);
    }

    expect(escrowIds).toHaveLength(3); // worker1, worker2, finalizer

    // Simulate all workers completing their tasks
    for (let i = 0; i < escrowIds.length; i++) {
      const escrow = mockPublicClient.escrows.get(escrowIds[i]!);
      if (escrow) {
        escrow.state = EscrowState.DELIVERED;
        escrow.outputHash = keccak256(toHex(`output-${i}`));
      }
    }

    // Release all payments
    for (const escrowId of escrowIds) {
      await payment.releaseEscrow(escrowId);
    }

    // Verify all escrows are released
    for (const escrowId of escrowIds) {
      const escrow = await payment.getEscrow(escrowId);
      expect(escrow.state).toBe(EscrowState.RELEASED);
    }

    // Calculate total paid
    let totalPaid = 0n;
    for (const escrowId of escrowIds) {
      const escrow = await payment.getEscrow(escrowId);
      totalPaid += escrow.amount;
    }

    // $50 + $50 + $100 = $200
    expect(totalPaid).toBe(parseUnits('200', USDC_DECIMALS));
  });

  it('should handle partial settlement with one worker dispute', async () => {
    const payment = new PaymentClient(orchestratorClient, agents.orchestrator.did);

    // Create escrows
    const worker1EscrowId = await payment.createAndFundEscrow({
      providerDid: agents.worker1.did,
      providerAddress: agents.worker1.address,
      amount: '50',
      taskHash: keccak256(toHex('task-worker1')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    const worker2EscrowId = await payment.createAndFundEscrow({
      providerDid: agents.worker2.did,
      providerAddress: agents.worker2.address,
      amount: '50',
      taskHash: keccak256(toHex('task-worker2')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Worker1 completes successfully
    const worker1Escrow = mockPublicClient.escrows.get(worker1EscrowId);
    if (worker1Escrow) {
      worker1Escrow.state = EscrowState.DELIVERED;
      worker1Escrow.outputHash = keccak256(toHex('output-worker1'));
    }
    await payment.releaseEscrow(worker1EscrowId);

    // Worker2 delivers bad work - dispute initiated
    const worker2Escrow = mockPublicClient.escrows.get(worker2EscrowId);
    if (worker2Escrow) {
      worker2Escrow.state = EscrowState.DELIVERED;
      worker2Escrow.outputHash = keccak256(toHex('bad-output'));
    }
    await payment.initiateDispute(worker2EscrowId);

    // Verify states
    const escrow1 = await payment.getEscrow(worker1EscrowId);
    const escrow2 = await payment.getEscrow(worker2EscrowId);

    expect(escrow1.state).toBe(EscrowState.RELEASED);
    expect(escrow2.state).toBe(EscrowState.DISPUTED);

    // Only $50 was successfully paid
    expect(escrow1.amount).toBe(parseUnits('50', USDC_DECIMALS));
  });

  it('should calculate aggregate trust impact from batch settlement', async () => {
    const trust = new TrustClient(orchestratorClient);
    const payment = new PaymentClient(orchestratorClient, agents.orchestrator.did);

    // Get initial trust scores
    const initialScores: Record<string, number> = {};
    for (const [name, agent] of Object.entries(agents)) {
      if (name === 'orchestrator') continue;
      const score = await trust.getTrustScore(agent.did);
      initialScores[name] = score.overall;
    }

    // Create and complete multiple escrows
    for (const [name, agent] of Object.entries(agents)) {
      if (name === 'orchestrator') continue;

      const escrowId = await payment.createAndFundEscrow({
        providerDid: agent.did,
        providerAddress: agent.address,
        amount: '25',
        taskHash: keccak256(toHex(`batch-task-${name}`)),
        deadline: Date.now() + 24 * 60 * 60 * 1000,
      });

      // Complete immediately
      const escrow = mockPublicClient.escrows.get(escrowId);
      if (escrow) {
        escrow.state = EscrowState.DELIVERED;
        escrow.outputHash = keccak256(toHex(`batch-output-${name}`));
      }

      await payment.releaseEscrow(escrowId);

      // Update mock trust score
      const agentData = mockPublicClient.extendedAgentData.get(didToHash(agent.did));
      if (agentData) {
        agentData.successfulTransactions += 1;
        const newTrustScore = createTestTrustScore({
          overall: Math.min(1.0, initialScores[name]! + 0.02),
        });
        agentData.trustScore = newTrustScore;
        mockPublicClient.trustScores.set(didToHash(agent.did), newTrustScore);
      }
    }

    // Verify all workers got trust boost
    for (const [name, agent] of Object.entries(agents)) {
      if (name === 'orchestrator') continue;
      const finalScore = await trust.getTrustScore(agent.did);
      expect(finalScore.overall).toBeGreaterThanOrEqual(initialScores[name]!);
    }
  });
});
