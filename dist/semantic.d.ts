/**
 * AgoraMesh Semantic Search
 *
 * Provides client-side semantic search capabilities using vector embeddings.
 * Supports multiple embedding providers for flexible integration.
 *
 * @packageDocumentation
 */
import type { CapabilityCard, DiscoveryResult } from './types.js';
/**
 * A vector embedding (array of numbers).
 */
export type Embedding = number[];
/**
 * Function that generates embeddings from text.
 */
export type EmbeddingFunction = (texts: string[]) => Promise<Embedding[]>;
/**
 * Configuration for the semantic search client.
 */
export interface SemanticSearchConfig {
    /**
     * Function to generate embeddings.
     * Can be OpenAI, Cohere, local model, etc.
     */
    embed: EmbeddingFunction;
    /**
     * Minimum similarity threshold (0-1).
     * Results below this threshold are filtered out.
     * @default 0.5
     */
    minSimilarity?: number;
    /**
     * Weight for name matching in combined score.
     * @default 0.3
     */
    nameWeight?: number;
    /**
     * Weight for description matching in combined score.
     * @default 0.5
     */
    descriptionWeight?: number;
    /**
     * Weight for skill matching in combined score.
     * @default 0.2
     */
    skillWeight?: number;
}
/**
 * A search result with similarity score.
 */
export interface SemanticSearchResult<T> {
    /** The matched item */
    item: T;
    /** Similarity score (0-1) */
    similarity: number;
    /** Component scores for debugging */
    components?: {
        name: number;
        description: number;
        skills: number;
    };
}
/**
 * Client for semantic search over capability cards and discovery results.
 *
 * Enables client-side re-ranking of discovery results using vector similarity.
 * Can also be used to search a local collection of capability cards.
 *
 * @example
 * ```typescript
 * import { SemanticSearchClient, createOpenAIEmbedder } from '@agoramesh/sdk';
 *
 * // Create client with OpenAI embeddings
 * const semantic = new SemanticSearchClient({
 *   embed: createOpenAIEmbedder({ apiKey: 'sk-...' }),
 * });
 *
 * // Index some capability cards
 * await semantic.indexCards(cards);
 *
 * // Search
 * const results = await semantic.search('translate legal documents from English to Spanish');
 * ```
 */
export declare class SemanticSearchClient {
    private readonly embed;
    private readonly minSimilarity;
    private index;
    /**
     * Create a new SemanticSearchClient.
     *
     * @param config - Configuration options
     */
    constructor(config: SemanticSearchConfig);
    /**
     * Index capability cards for semantic search.
     *
     * @param cards - Cards to index
     */
    indexCards(cards: CapabilityCard[]): Promise<void>;
    /**
     * Index discovery results for semantic search.
     *
     * @param results - Results to index
     */
    indexResults(results: DiscoveryResult[]): Promise<void>;
    /**
     * Add a single card to the index.
     *
     * @param card - Card to add
     */
    addCard(card: CapabilityCard): Promise<void>;
    /**
     * Remove a card from the index.
     *
     * @param id - Card ID to remove
     */
    removeCard(id: string): void;
    /**
     * Clear the entire index.
     */
    clearIndex(): void;
    /**
     * Get the number of indexed items.
     */
    getIndexSize(): number;
    /**
     * Search the index using semantic similarity.
     *
     * @param query - Natural language search query
     * @param limit - Maximum results to return
     * @returns Ranked results with similarity scores
     */
    search(query: string, limit?: number): Promise<SemanticSearchResult<CapabilityCard | DiscoveryResult>[]>;
    /**
     * Re-rank discovery results using semantic similarity.
     *
     * @param query - The original search query
     * @param results - Results from the discovery API
     * @returns Re-ranked results with similarity scores
     */
    rerank(query: string, results: DiscoveryResult[]): Promise<SemanticSearchResult<DiscoveryResult>[]>;
    /**
     * Find similar cards to a given card.
     *
     * @param cardId - ID of the reference card
     * @param limit - Maximum results to return
     * @returns Similar cards with similarity scores
     */
    findSimilar(cardId: string, limit?: number): SemanticSearchResult<CapabilityCard | DiscoveryResult>[];
    /**
     * Compute similarity between a query and a capability card.
     *
     * @param query - Search query
     * @param card - Capability card
     * @returns Similarity score (0-1)
     */
    computeSimilarity(query: string, card: CapabilityCard): Promise<number>;
    /**
     * Extract keywords from a query for hybrid search.
     *
     * @param query - Search query
     * @returns Extracted keywords
     */
    extractKeywords(query: string): string[];
    /**
     * Index entries with embeddings.
     */
    private indexEntries;
    /**
     * Convert a capability card to searchable text.
     */
    private cardToText;
    /**
     * Convert a discovery result to searchable text.
     */
    private resultToText;
    /**
     * Convert a skill to searchable text.
     */
    private skillToText;
    /**
     * Calculate cosine similarity between two embeddings.
     */
    private cosineSimilarity;
}
/**
 * Options for OpenAI embeddings.
 */
export interface OpenAIEmbedderOptions {
    /** OpenAI API key */
    apiKey: string;
    /** Model to use (default: text-embedding-3-small) */
    model?: string;
    /** Base URL for API (default: https://api.openai.com/v1) */
    baseUrl?: string;
}
/**
 * Create an embedding function using OpenAI.
 *
 * @param options - OpenAI options
 * @returns Embedding function
 *
 * @example
 * ```typescript
 * const embed = createOpenAIEmbedder({
 *   apiKey: 'sk-...',
 *   model: 'text-embedding-3-small',
 * });
 *
 * const semantic = new SemanticSearchClient({ embed });
 * ```
 */
export declare function createOpenAIEmbedder(options: OpenAIEmbedderOptions): EmbeddingFunction;
/**
 * Options for Cohere embeddings.
 */
export interface CohereEmbedderOptions {
    /** Cohere API key */
    apiKey: string;
    /** Model to use (default: embed-english-v3.0) */
    model?: string;
    /** Input type (default: search_query for queries, search_document for docs) */
    inputType?: 'search_query' | 'search_document';
}
/**
 * Create an embedding function using Cohere.
 *
 * @param options - Cohere options
 * @returns Embedding function
 */
export declare function createCohereEmbedder(options: CohereEmbedderOptions): EmbeddingFunction;
/**
 * Create a simple TF-IDF based embedder for testing/offline use.
 *
 * This is NOT suitable for production semantic search but useful for:
 * - Testing without API keys
 * - Offline environments
 * - Basic keyword matching
 *
 * @param dimension - Embedding dimension (default: 384)
 * @returns Embedding function
 */
export declare function createSimpleEmbedder(dimension?: number): EmbeddingFunction;
//# sourceMappingURL=semantic.d.ts.map