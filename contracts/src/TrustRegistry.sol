// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/ITrustRegistry.sol";

/// @title TrustRegistry - AgoraMesh Trust Layer
/// @notice Manages agent registration, reputation, staking, and endorsements
/// @dev Implements ITrustRegistry with AccessControl for role-based permissions
contract TrustRegistry is ITrustRegistry, AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Role for recording transactions (oracle)
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Role for slashing stakes (arbiter)
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    /// @notice Cooldown period before stake can be withdrawn
    uint256 public constant STAKE_COOLDOWN = 7 days;

    /// @notice Minimum stake required ($100 USDC)
    uint256 public constant MINIMUM_STAKE = 100 * 1e6;

    /// @notice Reference stake for maximum stake score (10,000 USDC)
    uint256 public constant REFERENCE_STAKE = 10_000 * 1e6;

    /// @notice Weight for reputation in composite score (50%)
    uint256 public constant REPUTATION_WEIGHT = 5000;

    /// @notice Weight for stake in composite score (30%)
    uint256 public constant STAKE_WEIGHT = 3000;

    /// @notice Weight for endorsements in composite score (20%)
    uint256 public constant ENDORSEMENT_WEIGHT = 2000;

    /// @notice Maximum number of endorsements per agent
    uint256 public constant MAX_ENDORSEMENTS = 10;

    /// @notice Basis points denominator (100%)
    uint256 private constant BASIS_POINTS = 10000;

    // ============ State Variables ============

    /// @notice USDC token used for staking
    IERC20 public immutable stakingToken;

    /// @notice Mapping from DID hash to agent info
    mapping(bytes32 => AgentInfo) private _agents;

    /// @notice Mapping from DID hash to trust data
    mapping(bytes32 => TrustData) private _trustData;

    /// @notice Mapping from DID hash to array of endorsements
    mapping(bytes32 => Endorsement[]) private _endorsements;

    /// @notice Mapping from endorser DID to endorsee DID to endorsement index
    mapping(bytes32 => mapping(bytes32 => uint256)) private _endorsementIndex;

    /// @notice Mapping from endorser DID to endorsee DID to whether endorsement exists
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasEndorsement;

    /// @notice Mapping from owner address to their agent DID
    mapping(address => bytes32) private _ownerToAgent;

    /// @notice Pending withdrawal amounts
    mapping(bytes32 => uint256) private _pendingWithdrawals;

    /// @notice Treasury address for slashed funds
    address public treasury;

    // ============ Errors ============

    error AgentAlreadyRegistered();
    error AgentNotRegistered();
    error AgentNotActive();
    error NotAgentOwner();
    error InvalidCapabilityCardCID();
    error InvalidStakeAmount();
    error InsufficientStake();
    error CooldownNotPassed();
    error NoWithdrawPending();
    error CannotEndorseSelf();
    error AlreadyEndorsed();
    error EndorsementNotFound();
    error MaxEndorsementsReached();
    error EndorseeNotRegistered();
    error InvalidStakingToken();
    error InvalidAdmin();
    error OwnerAlreadyHasAgent();
    error WithdrawalAlreadyPending();
    error StakeBelowMinimum();
    error WithdrawalBelowMinimumStake();
    error InvalidDIDHash();

    // ============ Constructor ============

    /// @notice Initialize the TrustRegistry
    /// @param _stakingToken Address of the USDC token
    /// @param _admin Address of the admin
    constructor(address _stakingToken, address _admin) {
        if (_stakingToken == address(0)) revert InvalidStakingToken();
        if (_admin == address(0)) revert InvalidAdmin();
        stakingToken = IERC20(_stakingToken);
        treasury = _admin;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Registration Functions ============

    /// @inheritdoc ITrustRegistry
    function registerAgent(bytes32 didHash, string calldata capabilityCardCID) external override {
        if (didHash == bytes32(0)) revert InvalidDIDHash();
        if (_agents[didHash].owner != address(0)) {
            revert AgentAlreadyRegistered();
        }
        if (bytes(capabilityCardCID).length == 0) {
            revert InvalidCapabilityCardCID();
        }

        if (_ownerToAgent[msg.sender] != bytes32(0)) {
            revert OwnerAlreadyHasAgent();
        }

        _agents[didHash] = AgentInfo({
            didHash: didHash,
            owner: msg.sender,
            capabilityCardCID: capabilityCardCID,
            registeredAt: block.timestamp,
            isActive: true
        });

        _ownerToAgent[msg.sender] = didHash;

        emit AgentRegistered(didHash, msg.sender, capabilityCardCID);
    }

    /// @inheritdoc ITrustRegistry
    function updateCapabilityCard(bytes32 didHash, string calldata newCID) external override {
        _requireOwner(didHash);
        _requireActive(didHash);

        if (bytes(newCID).length == 0) {
            revert InvalidCapabilityCardCID();
        }

        _agents[didHash].capabilityCardCID = newCID;

        emit AgentUpdated(didHash, newCID);
    }

    /// @inheritdoc ITrustRegistry
    function deactivateAgent(bytes32 didHash) external override {
        _requireOwner(didHash);
        _requireActive(didHash);

        _agents[didHash].isActive = false;

        emit AgentDeactivated(didHash);
    }

    // ============ Reputation Functions ============

    /// @inheritdoc ITrustRegistry
    function recordTransaction(bytes32 agentDid, uint256 volumeUsd, bool successful)
        external
        override
        onlyRole(ORACLE_ROLE)
    {
        _requireRegistered(agentDid);

        TrustData storage data = _trustData[agentDid];
        data.totalTransactions += 1;
        if (successful) {
            data.successfulTransactions += 1;
        }
        data.totalVolumeUsd += volumeUsd;
        data.lastActivityTimestamp = block.timestamp;

        // Calculate new reputation score
        data.reputationScore = _calculateReputationScore(agentDid);

        emit ReputationUpdated(agentDid, data.reputationScore, data.totalTransactions);
    }

    /// @inheritdoc ITrustRegistry
    function getReputation(bytes32 didHash)
        external
        view
        override
        returns (uint256 score, uint256 transactions, uint256 successRate)
    {
        TrustData storage data = _trustData[didHash];
        score = data.reputationScore;
        transactions = data.totalTransactions;

        if (data.totalTransactions > 0) {
            successRate = (data.successfulTransactions * BASIS_POINTS) / data.totalTransactions;
        }
    }

    // ============ Staking Functions ============

    /// @inheritdoc ITrustRegistry
    function depositStake(bytes32 didHash, uint256 amount) external override nonReentrant {
        _requireOwner(didHash);
        _requireActive(didHash);

        if (amount == 0) {
            revert InvalidStakeAmount();
        }

        uint256 newTotal = _trustData[didHash].stakedAmount + amount;
        if (newTotal < MINIMUM_STAKE) {
            revert StakeBelowMinimum();
        }

        _trustData[didHash].stakedAmount = newTotal;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit StakeDeposited(didHash, amount);
    }

    /// @inheritdoc ITrustRegistry
    function requestWithdraw(bytes32 didHash, uint256 amount) external override returns (uint256 unlockTime) {
        _requireOwner(didHash);

        if (_pendingWithdrawals[didHash] > 0) {
            revert WithdrawalAlreadyPending();
        }

        TrustData storage data = _trustData[didHash];

        if (amount > data.stakedAmount) {
            revert InsufficientStake();
        }

        // Check that remaining stake is either 0 or >= MINIMUM_STAKE
        uint256 remaining = data.stakedAmount - amount;
        if (remaining > 0 && remaining < MINIMUM_STAKE) {
            revert WithdrawalBelowMinimumStake();
        }

        // Subtract pending amount from stakedAmount immediately to prevent race with slashing
        data.stakedAmount -= amount;

        unlockTime = block.timestamp + STAKE_COOLDOWN;
        data.stakeUnlockTime = unlockTime;
        _pendingWithdrawals[didHash] = amount;

        emit StakeWithdrawRequested(didHash, amount, unlockTime);
    }

    /// @inheritdoc ITrustRegistry
    function executeWithdraw(bytes32 didHash) external override nonReentrant returns (uint256 withdrawnAmount) {
        _requireOwner(didHash);

        TrustData storage data = _trustData[didHash];
        withdrawnAmount = _pendingWithdrawals[didHash];

        if (withdrawnAmount == 0) {
            revert NoWithdrawPending();
        }

        if (block.timestamp < data.stakeUnlockTime) {
            revert CooldownNotPassed();
        }

        // stakedAmount was already subtracted in requestWithdraw, so no need to subtract again
        data.stakeUnlockTime = 0;
        _pendingWithdrawals[didHash] = 0;

        stakingToken.safeTransfer(_agents[didHash].owner, withdrawnAmount);

        emit StakeWithdrawn(didHash, withdrawnAmount);
    }

    /// @inheritdoc ITrustRegistry
    function slash(bytes32 didHash, uint256 amount, bytes32 disputeId)
        external
        override
        onlyRole(ARBITER_ROLE)
        nonReentrant
    {
        TrustData storage data = _trustData[didHash];

        // If there's a pending withdrawal, add it back to stakedAmount before slashing
        // (it was subtracted in requestWithdraw to prevent the withdrawal race)
        uint256 pendingAmount = _pendingWithdrawals[didHash];
        if (pendingAmount > 0) {
            data.stakedAmount += pendingAmount;
            _pendingWithdrawals[didHash] = 0;
            data.stakeUnlockTime = 0;
        }

        if (amount > data.stakedAmount) {
            revert InsufficientStake();
        }

        data.stakedAmount -= amount;

        // Transfer slashed funds to treasury
        stakingToken.safeTransfer(treasury, amount);

        emit StakeSlashed(didHash, amount, disputeId);
    }

    // ============ Admin Functions ============

    /// @notice Set the treasury address for slashed funds
    /// @param _treasury New treasury address
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert InvalidAdmin();
        treasury = _treasury;
    }

    // ============ Endorsement Functions ============

    /// @inheritdoc ITrustRegistry
    function endorse(bytes32 endorseeDid, string calldata message) external override {
        bytes32 endorserDid = _ownerToAgent[msg.sender];

        if (endorserDid == bytes32(0)) {
            revert AgentNotRegistered();
        }

        if (_agents[endorseeDid].owner == address(0)) {
            revert EndorseeNotRegistered();
        }

        if (endorserDid == endorseeDid) {
            revert CannotEndorseSelf();
        }

        if (_hasEndorsement[endorserDid][endorseeDid]) {
            revert AlreadyEndorsed();
        }

        if (_endorsements[endorseeDid].length >= MAX_ENDORSEMENTS) {
            revert MaxEndorsementsReached();
        }

        Endorsement memory newEndorsement = Endorsement({
            endorserDid: endorserDid,
            endorseeDid: endorseeDid,
            timestamp: block.timestamp,
            message: message,
            isActive: true
        });

        _endorsements[endorseeDid].push(newEndorsement);
        _endorsementIndex[endorserDid][endorseeDid] = _endorsements[endorseeDid].length - 1;
        _hasEndorsement[endorserDid][endorseeDid] = true;

        emit EndorsementAdded(endorserDid, endorseeDid, message);
    }

    /// @inheritdoc ITrustRegistry
    function revokeEndorsement(bytes32 endorseeDid) external override {
        bytes32 endorserDid = _ownerToAgent[msg.sender];

        if (!_hasEndorsement[endorserDid][endorseeDid]) {
            revert EndorsementNotFound();
        }

        uint256 index = _endorsementIndex[endorserDid][endorseeDid];
        uint256 lastIndex = _endorsements[endorseeDid].length - 1;

        // Move last element to deleted position
        if (index != lastIndex) {
            Endorsement memory lastEndorsement = _endorsements[endorseeDid][lastIndex];
            _endorsements[endorseeDid][index] = lastEndorsement;
            _endorsementIndex[lastEndorsement.endorserDid][endorseeDid] = index;
        }

        _endorsements[endorseeDid].pop();
        delete _endorsementIndex[endorserDid][endorseeDid];
        _hasEndorsement[endorserDid][endorseeDid] = false;

        emit EndorsementRevoked(endorserDid, endorseeDid);
    }

    /// @inheritdoc ITrustRegistry
    function getEndorsements(bytes32 didHash) external view override returns (Endorsement[] memory) {
        return _endorsements[didHash];
    }

    // ============ Trust Score Functions ============

    /// @inheritdoc ITrustRegistry
    function getTrustScore(bytes32 didHash) external view override returns (uint256 compositeScore) {
        (,,, compositeScore) = _calculateTrustDetails(didHash);
    }

    /// @inheritdoc ITrustRegistry
    function getTrustDetails(bytes32 didHash)
        external
        view
        override
        returns (uint256 reputationScore, uint256 stakeScore, uint256 endorsementScore, uint256 compositeScore)
    {
        return _calculateTrustDetails(didHash);
    }

    // ============ View Functions ============

    /// @inheritdoc ITrustRegistry
    function getAgent(bytes32 didHash) external view override returns (AgentInfo memory) {
        return _agents[didHash];
    }

    /// @inheritdoc ITrustRegistry
    function getTrustData(bytes32 didHash) external view override returns (TrustData memory) {
        return _trustData[didHash];
    }

    /// @inheritdoc ITrustRegistry
    function isAgentActive(bytes32 didHash) external view override returns (bool) {
        return _agents[didHash].isActive;
    }

    /// @inheritdoc ITrustRegistry
    function getAgentByOwner(address owner) external view override returns (bytes32 didHash) {
        return _ownerToAgent[owner];
    }

    // ============ Internal Functions ============

    /// @notice Calculate reputation score based on transaction history
    /// @param didHash Agent's DID hash
    /// @return score Reputation score (0-10000)
    function _calculateReputationScore(bytes32 didHash) internal view returns (uint256 score) {
        TrustData storage data = _trustData[didHash];

        if (data.totalTransactions == 0) {
            return 0;
        }

        // Success rate component (0-10000)
        uint256 successRate = (data.successfulTransactions * BASIS_POINTS) / data.totalTransactions;

        // Volume factor (logarithmic scaling, caps at $100k)
        // Simple linear scaling for now: 1 point per $100 volume, max 1000 points
        uint256 volumeFactor = data.totalVolumeUsd / 100_00; // Convert cents to $100 units
        if (volumeFactor > 1000) {
            volumeFactor = 1000;
        }

        // Transaction count factor (logarithmic scaling)
        // Simple scaling: 10 points per transaction, max 1000 points
        uint256 txFactor = data.totalTransactions * 10;
        if (txFactor > 1000) {
            txFactor = 1000;
        }

        // Composite: 70% success rate, 15% volume, 15% tx count
        score = (successRate * 7000 + volumeFactor * 10 * 1500 + txFactor * 10 * 1500) / 10000;

        // Cap at 10000
        if (score > BASIS_POINTS) {
            score = BASIS_POINTS;
        }
    }

    /// @notice Calculate all trust score components
    /// @param didHash Agent's DID hash
    /// @return reputationScore Reputation component (0-10000)
    /// @return stakeScore Stake component (0-10000)
    /// @return endorsementScore Endorsement component (0-10000)
    /// @return compositeScore Weighted composite score (0-10000)
    function _calculateTrustDetails(bytes32 didHash)
        internal
        view
        returns (uint256 reputationScore, uint256 stakeScore, uint256 endorsementScore, uint256 compositeScore)
    {
        TrustData storage data = _trustData[didHash];

        // Reputation score
        reputationScore = data.reputationScore;

        // Stake score: linear scaling against reference stake
        if (data.stakedAmount >= REFERENCE_STAKE) {
            stakeScore = BASIS_POINTS;
        } else {
            stakeScore = (data.stakedAmount * BASIS_POINTS) / REFERENCE_STAKE;
        }

        // Endorsement score: based on number and quality of endorsements
        endorsementScore = _calculateEndorsementScore(didHash);

        // Composite score: weighted average
        compositeScore =
            (reputationScore * REPUTATION_WEIGHT + stakeScore * STAKE_WEIGHT + endorsementScore * ENDORSEMENT_WEIGHT)
                / BASIS_POINTS;
    }

    /// @notice Calculate endorsement score
    /// @param didHash Agent's DID hash
    /// @return score Endorsement score (0-10000)
    function _calculateEndorsementScore(bytes32 didHash) internal view returns (uint256 score) {
        Endorsement[] storage endorsements = _endorsements[didHash];
        uint256 count = endorsements.length;

        if (count == 0) {
            return 0;
        }

        // Base score from endorsement count (max 5000 for 10 endorsements)
        uint256 countScore = (count * 500);
        if (countScore > 5000) {
            countScore = 5000;
        }

        // Quality score from endorser reputations (max 5000)
        uint256 totalEndorserRep = 0;
        for (uint256 i = 0; i < count; i++) {
            totalEndorserRep += _trustData[endorsements[i].endorserDid].reputationScore;
        }

        uint256 avgEndorserRep = totalEndorserRep / count;
        uint256 qualityScore = avgEndorserRep / 2; // Max 5000 (half of max reputation)

        score = countScore + qualityScore;
        if (score > BASIS_POINTS) {
            score = BASIS_POINTS;
        }
    }

    /// @notice Require that the caller is the agent owner
    /// @param didHash Agent's DID hash
    function _requireOwner(bytes32 didHash) internal view {
        if (_agents[didHash].owner != msg.sender) {
            revert NotAgentOwner();
        }
    }

    /// @notice Require that the agent is active
    /// @param didHash Agent's DID hash
    function _requireActive(bytes32 didHash) internal view {
        if (!_agents[didHash].isActive) {
            revert AgentNotActive();
        }
    }

    /// @notice Require that the agent is registered
    /// @param didHash Agent's DID hash
    function _requireRegistered(bytes32 didHash) internal view {
        if (_agents[didHash].owner == address(0)) {
            revert AgentNotRegistered();
        }
    }
}
