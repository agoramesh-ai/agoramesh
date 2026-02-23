// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC8004IdentityRegistry - ERC-8004 Identity Registry Interface
/// @notice Manages agent identity registration with ERC-721 + URIStorage semantics
/// @dev Part of the ERC-8004 Trustless Agents standard (launched January 2026).
///      AgoraMesh implements this via a read-only adapter that maps our TrustRegistry
///      and AgentToken data into the ERC-8004 shape.
interface IERC8004IdentityRegistry {
    // ============ Events ============

    /// @notice Emitted when a new agent is registered
    /// @param agentId The unique identifier assigned to the agent (ERC-721 token ID)
    /// @param agentURI The URI pointing to the agent's metadata (e.g., IPFS CID)
    /// @param owner The address that owns the registered agent
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @notice Emitted when an agent's URI is updated
    /// @param agentId The agent whose URI was updated
    /// @param newURI The new metadata URI
    /// @param updatedBy The address that performed the update
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    /// @notice Emitted when metadata is set for an agent
    /// @param agentId The agent whose metadata was set
    /// @param indexedMetadataKey The metadata key (indexed for filtering)
    /// @param metadataKey The metadata key (non-indexed, for reading)
    /// @param metadataValue The raw metadata value
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    // ============ Registration Functions ============

    /// @notice Register a new agent identity and mint an ERC-721 token
    /// @param agentURI The URI pointing to the agent's metadata
    /// @return agentId The unique identifier assigned to the newly registered agent
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice Update the metadata URI for an existing agent
    /// @param agentId The agent whose URI should be updated
    /// @param newURI The new metadata URI
    function setAgentURI(uint256 agentId, string calldata newURI) external;

    // ============ Metadata Functions ============

    /// @notice Retrieve arbitrary metadata for an agent by key
    /// @param agentId The agent to query
    /// @param metadataKey The key identifying the metadata field
    /// @return The raw metadata value as bytes
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);

    /// @notice Set arbitrary metadata for an agent
    /// @param agentId The agent to update
    /// @param metadataKey The key identifying the metadata field
    /// @param metadataValue The raw metadata value to store
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;

    // ============ View Functions ============

    /// @notice Get the wallet address associated with an agent
    /// @param agentId The agent to query
    /// @return The wallet address of the agent's owner
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @title IERC8004ReputationRegistry - ERC-8004 Reputation Registry Interface
/// @notice Manages feedback and reputation summaries for registered agents
/// @dev Linked to an IERC8004IdentityRegistry instance. Feedback is indexed by
///      (agentId, clientAddress) pairs with per-client sequential indices.
interface IERC8004ReputationRegistry {
    // ============ Events ============

    /// @notice Emitted when new feedback is submitted for an agent
    /// @param agentId The agent receiving feedback
    /// @param clientAddress The client submitting the feedback
    /// @param feedbackIndex Sequential index of this feedback for the (agentId, clientAddress) pair
    /// @param value The feedback score (signed, supports negative feedback)
    /// @param valueDecimals Number of decimal places in the value
    /// @param indexedTag1 Primary tag (indexed for efficient filtering)
    /// @param tag1 Primary tag (non-indexed, for reading)
    /// @param tag2 Secondary tag for additional categorization
    /// @param endpoint The service endpoint the feedback relates to
    /// @param feedbackURI URI pointing to detailed feedback data (e.g., IPFS)
    /// @param feedbackHash Hash of the feedback content for integrity verification
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    /// @notice Emitted when a previously submitted feedback is revoked
    /// @param agentId The agent whose feedback was revoked
    /// @param clientAddress The client who revoked the feedback
    /// @param feedbackIndex The index of the revoked feedback
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex);

    // ============ View Functions ============

    /// @notice Get the address of the linked Identity Registry
    /// @return The address of the IERC8004IdentityRegistry contract
    function getIdentityRegistry() external view returns (address);

    /// @notice Get an aggregated reputation summary for an agent
    /// @param agentId The agent to query
    /// @param clientAddresses Filter by specific client addresses (empty array for all clients)
    /// @param tag1 Filter by primary tag (empty string for all tags)
    /// @param tag2 Filter by secondary tag (empty string for all tags)
    /// @return count Total number of matching feedback entries
    /// @return summaryValue Aggregated feedback score
    /// @return summaryValueDecimals Number of decimal places in summaryValue
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    /// @notice Read a specific feedback entry
    /// @param agentId The agent to query
    /// @param clientAddress The client who submitted the feedback
    /// @param feedbackIndex The sequential index of the feedback
    /// @return value The feedback score
    /// @return valueDecimals Number of decimal places in the value
    /// @return tag1 Primary tag
    /// @return tag2 Secondary tag
    /// @return isRevoked Whether this feedback has been revoked
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    /// @notice Get all client addresses that have submitted feedback for an agent
    /// @param agentId The agent to query
    /// @return Array of client addresses
    function getClients(uint256 agentId) external view returns (address[] memory);

    /// @notice Get the last feedback index for a specific (agentId, clientAddress) pair
    /// @param agentId The agent to query
    /// @param clientAddress The client to query
    /// @return The last sequential feedback index (0 if no feedback exists)
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}

/// @title IERC8004ValidationRegistry - ERC-8004 Validation Registry Interface
/// @notice Manages third-party validation attestations for registered agents
/// @dev Linked to an IERC8004IdentityRegistry instance. Validations are identified
///      by request hashes and can be queried per-agent or per-validator.
interface IERC8004ValidationRegistry {
    // ============ Events ============

    /// @notice Emitted when a validator submits a validation response for an agent
    /// @param validatorAddress The address of the validator
    /// @param agentId The agent being validated
    /// @param requestHash Unique hash identifying the validation request
    /// @param response The validation response code (0 = pending, 1 = valid, 2 = invalid, 3 = inconclusive)
    /// @param responseURI URI pointing to detailed response data
    /// @param responseHash Hash of the response content for integrity verification
    /// @param tag Category tag for the validation
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    /// @notice Emitted when a validation is requested for an agent
    /// @param requesterAddress The address requesting the validation
    /// @param agentId The agent to be validated
    /// @param requestHash Unique hash identifying the validation request
    /// @param tag Category tag for the validation
    event ValidationRequest(
        address indexed requesterAddress, uint256 indexed agentId, bytes32 indexed requestHash, string tag
    );

    // ============ View Functions ============

    /// @notice Get the address of the linked Identity Registry
    /// @return The address of the IERC8004IdentityRegistry contract
    function getIdentityRegistry() external view returns (address);

    /// @notice Get the current status of a validation request
    /// @param requestHash The unique hash identifying the validation request
    /// @return validatorAddress The address of the validator who responded
    /// @return agentId The agent that was validated
    /// @return response The validation response code
    /// @return responseHash Hash of the response content
    /// @return tag Category tag for the validation
    /// @return lastUpdate Timestamp of the last update to this validation
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    /// @notice Get an aggregated validation summary for an agent
    /// @param agentId The agent to query
    /// @param validatorAddresses Filter by specific validators (empty array for all)
    /// @param tag Filter by category tag (empty string for all)
    /// @return count Total number of matching validations
    /// @return averageResponse Average response code across matching validations
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    /// @notice Get all validation request hashes associated with an agent
    /// @param agentId The agent to query
    /// @return Array of validation request hashes
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);
}
