// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TrustRegistry.sol";
import "../src/interfaces/ITrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC token for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TrustRegistryTest is Test {
    TrustRegistry public registry;
    MockUSDC public usdc;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public arbiter = address(0x3);
    address public alice = address(0x4);
    address public bob = address(0x5);
    address public charlie = address(0x6);

    bytes32 public aliceDid = keccak256("did:agoramesh:alice");
    bytes32 public bobDid = keccak256("did:agoramesh:bob");
    bytes32 public charlieDid = keccak256("did:agoramesh:charlie");

    string public aliceCID = "QmAliceCapabilityCard123";
    string public bobCID = "QmBobCapabilityCard456";
    string public charlieCID = "QmCharlieCapabilityCard789";

    uint256 public constant STAKE_COOLDOWN = 7 days;
    uint256 public constant REFERENCE_STAKE = 10_000 * 1e6; // 10,000 USDC
    uint256 public constant MINIMUM_STAKE = 100 * 1e6; // 100 USDC

    function setUp() public {
        // Deploy mock USDC
        usdc = new MockUSDC();

        // Deploy registry
        vm.prank(admin);
        registry = new TrustRegistry(address(usdc), admin);

        // Grant roles
        vm.startPrank(admin);
        registry.grantRole(registry.ORACLE_ROLE(), oracle);
        registry.grantRole(registry.ARBITER_ROLE(), arbiter);
        vm.stopPrank();

        // Mint USDC to test users
        usdc.mint(alice, 100_000 * 1e6);
        usdc.mint(bob, 100_000 * 1e6);
        usdc.mint(charlie, 100_000 * 1e6);

        // Approve registry to spend USDC
        vm.prank(alice);
        usdc.approve(address(registry), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(registry), type(uint256).max);
        vm.prank(charlie);
        usdc.approve(address(registry), type(uint256).max);
    }

    // ============ Constructor Tests ============

    function test_Constructor_RevertIfZeroStakingToken() public {
        vm.expectRevert(TrustRegistry.InvalidStakingToken.selector);
        new TrustRegistry(address(0), admin);
    }

    function test_Constructor_RevertIfZeroAdmin() public {
        vm.expectRevert(TrustRegistry.InvalidAdmin.selector);
        new TrustRegistry(address(usdc), address(0));
    }

    // ============ Registration Tests ============

    function test_RegisterAgent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ITrustRegistry.AgentRegistered(aliceDid, alice, aliceCID);
        registry.registerAgent(aliceDid, aliceCID);

        ITrustRegistry.AgentInfo memory info = registry.getAgent(aliceDid);
        assertEq(info.didHash, aliceDid);
        assertEq(info.owner, alice);
        assertEq(info.capabilityCardCID, aliceCID);
        assertEq(info.registeredAt, block.timestamp);
        assertTrue(info.isActive);
    }

    function test_RegisterAgent_RevertIfAlreadyRegistered() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(bob);
        vm.expectRevert(TrustRegistry.AgentAlreadyRegistered.selector);
        registry.registerAgent(aliceDid, bobCID);
    }

    function test_RegisterAgent_RevertIfEmptyCID() public {
        vm.prank(alice);
        vm.expectRevert(TrustRegistry.InvalidCapabilityCardCID.selector);
        registry.registerAgent(aliceDid, "");
    }

    function test_RegisterAgent_RevertIfOwnerAlreadyHasAgent() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        bytes32 anotherDid = keccak256("did:agoramesh:alice2");
        vm.expectRevert(TrustRegistry.OwnerAlreadyHasAgent.selector);
        registry.registerAgent(anotherDid, "QmAnotherCID");
        vm.stopPrank();
    }

    function test_UpdateCapabilityCard() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        string memory newCID = "QmNewCapabilityCard999";
        vm.expectEmit(true, false, false, true);
        emit ITrustRegistry.AgentUpdated(aliceDid, newCID);
        registry.updateCapabilityCard(aliceDid, newCID);
        vm.stopPrank();

        ITrustRegistry.AgentInfo memory info = registry.getAgent(aliceDid);
        assertEq(info.capabilityCardCID, newCID);
    }

    function test_UpdateCapabilityCard_RevertIfNotOwner() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(bob);
        vm.expectRevert(TrustRegistry.NotAgentOwner.selector);
        registry.updateCapabilityCard(aliceDid, "QmNewCID");
    }

    function test_UpdateCapabilityCard_RevertIfNotActive() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.deactivateAgent(aliceDid);

        vm.expectRevert(TrustRegistry.AgentNotActive.selector);
        registry.updateCapabilityCard(aliceDid, "QmNewCID");
        vm.stopPrank();
    }

    function test_DeactivateAgent() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.expectEmit(true, false, false, false);
        emit ITrustRegistry.AgentDeactivated(aliceDid);
        registry.deactivateAgent(aliceDid);
        vm.stopPrank();

        assertFalse(registry.isAgentActive(aliceDid));
    }

    function test_DeactivateAgent_RevertIfNotOwner() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(bob);
        vm.expectRevert(TrustRegistry.NotAgentOwner.selector);
        registry.deactivateAgent(aliceDid);
    }

    // ============ Staking Tests ============

    function test_DepositStake() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 1e6; // Above minimum stake
        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ITrustRegistry.StakeDeposited(aliceDid, stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, stakeAmount);
        assertEq(usdc.balanceOf(alice), balanceBefore - stakeAmount);
        assertEq(usdc.balanceOf(address(registry)), stakeAmount);
    }

    function test_DepositStake_RevertIfBelowMinimum() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        vm.expectRevert(TrustRegistry.StakeBelowMinimum.selector);
        registry.depositStake(aliceDid, 50 * 1e6); // Below $100 minimum
    }

    function test_DepositStake_RevertIfNotOwner() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(bob);
        vm.expectRevert(TrustRegistry.NotAgentOwner.selector);
        registry.depositStake(aliceDid, MINIMUM_STAKE);
    }

    function test_DepositStake_RevertIfNotActive() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.deactivateAgent(aliceDid);

        vm.expectRevert(TrustRegistry.AgentNotActive.selector);
        registry.depositStake(aliceDid, MINIMUM_STAKE);
        vm.stopPrank();
    }

    function test_DepositStake_RevertIfZeroAmount() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        vm.expectRevert(TrustRegistry.InvalidStakeAmount.selector);
        registry.depositStake(aliceDid, 0);
    }

    function test_RequestWithdraw() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);

        uint256 withdrawAmount = 500 * 1e6;
        uint256 expectedUnlockTime = block.timestamp + STAKE_COOLDOWN;

        vm.expectEmit(true, false, false, true);
        emit ITrustRegistry.StakeWithdrawRequested(aliceDid, withdrawAmount, expectedUnlockTime);
        uint256 unlockTime = registry.requestWithdraw(aliceDid, withdrawAmount);
        vm.stopPrank();

        assertEq(unlockTime, expectedUnlockTime);
        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakeUnlockTime, expectedUnlockTime);
    }

    function test_RequestWithdraw_RevertIfExceedsStake() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);

        vm.expectRevert(TrustRegistry.InsufficientStake.selector);
        registry.requestWithdraw(aliceDid, 2000 * 1e6);
        vm.stopPrank();
    }

    function test_RequestWithdraw_RevertIfWithdrawalAlreadyPending() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);
        registry.requestWithdraw(aliceDid, 500 * 1e6);

        vm.expectRevert(TrustRegistry.WithdrawalAlreadyPending.selector);
        registry.requestWithdraw(aliceDid, 200 * 1e6);
        vm.stopPrank();
    }

    function test_ExecuteWithdraw() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);

        uint256 withdrawAmount = 500 * 1e6;
        registry.requestWithdraw(aliceDid, withdrawAmount);

        // Warp past cooldown
        vm.warp(block.timestamp + STAKE_COOLDOWN + 1);

        uint256 balanceBefore = usdc.balanceOf(alice);
        vm.expectEmit(true, false, false, true);
        emit ITrustRegistry.StakeWithdrawn(aliceDid, withdrawAmount);
        uint256 withdrawn = registry.executeWithdraw(aliceDid);
        vm.stopPrank();

        assertEq(withdrawn, withdrawAmount);
        assertEq(usdc.balanceOf(alice), balanceBefore + withdrawAmount);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, 500 * 1e6);
        assertEq(data.stakeUnlockTime, 0);
    }

    function test_ExecuteWithdraw_RevertIfCooldownNotPassed() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);
        registry.requestWithdraw(aliceDid, 500 * 1e6);

        vm.expectRevert(TrustRegistry.CooldownNotPassed.selector);
        registry.executeWithdraw(aliceDid);
        vm.stopPrank();
    }

    function test_ExecuteWithdraw_RevertIfNoWithdrawPending() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);

        vm.expectRevert(TrustRegistry.NoWithdrawPending.selector);
        registry.executeWithdraw(aliceDid);
        vm.stopPrank();
    }

    // ============ Slashing Tests ============

    function test_Slash() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        registry.depositStake(aliceDid, 1000 * 1e6);

        uint256 slashAmount = 200 * 1e6;
        bytes32 disputeId = keccak256("dispute-001");

        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit ITrustRegistry.StakeSlashed(aliceDid, slashAmount, disputeId);
        registry.slash(aliceDid, slashAmount, disputeId);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, 800 * 1e6);
    }

    function test_Slash_RevertIfNotArbiter() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        registry.depositStake(aliceDid, 1000 * 1e6);

        vm.prank(alice);
        vm.expectRevert();
        registry.slash(aliceDid, 200 * 1e6, keccak256("dispute-001"));
    }

    function test_Slash_RevertIfExceedsStake() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        registry.depositStake(aliceDid, 1000 * 1e6);

        vm.prank(arbiter);
        vm.expectRevert(TrustRegistry.InsufficientStake.selector);
        registry.slash(aliceDid, 2000 * 1e6, keccak256("dispute-001"));
    }

    function test_Slash_CancelsWithdrawRequest() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, 1000 * 1e6);
        registry.requestWithdraw(aliceDid, 500 * 1e6);
        vm.stopPrank();

        vm.prank(arbiter);
        registry.slash(aliceDid, 200 * 1e6, keccak256("dispute-001"));

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakeUnlockTime, 0); // Withdraw request cancelled
    }

    // ============ Reputation Tests ============

    function test_RecordTransaction_Success() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(oracle);
        vm.expectEmit(true, false, false, false);
        emit ITrustRegistry.ReputationUpdated(aliceDid, 0, 1);
        registry.recordTransaction(aliceDid, 100_00, true); // $100

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.totalTransactions, 1);
        assertEq(data.successfulTransactions, 1);
        assertEq(data.totalVolumeUsd, 100_00);
    }

    function test_RecordTransaction_Failure() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(oracle);
        registry.recordTransaction(aliceDid, 100_00, false);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.totalTransactions, 1);
        assertEq(data.successfulTransactions, 0);
    }

    function test_RecordTransaction_RevertIfNotOracle() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        vm.expectRevert();
        registry.recordTransaction(aliceDid, 100_00, true);
    }

    function test_GetReputation() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        // Record multiple transactions
        vm.startPrank(oracle);
        for (uint256 i = 0; i < 8; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        for (uint256 i = 0; i < 2; i++) {
            registry.recordTransaction(aliceDid, 100_00, false);
        }
        vm.stopPrank();

        (uint256 score, uint256 transactions, uint256 successRate) = registry.getReputation(aliceDid);

        assertEq(transactions, 10);
        assertEq(successRate, 8000); // 80% success rate in basis points
        assertTrue(score > 0);
    }

    // ============ Endorsement Tests ============

    function test_Endorse() public {
        // Register both agents
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        string memory message = "Great agent!";

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ITrustRegistry.EndorsementAdded(aliceDid, bobDid, message);
        registry.endorse(bobDid, message);

        ITrustRegistry.Endorsement[] memory endorsements = registry.getEndorsements(bobDid);
        assertEq(endorsements.length, 1);
        assertEq(endorsements[0].endorserDid, aliceDid);
        assertEq(endorsements[0].endorseeDid, bobDid);
        assertEq(endorsements[0].message, message);
        assertTrue(endorsements[0].isActive);
    }

    function test_Endorse_RevertIfNotRegistered() public {
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        vm.prank(alice);
        vm.expectRevert(TrustRegistry.AgentNotRegistered.selector);
        registry.endorse(bobDid, "Great!");
    }

    function test_Endorse_RevertIfSelfEndorsement() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        vm.expectRevert(TrustRegistry.CannotEndorseSelf.selector);
        registry.endorse(aliceDid, "I'm great!");
    }

    function test_Endorse_RevertIfAlreadyEndorsed() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        vm.startPrank(alice);
        registry.endorse(bobDid, "Great!");
        vm.expectRevert(TrustRegistry.AlreadyEndorsed.selector);
        registry.endorse(bobDid, "Great again!");
        vm.stopPrank();
    }

    function test_RevokeEndorsement() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        vm.startPrank(alice);
        registry.endorse(bobDid, "Great!");

        vm.expectEmit(true, true, false, false);
        emit ITrustRegistry.EndorsementRevoked(aliceDid, bobDid);
        registry.revokeEndorsement(bobDid);
        vm.stopPrank();

        ITrustRegistry.Endorsement[] memory endorsements = registry.getEndorsements(bobDid);
        assertEq(endorsements.length, 0);
    }

    function test_RevokeEndorsement_RevertIfNotEndorsed() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        vm.prank(alice);
        vm.expectRevert(TrustRegistry.EndorsementNotFound.selector);
        registry.revokeEndorsement(bobDid);
    }

    function test_MaxEndorsements() public {
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        // Create 10 endorsers
        for (uint256 i = 0; i < 10; i++) {
            address endorser = address(uint160(100 + i));
            bytes32 endorserDid = keccak256(abi.encodePacked("did:agoramesh:", i));

            vm.prank(endorser);
            registry.registerAgent(endorserDid, "QmCID");

            vm.prank(endorser);
            registry.endorse(bobDid, "Endorsed");
        }

        // 11th endorsement should revert
        address extraEndorser = address(uint160(200));
        bytes32 extraDid = keccak256("did:agoramesh:extra");
        vm.prank(extraEndorser);
        registry.registerAgent(extraDid, "QmCID");

        vm.prank(extraEndorser);
        vm.expectRevert(TrustRegistry.MaxEndorsementsReached.selector);
        registry.endorse(bobDid, "Too many");
    }

    // ============ Trust Score Tests ============

    function test_GetTrustScore_NewAgent() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 score = registry.getTrustScore(aliceDid);
        assertEq(score, 0); // New agent with no activity
    }

    function test_GetTrustScore_WithStakeOnly() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, REFERENCE_STAKE); // Full reference stake
        vm.stopPrank();

        (uint256 repScore, uint256 stakeScore, uint256 endorseScore, uint256 composite) =
            registry.getTrustDetails(aliceDid);

        assertEq(repScore, 0);
        assertEq(stakeScore, 10000); // Max stake score
        assertEq(endorseScore, 0);
        assertEq(composite, 3000); // 30% weight for stake
    }

    function test_GetTrustScore_WithReputationOnly() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        // Record 100% success rate
        vm.startPrank(oracle);
        for (uint256 i = 0; i < 100; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        vm.stopPrank();

        (uint256 repScore, uint256 stakeScore, uint256 endorseScore, uint256 composite) =
            registry.getTrustDetails(aliceDid);

        assertTrue(repScore > 0);
        assertEq(stakeScore, 0);
        assertEq(endorseScore, 0);
        assertTrue(composite > 0);
    }

    function test_GetTrustScore_WithEndorsementsOnly() public {
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        // Create endorsers with reputation
        for (uint256 i = 0; i < 5; i++) {
            address endorser = address(uint160(100 + i));
            bytes32 endorserDid = keccak256(abi.encodePacked("did:agoramesh:", i));

            vm.prank(endorser);
            registry.registerAgent(endorserDid, "QmCID");

            // Give endorser some reputation
            vm.prank(oracle);
            registry.recordTransaction(endorserDid, 1000_00, true);

            vm.prank(endorser);
            registry.endorse(bobDid, "Endorsed");
        }

        (uint256 repScore, uint256 stakeScore, uint256 endorseScore, uint256 composite) =
            registry.getTrustDetails(bobDid);

        assertEq(repScore, 0);
        assertEq(stakeScore, 0);
        assertTrue(endorseScore > 0);
        assertTrue(composite > 0);
    }

    function test_GetTrustScore_Composite() public {
        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        registry.depositStake(aliceDid, REFERENCE_STAKE / 2); // 50% of reference stake
        vm.stopPrank();

        // Record transactions
        vm.startPrank(oracle);
        for (uint256 i = 0; i < 50; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        vm.stopPrank();

        // Add endorsements
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);
        vm.prank(oracle);
        registry.recordTransaction(bobDid, 1000_00, true);
        vm.prank(bob);
        registry.endorse(aliceDid, "Good agent");

        (uint256 repScore, uint256 stakeScore, uint256 endorseScore, uint256 composite) =
            registry.getTrustDetails(aliceDid);

        assertTrue(repScore > 0, "Reputation score should be positive");
        assertTrue(stakeScore > 0, "Stake score should be positive");
        assertTrue(endorseScore > 0, "Endorsement score should be positive");
        assertTrue(composite > 0, "Composite score should be positive");

        // Verify composite is weighted correctly (approximately)
        // composite = 0.5 * repScore + 0.3 * stakeScore + 0.2 * endorseScore
        uint256 expectedComposite = (repScore * 5000 + stakeScore * 3000 + endorseScore * 2000) / 10000;
        assertEq(composite, expectedComposite);
    }

    // ============ View Function Tests ============

    function test_IsAgentActive_NotRegistered() public {
        assertFalse(registry.isAgentActive(aliceDid));
    }

    function test_GetAgent_NotRegistered() public {
        ITrustRegistry.AgentInfo memory info = registry.getAgent(aliceDid);
        assertEq(info.didHash, bytes32(0));
        assertEq(info.owner, address(0));
    }

    // ============ Access Control Tests ============

    function test_AdminCanGrantRoles() public {
        address newOracle = address(0x100);
        bytes32 oracleRole = registry.ORACLE_ROLE();

        vm.prank(admin);
        registry.grantRole(oracleRole, newOracle);

        assertTrue(registry.hasRole(oracleRole, newOracle));
    }

    function test_NonAdminCannotGrantRoles() public {
        address newOracle = address(0x100);
        bytes32 oracleRole = registry.ORACLE_ROLE();

        vm.prank(alice);
        vm.expectRevert();
        registry.grantRole(oracleRole, newOracle);
    }

    // ============ Fuzz Tests ============

    function testFuzz_DepositStake(uint256 amount) public {
        amount = bound(amount, MINIMUM_STAKE, 100_000 * 1e6);

        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(alice);
        registry.depositStake(aliceDid, amount);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, amount);
    }

    function testFuzz_RecordTransaction(uint256 volume, bool success) public {
        vm.assume(volume <= type(uint128).max);

        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.prank(oracle);
        registry.recordTransaction(aliceDid, volume, success);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.totalTransactions, 1);
        assertEq(data.successfulTransactions, success ? 1 : 0);
        assertEq(data.totalVolumeUsd, volume);
    }

    function testFuzz_TrustScore(uint256 stakeAmount, uint8 numTransactions, uint8 successRatio) public {
        vm.assume(stakeAmount <= 50_000 * 1e6);
        vm.assume(numTransactions > 0 && numTransactions <= 100);
        vm.assume(successRatio <= 100);

        vm.startPrank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        // Only deposit stake if it meets minimum requirement
        if (stakeAmount >= MINIMUM_STAKE) {
            registry.depositStake(aliceDid, stakeAmount);
        }
        vm.stopPrank();

        uint256 successCount = (uint256(numTransactions) * successRatio) / 100;
        vm.startPrank(oracle);
        for (uint256 i = 0; i < successCount; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        for (uint256 i = 0; i < numTransactions - successCount; i++) {
            registry.recordTransaction(aliceDid, 100_00, false);
        }
        vm.stopPrank();

        uint256 score = registry.getTrustScore(aliceDid);
        assertTrue(score <= 10000, "Trust score should not exceed 10000");
    }

    // ============ Endorsement Cooldown Tests ============

    function test_Endorse_CooldownConstant() public {
        assertEq(registry.ENDORSEMENT_COOLDOWN(), 24 hours);
    }

    function test_Endorse_RevertsIfCooldownActive() public {
        // Register all agents
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);
        vm.prank(charlie);
        registry.registerAgent(charlieDid, charlieCID);

        // Alice endorses bob
        vm.prank(alice);
        registry.endorse(bobDid, "Great!");

        // Alice revokes endorsement of bob
        vm.prank(alice);
        registry.revokeEndorsement(bobDid);

        // Alice tries to re-endorse bob immediately - should fail due to cooldown
        // All operations happen in the same block, so remaining time = 24 hours
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TrustRegistry.EndorsementCooldownActive.selector, 24 hours)
        );
        registry.endorse(bobDid, "Great again!");
    }

    function test_Endorse_SucceedsAfterCooldown() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        // Alice endorses bob
        vm.prank(alice);
        registry.endorse(bobDid, "Great!");

        // Alice revokes endorsement
        vm.prank(alice);
        registry.revokeEndorsement(bobDid);

        // Warp past cooldown
        vm.warp(block.timestamp + 24 hours + 1);

        // Alice can now re-endorse bob
        vm.prank(alice);
        registry.endorse(bobDid, "Still great!");

        ITrustRegistry.Endorsement[] memory endorsements = registry.getEndorsements(bobDid);
        assertEq(endorsements.length, 1);
        assertEq(endorsements[0].message, "Still great!");
    }

    function test_Endorse_CooldownDoesNotAffectDifferentEndorsees() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);
        vm.prank(charlie);
        registry.registerAgent(charlieDid, charlieCID);

        // Alice endorses bob (starts cooldown for alice->bob pair)
        vm.prank(alice);
        registry.endorse(bobDid, "Great!");

        // Alice can still endorse charlie (different endorsee)
        vm.prank(alice);
        registry.endorse(charlieDid, "Also great!");

        ITrustRegistry.Endorsement[] memory endorsements = registry.getEndorsements(charlieDid);
        assertEq(endorsements.length, 1);
    }

    function test_Endorse_CooldownPartialTime() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);

        // Alice endorses bob
        vm.prank(alice);
        registry.endorse(bobDid, "Great!");

        // Alice revokes endorsement
        vm.prank(alice);
        registry.revokeEndorsement(bobDid);

        // Warp only halfway through cooldown
        vm.warp(block.timestamp + 12 hours);

        // Should still fail - cooldown not yet passed
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TrustRegistry.EndorsementCooldownActive.selector, 12 hours)
        );
        registry.endorse(bobDid, "Too early!");
    }
}
