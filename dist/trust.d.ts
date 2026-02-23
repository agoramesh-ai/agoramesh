/**
 * AgoraMesh Trust Client
 *
 * Client for interacting with the AgoraMesh trust layer.
 *
 * @packageDocumentation
 */
import type { TrustScore, TrustDetails, ReputationData, StakeInfo, Endorsement } from './types.js';
import type { AgoraMeshClient } from './client.js';
/**
 * Client for interacting with the AgoraMesh trust layer.
 *
 * The trust layer provides:
 * - Composite trust scores (reputation + stake + endorsements)
 * - Staking for economic commitment
 * - Endorsement system (web of trust)
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const trust = new TrustClient(client);
 *
 * // Get trust score
 * const score = await trust.getTrustScore('did:agoramesh:base:0x...');
 * console.log(`Trust: ${(score.overall * 100).toFixed(1)}%`);
 *
 * // Deposit stake
 * await trust.depositStake('did:agoramesh:base:0x...', '1000'); // 1000 USDC
 *
 * // Endorse another agent
 * await trust.endorse('did:agoramesh:base:0x...', 'Reliable partner');
 * ```
 */
export declare class TrustClient {
    private readonly client;
    /**
     * Create a new TrustClient.
     *
     * @param client - The AgoraMesh client instance
     */
    constructor(client: AgoraMeshClient);
    /**
     * Get trust score from a node's REST API (no wallet/blockchain connection needed).
     *
     * @param did - The agent's DID
     * @param nodeUrl - The AgoraMesh node URL (e.g., 'https://api.agoramesh.ai')
     * @returns Trust score breakdown
     *
     * @example
     * ```typescript
     * const trust = new TrustClient(client);
     * const score = await trust.getTrustFromNode(
     *   'did:agoramesh:base:0x...',
     *   'https://api.agoramesh.ai'
     * );
     * console.log(`Trust: ${(score.overall * 100).toFixed(1)}%`);
     * ```
     */
    getTrustFromNode(did: string, nodeUrl: string): Promise<TrustScore>;
    /**
     * Get the composite trust score for an agent.
     *
     * @param did - The agent's DID
     * @returns Trust score breakdown
     */
    getTrustScore(did: string): Promise<TrustScore>;
    /**
     * Get detailed trust information for an agent.
     *
     * @param did - The agent's DID
     * @returns Complete trust details including raw data
     */
    getTrustDetails(did: string): Promise<TrustDetails>;
    /**
     * Get just the reputation data for an agent.
     *
     * @param did - The agent's DID
     * @returns Reputation data
     */
    getReputation(did: string): Promise<ReputationData>;
    /**
     * Get endorsements for an agent.
     *
     * @param did - The agent's DID
     * @returns Array of endorsements
     */
    getEndorsements(did: string): Promise<Endorsement[]>;
    /**
     * Deposit stake for an agent.
     *
     * Requires USDC approval first. This method handles approval automatically.
     *
     * @param did - The agent's DID
     * @param amount - Amount to stake in USDC (human-readable, e.g., "1000")
     * @returns Transaction hash
     *
     * @example
     * ```typescript
     * // Stake 1000 USDC
     * const txHash = await trust.depositStake('did:agoramesh:base:0x...', '1000');
     * ```
     */
    depositStake(did: string, amount: string): Promise<`0x${string}`>;
    /**
     * Request withdrawal of staked funds.
     *
     * Starts the 7-day cooldown period.
     *
     * @param did - The agent's DID
     * @param amount - Amount to withdraw in USDC (human-readable)
     * @returns Object with transaction hash and unlock timestamp
     */
    requestWithdraw(did: string, amount: string): Promise<{
        txHash: `0x${string}`;
        unlockTime: bigint;
    }>;
    /**
     * Execute a pending withdrawal after cooldown.
     *
     * @param did - The agent's DID
     * @returns Transaction hash
     */
    executeWithdraw(did: string): Promise<`0x${string}`>;
    /**
     * Get stake information for an agent.
     *
     * @param did - The agent's DID
     * @returns Stake information
     */
    getStakeInfo(did: string): Promise<StakeInfo>;
    /**
     * Get the human-readable stake amount.
     *
     * @param did - The agent's DID
     * @returns Stake amount as string (e.g., "1000.00")
     */
    getStakeAmount(did: string): Promise<string>;
    /**
     * Endorse another agent.
     *
     * The caller must be a registered agent.
     *
     * @param endorseeDid - The DID of the agent to endorse
     * @param message - Optional endorsement message
     * @returns Transaction hash
     *
     * @example
     * ```typescript
     * await trust.endorse(
     *   'did:agoramesh:base:0x...',
     *   'Reliable partner for legal translations'
     * );
     * ```
     */
    endorse(endorseeDid: string, message?: string): Promise<`0x${string}`>;
    /**
     * Revoke an endorsement.
     *
     * @param endorseeDid - The DID of the agent to revoke endorsement from
     * @returns Transaction hash
     */
    revokeEndorsement(endorseeDid: string): Promise<`0x${string}`>;
    /**
     * Check if an agent meets minimum trust requirements.
     *
     * @param did - The agent's DID
     * @param minTrust - Minimum required trust score (0.0-1.0)
     * @returns True if agent meets requirements
     */
    meetsTrustRequirement(did: string, minTrust: number): Promise<boolean>;
    /**
     * Calculate escrow requirement based on trust score.
     *
     * Higher trust = lower escrow requirement.
     *
     * @param trustScore - Trust score (0.0-1.0)
     * @param taskValue - Task value in USDC
     * @returns Required escrow amount as string
     */
    calculateEscrowRequirement(trustScore: number, taskValue: string): string;
    /**
     * Format a trust score for display.
     *
     * @param score - Trust score (0.0-1.0)
     * @returns Formatted string (e.g., "85.5%")
     */
    formatTrustScore(score: number): string;
}
//# sourceMappingURL=trust.d.ts.map