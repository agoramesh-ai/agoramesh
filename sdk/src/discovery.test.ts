/**
 * Discovery Client Tests
 *
 * Tests for DiscoveryClient functionality.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DiscoveryClient } from './discovery.js';
import type { AgoraMeshClient } from './client.js';
import type { CapabilityCard, DiscoveryResult } from './types.js';

// Mock fetch globally
global.fetch = vi.fn();

/**
 * Mock AgoraMeshClient
 */
function createMockClient(): AgoraMeshClient {
  return {
    getAgent: vi.fn(),
    getPublicClient: vi.fn(),
    getContractAddresses: vi.fn(() => ({})),
  } as unknown as AgoraMeshClient;
}

/**
 * Sample capability card for testing
 */
function sampleCapabilityCard(did: string): CapabilityCard {
  return {
    id: did,
    name: 'Test Agent',
    description: 'A test agent for unit testing',
    url: 'https://agent.example.com',
    version: '1.0.0',
    skills: [
      {
        id: 'translation',
        name: 'Translation',
        description: 'Translate text between languages',
        tags: ['nlp', 'translation'],
        pricing: {
          model: 'per_unit',
          currency: 'USDC',
          amount: '0.01',
          unit: 'token',
        },
      },
    ],
    authentication: undefined,
  };
}

/**
 * Sample discovery result
 */
function sampleDiscoveryResult(did: string): DiscoveryResult {
  return {
    did,
    name: 'Test Agent',
    description: 'A test agent',
    url: 'https://agent.example.com',
    trust: {
      overall: 0.85,
      reputation: 0.9,
      stake: 0.8,
      endorsement: 0.75,
    },
    matchingSkills: [
      {
        id: 'translation',
        name: 'Translation',
        description: 'Translate text',
        tags: ['nlp'],
        pricing: {
          model: 'per_unit',
          currency: 'USDC',
          amount: '0.01',
          unit: 'token',
        },
      },
    ],
    pricing: {
      model: 'per_unit',
      currency: 'USDC',
      amount: '0.01',
      unit: 'token',
    },
  };
}

