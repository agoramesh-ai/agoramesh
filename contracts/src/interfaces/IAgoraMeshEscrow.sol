// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgoraMeshEscrow - Interface for the AgoraMesh Escrow Contract
/// @notice Manages escrow for agent-to-agent transactions with dispute resolution
/// @dev Part of the AgoraMesh payment layer, compatible with x402 protocol
interface IAgoraMeshEscrow {
    // ============ Enums ============

    /// @notice State machine for escrow lifecycle
    enum State {
        AWAITING_DEPOSIT, // Escrow created, waiting for client to fund
        FUNDED, // Client has deposited funds
        DELIVERED, // Provider has confirmed delivery
        DISPUTED, // Either party has initiated a dispute
        RELEASED, // Funds released to provider
        REFUNDED // Funds refunded to client
    }

    // ============ Structs ============

    /// @notice Complete escrow record
    struct Escrow {
        uint256 id; // Unique escrow identifier
        bytes32 clientDid; // Hash of client agent's DID
        bytes32 providerDid; // Hash of provider agent's DID
        address clientAddress; // Client's wallet address
        address providerAddress; // Provider's wallet address
        uint256 amount; // Escrowed amount (token decimals)
        address token; // Payment token address (e.g., USDC)
        bytes32 taskHash; // Hash of the task specification
        bytes32 outputHash; // Hash of delivered output (set on delivery)
        uint256 deadline; // Unix timestamp deadline for delivery
        State state; // Current escrow state
        uint256 createdAt; // Creation timestamp
        uint256 deliveredAt; // Delivery confirmation timestamp
        address facilitator; // Facilitator address for fee splitting
    }

    // ============ Events ============

    /// @notice Emitted when a new escrow is created
    event EscrowCreated(
        uint256 indexed escrowId,
        bytes32 indexed clientDid,
        bytes32 indexed providerDid,
        uint256 amount,
        uint256 deadline
    );

    /// @notice Emitted when an escrow is funded by the client
    event EscrowFunded(uint256 indexed escrowId);

    /// @notice Emitted when the provider confirms task delivery
    event TaskDelivered(uint256 indexed escrowId, bytes32 outputHash);

    /// @notice Emitted when funds are released to the provider
    event EscrowReleased(uint256 indexed escrowId);

    /// @notice Emitted when funds are refunded to the client
    event EscrowRefunded(uint256 indexed escrowId);

    /// @notice Emitted when a dispute is initiated
    event DisputeInitiated(uint256 indexed escrowId, address initiator);

    /// @notice Emitted when a dispute is resolved by an arbiter
    event DisputeResolved(uint256 indexed escrowId, bool releasedToProvider, uint256 providerAmount);

    /// @notice Emitted when protocol fee is collected
    event ProtocolFeeCollected(
        uint256 indexed escrowId,
        uint256 totalFee,
        address indexed facilitator,
        uint256 facilitatorShare,
        uint256 treasuryShare
    );

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Emitted when the protocol fee basis points are updated
    event ProtocolFeeUpdated(uint256 newFeeBp);

    // ============ Errors ============

    error ClientDIDOwnershipMismatch();
    error ProviderDIDOwnershipMismatch();
    error SelfDealingNotAllowed();

    // ============ Escrow Lifecycle Functions ============

    /// @notice Create a new escrow for an agent task
    /// @param clientDid Hash of the client agent's DID
    /// @param providerDid Hash of the provider agent's DID
    /// @param providerAddress Provider's wallet address for receiving payment
    /// @param token Payment token address (e.g., USDC)
    /// @param amount Payment amount in token decimals
    /// @param taskHash Hash of the task specification (for verification)
    /// @param deadline Unix timestamp by which task must be delivered
    /// @param facilitator Address of the facilitator for fee splitting (address(0) if none)
    /// @return escrowId The unique identifier for the created escrow
    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline,
        address facilitator
    ) external returns (uint256 escrowId);

    /// @notice Fund an escrow (transfers tokens from client to contract)
    /// @param escrowId The escrow to fund
    /// @dev Client must have approved the contract to spend the token amount
    function fundEscrow(uint256 escrowId) external;

    /// @notice Provider confirms task delivery
    /// @param escrowId The escrow for the delivered task
    /// @param outputHash Hash of the delivered output (for verification)
    function confirmDelivery(uint256 escrowId, bytes32 outputHash) external;

    /// @notice Client releases funds to provider after verifying delivery
    /// @param escrowId The escrow to release
    /// @dev Can also be called after AUTO_RELEASE_DELAY by provider
    function releaseEscrow(uint256 escrowId) external;

    // ============ Dispute Functions ============

    /// @notice Initiate a dispute for an escrow
    /// @param escrowId The escrow to dispute
    /// @param evidence IPFS CID or hash of evidence supporting the dispute
    /// @dev Can be called by client or provider when escrow is FUNDED or DELIVERED
    function initiateDispute(uint256 escrowId, bytes calldata evidence) external;

    /// @notice Arbiter resolves a dispute
    /// @param escrowId The disputed escrow
    /// @param releaseToProvider If true, majority goes to provider; if false, to client
    /// @param providerShare Amount to send to provider (rest goes to client)
    /// @dev Only callable by ARBITER_ROLE
    function resolveDispute(uint256 escrowId, bool releaseToProvider, uint256 providerShare) external;

    // ============ Timeout Functions ============

    /// @notice Claim refund when deadline has passed without delivery
    /// @param escrowId The escrow to claim timeout on
    /// @dev Only callable by client when deadline has passed and state is FUNDED
    function claimTimeout(uint256 escrowId) external;

    // ============ View Functions ============

    /// @notice Get complete escrow details
    /// @param escrowId The escrow to query
    /// @return The Escrow struct with all details
    function getEscrow(uint256 escrowId) external view returns (Escrow memory);
}
