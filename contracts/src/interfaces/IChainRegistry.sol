// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IChainRegistry - Interface for Multi-Chain Registry
/// @notice Manages supported blockchain networks for AgentMe
/// @dev Part of the AgentMe multi-chain infrastructure
interface IChainRegistry {
    // ============ Structs ============

    /// @notice Information about a supported chain
    struct ChainInfo {
        uint64 chainId; // EVM chain ID
        string name; // Human-readable name
        bool isTestnet; // Whether this is a testnet
        bool isActive; // Whether the chain is currently active
        address trustRegistry; // TrustRegistry contract address on this chain
        address usdcAddress; // USDC token address on this chain
        address endpoint; // LayerZero endpoint address
    }

    // ============ Events ============

    /// @notice Emitted when a new chain is added
    event ChainAdded(uint64 indexed chainId, string name, bool isTestnet);

    /// @notice Emitted when a chain is removed
    event ChainRemoved(uint64 indexed chainId);

    /// @notice Emitted when a chain is updated
    event ChainUpdated(uint64 indexed chainId);

    /// @notice Emitted when a TrustRegistry address is set
    event TrustRegistrySet(uint64 indexed chainId, address trustRegistry);

    /// @notice Emitted when a USDC address is set
    event USDCAddressSet(uint64 indexed chainId, address usdcAddress);

    /// @notice Emitted when a LayerZero endpoint is set
    event EndpointSet(uint64 indexed chainId, address endpoint);

    // ============ Chain Management ============

    /// @notice Add a new supported chain
    /// @param chainId EVM chain ID
    /// @param name Human-readable chain name
    /// @param isTestnet Whether this is a testnet
    function addChain(uint64 chainId, string calldata name, bool isTestnet) external;

    /// @notice Remove a supported chain
    /// @param chainId Chain ID to remove
    function removeChain(uint64 chainId) external;

    /// @notice Deactivate a chain (keeps data but marks inactive)
    /// @param chainId Chain ID to deactivate
    function deactivateChain(uint64 chainId) external;

    /// @notice Activate a previously deactivated chain
    /// @param chainId Chain ID to activate
    function activateChain(uint64 chainId) external;

    // ============ Address Management ============

    /// @notice Set the TrustRegistry address for a chain
    /// @param chainId Chain ID
    /// @param trustRegistry TrustRegistry contract address
    function setTrustRegistry(uint64 chainId, address trustRegistry) external;

    /// @notice Set the USDC address for a chain
    /// @param chainId Chain ID
    /// @param usdcAddress USDC token address
    function setUSDCAddress(uint64 chainId, address usdcAddress) external;

    /// @notice Set the LayerZero endpoint for a chain
    /// @param chainId Chain ID
    /// @param endpoint LayerZero endpoint address
    function setEndpoint(uint64 chainId, address endpoint) external;

    // ============ View Functions ============

    /// @notice Get chain information
    /// @param chainId Chain ID to query
    /// @return chainId_ The chain ID
    /// @return name The chain name
    /// @return isTestnet Whether it's a testnet
    /// @return isActive Whether the chain is active
    function getChain(uint64 chainId)
        external
        view
        returns (uint64 chainId_, string memory name, bool isTestnet, bool isActive);

    /// @notice Get the TrustRegistry address for a chain
    /// @param chainId Chain ID
    /// @return TrustRegistry address
    function getTrustRegistry(uint64 chainId) external view returns (address);

    /// @notice Get the USDC address for a chain
    /// @param chainId Chain ID
    /// @return USDC address
    function getUSDCAddress(uint64 chainId) external view returns (address);

    /// @notice Get the LayerZero endpoint for a chain
    /// @param chainId Chain ID
    /// @return Endpoint address
    function getEndpoint(uint64 chainId) external view returns (address);

    /// @notice Get all supported chain IDs
    /// @return Array of chain IDs
    function getAllChains() external view returns (uint64[] memory);

    /// @notice Get all active chain IDs
    /// @return Array of active chain IDs
    function getActiveChains() external view returns (uint64[] memory);

    /// @notice Get all testnet chain IDs
    /// @return Array of testnet chain IDs
    function getTestnets() external view returns (uint64[] memory);

    /// @notice Get all mainnet chain IDs
    /// @return Array of mainnet chain IDs
    function getMainnets() external view returns (uint64[] memory);

    /// @notice Check if a chain is supported
    /// @param chainId Chain ID to check
    /// @return Whether the chain is supported
    function isChainSupported(uint64 chainId) external view returns (bool);

    /// @notice Get the total number of supported chains
    /// @return Number of chains
    function chainCount() external view returns (uint256);
}