describe('DiscoveryClient', () => {
  let client: AgoraMeshClient;
  let discovery: DiscoveryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    client = createMockClient();
    discovery = new DiscoveryClient(client);
  });

  // ===========================================================================
  // Configuration Tests
  // ===========================================================================

  describe('configuration', () => {
    it('should start without node URL', () => {
      expect(discovery.getNodeUrl()).toBeNull();
    });

    it('should accept node URL in constructor', () => {
      const discoveryWithNode = new DiscoveryClient(client, 'https://node.example.com');
      expect(discoveryWithNode.getNodeUrl()).toBe('https://node.example.com');
    });

    it('should update node URL via setNodeUrl', () => {
      discovery.setNodeUrl('https://new-node.example.com');
      expect(discovery.getNodeUrl()).toBe('https://new-node.example.com');
    });

    it('should have default IPFS gateway', () => {
      expect(discovery.getIPFSGateway()).toBe('https://ipfs.io/ipfs');
    });

    it('should update IPFS gateway', () => {
      discovery.setIPFSGateway('https://cloudflare-ipfs.com/ipfs');
      expect(discovery.getIPFSGateway()).toBe('https://cloudflare-ipfs.com/ipfs');
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search()', () => {
    it('should throw error when node URL not configured', async () => {
      await expect(discovery.search('translate documents')).rejects.toThrow(
        'Node URL not configured'
      );
    });

    it('should build correct query parameters', async () => {
      discovery.setNodeUrl('https://node.example.com');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await discovery.search('translate', {
        minTrust: 0.8,
        maxPrice: '0.10',
        tags: ['nlp'],
        currency: 'USDC',
        limit: 10,
        offset: 5,
      });

      const call = (global.fetch as Mock).mock.calls[0]!;
      const url = new URL(call[0] as string);

      expect(url.pathname).toBe('/agents/semantic');
      expect(url.searchParams.get('q')).toBe('translate');
      expect(url.searchParams.get('minTrust')).toBe('0.8');
      expect(url.searchParams.get('maxPrice')).toBe('0.10');
      expect(url.searchParams.get('tags')).toBe('nlp');
      expect(url.searchParams.get('currency')).toBe('USDC');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('offset')).toBe('5');
    });

    it('should return discovery results', async () => {
      discovery.setNodeUrl('https://node.example.com');

      const nodeResults = [
        {
          did: 'did:agoramesh:base:agent1',
          score: 0.9,
          vector_score: 0.85,
          keyword_score: 0.95,
          card: {
            name: 'Test Agent 1',
            description: 'A test agent',
            url: 'https://agent1.example.com',
            capabilities: [{ id: 'translate', name: 'Translation' }],
            agoramesh: { did: 'did:agoramesh:base:agent1', trust_score: 0.85 },
          },
        },
        {
          did: 'did:agoramesh:base:agent2',
          score: 0.8,
          vector_score: 0.75,
          keyword_score: 0.85,
          card: {
            name: 'Test Agent 2',
            description: 'Another test agent',
            url: 'https://agent2.example.com',
            capabilities: [],
            agoramesh: { did: 'did:agoramesh:base:agent2', trust_score: 0.7 },
          },
        },
      ];

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => nodeResults,
      });

      const results = await discovery.search('translate');

      expect(results).toHaveLength(2);
      expect(results[0]!.did).toBe('did:agoramesh:base:agent1');
      expect(results[0]!.name).toBe('Test Agent 1');
      expect(results[0]!.trust.overall).toBe(0.85);
    });

    it('should prefer enriched trust data from node response', async () => {
      discovery.setNodeUrl('https://node.example.com');

      const nodeResults = [
        {
          did: 'did:agoramesh:base:agent1',
          score: 0.9,
          vector_score: 0.85,
          keyword_score: 0.95,
          card: {
            name: 'Trusted Agent',
            description: 'An agent with enriched trust',
            url: 'https://agent1.example.com',
            capabilities: [{ id: 'translate', name: 'Translation' }],
            agoramesh: { did: 'did:agoramesh:base:agent1', trust_score: 0.5 },
          },
          trust: {
            did: 'did:agoramesh:base:agent1',
            score: 0.92,
            reputation: 0.95,
            stake_score: 0.88,
            endorsement_score: 0.80,
          },
        },
        {
          did: 'did:agoramesh:base:agent2',
          score: 0.8,
          vector_score: 0.75,
          keyword_score: 0.85,
          card: {
            name: 'Basic Agent',
            description: 'An agent without enriched trust',
            url: 'https://agent2.example.com',
            capabilities: [],
            agoramesh: { did: 'did:agoramesh:base:agent2', trust_score: 0.7 },
          },
          // No trust field - should fall back to card.agoramesh.trust_score
        },
      ];

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => nodeResults,
      });

      const results = await discovery.search('translate');

      expect(results).toHaveLength(2);

      // Agent 1: should use enriched trust data
      expect(results[0]!.trust.overall).toBe(0.92);
      expect(results[0]!.trust.reputation).toBe(0.95);
      expect(results[0]!.trust.stake).toBe(0.88);
      expect(results[0]!.trust.endorsement).toBe(0.80);

      // Agent 2: should fall back to card.agoramesh.trust_score
      expect(results[1]!.trust.overall).toBe(0.7);
      expect(results[1]!.trust.reputation).toBe(0.8);
      expect(results[1]!.trust.stake).toBe(0);
      expect(results[1]!.trust.endorsement).toBe(0);
    });

    it('should throw error on API failure', async () => {
      discovery.setNodeUrl('https://node.example.com');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        text: async () => 'Internal Server Error',
      });

      await expect(discovery.search('translate')).rejects.toThrow(
        'Discovery search failed: Internal Server Error'
      );
    });
  });

  // ===========================================================================
  // searchByTags Tests
  // ===========================================================================

  describe('searchByTags()', () => {
    it('should search by tags using keyword endpoint', async () => {
      discovery.setNodeUrl('https://node.example.com');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await discovery.searchByTags(['nlp', 'translation']);

      const call = (global.fetch as Mock).mock.calls[0]!;
      const url = new URL(call[0] as string);

      expect(url.pathname).toBe('/agents');
      expect(url.searchParams.get('q')).toBe('nlp,translation');
    });
  });

  // ===========================================================================
  // getCapabilityCard Tests
  // ===========================================================================

  describe('getCapabilityCard()', () => {
    it('should fetch from well-known URL for did:web', async () => {
      const card = sampleCapabilityCard('did:web:agent.example.com');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => card,
      });

      const result = await discovery.getCapabilityCard('did:web:agent.example.com');

      expect(result).toEqual(card);
      expect((global.fetch as Mock).mock.calls[0]![0]).toBe(
        'https://agent.example.com/.well-known/agent.json'
      );
    });

    it('should return null for DID mismatch from well-known', async () => {
      const card = sampleCapabilityCard('did:web:other.example.com');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => card,
      });

      const result = await discovery.getCapabilityCard('did:web:agent.example.com');

      expect(result).toBeNull();
    });

    it('should try DHT if well-known fails', async () => {
      discovery.setNodeUrl('https://node.example.com');
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      // Well-known fails (not a did:web)
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => card,
      });

      const result = await discovery.getCapabilityCard('did:agoramesh:base:agent1');

      expect(result).toBeDefined();
    });

    it('should try IPFS if DHT fails', async () => {
      discovery.setNodeUrl('https://node.example.com');
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      // Mock getAgent to return agent with CID
      (client.getAgent as Mock).mockResolvedValueOnce({
        did: 'did:agoramesh:base:agent1',
        capabilityCardCID: 'QmTest123',
      });

      // Mock fetch responses:
      // - well-known is skipped for did:agoramesh:* (regex doesn't match, no fetch)
      // - DHT fetch fails
      // - IPFS gateway fetch succeeds
      (global.fetch as Mock)
        .mockResolvedValueOnce({ ok: false }) // DHT fails
        .mockResolvedValueOnce({ ok: true, json: async () => card }); // IPFS works

      const result = await discovery.getCapabilityCard('did:agoramesh:base:agent1');

      expect(result).toEqual(card);
    });

    it('should return null if all sources fail', async () => {
      discovery.setNodeUrl('https://node.example.com');

      (client.getAgent as Mock).mockResolvedValueOnce(null);
      (global.fetch as Mock)
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      const result = await discovery.getCapabilityCard('did:agoramesh:base:unknown');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // announce Tests
  // ===========================================================================

  describe('announce()', () => {
    it('should throw error when node URL not configured', async () => {
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');
      await expect(discovery.announce(card)).rejects.toThrow('Node URL not configured');
    });

    it('should POST capability card to agents endpoint', async () => {
      discovery.setNodeUrl('https://node.example.com');
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      (global.fetch as Mock).mockResolvedValueOnce({ ok: true });

      await discovery.announce(card);

      const call = (global.fetch as Mock).mock.calls[0]!;
      expect(call[0]).toBe('https://node.example.com/agents');
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(card);
    });

    it('should include admin token in Authorization header', async () => {
      discovery.setNodeUrl('https://node.example.com');
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      (global.fetch as Mock).mockResolvedValueOnce({ ok: true });

      await discovery.announce(card, 'my-secret-token');

      const call = (global.fetch as Mock).mock.calls[0]!;
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my-secret-token');
    });
  });

  // ===========================================================================
  // unannounce Tests
  // ===========================================================================

  describe('unannounce()', () => {
    it('should throw not yet supported error', async () => {
      discovery.setNodeUrl('https://node.example.com');

      await expect(
        discovery.unannounce('did:agoramesh:base:agent1')
      ).rejects.toThrow('not yet supported');
    });
  });

  // ===========================================================================
  // Utility Function Tests
  // ===========================================================================

  describe('rankResults()', () => {
    it('should rank by value (trust / price)', () => {
      const results: DiscoveryResult[] = [
        {
          ...sampleDiscoveryResult('did:1'),
          trust: { overall: 0.8, reputation: 0.8, stake: 0.8, endorsement: 0.8 },
          pricing: { model: 'per_unit', currency: 'USDC', amount: '0.10', unit: 'token' },
        },
        {
          ...sampleDiscoveryResult('did:2'),
          trust: { overall: 0.9, reputation: 0.9, stake: 0.9, endorsement: 0.9 },
          pricing: { model: 'per_unit', currency: 'USDC', amount: '0.05', unit: 'token' },
        },
        {
          ...sampleDiscoveryResult('did:3'),
          trust: { overall: 0.7, reputation: 0.7, stake: 0.7, endorsement: 0.7 },
          pricing: { model: 'per_unit', currency: 'USDC', amount: '0.02', unit: 'token' },
        },
      ];

      const ranked = discovery.rankResults(results);

      // did:3 has best value (0.7 / 0.02 = 35)
      // did:2 has second (0.9 / 0.05 = 18)
      // did:1 has worst (0.8 / 0.10 = 8)
      expect(ranked[0]!.did).toBe('did:3');
      expect(ranked[1]!.did).toBe('did:2');
      expect(ranked[2]!.did).toBe('did:1');
    });
  });

  describe('filterBySkills()', () => {
    it('should filter to agents with all required skills', () => {
      const results: DiscoveryResult[] = [
        {
          ...sampleDiscoveryResult('did:1'),
          matchingSkills: [
            { id: 'translate', name: 'Translate', description: '', tags: [], pricing: undefined },
            { id: 'summarize', name: 'Summarize', description: '', tags: [], pricing: undefined },
          ],
        },
        {
          ...sampleDiscoveryResult('did:2'),
          matchingSkills: [
            { id: 'translate', name: 'Translate', description: '', tags: [], pricing: undefined },
          ],
        },
        {
          ...sampleDiscoveryResult('did:3'),
          matchingSkills: [
            { id: 'translate', name: 'Translate', description: '', tags: [], pricing: undefined },
            { id: 'summarize', name: 'Summarize', description: '', tags: [], pricing: undefined },
            { id: 'analyze', name: 'Analyze', description: '', tags: [], pricing: undefined },
          ],
        },
      ];

      const filtered = discovery.filterBySkills(results, ['translate', 'summarize']);

      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.did)).toContain('did:1');
      expect(filtered.map((r) => r.did)).toContain('did:3');
      expect(filtered.map((r) => r.did)).not.toContain('did:2');
    });
  });

  describe('isAgentAvailable()', () => {
    it('should return true if agent responds to OPTIONS', async () => {
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      (global.fetch as Mock).mockResolvedValueOnce({ ok: true });

      const available = await discovery.isAgentAvailable(card);

      expect(available).toBe(true);
    });

    it('should return false if agent is not reachable', async () => {
      const card = sampleCapabilityCard('did:agoramesh:base:agent1');

      (global.fetch as Mock).mockRejectedValueOnce(new Error('Network error'));

      const available = await discovery.isAgentAvailable(card);

      expect(available).toBe(false);
    });
  });
});
