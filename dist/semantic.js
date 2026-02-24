/**
 * AgoraMesh Semantic Search
 *
 * Provides client-side semantic search capabilities using vector embeddings.
 * Supports multiple embedding providers for flexible integration.
 *
 * @packageDocumentation
 */
// =============================================================================
// SemanticSearchClient
// =============================================================================
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
export class SemanticSearchClient {
    embed;
    minSimilarity;
    index = new Map();
    /**
     * Create a new SemanticSearchClient.
     *
     * @param config - Configuration options
     */
    constructor(config) {
        this.embed = config.embed;
        this.minSimilarity = config.minSimilarity ?? 0.5;
        // Weight parameters reserved for future weighted similarity
    }
    // ===========================================================================
    // Indexing
    // ===========================================================================
    /**
     * Index capability cards for semantic search.
     *
     * @param cards - Cards to index
     */
    async indexCards(cards) {
        const entries = cards.map((card) => ({
            id: card.id,
            text: this.cardToText(card),
            item: card,
        }));
        await this.indexEntries(entries);
    }
    /**
     * Index discovery results for semantic search.
     *
     * @param results - Results to index
     */
    async indexResults(results) {
        const entries = results.map((result) => ({
            id: result.did,
            text: this.resultToText(result),
            item: result,
        }));
        await this.indexEntries(entries);
    }
    /**
     * Add a single card to the index.
     *
     * @param card - Card to add
     */
    async addCard(card) {
        const text = this.cardToText(card);
        const [embedding] = await this.embed([text]);
        this.index.set(card.id, {
            id: card.id,
            text,
            embedding,
            item: card,
        });
    }
    /**
     * Remove a card from the index.
     *
     * @param id - Card ID to remove
     */
    removeCard(id) {
        this.index.delete(id);
    }
    /**
     * Clear the entire index.
     */
    clearIndex() {
        this.index.clear();
    }
    /**
     * Get the number of indexed items.
     */
    getIndexSize() {
        return this.index.size;
    }
    // ===========================================================================
    // Search
    // ===========================================================================
    /**
     * Search the index using semantic similarity.
     *
     * @param query - Natural language search query
     * @param limit - Maximum results to return
     * @returns Ranked results with similarity scores
     */
    async search(query, limit = 20) {
        if (this.index.size === 0) {
            return [];
        }
        // Generate query embedding
        const embeddings = await this.embed([query]);
        const queryEmbedding = embeddings[0];
        if (!queryEmbedding) {
            throw new Error('Failed to generate query embedding');
        }
        // Calculate similarities
        const results = [];
        for (const entry of this.index.values()) {
            if (!entry.embedding)
                continue;
            const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
            if (similarity >= this.minSimilarity) {
                results.push({
                    item: entry.item,
                    similarity,
                });
            }
        }
        // Sort by similarity (highest first)
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }
    /**
     * Re-rank discovery results using semantic similarity.
     *
     * @param query - The original search query
     * @param results - Results from the discovery API
     * @returns Re-ranked results with similarity scores
     */
    async rerank(query, results) {
        if (results.length === 0) {
            return [];
        }
        // Generate embeddings for query and all result texts
        const texts = [query, ...results.map((r) => this.resultToText(r))];
        const embeddings = await this.embed(texts);
        const queryEmbedding = embeddings[0];
        if (!queryEmbedding) {
            throw new Error('Failed to generate query embedding');
        }
        // Calculate similarities and sort
        const ranked = results.map((result, i) => {
            const resultEmbedding = embeddings[i + 1];
            if (!resultEmbedding) {
                return { item: result, similarity: 0 };
            }
            const similarity = this.cosineSimilarity(queryEmbedding, resultEmbedding);
            return { item: result, similarity };
        });
        ranked.sort((a, b) => b.similarity - a.similarity);
        return ranked;
    }
    /**
     * Find similar cards to a given card.
     *
     * @param cardId - ID of the reference card
     * @param limit - Maximum results to return
     * @returns Similar cards with similarity scores
     */
    findSimilar(cardId, limit = 10) {
        const entry = this.index.get(cardId);
        if (!entry || !entry.embedding) {
            return [];
        }
        const results = [];
        for (const [id, other] of this.index.entries()) {
            if (id === cardId || !other.embedding)
                continue;
            const similarity = this.cosineSimilarity(entry.embedding, other.embedding);
            if (similarity >= this.minSimilarity) {
                results.push({
                    item: other.item,
                    similarity,
                });
            }
        }
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }
    // ===========================================================================
    // Utilities
    // ===========================================================================
    /**
     * Compute similarity between a query and a capability card.
     *
     * @param query - Search query
     * @param card - Capability card
     * @returns Similarity score (0-1)
     */
    async computeSimilarity(query, card) {
        const text = this.cardToText(card);
        const embeddings = await this.embed([query, text]);
        const queryEmbedding = embeddings[0];
        const cardEmbedding = embeddings[1];
        if (!queryEmbedding || !cardEmbedding) {
            throw new Error('Failed to generate embeddings');
        }
        return this.cosineSimilarity(queryEmbedding, cardEmbedding);
    }
    /**
     * Extract keywords from a query for hybrid search.
     *
     * @param query - Search query
     * @returns Extracted keywords
     */
    extractKeywords(query) {
        // Simple keyword extraction (stopword removal)
        const stopwords = new Set([
            'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
            'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we',
            'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
            'their', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
        ]);
        return query
            .toLowerCase()
            .split(/\W+/)
            .filter((word) => word.length > 2 && !stopwords.has(word));
    }
    // ===========================================================================
    // Private Methods
    // ===========================================================================
    /**
     * Index entries with embeddings.
     */
    async indexEntries(entries) {
        if (entries.length === 0)
            return;
        // Generate all embeddings in batch
        const texts = entries.map((e) => e.text);
        const embeddings = await this.embed(texts);
        // Store in index
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const embedding = embeddings[i];
            if (entry && embedding) {
                entry.embedding = embedding;
                this.index.set(entry.id, entry);
            }
        }
    }
    /**
     * Convert a capability card to searchable text.
     */
    cardToText(card) {
        const parts = [
            card.name,
            card.description,
            ...card.skills.map((s) => this.skillToText(s)),
        ];
        return parts.join(' ');
    }
    /**
     * Convert a discovery result to searchable text.
     */
    resultToText(result) {
        const parts = [
            result.name,
            result.description,
            ...result.matchingSkills.map((s) => this.skillToText(s)),
        ];
        return parts.join(' ');
    }
    /**
     * Convert a skill to searchable text.
     */
    skillToText(skill) {
        const parts = [skill.name, skill.description];
        if (skill.tags) {
            parts.push(...skill.tags);
        }
        return parts.join(' ');
    }
    /**
     * Calculate cosine similarity between two embeddings.
     */
    cosineSimilarity(a, b) {
        if (a.length !== b.length) {
            throw new Error('Embedding dimensions must match');
        }
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            const aVal = a[i] ?? 0;
            const bVal = b[i] ?? 0;
            dotProduct += aVal * bVal;
            normA += aVal * aVal;
            normB += bVal * bVal;
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
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
export function createOpenAIEmbedder(options) {
    const { apiKey, model = 'text-embedding-3-small', baseUrl = 'https://api.openai.com/v1' } = options;
    return async (texts) => {
        const response = await fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                input: texts,
            }),
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI embedding failed: ${error}`);
        }
        const data = (await response.json());
        // Sort by index to maintain order
        const sorted = data.data.sort((a, b) => a.index - b.index);
        return sorted.map((d) => d.embedding);
    };
}
/**
 * Create an embedding function using Cohere.
 *
 * @param options - Cohere options
 * @returns Embedding function
 */
export function createCohereEmbedder(options) {
    const { apiKey, model = 'embed-english-v3.0', inputType = 'search_document' } = options;
    return async (texts) => {
        const response = await fetch('https://api.cohere.ai/v1/embed', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                texts,
                input_type: inputType,
            }),
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Cohere embedding failed: ${error}`);
        }
        const data = (await response.json());
        return data.embeddings;
    };
}
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
export function createSimpleEmbedder(dimension = 384) {
    // Simple hash-based pseudo-embedding for testing
    return async (texts) => {
        return texts.map((text) => {
            const words = text.toLowerCase().split(/\W+/).filter(Boolean);
            const embedding = new Array(dimension).fill(0);
            for (const word of words) {
                // Use word hash to determine which dimensions to activate
                let hash = 0;
                for (let i = 0; i < word.length; i++) {
                    hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
                }
                // Activate several dimensions based on hash
                for (let i = 0; i < 8; i++) {
                    const idx = Math.abs((hash + i * 7919) % dimension);
                    embedding[idx] += 1 / Math.sqrt(words.length);
                }
            }
            // Normalize
            const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
            if (norm > 0) {
                for (let i = 0; i < dimension; i++) {
                    embedding[i] /= norm;
                }
            }
            return embedding;
        });
    };
}
//# sourceMappingURL=semantic.js.map