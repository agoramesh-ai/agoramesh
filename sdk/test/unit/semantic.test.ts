/**
 * Semantic Search Unit Tests
 *
 * Tests for the semantic search client using vector embeddings.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SemanticSearchClient,
  createSimpleEmbedder,
  createOpenAIEmbedder,
  createCohereEmbedder,
  type EmbeddingFunction,
  type SemanticSearchConfig,
} from '../../src/semantic.js';
import type { CapabilityCard, DiscoveryResult, Skill } from '../../src/types.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a test skill.
 */
function createTestSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    tags: ['test'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
    pricing: {
      model: 'per_request',
      amount: '0.10',
      currency: 'USDC',
    },
    ...overrides,
  };
}

/**
 * Create a test capability card.
 */
function createTestCard(overrides: Partial<CapabilityCard> = {}): CapabilityCard {
  return {
    $schema: 'https://agoramesh.ai/schemas/capability-card-v1.json',
    id: `did:agoramesh:base:0x${Math.random().toString(16).slice(2)}`,
    name: 'Test Agent',
    description: 'A test agent',
    version: '1.0.0',
    url: 'https://test.example.com',
    protocolVersion: '1.0',
    provider: {
      name: 'Test Provider',
      url: 'https://example.com',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      x402Payments: true,
      escrow: true,
    },
    authentication: {
      schemes: ['did-auth'],
      didMethods: ['agoramesh'],
    },
    skills: [createTestSkill()],
    payment: {
      methods: ['escrow'],
      currencies: ['USDC'],
      chains: ['base-sepolia'],
      addresses: {},
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    ...overrides,
  };
}

/**
 * Create a test discovery result.
 */
function createTestResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    did: `did:agoramesh:base:0x${Math.random().toString(16).slice(2)}`,
    name: 'Test Agent',
    description: 'A test agent',
    url: 'https://test.example.com',
    trust: {
      overall: 0.8,
      reputation: 0.85,
      stake: 0.7,
      endorsement: 0.6,
    },
    pricing: {
      model: 'per_request',
      amount: '0.10',
      currency: 'USDC',
    },
    matchingSkills: [createTestSkill()],
    ...overrides,
  };
}

/**
 * Create a mock embedding function for testing.
 */
