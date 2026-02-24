/**
 * AgoraMesh ERC-8004 Bridge Client
 *
 * Client for interacting with the ERC8004Bridge contract, which registers
 * AgoraMesh agents on the official ERC-8004 registries on Base Sepolia.
 *
 * @packageDocumentation
 */
import type { AgoraMeshClient } from './client.js';
/** Official ERC-8004 IdentityRegistry on Base Sepolia */
export declare const ERC8004_IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e";
/** Official ERC-8004 ReputationRegistry on Base Sepolia */
export declare const ERC8004_REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713";
/** Result of registering an agent on ERC-8004 */
export interface ERC8004Registration {
    /** Transaction hash */
    txHash: `0x${string}`;
    /** The ERC-8004 agent ID assigned by the official registry */
    erc8004AgentId: bigint;
}
/** ERC-8004 reputation summary */
export interface ERC8004ReputationSummary {
    /** Total number of feedback entries */
    count: bigint;
    /** Aggregated feedback score */
    summaryValue: bigint;
    /** Decimal places in summaryValue */
    summaryValueDecimals: number;
}
/**
 * Client for interacting with the AgoraMesh ERC-8004 Bridge.
 *
 * The bridge registers AgoraMesh agents on the official ERC-8004 registries
 * and allows submitting feedback and validations.
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const bridge = new ERC8004BridgeClient(client, '0xBridgeAddress...');
 *
 * // Register an agent
 * const result = await bridge.registerAgentOnERC8004(1n, 'ipfs://QmCapCard');
 * console.log(`ERC-8004 ID: ${result.erc8004AgentId}`);
 *
 * // Submit feedback
 * await bridge.submitFeedbackToERC8004(result.erc8004AgentId, 85n, 'quality', 'speed');
 * ```
 */
export declare class ERC8004BridgeClient {
    private readonly client;
    private readonly bridgeAddress;
    /**
     * Create a new ERC8004BridgeClient.
     *
     * @param client - The AgoraMesh client instance
     * @param bridgeAddress - Address of the deployed ERC8004Bridge contract
     */
    constructor(client: AgoraMeshClient, bridgeAddress: `0x${string}`);
    /**
     * Register an AgoraMesh agent on the official ERC-8004 IdentityRegistry.
     *
     * @param agentTokenId - The AgoraMesh token ID to register
     * @param agentURI - The agent metadata URI (e.g., IPFS CID)
     * @returns Transaction hash and the assigned ERC-8004 agent ID
     */
    registerAgentOnERC8004(agentTokenId: bigint, agentURI: string): Promise<ERC8004Registration>;
    /**
     * Update an agent's URI on the official ERC-8004 IdentityRegistry.
     *
     * @param agentTokenId - The AgoraMesh token ID
     * @param newURI - The new metadata URI
     * @returns Transaction hash
     */
    updateAgentURI(agentTokenId: bigint, newURI: string): Promise<`0x${string}`>;
    /**
     * Submit feedback for an agent to the official ERC-8004 ReputationRegistry.
     *
     * @param erc8004AgentId - The ERC-8004 agent ID
     * @param value - Feedback value (signed, supports negative)
     * @param tag1 - Primary categorization tag
     * @param tag2 - Secondary categorization tag
     * @returns Transaction hash
     */
    submitFeedbackToERC8004(erc8004AgentId: bigint, value: bigint, tag1: string, tag2: string): Promise<`0x${string}`>;
    /**
     * Submit a validation response for an agent.
     *
     * @param erc8004AgentId - The ERC-8004 agent ID
     * @param requestHash - Unique validation request hash
     * @param response - Response code (0=pending, 1=valid, 2=invalid, 3=inconclusive)
     * @param tag - Category tag
     * @returns Transaction hash
     */
    submitValidation(erc8004AgentId: bigint, requestHash: `0x${string}`, response: number, tag: string): Promise<`0x${string}`>;
    /**
     * Get the ERC-8004 agent ID for an AgoraMesh token ID.
     *
     * @param agentTokenId - The AgoraMesh token ID
     * @returns The ERC-8004 agent ID (0n if not registered)
     */
    getERC8004AgentId(agentTokenId: bigint): Promise<bigint>;
    /**
     * Get the AgoraMesh token ID for an ERC-8004 agent ID.
     *
     * @param erc8004AgentId - The ERC-8004 agent ID
     * @returns The AgoraMesh token ID (0n if not mapped)
     */
    getAgoraMeshTokenId(erc8004AgentId: bigint): Promise<bigint>;
    /**
     * Check if an AgoraMesh agent is registered on ERC-8004.
     *
     * @param agentTokenId - The AgoraMesh token ID
     * @returns True if registered
     */
    isRegistered(agentTokenId: bigint): Promise<boolean>;
    /**
     * Get agent metadata from the official ERC-8004 IdentityRegistry.
     *
     * @param agentTokenId - The AgoraMesh token ID
     * @param metadataKey - The metadata key to query
     * @returns Raw metadata value as hex bytes
     */
    getAgoraMeshtadata(agentTokenId: bigint, metadataKey: string): Promise<`0x${string}`>;
    /**
     * Get reputation summary from the official ERC-8004 ReputationRegistry.
     *
     * @param erc8004AgentId - The ERC-8004 agent ID
     * @returns Reputation summary
     */
    getReputationSummary(erc8004AgentId: bigint): Promise<ERC8004ReputationSummary>;
    /**
     * Get total number of agents registered through the bridge.
     *
     * @returns Total registered agent count
     */
    getTotalRegistered(): Promise<bigint>;
}
//# sourceMappingURL=erc8004-bridge.d.ts.map