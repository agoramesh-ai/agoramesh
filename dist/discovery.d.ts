/**
 * AgoraMesh Discovery Client
 *
 * Client for discovering agents in the AgoraMesh network.
 *
 * @packageDocumentation
 */
import type { CapabilityCard, SearchOptions, DiscoveryResult } from './types.js';
import type { AgoraMeshClient } from './client.js';
export declare class DiscoveryClient {
    private readonly client;
    private nodeUrl;
    private ipfsGateway;
    /**
     * Create a new DiscoveryClient.
     *
     * @param client - The AgoraMesh client instance
     * @param nodeUrl - Optional AgoraMesh node URL for P2P discovery
     */
    constructor(client: AgoraMeshClient, nodeUrl?: string);
    /**
     * Set the AgoraMesh node URL for P2P discovery.
     *
     * @param url - The node URL
     * @throws Error if the URL points to a private address
     */
    setNodeUrl(url: string): void;
    /**
     * Get the configured node URL.
     */
    getNodeUrl(): string | null;
    /**
     * Set the IPFS gateway URL for fetching capability cards.
     *
     * @param gateway - The IPFS gateway URL (e.g., 'https://ipfs.io/ipfs')
     * @throws Error if the gateway URL points to a private address
     */
    setIPFSGateway(gateway: string): void;
    /**
     * Get the configured IPFS gateway URL.
     */
    getIPFSGateway(): string;
    /**
     * Search for agents by capability using natural language.
     *
     * @param query - Natural language search query
     * @param options - Search options (filters, pagination)
     * @returns Array of matching agents
     *
     * @example
     * ```typescript
     * const results = await discovery.search('translate legal documents', {
     *   minTrust: 0.8,
     *   tags: ['legal', 'translation'],
     *   currency: 'USDC',
     *   limit: 10,
     * });
     * ```
     */
    search(query: string, options?: SearchOptions): Promise<DiscoveryResult[]>;
    /**
     * Search for agents by specific tags/capabilities.
     *
     * @param tags - Array of capability tags to search for
     * @param options - Additional search options
     * @returns Array of matching agents
     */
    searchByTags(tags: string[], options?: Omit<SearchOptions, 'tags'>): Promise<DiscoveryResult[]>;
    /**
     * Fetch an agent's capability card.
     *
     * Attempts to fetch from:
     * 1. Well-known URL (https://domain/.well-known/agent.json)
     * 2. AgoraMesh DHT (if node URL configured)
     * 3. IPFS (if CID available on-chain)
     *
     * @param did - The agent's DID
     * @returns The capability card or null if not found
     */
    getCapabilityCard(did: string): Promise<CapabilityCard | null>;
    /**
     * Fetch capability card from well-known URL.
     */
    private fetchFromWellKnown;
    /**
     * Fetch capability card from DHT via node.
     */
    private fetchFromDHT;
    /**
     * Fetch capability card from IPFS using on-chain CID.
     *
     * @param did - The agent's DID
     * @returns The capability card if found, null otherwise
     */
    private fetchFromIPFS;
    /**
     * Announce an agent's capability card to the network.
     *
     * This publishes the capability card to:
     * 1. The DHT (via the node)
     * 2. GossipSub for real-time propagation
     *
     * @param card - The capability card to announce
     * @param adminToken - Optional admin auth token (Bearer token or API key)
     * @throws Error if node URL not configured
     */
    announce(card: CapabilityCard, adminToken?: string): Promise<void>;
    /**
     * Remove an agent's capability card from the network.
     *
     * Note: The node API does not currently support agent removal.
     * This method will throw until the endpoint is implemented.
     *
     * @param _did - The agent's DID to remove
     */
    unannounce(_did: string): Promise<void>;
    /**
     * Check if an agent is available (reachable at their endpoint).
     *
     * @param card - The agent's capability card
     * @returns True if the agent is reachable
     */
    isAgentAvailable(card: CapabilityCard): Promise<boolean>;
    /**
     * Score and rank agents based on trust and price.
     *
     * @param results - Discovery results to rank
     * @returns Sorted results (best first)
     */
    rankResults(results: DiscoveryResult[]): DiscoveryResult[];
    /**
     * Filter results to only include agents with specific skills.
     *
     * @param results - Discovery results to filter
     * @param skillIds - Required skill IDs
     * @returns Filtered results
     */
    filterBySkills(results: DiscoveryResult[], skillIds: string[]): DiscoveryResult[];
    /**
     * Get recommended agents for a task based on requirements.
     *
     * @param query - Natural language task description
     * @param requirements - Task requirements
     * @returns Ranked list of recommended agents
     */
    getRecommendations(query: string, requirements?: {
        minTrust?: number;
        maxPrice?: string;
        requiredSkills?: string[];
        currency?: string;
    }): Promise<DiscoveryResult[]>;
}
//# sourceMappingURL=discovery.d.ts.map