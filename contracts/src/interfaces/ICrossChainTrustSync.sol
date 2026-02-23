// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICrossChainTrustSync - Interface for Cross-Chain Trust Synchronization
/// @notice Manages synchronization of trust scores across chains using LayerZero V2
/// @dev Part of the AgoraMesh multi-chain infrastructure
interface ICrossChainTrustSync {
    // ============ Structs ============

    /// @notice Cached trust score from another chain
    struct CachedTrustScore {
        uint256 trustScore; // Trust score (0-10000)
        uint256 timestamp; // When the score was recorded
        uint32 srcEid; // Source chain endpoint ID
        bool exists; // Whether the cache entry exists
    }

    // ============ Events ============

    /// @notice Emitted when a trust sync is requested
    event TrustSyncRequested(bytes32 indexed didHash, uint32 dstEid, uint256 trustScore);

    /// @notice Emitted when a trust sync is received
    event TrustSyncReceived(bytes32 indexed didHash, uint32 srcEid, uint256 trustScore);

    /// @notice Emitted when a peer is set
    event PeerSet(uint32 indexed eid, bytes32 peer);

    /// @notice Emitted when the primary chain is set
    event PrimaryChainSet(uint64 indexed chainId);

    /// @notice Emitted when cache TTL is updated
    event CacheTTLUpdated(uint256 newTTL);

    // ============ Configuration ============

    /// @notice Set the primary chain (canonical source of trust)
    /// @param chainId Chain ID to set as primary
    function setPrimaryChain(uint64 chainId) external;

    /// @notice Set a peer contract on another chain
    /// @param eid LayerZero endpoint ID
    /// @param peer Peer contract address (as bytes32)
    function setPeer(uint32 eid, bytes32 peer) external;

    /// @notice Set the cache time-to-live
    /// @param ttl Time in seconds before cache is considered stale
    function setCacheTTL(uint256 ttl) external;

    // ============ Trust Sync Functions ============

    /// @notice Request trust score sync to a destination chain
    /// @param dstEid Destination endpoint ID
    /// @param didHash Agent DID hash
    /// @param trustScore Current trust score
    function requestSync(uint32 dstEid, bytes32 didHash, uint256 trustScore) external;

    /// @notice Cache a trust score locally (for testing/oracle use)
    /// @param didHash Agent DID hash
    /// @param trustScore Trust score to cache
    /// @param timestamp Timestamp of the score
    function cacheTrustScore(bytes32 didHash, uint256 trustScore, uint256 timestamp) external;

    /// @notice Batch cache multiple trust scores
    /// @param didHashes Array of DID hashes
    /// @param trustScores Array of trust scores
    /// @param timestamps Array of timestamps
    function batchCacheTrustScores(
        bytes32[] calldata didHashes,
        uint256[] calldata trustScores,
        uint256[] calldata timestamps
    ) external;

    // ============ Query Functions ============

    /// @notice Get cached trust score for an agent
    /// @param didHash Agent DID hash
    /// @return trustScore The cached trust score
    /// @return timestamp When the score was recorded
    /// @return exists Whether the cache entry exists
    function getCachedTrustScore(bytes32 didHash)
        external
        view
        returns (uint256 trustScore, uint256 timestamp, bool exists);

    /// @notice Get aggregated trust score across all cached sources
    /// @param didHash Agent DID hash
    /// @return Aggregated trust score
    function getAggregatedTrustScore(bytes32 didHash) external view returns (uint256);

    /// @notice Check if cache is stale for an agent
    /// @param didHash Agent DID hash
    /// @return Whether the cache is stale
    function isCacheStale(bytes32 didHash) external view returns (bool);

    /// @notice Quote the fee for syncing trust score
    /// @param dstEid Destination endpoint ID
    /// @param didHash Agent DID hash
    /// @param trustScore Trust score to sync
    /// @return nativeFee Fee in native token
    function quoteSyncFee(uint32 dstEid, bytes32 didHash, uint256 trustScore) external view returns (uint256 nativeFee);

    // ============ View Functions ============

    /// @notice Check if this chain is the primary chain
    /// @return Whether this is the primary chain
    function isPrimaryChain() external view returns (bool);

    /// @notice Get all supported destination endpoint IDs
    /// @return Array of endpoint IDs with configured peers
    function getSupportedDestinations() external view returns (uint32[] memory);

    /// @notice Get the cache TTL
    /// @return TTL in seconds
    function cacheTTL() external view returns (uint256);

    /// @notice Get the primary chain ID
    /// @return Chain ID
    function primaryChainId() external view returns (uint64);
}