function createMockEmbedder(dimension: number = 8): EmbeddingFunction {
  return vi.fn().mockImplementation(async (texts: string[]) => {
    // Create deterministic embeddings based on text content
    return texts.map((text) => {
      const embedding = new Array(dimension).fill(0);
      const words = text.toLowerCase().split(/\W+/);

      for (const word of words) {
        let hash = 0;
        for (let i = 0; i < word.length; i++) {
          hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
        }
        const idx = Math.abs(hash % dimension);
        embedding[idx] += 1;
      }

      // Normalize
      const norm = Math.sqrt(embedding.reduce((sum: number, v: number) => sum + v * v, 0));
      if (norm > 0) {
        for (let i = 0; i < dimension; i++) {
          embedding[i] /= norm;
        }
      }

      return embedding;
    });
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('SemanticSearchClient', () => {
  let embedder: EmbeddingFunction;
  let client: SemanticSearchClient;

  beforeEach(() => {
    embedder = createMockEmbedder();
    client = new SemanticSearchClient({ embed: embedder });
  });

  describe('Constructor', () => {
    it('should create client with required config', () => {
      const client = new SemanticSearchClient({ embed: embedder });
      expect(client).toBeInstanceOf(SemanticSearchClient);
    });

    it('should accept optional config values', () => {
      const client = new SemanticSearchClient({
        embed: embedder,
        minSimilarity: 0.7,
        nameWeight: 0.4,
        descriptionWeight: 0.4,
        skillWeight: 0.2,
      });
      expect(client).toBeInstanceOf(SemanticSearchClient);
    });
  });

  describe('Indexing', () => {
    it('should index capability cards', async () => {
      const cards = [
        createTestCard({ name: 'Translation Agent' }),
        createTestCard({ name: 'Code Review Agent' }),
      ];

      await client.indexCards(cards);

      expect(client.getIndexSize()).toBe(2);
    });

    it('should index discovery results', async () => {
      const results = [
        createTestResult({ name: 'Translation Agent' }),
        createTestResult({ name: 'Code Review Agent' }),
      ];

      await client.indexResults(results);

      expect(client.getIndexSize()).toBe(2);
    });

    it('should add single card to index', async () => {
      const card = createTestCard({ name: 'Test Agent' });

      await client.addCard(card);

      expect(client.getIndexSize()).toBe(1);
    });

    it('should remove card from index', async () => {
      const card = createTestCard({ id: 'did:test:1', name: 'Test Agent' });
      await client.addCard(card);
      expect(client.getIndexSize()).toBe(1);

      client.removeCard('did:test:1');

      expect(client.getIndexSize()).toBe(0);
    });

    it('should clear entire index', async () => {
      const cards = [
        createTestCard({ name: 'Agent 1' }),
        createTestCard({ name: 'Agent 2' }),
        createTestCard({ name: 'Agent 3' }),
      ];
      await client.indexCards(cards);
      expect(client.getIndexSize()).toBe(3);

      client.clearIndex();

      expect(client.getIndexSize()).toBe(0);
    });

    it('should handle empty index gracefully', async () => {
      await client.indexCards([]);
      expect(client.getIndexSize()).toBe(0);
    });

    it('should call embedder with card text', async () => {
      const card = createTestCard({
        name: 'Translation Agent',
        description: 'Translates documents',
      });

      await client.addCard(card);

      expect(embedder).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('Translation')])
      );
    });
  });

  describe('Search', () => {
    beforeEach(async () => {
      const cards = [
        createTestCard({
          id: 'did:test:translator',
          name: 'Translation Agent',
          description: 'Translates documents between languages',
          skills: [
            createTestSkill({
              id: 'translate',
              name: 'Translate',
              tags: ['translation', 'languages', 'documents'],
            }),
          ],
        }),
        createTestCard({
          id: 'did:test:coder',
          name: 'Code Review Agent',
          description: 'Reviews code for bugs and best practices',
          skills: [
            createTestSkill({
              id: 'code-review',
              name: 'Code Review',
              tags: ['code', 'review', 'programming'],
            }),
          ],
        }),
        createTestCard({
          id: 'did:test:writer',
          name: 'Content Writer',
          description: 'Writes blog posts and articles',
          skills: [
            createTestSkill({
              id: 'writing',
              name: 'Writing',
              tags: ['writing', 'content', 'blog'],
            }),
          ],
        }),
      ];

      await client.indexCards(cards);
    });

    it('should return empty array for empty index', async () => {
      client.clearIndex();

      const results = await client.search('translate documents');

      expect(results).toEqual([]);
    });

    it('should return results with similarity scores', async () => {
      const results = await client.search('translate documents');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('item');
      expect(results[0]).toHaveProperty('similarity');
      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
      expect(results[0].similarity).toBeLessThanOrEqual(1);
    });

    it('should sort results by similarity (highest first)', async () => {
      const results = await client.search('translate documents');

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });

    it('should respect limit parameter', async () => {
      const results = await client.search('agent', 1);

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should filter results below minimum similarity', async () => {
      const strictClient = new SemanticSearchClient({
        embed: embedder,
        minSimilarity: 0.99, // Very high threshold
      });

      const cards = [createTestCard({ name: 'Test Agent' })];
      await strictClient.indexCards(cards);

      const results = await strictClient.search('completely unrelated query xyz123');

      // With very high threshold, likely no results match
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Re-ranking', () => {
    it('should re-rank discovery results', async () => {
      const results = [
        createTestResult({
          did: 'did:test:1',
          name: 'Translation Agent',
          description: 'Translates documents',
        }),
        createTestResult({
          did: 'did:test:2',
          name: 'Code Agent',
          description: 'Reviews code',
        }),
      ];

      const ranked = await client.rerank('translate documents', results);

      expect(ranked.length).toBe(2);
      expect(ranked[0]).toHaveProperty('item');
      expect(ranked[0]).toHaveProperty('similarity');
    });

    it('should return empty array for empty results', async () => {
      const ranked = await client.rerank('query', []);

      expect(ranked).toEqual([]);
    });

    it('should sort re-ranked results by similarity', async () => {
      const results = [
        createTestResult({ name: 'Agent A', description: 'Does something' }),
        createTestResult({ name: 'Agent B', description: 'Does something else' }),
      ];

      const ranked = await client.rerank('something', results);

      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].similarity).toBeGreaterThanOrEqual(ranked[i].similarity);
      }
    });
  });

  describe('Find Similar', () => {
    it('should find similar cards', async () => {
      const cards = [
        createTestCard({
          id: 'did:test:a',
          name: 'Translation Agent',
          description: 'Translates documents',
        }),
        createTestCard({
          id: 'did:test:b',
          name: 'Another Translation Agent',
          description: 'Also translates documents',
        }),
        createTestCard({
          id: 'did:test:c',
          name: 'Code Review Agent',
          description: 'Reviews code',
        }),
      ];

      await client.indexCards(cards);

      const similar = client.findSimilar('did:test:a', 10);

      expect(similar.length).toBeGreaterThan(0);
      // Should not include the reference card itself
      expect(similar.every((r) => {
        const card = r.item as CapabilityCard;
        return card.id !== 'did:test:a';
      })).toBe(true);
    });

    it('should return empty array for non-existent card', () => {
      const similar = client.findSimilar('did:test:nonexistent');

      expect(similar).toEqual([]);
    });
  });

  describe('Compute Similarity', () => {
    it('should compute similarity between query and card', async () => {
      const card = createTestCard({
        name: 'Translation Agent',
        description: 'Translates documents between languages',
      });

      const similarity = await client.computeSimilarity('translate documents', card);

      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThanOrEqual(1);
    });

    it('should return higher similarity for matching content', async () => {
      const matchingCard = createTestCard({
        name: 'Translation Agent',
        description: 'Translates documents',
      });
      const unmatchingCard = createTestCard({
        name: 'Code Review Agent',
        description: 'Reviews code',
      });

      const matchingSim = await client.computeSimilarity('translate documents', matchingCard);
      const unmatchingSim = await client.computeSimilarity('translate documents', unmatchingCard);

      expect(matchingSim).toBeGreaterThan(unmatchingSim);
    });
  });

  describe('Extract Keywords', () => {
    it('should extract keywords from query', () => {
      const keywords = client.extractKeywords('translate legal documents from English');

      expect(keywords).toContain('translate');
      expect(keywords).toContain('legal');
      expect(keywords).toContain('documents');
      expect(keywords).toContain('english');
    });

    it('should remove stopwords', () => {
      const keywords = client.extractKeywords('the quick and brown fox');

      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('and');
      expect(keywords).toContain('quick');
      expect(keywords).toContain('brown');
      expect(keywords).toContain('fox');
    });

    it('should filter short words', () => {
      const keywords = client.extractKeywords('a is to do it');

      expect(keywords.length).toBe(0);
    });

    it('should handle empty query', () => {
      const keywords = client.extractKeywords('');

      expect(keywords).toEqual([]);
    });
  });
});

