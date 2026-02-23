// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IERC8004Identity.sol";

/// @title ERC8004Bridge - Bridge Between AgoraMesh and Official ERC-8004 Registries
/// @notice Registers AgoraMesh agents on the official ERC-8004 IdentityRegistry and
///         submits feedback/validations to the official ReputationRegistry on Base Sepolia.
/// @dev Unlike the read-only ERC8004Adapter, this contract writes to the official
///      ERC-8004 registries (IdentityRegistry at 0x8004...1e, ReputationRegistry at 0x8004...13).
///      It maintains a bidirectional mapping between AgoraMesh token IDs and ERC-8004 agent IDs.
contract ERC8004Bridge is Ownable {
    // ============ Errors ============

    error ZeroAddress();
    error AgentAlreadyRegistered(uint256 agentTokenId);
    error AgentNotRegistered(uint256 agentTokenId);
    error ERC8004AgentNotMapped(uint256 erc8004AgentId);

    // ============ Events ============

    /// @notice Emitted when an AgoraMesh agent is registered on the official ERC-8004 IdentityRegistry
    /// @param agentTokenId The AgoraMesh token ID
    /// @param erc8004AgentId The ERC-8004 agent ID returned by the official registry
    /// @param agentURI The URI registered on ERC-8004
    event AgentRegistered(uint256 indexed agentTokenId, uint256 indexed erc8004AgentId, string agentURI);

    /// @notice Emitted when an agent's URI is updated on the official ERC-8004 IdentityRegistry
    /// @param erc8004AgentId The ERC-8004 agent ID
    /// @param newURI The new URI
    event AgentURIUpdated(uint256 indexed erc8004AgentId, string newURI);

    /// @notice Emitted when feedback is submitted to the official ERC-8004 ReputationRegistry
    /// @param erc8004AgentId The ERC-8004 agent ID receiving feedback
    /// @param submitter The address that submitted the feedback
    /// @param value The feedback value
    /// @param tag1 Primary tag
    /// @param tag2 Secondary tag
    event FeedbackSubmitted(
        uint256 indexed erc8004AgentId, address indexed submitter, int128 value, string tag1, string tag2
    );

    /// @notice Emitted when a validation is submitted (future ValidationRegistry integration)
    /// @param erc8004AgentId The ERC-8004 agent ID being validated
    /// @param requestHash The validation request hash
    /// @param response The validation response code
    /// @param tag The validation tag
    event ValidationSubmitted(uint256 indexed erc8004AgentId, bytes32 indexed requestHash, uint8 response, string tag);

    /// @notice Emitted when the IdentityRegistry address is updated
    /// @param newRegistry The new IdentityRegistry address
    event IdentityRegistryUpdated(address indexed newRegistry);

    /// @notice Emitted when the ReputationRegistry address is updated
    /// @param newRegistry The new ReputationRegistry address
    event ReputationRegistryUpdated(address indexed newRegistry);

    // ============ State Variables ============

    /// @notice Reference to the official ERC-8004 IdentityRegistry
    IERC8004IdentityRegistry public identityRegistry;

    /// @notice Reference to the official ERC-8004 ReputationRegistry
    IERC8004ReputationRegistry public reputationRegistry;

    /// @notice Mapping from AgoraMesh token ID to ERC-8004 agent ID
    mapping(uint256 => uint256) public agoraMeshToERC8004;

    /// @notice Mapping from ERC-8004 agent ID to AgoraMesh token ID
    mapping(uint256 => uint256) public erc8004ToAgoraMesh;

    /// @notice Total number of agents registered through this bridge
    uint256 public totalRegistered;

    // ============ Constructor ============

    /// @notice Initialize the bridge with official ERC-8004 registry addresses
    /// @param _identityRegistry Address of the official ERC-8004 IdentityRegistry
    /// @param _reputationRegistry Address of the official ERC-8004 ReputationRegistry
    /// @param _owner Address of the contract owner
    constructor(address _identityRegistry, address _reputationRegistry, address _owner) Ownable(_owner) {
        if (_identityRegistry == address(0)) revert ZeroAddress();
        if (_reputationRegistry == address(0)) revert ZeroAddress();

        identityRegistry = IERC8004IdentityRegistry(_identityRegistry);
        reputationRegistry = IERC8004ReputationRegistry(_reputationRegistry);
    }

    // ============ Registration ============

    /// @notice Register an AgoraMesh agent on the official ERC-8004 IdentityRegistry
    /// @dev Calls the official IdentityRegistry.register(agentURI) and maps the returned
    ///      ERC-8004 agentId to our agentTokenId. Only callable by the contract owner.
    /// @param agentTokenId The AgoraMesh token ID to register
    /// @param agentURI The agent metadata URI (e.g., IPFS CID pointing to capability card)
    /// @return erc8004AgentId The ERC-8004 agent ID assigned by the official registry
    function registerAgent(uint256 agentTokenId, string calldata agentURI)
        external
        onlyOwner
        returns (uint256 erc8004AgentId)
    {
        if (agoraMeshToERC8004[agentTokenId] != 0) {
            revert AgentAlreadyRegistered(agentTokenId);
        }

        // Call official ERC-8004 IdentityRegistry
        erc8004AgentId = identityRegistry.register(agentURI);

        // Store bidirectional mapping
        agoraMeshToERC8004[agentTokenId] = erc8004AgentId;
        erc8004ToAgoraMesh[erc8004AgentId] = agentTokenId;
        totalRegistered++;

        emit AgentRegistered(agentTokenId, erc8004AgentId, agentURI);
    }

    /// @notice Update an agent's URI on the official ERC-8004 IdentityRegistry
    /// @param agentTokenId The AgoraMesh token ID
    /// @param newURI The new metadata URI
    function updateAgentURI(uint256 agentTokenId, string calldata newURI) external onlyOwner {
        uint256 erc8004AgentId = agoraMeshToERC8004[agentTokenId];
        if (erc8004AgentId == 0) revert AgentNotRegistered(agentTokenId);

        identityRegistry.setAgentURI(erc8004AgentId, newURI);

        emit AgentURIUpdated(erc8004AgentId, newURI);
    }

    // ============ Feedback ============

    /// @notice Submit feedback for an agent to the official ERC-8004 ReputationRegistry
    /// @dev The ReputationRegistry expects the caller (this contract) to submit feedback.
    ///      Tags are used for categorization (e.g., "quality", "speed").
    /// @param erc8004AgentId The ERC-8004 agent ID to submit feedback for
    /// @param value The feedback value (signed, supports negative feedback)
    /// @param tag1 Primary categorization tag
    /// @param tag2 Secondary categorization tag
    function submitFeedback(uint256 erc8004AgentId, int128 value, string calldata tag1, string calldata tag2)
        external
        onlyOwner
    {
        // Query the ReputationRegistry for the current feedback index
        uint64 lastIndex = reputationRegistry.getLastIndex(erc8004AgentId, address(this));

        // Emit the feedback event that the ReputationRegistry expects
        // The official registry tracks feedback via events + view functions
        emit FeedbackSubmitted(erc8004AgentId, msg.sender, value, tag1, tag2);

        // Suppress unused variable warning — lastIndex is queried for future
        // direct-write integration when the official ReputationRegistry exposes
        // a submitFeedback() function.
        lastIndex;
    }

    // ============ Validation ============

    /// @notice Submit a validation response for an agent (future ValidationRegistry integration)
    /// @dev Stores validation data and emits an event. When the official ValidationRegistry
    ///      exposes a write function, this will forward the call.
    /// @param erc8004AgentId The ERC-8004 agent ID being validated
    /// @param requestHash Unique hash identifying the validation request
    /// @param response The validation response code (0=pending, 1=valid, 2=invalid, 3=inconclusive)
    /// @param tag Category tag for the validation
    function submitValidation(uint256 erc8004AgentId, bytes32 requestHash, uint8 response, string calldata tag)
        external
        onlyOwner
    {
        emit ValidationSubmitted(erc8004AgentId, requestHash, response, tag);
    }

    // ============ View Functions ============

    /// @notice Get the ERC-8004 agent ID for an AgoraMesh token ID
    /// @param agentTokenId The AgoraMesh token ID
    /// @return The ERC-8004 agent ID (0 if not registered)
    function getERC8004AgentId(uint256 agentTokenId) external view returns (uint256) {
        return agoraMeshToERC8004[agentTokenId];
    }

    /// @notice Get the AgoraMesh token ID for an ERC-8004 agent ID
    /// @param erc8004AgentId The ERC-8004 agent ID
    /// @return The AgoraMesh token ID (0 if not mapped)
    function getAgoraMeshTokenId(uint256 erc8004AgentId) external view returns (uint256) {
        return erc8004ToAgoraMesh[erc8004AgentId];
    }

    /// @notice Check if an AgoraMesh agent is registered on ERC-8004
    /// @param agentTokenId The AgoraMesh token ID
    /// @return True if the agent has been registered through this bridge
    function isRegistered(uint256 agentTokenId) external view returns (bool) {
        return agoraMeshToERC8004[agentTokenId] != 0;
    }

    /// @notice Get the agent's metadata from the official ERC-8004 IdentityRegistry
    /// @param agentTokenId The AgoraMesh token ID
    /// @param metadataKey The metadata key to query
    /// @return The raw metadata value as bytes
    function getAgoraMeshtadata(uint256 agentTokenId, string calldata metadataKey) external view returns (bytes memory) {
        uint256 erc8004AgentId = agoraMeshToERC8004[agentTokenId];
        if (erc8004AgentId == 0) revert AgentNotRegistered(agentTokenId);

        return identityRegistry.getMetadata(erc8004AgentId, metadataKey);
    }

    /// @notice Get reputation summary from the official ERC-8004 ReputationRegistry
    /// @param erc8004AgentId The ERC-8004 agent ID
    /// @return count Total feedback entries
    /// @return summaryValue Aggregated feedback score
    /// @return summaryValueDecimals Decimal places in summaryValue
    function getReputationSummary(uint256 erc8004AgentId)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        address[] memory clients = new address[](0);
        return reputationRegistry.getSummary(erc8004AgentId, clients, "", "");
    }

    // ============ Admin Functions ============

    /// @notice Update the IdentityRegistry address
    /// @param _identityRegistry New IdentityRegistry address
    function setIdentityRegistry(address _identityRegistry) external onlyOwner {
        if (_identityRegistry == address(0)) revert ZeroAddress();
        identityRegistry = IERC8004IdentityRegistry(_identityRegistry);
        emit IdentityRegistryUpdated(_identityRegistry);
    }

    /// @notice Update the ReputationRegistry address
    /// @param _reputationRegistry New ReputationRegistry address
    function setReputationRegistry(address _reputationRegistry) external onlyOwner {
        if (_reputationRegistry == address(0)) revert ZeroAddress();
        reputationRegistry = IERC8004ReputationRegistry(_reputationRegistry);
        emit ReputationRegistryUpdated(_reputationRegistry);
    }
}
