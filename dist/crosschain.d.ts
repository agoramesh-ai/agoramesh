/**
 * AgoraMesh Cross-Chain Trust Client
 *
 * Client for interacting with the CrossChainTrustSync contract
 * for multi-chain trust score synchronization via LayerZero V2.
 *
 * @packageDocumentation
 */
import type { Address, Hash } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
/**
 * Configuration for the CrossChainTrustClient
 */
export interface CrossChainConfig {
    /** Address of the CrossChainTrustSync contract */
    crossChainSyncAddress: Address;
    /** Address of the ChainRegistry contract */
    chainRegistryAddress: Address;
}
/**
 * Cached trust score data
 */
export interface CachedTrustScore {
    /** Trust score in basis points (0-10000) */
    trustScore: number;
    /** When the cache was last updated */
    lastUpdated: Date;
    /** Whether a cached score exists */
    exists: boolean;
}
/**
 * Chain information from ChainRegistry
 */
export interface ChainInfo {
    /** Chain ID */
    chainId: number;
    /** Human-readable chain name */
    name: string;
    /** Whether this is a testnet */
    isTestnet: boolean;
    /** Whether the chain is currently active */
    isActive: boolean;
    /** TrustRegistry address on this chain */
    trustRegistry: Address;
    /** USDC address on this chain */
    usdcAddress: Address;
    /** LayerZero endpoint address */
    endpoint: Address;
}
/**
 * Options for requesting a trust sync
 */
export interface RequestTrustSyncOptions {
    /** LayerZero endpoint ID of the destination chain */
    destinationEid: number;
    /** Agent DID to sync trust for */
    did: string;
}
/**
 * Options for syncing a trust score
 */
export interface SyncTrustScoreOptions {
    /** LayerZero endpoint ID of the destination chain */
    destinationEid: number;
    /** Agent DID */
    did: string;
    /** Trust score to sync (basis points) */
    trustScore: number;
}
/**
 * Options for quoting sync fee
 */
export interface QuoteSyncFeeOptions {
    /** LayerZero endpoint ID of the destination chain */
    destinationEid: number;
    /** Agent DID */
    did: string;
    /** Trust score (basis points) */
    trustScore: number;
}
/**
 * Result of a sync operation
 */
export interface SyncResult {
    /** Transaction hash */
    hash: Hash;
}
/**
 * Client for cross-chain trust score synchronization.
 *
 * Provides methods to:
 * - Query cached trust scores from other chains
 * - Initiate trust sync operations
 * - Check chain registry for supported chains
 *
 * @example
 * ```typescript
 * const client = new CrossChainTrustClient(publicClient, walletClient, {
 *   crossChainSyncAddress: '0x...',
 *   chainRegistryAddress: '0x...',
 * });
 *
 * // Check if cache is stale
 * const isStale = await client.isCacheStale('did:agoramesh:base:0x...');
 *
 * // Request sync from primary chain
 * if (isStale) {
 *   const { hash } = await client.requestTrustSync({
 *     destinationEid: 30184,
 *     did: 'did:agoramesh:base:0x...',
 *   });
 * }
 * ```
 */
export declare class CrossChainTrustClient {
    private readonly publicClient;
    private readonly walletClient;
    private readonly config;
    constructor(publicClient: PublicClient, walletClient: WalletClient, config: CrossChainConfig);
    get crossChainSyncAddress(): Address;
    get chainRegistryAddress(): Address;
    /**
     * Get cached trust score for a DID
     */
    getCachedTrustScore(did: string): Promise<CachedTrustScore>;
    /**
     * Get aggregated trust score (returns cached score or 0 if not cached)
     */
    getAggregatedTrustScore(did: string): Promise<number>;
    /**
     * Check if cached trust score is stale (expired TTL)
     */
    isCacheStale(did: string): Promise<boolean>;
    /**
     * Check if current chain is the primary chain
     */
    isPrimaryChain(): Promise<boolean>;
    /**
     * Get list of supported destination endpoint IDs
     */
    getSupportedDestinations(): Promise<number[]>;
    /**
     * Get the primary chain ID
     */
    getPrimaryChainId(): Promise<number>;
    /**
     * Get the cache TTL in seconds
     */
    getCacheTTL(): Promise<number>;
    /**
     * Quote the fee for syncing trust score to destination chain
     */
    quoteSyncFee(options: QuoteSyncFeeOptions): Promise<bigint>;
    /**
     * Request a trust score sync from the primary chain
     *
     * Used on secondary chains to request the latest trust score
     * from the primary chain.
     */
    requestTrustSync(options: RequestTrustSyncOptions): Promise<SyncResult>;
    /**
     * Sync a trust score to a destination chain
     *
     * Used on the primary chain to push trust scores to secondary chains.
     */
    syncTrustScore(options: SyncTrustScoreOptions): Promise<SyncResult>;
    /**
     * Get information about a specific chain
     */
    getChainInfo(chainId: number): Promise<ChainInfo>;
    /**
     * Get all supported chain IDs
     */
    getSupportedChains(): Promise<number[]>;
    /**
     * Check if a chain is supported
     */
    isChainSupported(chainId: number): Promise<boolean>;
    /**
     * Convert a DID string to bytes32 hash
     */
    didToHash(did: string): `0x${string}`;
    /**
     * Format trust score from basis points to percentage
     */
    formatTrustScore(basisPoints: number): number;
    /**
     * Calculate seconds since last cache update
     */
    getTimeSinceLastUpdate(cachedScore: CachedTrustScore): number;
}
//# sourceMappingURL=crosschain.d.ts.map