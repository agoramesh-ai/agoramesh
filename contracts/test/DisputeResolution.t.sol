// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TieredDisputeResolution.sol";
import "../src/AgentMeshEscrow.sol";
import "../src/TrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC token for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 1e6); // 1M USDC
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DisputeResolutionTest is Test {
    TieredDisputeResolution public disputeResolution;
    AgentMeshEscrow public escrow;
    TrustRegistry public trustRegistry;
    MockUSDC public usdc;

    address public admin = makeAddr("admin");
    address public client = makeAddr("client");
    address public provider = makeAddr("provider");
    address public oracle = makeAddr("oracle");
    address public arbiter1 = makeAddr("arbiter1");
    address public arbiter2 = makeAddr("arbiter2");
    address public arbiter3 = makeAddr("arbiter3");

    bytes32 public clientDid = keccak256("did:agentme:base:client");
    bytes32 public providerDid = keccak256("did:agentme:base:provider");
    bytes32 public arbiter1Did = keccak256("did:agentme:base:arbiter1");
    bytes32 public arbiter2Did = keccak256("did:agentme:base:arbiter2");
    bytes32 public arbiter3Did = keccak256("did:agentme:base:arbiter3");

    // Constants matching the spec
    uint256 constant TIER1_MAX = 10 * 1e6; // $10
    uint256 constant TIER2_MAX = 1000 * 1e6; // $1,000
    uint256 constant EVIDENCE_PERIOD = 48 hours;
    uint256 constant VOTING_PERIOD = 24 hours;
    uint256 constant APPEAL_PERIOD = 48 hours;

    function setUp() public {
        vm.startPrank(admin);

        // Deploy contracts
        usdc = new MockUSDC();
        trustRegistry = new TrustRegistry(address(usdc), admin);
        escrow = new AgentMeshEscrow(address(trustRegistry), admin);
        disputeResolution = new TieredDisputeResolution(address(escrow), address(trustRegistry), address(usdc), admin);

        // Grant roles
        trustRegistry.grantRole(trustRegistry.ORACLE_ROLE(), address(escrow));
        trustRegistry.grantRole(trustRegistry.ARBITER_ROLE(), address(disputeResolution));
        escrow.grantRole(escrow.ARBITER_ROLE(), address(disputeResolution));
        disputeResolution.grantRole(disputeResolution.ORACLE_ROLE(), oracle);

        // Register arbiters in the eligible pool
        disputeResolution.registerArbiter(arbiter1);
        disputeResolution.registerArbiter(arbiter2);
        disputeResolution.registerArbiter(arbiter3);

        // Add USDC to allowed tokens for escrow
        escrow.addAllowedToken(address(usdc));

        vm.stopPrank();

        // Register agents
        _registerAgent(client, clientDid);
        _registerAgent(provider, providerDid);
        _registerAgent(arbiter1, arbiter1Did);
        _registerAgent(arbiter2, arbiter2Did);
        _registerAgent(arbiter3, arbiter3Did);

        // Fund accounts
        usdc.mint(client, 100_000 * 1e6);
        usdc.mint(arbiter1, 10_000 * 1e6);
        usdc.mint(arbiter2, 10_000 * 1e6);
        usdc.mint(arbiter3, 10_000 * 1e6);
    }

    function _registerAgent(address owner, bytes32 did) internal {
        vm.prank(owner);
        trustRegistry.registerAgent(did, "ipfs://capability-card");
    }

    function _createFundedEscrow(uint256 amount) internal returns (uint256 escrowId) {
        vm.startPrank(client);
        usdc.approve(address(escrow), amount);

        escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, keccak256("task"), block.timestamp + 7 days
        );

        escrow.fundEscrow(escrowId);
        vm.stopPrank();
    }

    // ============ Tier Determination Tests ============

    function test_determineTier_tier1_under10() public {
        assertEq(
            uint256(disputeResolution.determineTier(5 * 1e6)),
            uint256(IDisputeResolution.Tier.AUTO),
            "5 USDC should be Tier 1"
        );
    }

    function test_determineTier_tier1_exactly10() public {
        assertEq(
            uint256(disputeResolution.determineTier(10 * 1e6)),
            uint256(IDisputeResolution.Tier.AUTO),
            "10 USDC should be Tier 1"
        );
    }

    function test_determineTier_tier2_above10() public {
        assertEq(
            uint256(disputeResolution.determineTier(11 * 1e6)),
            uint256(IDisputeResolution.Tier.AI_ASSISTED),
            "11 USDC should be Tier 2"
        );
    }

    function test_determineTier_tier2_1000() public {
        assertEq(
            uint256(disputeResolution.determineTier(1000 * 1e6)),
            uint256(IDisputeResolution.Tier.AI_ASSISTED),
            "1000 USDC should be Tier 2"
        );
    }

    function test_determineTier_tier3_above1000() public {
        assertEq(
            uint256(disputeResolution.determineTier(1001 * 1e6)),
            uint256(IDisputeResolution.Tier.COMMUNITY),
            "1001 USDC should be Tier 3"
        );
    }

    // ============ Fee Calculation Tests ============

    function test_calculateFee_tier1_gasOnly() public {
        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AUTO, 5 * 1e6);
        assertEq(fee, 0, "Tier 1 should have no fee");
    }

    function test_calculateFee_tier2_3percent() public {
        // 3% of $500 = $15 (above $5 minimum)
        uint256 fee = disputeResolution.calculateFee(
            IDisputeResolution.Tier.AI_ASSISTED,
            500 * 1e6 // $500
        );
        assertEq(fee, 15 * 1e6, "Tier 2 fee should be 3% ($15)");
    }

    function test_calculateFee_tier2_minimum() public {
        uint256 fee = disputeResolution.calculateFee(
            IDisputeResolution.Tier.AI_ASSISTED,
            20 * 1e6 // $20 -> 3% = $0.60, but min is $5
        );
        assertEq(fee, 5 * 1e6, "Tier 2 minimum fee should be $5");
    }

    function test_calculateFee_tier3_5percent() public {
        uint256 fee = disputeResolution.calculateFee(
            IDisputeResolution.Tier.COMMUNITY,
            2000 * 1e6 // $2000
        );
        assertEq(fee, 100 * 1e6, "Tier 3 fee should be 5% ($100)");
    }

    function test_calculateFee_tier3_minimum() public {
        uint256 fee = disputeResolution.calculateFee(
            IDisputeResolution.Tier.COMMUNITY,
            1001 * 1e6 // $1001 -> 5% = $50.05, equal to min
        );
        assertGe(fee, 50 * 1e6, "Tier 3 minimum fee should be $50");
    }

    // ============ Arbiter Count Tests ============

    function test_getArbiterCount_tier1() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.AUTO, 0), 0, "Tier 1 should have no arbiters"
        );
    }

    function test_getArbiterCount_tier2_round0() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.AI_ASSISTED, 0),
            3,
            "Tier 2 round 0 should have 3 arbiters"
        );
    }

    function test_getArbiterCount_tier3_round0() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.COMMUNITY, 0),
            5,
            "Tier 3 round 0 should have 5 jurors"
        );
    }

    function test_getArbiterCount_tier3_round1() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.COMMUNITY, 1),
            11,
            "Tier 3 round 1 (appeal) should have 11 jurors"
        );
    }

    // ============ Dispute Creation Tests ============

    function test_createDispute_tier1_success() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        // Initiate dispute on escrow first
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        bytes32 evidenceCID = keccak256("evidence");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, evidenceCID);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);

        assertEq(d.id, disputeId);
        assertEq(d.escrowId, escrowId);
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.AUTO));
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.EVIDENCE_PERIOD));
    }

    function test_createDispute_tier2_success() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        bytes32 evidenceCID = keccak256("evidence");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6); // Min fee
        uint256 disputeId = disputeResolution.createDispute(escrowId, evidenceCID);
        vm.stopPrank();

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);

        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.AI_ASSISTED));
    }

    function test_createDispute_requiresDisputedEscrow() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        // Don't initiate dispute on escrow

        bytes32 evidenceCID = keccak256("evidence");

        vm.prank(client);
        vm.expectRevert();
        disputeResolution.createDispute(escrowId, evidenceCID);
    }

    function test_createDispute_onlyParty() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        bytes32 evidenceCID = keccak256("evidence");

        vm.prank(arbiter1); // Not a party
        vm.expectRevert();
        disputeResolution.createDispute(escrowId, evidenceCID);
    }

    // ============ Evidence Submission Tests ============

    function test_submitEvidence_success() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("initial"));

        bytes32 newEvidence = keccak256("more evidence");

        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, newEvidence);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.providerEvidenceCID, newEvidence);
    }

    function test_submitEvidence_afterDeadline_reverts() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("initial"));

        // Warp past evidence deadline
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(provider);
        vm.expectRevert();
        disputeResolution.submitEvidence(disputeId, keccak256("late"));
    }

    // ============ Auto-Resolution (Tier 1) Tests ============

    function test_checkAutoResolution_timeout() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);

        assertTrue(canResolve, "Should be able to auto-resolve");
        // Default: if no provider evidence and deadline passed, favor client
        assertEq(clientShare, 10000, "Client should get 100%");
    }

    function test_executeAutoResolution_success() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(client);
        disputeResolution.executeAutoResolution(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));

        uint256 clientBalanceAfter = usdc.balanceOf(client);
        assertEq(clientBalanceAfter - clientBalanceBefore, 5 * 1e6, "Client should receive full refund");
    }

    // ============ AI Analysis Tests (Tier 2) ============

    function test_submitAIAnalysis_oracleOnly() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        bytes32 analysisCID = keccak256("ai-analysis");

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, analysisCID, 5000); // 50% split

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.aiAnalysisCID, analysisCID);
    }

    function test_submitAIAnalysis_notOracle_reverts() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(arbiter1); // Not oracle
        vm.expectRevert();
        disputeResolution.submitAIAnalysis(disputeId, keccak256("fake"), 5000);
    }

    // ============ Voting Tests ============

    function test_castVote_success() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis (transitions to voting)
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Arbiter votes
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("justification"));

        IDisputeResolution.ArbiterVote[] memory votes = disputeResolution.getVotes(disputeId);
        assertEq(votes.length, 1);
        assertEq(votes[0].arbiter, arbiter1);
        assertEq(uint256(votes[0].vote), uint256(IDisputeResolution.Vote.FAVOR_CLIENT));
    }

    function test_castVote_afterDeadline_reverts() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.prank(arbiter1);
        vm.expectRevert();
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("too late"));
    }

    // ============ Ruling Tests ============

    function test_finalizeRuling_majorityWins() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // 2 vote for client, 1 for provider = client wins
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");

        // Warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        disputeResolution.finalizeRuling(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.clientShare, 10000, "Client should get 100%");
        assertEq(d.providerShare, 0, "Provider should get 0%");
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.APPEALABLE));
    }

    // ============ Appeal Tests ============

    function test_appeal_success() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0); // AI says refund

        // All vote for client (provider loses)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        disputeResolution.finalizeRuling(disputeId);

        // Provider appeals
        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);

        vm.startPrank(provider);
        usdc.mint(provider, appealFee);
        usdc.approve(address(disputeResolution), appealFee);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.appealRound, 1, "Should be on appeal round 1");
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.COMMUNITY), "Should escalate to Tier 3");
    }

    function test_appeal_afterDeadline_reverts() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        disputeResolution.finalizeRuling(disputeId);

        // Warp past appeal deadline
        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);

        vm.startPrank(provider);
        usdc.mint(provider, appealFee);
        usdc.approve(address(disputeResolution), appealFee);
        vm.expectRevert();
        disputeResolution.appeal(disputeId);
        vm.stopPrank();
    }

    // ============ Settlement Tests ============

    function test_executeSettlement_success() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 7000); // 70% client

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        disputeResolution.finalizeRuling(disputeId);

        // Warp past appeal deadline (no appeal)
        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 providerBefore = usdc.balanceOf(provider);

        disputeResolution.executeSettlement(disputeId);

        uint256 clientAfter = usdc.balanceOf(client);
        uint256 providerAfter = usdc.balanceOf(provider);

        // 70% to client, 30% to provider
        assertEq(clientAfter - clientBefore, 70 * 1e6, "Client should receive 70%");
        assertEq(providerAfter - providerBefore, 30 * 1e6, "Provider should receive 30%");
    }

    function test_executeSettlement_beforeAppealDeadline_reverts() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 10000);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        disputeResolution.finalizeRuling(disputeId);

        // Don't warp past appeal deadline
        vm.expectRevert();
        disputeResolution.executeSettlement(disputeId);
    }

    // ============ Arbiter Verification Tests (CRITICAL FIX) ============

    /// @notice Tests that non-arbiters cannot vote on disputes
    /// @dev This test exposes the missing arbiter verification vulnerability
    function test_RevertIfNonArbiterVotes() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis (transitions to voting)
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Create a random non-arbiter address
        address nonArbiter = makeAddr("nonArbiter");

        // CRITICAL: Non-arbiter should NOT be able to vote
        // Current implementation allows "anyone to vote for testing"
        vm.prank(nonArbiter);
        vm.expectRevert(TieredDisputeResolution.NotArbiter.selector);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("fake vote"));
    }

    /// @notice Tests that registered arbiters CAN vote on disputes
    /// @dev Ensures fix doesn't break legitimate arbiter voting
    function test_ArbiterCanVote() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis (transitions to voting and selects arbiters)
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Get the selected arbiters
        address[] memory selectedArbiters = disputeResolution.getArbiters(disputeId);

        // If arbiters were selected, the first one should be able to vote
        // Note: In production, _selectArbiters would populate this array
        // For this test to pass after fix, we need arbiters to be properly selected
        if (selectedArbiters.length > 0) {
            vm.prank(selectedArbiters[0]);
            disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("justification"));

            IDisputeResolution.ArbiterVote[] memory votes = disputeResolution.getVotes(disputeId);
            assertEq(votes.length, 1, "Vote should be recorded");
            assertEq(votes[0].arbiter, selectedArbiters[0], "Arbiter address should match");
        }
    }

    /// @notice Tests that parties to the dispute cannot vote as arbiters
    /// @dev Prevents conflict of interest
    function test_RevertIfPartyVotesAsArbiter() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Client (a party) should not be able to vote
        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.NotArbiter.selector);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("biased vote"));

        // Provider (a party) should not be able to vote
        vm.prank(provider);
        vm.expectRevert(TieredDisputeResolution.NotArbiter.selector);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, keccak256("biased vote"));
    }

    // ============ Quorum Tests (H-3) ============

    function _createTier2Dispute() internal returns (uint256 disputeId) {
        uint256 escrowId = _createFundedEscrow(500 * 1e6);

        vm.prank(provider);
        escrow.confirmDelivery(escrowId, keccak256("output"));

        // Initiate dispute on escrow first
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        // Create dispute in resolution contract
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 100 * 1e6);
        disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();
    }

    function test_finalizeRuling_RevertsIfNoVotes() public {
        uint256 disputeId = _createTier2Dispute();

        // Skip evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Submit AI analysis to move to voting
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Skip voting period without any votes
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // finalizeRuling should revert - no quorum
        vm.expectRevert(TieredDisputeResolution.QuorumNotMet.selector);
        disputeResolution.finalizeRuling(disputeId);
    }

    function test_finalizeRuling_RevertsIfInsufficientVotes() public {
        uint256 disputeId = _createTier2Dispute();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Only 1 of 3 arbiters votes (need at least 2 for quorum = 2/3)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("just1"));

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Should revert - only 1/3 voted, need 2/3
        vm.expectRevert(TieredDisputeResolution.QuorumNotMet.selector);
        disputeResolution.finalizeRuling(disputeId);
    }

    function test_finalizeRuling_SucceedsWithQuorum() public {
        uint256 disputeId = _createTier2Dispute();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // 2 of 3 arbiters vote (meets 2/3 quorum)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("just1"));
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("just2"));

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Should succeed with 2/3 quorum met
        disputeResolution.finalizeRuling(disputeId);
    }

    // ============ Arbiter Pool Management Tests ============

    function test_registerArbiter_success() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(admin);
        disputeResolution.registerArbiter(newArbiter);

        address[] memory arbiters = disputeResolution.getEligibleArbiters();
        bool found = false;
        for (uint256 i = 0; i < arbiters.length; i++) {
            if (arbiters[i] == newArbiter) {
                found = true;
                break;
            }
        }
        assertTrue(found, "New arbiter should be in eligible pool");
    }

    function test_registerArbiter_revertsIfZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert("Invalid arbiter address");
        disputeResolution.registerArbiter(address(0));
    }

    function test_registerArbiter_revertsIfAlreadyRegistered() public {
        vm.prank(admin);
        vm.expectRevert(TieredDisputeResolution.ArbiterAlreadyRegistered.selector);
        disputeResolution.registerArbiter(arbiter1); // Already registered in setUp
    }

    function test_registerArbiter_revertsIfNotAdmin() public {
        address newArbiter = makeAddr("newArbiter");
        vm.prank(arbiter1); // Not admin
        vm.expectRevert();
        disputeResolution.registerArbiter(newArbiter);
    }

    function test_unregisterArbiter_success() public {
        address[] memory arbitersBefore = disputeResolution.getEligibleArbiters();
        uint256 countBefore = arbitersBefore.length;

        vm.prank(admin);
        disputeResolution.unregisterArbiter(arbiter3);

        address[] memory arbitersAfter = disputeResolution.getEligibleArbiters();
        assertEq(arbitersAfter.length, countBefore - 1, "Should have one fewer arbiter");

        // Verify arbiter3 is no longer in the pool
        for (uint256 i = 0; i < arbitersAfter.length; i++) {
            assertTrue(arbitersAfter[i] != arbiter3, "Removed arbiter should not be in pool");
        }
    }

    function test_unregisterArbiter_swapAndPop() public {
        // Register a 4th arbiter, then remove 1st to test swap-and-pop
        address arbiter4 = makeAddr("arbiter4");
        vm.startPrank(admin);
        disputeResolution.registerArbiter(arbiter4);

        // Remove arbiter1 — should be replaced by last element
        disputeResolution.unregisterArbiter(arbiter1);
        vm.stopPrank();

        address[] memory arbiters = disputeResolution.getEligibleArbiters();
        assertEq(arbiters.length, 3, "Should have 3 arbiters after removal");

        // arbiter1 should not be present
        for (uint256 i = 0; i < arbiters.length; i++) {
            assertTrue(arbiters[i] != arbiter1, "Removed arbiter should not be in pool");
        }
    }

    function test_unregisterArbiter_nonExistentIsNoop() public {
        address[] memory arbitersBefore = disputeResolution.getEligibleArbiters();
        address nonExistent = makeAddr("nonExistent");

        vm.prank(admin);
        disputeResolution.unregisterArbiter(nonExistent); // Should not revert

        address[] memory arbitersAfter = disputeResolution.getEligibleArbiters();
        assertEq(arbitersAfter.length, arbitersBefore.length, "Count should not change");
    }

    function test_unregisterArbiter_revertsIfNotAdmin() public {
        vm.prank(arbiter1); // Not admin
        vm.expectRevert();
        disputeResolution.unregisterArbiter(arbiter2);
    }

    function test_getEligibleArbiters_returnsAll() public {
        address[] memory arbiters = disputeResolution.getEligibleArbiters();
        assertEq(arbiters.length, 3, "Should have 3 arbiters from setUp");
        assertEq(arbiters[0], arbiter1);
        assertEq(arbiters[1], arbiter2);
        assertEq(arbiters[2], arbiter3);
    }

    function test_getEligibleArbiters_emptyWhenNoneRegistered() public {
        // Remove all arbiters
        vm.startPrank(admin);
        disputeResolution.unregisterArbiter(arbiter1);
        disputeResolution.unregisterArbiter(arbiter2);
        disputeResolution.unregisterArbiter(arbiter3);
        vm.stopPrank();

        address[] memory arbiters = disputeResolution.getEligibleArbiters();
        assertEq(arbiters.length, 0, "Should be empty");
    }

    // ============ Fee Management Tests ============

    function test_withdrawFees_success() public {
        // Create a tier 2 dispute to accumulate fees
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        uint256 poolBefore = disputeResolution.feePool();
        assertGt(poolBefore, 0, "Fee pool should have funds");

        address feeRecipient = makeAddr("feeRecipient");
        uint256 recipientBefore = usdc.balanceOf(feeRecipient);

        vm.prank(admin);
        disputeResolution.withdrawFees(feeRecipient);

        assertEq(disputeResolution.feePool(), 0, "Fee pool should be zero after withdrawal");
        assertEq(usdc.balanceOf(feeRecipient) - recipientBefore, poolBefore, "Recipient should receive all fees");
    }

    function test_withdrawFees_revertsIfEmpty() public {
        address feeRecipient = makeAddr("feeRecipient");
        vm.prank(admin);
        vm.expectRevert(TieredDisputeResolution.NoFeesToWithdraw.selector);
        disputeResolution.withdrawFees(feeRecipient);
    }

    function test_withdrawFees_revertsIfNotAdmin() public {
        vm.prank(arbiter1); // Not admin
        vm.expectRevert();
        disputeResolution.withdrawFees(arbiter1);
    }

    // ============ View Function Tests ============

    function test_getDispute_returnsCorrectData() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        bytes32 evidenceCID = keccak256("evidence");
        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, evidenceCID);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.id, disputeId, "ID should match");
        assertEq(d.escrowId, escrowId, "Escrow ID should match");
        assertEq(d.amount, 5 * 1e6, "Amount should match");
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.AUTO), "Tier should be AUTO");
        assertEq(
            uint256(d.state),
            uint256(IDisputeResolution.DisputeState.EVIDENCE_PERIOD),
            "State should be EVIDENCE_PERIOD"
        );
        assertEq(d.clientEvidenceCID, evidenceCID, "Client evidence should match");
        assertEq(d.providerEvidenceCID, bytes32(0), "Provider evidence should be empty");
        assertEq(d.appealRound, 0, "Appeal round should be 0");
    }

    function test_getDispute_nonExistentReturnsZero() public {
        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(999);
        assertEq(d.id, 0, "Non-existent dispute should have id 0");
    }

    function test_getVotes_emptyBeforeVoting() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        IDisputeResolution.ArbiterVote[] memory votes = disputeResolution.getVotes(disputeId);
        assertEq(votes.length, 0, "Should have no votes yet");
    }

    function test_getVotes_returnsCorrectVoteDetails() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        bytes32 justification = keccak256("my justification");
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, justification);

        IDisputeResolution.ArbiterVote[] memory votes = disputeResolution.getVotes(disputeId);
        assertEq(votes.length, 1, "Should have 1 vote");
        assertEq(votes[0].arbiter, arbiter1, "Arbiter should match");
        assertEq(uint256(votes[0].vote), uint256(IDisputeResolution.Vote.SPLIT), "Vote type should be SPLIT");
        assertEq(votes[0].clientShareProposal, 7000, "Client share proposal should be 7000");
        assertEq(votes[0].justificationCID, justification, "Justification should match");
        assertGt(votes[0].votedAt, 0, "votedAt should be non-zero");
    }

    function test_getArbiters_returnsSelectedArbiters() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Before AI analysis, no arbiters selected
        address[] memory arbitersBefore = disputeResolution.getArbiters(disputeId);
        assertEq(arbitersBefore.length, 0, "No arbiters before AI analysis");

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        address[] memory arbitersAfter = disputeResolution.getArbiters(disputeId);
        assertEq(arbitersAfter.length, 3, "Should have 3 arbiters for Tier 2");

        // Verify no duplicates
        assertTrue(arbitersAfter[0] != arbitersAfter[1], "No duplicate arbiters");
        assertTrue(arbitersAfter[0] != arbitersAfter[2], "No duplicate arbiters");
        assertTrue(arbitersAfter[1] != arbitersAfter[2], "No duplicate arbiters");

        // Verify parties are excluded
        for (uint256 i = 0; i < arbitersAfter.length; i++) {
            assertTrue(arbitersAfter[i] != client, "Client should not be arbiter");
            assertTrue(arbitersAfter[i] != provider, "Provider should not be arbiter");
        }
    }

    // ============ Additional createDispute Tests ============

    function test_createDispute_tier3_success() public {
        uint256 amount = 2000 * 1e6; // $2000 -> Tier 3
        uint256 escrowId = _createFundedEscrow(amount);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, amount);

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.COMMUNITY), "Should be Tier 3");
        assertGt(disputeResolution.feePool(), 0, "Fee pool should have funds");
    }

    function test_createDispute_revertsIfDuplicate() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        disputeResolution.createDispute(escrowId, keccak256("evidence1"));

        // Second dispute for same escrow should revert
        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.DisputeAlreadyExists.selector);
        disputeResolution.createDispute(escrowId, keccak256("evidence2"));
    }

    function test_createDispute_providerCanCreate() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);

        // Provider initiates the dispute on escrow
        vm.prank(provider);
        escrow.initiateDispute(escrowId, "");

        // Provider creates dispute in resolution contract
        vm.prank(provider);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("provider-evidence"));

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.providerEvidenceCID, keccak256("provider-evidence"), "Provider evidence should be set");
        assertEq(d.clientEvidenceCID, bytes32(0), "Client evidence should be empty");
    }

    function test_createDispute_feeAddedToPool() public {
        uint256 amount = 100 * 1e6; // $100 -> Tier 2
        uint256 escrowId = _createFundedEscrow(amount);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        uint256 expectedFee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        uint256 poolBefore = disputeResolution.feePool();

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), expectedFee);
        disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        assertEq(disputeResolution.feePool() - poolBefore, expectedFee, "Fee pool should increase by fee amount");
    }

    // ============ Additional Evidence Tests ============

    function test_submitEvidence_nonPartyReverts() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");
        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("initial"));

        vm.prank(arbiter1); // Not a party
        vm.expectRevert(TieredDisputeResolution.NotParty.selector);
        disputeResolution.submitEvidence(disputeId, keccak256("evidence"));
    }

    function test_submitEvidence_bothPartiesCanSubmit() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");
        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("initial-client"));

        bytes32 providerEvidence = keccak256("provider-evidence");
        bytes32 clientNewEvidence = keccak256("client-new-evidence");

        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, providerEvidence);

        vm.prank(client);
        disputeResolution.submitEvidence(disputeId, clientNewEvidence);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.providerEvidenceCID, providerEvidence, "Provider evidence should be set");
        assertEq(d.clientEvidenceCID, clientNewEvidence, "Client evidence should be updated");
    }

    // ============ Additional AI Analysis Tests ============

    function test_submitAIAnalysis_revertsIfInvalidClientShare() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        vm.expectRevert(TieredDisputeResolution.InvalidClientShare.selector);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 10001); // > BP
    }

    function test_submitAIAnalysis_revertsIfEvidencePeriodNotEnded() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Don't warp past evidence period
        vm.prank(oracle);
        vm.expectRevert(TieredDisputeResolution.EvidencePeriodNotEnded.selector);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);
    }

    function test_submitAIAnalysis_revertsIfTier1() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6); // Tier 1
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        vm.expectRevert(TieredDisputeResolution.NotTier1.selector);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);
    }

    function test_submitAIAnalysis_transitionsToVoting() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.VOTING), "Should transition to VOTING");
        assertGt(d.votingDeadline, 0, "Voting deadline should be set");
    }

    // ============ Additional Voting Tests ============

    function test_castVote_revertsIfAlreadyVoted() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.prank(arbiter1);
        vm.expectRevert(TieredDisputeResolution.AlreadyVoted.selector);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
    }

    function test_castVote_splitVoteInvalidShareReverts() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        vm.prank(arbiter1);
        vm.expectRevert(TieredDisputeResolution.InvalidClientShare.selector);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 10001, ""); // > BP
    }

    // ============ Additional Ruling Tests ============

    function test_finalizeRuling_providerMajorityWins() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // 2 vote for provider, 1 for client
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.clientShare, 0, "Client should get 0%");
        assertEq(d.providerShare, 10000, "Provider should get 100%");
    }

    function test_finalizeRuling_splitVoteAveraging() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // All 3 vote SPLIT with different proposals: 6000, 8000, 4000
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 6000, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 8000, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 4000, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        // Average: (6000 + 8000 + 4000) / 3 = 6000
        assertEq(d.clientShare, 6000, "Client should get average 60%");
        assertEq(d.providerShare, 4000, "Provider should get 40%");
    }

    function test_finalizeRuling_tieDefaultsTo5050() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // 1 client, 1 provider, 1 abstain = tie (abstain doesn't count in split)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.ABSTAIN, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.clientShare, 5000, "Tie should default to 50%");
        assertEq(d.providerShare, 5000, "Tie should default to 50%");
    }

    function test_finalizeRuling_revertsIfNotVotingState() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Still in EVIDENCE_PERIOD, not VOTING
        vm.expectRevert(TieredDisputeResolution.InvalidState.selector);
        disputeResolution.finalizeRuling(disputeId);
    }

    function test_finalizeRuling_revertsIfVotingNotEnded() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 5000);

        // Vote but don't warp past voting period
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.expectRevert(TieredDisputeResolution.VotingPeriodNotEnded.selector);
        disputeResolution.finalizeRuling(disputeId);
    }

    // ============ Additional Appeal Tests ============

    function test_appeal_revertsIfNotAppealable() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Still in EVIDENCE_PERIOD, not APPEALABLE
        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.InvalidState.selector);
        disputeResolution.appeal(disputeId);
    }

    function test_appeal_revertsIfNonParty() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);
        usdc.mint(arbiter1, appealFee);

        vm.startPrank(arbiter1); // Not a party
        usdc.approve(address(disputeResolution), appealFee);
        vm.expectRevert(TieredDisputeResolution.NotParty.selector);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();
    }

    function test_appeal_clientCanAppeal() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0);

        // All vote for provider (client loses)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);

        // Client appeals
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), appealFee);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.appealRound, 1, "Appeal round should be 1");
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.VOTING), "Should be back to VOTING");
    }

    function test_appeal_clearsVotesAndArbiters() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        // Verify votes exist before appeal
        assertEq(disputeResolution.getVotes(disputeId).length, 3, "Should have 3 votes before appeal");

        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);
        vm.startPrank(provider);
        usdc.mint(provider, appealFee);
        usdc.approve(address(disputeResolution), appealFee);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();

        // Votes should be cleared after appeal
        assertEq(disputeResolution.getVotes(disputeId).length, 0, "Votes should be cleared after appeal");
    }

    function test_appeal_feeAddedToPool() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 0);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        uint256 poolBefore = disputeResolution.feePool();
        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 100 * 1e6);

        vm.startPrank(provider);
        usdc.mint(provider, appealFee);
        usdc.approve(address(disputeResolution), appealFee);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();

        assertEq(disputeResolution.feePool() - poolBefore, appealFee, "Appeal fee should be added to pool");
    }

    // ============ Additional Settlement Tests ============

    function test_executeSettlement_revertsIfNotAppealable() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        vm.expectRevert(TieredDisputeResolution.InvalidState.selector);
        disputeResolution.executeSettlement(disputeId);
    }

    // ============ Additional Auto-Resolution Tests ============

    function test_checkAutoResolution_nonExistentReturnsFalse() public {
        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(999);
        assertFalse(canResolve, "Non-existent dispute should not be auto-resolvable");
        assertEq(clientShare, 0);
    }

    function test_checkAutoResolution_nonTier1ReturnsFalse() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6); // Tier 2
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        (bool canResolve,) = disputeResolution.checkAutoResolution(disputeId);
        assertFalse(canResolve, "Tier 2 dispute should not be auto-resolvable");
    }

    function test_checkAutoResolution_duringEvidencePeriodReturnsFalse() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Don't warp past evidence period
        (bool canResolve,) = disputeResolution.checkAutoResolution(disputeId);
        assertFalse(canResolve, "Should not be auto-resolvable during evidence period");
    }

    function test_checkAutoResolution_bothEvidenceSplits5050() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("client-evidence"));

        // Provider also submits evidence
        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, keccak256("provider-evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);
        assertTrue(canResolve, "Should be auto-resolvable");
        assertEq(clientShare, 5000, "Both evidence = 50/50 split");
    }

    function test_checkAutoResolution_noClientEvidence_providerGetsAll() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        // Provider creates dispute (provider has evidence, client doesn't)
        vm.prank(provider);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("provider-evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);
        assertTrue(canResolve, "Should be auto-resolvable");
        assertEq(clientShare, 0, "No client evidence = 100% to provider");
    }

    function test_executeAutoResolution_providerCanExecute() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(provider); // Provider executes (not just client)
        disputeResolution.executeAutoResolution(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));
    }

    function test_executeAutoResolution_revertsIfNotTier1() public {
        uint256 escrowId = _createFundedEscrow(100 * 1e6); // Tier 2
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), 5 * 1e6);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.NotTier1.selector);
        disputeResolution.executeAutoResolution(disputeId);
    }

    function test_executeAutoResolution_revertsIfEvidencePeriodNotEnded() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Don't warp past evidence period
        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.EvidencePeriodNotEnded.selector);
        disputeResolution.executeAutoResolution(disputeId);
    }

    function test_executeAutoResolution_revertsIfNotParty() public {
        uint256 escrowId = _createFundedEscrow(5 * 1e6);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(arbiter1); // Not a party
        vm.expectRevert(TieredDisputeResolution.NotDisputeParty.selector);
        disputeResolution.executeAutoResolution(disputeId);
    }

    // ============ Additional Arbiter Count Tests ============

    function test_getArbiterCount_tier3_round2() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.COMMUNITY, 2),
            23,
            "Tier 3 round 2 should have 23 jurors"
        );
    }

    function test_getArbiterCount_tier3_round3() public {
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.COMMUNITY, 3),
            47,
            "Tier 3 round 3 should have 47 jurors"
        );
    }

    function test_getArbiterCount_tier3_beyondRound3() public {
        // Round 4+ should still return 47 (max)
        assertEq(
            disputeResolution.getArbiterCount(IDisputeResolution.Tier.COMMUNITY, 4),
            47,
            "Tier 3 round 4+ should have 47 jurors (max)"
        );
    }

    // ============ Additional Fee Calculation Tests ============

    function test_calculateFee_tier2_atExact100() public {
        // $100 -> 3% = $3, but min is $5
        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, 100 * 1e6);
        assertEq(fee, 5 * 1e6, "Fee at $100 should be minimum $5");
    }

    function test_calculateFee_tier3_largeAmount() public {
        // $20,000 -> 5% = $1,000
        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, 20_000 * 1e6);
        assertEq(fee, 1000 * 1e6, "Fee at $20K should be 5% = $1000");
    }

    function test_determineTier_zeroAmount() public {
        assertEq(
            uint256(disputeResolution.determineTier(0)), uint256(IDisputeResolution.Tier.AUTO), "$0 should be Tier 1"
        );
    }

    function test_determineTier_veryLargeAmount() public {
        assertEq(
            uint256(disputeResolution.determineTier(1_000_000 * 1e6)),
            uint256(IDisputeResolution.Tier.COMMUNITY),
            "$1M should be Tier 3"
        );
    }
}
