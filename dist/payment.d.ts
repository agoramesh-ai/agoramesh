/**
 * AgoraMesh Payment Client
 *
 * Client for managing escrow payments between agents.
 *
 * @packageDocumentation
 */
import type { Escrow, CreateEscrowOptions } from './types.js';
import type { AgoraMeshClient } from './client.js';
/**
 * Client for managing escrow payments between agents.
 *
 * The payment layer supports:
 * - Creating escrows for untrusted transactions
 * - Funding escrows with USDC
 * - Releasing funds to providers
 * - Claiming refunds on timeout
 * - Initiating disputes
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const payment = new PaymentClient(client, 'did:agoramesh:base:0x...');
 *
 * // Create and fund an escrow
 * const escrowId = await payment.createEscrow({
 *   providerDid: 'did:agoramesh:base:0x...',
 *   providerAddress: '0x...',
 *   amount: '100',
 *   taskHash: '0x...',
 *   deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
 * });
 *
 * await payment.fundEscrow(escrowId);
 *
 * // After task completion, release funds
 * await payment.releaseEscrow(escrowId);
 * ```
 */
export declare class PaymentClient {
    private readonly client;
    private readonly clientDid;
    /**
     * Create a new PaymentClient.
     *
     * @param client - The AgoraMesh client instance
     * @param clientDid - The client agent's DID (for creating escrows)
     */
    constructor(client: AgoraMeshClient, clientDid: string);
    /**
     * Create a new escrow for an agent task.
     *
     * @param options - Escrow creation options
     * @returns The new escrow ID
     *
     * @example
     * ```typescript
     * const escrowId = await payment.createEscrow({
     *   providerDid: 'did:agoramesh:base:0x...',
     *   providerAddress: '0x...',
     *   amount: '100', // 100 USDC
     *   taskHash: keccak256(toHex(taskDescription)),
     *   deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
     * });
     * ```
     */
    createEscrow(options: CreateEscrowOptions): Promise<bigint>;
    /**
     * Create and immediately fund an escrow.
     *
     * @param options - Escrow creation options
     * @returns The new escrow ID
     */
    createAndFundEscrow(options: CreateEscrowOptions): Promise<bigint>;
    /**
     * Fund an escrow with USDC.
     *
     * Handles token approval automatically.
     *
     * @param escrowId - The escrow ID to fund
     * @returns Transaction hash
     */
    fundEscrow(escrowId: bigint): Promise<`0x${string}`>;
    /**
     * Confirm task delivery (provider only).
     *
     * @param escrowId - The escrow ID
     * @param outputHash - Hash of the delivered output
     * @returns Transaction hash
     */
    confirmDelivery(escrowId: bigint, outputHash: `0x${string}`): Promise<`0x${string}`>;
    /**
     * Release escrowed funds to the provider.
     *
     * @param escrowId - The escrow ID to release
     * @returns Transaction hash
     */
    releaseEscrow(escrowId: bigint): Promise<`0x${string}`>;
    /**
     * Claim refund after deadline has passed.
     *
     * @param escrowId - The escrow ID to claim timeout on
     * @returns Transaction hash
     */
    claimTimeout(escrowId: bigint): Promise<`0x${string}`>;
    /**
     * Initiate a dispute for an escrow.
     *
     * @param escrowId - The escrow ID to dispute
     * @param evidence - Evidence supporting the dispute (e.g., IPFS CID as bytes)
     * @returns Transaction hash
     */
    initiateDispute(escrowId: bigint, evidence?: `0x${string}`): Promise<`0x${string}`>;
    /**
     * Get escrow details by ID.
     *
     * @param escrowId - The escrow ID to query
     * @returns Escrow details
     */
    getEscrow(escrowId: bigint): Promise<Escrow>;
    /**
     * Check if an escrow can be claimed due to timeout.
     *
     * @param escrowId - The escrow ID to check
     * @returns True if timeout can be claimed
     */
    canClaimTimeout(escrowId: bigint): Promise<boolean>;
    /**
     * Get the time remaining until deadline.
     *
     * @param escrowId - The escrow ID
     * @returns Seconds until deadline (negative if passed)
     */
    getTimeUntilDeadline(escrowId: bigint): Promise<number>;
    /**
     * Get the human-readable amount for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns Amount as string (e.g., "100.00")
     */
    getEscrowAmount(escrowId: bigint): Promise<string>;
    /**
     * Get the human-readable state name for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns State name (e.g., "Funded")
     */
    getEscrowStateName(escrowId: bigint): Promise<string>;
    /**
     * Check if the current user is the client for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns True if current user is the client
     */
    isClient(escrowId: bigint): Promise<boolean>;
    /**
     * Check if the current user is the provider for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns True if current user is the provider
     */
    isProvider(escrowId: bigint): Promise<boolean>;
    /**
     * Format an escrow for display.
     *
     * @param escrow - The escrow to format
     * @returns Formatted escrow summary
     */
    formatEscrow(escrow: Escrow): {
        id: string;
        amount: string;
        state: string;
        deadline: Date;
        isOverdue: boolean;
    };
}
//# sourceMappingURL=payment.d.ts.map