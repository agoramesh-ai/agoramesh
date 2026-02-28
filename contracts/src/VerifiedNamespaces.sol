// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "./interfaces/IVerifiedNamespaces.sol";

/// @title VerifiedNamespaces - Verified Namespace Registry for AgoraMesh
/// @notice Manages organization namespaces for agent verification
/// @dev Implements IVerifiedNamespaces with ENS-inspired architecture
contract VerifiedNamespaces is IVerifiedNamespaces, AccessControlEnumerable {
    // ============ Constants ============

    /// @notice Role for verifying namespaces
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    /// @notice Minimum namespace name length
    uint256 public constant MIN_NAME_LENGTH = 3;

    /// @notice Maximum namespace name length
    uint256 public constant MAX_NAME_LENGTH = 32;

    /// @notice Maximum metadata key length (bytes)
    uint256 public constant MAX_METADATA_KEY_LENGTH = 64;

    /// @notice Maximum metadata value length (bytes)
    uint256 public constant MAX_METADATA_VALUE_LENGTH = 1024;

    // ============ State Variables ============

    /// @notice Mapping from namespace hash to namespace info
    mapping(bytes32 => NamespaceInfo) private _namespaces;

    /// @notice Mapping from namespace hash to linked agent DIDs
    mapping(bytes32 => bytes32[]) private _linkedAgents;

    /// @notice Mapping from namespace hash to agent DID to index
    mapping(bytes32 => mapping(bytes32 => uint256)) private _agentIndex;

    /// @notice Mapping from namespace hash to agent DID to linked status
    mapping(bytes32 => mapping(bytes32 => bool)) private _isLinked;

    /// @notice Mapping from namespace hash to metadata (key => value)
    mapping(bytes32 => mapping(string => string)) private _metadata;

    /// @notice Mapping from owner to namespace hashes
    mapping(address => bytes32[]) private _ownerNamespaces;

    /// @notice Mapping from owner to namespace hash to index
    mapping(address => mapping(bytes32 => uint256)) private _ownerIndex;

    /// @notice Mapping to track reserved namespaces
    mapping(bytes32 => bool) private _reserved;

    /// @notice Total number of registered namespaces
    uint256 private _totalNamespaces;

    /// @notice Number of verified namespaces
    uint256 private _verifiedCount;

    // ============ Errors ============

    error InvalidAdmin();
    error InvalidNamespaceName();
    error NamespaceAlreadyExists();
    error NamespaceNotFound();
    error NamespaceReserved();
    error NotNamespaceOwner();
    error InvalidAddress();
    error AgentAlreadyLinked();
    error AgentNotLinked();
    error NamespaceNotActive();
    error InvalidNameCharacter();
    error MetadataKeyTooLong();
    error MetadataValueTooLong();

    // ============ Constructor ============

    /// @notice Initialize the VerifiedNamespaces contract
    /// @param _admin Address of the admin
    constructor(address _admin) {
        if (_admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Registration Functions ============

    /// @inheritdoc IVerifiedNamespaces
    function registerNamespace(string calldata name) external override {
        bytes32 nsHash = _validateAndHashName(name);

        if (_namespaces[nsHash].owner != address(0)) revert NamespaceAlreadyExists();
        if (_reserved[nsHash]) revert NamespaceReserved();

        _namespaces[nsHash] = NamespaceInfo({
            namespaceHash: nsHash,
            owner: msg.sender,
            name: _toLowercase(name),
            isVerified: false,
            isActive: true,
            registeredAt: block.timestamp,
            verifiedAt: 0
        });

        // Track owner's namespaces
        _ownerIndex[msg.sender][nsHash] = _ownerNamespaces[msg.sender].length;
        _ownerNamespaces[msg.sender].push(nsHash);

        _totalNamespaces++;

        emit NamespaceRegistered(nsHash, msg.sender, name);
    }

    /// @inheritdoc IVerifiedNamespaces
    function transferNamespace(string calldata name, address to) external override {
        if (to == address(0)) revert InvalidAddress();

        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (ns.owner != msg.sender) revert NotNamespaceOwner();

        address from = ns.owner;

        // Remove from previous owner's list
        _removeFromOwnerList(from, nsHash);

        // Add to new owner's list
        _ownerIndex[to][nsHash] = _ownerNamespaces[to].length;
        _ownerNamespaces[to].push(nsHash);

        // Update owner
        ns.owner = to;

        emit NamespaceTransferred(nsHash, from, to);
    }

    /// @inheritdoc IVerifiedNamespaces
    function verifyNamespace(string calldata name) external override onlyRole(VERIFIER_ROLE) {
        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (!ns.isVerified) {
            ns.isVerified = true;
            ns.verifiedAt = block.timestamp;
            _verifiedCount++;
        }

        emit NamespaceVerified(nsHash, msg.sender);
    }

    /// @inheritdoc IVerifiedNamespaces
    function revokeNamespace(string calldata name) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (ns.isActive) {
            ns.isActive = false;
            if (ns.isVerified) {
                _verifiedCount--;
            }
        }

        emit NamespaceRevoked(nsHash);
    }

    /// @inheritdoc IVerifiedNamespaces
    function reserveNamespace(string calldata name) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 nsHash = _validateAndHashName(name);
        _reserved[nsHash] = true;
    }

    // ============ Agent Linking Functions ============

    /// @inheritdoc IVerifiedNamespaces
    function linkAgent(string calldata name, bytes32 didHash) external override {
        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (ns.owner != msg.sender) revert NotNamespaceOwner();
        if (!ns.isActive) revert NamespaceNotActive();
        if (_isLinked[nsHash][didHash]) revert AgentAlreadyLinked();

        _agentIndex[nsHash][didHash] = _linkedAgents[nsHash].length;
        _linkedAgents[nsHash].push(didHash);
        _isLinked[nsHash][didHash] = true;

        emit AgentLinked(nsHash, didHash);
    }

    /// @inheritdoc IVerifiedNamespaces
    function unlinkAgent(string calldata name, bytes32 didHash) external override {
        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (ns.owner != msg.sender) revert NotNamespaceOwner();
        if (!_isLinked[nsHash][didHash]) revert AgentNotLinked();

        // Remove agent using swap-and-pop
        uint256 index = _agentIndex[nsHash][didHash];
        uint256 lastIndex = _linkedAgents[nsHash].length - 1;

        if (index != lastIndex) {
            bytes32 lastDid = _linkedAgents[nsHash][lastIndex];
            _linkedAgents[nsHash][index] = lastDid;
            _agentIndex[nsHash][lastDid] = index;
        }

        _linkedAgents[nsHash].pop();
        delete _agentIndex[nsHash][didHash];
        _isLinked[nsHash][didHash] = false;

        emit AgentUnlinked(nsHash, didHash);
    }

    // ============ Metadata Functions ============

    /// @inheritdoc IVerifiedNamespaces
    function setMetadata(string calldata name, string calldata key, string calldata value) external override {
        if (bytes(key).length > MAX_METADATA_KEY_LENGTH) revert MetadataKeyTooLong();
        if (bytes(value).length > MAX_METADATA_VALUE_LENGTH) revert MetadataValueTooLong();

        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _getNamespace(nsHash);

        if (ns.owner != msg.sender) revert NotNamespaceOwner();

        _metadata[nsHash][key] = value;

        emit MetadataUpdated(nsHash, key, value);
    }

    /// @inheritdoc IVerifiedNamespaces
    function getMetadata(string calldata name, string calldata key)
        external
        view
        override
        returns (string memory value)
    {
        bytes32 nsHash = _validateAndHashName(name);
        return _metadata[nsHash][key];
    }

    // ============ View Functions ============

    /// @inheritdoc IVerifiedNamespaces
    function getNamespace(string calldata name)
        external
        view
        override
        returns (
            address owner,
            string memory nameStr,
            bool verified,
            bool active,
            uint256 registeredAt,
            uint256 linkedAgents
        )
    {
        bytes32 nsHash = _validateAndHashName(name);
        NamespaceInfo storage ns = _namespaces[nsHash];

        return (ns.owner, ns.name, ns.isVerified, ns.isActive, ns.registeredAt, _linkedAgents[nsHash].length);
    }

    /// @inheritdoc IVerifiedNamespaces
    function isNamespaceAvailable(string calldata name) external view override returns (bool) {
        bytes32 nsHash = _validateAndHashName(name);
        return _namespaces[nsHash].owner == address(0) && !_reserved[nsHash];
    }

    /// @inheritdoc IVerifiedNamespaces
    function isAgentLinked(string calldata name, bytes32 didHash) external view override returns (bool) {
        bytes32 nsHash = _validateAndHashName(name);
        return _isLinked[nsHash][didHash];
    }

    /// @inheritdoc IVerifiedNamespaces
    function getLinkedAgents(string calldata name) external view override returns (bytes32[] memory) {
        bytes32 nsHash = _validateAndHashName(name);
        return _linkedAgents[nsHash];
    }

    /// @inheritdoc IVerifiedNamespaces
    function getNamespacesByOwner(address owner) external view override returns (bytes32[] memory) {
        return _ownerNamespaces[owner];
    }

    /// @inheritdoc IVerifiedNamespaces
    function getNamespaceHash(string calldata name) external pure override returns (bytes32) {
        return _validateAndHashName(name);
    }

    /// @inheritdoc IVerifiedNamespaces
    function totalNamespaces() external view override returns (uint256) {
        return _totalNamespaces;
    }

    /// @inheritdoc IVerifiedNamespaces
    function verifiedNamespacesCount() external view override returns (uint256) {
        return _verifiedCount;
    }

    // ============ Internal Functions ============

    /// @notice Validate namespace name and return hash
    /// @param name The namespace name
    /// @return The hash of the normalized name
    function _validateAndHashName(string calldata name) internal pure returns (bytes32) {
        bytes memory nameBytes = bytes(name);
        uint256 len = nameBytes.length;

        if (len < MIN_NAME_LENGTH || len > MAX_NAME_LENGTH) {
            revert InvalidNamespaceName();
        }

        // Normalize to lowercase, validate characters, and hash in a single pass
        bytes memory normalized = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            bytes1 char = nameBytes[i];
            // Convert uppercase to lowercase
            if (char >= 0x41 && char <= 0x5A) {
                char = bytes1(uint8(char) + 32);
            }
            // Validate: must be [a-z0-9-]
            bool isLowerAlpha = (char >= 0x61 && char <= 0x7A);
            bool isDigit = (char >= 0x30 && char <= 0x39);
            bool isHyphen = (char == 0x2D);
            if (!isLowerAlpha && !isDigit && !isHyphen) {
                revert InvalidNameCharacter();
            }
            normalized[i] = char;
        }

        return keccak256(normalized);
    }

    /// @notice Normalize a string to lowercase
    /// @dev Delegates to _validateAndHashName for validation, then builds the lowercase result.
    ///      We keep this as a separate function since _validateAndHashName returns a hash, not the string.
    /// @param str The input string
    /// @return The lowercase string
    function _toLowercase(string calldata str) internal pure returns (string memory) {
        bytes memory strBytes = bytes(str);
        bytes memory result = new bytes(strBytes.length);

        for (uint256 i = 0; i < strBytes.length; i++) {
            bytes1 char = strBytes[i];
            if (char >= 0x41 && char <= 0x5A) {
                result[i] = bytes1(uint8(char) + 32);
            } else {
                result[i] = char;
            }
        }

        return string(result);
    }

    /// @notice Get namespace by hash, revert if not found
    /// @param nsHash The namespace hash
    /// @return The namespace info
    function _getNamespace(bytes32 nsHash) internal view returns (NamespaceInfo storage) {
        NamespaceInfo storage ns = _namespaces[nsHash];
        if (ns.owner == address(0)) revert NamespaceNotFound();
        return ns;
    }

    /// @notice Remove namespace from owner's list
    /// @param owner The owner address
    /// @param nsHash The namespace hash
    function _removeFromOwnerList(address owner, bytes32 nsHash) internal {
        uint256 index = _ownerIndex[owner][nsHash];
        uint256 lastIndex = _ownerNamespaces[owner].length - 1;

        if (index != lastIndex) {
            bytes32 lastHash = _ownerNamespaces[owner][lastIndex];
            _ownerNamespaces[owner][index] = lastHash;
            _ownerIndex[owner][lastHash] = index;
        }

        _ownerNamespaces[owner].pop();
        delete _ownerIndex[owner][nsHash];
    }
}
