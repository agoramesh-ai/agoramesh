// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITrustRegistry - Interface for the AgentMe Trust Registry
/// @notice Manages agent registration, reputation, staking, and endorsements
/// @dev Part of the AgentMe trust layer, compatible with ERC-8004
interface ITrustRegistry {
    // ============ Structs ============

    /// @notice Information about a registered agent
    struct AgentInfo {
        bytes32 didHash; // Hash of the agent's DID
        address owner; // Owner address that can manage this agent
        string capabilityCardCID; // IPFS CID of the agent's capability card
        uint256 registeredAt; // Timestamp of registration
        bool isActive; // Whether the agent is currently active
    }

    /// @notice Trust-related data for an agent
    struct TrustData {
        uint256 reputationScore; // 0-10000 (basis points, 100% = 10000)
        uint256 totalTransactions; // Total number of transactions
        uint256 successfulTransactions; // Number of successful transactions
        uint256 totalVolumeUsd; // Total transaction volume in cents
        uint256 lastActivityTimestamp; // Last activity timestamp
        uint256 stakedAmount; // USDC staked (6 decimals)
        uint256 stakeUnlockTime; // When stake can be withdrawn (0 if not requested)
    }

    /// @notice Endorsement from one agent to another
    struct Endorsement {
        bytes32 endorserDid; // DID hash of the endorser
        bytes32 endorseeDid; // DID hash of the endorsee
        uint256 timestamp; // When the endorsement was made
        string message; // Optional endorsement message
        bool isActive; // Whether the endorsement is still active
    }

    // ============ Events ============

    /// @notice Emitted when a new agent is registered
    event AgentRegistered(bytes32 indexed didHash, address indexed owner, string capabilityCardCID);

    /// @notice Emitted when an agent's capability card is updated
    event AgentUpdated(bytes32 indexed didHash, string newCID);

    /// @notice Emitted when an agent is deactivated
    event AgentDeactivated(bytes32 indexed didHash);

    /// @notice Emitted when an agent's reputation is updated
    event ReputationUpdated(bytes32 indexed didHash, uint256 newScore, uint256 totalTransactions);

    /// @notice Emitted when stake is deposited
    event StakeDeposited(bytes32 indexed didHash, uint256 amount);

    /// @notice Emitted when a withdrawal is requested
    event StakeWithdrawRequested(bytes32 indexed didHash, uint256 amount, uint256 unlockTime);

    /// @notice Emitted when stake is withdrawn
    event StakeWithdrawn(bytes32 indexed didHash, uint256 amount);

    /// @notice Emitted when stake is slashed
    event StakeSlashed(bytes32 indexed didHash, uint256 amount, bytes32 reason);

    /// @notice Emitted when an endorsement is added
    event EndorsementAdded(bytes32 indexed endorser, bytes32 indexed endorsee, string message);

    /// @notice Emitted when an endorsement is revoked
    event EndorsementRevoked(bytes32 indexed endorser, bytes32 indexed endorsee);

    // ============ Registration Functions ============

    /// @notice Register a new agent
    /// @param didHash Hash of the agent's DID
    /// @param capabilityCardCID IPFS CID of the capability card
    function registerAgent(bytes32 didHash, string calldata capabilityCardCID) external;

    /// @notice Update an agent's capability card
    /// @param didHash Hash of the agent's DID
    /// @param newCID New IPFS CID for the capability card
    function updateCapabilityCard(bytes32 didHash, string calldata newCID) external;

    /// @notice Deactivate an agent
    /// @param didHash Hash of the agent's DID
    function deactivateAgent(bytes32 didHash) external;

    // ============ Reputation Functions ============

    /// @notice Record a transaction for an agent (oracle only)
    /// @param agentDid Hash of the agent's DID
    /// @param volumeUsd Transaction volume in USD cents
    /// @param successful Whether the transaction was successful
    function recordTransaction(bytes32 agentDid, uint256 volumeUsd, bool successful) external;

    /// @notice Get an agent's reputation data
    /// @param didHash Hash of the agent's DID
    /// @return score Reputation score (0-10000)
    /// @return transactions Total transactions
    /// @return successRate Success rate in basis points (0-10000)
    function getReputation(bytes32 didHash)
        external
        view
        returns (uint256 score, uint256 transactions, uint256 successRate);

    // ============ Staking Functions ============

    /// @notice Deposit stake for an agent
    /// @param didHash Hash of the agent's DID
    /// @param amount Amount of USDC to stake (6 decimals)
    function depositStake(bytes32 didHash, uint256 amount) external;

    /// @notice Request withdrawal of stake (starts cooldown)
    /// @param didHash Hash of the agent's DID
    /// @param amount Amount to withdraw
    /// @return unlockTime When the stake can be withdrawn
    function requestWithdraw(bytes32 didHash, uint256 amount) external returns (uint256 unlockTime);

    /// @notice Execute a pending withdrawal
    /// @param didHash Hash of the agent's DID
    /// @return withdrawnAmount Amount that was withdrawn
    function executeWithdraw(bytes32 didHash) external returns (uint256 withdrawnAmount);

    /// @notice Slash an agent's stake (arbiter only)
    /// @param didHash Hash of the agent's DID
    /// @param amount Amount to slash
    /// @param disputeId ID of the dispute that triggered slashing
    function slash(bytes32 didHash, uint256 amount, bytes32 disputeId) external;

    // ============ Endorsement Functions ============

    /// @notice Endorse another agent
    /// @param endorseeDid Hash of the agent to endorse
    /// @param message Optional endorsement message
    function endorse(bytes32 endorseeDid, string calldata message) external;

    /// @notice Revoke an endorsement
    /// @param endorseeDid Hash of the agent to revoke endorsement from
    function revokeEndorsement(bytes32 endorseeDid) external;

    /// @notice Get all endorsements for an agent
    /// @param didHash Hash of the agent's DID
    /// @return Array of endorsements
    function getEndorsements(bytes32 didHash) external view returns (Endorsement[] memory);

    // ============ Trust Score Functions ============

    /// @notice Get the composite trust score for an agent
    /// @param didHash Hash of the agent's DID
    /// @return compositeScore The composite trust score (0-10000)
    function getTrustScore(bytes32 didHash) external view returns (uint256 compositeScore);

    /// @notice Get detailed trust breakdown for an agent
    /// @param didHash Hash of the agent's DID
    /// @return reputationScore Reputation component (0-10000)
    /// @return stakeScore Stake component (0-10000)
    /// @return endorsementScore Endorsement component (0-10000)
    /// @return compositeScore Weighted composite score (0-10000)
    function getTrustDetails(bytes32 didHash)
        external
        view
        returns (uint256 reputationScore, uint256 stakeScore, uint256 endorsementScore, uint256 compositeScore);

    // ============ View Functions ============

    /// @notice Get agent info
    /// @param didHash Hash of the agent's DID
    /// @return Agent information struct
    function getAgent(bytes32 didHash) external view returns (AgentInfo memory);

    /// @notice Get trust data for an agent
    /// @param didHash Hash of the agent's DID
    /// @return Trust data struct
    function getTrustData(bytes32 didHash) external view returns (TrustData memory);

    /// @notice Check if an agent is active
    /// @param didHash Hash of the agent's DID
    /// @return Whether the agent is active
    function isAgentActive(bytes32 didHash) external view returns (bool);

    /// @notice Get the agent DID for an owner address
    /// @param owner Owner address to look up
    /// @return didHash The agent's DID hash, or bytes32(0) if not found
    function getAgentByOwner(address owner) external view returns (bytes32 didHash);
}
