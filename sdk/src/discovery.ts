/**
 * AgoraMesh Discovery Client
 *
 * Client for discovering agents in the AgoraMesh network.
 *
 * @packageDocumentation
 */

import type {
  CapabilityCard,
  SearchOptions,
  DiscoveryResult,
} from './types.js';
import type { AgoraMeshClient } from './client.js';

// =============================================================================
// URL Validation (SSRF Protection)
// =============================================================================

/**
 * Check if a URL points to a private/internal network address.
 * Used to prevent SSRF attacks by blocking requests to internal services.
 *
 * Handles bypass vectors including:
 * - IPv6 loopback (::1), private (fc00::/7, fe80::/10), IPv4-mapped (::ffff:)
 * - Hex IPs (0x7f000001), octal IPs (0177.0.0.1), decimal integer IPs (2130706433)
 * - 0.0.0.0 and localhost variants
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    // Block localhost variants
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) return true;

    // Block IPv6 loopback and private
    if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
    if (hostname.startsWith('::ffff:')) return true; // IPv4-mapped IPv6
    if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true; // unique local
    if (hostname.startsWith('fe80')) return true; // link-local

    // Try to parse as IPv4 (handles decimal, hex, octal)
    // Check if hostname is numeric-only (after dots) or a single integer
    const parts = hostname.split('.');
    if (parts.every(p => /^(0x[\da-f]+|\d+)$/i.test(p)) || /^\d+$/.test(hostname)) {
      // Numeric hostname - could be decimal/hex/octal IP
      let ip: number;
      if (/^\d+$/.test(hostname)) {
        ip = parseInt(hostname, 10); // single integer IP like 2130706433
      } else {
        // Parse dotted notation (may be hex/octal)
        const octets = parts.map(p => {
          if (p.startsWith('0x') || p.startsWith('0X')) return parseInt(p, 16);
          if (p.startsWith('0') && p.length > 1) return parseInt(p, 8);
          return parseInt(p, 10);
        });
        if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) return true; // invalid = block
        ip = (octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!;
      }
      // Check private ranges using unsigned comparison
      const a = (ip >>> 24) & 0xff;
      const b = (ip >>> 16) & 0xff;
      if (ip === 0) return true; // 0.0.0.0
      if (a === 127) return true; // 127.0.0.0/8
      if (a === 10) return true; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; // 192.168.0.0/16
      if (a === 169 && b === 254) return true; // 169.254.0.0/16
      return false;
    }

    // Standard hostname checks (non-numeric hostnames that weren't caught above)
    if (hostname === '127.0.0.1' || hostname === '0.0.0.0') return true;
    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    if (hostname.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (hostname.startsWith('0.')) return true;

    return false;
  } catch {
    return true; // Invalid URL = reject
  }
}

// =============================================================================
// DiscoveryClient
// =============================================================================

/**
 * Client for discovering and announcing agents in the AgoraMesh network.
 *
 * Discovery uses a combination of:
 * - On-chain registry for registered agents
 * - libp2p DHT for distributed capability cards
 * - Semantic search for natural language queries
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const discovery = new DiscoveryClient(client);
 *
 * // Search for translation agents
 * const results = await discovery.search('translate legal documents', {
 *   minTrust: 0.8,
 *   maxPrice: '0.10',
 * });
 *
 * // Get a specific agent's capability card
 * const card = await discovery.getCapabilityCard('did:agoramesh:base:0x...');
 * ```
 */
/** Default IPFS gateway URL */
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs';

export class DiscoveryClient {
  private readonly client: AgoraMeshClient;
  private nodeUrl: string | null = null;
  private ipfsGateway: string = DEFAULT_IPFS_GATEWAY;

