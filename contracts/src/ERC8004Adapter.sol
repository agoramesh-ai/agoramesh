// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IERC8004Identity.sol";
import "./interfaces/ITrustRegistry.sol";
import "./AgentToken.sol";

/// @title ERC8004Adapter - Read-Only ERC-8004 Compatibility Layer
/// @notice Wraps existing TrustRegistry and AgentToken contracts to expose
///         ERC-8004 compatible query interfaces without modifying underlying contracts
/// @dev This is a read-only adapter. All write functions revert with ReadOnlyAdapter().
///      Maps between ERC-8004's uint256 agentId (AgentToken token IDs) and
///      AgentMesh's bytes32 didHash (TrustRegistry identifiers).
contract ERC8004Adapter is
    IERC8004IdentityRegistry,
    IERC8004ReputationRegistry,
    IERC8004ValidationRegistry
{
    // ============ Errors ============

    /// @notice Reverted when a write operation is attempted on this read-only adapter
    error ReadOnlyAdapter();

    /// @notice Reverted when an agentId does not correspond to a valid agent
    error AgentNotFound();

    /// @notice Reverted when a uint256 value overflows during type narrowing
    error ValueOverflow();

    // ============ State Variables ============

    /// @notice Reference to the AgentMesh TrustRegistry contract
    ITrustRegistry public immutable trustRegistry;

    /// @notice Reference to the AgentToken ERC-721 contract
    AgentToken public immutable agentToken;

    // ============ Constructor ============

    /// @notice Initialize the adapter with references to existing contracts
    /// @param _trustRegistry Address of the deployed TrustRegistry contract
    /// @param _agentToken Address of the deployed AgentToken contract
    constructor(address _trustRegistry, address _agentToken) {
        trustRegistry = ITrustRegistry(_trustRegistry);
        agentToken = AgentToken(_agentToken);
    }

    // ============ IERC8004IdentityRegistry - Write Functions (Reverts) ============

    /// @notice Not supported: this is a read-only adapter
    /// @dev Always reverts. Use AgentToken.mintAgent() and TrustRegistry.registerAgent() directly.
    function register(string calldata) external pure returns (uint256) {
        revert ReadOnlyAdapter();
    }

    /// @notice Not supported: this is a read-only adapter
    /// @dev Always reverts. Use AgentToken.updateCapabilityCID() directly.
    function setAgentURI(uint256, string calldata) external pure {
        revert ReadOnlyAdapter();
    }

    /// @notice Not supported: this is a read-only adapter
    /// @dev Always reverts.
    function setMetadata(uint256, string memory, bytes memory) external pure {
        revert ReadOnlyAdapter();
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

        if (keyHash == keccak256("didHash")) {
            return abi.encode(didHash);
        }

        if (keyHash == keccak256("capabilityCID")) {
            (, string memory capabilityCID,,) = agentToken.getAgentInfo(agentId);
            return abi.encode(capabilityCID);
        }

        if (keyHash == keccak256("registeredAt")) {
            ITrustRegistry.AgentInfo memory agentInfo = trustRegistry.getAgent(didHash);
            return abi.encode(agentInfo.registeredAt);
        }

        if (keyHash == keccak256("isActive")) {
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
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
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
    /// @dev Returns zeroed placeholder values. AgentMesh does not track per-client feedback
    ///      entries; reputation is computed from aggregate transaction history.
    /// @param agentId Ignored
    /// @param clientAddress Ignored
    /// @param feedbackIndex Ignored
    /// @return value Always 0
    /// @return valueDecimals Always 0
    /// @return tag1 Always empty string
    /// @return tag2 Always empty string
    /// @return isRevoked Always false
    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external pure returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked) {
        // Suppress unused parameter warnings
        agentId;
        clientAddress;
        feedbackIndex;

        return (0, 0, "", "", false);
    }

    /// @notice Get all client addresses that have submitted feedback for an agent
    /// @dev Returns empty array. AgentMesh does not track individual feedback clients.
    /// @param agentId Ignored
    /// @return Empty address array
    function getClients(uint256 agentId) external pure returns (address[] memory) {
        agentId;
        return new address[](0);
    }

    /// @notice Get the last feedback index for a specific (agentId, clientAddress) pair
    /// @dev Returns 0. AgentMesh does not track per-client feedback indices.
    /// @param agentId Ignored
    /// @param clientAddress Ignored
    /// @return Always 0
    function getLastIndex(uint256 agentId, address clientAddress) external pure returns (uint64) {
        agentId;
        clientAddress;
        return 0;
    }

    // ============ IERC8004ValidationRegistry - View Functions ============

    // Note: getIdentityRegistry() is shared with IERC8004ReputationRegistry
    // and is implemented once above.

    /// @notice Get the current status of a validation request
    /// @dev Returns zeroed placeholder values. AgentMesh does not use request-hash-based
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
    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    ) external view returns (uint64 count, uint8 averageResponse) {
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
    /// @dev Returns empty array. AgentMesh does not use individual validation requests.
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
