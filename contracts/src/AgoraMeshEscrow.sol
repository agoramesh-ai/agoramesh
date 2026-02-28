// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAgoraMeshEscrow.sol";
import "./interfaces/ITrustRegistry.sol";

/// @title AgoraMeshEscrow - Escrow for Agent-to-Agent Transactions
/// @notice Manages escrow for agent tasks with dispute resolution
/// @dev Integrates with TrustRegistry for agent validation and reputation updates
contract AgoraMeshEscrow is IAgoraMeshEscrow, AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Role for resolving disputes
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    /// @notice Time after delivery before provider can auto-release
    uint256 public constant AUTO_RELEASE_DELAY = 24 hours;

    /// @notice Maximum deadline duration (90 days)
    uint256 public constant MAX_DEADLINE_DURATION = 90 days;

    // ============ State Variables ============

    /// @notice Reference to the TrustRegistry contract
    ITrustRegistry public immutable trustRegistry;

    /// @notice Counter for generating escrow IDs
    uint256 private _nextEscrowId;

    /// @notice Mapping from escrow ID to Escrow struct
    mapping(uint256 => Escrow) private _escrows;

    /// @notice Allowed token addresses for escrow
    mapping(address => bool) private _allowedTokens;

    /// @notice Treasury address for collecting protocol fees
    address public treasury;

    /// @notice Protocol fee in basis points
    uint256 public protocolFeeBp;

    /// @notice Maximum protocol fee (5%)
    uint256 public constant MAX_FEE_BP = 500;

    /// @notice Minimum fee ($0.01 USDC = 10_000 in 6 decimal)
    uint256 public constant MIN_FEE = 10_000;

    /// @notice Basis points denominator
    uint256 private constant BP = 10_000;

    /// @notice Facilitator share of protocol fee (70%)
    uint256 public constant FACILITATOR_SHARE_BP = 7_000;

    // ============ Errors ============

    error InvalidTrustRegistry();
    error InvalidAdmin();
    error InvalidAmount();
    error InvalidDeadline();
    error InvalidProviderAddress();
    error InvalidToken();
    error InvalidProviderShare();
    error AgentNotActive();
    error EscrowNotFound();
    error InvalidState();
    error NotClient();
    error NotProvider();
    error NotParty();
    error NotAuthorized();
    error DeadlineNotPassed();
    error AutoReleaseNotReady();
    error TokenNotAllowed();
    error DeadlineTooFar();
    error InvalidTreasury();
    error FeeTooHigh();

    // ============ Events ============

    /// @notice Emitted when reputation recording fails
    event ReputationRecordingFailed(bytes32 indexed providerDid, bool success);

    /// @notice Emitted on every state transition
    event StateTransition(uint256 indexed escrowId, State from, State to, uint256 timestamp, address triggeredBy);

    // ============ Constructor ============

    /// @notice Initialize the AgoraMeshEscrow contract
    /// @param _trustRegistry Address of the TrustRegistry contract
    /// @param _admin Address of the admin
    constructor(address _trustRegistry, address _admin) {
        if (_trustRegistry == address(0)) revert InvalidTrustRegistry();
        if (_admin == address(0)) revert InvalidAdmin();

        trustRegistry = ITrustRegistry(_trustRegistry);
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Escrow Lifecycle Functions ============

    /// @inheritdoc IAgoraMeshEscrow
    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline,
        address facilitator
    ) external override returns (uint256 escrowId) {
        // Validate inputs
        if (amount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (deadline > block.timestamp + MAX_DEADLINE_DURATION) revert DeadlineTooFar();
        if (providerAddress == address(0)) revert InvalidProviderAddress();
        if (token == address(0)) revert InvalidToken();
        if (!_allowedTokens[token]) revert TokenNotAllowed();

        // Verify both agents are active in TrustRegistry
        if (!trustRegistry.isAgentActive(clientDid)) revert AgentNotActive();
        if (!trustRegistry.isAgentActive(providerDid)) revert AgentNotActive();

        // Verify caller owns the client DID
        ITrustRegistry.AgentInfo memory clientAgent = trustRegistry.getAgent(clientDid);
        if (clientAgent.owner != msg.sender) revert ClientDIDOwnershipMismatch();

        // Verify providerAddress matches the owner of providerDid
        ITrustRegistry.AgentInfo memory providerAgent = trustRegistry.getAgent(providerDid);
        if (providerAgent.owner != providerAddress) revert ProviderDIDOwnershipMismatch();

        // Prevent self-dealing
        if (clientDid == providerDid) revert SelfDealingNotAllowed();
        if (msg.sender == providerAddress) revert SelfDealingNotAllowed();

        // Generate escrow ID
        escrowId = ++_nextEscrowId;

        // Create escrow record
        _escrows[escrowId] = Escrow({
            id: escrowId,
            clientDid: clientDid,
            providerDid: providerDid,
            clientAddress: msg.sender,
            providerAddress: providerAddress,
            amount: amount,
            token: token,
            taskHash: taskHash,
            outputHash: bytes32(0),
            deadline: deadline,
            state: State.AWAITING_DEPOSIT,
            createdAt: block.timestamp,
            deliveredAt: 0,
            facilitator: facilitator
        });

        emit EscrowCreated(escrowId, clientDid, providerDid, amount, deadline);
    }

    /// @inheritdoc IAgoraMeshEscrow
    function fundEscrow(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _getEscrow(escrowId);

        // Verify caller is the client
        if (msg.sender != e.clientAddress) revert NotClient();

        // Verify state
        if (e.state != State.AWAITING_DEPOSIT) revert InvalidState();

        // Update state
        e.state = State.FUNDED;

        // Transfer tokens from client to contract
        IERC20(e.token).safeTransferFrom(msg.sender, address(this), e.amount);

        _emitStateTransition(escrowId, State.AWAITING_DEPOSIT, State.FUNDED);
        emit EscrowFunded(escrowId);
    }

    /// @inheritdoc IAgoraMeshEscrow
    function confirmDelivery(uint256 escrowId, bytes32 outputHash) external override {
        Escrow storage e = _getEscrow(escrowId);

        // Verify caller is the provider
        if (msg.sender != e.providerAddress) revert NotProvider();

        // Verify state
        if (e.state != State.FUNDED) revert InvalidState();

        // Update state
        e.state = State.DELIVERED;
        e.outputHash = outputHash;
        e.deliveredAt = block.timestamp;

        _emitStateTransition(escrowId, State.FUNDED, State.DELIVERED);
        emit TaskDelivered(escrowId, outputHash);
    }

    /// @inheritdoc IAgoraMeshEscrow
    function releaseEscrow(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _getEscrow(escrowId);

        // Verify state
        if (e.state != State.DELIVERED) revert InvalidState();

        // Check authorization
        bool isClient = msg.sender == e.clientAddress;
        bool isProvider = msg.sender == e.providerAddress;

        if (!isClient && !isProvider) revert NotAuthorized();

        // If provider is releasing, check auto-release delay
        if (isProvider) {
            if (block.timestamp < e.deliveredAt + AUTO_RELEASE_DELAY) {
                revert AutoReleaseNotReady();
            }
        }

        // Update state
        e.state = State.RELEASED;

        // Deduct protocol fee and transfer net amount to provider
        uint256 netAmount = _deductAndTransferFee(e.token, e.amount, e.facilitator, escrowId);
        IERC20(e.token).safeTransfer(e.providerAddress, netAmount);

        // Record successful transaction in TrustRegistry
        _recordTransaction(e.providerDid, e.amount, true);

        _emitStateTransition(escrowId, State.DELIVERED, State.RELEASED);
        emit EscrowReleased(escrowId);
    }

    // ============ Dispute Functions ============

    /// @inheritdoc IAgoraMeshEscrow
    function initiateDispute(
        uint256 escrowId,
        bytes calldata /* evidence */
    )
        external
        override
    {
        Escrow storage e = _getEscrow(escrowId);

        // Verify caller is a party to the escrow
        if (msg.sender != e.clientAddress && msg.sender != e.providerAddress) {
            revert NotParty();
        }

        // Verify state (can dispute when FUNDED or DELIVERED)
        if (e.state != State.FUNDED && e.state != State.DELIVERED) {
            revert InvalidState();
        }

        // Update state
        State previousState = e.state;
        e.state = State.DISPUTED;

        _emitStateTransition(escrowId, previousState, State.DISPUTED);
        emit DisputeInitiated(escrowId, msg.sender);
    }

    /// @inheritdoc IAgoraMeshEscrow
    function resolveDispute(uint256 escrowId, bool releaseToProvider, uint256 providerShare)
        external
        override
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        Escrow storage e = _getEscrow(escrowId);

        // Verify state
        if (e.state != State.DISPUTED) revert InvalidState();

        // Verify provider share doesn't exceed total
        if (providerShare > e.amount) revert InvalidProviderShare();

        // Calculate client share
        uint256 clientShare = e.amount - providerShare;

        // Update state based on resolution
        State newState;
        if (releaseToProvider && providerShare == e.amount) {
            newState = State.RELEASED;
        } else if (!releaseToProvider && providerShare == 0) {
            newState = State.REFUNDED;
        } else {
            // Split scenario - use RELEASED as final state
            newState = State.RELEASED;
        }
        e.state = newState;

        _emitStateTransition(escrowId, State.DISPUTED, newState);

        // Deduct protocol fees and transfer funds
        if (providerShare > 0) {
            uint256 netProviderShare = _deductAndTransferFee(e.token, providerShare, e.facilitator, escrowId);
            IERC20(e.token).safeTransfer(e.providerAddress, netProviderShare);
        }
        if (clientShare > 0) {
            uint256 netClientShare = _deductAndTransferFee(e.token, clientShare, e.facilitator, escrowId);
            IERC20(e.token).safeTransfer(e.clientAddress, netClientShare);
        }

        // Record transaction outcome in TrustRegistry
        // If provider got majority, record as successful; otherwise failed
        bool successful = releaseToProvider && providerShare >= e.amount / 2;
        _recordTransaction(e.providerDid, e.amount, successful);

        emit DisputeResolved(escrowId, releaseToProvider, providerShare);
    }

    // ============ Timeout Functions ============

    /// @inheritdoc IAgoraMeshEscrow
    function claimTimeout(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _getEscrow(escrowId);

        // Verify caller is the client
        if (msg.sender != e.clientAddress) revert NotClient();

        // Verify state (can only timeout from FUNDED state)
        if (e.state != State.FUNDED) revert InvalidState();

        // Verify deadline has passed
        if (block.timestamp <= e.deadline) revert DeadlineNotPassed();

        // Update state
        e.state = State.REFUNDED;

        // Return tokens to client
        IERC20(e.token).safeTransfer(e.clientAddress, e.amount);

        // Record failed transaction in TrustRegistry
        _recordTransaction(e.providerDid, e.amount, false);

        _emitStateTransition(escrowId, State.FUNDED, State.REFUNDED);
        emit EscrowRefunded(escrowId);
    }

    // ============ View Functions ============

    /// @inheritdoc IAgoraMeshEscrow
    function getEscrow(uint256 escrowId) external view override returns (Escrow memory) {
        return _escrows[escrowId];
    }

    // ============ Token Whitelist Functions ============

    /// @notice Add a token to the allowed list
    /// @param token Token address to allow
    function addAllowedToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidToken();
        _allowedTokens[token] = true;
    }

    /// @notice Remove a token from the allowed list
    /// @param token Token address to remove
    function removeAllowedToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _allowedTokens[token] = false;
    }

    /// @notice Check if a token is allowed
    /// @param token Token address to check
    /// @return Whether the token is allowed
    function isTokenAllowed(address token) external view returns (bool) {
        return _allowedTokens[token];
    }

    // ============ Admin Functions ============

    /// @notice Set the treasury address
    /// @param _treasury New treasury address
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert InvalidTreasury();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Set the protocol fee in basis points
    /// @param _feeBp New fee in basis points (max 500 = 5%)
    function setProtocolFeeBp(uint256 _feeBp) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBp > MAX_FEE_BP) revert FeeTooHigh();
        protocolFeeBp = _feeBp;
        emit ProtocolFeeUpdated(_feeBp);
    }

    // ============ Internal Functions ============

    /// @notice Emit a state transition event
    /// @param escrowId The escrow ID
    /// @param from The previous state
    /// @param to The new state
    function _emitStateTransition(uint256 escrowId, State from, State to) internal {
        emit StateTransition(escrowId, from, to, block.timestamp, msg.sender);
    }

    /// @notice Deduct protocol fee and transfer to facilitator/treasury
    /// @param token Token address
    /// @param amount Amount to deduct fee from
    /// @param _facilitator Facilitator address
    /// @param escrowId Escrow ID for event emission
    /// @return netAmount Amount after fee deduction
    function _deductAndTransferFee(
        address token,
        uint256 amount,
        address _facilitator,
        uint256 escrowId
    ) internal returns (uint256 netAmount) {
        // No fee if protocolFeeBp is 0 or treasury not set
        if (protocolFeeBp == 0 || treasury == address(0)) {
            return amount;
        }

        // Calculate fee
        uint256 fee = (amount * protocolFeeBp) / BP;

        // Apply minimum fee if fee > 0 but below minimum
        if (fee > 0 && fee < MIN_FEE) {
            fee = MIN_FEE;
        }

        // Safety: cap fee at half the amount
        if (fee > amount / 2) {
            fee = amount / 2;
        }

        // Split fee between facilitator and treasury
        uint256 facilitatorShare = 0;
        uint256 treasuryShare = fee;

        if (_facilitator != address(0)) {
            facilitatorShare = (fee * FACILITATOR_SHARE_BP) / BP;
            treasuryShare = fee - facilitatorShare;
        }

        // Transfer shares
        if (facilitatorShare > 0) {
            IERC20(token).safeTransfer(_facilitator, facilitatorShare);
        }
        if (treasuryShare > 0) {
            IERC20(token).safeTransfer(treasury, treasuryShare);
        }

        emit ProtocolFeeCollected(escrowId, fee, _facilitator, facilitatorShare, treasuryShare);

        return amount - fee;
    }

    /// @notice Get escrow by ID, revert if not found
    /// @param escrowId The escrow ID to look up
    /// @return The Escrow storage reference
    function _getEscrow(uint256 escrowId) internal view returns (Escrow storage) {
        Escrow storage e = _escrows[escrowId];
        if (e.id == 0) revert EscrowNotFound();
        return e;
    }

    /// @notice Record a transaction in the TrustRegistry
    /// @param agentDid The agent DID to record for
    /// @param volumeUsd The transaction volume
    /// @param successful Whether the transaction was successful
    function _recordTransaction(bytes32 agentDid, uint256 volumeUsd, bool successful) internal {
        // Convert token amount to USD cents (assuming 6 decimal token like USDC)
        // 1 USDC = 100 cents, so amount / 10000 gives cents
        uint256 volumeInCents = volumeUsd / 10000;

        // Try to record the transaction; if it fails (e.g., no ORACLE_ROLE), continue silently
        try trustRegistry.recordTransaction(agentDid, volumeInCents, successful) {
        // Transaction recorded successfully
        }
        catch {
            // Recording failed (likely missing ORACLE_ROLE), but don't block the escrow operation
            emit ReputationRecordingFailed(agentDid, successful);
        }
    }
}
