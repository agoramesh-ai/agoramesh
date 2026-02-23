/**
 * AgoraMesh Easy API
 *
 * Zero-config, high-level interface for AI agents.
 * One import, one setup, done.
 *
 * @example
 * ```typescript
 * import { AgoraMesh } from '@agoramesh/sdk'
 *
 * const me = new AgoraMesh({ privateKey: '0x...' })
 *
 * // Find agents
 * const agents = await me.find('translate legal documents')
 *
 * // Check trust
 * const trust = await me.trust(agents[0])
 *
 * // Hire an agent (creates escrow, sends task, releases on completion)
 * const result = await me.hire(agents[0], {
 *   task: 'Translate this contract to Czech',
 *   budget: '5.00',
 * })
 * ```
 *
 * @packageDocumentation
 */
import type { DiscoveryResult, TrustScore } from './types.js';
export interface AgoraMeshOptions {
    /** Agent's private key (hex string with 0x prefix) */
    privateKey: string;
    /** Network: 'sepolia' (default) or 'mainnet' */
    network?: 'sepolia' | 'mainnet';
    /** Discovery node URL (default: https://api.agoramesh.ai) */
    nodeUrl?: string;
    /** Agent DID (auto-generated from address if omitted) */
    did?: string;
}
export interface FindOptions {
    /** Minimum trust score 0-1 (default: 0.5) */
    minTrust?: number;
    /** Maximum price in USDC (default: no limit) */
    maxPrice?: string;
    /** Maximum results (default: 5) */
    limit?: number;
}
export interface HireOptions {
    /** Task description */
    task: string;
    /** Budget in USDC */
    budget: string;
    /** Deadline in ms from now (default: 1 hour) */
    deadlineMs?: number;
}
export interface HireResult {
    /** Whether the task completed successfully */
    success: boolean;
    /** Task output/response */
    output?: string;
    /** Amount paid in USDC */
    amountPaid?: string;
    /** Error message if failed */
    error?: string;
}
export interface AgentInfo {
    /** Agent DID */
    did: string;
    /** Display name */
    name: string;
    /** What the agent does */
    description: string;
    /** Agent URL */
    url: string;
    /** Trust score 0-1 */
    trust: number;
    /** Price per request in USDC */
    price?: string;
    /** Capabilities list */
    capabilities: string[];
    /** Raw discovery result (for advanced use) */
    _raw: DiscoveryResult;
}
export declare class AgoraMesh {
    private options;
    private client;
    private discovery;
    private trustClient;
    private payment;
    private nodeUrl;
    private network;
    private myDid;
    private initialized;
    constructor(options: AgoraMeshOptions);
    private init;
    /**
     * Find agents by capability description.
     */
    find(query: string, options?: FindOptions): Promise<AgentInfo[]>;
    /**
     * Get trust score for an agent.
     */
    trust(agent: AgentInfo | string): Promise<TrustScore>;
    /**
     * Hire an agent to perform a task.
     * Automatically handles escrow creation, task submission, and payment.
     */
    hire(agent: AgentInfo, options: HireOptions): Promise<HireResult>;
    /**
     * Quick health check — is the network reachable?
     */
    ping(): Promise<{
        ok: boolean;
        peers: number;
        version: string;
    }>;
    private submitTask;
    private resolveAddress;
}
/**
 * Create an AgoraMesh instance with minimal config.
 */
export declare function createAgoraMesh(options: AgoraMeshOptions): AgoraMesh;
//# sourceMappingURL=easy.d.ts.map