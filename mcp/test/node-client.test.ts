import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeClient, NodeClientError } from '../src/node-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NodeClient', () => {
  const NODE_URL = 'https://api.agoramesh.ai';
  let client: NodeClient;

  beforeEach(() => {
    client = new NodeClient(NODE_URL);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── searchAgents ──────────────────────────────────────────────

  describe('searchAgents', () => {
    it('searches agents with query string', async () => {
      const agents = [
        { did: 'did:agoramesh:base:abc', name: 'CodeReviewer', trust: { score: 0.85 } },
        { did: 'did:agoramesh:base:def', name: 'Translator', trust: { score: 0.72 } },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => agents,
      });

      const result = await client.searchAgents('code review');

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.origin).toBe(NODE_URL);
      expect(url.pathname).toBe('/agents/semantic');
      expect(url.searchParams.get('q')).toBe('code review');
      expect(result).toEqual(agents);
    });

    it('passes limit and minTrust params', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      await client.searchAgents('test', { limit: 5, minTrust: 0.5 });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('minTrust')).toBe('0.5');
    });

    it('lists all agents when no query provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      await client.searchAgents();

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.has('q')).toBe(false);
      expect(url.pathname).toBe('/agents/semantic');
    });

    it('returns empty array on empty response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      const result = await client.searchAgents('nonexistent');
      expect(result).toEqual([]);
    });

    it('handles non-array response gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ agents: [] }) });

      // Should not throw — should return empty array or the data
      const result = await client.searchAgents('test');
      expect(result).toBeDefined();
    });

    it('unwraps card envelope from search results', async () => {
      const envelope = [
        {
          did: 'did:agoramesh:base:abc',
          score: 0.87,
          card: { name: 'TestAgent', description: 'A test', capabilities: [], 'x-agoramesh': { did: 'did:agoramesh:base:abc' } },
          trust: { score: 0.75, reputation: 0.95 },
        },
      ];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => envelope });

      const result = await client.searchAgents('test');

      expect(result).toHaveLength(1);
      const agent = result[0] as Record<string, unknown>;
      // Card fields should be at top level
      expect(agent.name).toBe('TestAgent');
      expect(agent.description).toBe('A test');
      expect(agent['x-agoramesh']).toBeDefined();
      // DID and trust from envelope
      expect(agent.did).toBe('did:agoramesh:base:abc');
      expect(agent.trust).toEqual({ score: 0.75, reputation: 0.95 });
    });

    it('throws NodeClientError on 500', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(client.searchAgents('test')).rejects.toThrow(NodeClientError);
      await expect(client.searchAgents('test')).rejects.toThrow(/500/);
    });

    it('throws on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(client.searchAgents('test')).rejects.toThrow('fetch failed');
    });

    it('uses 5s timeout via AbortSignal', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

      await client.searchAgents('test');

      const options = mockFetch.mock.calls[0][1];
      expect(options.signal).toBeDefined();
    });
  });

  // ─── getAgent ──────────────────────────────────────────────────

  describe('getAgent', () => {
    it('returns agent card for valid DID', async () => {
      const agent = {
        did: 'did:agoramesh:base:abc123',
        name: 'CodeReviewer',
        description: 'Reviews code for quality',
        skills: [{ id: 'review', name: 'Code Review' }],
        trust: { score: 0.85, tier: 'verified' },
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => agent });

      const result = await client.getAgent('did:agoramesh:base:abc123');

      expect(result).toEqual(agent);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/agents/did:agoramesh:base:abc123');
    });

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const result = await client.getAgent('did:agoramesh:base:nonexistent');
      expect(result).toBeNull();
    });

    it('throws NodeClientError on 500', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      await expect(client.getAgent('did:agoramesh:base:abc')).rejects.toThrow(NodeClientError);
    });
  });

  // ─── getTrust ──────────────────────────────────────────────────

  describe('getTrust', () => {
    it('returns trust breakdown for valid DID', async () => {
      const trust = {
        score: 0.85,
        tier: 'verified',
        reputation: { successRate: 0.95, totalTasks: 42 },
        stake: { amount: '5000', currency: 'USDC' },
        endorsements: [
          { endorser: 'did:agoramesh:base:xyz', endorserTrust: 0.9 },
        ],
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => trust });

      const result = await client.getTrust('did:agoramesh:base:abc123');

      expect(result).toEqual(trust);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/trust/did:agoramesh:base:abc123');
    });

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const result = await client.getTrust('did:agoramesh:base:unknown');
      expect(result).toBeNull();
    });

    it('throws NodeClientError on 500', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      await expect(client.getTrust('did:agoramesh:base:abc')).rejects.toThrow(NodeClientError);
    });
  });
});
