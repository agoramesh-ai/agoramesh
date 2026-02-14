// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IDisputeResolution.sol";
import "./interfaces/IAgentMeshEscrow.sol";
import "./interfaces/ITrustRegistry.sol";

/// @title TieredDisputeResolution - AgentMe Dispute Resolution
/// @notice Implements tiered dispute resolution: Auto, AI-Assisted, and Community
/// @dev Follows spec: Tier 1 (<$10), Tier 2 ($10-$1000), Tier 3 (>$1000)
contract TieredDisputeResolution is IDisputeResolution, AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Role for AI oracle to submit analysis
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Tier thresholds in USDC (6 decimals)
    uint256 public constant TIER1_MAX = 10 * 1e6; // $10
    uint256 public constant TIER2_MAX = 1000 * 1e6; // $1,000

    /// @notice Time periods
    uint256 public constant EVIDENCE_PERIOD = 48 hours;
    uint256 public constant VOTING_PERIOD = 24 hours;
    uint256 public constant APPEAL_PERIOD = 48 hours;

    /// @notice Fee percentages (basis points)
    uint256 public constant TIER2_FEE_BP = 300; // 3%
    uint256 public constant TIER3_FEE_BP = 500; // 5%

    /// @notice Minimum fees
    uint256 public constant TIER2_MIN_FEE = 5 * 1e6; // $5
    uint256 public constant TIER3_MIN_FEE = 50 * 1e6; // $50

    /// @notice Basis points denominator
    uint256 private constant BP = 10000;

    // ============ State Variables ============

    /// @notice Reference to the Escrow contract
    IAgentMeshEscrow public immutable escrow;

    /// @notice Reference to the Trust Registry
    ITrustRegistry public immutable trustRegistry;

    /// @notice Payment token (USDC)
    IERC20 public immutable paymentToken;

    /// @notice Counter for dispute IDs
    uint256 private _nextDisputeId;

    /// @notice Mapping from dispute ID to Dispute struct
    mapping(uint256 => Dispute) private _disputes;

    /// @notice Mapping from dispute ID to votes
    mapping(uint256 => ArbiterVote[]) private _votes;

    /// @notice Mapping from dispute ID to selected arbiters
    mapping(uint256 => address[]) private _arbiters;

    /// @notice Mapping from escrow ID to dispute ID
    mapping(uint256 => uint256) private _escrowToDispute;

    /// @notice Fee pool for arbiter rewards
    uint256 public feePool;

    // ============ Errors ============

    error InvalidEscrow();
    error InvalidTrustRegistry();
    error InvalidPaymentToken();
    error InvalidAdmin();
    error EscrowNotDisputed();
    error NotParty();
    error DisputeNotFound();
    error InvalidState();
    error EvidencePeriodEnded();
    error EvidencePeriodNotEnded();
    error VotingPeriodEnded();
    error VotingPeriodNotEnded();
    error AppealPeriodEnded();
    error AppealPeriodNotEnded();
    error CannotAutoResolve();
    error NotTier1();
    error MaxAppealsReached();
    error InsufficientFee();
    error NotArbiter();
    error AlreadyVoted();
    error InvalidClientShare();
    error DisputeAlreadyExists();
    error NotDisputeParty();
    error NoFeesToWithdraw();
    error QuorumNotMet();
    error ArbiterAlreadyRegistered();
    error EscrowNotInDisputedState();

    // ============ Constructor ============

    /// @notice Initialize the dispute resolution contract
    /// @param _escrow Address of the Escrow contract
    /// @param _trustRegistry Address of the Trust Registry
    /// @param _paymentToken Address of the payment token (USDC)
    /// @param _admin Address of the admin
    constructor(address _escrow, address _trustRegistry, address _paymentToken, address _admin) {
        if (_escrow == address(0)) revert InvalidEscrow();
        if (_trustRegistry == address(0)) revert InvalidTrustRegistry();
        if (_paymentToken == address(0)) revert InvalidPaymentToken();
        if (_admin == address(0)) revert InvalidAdmin();

        escrow = IAgentMeshEscrow(_escrow);
        trustRegistry = ITrustRegistry(_trustRegistry);
        paymentToken = IERC20(_paymentToken);

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Dispute Creation ============

    /// @inheritdoc IDisputeResolution
    function createDispute(uint256 escrowId, bytes32 evidenceCID) external override returns (uint256 disputeId) {
        // Get escrow details
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);

        // Verify no dispute already exists for this escrow
        if (_escrowToDispute[escrowId] != 0) revert DisputeAlreadyExists();

        // Verify escrow is in DISPUTED state
        if (e.state != IAgentMeshEscrow.State.DISPUTED) {
            revert EscrowNotDisputed();
        }

        // Verify caller is a party
        if (msg.sender != e.clientAddress && msg.sender != e.providerAddress) {
            revert NotParty();
        }

        // Determine tier based on amount
        Tier tier = determineTier(e.amount);

        // Calculate and collect fee for Tier 2+
        if (tier != Tier.AUTO) {
            uint256 fee = calculateFee(tier, e.amount);
            paymentToken.safeTransferFrom(msg.sender, address(this), fee);
            feePool += fee;
        }

        // Generate dispute ID
        disputeId = ++_nextDisputeId;

        // Create dispute record
        _disputes[disputeId] = Dispute({
            id: disputeId,
            escrowId: escrowId,
            clientDid: e.clientDid,
            providerDid: e.providerDid,
            amount: e.amount,
            tier: tier,
            state: DisputeState.EVIDENCE_PERIOD,
            createdAt: block.timestamp,
            evidenceDeadline: block.timestamp + EVIDENCE_PERIOD,
            votingDeadline: 0,
            appealDeadline: 0,
            appealRound: 0,
            clientEvidenceCID: msg.sender == e.clientAddress ? evidenceCID : bytes32(0),
            providerEvidenceCID: msg.sender == e.providerAddress ? evidenceCID : bytes32(0),
            aiAnalysisCID: bytes32(0),
            clientShare: 0,
            providerShare: 0
        });

        _escrowToDispute[escrowId] = disputeId;

        emit DisputeCreated(disputeId, escrowId, tier, e.amount);
    }

    // ============ Evidence Submission ============

    /// @inheritdoc IDisputeResolution
    function submitEvidence(uint256 disputeId, bytes32 evidenceCID) external override {
        Dispute storage d = _getDispute(disputeId);

        // Verify in evidence period
        if (d.state != DisputeState.EVIDENCE_PERIOD) {
            revert InvalidState();
        }
        if (block.timestamp > d.evidenceDeadline) {
            revert EvidencePeriodEnded();
        }

        // Get escrow to verify party
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);

        if (msg.sender == e.clientAddress) {
            d.clientEvidenceCID = evidenceCID;
        } else if (msg.sender == e.providerAddress) {
            d.providerEvidenceCID = evidenceCID;
        } else {
            revert NotParty();
        }

        emit EvidenceSubmitted(disputeId, msg.sender == e.clientAddress ? d.clientDid : d.providerDid, evidenceCID);
    }

    // ============ AI Analysis (Tier 2+) ============

    /// @inheritdoc IDisputeResolution
    function submitAIAnalysis(uint256 disputeId, bytes32 analysisCID, uint256 suggestedClientShare)
        external
        override
        onlyRole(ORACLE_ROLE)
    {
        Dispute storage d = _getDispute(disputeId);

        // Must be Tier 2+ and evidence period must be over
        if (d.tier == Tier.AUTO) {
            revert NotTier1();
        }
        if (block.timestamp <= d.evidenceDeadline) {
            revert EvidencePeriodNotEnded();
        }
        if (suggestedClientShare > BP) {
            revert InvalidClientShare();
        }

        d.aiAnalysisCID = analysisCID;
        d.state = DisputeState.VOTING;
        d.votingDeadline = block.timestamp + VOTING_PERIOD;

        // Select arbiters for voting
        _selectArbiters(disputeId);

        emit AIAnalysisCompleted(disputeId, analysisCID, suggestedClientShare);
    }

    // ============ Voting ============

    /// @inheritdoc IDisputeResolution
    function castVote(uint256 disputeId, Vote vote, uint256 clientShareProposal, bytes32 justificationCID)
        external
        override
    {
        Dispute storage d = _getDispute(disputeId);

        // Verify voting state
        if (d.state != DisputeState.VOTING) {
            revert InvalidState();
        }
        if (block.timestamp > d.votingDeadline) {
            revert VotingPeriodEnded();
        }

        // Verify caller is an arbiter for this dispute
        // First check they are not a party to the dispute (conflict of interest)
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);
        if (msg.sender == e.clientAddress || msg.sender == e.providerAddress) {
            revert NotArbiter();
        }

        // Verify caller is in the selected arbiters list
        if (!_isSelectedArbiter(disputeId, msg.sender)) {
            revert NotArbiter();
        }

        // Check not already voted
        for (uint256 i = 0; i < _votes[disputeId].length; i++) {
            if (_votes[disputeId][i].arbiter == msg.sender) {
                revert AlreadyVoted();
            }
        }

        // Validate split proposal
        if (vote == Vote.SPLIT && clientShareProposal > BP) {
            revert InvalidClientShare();
        }

        _votes[disputeId].push(
            ArbiterVote({
                arbiter: msg.sender,
                vote: vote,
                clientShareProposal: vote == Vote.SPLIT ? clientShareProposal : 0,
                justificationCID: justificationCID,
                votedAt: block.timestamp
            })
        );

        emit ArbiterVoted(disputeId, msg.sender, vote);
    }

    /// @inheritdoc IDisputeResolution
    function finalizeRuling(uint256 disputeId) external override {
        Dispute storage d = _getDispute(disputeId);

        // Verify voting period ended
        if (d.state != DisputeState.VOTING) {
            revert InvalidState();
        }
        if (block.timestamp <= d.votingDeadline) {
            revert VotingPeriodNotEnded();
        }

        // Enforce minimum quorum: at least 2/3 of selected arbiters must vote
        ArbiterVote[] storage votes = _votes[disputeId];
        uint256 requiredArbiters = getArbiterCount(d.tier, d.appealRound);
        uint256 minQuorum = (requiredArbiters * 2 + 2) / 3; // ceil(2/3)
        if (votes.length < minQuorum) revert QuorumNotMet();

        // Count votes
        uint256 clientVotes = 0;
        uint256 providerVotes = 0;
        uint256 splitTotal = 0;
        uint256 splitCount = 0;

        for (uint256 i = 0; i < votes.length; i++) {
            if (votes[i].vote == Vote.FAVOR_CLIENT) {
                clientVotes++;
            } else if (votes[i].vote == Vote.FAVOR_PROVIDER) {
                providerVotes++;
            } else if (votes[i].vote == Vote.SPLIT) {
                splitTotal += votes[i].clientShareProposal;
                splitCount++;
            }
        }

        // Determine ruling
        if (clientVotes > providerVotes && clientVotes >= splitCount) {
            d.clientShare = BP;
            d.providerShare = 0;
        } else if (providerVotes > clientVotes && providerVotes >= splitCount) {
            d.clientShare = 0;
            d.providerShare = BP;
        } else if (splitCount > 0) {
            // Average of split proposals
            d.clientShare = splitTotal / splitCount;
            d.providerShare = BP - d.clientShare;
        } else {
            // No votes or tie - default to 50/50
            d.clientShare = BP / 2;
            d.providerShare = BP / 2;
        }

        d.state = DisputeState.APPEALABLE;
        d.appealDeadline = block.timestamp + APPEAL_PERIOD;

        emit RulingGiven(disputeId, d.clientShare, d.providerShare, true);
    }

    // ============ Appeal ============

    /// @inheritdoc IDisputeResolution
    function appeal(uint256 disputeId) external override {
        Dispute storage d = _getDispute(disputeId);

        // Verify appealable state
        if (d.state != DisputeState.APPEALABLE) {
            revert InvalidState();
        }
        if (block.timestamp > d.appealDeadline) {
            revert AppealPeriodEnded();
        }

        // Max 4 appeal rounds
        if (d.appealRound >= 4) {
            revert MaxAppealsReached();
        }

        // Verify caller is a party
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);
        if (msg.sender != e.clientAddress && msg.sender != e.providerAddress) {
            revert NotParty();
        }

        // Collect appeal fee (escalates to Tier 3)
        uint256 fee = calculateFee(Tier.COMMUNITY, d.amount);
        paymentToken.safeTransferFrom(msg.sender, address(this), fee);
        feePool += fee;

        // Escalate to Tier 3 and increment round
        d.tier = Tier.COMMUNITY;
        d.appealRound++;
        d.state = DisputeState.VOTING;
        d.votingDeadline = block.timestamp + VOTING_PERIOD;

        // Clear previous votes
        delete _votes[disputeId];

        // Select new arbiters (more for appeals)
        _selectArbiters(disputeId);

        emit AppealFiled(disputeId, msg.sender, d.appealRound);
    }

    // ============ Settlement ============

    /// @inheritdoc IDisputeResolution
    function executeSettlement(uint256 disputeId) external override nonReentrant {
        Dispute storage d = _getDispute(disputeId);

        // Verify appealable and appeal period passed
        if (d.state != DisputeState.APPEALABLE) {
            revert InvalidState();
        }
        if (block.timestamp <= d.appealDeadline) {
            revert AppealPeriodNotEnded();
        }

        // Get escrow details and verify it is still in DISPUTED state
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);
        if (e.state != IAgentMeshEscrow.State.DISPUTED) revert EscrowNotInDisputedState();

        d.state = DisputeState.SETTLED;

        // Calculate amounts
        uint256 clientAmount = (e.amount * d.clientShare) / BP;
        uint256 providerAmount = e.amount - clientAmount;

        // Resolve dispute in escrow contract
        escrow.resolveDispute(d.escrowId, d.providerShare > d.clientShare, providerAmount);

        emit DisputeSettled(disputeId, clientAmount, providerAmount);
    }

    // ============ Auto-Resolution (Tier 1) ============

    /// @inheritdoc IDisputeResolution
    function checkAutoResolution(uint256 disputeId)
        external
        view
        override
        returns (bool canResolve, uint256 clientShare)
    {
        Dispute storage d = _disputes[disputeId];

        if (d.id == 0) {
            return (false, 0);
        }

        // Must be Tier 1
        if (d.tier != Tier.AUTO) {
            return (false, 0);
        }

        // Must be past evidence period
        if (block.timestamp <= d.evidenceDeadline) {
            return (false, 0);
        }

        // Auto-resolution logic:
        // - No provider evidence = full refund to client
        // - No client evidence = full release to provider
        // - Both evidence = 50/50 split (requires human review in reality)
        if (d.providerEvidenceCID == bytes32(0)) {
            return (true, BP); // 100% to client
        } else if (d.clientEvidenceCID == bytes32(0)) {
            return (true, 0); // 100% to provider
        } else {
            return (true, BP / 2); // 50/50
        }
    }

    /// @inheritdoc IDisputeResolution
    function executeAutoResolution(uint256 disputeId) external override nonReentrant {
        Dispute storage d = _getDispute(disputeId);

        // Verify caller is a party to the dispute
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);
        if (msg.sender != e.clientAddress && msg.sender != e.providerAddress) revert NotDisputeParty();

        // Must be Tier 1
        if (d.tier != Tier.AUTO) {
            revert NotTier1();
        }

        // Must be past evidence period
        if (block.timestamp <= d.evidenceDeadline) {
            revert EvidencePeriodNotEnded();
        }

        (bool canResolve, uint256 clientShare) = this.checkAutoResolution(disputeId);
        if (!canResolve) {
            revert CannotAutoResolve();
        }

        d.clientShare = clientShare;
        d.providerShare = BP - clientShare;
        d.state = DisputeState.SETTLED;

        // Calculate amounts (reuse e from party verification above)
        uint256 clientAmount = (e.amount * clientShare) / BP;
        uint256 providerAmount = e.amount - clientAmount;

        // Resolve dispute in escrow contract
        escrow.resolveDispute(d.escrowId, providerAmount > clientAmount, providerAmount);

        emit DisputeSettled(disputeId, clientAmount, providerAmount);
    }

    // ============ View Functions ============

    /// @inheritdoc IDisputeResolution
    function getDispute(uint256 disputeId) external view override returns (Dispute memory) {
        return _disputes[disputeId];
    }

    /// @inheritdoc IDisputeResolution
    function getVotes(uint256 disputeId) external view override returns (ArbiterVote[] memory) {
        return _votes[disputeId];
    }

    /// @inheritdoc IDisputeResolution
    function getArbiters(uint256 disputeId) external view override returns (address[] memory) {
        return _arbiters[disputeId];
    }

    /// @inheritdoc IDisputeResolution
    function calculateFee(Tier tier, uint256 amount) public pure override returns (uint256 fee) {
        if (tier == Tier.AUTO) {
            return 0;
        } else if (tier == Tier.AI_ASSISTED) {
            fee = (amount * TIER2_FEE_BP) / BP;
            if (fee < TIER2_MIN_FEE) {
                fee = TIER2_MIN_FEE;
            }
        } else {
            fee = (amount * TIER3_FEE_BP) / BP;
            if (fee < TIER3_MIN_FEE) {
                fee = TIER3_MIN_FEE;
            }
        }
    }

    /// @inheritdoc IDisputeResolution
    function determineTier(uint256 amount) public pure override returns (Tier tier) {
        if (amount <= TIER1_MAX) {
            return Tier.AUTO;
        } else if (amount <= TIER2_MAX) {
            return Tier.AI_ASSISTED;
        } else {
            return Tier.COMMUNITY;
        }
    }

    /// @inheritdoc IDisputeResolution
    function getArbiterCount(Tier tier, uint8 round) public pure override returns (uint256) {
        if (tier == Tier.AUTO) {
            return 0;
        } else if (tier == Tier.AI_ASSISTED) {
            return 3;
        } else {
            // Community: 5, 11, 23, 47 for rounds 0, 1, 2, 3
            if (round == 0) return 5;
            if (round == 1) return 11;
            if (round == 2) return 23;
            return 47;
        }
    }

    // ============ Internal Functions ============

    /// @notice Get dispute by ID, revert if not found
    function _getDispute(uint256 disputeId) internal view returns (Dispute storage) {
        Dispute storage d = _disputes[disputeId];
        if (d.id == 0) {
            revert DisputeNotFound();
        }
        return d;
    }

    /// @notice Select arbiters for a dispute
    /// @dev In production, would use weighted random selection based on stake/trust
    function _selectArbiters(uint256 disputeId) internal {
        Dispute storage d = _disputes[disputeId];
        uint256 count = getArbiterCount(d.tier, d.appealRound);

        // Clear previous arbiters
        delete _arbiters[disputeId];

        // Get escrow to exclude parties from arbiter selection
        IAgentMeshEscrow.Escrow memory e = escrow.getEscrow(d.escrowId);

        // Select arbiters from the eligible pool
        // In production: weighted random selection from TrustRegistry with Chainlink VRF
        // For now: select first N eligible arbiters who are not parties
        uint256 poolSize = _eligibleArbitersCount;
        uint256 selected = 0;

        for (uint256 i = 0; i < poolSize && selected < count; i++) {
            address candidate = _eligibleArbiters[i];
            // Skip if candidate is a party to the dispute
            if (candidate != e.clientAddress && candidate != e.providerAddress) {
                _arbiters[disputeId].push(candidate);
                selected++;
            }
        }
    }

    /// @notice Check if an address is a selected arbiter for a dispute
    /// @param disputeId The dispute ID
    /// @param arbiter The address to check
    /// @return True if the address is a selected arbiter
    function _isSelectedArbiter(uint256 disputeId, address arbiter) internal view returns (bool) {
        address[] storage selectedArbiters = _arbiters[disputeId];
        for (uint256 i = 0; i < selectedArbiters.length; i++) {
            if (selectedArbiters[i] == arbiter) {
                return true;
            }
        }
        return false;
    }

    // ============ Fee Management ============

    /// @notice Withdraw accumulated fees
    /// @param to Address to send fees to
    function withdrawFees(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 amount = feePool;
        if (amount == 0) revert NoFeesToWithdraw();
        feePool = 0;
        paymentToken.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // ============ Arbiter Pool Management ============

    /// @notice Pool of eligible arbiters (for testing/simple implementation)
    /// @dev In production, this would query TrustRegistry for qualified arbiters
    address[] private _eligibleArbiters;
    uint256 private _eligibleArbitersCount;

    /// @notice Register an address as an eligible arbiter
    /// @dev In production, eligibility would be determined by TrustRegistry
    /// @param arbiter The address to register
    function registerArbiter(address arbiter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(arbiter != address(0), "Invalid arbiter address");

        // Check not already registered
        for (uint256 i = 0; i < _eligibleArbitersCount; i++) {
            if (_eligibleArbiters[i] == arbiter) {
                revert ArbiterAlreadyRegistered();
            }
        }

        _eligibleArbiters.push(arbiter);
        _eligibleArbitersCount++;

        emit ArbiterRegistered(arbiter);
    }

    /// @notice Remove an address from the eligible arbiter pool
    /// @param arbiter The address to remove
    function unregisterArbiter(address arbiter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < _eligibleArbitersCount; i++) {
            if (_eligibleArbiters[i] == arbiter) {
                // Swap with last element and pop
                _eligibleArbiters[i] = _eligibleArbiters[_eligibleArbitersCount - 1];
                _eligibleArbiters.pop();
                _eligibleArbitersCount--;
                emit ArbiterUnregistered(arbiter);
                return;
            }
        }
    }

    /// @notice Get the list of eligible arbiters
    /// @return List of eligible arbiter addresses
    function getEligibleArbiters() external view returns (address[] memory) {
        return _eligibleArbiters;
    }

    // ============ Events ============

    /// @notice Emitted when an arbiter is registered
    event ArbiterRegistered(address indexed arbiter);

    /// @notice Emitted when an arbiter is unregistered
    event ArbiterUnregistered(address indexed arbiter);

    /// @notice Emitted when accumulated fees are withdrawn
    event FeesWithdrawn(address indexed to, uint256 amount);
}
