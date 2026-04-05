// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title OracleConsensus - Hybrid Optimistic Multi-Oracle Consensus
/// @notice Replaces single-oracle trust report submission with optimistic + M-of-N pattern
/// @dev Layer 1: Optimistic submission with bonded stake and challenge window.
///      Layer 2: On challenge, 2-of-3 oracle ECDSA signatures resolve the dispute.
///      Layer 3: Oracle accuracy tracking and deviation circuit breaker (stub).
contract OracleConsensus is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Constants ============

    /// @notice Challenge window duration
    uint256 public constant CHALLENGE_PERIOD = 30 minutes;

    /// @notice Percentage of bond slashed from loser (50%)
    uint256 public constant BOND_SLASH_BPS = 5000;

    /// @notice Required oracle signatures for M-of-N resolution
    uint256 public constant REQUIRED_SIGNATURES = 2;

    /// @notice Maximum whitelisted oracles
    uint256 public constant MAX_ORACLES = 3;

    /// @notice Basis points denominator
    uint256 private constant BASIS_POINTS = 10000;

    /// @notice Deviation threshold for circuit breaker (50%)
    uint256 public constant DEVIATION_THRESHOLD_BPS = 5000;

    // ============ Enums ============

    enum ReportStatus {
        None,
        Pending,
        Challenged,
        Finalized,
        Rejected
    }

    // ============ Structs ============

    struct Report {
        bytes32 agentDid;
        uint256 volumeUsd;
        bool successful;
        address submitter;
        uint256 bondAmount;
        uint256 submittedAt;
        ReportStatus status;
        address challenger;
        uint256 challengerBond;
    }

    // ============ State Variables ============

    /// @notice Bond token (USDC)
    IERC20 public immutable bondToken;

    /// @notice Target contract that receives finalized reports
    address public target;

    /// @notice Minimum bond required for submission
    uint256 public minBond;

    /// @notice Oracle whitelist
    mapping(address => bool) public isOracle;
    address[] public oracleList;

    /// @notice Reports indexed by ID
    mapping(bytes32 => Report) private _reports;

    /// @notice Monotonic nonce for report ID generation
    uint256 public reportNonce;

    // Layer 3 stubs: oracle reputation tracking
    mapping(address => uint256) public oracleCorrectReports;
    mapping(address => uint256) public oracleTotalReports;

    // Deviation circuit breaker state
    mapping(bytes32 => uint256) public agentTrailingVolume;
    mapping(bytes32 => uint256) public agentReportCount;

    // ============ Events ============

    event ReportSubmitted(
        bytes32 indexed reportId, bytes32 indexed agentDid, address indexed submitter, uint256 bondAmount
    );
    event ReportChallenged(bytes32 indexed reportId, address indexed challenger);
    event ReportFinalized(bytes32 indexed reportId);
    event ReportRejected(bytes32 indexed reportId);
    event ChallengeResolved(bytes32 indexed reportId, bool upheld, uint256 slashedAmount);
    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event DeviationAlert(bytes32 indexed reportId, bytes32 indexed agentDid, uint256 volume, uint256 trailingAvg);

    // ============ Errors ============

    error NotOracle();
    error ReportNotPending();
    error ReportNotChallenged();
    error ChallengePeriodNotExpired();
    error ChallengePeriodExpired();
    error CannotChallengeSelf();
    error InsufficientBond();
    error InvalidSignatureCount();
    error DuplicateSigner();
    error SignerNotOracle();
    error OracleAlreadyAdded();
    error OracleNotFound();
    error MaxOraclesReached();
    error InvalidTarget();
    error InvalidBondAmount();
    error InvalidAdmin();
    error ForwardFailed();

    // ============ Constructor ============

    /// @notice Deploy the OracleConsensus contract
    /// @param _bondToken Token used for oracle bonds (USDC)
    /// @param _target Target contract for finalized reports (TrustRegistry)
    /// @param _minBond Minimum bond amount for report submission
    /// @param _admin Admin address
    constructor(address _bondToken, address _target, uint256 _minBond, address _admin) {
        if (_bondToken == address(0)) revert InvalidTarget();
        if (_target == address(0)) revert InvalidTarget();
        if (_minBond == 0) revert InvalidBondAmount();
        if (_admin == address(0)) revert InvalidAdmin();

        bondToken = IERC20(_bondToken);
        target = _target;
        minBond = _minBond;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ============ Oracle Management ============

    /// @notice Add an oracle to the whitelist
    /// @param oracle Address to whitelist
    function addOracle(address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isOracle[oracle]) revert OracleAlreadyAdded();
        if (oracleList.length >= MAX_ORACLES) revert MaxOraclesReached();

        isOracle[oracle] = true;
        oracleList.push(oracle);

        emit OracleAdded(oracle);
    }

    /// @notice Remove an oracle from the whitelist
    /// @param oracle Address to remove
    function removeOracle(address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isOracle[oracle]) revert OracleNotFound();

        isOracle[oracle] = false;

        for (uint256 i = 0; i < oracleList.length; i++) {
            if (oracleList[i] == oracle) {
                oracleList[i] = oracleList[oracleList.length - 1];
                oracleList.pop();
                break;
            }
        }

        emit OracleRemoved(oracle);
    }

    /// @notice Get the number of whitelisted oracles
    function getOracleCount() external view returns (uint256) {
        return oracleList.length;
    }

    // ============ Layer 1: Optimistic Submission ============

    /// @notice Submit a report with a bonded stake
    /// @param agentDid Agent's DID hash
    /// @param volumeUsd Transaction volume in USD (6 decimals)
    /// @param successful Whether the transaction was successful
    /// @param bondAmount Bond amount (must be >= minBond)
    /// @return reportId Unique report identifier
    function submitReport(bytes32 agentDid, uint256 volumeUsd, bool successful, uint256 bondAmount)
        external
        nonReentrant
        returns (bytes32 reportId)
    {
        if (!isOracle[msg.sender]) revert NotOracle();
        if (bondAmount < minBond) revert InsufficientBond();

        reportNonce++;
        reportId = keccak256(abi.encodePacked(block.chainid, address(this), reportNonce));

        _reports[reportId] = Report({
            agentDid: agentDid,
            volumeUsd: volumeUsd,
            successful: successful,
            submitter: msg.sender,
            bondAmount: bondAmount,
            submittedAt: block.timestamp,
            status: ReportStatus.Pending,
            challenger: address(0),
            challengerBond: 0
        });

        bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);

        // Layer 3 stub: deviation circuit breaker
        _checkDeviation(reportId, agentDid, volumeUsd);

        // Layer 3 stub: track oracle activity
        oracleTotalReports[msg.sender]++;

        emit ReportSubmitted(reportId, agentDid, msg.sender, bondAmount);
    }

    /// @notice Challenge a pending report within the challenge window
    /// @param reportId Report to challenge
    function challengeReport(bytes32 reportId) external nonReentrant {
        if (!isOracle[msg.sender]) revert NotOracle();

        Report storage report = _reports[reportId];
        if (report.status != ReportStatus.Pending) revert ReportNotPending();
        if (report.submitter == msg.sender) revert CannotChallengeSelf();
        if (block.timestamp > report.submittedAt + CHALLENGE_PERIOD) revert ChallengePeriodExpired();

        uint256 challengerBondAmount = report.bondAmount;

        report.status = ReportStatus.Challenged;
        report.challenger = msg.sender;
        report.challengerBond = challengerBondAmount;

        bondToken.safeTransferFrom(msg.sender, address(this), challengerBondAmount);

        emit ReportChallenged(reportId, msg.sender);
    }

    // ============ Layer 2: M-of-N Resolution ============

    /// @notice Resolve a challenged report with 2-of-3 oracle signatures
    /// @param reportId Report to resolve
    /// @param upholdOriginal True if the original report is correct, false if the challenge wins
    /// @param signatures Array of ECDSA signatures from whitelisted oracles
    function resolveChallenge(bytes32 reportId, bool upholdOriginal, bytes[] calldata signatures)
        external
        nonReentrant
    {
        Report storage report = _reports[reportId];
        if (report.status != ReportStatus.Challenged) revert ReportNotChallenged();
        if (signatures.length < REQUIRED_SIGNATURES) revert InvalidSignatureCount();

        // Build the message hash that oracles signed
        bytes32 messageHash = keccak256(abi.encodePacked(reportId, upholdOriginal, block.chainid, address(this)));
        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();

        // Verify M-of-N unique oracle signatures
        address[] memory signers = new address[](signatures.length);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethSignedHash.recover(signatures[i]);
            if (!isOracle[signer]) revert SignerNotOracle();

            for (uint256 j = 0; j < i; j++) {
                if (signers[j] == signer) revert DuplicateSigner();
            }
            signers[i] = signer;
        }

        uint256 slashAmount = (report.bondAmount * BOND_SLASH_BPS) / BASIS_POINTS;

        if (upholdOriginal) {
            report.status = ReportStatus.Finalized;

            // Submitter wins: gets own bond back + 50% of challenger's bond
            bondToken.safeTransfer(report.submitter, report.bondAmount + slashAmount);
            uint256 challengerReturn = report.challengerBond - slashAmount;
            if (challengerReturn > 0) {
                bondToken.safeTransfer(report.challenger, challengerReturn);
            }

            // Forward finalized report to target
            _forwardReport(report);

            oracleCorrectReports[report.submitter]++;
        } else {
            report.status = ReportStatus.Rejected;

            // Challenger wins: gets own bond back + 50% of submitter's bond
            bondToken.safeTransfer(report.challenger, report.challengerBond + slashAmount);
            uint256 submitterReturn = report.bondAmount - slashAmount;
            if (submitterReturn > 0) {
                bondToken.safeTransfer(report.submitter, submitterReturn);
            }

            oracleCorrectReports[report.challenger]++;
        }

        emit ChallengeResolved(reportId, upholdOriginal, slashAmount);
    }

    // ============ Finalization (Unchallenged) ============

    /// @notice Finalize a report after the challenge period expires without challenge
    /// @param reportId Report to finalize
    function finalizeReport(bytes32 reportId) external nonReentrant {
        Report storage report = _reports[reportId];
        if (report.status != ReportStatus.Pending) revert ReportNotPending();
        if (block.timestamp < report.submittedAt + CHALLENGE_PERIOD) revert ChallengePeriodNotExpired();

        report.status = ReportStatus.Finalized;

        // Return bond to submitter (no slash on unchallenged reports)
        bondToken.safeTransfer(report.submitter, report.bondAmount);

        // Forward to target
        _forwardReport(report);

        oracleCorrectReports[report.submitter]++;

        emit ReportFinalized(reportId);
    }

    // ============ View Functions ============

    /// @notice Get a report by ID
    /// @param reportId Report identifier
    /// @return The report struct
    function getReport(bytes32 reportId) external view returns (Report memory) {
        return _reports[reportId];
    }

    /// @notice Get oracle accuracy stats
    /// @param oracle Oracle address
    /// @return correct Number of correct reports
    /// @return total Total reports submitted
    function getOracleAccuracy(address oracle) external view returns (uint256 correct, uint256 total) {
        return (oracleCorrectReports[oracle], oracleTotalReports[oracle]);
    }

    // ============ Admin Functions ============

    /// @notice Update the minimum bond amount
    /// @param _minBond New minimum bond
    function setMinBond(uint256 _minBond) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_minBond == 0) revert InvalidBondAmount();
        minBond = _minBond;
    }

    /// @notice Update the target contract
    /// @param _target New target address
    function setTarget(address _target) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_target == address(0)) revert InvalidTarget();
        target = _target;
    }

    // ============ Internal Functions ============

    /// @notice Forward a finalized report to the target contract
    /// @dev Calls recordTransaction(bytes32,uint256,bool) on the target
    function _forwardReport(Report storage report) internal {
        (bool success,) = target.call(
            abi.encodeWithSignature(
                "recordTransaction(bytes32,uint256,bool)", report.agentDid, report.volumeUsd, report.successful
            )
        );
        if (!success) revert ForwardFailed();
    }

    /// @notice Layer 3 stub: Check volume deviation against trailing average
    /// @dev Emits DeviationAlert if volume deviates >50% from trailing average
    function _checkDeviation(bytes32 reportId, bytes32 agentDid, uint256 volumeUsd) internal {
        uint256 count = agentReportCount[agentDid];
        if (count > 0) {
            uint256 avg = agentTrailingVolume[agentDid] / count;
            if (avg > 0) {
                uint256 deviation;
                if (volumeUsd > avg) {
                    deviation = ((volumeUsd - avg) * BASIS_POINTS) / avg;
                } else {
                    deviation = ((avg - volumeUsd) * BASIS_POINTS) / avg;
                }
                if (deviation > DEVIATION_THRESHOLD_BPS) {
                    emit DeviationAlert(reportId, agentDid, volumeUsd, avg);
                }
            }
        }
        agentTrailingVolume[agentDid] += volumeUsd;
        agentReportCount[agentDid]++;
    }
}
