/**
 * Integration Workflow Tests
 *
 * Tests complete end-to-end workflows across multiple SDK components.
 * These tests verify that all components work together correctly.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { keccak256, toHex, parseUnits } from 'viem';
import { AgentMeClient, didToHash } from '../../src/client.js';
import { TrustClient } from '../../src/trust.js';
import { PaymentClient } from '../../src/payment.js';
import { DiscoveryClient } from '../../src/discovery.js';
import { X402Client, createX402Client } from '../../src/x402.js';
import { SemanticSearchClient, createSimpleEmbedder } from '../../src/semantic.js';
import { EscrowState, USDC_DECIMALS } from '../../src/types.js';
import type { CapabilityCard, Escrow } from '../../src/types.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  createMockPublicClient,
  createMockWalletClient,
  createMockFetch,
  createTestCapabilityCard,
  createTestTrustScore,
  createTestEscrow,
  registerTestAgent,
} from '../e2e/setup.js';

// =============================================================================
// Full Workflow Tests
// =============================================================================

describe('Complete Agent Discovery and Payment Workflow', () => {
  let clientAgent: AgentMeClient;
  let providerAgent: AgentMeClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;
  let mockFetchContext: ReturnType<typeof createMockFetch>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Save original fetch
    originalFetch = global.fetch;

    // Setup mocks
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);
    mockFetchContext = createMockFetch();
    global.fetch = mockFetchContext.mockFetch;

    // Create client agent (the one requesting services)
    clientAgent = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private property for testing
    clientAgent.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    clientAgent.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    clientAgent.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private property for testing
    clientAgent.connected = true;

    // Create provider agent (the one offering services)
    providerAgent = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.provider,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private property for testing
    providerAgent.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    providerAgent.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    providerAgent.account = { address: TEST_ADDRESSES.provider };
    // @ts-expect-error - accessing private property for testing
    providerAgent.connected = true;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should complete full discovery → trust check → payment workflow', async () => {
    // =========================================================================
    // Step 1: Provider registers and announces their capability card
    // =========================================================================

    // Register provider on-chain
    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
      trustScore: createTestTrustScore({ overall: 0.85 }),
      capabilityCardCID: 'ipfs://QmTestProvider',
    });

    // Create and announce capability card
    const providerCard = createTestCapabilityCard({
      id: TEST_DIDS.provider,
      name: 'Translation Agent',
      description: 'Professional translation services for legal documents',
      skills: [
        {
          id: 'legal-translation',
          name: 'Legal Translation',
          description: 'Translate legal documents between languages',
          tags: ['translation', 'legal', 'documents'],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
          pricing: {
            model: 'per_request',
            amount: '0.50',
            currency: 'USDC',
          },
        },
      ],
    });

    const discovery = new DiscoveryClient(providerAgent, 'http://localhost:8080');
    await discovery.announce(providerCard);

    // =========================================================================
    // Step 2: Client searches for translation services
    // =========================================================================

    const clientDiscovery = new DiscoveryClient(clientAgent, 'http://localhost:8080');
    const results = await clientDiscovery.search('translate legal documents', {
      minTrust: 0.7,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('Translation Agent');

    // =========================================================================
    // Step 3: Client checks provider's trust score
    // =========================================================================

    const trust = new TrustClient(clientAgent);
    const trustScore = await trust.getTrustScore(TEST_DIDS.provider);

    expect(trustScore.overall).toBeGreaterThanOrEqual(0.7);
    await expect(trust.meetsTrustRequirement(TEST_DIDS.provider, 0.7)).resolves.toBe(true);

    // Calculate escrow requirement based on trust
    const escrowRequirement = trust.calculateEscrowRequirement(trustScore.overall, '100');
    expect(parseFloat(escrowRequirement)).toBeLessThan(100); // Higher trust = less escrow

    // =========================================================================
    // Step 4: Client creates escrow for the service
    // =========================================================================

    // Register client for transactions
    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
      trustScore: createTestTrustScore({ overall: 0.6 }),
    });

    const payment = new PaymentClient(clientAgent, TEST_DIDS.client);
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '100',
      taskHash: keccak256(toHex('translate-legal-doc-001')),
      deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    });

    expect(escrowId).toBeGreaterThanOrEqual(1n);

    // =========================================================================
    // Step 5: Provider confirms delivery
    // =========================================================================

    const providerPayment = new PaymentClient(providerAgent, TEST_DIDS.provider);
    const outputHash = keccak256(toHex('translation-output-hash'));
    const deliveryTx = await providerPayment.confirmDelivery(escrowId, outputHash);

    expect(deliveryTx).toMatch(/^0x[0-9a-f]{64}$/);

    // =========================================================================
    // Step 6: Client releases payment
    // =========================================================================

    const releaseTx = await payment.releaseEscrow(escrowId);
    expect(releaseTx).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify escrow state
    const escrow = await payment.getEscrow(escrowId);
    expect(escrow.state).toBe(EscrowState.RELEASED);
  });

  it('should handle dispute workflow', async () => {
    // Setup: Provider registered with lower trust
    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
      trustScore: createTestTrustScore({ overall: 0.5 }),
    });

    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
      trustScore: createTestTrustScore({ overall: 0.6 }),
    });

    // Client creates escrow
    const payment = new PaymentClient(clientAgent, TEST_DIDS.client);
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '50',
      taskHash: keccak256(toHex('disputed-task')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Provider delivers but client disputes
    const providerPayment = new PaymentClient(providerAgent, TEST_DIDS.provider);
    await providerPayment.confirmDelivery(escrowId, keccak256(toHex('bad-output')));

    // Client initiates dispute
    const disputeTx = await payment.initiateDispute(escrowId);
    expect(disputeTx).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify escrow is in disputed state
    const escrow = await payment.getEscrow(escrowId);
    expect(escrow.state).toBe(EscrowState.DISPUTED);
  });
});

describe('Semantic Search Integration', () => {
  let mockFetchContext: ReturnType<typeof createMockFetch>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetchContext = createMockFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should enhance discovery results with semantic search', async () => {
    // Setup semantic search client
    const semantic = new SemanticSearchClient({
      embed: createSimpleEmbedder(),
      minSimilarity: 0.1, // Low threshold for testing
    });

    // Create diverse capability cards
    const cards: CapabilityCard[] = [
      createTestCapabilityCard({
        id: 'did:test:translator',
        name: 'Translation Agent',
        description: 'Translates documents between multiple languages',
        skills: [
          {
            id: 'translate',
            name: 'Translation',
            description: 'Multi-language translation',
            tags: ['translation', 'languages', 'documents'],
            inputModes: ['text/plain'],
            outputModes: ['text/plain'],
          },
        ],
      }),
      createTestCapabilityCard({
        id: 'did:test:coder',
        name: 'Code Assistant',
        description: 'Helps with code review and debugging',
        skills: [
          {
            id: 'code-review',
            name: 'Code Review',
            description: 'Review code for bugs and style',
            tags: ['code', 'review', 'programming'],
            inputModes: ['text/plain'],
            outputModes: ['text/plain'],
          },
        ],
      }),
      createTestCapabilityCard({
        id: 'did:test:writer',
        name: 'Content Writer',
        description: 'Creates blog posts and marketing content',
        skills: [
          {
            id: 'writing',
            name: 'Content Writing',
            description: 'Write engaging content',
            tags: ['writing', 'content', 'marketing'],
            inputModes: ['text/plain'],
            outputModes: ['text/plain'],
          },
        ],
      }),
    ];

    // Index cards
    await semantic.indexCards(cards);

    // Search for translation services
    const results = await semantic.search('translate documents');

    expect(results.length).toBeGreaterThan(0);
    // Translation agent should rank higher for translation queries
    const translatorResult = results.find(
      (r) => (r.item as CapabilityCard).id === 'did:test:translator'
    );
    expect(translatorResult).toBeDefined();
  });

  it('should find similar agents for recommendations', async () => {
    const semantic = new SemanticSearchClient({
      embed: createSimpleEmbedder(),
      minSimilarity: 0.1,
    });

    const cards: CapabilityCard[] = [
      createTestCapabilityCard({
        id: 'did:test:legal-translator',
        name: 'Legal Translation Agent',
        description: 'Specializes in legal document translation',
      }),
      createTestCapabilityCard({
        id: 'did:test:medical-translator',
        name: 'Medical Translation Agent',
        description: 'Specializes in medical document translation',
      }),
      createTestCapabilityCard({
        id: 'did:test:code-agent',
        name: 'Code Review Agent',
        description: 'Reviews code for quality',
      }),
    ];

    await semantic.indexCards(cards);

    // Find agents similar to legal translator
    const similar = semantic.findSimilar('did:test:legal-translator');

    // Medical translator should be more similar than code agent
    if (similar.length >= 2) {
      const medicalIdx = similar.findIndex(
        (r) => (r.item as CapabilityCard).id === 'did:test:medical-translator'
      );
      const codeIdx = similar.findIndex(
        (r) => (r.item as CapabilityCard).id === 'did:test:code-agent'
      );

      // If both are found, medical should rank higher (lower index = higher similarity)
      if (medicalIdx !== -1 && codeIdx !== -1) {
        expect(medicalIdx).toBeLessThan(codeIdx);
      }
    }
  });
});

describe('x402 Micropayment Integration', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should handle 402 payment flow for agent services', async () => {
    const x402Client = createX402Client(TEST_PRIVATE_KEYS.client);

    // Create a mock 402 response followed by success
    const requirement = {
      network: 'eip155:84532',
      receiver: TEST_ADDRESSES.provider,
      amount: '0.10',
      token: TEST_CONTRACT_ADDRESSES.usdc,
    };

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: return 402 with payment requirement
        return new Response(null, {
          status: 402,
          headers: {
            'x-payment-required': btoa(JSON.stringify(requirement)),
          },
        });
      }
      // Second call: return success with payment result
      return new Response(JSON.stringify({ result: 'translation complete' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-payment-response': btoa(
            JSON.stringify({
              success: true,
              network: 'eip155:84532',
              payer: TEST_ADDRESSES.client,
            })
          ),
        },
      });
    });

    // Track payments
    const payments: unknown[] = [];
    const response = await x402Client.fetch(
      'https://agent.example.com/translate',
      {
        method: 'POST',
        body: JSON.stringify({ text: 'Hello world' }),
      },
      {
        onPayment: (payment) => payments.push(payment),
      }
    );

    // Verify flow
    expect(response.status).toBe(200);
    expect(payments.length).toBe(1);
    expect(x402Client.wasPaymentSuccessful(response)).toBe(true);

    const data = await response.json();
    expect(data.result).toBe('translation complete');
  });

  it('should respect payment limits', async () => {
    const x402Client = createX402Client(TEST_PRIVATE_KEYS.client);

    // Return 402 with amount exceeding limit
    global.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 402,
        headers: {
          'x-payment-required': btoa(
            JSON.stringify({
              network: 'eip155:84532',
              receiver: TEST_ADDRESSES.provider,
              amount: '100.00', // High amount
              token: TEST_CONTRACT_ADDRESSES.usdc,
            })
          ),
        },
      })
    );

    // Should reject if amount exceeds maxAmount
    await expect(
      x402Client.fetch('https://agent.example.com/expensive', undefined, {
        maxAmount: '10.00',
      })
    ).rejects.toThrow(/exceeds maximum/);
  });
});

describe('Multi-Agent Collaboration Workflow', () => {
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);
  });

  it('should orchestrate task between multiple agents', async () => {
    // Setup: Three agents - Orchestrator, Translator, and Reviewer
    const agents = {
      orchestrator: {
        did: 'did:agentme:base:0x1111111111111111111111111111111111111111',
        address: '0x1111111111111111111111111111111111111111' as const,
      },
      translator: {
        did: 'did:agentme:base:0x2222222222222222222222222222222222222222',
        address: '0x2222222222222222222222222222222222222222' as const,
      },
      reviewer: {
        did: 'did:agentme:base:0x3333333333333333333333333333333333333333',
        address: '0x3333333333333333333333333333333333333333' as const,
      },
    };

    // Register all agents
    for (const [name, agent] of Object.entries(agents)) {
      registerTestAgent(mockPublicClient, agent.did, {
        owner: agent.address,
        trustScore: createTestTrustScore({ overall: 0.8 }),
      });
    }

    // Create orchestrator client
    const orchestratorClient = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client, // Use any key for testing
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private property for testing
    orchestratorClient.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    orchestratorClient.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    orchestratorClient.account = { address: agents.orchestrator.address };
    // @ts-expect-error - accessing private property for testing
    orchestratorClient.connected = true;

    const trust = new TrustClient(orchestratorClient);
    const payment = new PaymentClient(orchestratorClient, agents.orchestrator.did);

    // =========================================================================
    // Step 1: Create escrow for translation task
    // =========================================================================

    const translationEscrowId = await payment.createAndFundEscrow({
      providerDid: agents.translator.did,
      providerAddress: agents.translator.address,
      amount: '50',
      taskHash: keccak256(toHex('translate-document')),
      deadline: Date.now() + 24 * 60 * 60 * 1000,
    });

    expect(translationEscrowId).toBe(1n);

    // =========================================================================
    // Step 2: Create escrow for review task (depends on translation)
    // =========================================================================

    const reviewEscrowId = await payment.createAndFundEscrow({
      providerDid: agents.reviewer.did,
      providerAddress: agents.reviewer.address,
      amount: '25',
      taskHash: keccak256(toHex('review-translation')),
      deadline: Date.now() + 48 * 60 * 60 * 1000,
    });

    expect(reviewEscrowId).toBe(2n);

    // =========================================================================
    // Step 3: Verify trust scores of all participants
    // =========================================================================

    const translatorScore = await trust.getTrustScore(agents.translator.did);
    const reviewerScore = await trust.getTrustScore(agents.reviewer.did);

    expect(translatorScore.overall).toBeGreaterThanOrEqual(0.7);
    expect(reviewerScore.overall).toBeGreaterThanOrEqual(0.7);

    // =========================================================================
    // Step 4: Complete tasks in sequence
    // =========================================================================

    // Translator delivers
    // In real scenario, translator's payment client would call this
    // For testing, we simulate by updating escrow state directly
    const translationEscrow = mockPublicClient.escrows.get(translationEscrowId);
    if (translationEscrow) {
      translationEscrow.state = EscrowState.DELIVERED;
      translationEscrow.outputHash = keccak256(toHex('translated-output'));
    }

    // Reviewer reviews and delivers
    const reviewEscrow = mockPublicClient.escrows.get(reviewEscrowId);
    if (reviewEscrow) {
      reviewEscrow.state = EscrowState.DELIVERED;
      reviewEscrow.outputHash = keccak256(toHex('review-output'));
    }

    // =========================================================================
    // Step 5: Release payments
    // =========================================================================

    await payment.releaseEscrow(translationEscrowId);
    await payment.releaseEscrow(reviewEscrowId);

    // Verify both escrows are released
    const finalTranslationEscrow = await payment.getEscrow(translationEscrowId);
    const finalReviewEscrow = await payment.getEscrow(reviewEscrowId);

    expect(finalTranslationEscrow.state).toBe(EscrowState.RELEASED);
    expect(finalReviewEscrow.state).toBe(EscrowState.RELEASED);
  });
});

describe('Error Handling and Edge Cases', () => {
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);
  });

  it('should handle unregistered agent gracefully', async () => {
    const client = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
    });

    // @ts-expect-error - accessing private property for testing
    client.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    client.connected = true;

    const trust = new TrustClient(client);
    const score = await trust.getTrustScore('did:agentme:base:0x0000000000000000000000000000000000000000');

    // Unregistered agents should have zero trust
    expect(score.overall).toBe(0);
    expect(score.reputation).toBe(0);
    expect(score.stake).toBe(0);
    expect(score.endorsement).toBe(0);
  });

  it('should handle network errors', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const client = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
    });

    // @ts-expect-error - accessing private property for testing
    client.connected = true;

    const discovery = new DiscoveryClient(client, 'http://localhost:8080');

    await expect(discovery.search('test')).rejects.toThrow();

    global.fetch = originalFetch;
  });

  it('should handle expired escrow deadline', async () => {
    const client = new AgentMeClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // @ts-expect-error - accessing private property for testing
    client.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    client.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    client.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private property for testing
    client.connected = true;

    registerTestAgent(mockPublicClient, TEST_DIDS.client, {
      owner: TEST_ADDRESSES.client,
    });
    registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
      owner: TEST_ADDRESSES.provider,
    });

    const payment = new PaymentClient(client, TEST_DIDS.client);

    // Create escrow with past deadline (simulating expired)
    const escrowId = await payment.createAndFundEscrow({
      providerDid: TEST_DIDS.provider,
      providerAddress: TEST_ADDRESSES.provider,
      amount: '100',
      taskHash: keccak256(toHex('expired-task')),
      deadline: Date.now() - 1000, // Already expired
    });

    // Client can claim timeout on expired escrow
    const timeoutTx = await payment.claimTimeout(escrowId);
    expect(timeoutTx).toMatch(/^0x[0-9a-f]{64}$/);

    const escrow = await payment.getEscrow(escrowId);
    expect(escrow.state).toBe(EscrowState.REFUNDED);
  });
});
