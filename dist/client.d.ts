/**
 * AgoraMesh Client
 *
 * Main client for interacting with the AgoraMesh network.
 *
 * @packageDocumentation
 */
import { type PublicClient, type WalletClient, type Chain, type Transport, type Account } from 'viem';
import type { AgoraMeshConfig, ContractAddresses, CapabilityCard, Agent } from './types.js';
/**
 * Validate a DID string format according to W3C DID spec.
 *
 * Supported formats:
 * - did:agoramesh:base:abc123 (AgoraMesh native)
 * - did:web:ethereum:ABC123 (Web DID)
 * - did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK (Key DID)
 * - did:ethr:0xb9c5714089478a327f09197987f16f9e5d936e8a (Ethereum DID)
 * - did:ethr:mainnet:0xb9c5714089478a327f09197987f16f9e5d936e8a (Ethereum DID with network)
 *
 * Invalid patterns:
 * - agoramesh:base:abc123 (missing did: prefix)
 * - did:invalid:base:abc123 (unsupported method)
 * - did:KEY:... (uppercase method not allowed)
 * - did:key:abc123 (key must start with 'z' for multibase)
 * - did:ethr:0x123 (address too short)
 *
 * @param did - The DID string to validate
 * @throws Error if DID format is invalid
 */
export declare function validateDID(did: string): void;
/**
 * Convert a DID string to a bytes32 hash.
 *
 * @param did - The DID string to hash
 * @returns The keccak256 hash of the DID as a hex string
 * @throws Error if DID format is invalid
 */
export declare function didToHash(did: string): `0x${string}`;
/**
 * Main client for interacting with the AgoraMesh network.
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({
 *   rpcUrl: 'https://sepolia.base.org',
 *   chainId: 84532,
 *   privateKey: '0x...',
 *   trustRegistryAddress: '0x...',
 * });
 *
 * await client.connect();
 *
 * // Register an agent
 * await client.registerAgent(capabilityCard, 'ipfs://Qm...');
 *
 * // Get agent info
 * const agent = await client.getAgent('did:agoramesh:base:0x...');
 * ```
 */
export declare class AgoraMeshClient {
    private readonly config;
    private readonly chain;
    private readonly addresses;
    private publicClient;
    private walletClient;
    private account;
    private connected;
    /**
     * Create a new AgoraMesh client.
     *
     * @param config - Client configuration
     */
    constructor(config: AgoraMeshConfig);
    /**
     * Connect to the blockchain.
     *
     * @throws Error if already connected or if connection fails
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the blockchain.
     */
    disconnect(): void;
    /**
     * Check if the client is connected.
     */
    isConnected(): boolean;
    /**
     * Register a new agent on-chain.
     *
     * @param card - The agent's capability card
     * @param capabilityCardCID - IPFS CID where the capability card is stored
     * @returns Transaction hash
     * @throws Error if not connected or no wallet configured
     */
    registerAgent(card: CapabilityCard, capabilityCardCID: string): Promise<`0x${string}`>;
    /**
     * Update an agent's capability card.
     *
     * @param did - The agent's DID
     * @param newCID - New IPFS CID for the capability card
     * @returns Transaction hash
     */
    updateCapabilityCard(did: string, newCID: string): Promise<`0x${string}`>;
    /**
     * Deactivate an agent.
     *
     * @param did - The agent's DID
     * @returns Transaction hash
     */
    deactivateAgent(did: string): Promise<`0x${string}`>;
    /**
     * Get an agent by DID.
     *
     * @param did - The agent's DID
     * @returns Agent data or null if not found
     */
    getAgent(did: string): Promise<Agent | null>;
    /**
     * Check if an agent is active.
     *
     * @param did - The agent's DID
     * @returns True if the agent is active
     */
    isAgentActive(did: string): Promise<boolean>;
    /**
     * Get the RPC URL.
     */
    get rpcUrl(): string;
    /**
     * Get the chain ID.
     */
    get chainId(): number;
    /**
     * Get the public client for advanced operations.
     */
    getPublicClient(): PublicClient<Transport, Chain> | null;
    /**
     * Get the wallet client for advanced operations.
     */
    getWalletClient(): WalletClient<Transport, Chain, Account> | null;
    /**
     * Get the account address.
     */
    getAddress(): `0x${string}` | null;
    /**
     * Get contract addresses.
     */
    getContractAddresses(): Partial<ContractAddresses>;
    /**
     * Ensure the client is connected.
     */
    private requireConnection;
    /**
     * Ensure a wallet is configured.
     */
    private requireWallet;
    /**
     * Ensure TrustRegistry address is configured.
     */
    private requireTrustRegistry;
}
/**
 * Create a new AgoraMesh client.
 *
 * @param config - Client configuration
 * @returns A new AgoraMeshClient instance
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   rpcUrl: 'https://sepolia.base.org',
 *   chainId: 84532,
 * });
 * ```
 */
export declare function createClient(config: AgoraMeshConfig): AgoraMeshClient;
//# sourceMappingURL=client.d.ts.map