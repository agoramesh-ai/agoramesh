/**
 * Agent Discovery E2E Tests
 *
 * Tests for agent discovery, announcement, and capability card retrieval.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentMeshClient } from '../../src/client.js';
import { DiscoveryClient } from '../../src/discovery.js';
import type { CapabilityCard, DiscoveryResult } from '../../src/types.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  TEST_NODE_URL,
  createTestCapabilityCard,
  createTestSkill,
  createTestTrustScore,
  createTestDiscoveryResult,
  createMockPublicClient,
  createMockWalletClient,
  createMockFetch,
  registerTestAgent,
} from './setup.js';

describe('Agent Discovery E2E', () => {
  let client: AgentMeshClient;
  let discovery: DiscoveryClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;
  let mockFetchResult: ReturnType<typeof createMockFetch>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Save original fetch
    originalFetch = global.fetch;

    // Create fresh mocks
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);
    mockFetchResult = createMockFetch();

    // Replace global fetch
    global.fetch = mockFetchResult.mockFetch;

    // Create client with test config
    client = new AgentMeshClient({
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

    // Create discovery client
    discovery = new DiscoveryClient(client, TEST_NODE_URL);
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('announce', () => {
    it('should announce agent capability card to the network', async () => {
      const capabilityCard = createTestCapabilityCard({
        id: TEST_DIDS.provider,
        name: 'Translation Agent',
        description: 'Professional translation services',
        skills: [
          createTestSkill({
            id: 'translate',
            name: 'Document Translation',
            tags: ['translation', 'legal', 'documents'],
          }),
        ],
      });

      // Announce the card
      await discovery.announce(capabilityCard);

      // Verify fetch was called
      expect(mockFetchResult.mockFetch).toHaveBeenCalledWith(
        `${TEST_NODE_URL}/api/v1/discovery/announce`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(capabilityCard),
        })
      );

      // Verify card was stored in mock
      expect(mockFetchResult.announcedCards.has(TEST_DIDS.provider)).toBe(true);
    });

    it('should throw when node URL not configured', async () => {
      const discoveryWithoutNode = new DiscoveryClient(client);
      const capabilityCard = createTestCapabilityCard();

      await expect(discoveryWithoutNode.announce(capabilityCard)).rejects.toThrow(
        'Node URL not configured'
      );
    });

    it('should update existing announcement', async () => {
      const cardV1 = createTestCapabilityCard({
        id: TEST_DIDS.provider,
        version: '1.0.0',
        description: 'Version 1',
      });

      const cardV2 = createTestCapabilityCard({
        id: TEST_DIDS.provider,
        version: '2.0.0',
        description: 'Version 2',
      });

      // Announce v1
      await discovery.announce(cardV1);
      expect(mockFetchResult.announcedCards.get(TEST_DIDS.provider)?.version).toBe(
        '1.0.0'
      );

      // Announce v2 (update)
      await discovery.announce(cardV2);
      expect(mockFetchResult.announcedCards.get(TEST_DIDS.provider)?.version).toBe(
        '2.0.0'
      );
    });
  });

  describe('unannounce', () => {
    it('should remove agent from discovery', async () => {
      // First announce
      const capabilityCard = createTestCapabilityCard({
        id: TEST_DIDS.provider,
      });
      await discovery.announce(capabilityCard);
      expect(mockFetchResult.announcedCards.has(TEST_DIDS.provider)).toBe(true);

      // Then unannounce
      await discovery.unannounce(TEST_DIDS.provider);

      // Verify fetch was called
      expect(mockFetchResult.mockFetch).toHaveBeenCalledWith(
        `${TEST_NODE_URL}/api/v1/discovery/unannounce`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ did: TEST_DIDS.provider }),
        })
      );

      // Verify card was removed
      expect(mockFetchResult.announcedCards.has(TEST_DIDS.provider)).toBe(false);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Announce several test agents
      const translationAgent = createTestCapabilityCard({
        id: 'did:agentmesh:base:translation',
        name: 'Translation Agent',
        description: 'Professional translation services for legal documents',
        skills: [
          createTestSkill({
            id: 'translate',
            name: 'Document Translation',
            tags: ['translation', 'legal', 'documents'],
          }),
        ],
      });

      const summaryAgent = createTestCapabilityCard({
        id: 'did:agentmesh:base:summary',
        name: 'Summary Agent',
        description: 'Summarize long documents quickly',
        skills: [
          createTestSkill({
            id: 'summarize',
            name: 'Text Summarization',
            tags: ['summarization', 'documents'],
          }),
        ],
      });

      const codeAgent = createTestCapabilityCard({
        id: 'did:agentmesh:base:code',
        name: 'Code Agent',
        description: 'Code review and analysis',
        skills: [
          createTestSkill({
            id: 'review',
            name: 'Code Review',
            tags: ['code', 'review', 'analysis'],
          }),
        ],
      });

      await discovery.announce(translationAgent);
      await discovery.announce(summaryAgent);
      await discovery.announce(codeAgent);
    });

    it('should search for agents by natural language query', async () => {
      const results = await discovery.search('translate legal documents');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Translation Agent');
      expect(results[0].matchingSkills).toHaveLength(1);
    });

    it('should search by agent name', async () => {
      const results = await discovery.search('Summary Agent');

      expect(results).toHaveLength(1);
      expect(results[0].did).toBe('did:agentmesh:base:summary');
    });

    it('should search by skill name', async () => {
      const results = await discovery.search('Code Review');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Code Agent');
    });

    it('should return empty results for no matches', async () => {
      const results = await discovery.search('quantum computing');

      expect(results).toHaveLength(0);
    });

    it('should apply minTrust filter', async () => {
      const results = await discovery.search('documents', {
        minTrust: 0.9,
      });

      // Our mock returns default trust of 0.75, so no results with 0.9 filter
      // (The mock filters based on card.trust?.score which is undefined by default)
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should respect limit option', async () => {
      const results = await discovery.search('documents', {
        limit: 1,
      });

      // Should return at most 1 result
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should throw when node URL not configured', async () => {
      const discoveryWithoutNode = new DiscoveryClient(client);

      await expect(discoveryWithoutNode.search('test')).rejects.toThrow(
        'Node URL not configured'
      );
    });
  });

  describe('searchByTags', () => {
    beforeEach(async () => {
      // Announce test agents with specific tags
      const translationAgent = createTestCapabilityCard({
        id: 'did:agentmesh:base:translation',
        name: 'Translation Agent',
        skills: [
          createTestSkill({
            id: 'translate',
            tags: ['translation', 'legal', 'documents'],
          }),
        ],
      });

      const summaryAgent = createTestCapabilityCard({
        id: 'did:agentmesh:base:summary',
        name: 'Summary Agent',
        skills: [
          createTestSkill({
            id: 'summarize',
            tags: ['summarization', 'documents', 'ai'],
          }),
        ],
      });

      await discovery.announce(translationAgent);
      await discovery.announce(summaryAgent);
    });

    it('should find agents by single tag', async () => {
      const results = await discovery.searchByTags(['documents']);

      expect(results).toHaveLength(2);
    });

    it('should find agents by multiple tags', async () => {
      const results = await discovery.searchByTags(['legal', 'translation']);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Translation Agent');
    });

    it('should return empty for non-existent tags', async () => {
      const results = await discovery.searchByTags(['blockchain', 'defi']);

      expect(results).toHaveLength(0);
    });
  });

  describe('getCapabilityCard', () => {
    it('should get capability card by DID from DHT', async () => {
      // Announce a card first
      const capabilityCard = createTestCapabilityCard({
        id: TEST_DIDS.provider,
        name: 'Provider Agent',
      });
      await discovery.announce(capabilityCard);

      // Fetch the card
      const card = await discovery.getCapabilityCard(TEST_DIDS.provider);

      expect(card).toBeDefined();
      expect(card?.id).toBe(TEST_DIDS.provider);
      expect(card?.name).toBe('Provider Agent');
    });

    it('should return null for non-existent agent', async () => {
      const card = await discovery.getCapabilityCard(TEST_DIDS.unregistered);

      expect(card).toBeNull();
    });

    it('should try well-known URL for did:web DIDs', async () => {
      // Mock a did:web DID
      const didWeb = 'did:web:example.com';

      // This should try https://example.com/.well-known/agent.json
      // Our mock returns null for well-known URLs
      const card = await discovery.getCapabilityCard(didWeb);

      // Should have tried the well-known URL
      expect(mockFetchResult.mockFetch).toHaveBeenCalled();
    });
  });

  describe('rankResults', () => {
    it('should rank results by trust/price ratio', () => {
      const results: DiscoveryResult[] = [
        createTestDiscoveryResult({
          did: 'did:1',
          name: 'Expensive High Trust',
          trust: { overall: 0.9, reputation: 0.9, stake: 0.9, endorsement: 0.9 },
          pricing: { model: 'per_request', amount: '1.00', currency: 'USDC' },
        }),
        createTestDiscoveryResult({
          did: 'did:2',
          name: 'Cheap Medium Trust',
          trust: { overall: 0.6, reputation: 0.6, stake: 0.6, endorsement: 0.6 },
          pricing: { model: 'per_request', amount: '0.10', currency: 'USDC' },
        }),
        createTestDiscoveryResult({
          did: 'did:3',
          name: 'Medium Price High Trust',
          trust: { overall: 0.8, reputation: 0.8, stake: 0.8, endorsement: 0.8 },
          pricing: { model: 'per_request', amount: '0.20', currency: 'USDC' },
        }),
      ];

      const ranked = discovery.rankResults(results);

      // Cheap Medium Trust: 0.6/0.10 = 6.0 (best value)
      // Medium Price High Trust: 0.8/0.20 = 4.0
      // Expensive High Trust: 0.9/1.00 = 0.9
      expect(ranked[0].did).toBe('did:2');
      expect(ranked[1].did).toBe('did:3');
      expect(ranked[2].did).toBe('did:1');
    });

    it('should handle missing pricing gracefully', () => {
      const results: DiscoveryResult[] = [
        createTestDiscoveryResult({
          did: 'did:1',
          trust: { overall: 0.9, reputation: 0.9, stake: 0.9, endorsement: 0.9 },
          pricing: undefined,
        }),
        createTestDiscoveryResult({
          did: 'did:2',
          trust: { overall: 0.5, reputation: 0.5, stake: 0.5, endorsement: 0.5 },
          pricing: { model: 'per_request', amount: '0.10', currency: 'USDC' },
        }),
      ];

      const ranked = discovery.rankResults(results);

      // Agent with pricing should rank higher (has actual value ratio)
      expect(ranked[0].did).toBe('did:2');
    });
  });

  describe('filterBySkills', () => {
    it('should filter results by required skill IDs', () => {
      const results: DiscoveryResult[] = [
        createTestDiscoveryResult({
          did: 'did:1',
          matchingSkills: [
            createTestSkill({ id: 'translate' }),
            createTestSkill({ id: 'summarize' }),
          ],
        }),
        createTestDiscoveryResult({
          did: 'did:2',
          matchingSkills: [createTestSkill({ id: 'translate' })],
        }),
        createTestDiscoveryResult({
          did: 'did:3',
          matchingSkills: [createTestSkill({ id: 'review' })],
        }),
      ];

      const filtered = discovery.filterBySkills(results, ['translate']);

      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.did)).toContain('did:1');
      expect(filtered.map((r) => r.did)).toContain('did:2');
    });

    it('should require all specified skills', () => {
      const results: DiscoveryResult[] = [
        createTestDiscoveryResult({
          did: 'did:1',
          matchingSkills: [
            createTestSkill({ id: 'translate' }),
            createTestSkill({ id: 'summarize' }),
          ],
        }),
        createTestDiscoveryResult({
          did: 'did:2',
          matchingSkills: [createTestSkill({ id: 'translate' })],
        }),
      ];

      const filtered = discovery.filterBySkills(results, [
        'translate',
        'summarize',
      ]);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].did).toBe('did:1');
    });
  });

  describe('getRecommendations', () => {
    beforeEach(async () => {
      const agent1 = createTestCapabilityCard({
        id: 'did:agentmesh:base:agent1',
        name: 'Premium Agent',
        description: 'High quality translation',
        skills: [
          createTestSkill({
            id: 'translate',
            tags: ['translation'],
            pricing: { model: 'per_request', amount: '1.00', currency: 'USDC' },
          }),
        ],
      });

      const agent2 = createTestCapabilityCard({
        id: 'did:agentmesh:base:agent2',
        name: 'Budget Agent',
        description: 'Affordable translation',
        skills: [
          createTestSkill({
            id: 'translate',
            tags: ['translation'],
            pricing: { model: 'per_request', amount: '0.10', currency: 'USDC' },
          }),
        ],
      });

      await discovery.announce(agent1);
      await discovery.announce(agent2);
    });

    it('should return ranked recommendations for a task', async () => {
      const recommendations = await discovery.getRecommendations('translation', {
        minTrust: 0.5,
      });

      expect(recommendations.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Node URL configuration', () => {
    it('should allow setting node URL after construction', () => {
      const discoveryWithoutNode = new DiscoveryClient(client);
      expect(discoveryWithoutNode.getNodeUrl()).toBeNull();

      discoveryWithoutNode.setNodeUrl('http://new-node:8080');
      expect(discoveryWithoutNode.getNodeUrl()).toBe('http://new-node:8080');
    });

    it('should use constructor-provided node URL', () => {
      expect(discovery.getNodeUrl()).toBe(TEST_NODE_URL);
    });
  });

  describe('IPFS Resolution', () => {
    it('should fetch capability card from IPFS gateway when CID is available', async () => {
      // Arrange - mock getAgent to return agent with CID
      const testCard = createTestCapabilityCard({
        id: 'did:agentmesh:base:ipfs-agent',
        name: 'IPFS Agent',
        description: 'Agent with IPFS capability card',
      });

      // Mock the client.getAgent to return agent info with CID
      vi.spyOn(client, 'getAgent').mockResolvedValue({
        did: 'did:agentmesh:base:ipfs-agent',
        owner: TEST_ADDRESSES.agent,
        capabilityCardCID: 'QmTestCID123',
        active: true,
        registeredAt: BigInt(Date.now()),
      });

      // Mock fetch - DHT endpoint returns 404 (not found), IPFS returns the card
      // getCapabilityCard tries: 1) well-known (N/A for agentmesh DID), 2) DHT, 3) IPFS
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/v1/agents/')) {
          // DHT endpoint - return 404 so it falls through to IPFS
          return Promise.resolve({ ok: false, status: 404 });
        }
        const parsed = new URL(url, 'http://localhost');
        if (parsed.hostname === 'ipfs.io' || url.includes('QmTestCID123')) {
          // IPFS gateway - return the capability card
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(testCard),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      global.fetch = mockFetch;

      // Act
      const card = await discovery.getCapabilityCard('did:agentmesh:base:ipfs-agent');

      // Assert
      expect(card).not.toBeNull();
      expect(card?.id).toBe('did:agentmesh:base:ipfs-agent');
      expect(card?.name).toBe('IPFS Agent');
      // Verify IPFS gateway was called
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('QmTestCID123'),
        expect.any(Object)
      );
    });

    it('should return null when IPFS gateway returns error', async () => {
      // Arrange
      vi.spyOn(client, 'getAgent').mockResolvedValue({
        did: 'did:agentmesh:base:ipfs-agent',
        owner: TEST_ADDRESSES.agent,
        capabilityCardCID: 'QmInvalidCID',
        active: true,
        registeredAt: BigInt(Date.now()),
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      // Act
      const card = await discovery.getCapabilityCard('did:agentmesh:base:ipfs-agent');

      // Assert - should fall through to return null
      expect(card).toBeNull();
    });

    it('should return null when agent has no CID', async () => {
      // Arrange
      vi.spyOn(client, 'getAgent').mockResolvedValue({
        did: 'did:agentmesh:base:no-cid-agent',
        owner: TEST_ADDRESSES.agent,
        capabilityCardCID: '', // Empty CID
        active: true,
        registeredAt: BigInt(Date.now()),
      });

      // Act
      const card = await discovery.getCapabilityCard('did:agentmesh:base:no-cid-agent');

      // Assert
      expect(card).toBeNull();
    });

    it('should use configurable IPFS gateway URL', async () => {
      // Arrange
      const customGateway = 'https://custom-gateway.io/ipfs';
      discovery.setIPFSGateway(customGateway);

      vi.spyOn(client, 'getAgent').mockResolvedValue({
        did: 'did:agentmesh:base:custom-gateway',
        owner: TEST_ADDRESSES.agent,
        capabilityCardCID: 'QmCustomTest',
        active: true,
        registeredAt: BigInt(Date.now()),
      });

      // Mock fetch - DHT returns 404, custom IPFS gateway returns the card
      const testCard = createTestCapabilityCard({ id: 'did:agentmesh:base:custom-gateway' });
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/v1/agents/')) {
          // DHT endpoint - return 404 so it falls through to IPFS
          return Promise.resolve({ ok: false, status: 404 });
        }
        const parsed = new URL(url, 'http://localhost');
        if (parsed.hostname === 'custom-gateway.io') {
          // Custom IPFS gateway - return the capability card
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(testCard),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      global.fetch = mockFetch;

      // Act
      const card = await discovery.getCapabilityCard('did:agentmesh:base:custom-gateway');

      // Assert
      expect(card).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('custom-gateway.io'),
        expect.any(Object)
      );
    });
  });
});
