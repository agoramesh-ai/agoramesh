// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "./interfaces/IChainRegistry.sol";

/// @title ChainRegistry - Multi-Chain Registry for AgentMe
/// @notice Manages supported blockchain networks and their configurations
/// @dev Implements IChainRegistry with AccessControl for role-based permissions
contract ChainRegistry is IChainRegistry, AccessControlEnumerable {
    // ============ State Variables ============

    /// @notice Mapping from chain ID to chain info
    mapping(uint64 => ChainInfo) private _chains;

    /// @notice Array of all supported chain IDs
    uint64[] private _chainIds;

    /// @notice Mapping to track chain index in _chainIds array
    mapping(uint64 => uint256) private _chainIndex;

    /// @notice Mapping to check if chain exists
    mapping(uint64 => bool) private _chainExists;

    // ============ Errors ============

    error InvalidAdmin();
    error InvalidChainName();
    error ChainAlreadyExists();
    error ChainNotFound();
    error InvalidAddress();

    // ============ Constructor ============

    /// @notice Initialize the ChainRegistry
    /// @param _admin Address of the admin
    constructor(address _admin) {
        if (_admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Chain Management Functions ============

    /// @inheritdoc IChainRegistry
    function addChain(uint64 chainId, string calldata name, bool isTestnet)
        external
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (bytes(name).length == 0) revert InvalidChainName();
        if (_chainExists[chainId]) revert ChainAlreadyExists();

        _chains[chainId] = ChainInfo({
            chainId: chainId,
            name: name,
            isTestnet: isTestnet,
            isActive: true,
            trustRegistry: address(0),
            usdcAddress: address(0),
            endpoint: address(0)
        });

        _chainIndex[chainId] = _chainIds.length;
        _chainIds.push(chainId);
        _chainExists[chainId] = true;

        emit ChainAdded(chainId, name, isTestnet);
    }

    /// @inheritdoc IChainRegistry
    function removeChain(uint64 chainId) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();

        // Remove from array by swapping with last element
        uint256 index = _chainIndex[chainId];
        uint256 lastIndex = _chainIds.length - 1;

        if (index != lastIndex) {
            uint64 lastChainId = _chainIds[lastIndex];
            _chainIds[index] = lastChainId;
            _chainIndex[lastChainId] = index;
        }

        _chainIds.pop();
        delete _chainIndex[chainId];
        delete _chains[chainId];
        _chainExists[chainId] = false;

        emit ChainRemoved(chainId);
    }

    /// @inheritdoc IChainRegistry
    function deactivateChain(uint64 chainId) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();
        _chains[chainId].isActive = false;
        emit ChainUpdated(chainId);
    }

    /// @inheritdoc IChainRegistry
    function activateChain(uint64 chainId) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();
        _chains[chainId].isActive = true;
        emit ChainUpdated(chainId);
    }

    // ============ Address Management Functions ============

    /// @inheritdoc IChainRegistry
    function setTrustRegistry(uint64 chainId, address trustRegistry) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();
        if (trustRegistry == address(0)) revert InvalidAddress();

        _chains[chainId].trustRegistry = trustRegistry;

        emit TrustRegistrySet(chainId, trustRegistry);
    }

    /// @inheritdoc IChainRegistry
    function setUSDCAddress(uint64 chainId, address usdcAddress) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();
        if (usdcAddress == address(0)) revert InvalidAddress();

        _chains[chainId].usdcAddress = usdcAddress;

        emit USDCAddressSet(chainId, usdcAddress);
    }

    /// @inheritdoc IChainRegistry
    function setEndpoint(uint64 chainId, address endpoint) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_chainExists[chainId]) revert ChainNotFound();
        if (endpoint == address(0)) revert InvalidAddress();

        _chains[chainId].endpoint = endpoint;

        emit EndpointSet(chainId, endpoint);
    }

    // ============ View Functions ============

    /// @inheritdoc IChainRegistry
    function getChain(uint64 chainId)
        external
        view
        override
        returns (uint64 chainId_, string memory name, bool isTestnet, bool isActive)
    {
        ChainInfo storage info = _chains[chainId];
        return (info.chainId, info.name, info.isTestnet, info.isActive);
    }

    /// @inheritdoc IChainRegistry
    function getTrustRegistry(uint64 chainId) external view override returns (address) {
        return _chains[chainId].trustRegistry;
    }

    /// @inheritdoc IChainRegistry
    function getUSDCAddress(uint64 chainId) external view override returns (address) {
        return _chains[chainId].usdcAddress;
    }

    /// @inheritdoc IChainRegistry
    function getEndpoint(uint64 chainId) external view override returns (address) {
        return _chains[chainId].endpoint;
    }

    /// @inheritdoc IChainRegistry
    function getAllChains() external view override returns (uint64[] memory) {
        return _chainIds;
    }

    /// @inheritdoc IChainRegistry
    function getActiveChains() external view override returns (uint64[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (_chains[_chainIds[i]].isActive) {
                count++;
            }
        }

        uint64[] memory activeChains = new uint64[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (_chains[_chainIds[i]].isActive) {
                activeChains[index] = _chainIds[i];
                index++;
            }
        }

        return activeChains;
    }

    /// @inheritdoc IChainRegistry
    function getTestnets() external view override returns (uint64[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (_chains[_chainIds[i]].isTestnet) {
                count++;
            }
        }

        uint64[] memory testnets = new uint64[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (_chains[_chainIds[i]].isTestnet) {
                testnets[index] = _chainIds[i];
                index++;
            }
        }

        return testnets;
    }

    /// @inheritdoc IChainRegistry
    function getMainnets() external view override returns (uint64[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (!_chains[_chainIds[i]].isTestnet) {
                count++;
            }
        }

        uint64[] memory mainnets = new uint64[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < _chainIds.length; i++) {
            if (!_chains[_chainIds[i]].isTestnet) {
                mainnets[index] = _chainIds[i];
                index++;
            }
        }

        return mainnets;
    }

    /// @inheritdoc IChainRegistry
    function isChainSupported(uint64 chainId) external view override returns (bool) {
        return _chainExists[chainId];
    }

    /// @inheritdoc IChainRegistry
    function chainCount() external view override returns (uint256) {
        return _chainIds.length;
    }
}