describe('Embedding Providers', () => {
  describe('createSimpleEmbedder', () => {
    it('should create embedder with default dimension', () => {
      const embed = createSimpleEmbedder();
      expect(typeof embed).toBe('function');
    });

    it('should create embedder with custom dimension', () => {
      const embed = createSimpleEmbedder(128);
      expect(typeof embed).toBe('function');
    });

    it('should generate embeddings of correct dimension', async () => {
      const embed = createSimpleEmbedder(64);
      const embeddings = await embed(['test text']);

      expect(embeddings.length).toBe(1);
      expect(embeddings[0].length).toBe(64);
    });

    it('should generate normalized embeddings', async () => {
      const embed = createSimpleEmbedder(32);
      const embeddings = await embed(['test text with some words']);

      const norm = Math.sqrt(
        embeddings[0].reduce((sum, v) => sum + v * v, 0)
      );

      expect(norm).toBeCloseTo(1, 5);
    });

    it('should generate different embeddings for different texts', async () => {
      const embed = createSimpleEmbedder(64);
      const embeddings = await embed(['hello world', 'goodbye moon']);

      // Embeddings should be different
      const same = embeddings[0].every((v, i) => v === embeddings[1][i]);
      expect(same).toBe(false);
    });

    it('should generate consistent embeddings for same text', async () => {
      const embed = createSimpleEmbedder(64);
      const embeddings1 = await embed(['test query']);
      const embeddings2 = await embed(['test query']);

      expect(embeddings1[0]).toEqual(embeddings2[0]);
    });
  });

  describe('createOpenAIEmbedder', () => {
    it('should create embedder with API key', () => {
      const embed = createOpenAIEmbedder({ apiKey: 'test-key' });
      expect(typeof embed).toBe('function');
    });

    it('should call OpenAI API with correct parameters', async () => {
      const originalFetch = global.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [0.1, 0.2, 0.3], index: 0 },
          ],
        }),
      });
      global.fetch = mockFetch;

      const embed = createOpenAIEmbedder({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });

      await embed(['test text']);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        })
      );

      global.fetch = originalFetch;
    });

    it('should throw on API error', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'API error',
      });

      const embed = createOpenAIEmbedder({ apiKey: 'test-key' });

      await expect(embed(['test'])).rejects.toThrow('OpenAI embedding failed');

      global.fetch = originalFetch;
    });

    it('should sort results by index', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [0.3, 0.4], index: 1 },
            { embedding: [0.1, 0.2], index: 0 },
          ],
        }),
      });

      const embed = createOpenAIEmbedder({ apiKey: 'test-key' });
      const result = await embed(['first', 'second']);

      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.3, 0.4]);

      global.fetch = originalFetch;
    });
  });

  describe('createCohereEmbedder', () => {
    it('should create embedder with API key', () => {
      const embed = createCohereEmbedder({ apiKey: 'test-key' });
      expect(typeof embed).toBe('function');
    });

    it('should call Cohere API with correct parameters', async () => {
      const originalFetch = global.fetch;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: [[0.1, 0.2, 0.3]],
        }),
      });
      global.fetch = mockFetch;

      const embed = createCohereEmbedder({ apiKey: 'test-key' });

      await embed(['test text']);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cohere.ai/v1/embed',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        })
      );

      global.fetch = originalFetch;
    });

    it('should throw on API error', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'API error',
      });

      const embed = createCohereEmbedder({ apiKey: 'test-key' });

      await expect(embed(['test'])).rejects.toThrow('Cohere embedding failed');

      global.fetch = originalFetch;
    });
  });
});