  /**
   * Create a new DiscoveryClient.
   *
   * @param client - The AgoraMesh client instance
   * @param nodeUrl - Optional AgoraMesh node URL for P2P discovery
   */
  constructor(client: AgoraMeshClient, nodeUrl?: string) {
    this.client = client;
    this.nodeUrl = nodeUrl ?? null;
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Set the AgoraMesh node URL for P2P discovery.
   *
   * @param url - The node URL
   * @throws Error if the URL points to a private address
   */
  setNodeUrl(url: string): void {
    if (isPrivateUrl(url)) {
      throw new Error('Node URL cannot point to a private address');
    }
    this.nodeUrl = url;
  }

  /**
   * Get the configured node URL.
   */
  getNodeUrl(): string | null {
    return this.nodeUrl;
  }

  /**
   * Set the IPFS gateway URL for fetching capability cards.
   *
   * @param gateway - The IPFS gateway URL (e.g., 'https://ipfs.io/ipfs')
   * @throws Error if the gateway URL points to a private address
   */
  setIPFSGateway(gateway: string): void {
    if (isPrivateUrl(gateway)) {
      throw new Error('IPFS gateway URL cannot point to a private address');
    }
    this.ipfsGateway = gateway;
  }

  /**
   * Get the configured IPFS gateway URL.
   */
  getIPFSGateway(): string {
    return this.ipfsGateway;
  }

  // ===========================================================================
  // Search
  // ===========================================================================

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
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<DiscoveryResult[]> {
    if (!this.nodeUrl) {
      throw new Error(
        'Node URL not configured. Call setNodeUrl() or pass nodeUrl to constructor.'
      );
    }

    const {
      minTrust = 0,
      maxPrice,
      tags = [],
      currency,
      limit = 20,
      offset = 0,
    } = options;

    // Build query parameters
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    if (minTrust > 0) {
      params.set('minTrust', String(minTrust));
    }
    if (maxPrice) {
      params.set('maxPrice', maxPrice);
    }
    if (tags.length > 0) {
      params.set('tags', tags.join(','));
    }
    if (currency) {
      params.set('currency', currency);
    }

    // Make request to semantic search endpoint
    const response = await fetch(
      `${this.nodeUrl}/agents/semantic?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discovery search failed: ${error}`);
    }

    // Node returns a direct array of SemanticSearchResult objects
    const data = (await response.json()) as Array<{
      did: string;
      score: number;
      vector_score: number;
      keyword_score: number;
      card: {
        name: string;
        description: string;
        url: string;
        capabilities?: Array<{ id: string; name: string; description?: string }>;
        agoramesh?: {
          did: string;
          trust_score?: number;
          pricing?: { base_price: number; currency: string; model: string };
        };
      };
      trust?: {
        did: string;
        score: number;
        reputation: number;
        stake_score: number;
        endorsement_score: number;
      };
    }>;

    return data.map((item) => ({
      did: item.did,
      name: item.card.name,
      description: item.card.description,
      url: item.card.url,
      trust: item.trust
        ? {
            overall: item.trust.score,
            reputation: item.trust.reputation,
            stake: item.trust.stake_score,
            endorsement: item.trust.endorsement_score,
          }
        : {
            overall: item.card.agoramesh?.trust_score ?? item.score,
            reputation: item.score,
            stake: 0,
            endorsement: 0,
          },
      matchingSkills: (item.card.capabilities ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      })),
      pricing: item.card.agoramesh?.pricing
        ? {
            model: 'per_request' as const,
            amount: String(item.card.agoramesh.pricing.base_price),
            currency: item.card.agoramesh.pricing.currency,
          }
        : undefined,
    }));
  }

  /**
   * Search for agents by specific tags/capabilities.
   *
   * @param tags - Array of capability tags to search for
   * @param options - Additional search options
   * @returns Array of matching agents
   */
  async searchByTags(
    tags: string[],
    options: Omit<SearchOptions, 'tags'> = {}
  ): Promise<DiscoveryResult[]> {
    if (!this.nodeUrl) {
      throw new Error('Node URL not configured.');
    }

    const { minTrust = 0, maxPrice, currency, limit = 20, offset = 0 } = options;

    const params = new URLSearchParams();
    params.set('q', tags.join(','));
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    if (minTrust > 0) {
      params.set('minTrust', String(minTrust));
    }
    if (maxPrice) {
      params.set('maxPrice', maxPrice);
    }
    if (currency) {
      params.set('currency', currency);
    }

    const response = await fetch(
      `${this.nodeUrl}/agents?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discovery search failed: ${error}`);
    }

    // Node returns a direct array of CapabilityCard objects
    const data = (await response.json()) as Array<{
      name: string;
      description: string;
      url: string;
      capabilities?: Array<{ id: string; name: string; description?: string }>;
      agoramesh?: {
        did: string;
        trust_score?: number;
        pricing?: { base_price: number; currency: string; model: string };
      };
    }>;

    return data.map((card) => ({
      did: card.agoramesh?.did ?? '',
      name: card.name,
      description: card.description,
      url: card.url,
      trust: {
        overall: card.agoramesh?.trust_score ?? 0,
        reputation: 0,
        stake: 0,
        endorsement: 0,
      },
      matchingSkills: (card.capabilities ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      })),
      pricing: card.agoramesh?.pricing
        ? {
            model: 'per_request' as const,
            amount: String(card.agoramesh.pricing.base_price),
            currency: card.agoramesh.pricing.currency,
          }
        : undefined,
    }));
  }

  // ===========================================================================
  // Capability Cards
  // ===========================================================================

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
  async getCapabilityCard(did: string): Promise<CapabilityCard | null> {
    // Try to fetch from well-known URL first
    const wellKnownCard = await this.fetchFromWellKnown(did);
    if (wellKnownCard) {
      return wellKnownCard;
    }

    // Try DHT if node URL configured
    if (this.nodeUrl) {
      const dhtCard = await this.fetchFromDHT(did);
      if (dhtCard) {
        return dhtCard;
      }
    }

    // Try IPFS via on-chain CID
    const ipfsCard = await this.fetchFromIPFS(did);
    if (ipfsCard) {
      return ipfsCard;
    }

    return null;
  }

  /**
   * Fetch capability card from well-known URL.
   */
  private async fetchFromWellKnown(did: string): Promise<CapabilityCard | null> {
    // Extract domain from DID if possible
    // Format: did:web:example.com or did:agoramesh:base:0x...
    const match = did.match(/^did:web:([^:]+)/);
    if (!match) {
      return null;
    }

    const domain = match[1];
    const wellKnownUrl = `https://${domain}/.well-known/agent.json`;

    if (isPrivateUrl(wellKnownUrl)) {
      return null;
    }

    try {
      const response = await fetch(wellKnownUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const card = (await response.json()) as CapabilityCard;

      // Validate that the DID matches
      if (card.id !== did) {
        console.warn(`DID mismatch: expected ${did}, got ${card.id}`);
        return null;
      }

      return card;
    } catch {
      return null;
    }
  }

  /**
   * Fetch capability card from DHT via node.
   */
  private async fetchFromDHT(did: string): Promise<CapabilityCard | null> {
    if (!this.nodeUrl) {
      return null;
    }

    try {
      const response = await fetch(
        `${this.nodeUrl}/agents/${encodeURIComponent(did)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CapabilityCard;
    } catch {
      return null;
    }
  }

  /**
   * Fetch capability card from IPFS using on-chain CID.
   *
   * @param did - The agent's DID
   * @returns The capability card if found, null otherwise
   */
  private async fetchFromIPFS(did: string): Promise<CapabilityCard | null> {
    try {
      // Get agent info from on-chain registry
      const agent = await this.client.getAgent(did);
      if (!agent) {
        return null;
      }

      // Check if agent has a capability card CID
      const cid = agent.capabilityCardCID;
      if (!cid || cid.trim() === '') {
        return null;
      }

      // Validate CID format: must be alphanumeric, no path traversal or special chars
      // CIDv0 starts with Qm, CIDv1 starts with b, but we accept any safe alphanumeric string
      if (!/^[a-zA-Z0-9]+$/.test(cid)) {
        return null;
      }

      // Fetch capability card from IPFS gateway
      const ipfsUrl = `${this.ipfsGateway}/${cid}`;

      // SSRF protection: verify the constructed URL doesn't point to a private address
      if (isPrivateUrl(ipfsUrl)) {
        throw new Error(`SSRF blocked: ${ipfsUrl} points to a private address`);
      }

      const response = await fetch(ipfsUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CapabilityCard;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Announcement
  // ===========================================================================

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
  async announce(card: CapabilityCard, adminToken?: string): Promise<void> {
    if (!this.nodeUrl) {
      throw new Error('Node URL not configured.');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (adminToken) {
      headers['Authorization'] = `Bearer ${adminToken}`;
    }

    const response = await fetch(`${this.nodeUrl}/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to announce capability card: ${error}`);
    }
  }

  /**
   * Remove an agent's capability card from the network.
   *
   * Note: The node API does not currently support agent removal.
   * This method will throw until the endpoint is implemented.
   *
   * @param _did - The agent's DID to remove
   */
  async unannounce(_did: string): Promise<void> {
    throw new Error(
      'Agent removal is not yet supported by the node API. ' +
      'This feature will be available in a future version.'
    );
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Check if an agent is available (reachable at their endpoint).
   *
   * @param card - The agent's capability card
   * @returns True if the agent is reachable
   */
  async isAgentAvailable(card: CapabilityCard): Promise<boolean> {
    if (isPrivateUrl(card.url)) {
      return false;
    }

    try {
      const response = await fetch(card.url, {
        method: 'OPTIONS',
        headers: {
          Accept: 'application/json',
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Score and rank agents based on trust and price.
   *
   * @param results - Discovery results to rank
   * @returns Sorted results (best first)
   */
  rankResults(results: DiscoveryResult[]): DiscoveryResult[] {
    return [...results].sort((a, b) => {
      // Calculate value score: trust / price
      const aPrice = parseFloat(a.pricing?.amount ?? '999999');
      const bPrice = parseFloat(b.pricing?.amount ?? '999999');

      const aValue = a.trust.overall / aPrice;
      const bValue = b.trust.overall / bPrice;

      return bValue - aValue;
    });
  }

  /**
   * Filter results to only include agents with specific skills.
   *
   * @param results - Discovery results to filter
   * @param skillIds - Required skill IDs
   * @returns Filtered results
   */
  filterBySkills(
    results: DiscoveryResult[],
    skillIds: string[]
  ): DiscoveryResult[] {
    return results.filter((result) =>
      skillIds.every((skillId) =>
        result.matchingSkills.some((skill) => skill.id === skillId)
      )
    );
  }

  /**
   * Get recommended agents for a task based on requirements.
   *
   * @param query - Natural language task description
   * @param requirements - Task requirements
   * @returns Ranked list of recommended agents
   */
  async getRecommendations(
    query: string,
    requirements: {
      minTrust?: number;
      maxPrice?: string;
      requiredSkills?: string[];
      currency?: string;
    } = {}
  ): Promise<DiscoveryResult[]> {
    const results = await this.search(query, {
      minTrust: requirements.minTrust ?? 0.5,
      maxPrice: requirements.maxPrice,
      currency: requirements.currency,
      limit: 50,
    });

    let filtered = results;

    // Filter by required skills
    if (requirements.requiredSkills && requirements.requiredSkills.length > 0) {
      filtered = this.filterBySkills(filtered, requirements.requiredSkills);
    }

    // Rank by value
    return this.rankResults(filtered);
  }
}
