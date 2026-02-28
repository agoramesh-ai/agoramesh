// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentToken.sol";

/// @title NFTBoundReputation - Reputation Bound to Agent NFTs
/// @notice Manages reputation that is bound to AgentToken NFTs
/// @dev Reputation follows the NFT when transferred
contract NFTBoundReputation is AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Role for recording transactions (oracle)
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Role for slashing stakes (arbiter)
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    /// @notice Minimum stake required ($100 USDC)
    uint256 public constant MINIMUM_STAKE = 100 * 1e6;

    /// @notice Reference stake for maximum stake score (10,000 USDC)
    uint256 public constant REFERENCE_STAKE = 10_000 * 1e6;

    /// @notice Weight for reputation in composite score (60%)
    uint256 public constant REPUTATION_WEIGHT = 6000;

    /// @notice Weight for stake in composite score (40%)
    uint256 public constant STAKE_WEIGHT = 4000;

    /// @notice Basis points denominator (100%)
    uint256 private constant BASIS_POINTS = 10000;

    /// @notice Cooldown period for stake withdrawals (7 days)
    uint256 public constant STAKE_COOLDOWN = 7 days;

    /// @notice Maximum batch size for batchRecordTransactions
    uint256 public constant MAX_BATCH_SIZE = 100;

    // ============ Structs ============

    /// @notice Reputation data for an agent token
    struct ReputationData {
        uint256 reputationScore; // 0-10000 (basis points)
        uint256 totalTransactions;
        uint256 successfulTransactions;
        uint256 totalVolumeUsd; // In cents (6 decimal token)
        uint256 lastActivityTimestamp;
        uint256 stakedAmount; // USDC staked
    }

    // ============ State Variables ============

    /// @notice Reference to the AgentToken contract
    AgentToken public immutable agentToken;

    /// @notice USDC token used for staking
    IERC20 public immutable stakingToken;

    /// @notice Treasury address for slashed funds
    address public treasury;

    /// @notice Mapping from token ID to reputation data
    mapping(uint256 => ReputationData) private _reputations;

    /// @notice Pending stake withdrawal amounts
    mapping(uint256 => uint256) private _pendingWithdrawals;

    /// @notice Unlock time for pending withdrawals
    mapping(uint256 => uint256) private _withdrawUnlockTime;

    // ============ Events ============

    /// @notice Emitted when reputation is updated
    event ReputationUpdated(uint256 indexed tokenId, uint256 newScore, uint256 totalTransactions);

    /// @notice Emitted when stake is deposited
    event StakeDeposited(uint256 indexed tokenId, uint256 amount);

    /// @notice Emitted when stake is slashed
    event StakeSlashed(uint256 indexed tokenId, uint256 amount, bytes32 reason);

    /// @notice Emitted when reputation is transferred
    event ReputationTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    /// @notice Emitted when stake withdrawal is requested
    event StakeWithdrawRequested(uint256 indexed tokenId, uint256 amount, uint256 unlockTime);

    /// @notice Emitted when stake withdrawal is executed
    event StakeWithdrawn(uint256 indexed tokenId, uint256 amount);

    // ============ Errors ============

    error InvalidAgentToken();
    error InvalidStakingToken();
    error InvalidAdmin();
    error TokenNotFound();
    error NotTokenOwner();
    error StakeBelowMinimum();
    error InsufficientStake();
    error ArrayLengthMismatch();
    error InvalidTreasuryAddress();
    error WithdrawalAlreadyPending();
    error WithdrawalBelowMinimumStake();
    error NoWithdrawPending();
    error CooldownNotPassed();
    error BatchTooLarge();

    // ============ Constructor ============

    /// @notice Initialize the NFTBoundReputation contract
    /// @param _agentToken Address of the AgentToken contract
    /// @param _stakingToken Address of the USDC token
    /// @param _admin Address of the admin
    constructor(address _agentToken, address _stakingToken, address _admin) {
        if (_agentToken == address(0)) revert InvalidAgentToken();
        if (_stakingToken == address(0)) revert InvalidStakingToken();
        if (_admin == address(0)) revert InvalidAdmin();

        agentToken = AgentToken(_agentToken);
        stakingToken = IERC20(_stakingToken);
        treasury = _admin;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Transaction Recording ============

    /// @notice Record a transaction for an agent
    /// @param tokenId Agent token ID
    /// @param volumeUsd Transaction volume in USD (6 decimals)
    /// @param successful Whether the transaction was successful
    function recordTransaction(uint256 tokenId, uint256 volumeUsd, bool successful) external onlyRole(ORACLE_ROLE) {
        _requireTokenExists(tokenId);

        ReputationData storage data = _reputations[tokenId];
        data.totalTransactions += 1;
        if (successful) {
            data.successfulTransactions += 1;
        }
        data.totalVolumeUsd += volumeUsd;
        data.lastActivityTimestamp = block.timestamp;

        // Calculate new reputation score
        data.reputationScore = calculateReputationScore(tokenId);

        emit ReputationUpdated(tokenId, data.reputationScore, data.totalTransactions);
    }

    /// @notice Batch record transactions
    /// @param tokenIds Array of token IDs
    /// @param volumes Array of volumes
    /// @param successes Array of success flags
    function batchRecordTransactions(uint256[] calldata tokenIds, uint256[] calldata volumes, bool[] calldata successes)
        external
        onlyRole(ORACLE_ROLE)
    {
        if (tokenIds.length != volumes.length || tokenIds.length != successes.length) {
            revert ArrayLengthMismatch();
        }
        if (tokenIds.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge();
        }

        for (uint256 i = 0; i < tokenIds.length; i++) {
            _requireTokenExists(tokenIds[i]);

            ReputationData storage data = _reputations[tokenIds[i]];
            data.totalTransactions += 1;
            if (successes[i]) {
                data.successfulTransactions += 1;
            }
            data.totalVolumeUsd += volumes[i];
            data.lastActivityTimestamp = block.timestamp;
            data.reputationScore = calculateReputationScore(tokenIds[i]);

            emit ReputationUpdated(tokenIds[i], data.reputationScore, data.totalTransactions);
        }
    }

    // ============ Staking Functions ============

    /// @notice Deposit stake for an agent
    /// @param tokenId Agent token ID
    /// @param amount Amount to stake
    function depositStake(uint256 tokenId, uint256 amount) external nonReentrant {
        _requireTokenOwner(tokenId);

        uint256 newTotal = _reputations[tokenId].stakedAmount + amount;
        if (newTotal < MINIMUM_STAKE) revert StakeBelowMinimum();

        _reputations[tokenId].stakedAmount = newTotal;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit StakeDeposited(tokenId, amount);
    }

    /// @notice Slash an agent's stake
    /// @param tokenId Agent token ID
    /// @param amount Amount to slash
    /// @param disputeId Dispute ID for tracking
    function slash(uint256 tokenId, uint256 amount, bytes32 disputeId) external onlyRole(ARBITER_ROLE) nonReentrant {
        ReputationData storage data = _reputations[tokenId];

        // Reclaim any pending withdrawal first
        uint256 pending = _pendingWithdrawals[tokenId];
        uint256 totalAvailable = data.stakedAmount + pending;
        if (amount > totalAvailable) revert InsufficientStake();

        // Cancel pending withdrawal if needed
        if (pending > 0) {
            _pendingWithdrawals[tokenId] = 0;
            _withdrawUnlockTime[tokenId] = 0;
            data.stakedAmount += pending; // Return pending to staked for slashing
        }

        data.stakedAmount -= amount;

        // Transfer slashed funds to treasury
        stakingToken.safeTransfer(treasury, amount);

        emit StakeSlashed(tokenId, amount, disputeId);
    }

    // ============ Stake Withdrawal Functions ============

    /// @notice Request a stake withdrawal (subject to 7-day cooldown)
    /// @param tokenId Agent token ID
    /// @param amount Amount to withdraw
    /// @return unlockTime When the withdrawal can be executed
    function requestWithdraw(uint256 tokenId, uint256 amount) external returns (uint256 unlockTime) {
        _requireTokenOwner(tokenId);

        if (_pendingWithdrawals[tokenId] > 0) revert WithdrawalAlreadyPending();

        ReputationData storage data = _reputations[tokenId];
        if (amount > data.stakedAmount) revert InsufficientStake();

        // Check remaining stake is either 0 or >= MINIMUM_STAKE
        uint256 remaining = data.stakedAmount - amount;
        if (remaining > 0 && remaining < MINIMUM_STAKE) revert WithdrawalBelowMinimumStake();

        // Subtract immediately to prevent race with slashing
        data.stakedAmount -= amount;

        unlockTime = block.timestamp + STAKE_COOLDOWN;
        _pendingWithdrawals[tokenId] = amount;
        _withdrawUnlockTime[tokenId] = unlockTime;

        emit StakeWithdrawRequested(tokenId, amount, unlockTime);
    }

    /// @notice Execute a pending stake withdrawal after cooldown
    /// @param tokenId Agent token ID
    function executeWithdraw(uint256 tokenId) external nonReentrant {
        _requireTokenOwner(tokenId);

        uint256 amount = _pendingWithdrawals[tokenId];
        if (amount == 0) revert NoWithdrawPending();
        if (block.timestamp < _withdrawUnlockTime[tokenId]) revert CooldownNotPassed();

        _pendingWithdrawals[tokenId] = 0;
        _withdrawUnlockTime[tokenId] = 0;

        stakingToken.safeTransfer(msg.sender, amount);

        emit StakeWithdrawn(tokenId, amount);
    }

    // ============ Query Functions ============

    /// @notice Get reputation data for an agent
    /// @param tokenId Agent token ID
    /// @return score Reputation score (0-10000)
    /// @return transactions Total transactions
    /// @return successRate Success rate in basis points
    function getReputation(uint256 tokenId)
        external
        view
        returns (uint256 score, uint256 transactions, uint256 successRate)
    {
        ReputationData storage data = _reputations[tokenId];
        score = data.reputationScore;
        transactions = data.totalTransactions;

        if (data.totalTransactions > 0) {
            successRate = (data.successfulTransactions * BASIS_POINTS) / data.totalTransactions;
        }
    }

    /// @notice Get staked amount for an agent
    /// @param tokenId Agent token ID
    /// @return Staked amount
    function getStakedAmount(uint256 tokenId) external view returns (uint256) {
        return _reputations[tokenId].stakedAmount;
    }

    /// @notice Get composite trust score
    /// @param tokenId Agent token ID
    /// @return compositeScore Weighted trust score
    function getTrustScore(uint256 tokenId) external view returns (uint256 compositeScore) {
        (,, compositeScore) = _calculateTrustDetails(tokenId);
    }

    /// @notice Get trust score by DID
    /// @param didHash Agent's DID hash
    /// @return Trust score
    function getTrustScoreByDID(bytes32 didHash) external view returns (uint256) {
        uint256 tokenId = agentToken.getTokenByDID(didHash);
        if (tokenId == 0) return 0;

        (,, uint256 compositeScore) = _calculateTrustDetails(tokenId);
        return compositeScore;
    }

    /// @notice Get detailed trust breakdown
    /// @param tokenId Agent token ID
    /// @return reputationScore Reputation component
    /// @return stakeScore Stake component
    /// @return compositeScore Weighted composite
    function getTrustDetails(uint256 tokenId)
        external
        view
        returns (uint256 reputationScore, uint256 stakeScore, uint256 compositeScore)
    {
        return _calculateTrustDetails(tokenId);
    }

    /// @notice Calculate reputation score
    /// @param tokenId Agent token ID
    /// @return score Reputation score
    function calculateReputationScore(uint256 tokenId) public view returns (uint256 score) {
        ReputationData storage data = _reputations[tokenId];

        if (data.totalTransactions == 0) {
            return 0;
        }

        // Success rate component (0-10000)
        uint256 successRate = (data.successfulTransactions * BASIS_POINTS) / data.totalTransactions;

        // Volume factor (logarithmic scaling, caps at $100k)
        uint256 volumeFactor = data.totalVolumeUsd / 100_000_000; // Convert to $100 units
        if (volumeFactor > 1000) {
            volumeFactor = 1000;
        }

        // Transaction count factor
        uint256 txFactor = data.totalTransactions * 10;
        if (txFactor > 1000) {
            txFactor = 1000;
        }

        // Composite: 70% success rate, 15% volume, 15% tx count
        score = (successRate * 7000 + volumeFactor * 10 * 1500 + txFactor * 10 * 1500) / 10000;

        if (score > BASIS_POINTS) {
            score = BASIS_POINTS;
        }
    }

    // ============ Internal Functions ============

    /// @notice Calculate all trust components
    /// @param tokenId Agent token ID
    function _calculateTrustDetails(uint256 tokenId)
        internal
        view
        returns (uint256 reputationScore, uint256 stakeScore, uint256 compositeScore)
    {
        ReputationData storage data = _reputations[tokenId];

        reputationScore = data.reputationScore;

        // Stake score: linear scaling against reference stake
        if (data.stakedAmount >= REFERENCE_STAKE) {
            stakeScore = BASIS_POINTS;
        } else {
            stakeScore = (data.stakedAmount * BASIS_POINTS) / REFERENCE_STAKE;
        }

        // Composite score: weighted average
        compositeScore = (reputationScore * REPUTATION_WEIGHT + stakeScore * STAKE_WEIGHT) / BASIS_POINTS;
    }

    /// @notice Require token exists
    /// @param tokenId Token ID to check
    function _requireTokenExists(uint256 tokenId) internal view {
        try agentToken.ownerOf(tokenId) returns (
            address
        ) {
        // Token exists
        }
        catch {
            revert TokenNotFound();
        }
    }

    /// @notice Require caller is token owner
    /// @param tokenId Token ID to check
    function _requireTokenOwner(uint256 tokenId) internal view {
        try agentToken.ownerOf(tokenId) returns (address owner) {
            if (owner != msg.sender) revert NotTokenOwner();
        } catch {
            revert TokenNotFound();
        }
    }

    // ============ Admin Functions ============

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Set treasury address
    /// @param _treasury New treasury address
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert InvalidTreasuryAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }
}