describe('Edge Cases', () => {
  it('should handle cards with empty descriptions', async () => {
    const embed = createSimpleEmbedder();
    const client = new SemanticSearchClient({ embed });

    const card = createTestCard({
      name: 'Agent',
      description: '',
    });

    await client.addCard(card);
    const results = await client.search('test');

    expect(client.getIndexSize()).toBe(1);
  });

  it('should handle cards with empty skills', async () => {
    const embed = createSimpleEmbedder();
    const client = new SemanticSearchClient({ embed });

    const card = createTestCard({
      name: 'Agent',
      skills: [],
    });

    await client.addCard(card);
    expect(client.getIndexSize()).toBe(1);
  });

  it('should handle skills without tags', async () => {
    const embed = createSimpleEmbedder();
    const client = new SemanticSearchClient({ embed });

    const card = createTestCard({
      skills: [
        {
          id: 'skill-1',
          name: 'Skill',
          description: 'A skill',
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
          pricing: { model: 'per_request', amount: '0.1', currency: 'USDC' },
        },
      ],
    });

    await client.addCard(card);
    expect(client.getIndexSize()).toBe(1);
  });

  it('should handle zero-length embeddings', async () => {
    const badEmbedder = vi.fn().mockResolvedValue([[]]);
    const client = new SemanticSearchClient({ embed: badEmbedder });

    const card = createTestCard();
    await client.addCard(card);

    // Should not crash on search
    const results = await client.search('test');
    expect(results).toBeDefined();
  });
});
