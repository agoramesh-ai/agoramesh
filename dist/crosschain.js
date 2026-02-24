/**
 * AgoraMesh Cross-Chain Trust Client
 *
 * Client for interacting with the CrossChainTrustSync contract
 * for multi-chain trust score synchronization via LayerZero V2.
 *
 * @packageDocumentation
 */
import { didToHash as computeDidHash } from './client.js';
// =============================================================================
// ABI Fragments
// =============================================================================
const CROSS_CHAIN_TRUST_SYNC_ABI = [
    // Query Functions
    {
        name: 'getCachedTrustScore',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'didHash', type: 'bytes32' }],
        outputs: [
            { name: 'trustScore', type: 'uint256' },
            { name: 'lastUpdated', type: 'uint256' },
            { name: 'exists', type: 'bool' },
        ],
    },
    {
        name: 'getAggregatedTrustScore',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'didHash', type: 'bytes32' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'isCacheStale',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'didHash', type: 'bytes32' }],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'isPrimaryChain',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'getSupportedDestinations',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint32[]' }],
    },
    {
        name: 'primaryChainId',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint64' }],
    },
    {
        name: 'cacheTTL',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'quoteSyncFee',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'dstEid', type: 'uint32' },
            { name: 'didHash', type: 'bytes32' },
            { name: 'trustScore', type: 'uint256' },
        ],
        outputs: [{ name: 'fee', type: 'uint256' }],
    },
    // Write Functions
    {
        name: 'requestTrustSync',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'dstEid', type: 'uint32' },
            { name: 'didHash', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        name: 'syncTrustScore',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
            { name: 'dstEid', type: 'uint32' },
            { name: 'didHash', type: 'bytes32' },
            { name: 'trustScore', type: 'uint256' },
        ],
        outputs: [],
    },
];
const CHAIN_REGISTRY_ABI = [
    {
        name: 'getChain',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'chainId', type: 'uint64' }],
        outputs: [
            {
                name: '',
                type: 'tuple',
                components: [
                    { name: 'chainId', type: 'uint64' },
                    { name: 'name', type: 'string' },
                    { name: 'isTestnet', type: 'bool' },
                    { name: 'isActive', type: 'bool' },
                    { name: 'trustRegistry', type: 'address' },
                    { name: 'usdcAddress', type: 'address' },
                    { name: 'endpoint', type: 'address' },
                ],
            },
        ],
    },
    {
        name: 'getAllChains',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint64[]' }],
    },
    {
        name: 'isChainSupported',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'chainId', type: 'uint64' }],
        outputs: [{ name: '', type: 'bool' }],
    },
];
// =============================================================================
// CrossChainTrustClient
// =============================================================================
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
export class CrossChainTrustClient {
    publicClient;
    walletClient;
    config;
    constructor(publicClient, walletClient, config) {
        this.publicClient = publicClient;
        this.walletClient = walletClient;
        this.config = config;
    }
    // ============ Accessors ============
    get crossChainSyncAddress() {
        return this.config.crossChainSyncAddress;
    }
    get chainRegistryAddress() {
        return this.config.chainRegistryAddress;
    }
    // ============ Query Methods ============
    /**
     * Get cached trust score for a DID
     */
    async getCachedTrustScore(did) {
        const didHash = this.didToHash(did);
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'getCachedTrustScore',
            args: [didHash],
        });
        const [trustScore, lastUpdated, exists] = result;
        return {
            trustScore: Number(trustScore),
            lastUpdated: new Date(Number(lastUpdated) * 1000),
            exists,
        };
    }
    /**
     * Get aggregated trust score (returns cached score or 0 if not cached)
     */
    async getAggregatedTrustScore(did) {
        const didHash = this.didToHash(did);
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'getAggregatedTrustScore',
            args: [didHash],
        });
        return Number(result);
    }
    /**
     * Check if cached trust score is stale (expired TTL)
     */
    async isCacheStale(did) {
        const didHash = this.didToHash(did);
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'isCacheStale',
            args: [didHash],
        });
        return result;
    }
    /**
     * Check if current chain is the primary chain
     */
    async isPrimaryChain() {
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'isPrimaryChain',
        });
        return result;
    }
    /**
     * Get list of supported destination endpoint IDs
     */
    async getSupportedDestinations() {
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'getSupportedDestinations',
        });
        const eids = result;
        return eids.map((eid) => Number(eid));
    }
    /**
     * Get the primary chain ID
     */
    async getPrimaryChainId() {
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'primaryChainId',
        });
        return Number(result);
    }
    /**
     * Get the cache TTL in seconds
     */
    async getCacheTTL() {
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'cacheTTL',
        });
        return Number(result);
    }
    // ============ Fee Estimation ============
    /**
     * Quote the fee for syncing trust score to destination chain
     */
    async quoteSyncFee(options) {
        const didHash = this.didToHash(options.did);
        const result = await this.publicClient.readContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'quoteSyncFee',
            args: [options.destinationEid, didHash, BigInt(options.trustScore)],
        });
        return result;
    }
    // ============ Sync Operations ============
    /**
     * Request a trust score sync from the primary chain
     *
     * Used on secondary chains to request the latest trust score
     * from the primary chain.
     */
    async requestTrustSync(options) {
        const didHash = this.didToHash(options.did);
        // Get fee quote first
        const fee = await this.quoteSyncFee({
            destinationEid: options.destinationEid,
            did: options.did,
            trustScore: 0, // Request doesn't need trust score
        });
        // Simulate transaction
        const { request } = await this.publicClient.simulateContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'requestTrustSync',
            args: [options.destinationEid, didHash],
            value: fee,
            account: this.walletClient.account,
        });
        // Execute transaction
        const hash = await this.walletClient.writeContract(request);
        return { hash };
    }
    /**
     * Sync a trust score to a destination chain
     *
     * Used on the primary chain to push trust scores to secondary chains.
     */
    async syncTrustScore(options) {
        const didHash = this.didToHash(options.did);
        // Get fee quote first
        const fee = await this.quoteSyncFee({
            destinationEid: options.destinationEid,
            did: options.did,
            trustScore: options.trustScore,
        });
        // Simulate transaction
        const { request } = await this.publicClient.simulateContract({
            address: this.config.crossChainSyncAddress,
            abi: CROSS_CHAIN_TRUST_SYNC_ABI,
            functionName: 'syncTrustScore',
            args: [options.destinationEid, didHash, BigInt(options.trustScore)],
            value: fee,
            account: this.walletClient.account,
        });
        // Execute transaction
        const hash = await this.walletClient.writeContract(request);
        return { hash };
    }
    // ============ Chain Registry Methods ============
    /**
     * Get information about a specific chain
     */
    async getChainInfo(chainId) {
        const result = await this.publicClient.readContract({
            address: this.config.chainRegistryAddress,
            abi: CHAIN_REGISTRY_ABI,
            functionName: 'getChain',
            args: [BigInt(chainId)],
        });
        const info = result;
        return {
            chainId: Number(info.chainId),
            name: info.name,
            isTestnet: info.isTestnet,
            isActive: info.isActive,
            trustRegistry: info.trustRegistry,
            usdcAddress: info.usdcAddress,
            endpoint: info.endpoint,
        };
    }
    /**
     * Get all supported chain IDs
     */
    async getSupportedChains() {
        const result = await this.publicClient.readContract({
            address: this.config.chainRegistryAddress,
            abi: CHAIN_REGISTRY_ABI,
            functionName: 'getAllChains',
        });
        return result.map((id) => Number(id));
    }
    /**
     * Check if a chain is supported
     */
    async isChainSupported(chainId) {
        const result = await this.publicClient.readContract({
            address: this.config.chainRegistryAddress,
            abi: CHAIN_REGISTRY_ABI,
            functionName: 'isChainSupported',
            args: [BigInt(chainId)],
        });
        return result;
    }
    // ============ Helper Methods ============
    /**
     * Convert a DID string to bytes32 hash
     */
    didToHash(did) {
        return computeDidHash(did);
    }
    /**
     * Format trust score from basis points to percentage
     */
    formatTrustScore(basisPoints) {
        return basisPoints / 100;
    }
    /**
     * Calculate seconds since last cache update
     */
    getTimeSinceLastUpdate(cachedScore) {
        const now = new Date();
        return Math.floor((now.getTime() - cachedScore.lastUpdated.getTime()) / 1000);
    }
}
//# sourceMappingURL=crosschain.js.map