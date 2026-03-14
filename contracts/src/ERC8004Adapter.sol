// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IERC8004Identity.sol";
import "./interfaces/ITrustRegistry.sol";
import "./AgentToken.sol";

/// @title ERC8004Adapter - ERC-8004 Compatibility Layer with Dual Registration & Feedback Relay
/// @notice Wraps existing TrustRegistry and AgentToken contracts to expose ERC-8004 compatible
///         interfaces. Supports both read and write operations:
///         - Dual registration: register agents in both AgoraMesh and canonical ERC-8004 IdentityRegistry
///         - Feedback relay: accept ERC-8004 feedback and map to AgoraMesh trust scores
///         - Read queries: expose AgoraMesh data in ERC-8004 format
/// @dev Extends the original read-only adapter with write capabilities. When an external
///      ERC-8004 IdentityRegistry is configured, registration calls are forwarded to it.
///      Feedback from ERC-8004 ecosystem is relayed to TrustRegistry via the ORACLE_ROLE.
contract ERC8004Adapter is IERC8004IdentityRegistry, IERC8004ReputationRegistry, IERC8004ValidationRegistry, AccessControlEnumerable, ReentrancyGuard {
    // ============ Roles ============

    /// @notice Role for relaying ERC-8004 feedback to TrustRegistry
    bytes32 public constant RELAY_ROLE = keccak256("RELAY_ROLE");

    // ============ Errors ============

    /// @notice Reverted when an agentId does not correspond to a valid agent
    error AgentNotFound();

    /// @notice Reverted when a uint256 value overflows during type narrowing
    error ValueOverflow();

    /// @notice Reverted when a zero address is provided to the constructor
    error ZeroAddress();

    /// @notice Reverted when the canonical ERC-8004 registry is not configured
    error CanonicalRegistryNotSet();

    /// @notice Reverted when the agent is already registered on the canonical registry
    error AlreadyRegisteredOnCanonical(uint256 agentId);

    /// @notice Reverted when feedback value is out of acceptable range
    error InvalidFeedbackValue();

    /// @notice Reverted when the caller is not the agent owner
    error NotAgentOwner();

    // ============ Events ============

    /// @notice Emitted when an agent is dual-registered on the canonical ERC-8004 IdentityRegistry
    /// @param agentId The AgoraMesh token ID
    /// @param canonicalAgentId The agent ID on the canonical ERC-8004 registry
    /// @param agentURI The URI registered on the canonical registry
    event DualRegistered(uint256 indexed agentId, uint256 indexed canonicalAgentId, string agentURI);

    /// @notice Emitted when ERC-8004 feedback is relayed to the AgoraMesh TrustRegistry
    /// @param agentId The AgoraMesh token ID
    /// @param feedbackValue The ERC-8004 feedback value (signed)
    /// @param mappedSuccess Whether the feedback was mapped as successful
    /// @param mappedVolumeUsd The mapped volume in USD cents
    event FeedbackRelayed(uint256 indexed agentId, int128 feedbackValue, bool mappedSuccess, uint256 mappedVolumeUsd);

    /// @notice Emitted when the canonical ERC-8004 IdentityRegistry address is updated
    event CanonicalIdentityRegistryUpdated(address indexed newRegistry);

    /// @notice Emitted when the canonical ERC-8004 ReputationRegistry address is updated
    event CanonicalReputationRegistryUpdated(address indexed newRegistry);

    // ============ Metadata Key Hashes (compile-time constants) ============

    bytes32 private constant KEY_DID_HASH = keccak256("didHash");
    bytes32 private constant KEY_CAPABILITY_CID = keccak256("capabilityCID");
    bytes32 private constant KEY_REGISTERED_AT = keccak256("registeredAt");
    bytes32 private constant KEY_IS_ACTIVE = keccak256("isActive");

    // ============ State Variables ============

    /// @notice Reference to the AgoraMesh TrustRegistry contract
    ITrustRegistry public immutable trustRegistry;

    /// @notice Reference to the AgentToken ERC-721 contract
    AgentToken public immutable agentToken;

    /// @notice Reference to the canonical ERC-8004 IdentityRegistry (optional)
    IERC8004IdentityRegistry public canonicalIdentityRegistry;

    /// @notice Reference to the canonical ERC-8004 ReputationRegistry (optional)
    IERC8004ReputationRegistry public canonicalReputationRegistry;

    /// @notice Mapping from AgoraMesh token ID to canonical ERC-8004 agent ID
    mapping(uint256 => uint256) public agoraMeshToCanonical;

    /// @notice Mapping from canonical ERC-8004 agent ID to AgoraMesh token ID
    mapping(uint256 => uint256) public canonicalToAgoraMesh;

    /// @notice Total number of agents dual-registered on canonical ERC-8004
    uint256 public totalDualRegistered;

    /// @notice Default feedback volume in USD cents for relayed feedback (100 = $1.00)
    uint256 public defaultFeedbackVolumeUsd;

    // ============ Constructor ============

    /// @notice Initialize the adapter with references to existing contracts
    /// @param _trustRegistry Address of the deployed TrustRegistry contract
    /// @param _agentToken Address of the deployed AgentToken contract
    /// @param _admin Address of the admin (receives DEFAULT_ADMIN_ROLE)
    constructor(address _trustRegistry, address _agentToken, address _admin) {
        if (_trustRegistry == address(0)) revert ZeroAddress();
        if (_agentToken == address(0)) revert ZeroAddress();
        if (_admin == address(0)) revert ZeroAddress();
        trustRegistry = ITrustRegistry(_trustRegistry);
        agentToken = AgentToken(_agentToken);
        defaultFeedbackVolumeUsd = 100_00; // $100 default volume

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(RELAY_ROLE, _admin);
    }

    // ============ IERC8004IdentityRegistry - Write Functions ============

    /// @notice Register an agent on this adapter. If a canonical ERC-8004 IdentityRegistry
    ///         is configured, the agent is also registered there (dual registration).
    /// @dev The agent must already exist in AgentToken. This function finds the agent by
    ///      the caller's ownership and registers it on the canonical registry.
    /// @param agentURI The metadata URI for the canonical ERC-8004 registration
    /// @return agentId The AgoraMesh token ID of the registered agent
    function register(string calldata agentURI) external nonReentrant returns (uint256 agentId) {
        // Look up the caller's agent in TrustRegistry
        bytes32 didHash = trustRegistry.getAgentByOwner(msg.sender);
        if (didHash == bytes32(0)) revert AgentNotFound();

        // Get the AgoraMesh token ID
        agentId = agentToken.getTokenByDID(didHash);
        if (agentId == 0) revert AgentNotFound();

        // Dual registration on canonical ERC-8004 if configured
        if (address(canonicalIdentityRegistry) != address(0)) {
            if (agoraMeshToCanonical[agentId] != 0) {
                revert AlreadyRegisteredOnCanonical(agentId);
            }

            uint256 canonicalId = canonicalIdentityRegistry.register(agentURI);

            agoraMeshToCanonical[agentId] = canonicalId;
            canonicalToAgoraMesh[canonicalId] = agentId;
            totalDualRegistered++;

            emit DualRegistered(agentId, canonicalId, agentURI);
        }

        // Emit standard ERC-8004 event
        emit Registered(agentId, agentURI, msg.sender);
    }

    /// @notice Update the metadata URI for an existing agent on the canonical registry
    /// @param agentId The AgoraMesh token ID
    /// @param newURI The new metadata URI
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        // Verify caller owns the agent
        if (agentToken.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        // Forward to canonical registry if registered there
        uint256 canonicalId = agoraMeshToCanonical[agentId];
        if (canonicalId != 0 && address(canonicalIdentityRegistry) != address(0)) {
            canonicalIdentityRegistry.setAgentURI(canonicalId, newURI);
        }

        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @notice Set metadata on the canonical ERC-8004 registry for an agent
    /// @param agentId The AgoraMesh token ID
    /// @param metadataKey The metadata key
    /// @param metadataValue The metadata value
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        // Verify caller owns the agent
        if (agentToken.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        // Forward to canonical registry if registered there
        uint256 canonicalId = agoraMeshToCanonical[agentId];
        if (canonicalId != 0 && address(canonicalIdentityRegistry) != address(0)) {
            canonicalIdentityRegistry.setMetadata(canonicalId, metadataKey, metadataValue);
        }

        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    // ============ Feedback Relay ============

    /// @notice Relay ERC-8004 feedback to the AgoraMesh TrustRegistry
    /// @dev Converts signed ERC-8004 feedback values to AgoraMesh's binary success/fail model.
    ///      Positive feedback (> 0) → successful transaction.
    ///      Negative or zero feedback → failed transaction.
    ///      Volume defaults to `defaultFeedbackVolumeUsd` unless overridden.
    /// @param agentId The AgoraMesh token ID of the agent receiving feedback
    /// @param feedbackValue The ERC-8004 feedback value (signed int128)
    /// @param volumeUsd Override volume in USD cents (0 = use default)
    function relayFeedback(uint256 agentId, int128 feedbackValue, uint256 volumeUsd)
        external
        onlyRole(RELAY_ROLE)
        nonReentrant
    {
        bytes32 didHash = _getDidHash(agentId);

        // Map ERC-8004 signed feedback to AgoraMesh binary success
        bool success = feedbackValue > 0;
        uint256 volume = volumeUsd > 0 ? volumeUsd : defaultFeedbackVolumeUsd;

        // Record in TrustRegistry (requires this contract to have ORACLE_ROLE on TrustRegistry)
        trustRegistry.recordTransaction(didHash, volume, success);

        emit FeedbackRelayed(agentId, feedbackValue, success, volume);
    }

    /// @notice Batch relay multiple feedback entries
    /// @param agentIds Array of AgoraMesh token IDs
    /// @param feedbackValues Array of ERC-8004 feedback values
    /// @param volumesUsd Array of volume overrides (0 = use default)
    function relayFeedbackBatch(
        uint256[] calldata agentIds,
        int128[] calldata feedbackValues,
        uint256[] calldata volumesUsd
    ) external onlyRole(RELAY_ROLE) nonReentrant {
        require(agentIds.length == feedbackValues.length && agentIds.length == volumesUsd.length, "Length mismatch");

        for (uint256 i = 0; i < agentIds.length; i++) {
            bytes32 didHash = _getDidHash(agentIds[i]);
            bool success = feedbackValues[i] > 0;
            uint256 volume = volumesUsd[i] > 0 ? volumesUsd[i] : defaultFeedbackVolumeUsd;

            trustRegistry.recordTransaction(didHash, volume, success);

            emit FeedbackRelayed(agentIds[i], feedbackValues[i], success, volume);
        }
    }

    // ============ IERC8004IdentityRegistry - View Functions ============

    /// @notice Retrieve metadata for an agent by key
    /// @dev Maps ERC-8004 metadata keys to AgentToken and TrustRegistry data:
    ///      - "didHash"       -> abi.encode(bytes32 didHash)
    ///      - "capabilityCID" -> abi.encode(string capabilityCID)
    ///      - "registeredAt"  -> abi.encode(uint256 registeredAt)
    ///      - "isActive"      -> abi.encode(bool isActive)
    ///      - any other key   -> empty bytes
    /// @param agentId The ERC-721 token ID from AgentToken
    /// @param metadataKey The metadata field to query
    /// @return The ABI-encoded metadata value, or empty bytes for unknown keys
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        bytes32 didHash = _getDidHash(agentId);

        bytes32 keyHash = keccak256(bytes(metadataKey));

        if (keyHash == KEY_DID_HASH) {
            return abi.encode(didHash);
        }

        if (keyHash == KEY_CAPABILITY_CID) {
            (, string memory capabilityCID,,) = agentToken.getAgentInfo(agentId);
            return abi.encode(capabilityCID);
        }

        if (keyHash == KEY_REGISTERED_AT) {
            ITrustRegistry.AgentInfo memory agentInfo = trustRegistry.getAgent(didHash);
            return abi.encode(agentInfo.registeredAt);
        }

        if (keyHash == KEY_IS_ACTIVE) {
            (,,, bool active) = agentToken.getAgentInfo(agentId);
            return abi.encode(active);
        }

        // Unknown key: return empty bytes
        return "";
    }

    /// @notice Get the wallet address (owner) of an agent
    /// @param agentId The ERC-721 token ID from AgentToken
    /// @return The address that owns the agent token
    function getAgentWallet(uint256 agentId) external view returns (address) {
        return agentToken.ownerOf(agentId);
    }

    // ============ IERC8004ReputationRegistry - View Functions ============

    /// @notice Get the address of the linked Identity Registry
    /// @dev Returns address(this) since this adapter implements all three ERC-8004 registries
    /// @return The address of this contract
    function getIdentityRegistry()
        external
        view
        override(IERC8004ReputationRegistry, IERC8004ValidationRegistry)
        returns (address)
    {
        return address(this);
    }

    /// @notice Get an aggregated reputation summary for an agent
    /// @dev Maps TrustRegistry reputation data to ERC-8004 format:
    ///      - count = totalTransactions from TrustRegistry
    ///      - summaryValue = int128(reputationScore) in basis points (0-10000)
    ///      - summaryValueDecimals = 2 (so 10000 = 100.00)
    /// @param agentId The ERC-721 token ID from AgentToken
    /// @param clientAddresses Ignored (our system does not track per-client reputation)
    /// @param tag1 Ignored (our system does not use reputation tags)
    /// @param tag2 Ignored (our system does not use reputation tags)
    /// @return count Total number of transactions
    /// @return summaryValue Reputation score as int128 (0-10000 basis points)
    /// @return summaryValueDecimals Always 2 (two decimal places)
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        // Suppress unused parameter warnings
        clientAddresses;
        tag1;
        tag2;

        bytes32 didHash = _getDidHash(agentId);
        (uint256 score, uint256 transactions,) = trustRegistry.getReputation(didHash);

        if (transactions > type(uint64).max) revert ValueOverflow();
        if (score > uint256(uint128(type(int128).max))) revert ValueOverflow();

        count = uint64(transactions);
        summaryValue = int128(int256(score));
        summaryValueDecimals = 2;
    }

    /// @notice Read a specific feedback entry
    /// @dev Returns zeroed placeholder values. AgoraMesh does not track per-client feedback
    ///      entries; reputation is computed from aggregate transaction history.
    /// @param agentId Ignored
    /// @param clientAddress Ignored
    /// @param feedbackIndex Ignored
    /// @return value Always 0
    /// @return valueDecimals Always 0
    /// @return tag1 Always empty string
    /// @return tag2 Always empty string
    /// @return isRevoked Always false
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        pure
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        // Suppress unused parameter warnings
        agentId;
        clientAddress;
        feedbackIndex;

        return (0, 0, "", "", false);
    }

    /// @notice Get all client addresses that have submitted feedback for an agent
    /// @dev Returns empty array. AgoraMesh does not track individual feedback clients.
    /// @param agentId Ignored
    /// @return Empty address array
    function getClients(uint256 agentId) external pure returns (address[] memory) {
        agentId;
        return new address[](0);
    }

    /// @notice Get the last feedback index for a specific (agentId, clientAddress) pair
    /// @dev Returns 0. AgoraMesh does not track per-client feedback indices.
    /// @param agentId Ignored
    /// @param clientAddress Ignored
    /// @return Always 0
    function getLastIndex(uint256 agentId, address clientAddress) external pure returns (uint64) {
        agentId;
        clientAddress;
        return 0;
    }

    // ============ IERC8004ValidationRegistry - View Functions ============

    /// @notice Get the current status of a validation request
    /// @dev Returns zeroed placeholder values. AgoraMesh does not use request-hash-based
    ///      validation tracking; trust is computed via the composite trust score.
    /// @param requestHash Ignored
    /// @return validatorAddress Always address(0)
    /// @return agentId Always 0
    /// @return response Always 0 (pending)
    /// @return responseHash Always bytes32(0)
    /// @return tag Always empty string
    /// @return lastUpdate Always 0
    function getValidationStatus(bytes32 requestHash)
        external
        pure
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        requestHash;
        return (address(0), 0, 0, bytes32(0), "", 0);
    }

    /// @notice Get an aggregated validation summary for an agent
    /// @dev Maps the TrustRegistry composite trust score to ERC-8004 validation format:
    ///      - count = 1 if the agent has trust data, 0 otherwise
    ///      - averageResponse = 1 (valid) if trust score > 5000,
    ///                          2 (invalid) if trust score <= 5000,
    ///                          0 (pending) if no trust data exists
    /// @param agentId The ERC-721 token ID from AgentToken
    /// @param validatorAddresses Ignored (our system uses a composite trust score)
    /// @param tag Ignored (our system does not use validation tags)
    /// @return count 1 if trust data exists, 0 otherwise
    /// @return averageResponse Validation response code (0 = pending, 1 = valid, 2 = invalid)
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        validatorAddresses;
        tag;

        bytes32 didHash = _getDidHash(agentId);
        ITrustRegistry.TrustData memory data = trustRegistry.getTrustData(didHash);

        // Check if the agent has any trust data (transactions or stake)
        if (data.totalTransactions == 0 && data.stakedAmount == 0) {
            return (0, 0);
        }

        uint256 trustScore = trustRegistry.getTrustScore(didHash);

        count = 1;
        averageResponse = trustScore > 5000 ? 1 : 2;
    }

    /// @notice Get all validation request hashes associated with an agent
    /// @dev Returns empty array. AgoraMesh does not use individual validation requests.
    /// @param agentId Ignored
    /// @return Empty bytes32 array
    function getAgentValidations(uint256 agentId) external pure returns (bytes32[] memory) {
        agentId;
        return new bytes32[](0);
    }

    // ============ Convenience Functions ============

    /// @notice Look up the AgentToken token ID for a given DID hash
    /// @dev Convenience function bridging the DID-hash-based world to token-ID-based ERC-8004
    /// @param didHash The agent's DID hash
    /// @return tokenId The corresponding ERC-721 token ID (0 if not minted)
    function getAgentIdByDid(bytes32 didHash) external view returns (uint256 tokenId) {
        return agentToken.getTokenByDID(didHash);
    }

    /// @notice Get the canonical ERC-8004 agent ID for an AgoraMesh agent
    /// @param agentId The AgoraMesh token ID
    /// @return The canonical ERC-8004 agent ID (0 if not dual-registered)
    function getCanonicalAgentId(uint256 agentId) external view returns (uint256) {
        return agoraMeshToCanonical[agentId];
    }

    /// @notice Check if an agent is dual-registered on the canonical ERC-8004 registry
    /// @param agentId The AgoraMesh token ID
    /// @return True if the agent is registered on the canonical registry
    function isDualRegistered(uint256 agentId) external view returns (bool) {
        return agoraMeshToCanonical[agentId] != 0;
    }

    // ============ Admin Functions ============

    /// @notice Set the canonical ERC-8004 IdentityRegistry address
    /// @param _registry Address of the canonical IdentityRegistry
    function setCanonicalIdentityRegistry(address _registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        canonicalIdentityRegistry = IERC8004IdentityRegistry(_registry);
        emit CanonicalIdentityRegistryUpdated(_registry);
    }

    /// @notice Set the canonical ERC-8004 ReputationRegistry address
    /// @param _registry Address of the canonical ReputationRegistry
    function setCanonicalReputationRegistry(address _registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        canonicalReputationRegistry = IERC8004ReputationRegistry(_registry);
        emit CanonicalReputationRegistryUpdated(_registry);
    }

    /// @notice Set the default feedback volume for relayed feedback
    /// @param _volumeUsd Volume in USD cents
    function setDefaultFeedbackVolumeUsd(uint256 _volumeUsd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        defaultFeedbackVolumeUsd = _volumeUsd;
    }

    // ============ ERC-165 Support ============

    /// @notice Check interface support
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlEnumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ============ Internal Functions ============

    /// @notice Resolve an ERC-8004 agentId (token ID) to its underlying DID hash
    /// @dev Calls AgentToken.getAgentInfo() and verifies the agent exists
    /// @param agentId The ERC-721 token ID from AgentToken
    /// @return didHash The agent's DID hash in the TrustRegistry
    function _getDidHash(uint256 agentId) internal view returns (bytes32 didHash) {
        (didHash,,,) = agentToken.getAgentInfo(agentId);
        if (didHash == bytes32(0)) {
            revert AgentNotFound();
        }
    }
}
