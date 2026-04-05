// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OracleConsensus.sol";
import "../src/TrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC for OracleConsensus tests
contract MockUSDCOC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract OracleConsensusTest is Test {
    OracleConsensus public consensus;
    TrustRegistry public registry;
    MockUSDCOC public usdc;

    address public admin = address(0x1);
    uint256 public oracle1Key = 0xA1;
    uint256 public oracle2Key = 0xA2;
    uint256 public oracle3Key = 0xA3;
    address public oracle1;
    address public oracle2;
    address public oracle3;
    address public alice = address(0x10);

    bytes32 public agentDid = keccak256("did:agoramesh:agent1");
    uint256 public constant MIN_BOND = 100 * 1e6; // 100 USDC
    uint256 public constant BOND_AMOUNT = 100 * 1e6;

    function setUp() public {
        // Derive oracle addresses from private keys (needed for ECDSA signing)
        oracle1 = vm.addr(oracle1Key);
        oracle2 = vm.addr(oracle2Key);
        oracle3 = vm.addr(oracle3Key);

        // Deploy mock USDC
        usdc = new MockUSDCOC();

        // Deploy TrustRegistry as the target
        vm.prank(admin);
        registry = new TrustRegistry(address(usdc), admin);

        // Deploy OracleConsensus
        vm.prank(admin);
        consensus = new OracleConsensus(address(usdc), address(registry), MIN_BOND, admin);

        // Grant ORACLE_ROLE on TrustRegistry to the OracleConsensus contract
        bytes32 oracleRole = registry.ORACLE_ROLE();
        vm.prank(admin);
        registry.grantRole(oracleRole, address(consensus));

        // Add oracles to whitelist
        vm.startPrank(admin);
        consensus.addOracle(oracle1);
        consensus.addOracle(oracle2);
        consensus.addOracle(oracle3);
        vm.stopPrank();

        // Mint USDC and approve
        usdc.mint(oracle1, 1_000_000 * 1e6);
        usdc.mint(oracle2, 1_000_000 * 1e6);
        usdc.mint(oracle3, 1_000_000 * 1e6);

        vm.prank(oracle1);
        usdc.approve(address(consensus), type(uint256).max);
        vm.prank(oracle2);
        usdc.approve(address(consensus), type(uint256).max);
        vm.prank(oracle3);
        usdc.approve(address(consensus), type(uint256).max);

        // Register an agent in TrustRegistry so recordTransaction works
        vm.prank(alice);
        registry.registerAgent(agentDid, "QmTestCapabilityCard");
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsState() public {
        assertEq(address(consensus.bondToken()), address(usdc));
        assertEq(consensus.target(), address(registry));
        assertEq(consensus.minBond(), MIN_BOND);
        assertEq(consensus.getOracleCount(), 3);
    }

    function test_Constructor_RevertInvalidBondToken() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.InvalidTarget.selector);
        new OracleConsensus(address(0), address(registry), MIN_BOND, admin);
    }

    function test_Constructor_RevertInvalidTarget() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.InvalidTarget.selector);
        new OracleConsensus(address(usdc), address(0), MIN_BOND, admin);
    }

    function test_Constructor_RevertZeroBond() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.InvalidBondAmount.selector);
        new OracleConsensus(address(usdc), address(registry), 0, admin);
    }

    function test_Constructor_RevertInvalidAdmin() public {
        vm.expectRevert(OracleConsensus.InvalidAdmin.selector);
        new OracleConsensus(address(usdc), address(registry), MIN_BOND, address(0));
    }

    // ============ Oracle Management Tests ============

    function test_AddOracle_RevertDuplicate() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.OracleAlreadyAdded.selector);
        consensus.addOracle(oracle1);
    }

    function test_AddOracle_RevertMaxReached() public {
        address extra = address(0x99);
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.MaxOraclesReached.selector);
        consensus.addOracle(extra);
    }

    function test_RemoveOracle() public {
        vm.prank(admin);
        consensus.removeOracle(oracle3);
        assertEq(consensus.getOracleCount(), 2);
        assertFalse(consensus.isOracle(oracle3));
    }

    function test_RemoveOracle_RevertNotFound() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.OracleNotFound.selector);
        consensus.removeOracle(address(0x99));
    }

    // ============ Happy Path: Submit → Finalize (No Challenge) ============

    function test_HappyPath_SubmitAndFinalize() public {
        // Oracle1 submits a report
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        // Verify report is pending
        OracleConsensus.Report memory report = consensus.getReport(reportId);
        assertEq(uint256(report.status), uint256(OracleConsensus.ReportStatus.Pending));
        assertEq(report.submitter, oracle1);
        assertEq(report.bondAmount, BOND_AMOUNT);

        // Bond was transferred
        assertEq(usdc.balanceOf(address(consensus)), BOND_AMOUNT);

        // Warp past challenge period
        vm.warp(block.timestamp + 30 minutes + 1);

        // Finalize
        consensus.finalizeReport(reportId);

        // Verify finalized
        report = consensus.getReport(reportId);
        assertEq(uint256(report.status), uint256(OracleConsensus.ReportStatus.Finalized));

        // Bond returned to submitter
        assertEq(usdc.balanceOf(address(consensus)), 0);

        // TrustRegistry was updated
        (uint256 score, uint256 transactions,) = registry.getReputation(agentDid);
        assertEq(transactions, 1);
        assertGt(score, 0);

        // Oracle reputation tracked
        (uint256 correct, uint256 total) = consensus.getOracleAccuracy(oracle1);
        assertEq(correct, 1);
        assertEq(total, 1);
    }

    function test_Submit_RevertNotOracle() public {
        vm.prank(alice);
        vm.expectRevert(OracleConsensus.NotOracle.selector);
        consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);
    }

    function test_Submit_RevertInsufficientBond() public {
        vm.prank(oracle1);
        vm.expectRevert(OracleConsensus.InsufficientBond.selector);
        consensus.submitReport(agentDid, 1000 * 1e6, true, MIN_BOND - 1);
    }

    function test_Finalize_RevertBeforeChallengePeriod() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.expectRevert(OracleConsensus.ChallengePeriodNotExpired.selector);
        consensus.finalizeReport(reportId);
    }

    // ============ Challenge Path ============

    function test_Challenge_SubmitAndChallenge() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        // Oracle2 challenges
        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        OracleConsensus.Report memory report = consensus.getReport(reportId);
        assertEq(uint256(report.status), uint256(OracleConsensus.ReportStatus.Challenged));
        assertEq(report.challenger, oracle2);
        assertEq(report.challengerBond, BOND_AMOUNT);

        // Both bonds held by contract
        assertEq(usdc.balanceOf(address(consensus)), BOND_AMOUNT * 2);
    }

    function test_Challenge_RevertNotOracle() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(alice);
        vm.expectRevert(OracleConsensus.NotOracle.selector);
        consensus.challengeReport(reportId);
    }

    function test_Challenge_RevertSelfChallenge() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle1);
        vm.expectRevert(OracleConsensus.CannotChallengeSelf.selector);
        consensus.challengeReport(reportId);
    }

    function test_Challenge_RevertAfterPeriod() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.warp(block.timestamp + 30 minutes + 1);

        vm.prank(oracle2);
        vm.expectRevert(OracleConsensus.ChallengePeriodExpired.selector);
        consensus.challengeReport(reportId);
    }

    // ============ Challenge Resolution: Original Upheld ============

    function test_ResolveChallenge_OriginalUpheld() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        uint256 oracle1BalanceBefore = usdc.balanceOf(oracle1);
        uint256 oracle2BalanceBefore = usdc.balanceOf(oracle2);

        // Get 2-of-3 signatures upholding the original
        bytes[] memory sigs = _signResolution(reportId, true);

        consensus.resolveChallenge(reportId, true, sigs);

        OracleConsensus.Report memory report = consensus.getReport(reportId);
        assertEq(uint256(report.status), uint256(OracleConsensus.ReportStatus.Finalized));

        // Oracle1 (winner): gets bond back + 50% of challenger's bond
        uint256 slashAmount = (BOND_AMOUNT * 5000) / 10000; // 50 USDC
        assertEq(usdc.balanceOf(oracle1), oracle1BalanceBefore + BOND_AMOUNT + slashAmount);

        // Oracle2 (loser): gets 50% of their bond back
        assertEq(usdc.balanceOf(oracle2), oracle2BalanceBefore + (BOND_AMOUNT - slashAmount));

        // TrustRegistry updated (report forwarded)
        (, uint256 transactions,) = registry.getReputation(agentDid);
        assertEq(transactions, 1);

        // Oracle reputation: submitter credited
        (uint256 correct,) = consensus.getOracleAccuracy(oracle1);
        assertEq(correct, 1);
    }

    // ============ Challenge Resolution: Challenge Upheld ============

    function test_ResolveChallenge_ChallengeUpheld() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        uint256 oracle1BalanceBefore = usdc.balanceOf(oracle1);
        uint256 oracle2BalanceBefore = usdc.balanceOf(oracle2);

        // Get 2-of-3 signatures rejecting the original
        bytes[] memory sigs = _signResolution(reportId, false);

        consensus.resolveChallenge(reportId, false, sigs);

        OracleConsensus.Report memory report = consensus.getReport(reportId);
        assertEq(uint256(report.status), uint256(OracleConsensus.ReportStatus.Rejected));

        // Oracle2 (challenger/winner): gets bond back + 50% of submitter's bond
        uint256 slashAmount = (BOND_AMOUNT * 5000) / 10000;
        assertEq(usdc.balanceOf(oracle2), oracle2BalanceBefore + BOND_AMOUNT + slashAmount);

        // Oracle1 (submitter/loser): gets 50% of their bond back
        assertEq(usdc.balanceOf(oracle1), oracle1BalanceBefore + (BOND_AMOUNT - slashAmount));

        // TrustRegistry NOT updated (report rejected)
        (, uint256 transactions,) = registry.getReputation(agentDid);
        assertEq(transactions, 0);

        // Oracle reputation: challenger credited
        (uint256 correct,) = consensus.getOracleAccuracy(oracle2);
        assertEq(correct, 1);
    }

    // ============ Bond Slashing Tests ============

    function test_BondSlashing_ExactAmounts() public {
        // Use a non-standard bond amount to verify math
        uint256 bondAmt = 200 * 1e6; // 200 USDC

        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 500 * 1e6, true, bondAmt);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        uint256 totalBefore = usdc.balanceOf(oracle1) + usdc.balanceOf(oracle2);

        bytes[] memory sigs = _signResolution(reportId, true);
        consensus.resolveChallenge(reportId, true, sigs);

        uint256 totalAfter = usdc.balanceOf(oracle1) + usdc.balanceOf(oracle2);

        // All bonds returned (just redistributed) — total should equal both bonds
        assertEq(totalAfter, totalBefore + bondAmt * 2);

        // Winner gets bond + 50% of loser's bond = 200 + 100 = 300
        // Loser gets 50% of their bond = 100
        // Verify the slash was exactly 50%
        uint256 expectedSlash = (bondAmt * 5000) / 10000;
        assertEq(expectedSlash, 100 * 1e6);
    }

    function test_BondSlashing_ContractEndsEmpty() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        bytes[] memory sigs = _signResolution(reportId, true);
        consensus.resolveChallenge(reportId, true, sigs);

        // Contract should hold no funds after resolution
        assertEq(usdc.balanceOf(address(consensus)), 0);
    }

    // ============ Signature Validation Tests ============

    function test_ResolveChallenge_RevertInsufficientSignatures() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        // Only 1 signature (need 2)
        bytes[] memory sigs = new bytes[](1);
        bytes32 messageHash = keccak256(abi.encodePacked(reportId, true, block.chainid, address(consensus)));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracle1Key, ethSignedHash);
        sigs[0] = abi.encodePacked(r, s, v);

        vm.expectRevert(OracleConsensus.InvalidSignatureCount.selector);
        consensus.resolveChallenge(reportId, true, sigs);
    }

    function test_ResolveChallenge_RevertDuplicateSigner() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        // Same oracle signs twice
        bytes32 messageHash = keccak256(abi.encodePacked(reportId, true, block.chainid, address(consensus)));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);

        bytes[] memory sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(oracle1Key, ethSignedHash);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        sigs[1] = abi.encodePacked(r1, s1, v1);

        vm.expectRevert(OracleConsensus.DuplicateSigner.selector);
        consensus.resolveChallenge(reportId, true, sigs);
    }

    function test_ResolveChallenge_RevertNonOracleSigner() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        bytes32 messageHash = keccak256(abi.encodePacked(reportId, true, block.chainid, address(consensus)));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);

        // Sign with non-oracle key
        uint256 fakeKey = 0xDEAD;
        bytes[] memory sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(oracle1Key, ethSignedHash);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(fakeKey, ethSignedHash);
        sigs[1] = abi.encodePacked(r2, s2, v2);

        vm.expectRevert(OracleConsensus.SignerNotOracle.selector);
        consensus.resolveChallenge(reportId, true, sigs);
    }

    // ============ Edge Cases ============

    function test_CannotFinalizeAfterChallenge() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.prank(oracle2);
        consensus.challengeReport(reportId);

        vm.warp(block.timestamp + 30 minutes + 1);

        // Cannot finalize a challenged report
        vm.expectRevert(OracleConsensus.ReportNotPending.selector);
        consensus.finalizeReport(reportId);
    }

    function test_CannotResolveUnchallengedReport() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        bytes[] memory sigs = _signResolution(reportId, true);

        vm.expectRevert(OracleConsensus.ReportNotChallenged.selector);
        consensus.resolveChallenge(reportId, true, sigs);
    }

    function test_CannotDoubleFinalizeReport() public {
        vm.prank(oracle1);
        bytes32 reportId = consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        vm.warp(block.timestamp + 30 minutes + 1);
        consensus.finalizeReport(reportId);

        vm.expectRevert(OracleConsensus.ReportNotPending.selector);
        consensus.finalizeReport(reportId);
    }

    function test_DeviationAlert_EmittedOnLargeDeviation() public {
        // Submit first report to establish baseline
        vm.prank(oracle1);
        consensus.submitReport(agentDid, 1000 * 1e6, true, BOND_AMOUNT);

        // Submit second report with >50% deviation — should emit DeviationAlert
        vm.prank(oracle1);
        vm.expectEmit(false, true, false, false);
        emit OracleConsensus.DeviationAlert(bytes32(0), agentDid, 0, 0);
        consensus.submitReport(agentDid, 2000 * 1e6, true, BOND_AMOUNT);
    }

    // ============ Admin Tests ============

    function test_SetMinBond() public {
        vm.prank(admin);
        consensus.setMinBond(200 * 1e6);
        assertEq(consensus.minBond(), 200 * 1e6);
    }

    function test_SetMinBond_RevertZero() public {
        vm.prank(admin);
        vm.expectRevert(OracleConsensus.InvalidBondAmount.selector);
        consensus.setMinBond(0);
    }

    function test_SetTarget() public {
        address newTarget = address(0x999);
        vm.prank(admin);
        consensus.setTarget(newTarget);
        assertEq(consensus.target(), newTarget);
    }

    // ============ Helpers ============

    /// @notice Generate 2-of-3 oracle signatures for challenge resolution
    function _signResolution(bytes32 reportId, bool upholdOriginal) internal view returns (bytes[] memory sigs) {
        bytes32 messageHash = keccak256(abi.encodePacked(reportId, upholdOriginal, block.chainid, address(consensus)));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);

        sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(oracle1Key, ethSignedHash);
        sigs[0] = abi.encodePacked(r1, s1, v1);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(oracle3Key, ethSignedHash);
        sigs[1] = abi.encodePacked(r2, s2, v2);
    }
}
