// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifiedNamespaces - Interface for Verified Namespace Registry
/// @notice Manages organization namespaces for agent verification
/// @dev Part of the AgentMe trust layer, inspired by ENS
interface IVerifiedNamespaces {
    // ============ Structs ============

    /// @notice Information about a registered namespace
    struct NamespaceInfo {
        bytes32 namespaceHash; // Hash of the normalized namespace name
        address owner; // Owner of the namespace
        string name; // Original namespace name
        bool isVerified; // Whether officially verified
        bool isActive; // Whether the namespace is active
        uint256 registeredAt; // Registration timestamp
        uint256 verifiedAt; // Verification timestamp (0 if not verified)
    }

    // ============ Events ============

    /// @notice Emitted when a namespace is registered
    event NamespaceRegistered(bytes32 indexed namespaceHash, address indexed owner, string name);

    /// @notice Emitted when a namespace is transferred
    event NamespaceTransferred(bytes32 indexed namespaceHash, address indexed from, address indexed to);

    /// @notice Emitted when a namespace is verified
    event NamespaceVerified(bytes32 indexed namespaceHash, address indexed verifier);

    /// @notice Emitted when a namespace is revoked
    event NamespaceRevoked(bytes32 indexed namespaceHash);

    /// @notice Emitted when an agent is linked to a namespace
    event AgentLinked(bytes32 indexed namespaceHash, bytes32 indexed didHash);

    /// @notice Emitted when an agent is unlinked from a namespace
    event AgentUnlinked(bytes32 indexed namespaceHash, bytes32 indexed didHash);

    /// @notice Emitted when namespace metadata is updated
    event MetadataUpdated(bytes32 indexed namespaceHash, string key, string value);

    /// @notice Emitted when registration fee is updated
    event RegistrationFeeSet(uint256 fee);

    /// @notice Emitted when verification fee is updated
    event VerificationFeeSet(uint256 fee);

    // ============ Registration Functions ============

    /// @notice Register a new namespace
    /// @param name The namespace name to register
    function registerNamespace(string calldata name) external;

    /// @notice Transfer namespace ownership
    /// @param name The namespace name
    /// @param to The new owner address
    function transferNamespace(string calldata name, address to) external;

    /// @notice Verify a namespace (verifier only)
    /// @param name The namespace name to verify
    function verifyNamespace(string calldata name) external;

    /// @notice Revoke a namespace (admin only)
    /// @param name The namespace name to revoke
    function revokeNamespace(string calldata name) external;

    /// @notice Reserve a namespace (admin only, prevents registration)
    /// @param name The namespace name to reserve
    function reserveNamespace(string calldata name) external;

    // ============ Agent Linking Functions ============

    /// @notice Link an agent to a namespace
    /// @param name The namespace name
    /// @param didHash The agent's DID hash
    function linkAgent(string calldata name, bytes32 didHash) external;

    /// @notice Unlink an agent from a namespace
    /// @param name The namespace name
    /// @param didHash The agent's DID hash
    function unlinkAgent(string calldata name, bytes32 didHash) external;

    // ============ Metadata Functions ============

    /// @notice Set metadata for a namespace
    /// @param name The namespace name
    /// @param key The metadata key
    /// @param value The metadata value
    function setMetadata(string calldata name, string calldata key, string calldata value) external;

    /// @notice Get metadata for a namespace
    /// @param name The namespace name
    /// @param key The metadata key
    /// @return value The metadata value
    function getMetadata(string calldata name, string calldata key) external view returns (string memory value);

    // ============ View Functions ============

    /// @notice Get namespace information
    /// @param name The namespace name
    /// @return owner The namespace owner
    /// @return nameStr The namespace name
    /// @return verified Whether the namespace is verified
    /// @return active Whether the namespace is active
    /// @return registeredAt Registration timestamp
    /// @return linkedAgents Number of linked agents
    function getNamespace(string calldata name)
        external
        view
        returns (
            address owner,
            string memory nameStr,
            bool verified,
            bool active,
            uint256 registeredAt,
            uint256 linkedAgents
        );

    /// @notice Check if a namespace is available
    /// @param name The namespace name
    /// @return Whether the namespace is available
    function isNamespaceAvailable(string calldata name) external view returns (bool);

    /// @notice Check if an agent is linked to a namespace
    /// @param name The namespace name
    /// @param didHash The agent's DID hash
    /// @return Whether the agent is linked
    function isAgentLinked(string calldata name, bytes32 didHash) external view returns (bool);

    /// @notice Get all agents linked to a namespace
    /// @param name The namespace name
    /// @return Array of linked agent DID hashes
    function getLinkedAgents(string calldata name) external view returns (bytes32[] memory);

    /// @notice Get all namespaces owned by an address
    /// @param owner The owner address
    /// @return Array of namespace hashes
    function getNamespacesByOwner(address owner) external view returns (bytes32[] memory);

    /// @notice Get the hash for a namespace name
    /// @param name The namespace name
    /// @return The namespace hash
    function getNamespaceHash(string calldata name) external pure returns (bytes32);

    /// @notice Get total number of registered namespaces
    /// @return Total namespaces
    function totalNamespaces() external view returns (uint256);

    /// @notice Get number of verified namespaces
    /// @return Verified namespaces count
    function verifiedNamespacesCount() external view returns (uint256);
}
