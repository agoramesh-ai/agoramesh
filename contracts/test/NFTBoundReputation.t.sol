// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/NFTBoundReputation.sol";
import "../src/AgentToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockUSDC2 is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 1000000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title NFTBoundReputation Tests
/// @notice TDD tests for the NFTBoundReputation contract
contract NFTBoundReputationTest is Test {
    NFTBoundReputation public reputation;
    AgentToken public agentToken;
    MockUSDC2 public usdc;

    address public admin = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public oracle = address(0x4);
    address public arbiter = address(0x5);
    address public treasury = address(0x6);

    // Test DIDs
    bytes32 public constant DID1 = keccak256("did:agoramesh:base:0x1111");
    bytes32 public constant DID2 = keccak256("did:agoramesh:base:0x2222");

    // Events
    event ReputationUpdated(uint256 indexed tokenId, uint256 newScore, uint256 totalTransactions);
    event StakeDeposited(uint256 indexed tokenId, uint256 amount);
    event StakeSlashed(uint256 indexed tokenId, uint256 amount, bytes32 reason);
    event ReputationTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    function setUp() public {
        vm.startPrank(admin);

        usdc = new MockUSDC2();
        agentToken = new AgentToken("AgoraMesh Agents", "AGENT", address(usdc), treasury, admin);
        reputation = new NFTBoundReputation(address(agentToken), address(usdc), admin);

        reputation.grantRole(reputation.ORACLE_ROLE(), oracle);
        reputation.grantRole(reputation.ARBITER_ROLE(), arbiter);

        // Transfer USDC to test users
        usdc.transfer(user1, 100000 * 10 ** 6);
        usdc.transfer(user2, 100000 * 10 ** 6);

        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsAgentToken() public {
        assertEq(address(reputation.agentToken()), address(agentToken));
    }

    function test_Constructor_SetsStakingToken() public {
        assertEq(address(reputation.stakingToken()), address(usdc));
    }

    function test_Constructor_SetsAdmin() public {
        assertTrue(reputation.hasRole(reputation.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_RevertsIfAgentTokenIsZero() public {
        vm.expectRevert(NFTBoundReputation.InvalidAgentToken.selector);
        new NFTBoundReputation(address(0), address(usdc), admin);
    }

    function test_Constructor_RevertsIfStakingTokenIsZero() public {
        vm.expectRevert(NFTBoundReputation.InvalidStakingToken.selector);
        new NFTBoundReputation(address(agentToken), address(0), admin);
    }

    // ============ Record Transaction Tests ============

    function test_RecordTransaction_Success() public {
        // Mint agent token first
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(oracle);

        reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);

        (uint256 score, uint256 transactions, uint256 successRate) = reputation.getReputation(tokenId);
        assertGt(score, 0);
        assertEq(transactions, 1);
        assertEq(successRate, 10000); // 100%

        vm.stopPrank();
    }

    function test_RecordTransaction_FailedTransaction() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(oracle);
        reputation.recordTransaction(tokenId, 100 * 10 ** 6, false);

        (, uint256 transactions, uint256 successRate) = reputation.getReputation(tokenId);
        assertEq(transactions, 1);
        assertEq(successRate, 0); // 0%

        vm.stopPrank();
    }

    function test_RecordTransaction_RevertsIfNotOracle() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        vm.expectRevert();
        reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);
        vm.stopPrank();
    }

    function test_RecordTransaction_RevertsIfTokenNotMinted() public {
        vm.startPrank(oracle);
        vm.expectRevert(NFTBoundReputation.TokenNotFound.selector);
        reputation.recordTransaction(999, 100 * 10 ** 6, true);
        vm.stopPrank();
    }

    // ============ Stake Tests ============

    function test_DepositStake_Success() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);

        vm.expectEmit(true, false, false, true);
        emit StakeDeposited(tokenId, 1000 * 10 ** 6);

        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        assertEq(reputation.getStakedAmount(tokenId), 1000 * 10 ** 6);
        vm.stopPrank();
    }

    function test_DepositStake_RevertsIfNotOwner() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user2);
        usdc.approve(address(reputation), type(uint256).max);
        vm.expectRevert(NFTBoundReputation.NotTokenOwner.selector);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();
    }

    function test_DepositStake_RevertsIfBelowMinimum() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        vm.expectRevert(NFTBoundReputation.StakeBelowMinimum.selector);
        reputation.depositStake(tokenId, 10 * 10 ** 6); // Below $100 minimum
        vm.stopPrank();
    }

    // ============ Slash Tests ============

    function test_Slash_Success() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Deposit stake first
        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        // Slash
        vm.startPrank(arbiter);
        bytes32 disputeId = keccak256("dispute-1");

        vm.expectEmit(true, false, false, true);
        emit StakeSlashed(tokenId, 500 * 10 ** 6, disputeId);

        reputation.slash(tokenId, 500 * 10 ** 6, disputeId);

        assertEq(reputation.getStakedAmount(tokenId), 500 * 10 ** 6);
        vm.stopPrank();
    }

    function test_Slash_RevertsIfNotArbiter() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        vm.expectRevert();
        reputation.slash(tokenId, 500 * 10 ** 6, keccak256("dispute"));
        vm.stopPrank();
    }

    function test_Slash_RevertsIfExceedsStake() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        vm.startPrank(arbiter);
        vm.expectRevert(NFTBoundReputation.InsufficientStake.selector);
        reputation.slash(tokenId, 2000 * 10 ** 6, keccak256("dispute"));
        vm.stopPrank();
    }

    // ============ Trust Score Tests ============

    function test_GetTrustScore_Composite() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Record some transactions
        vm.startPrank(oracle);
        for (uint256 i = 0; i < 10; i++) {
            reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);
        }
        vm.stopPrank();

        // Deposit stake
        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 5000 * 10 ** 6);
        vm.stopPrank();

        uint256 trustScore = reputation.getTrustScore(tokenId);
        assertGt(trustScore, 0);
    }

    function test_GetTrustDetails() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Record transactions
        vm.startPrank(oracle);
        reputation.recordTransaction(tokenId, 1000 * 10 ** 6, true);
        vm.stopPrank();

        // Deposit stake
        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        (uint256 reputationScore, uint256 stakeScore, uint256 compositeScore) = reputation.getTrustDetails(tokenId);
        assertGt(reputationScore, 0);
        assertGt(stakeScore, 0);
        assertGt(compositeScore, 0);
    }

    // ============ Reputation Transfer Tests ============

    function test_ReputationFollowsNFTTransfer() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Build reputation
        vm.startPrank(oracle);
        for (uint256 i = 0; i < 5; i++) {
            reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);
        }
        vm.stopPrank();

        // Deposit stake
        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        uint256 trustBefore = reputation.getTrustScore(tokenId);
        uint256 stakeBefore = reputation.getStakedAmount(tokenId);

        // Transfer NFT
        vm.startPrank(user1);
        agentToken.transferFrom(user1, user2, tokenId);
        vm.stopPrank();

        // Reputation should remain the same after transfer
        uint256 trustAfter = reputation.getTrustScore(tokenId);
        uint256 stakeAfter = reputation.getStakedAmount(tokenId);

        assertEq(trustBefore, trustAfter);
        assertEq(stakeBefore, stakeAfter);

        // New owner can still interact
        vm.startPrank(oracle);
        reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);
        vm.stopPrank();

        // Trust score should update
        uint256 trustUpdated = reputation.getTrustScore(tokenId);
        assertGe(trustUpdated, trustAfter);
    }

    // ============ Get Token By DID Tests ============

    function test_GetReputationByDID() public {
        _mintAgentToken(user1, DID1);

        vm.startPrank(oracle);
        uint256 tokenId = agentToken.getTokenByDID(DID1);
        reputation.recordTransaction(tokenId, 100 * 10 ** 6, true);
        vm.stopPrank();

        uint256 trustScore = reputation.getTrustScoreByDID(DID1);
        assertGt(trustScore, 0);
    }

    // ============ Batch Record Tests ============

    function test_BatchRecordTransactions() public {
        _mintAgentToken(user1, DID1);
        _mintAgentToken(user2, DID2);

        uint256 tokenId1 = agentToken.getTokenByDID(DID1);
        uint256 tokenId2 = agentToken.getTokenByDID(DID2);

        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = tokenId1;
        tokenIds[1] = tokenId2;

        uint256[] memory volumes = new uint256[](2);
        volumes[0] = 100 * 10 ** 6;
        volumes[1] = 200 * 10 ** 6;

        bool[] memory successes = new bool[](2);
        successes[0] = true;
        successes[1] = true;

        vm.startPrank(oracle);
        reputation.batchRecordTransactions(tokenIds, volumes, successes);
        vm.stopPrank();

        (, uint256 tx1,) = reputation.getReputation(tokenId1);
        (, uint256 tx2,) = reputation.getReputation(tokenId2);

        assertEq(tx1, 1);
        assertEq(tx2, 1);
    }

    // ============ Stake Withdrawal Tests (C-4) ============

    function test_RequestWithdraw_Success() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Deposit stake
        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        // Request withdrawal
        uint256 unlockTime = reputation.requestWithdraw(tokenId, 500 * 10 ** 6);
        assertEq(unlockTime, block.timestamp + 7 days);

        // Staked amount should be reduced immediately
        assertEq(reputation.getStakedAmount(tokenId), 500 * 10 ** 6);
        vm.stopPrank();
    }

    function test_RequestWithdraw_FullWithdrawal() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        // Full withdrawal (remaining = 0, which is allowed)
        reputation.requestWithdraw(tokenId, 1000 * 10 ** 6);
        assertEq(reputation.getStakedAmount(tokenId), 0);
        vm.stopPrank();
    }

    function test_RequestWithdraw_RevertsIfNotOwner() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        vm.prank(user2);
        vm.expectRevert(NFTBoundReputation.NotTokenOwner.selector);
        reputation.requestWithdraw(tokenId, 500 * 10 ** 6);
    }

    function test_RequestWithdraw_RevertsIfExceedsStake() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        vm.expectRevert(NFTBoundReputation.InsufficientStake.selector);
        reputation.requestWithdraw(tokenId, 2000 * 10 ** 6);
        vm.stopPrank();
    }

    function test_RequestWithdraw_RevertsIfRemainingBelowMinimum() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        // Withdrawing 950 leaves 50, which is below minimum (100)
        vm.expectRevert(NFTBoundReputation.WithdrawalBelowMinimumStake.selector);
        reputation.requestWithdraw(tokenId, 950 * 10 ** 6);
        vm.stopPrank();
    }

    function test_RequestWithdraw_RevertsIfAlreadyPending() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        reputation.requestWithdraw(tokenId, 500 * 10 ** 6);

        vm.expectRevert(NFTBoundReputation.WithdrawalAlreadyPending.selector);
        reputation.requestWithdraw(tokenId, 200 * 10 ** 6);
        vm.stopPrank();
    }

    function test_ExecuteWithdraw_Success() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        uint256 balBefore = usdc.balanceOf(user1);

        reputation.requestWithdraw(tokenId, 500 * 10 ** 6);

        // Warp past cooldown
        vm.warp(block.timestamp + 7 days + 1);

        reputation.executeWithdraw(tokenId);

        assertEq(usdc.balanceOf(user1), balBefore + 500 * 10 ** 6);
        vm.stopPrank();
    }

    function test_ExecuteWithdraw_RevertsBeforeCooldown() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);

        reputation.requestWithdraw(tokenId, 500 * 10 ** 6);

        // Try to execute immediately (before 7 day cooldown)
        vm.expectRevert(NFTBoundReputation.CooldownNotPassed.selector);
        reputation.executeWithdraw(tokenId);
        vm.stopPrank();
    }

    function test_ExecuteWithdraw_RevertsIfNoPending() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        vm.expectRevert(NFTBoundReputation.NoWithdrawPending.selector);
        reputation.executeWithdraw(tokenId);
        vm.stopPrank();
    }

    function test_Slash_CancelsPendingWithdraw() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        vm.startPrank(user1);
        usdc.approve(address(reputation), type(uint256).max);
        reputation.depositStake(tokenId, 1000 * 10 ** 6);
        reputation.requestWithdraw(tokenId, 500 * 10 ** 6);
        vm.stopPrank();

        // Slash should reclaim pending withdrawal amount too
        vm.prank(arbiter);
        reputation.slash(tokenId, 400 * 10 ** 6, keccak256("dispute-2"));

        // After request: staked=500, pending=500
        // Slash reclaims pending (500) back to staked (now 1000), then slashes 400
        // Final staked = 1000 - 400 = 600
        assertEq(reputation.getStakedAmount(tokenId), 600 * 10 ** 6);
    }

    // ============ L-08: MAX_BATCH_SIZE ============

    function test_BatchRecordTransactions_RevertIfTooLarge() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Create arrays of 101 elements (exceeding MAX_BATCH_SIZE = 100)
        uint256[] memory tokenIds = new uint256[](101);
        uint256[] memory volumes = new uint256[](101);
        bool[] memory successes = new bool[](101);
        for (uint256 i = 0; i < 101; i++) {
            tokenIds[i] = tokenId;
            volumes[i] = 100 * 1e6;
            successes[i] = true;
        }

        vm.prank(oracle);
        vm.expectRevert(NFTBoundReputation.BatchTooLarge.selector);
        reputation.batchRecordTransactions(tokenIds, volumes, successes);
    }

    function test_BatchRecordTransactions_SucceedsAtMaxBatchSize() public {
        _mintAgentToken(user1, DID1);
        uint256 tokenId = agentToken.getTokenByDID(DID1);

        // Create arrays of exactly 100 elements (at MAX_BATCH_SIZE)
        uint256[] memory tokenIds = new uint256[](100);
        uint256[] memory volumes = new uint256[](100);
        bool[] memory successes = new bool[](100);
        for (uint256 i = 0; i < 100; i++) {
            tokenIds[i] = tokenId;
            volumes[i] = 100 * 1e6;
            successes[i] = true;
        }

        vm.prank(oracle);
        reputation.batchRecordTransactions(tokenIds, volumes, successes);

        (, uint256 transactions,) = reputation.getReputation(tokenId);
        assertEq(transactions, 100);
    }

    // ============ Helper Functions ============

    function _mintAgentToken(address to, bytes32 didHash) internal {
        vm.startPrank(to);
        usdc.approve(address(agentToken), type(uint256).max);
        agentToken.mintAgent(didHash, "ipfs://test", "ipfs://uri", 500);
        vm.stopPrank();
    }
}
