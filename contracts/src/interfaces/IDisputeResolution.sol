// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDisputeResolution - Interface for AgoraMesh Dispute Resolution
/// @notice Defines the interface for tiered dispute resolution
/// @dev Compatible with ERC-792 arbitration standard
interface IDisputeResolution {
    // ============ Enums ============

    /// @notice Dispute resolution tiers
    enum Tier {
        AUTO, // Tier 1: < $10, automatic resolution
        AI_ASSISTED, // Tier 2: $10 - $1,000, AI + 3 arbiters
        COMMUNITY // Tier 3: > $1,000, Schelling point voting
    }

    /// @notice Dispute states
    enum DisputeState {
        NONE,
        EVIDENCE_PERIOD, // Parties submitting evidence
        AI_ANALYSIS, // AI analyzing evidence (Tier 2)
        VOTING, // Arbiters/jurors voting
        APPEALABLE, // Ruling given, can appeal
        RESOLVED, // Final resolution
        SETTLED // Funds distributed
    }

    /// @notice Voting options
    enum Vote {
        ABSTAIN,
        FAVOR_CLIENT,
        FAVOR_PROVIDER,
        SPLIT
    }

    // ============ Structs ============

    /// @notice Dispute information
    struct Dispute {
        uint256 id;
        uint256 escrowId;
        bytes32 clientDid;
        bytes32 providerDid;
        uint256 amount;
        Tier tier;
        DisputeState state;
        uint256 createdAt;
        uint256 evidenceDeadline;
        uint256 votingDeadline;
        uint256 appealDeadline;
        uint8 appealRound;
        bytes32 clientEvidenceCID; // IPFS CID
        bytes32 providerEvidenceCID; // IPFS CID
        bytes32 aiAnalysisCID; // IPFS CID (Tier 2+)
        uint256 clientShare; // Basis points (0-10000)
        uint256 providerShare; // Basis points (0-10000)
    }

    /// @notice Arbiter/juror vote
    struct ArbiterVote {
        address arbiter;
        Vote vote;
        uint256 clientShareProposal; // Only for SPLIT vote
        bytes32 justificationCID; // IPFS CID
        uint256 votedAt;
    }

    // ============ Events ============

    /// @notice Emitted when a dispute is created
    event DisputeCreated(uint256 indexed disputeId, uint256 indexed escrowId, Tier tier, uint256 amount);

    /// @notice Emitted when evidence is submitted
    event EvidenceSubmitted(uint256 indexed disputeId, bytes32 indexed partyDid, bytes32 evidenceCID);

    /// @notice Emitted when AI analysis is completed
    event AIAnalysisCompleted(uint256 indexed disputeId, bytes32 analysisCID, uint256 suggestedClientShare);

    /// @notice Emitted when an arbiter votes
    event ArbiterVoted(uint256 indexed disputeId, address indexed arbiter, Vote vote);

    /// @notice Emitted when a ruling is given
    event RulingGiven(uint256 indexed disputeId, uint256 clientShare, uint256 providerShare, bool appealable);

    /// @notice Emitted when an appeal is filed
    event AppealFiled(uint256 indexed disputeId, address indexed appellant, uint8 newRound);

    /// @notice Emitted when a dispute is resolved and settled
    event DisputeSettled(uint256 indexed disputeId, uint256 clientAmount, uint256 providerAmount);

    // ============ Dispute Lifecycle ============

    /// @notice Create a new dispute
    /// @param escrowId The escrow ID being disputed
    /// @param evidenceCID Initial evidence IPFS CID
    /// @return disputeId The new dispute ID
    function createDispute(uint256 escrowId, bytes32 evidenceCID) external returns (uint256 disputeId);

    /// @notice Submit evidence for a dispute
    /// @param disputeId The dispute ID
    /// @param evidenceCID Evidence IPFS CID
    function submitEvidence(uint256 disputeId, bytes32 evidenceCID) external;

    /// @notice Submit AI analysis result (Tier 2+, oracle only)
    /// @param disputeId The dispute ID
    /// @param analysisCID Analysis result IPFS CID
    /// @param suggestedClientShare AI's suggested client share (basis points)
    function submitAIAnalysis(uint256 disputeId, bytes32 analysisCID, uint256 suggestedClientShare) external;

    /// @notice Cast a vote (arbiter/juror only)
    /// @param disputeId The dispute ID
    /// @param vote The vote
    /// @param clientShareProposal Proposed client share for SPLIT votes
    /// @param justificationCID Justification IPFS CID
    function castVote(uint256 disputeId, Vote vote, uint256 clientShareProposal, bytes32 justificationCID) external;

    /// @notice Finalize voting and give ruling
    /// @param disputeId The dispute ID
    function finalizeRuling(uint256 disputeId) external;

    /// @notice Appeal a ruling
    /// @param disputeId The dispute ID
    function appeal(uint256 disputeId) external;

    /// @notice Execute the final settlement
    /// @param disputeId The dispute ID
    function executeSettlement(uint256 disputeId) external;

    // ============ Auto-Resolution (Tier 1) ============

    /// @notice Check if dispute can be auto-resolved
    /// @param disputeId The dispute ID
    /// @return canResolve True if can auto-resolve
    /// @return clientShare Suggested client share if can resolve
    function checkAutoResolution(uint256 disputeId) external view returns (bool canResolve, uint256 clientShare);

    /// @notice Execute auto-resolution for Tier 1 disputes
    /// @param disputeId The dispute ID
    function executeAutoResolution(uint256 disputeId) external;

    // ============ View Functions ============

    /// @notice Get dispute details
    /// @param disputeId The dispute ID
    /// @return The dispute struct
    function getDispute(uint256 disputeId) external view returns (Dispute memory);

    /// @notice Get votes for a dispute
    /// @param disputeId The dispute ID
    /// @return Array of arbiter votes
    function getVotes(uint256 disputeId) external view returns (ArbiterVote[] memory);

    /// @notice Get selected arbiters/jurors for a dispute
    /// @param disputeId The dispute ID
    /// @return Array of arbiter addresses
    function getArbiters(uint256 disputeId) external view returns (address[] memory);

    /// @notice Calculate dispute fee
    /// @param tier The dispute tier
    /// @param amount The disputed amount
    /// @return fee The required fee
    function calculateFee(Tier tier, uint256 amount) external view returns (uint256 fee);

    /// @notice Determine tier based on amount
    /// @param amount The disputed amount in USDC (6 decimals)
    /// @return tier The dispute tier
    function determineTier(uint256 amount) external pure returns (Tier tier);

    // ============ Configuration ============

    /// @notice Get the number of arbiters for a tier and round
    /// @param tier The dispute tier
    /// @param round The appeal round (0 = initial)
    /// @return Number of arbiters
    function getArbiterCount(Tier tier, uint8 round) external pure returns (uint256);
}
