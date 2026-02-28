// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/StreamingPayments.sol";
import "../src/TieredDisputeResolution.sol";
import "../src/TrustRegistry.sol";
import "../src/interfaces/IAgoraMeshEscrow.sol";
import "../src/interfaces/IDisputeResolution.sol";
import "../src/interfaces/IStreamingPayments.sol";
import "../src/interfaces/ITrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC token for integration testing
contract IntegrationMockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title Integration Tests for AgoraMesh Escrow Lifecycle
/// @notice End-to-end tests covering Escrow, DisputeResolution, and TrustRegistry
contract IntegrationTest is Test {
    AgoraMeshEscrow public escrow;
    StreamingPayments public streaming;
    TieredDisputeResolution public disputeResolution;
    TrustRegistry public trustRegistry;
    IntegrationMockUSDC public usdc;

    address public admin = makeAddr("admin");
    address public client = makeAddr("client");
    address public provider = makeAddr("provider");
    address public oracle = makeAddr("oracle");
    address public facilitator = makeAddr("facilitator");
    address public treasury = makeAddr("treasury");
    address public arbiter1 = makeAddr("arbiter1");
    address public arbiter2 = makeAddr("arbiter2");
    address public arbiter3 = makeAddr("arbiter3");
    address public arbiter4 = makeAddr("arbiter4");
    address public arbiter5 = makeAddr("arbiter5");

    // Extra arbiters needed for COMMUNITY tier appeal rounds
    address[6] public extraArbiters;

    bytes32 public clientDid = keccak256("did:agoramesh:integration:client");
    bytes32 public providerDid = keccak256("did:agoramesh:integration:provider");

    bytes32 public taskHash = keccak256("integration-test-task");
    bytes32 public outputHash = keccak256("integration-test-output");

    uint256 public constant MINIMUM_STAKE = 100 * 1e6;
    uint256 public constant EVIDENCE_PERIOD = 48 hours;
    uint256 public constant VOTING_PERIOD = 24 hours;
    uint256 public constant APPEAL_PERIOD = 48 hours;
    uint256 public constant AUTO_RELEASE_DELAY = 24 hours;

    function setUp() public {
        vm.startPrank(admin);

        // Deploy contracts
        usdc = new IntegrationMockUSDC();
        trustRegistry = new TrustRegistry(address(usdc), admin);
        escrow = new AgoraMeshEscrow(address(trustRegistry), admin);
        disputeResolution = new TieredDisputeResolution(address(escrow), address(trustRegistry), address(usdc), admin);

        // Grant cross-contract roles
        // Escrow needs ORACLE_ROLE on TrustRegistry to record transactions
        trustRegistry.grantRole(trustRegistry.ORACLE_ROLE(), address(escrow));
        // DisputeResolution needs ARBITER_ROLE on Escrow to resolve disputes
        escrow.grantRole(escrow.ARBITER_ROLE(), address(disputeResolution));
        // DisputeResolution needs ARBITER_ROLE on TrustRegistry (via escrow's resolveDispute)
        trustRegistry.grantRole(trustRegistry.ARBITER_ROLE(), address(disputeResolution));
        // Oracle role on DisputeResolution for AI analysis
        disputeResolution.grantRole(disputeResolution.ORACLE_ROLE(), oracle);

        // Register arbiters in the eligible pool
        disputeResolution.registerArbiter(arbiter1);
        disputeResolution.registerArbiter(arbiter2);
        disputeResolution.registerArbiter(arbiter3);
        disputeResolution.registerArbiter(arbiter4);
        disputeResolution.registerArbiter(arbiter5);

        // Register extra arbiters for COMMUNITY tier rounds (need up to 11 arbiters)
        for (uint256 i = 0; i < 6; i++) {
            extraArbiters[i] = makeAddr(string(abi.encodePacked("extra-arbiter-", vm.toString(i))));
            disputeResolution.registerArbiter(extraArbiters[i]);
        }

        // Add USDC to allowed tokens
        escrow.addAllowedToken(address(usdc));

        // Deploy StreamingPayments
        streaming = new StreamingPayments(admin, address(trustRegistry));

        vm.stopPrank();

        // Register agents
        vm.prank(client);
        trustRegistry.registerAgent(clientDid, "ipfs://client-capability-card");

        vm.prank(provider);
        trustRegistry.registerAgent(providerDid, "ipfs://provider-capability-card");

        // Fund accounts
        usdc.mint(client, 500_000 * 1e6);
        usdc.mint(provider, 100_000 * 1e6);
        usdc.mint(arbiter1, 10_000 * 1e6);
        usdc.mint(arbiter2, 10_000 * 1e6);
        usdc.mint(arbiter3, 10_000 * 1e6);

        // Stake minimum for both agents
        vm.startPrank(client);
        usdc.approve(address(trustRegistry), type(uint256).max);
        trustRegistry.depositStake(clientDid, MINIMUM_STAKE);
        vm.stopPrank();

        vm.startPrank(provider);
        usdc.approve(address(trustRegistry), type(uint256).max);
        trustRegistry.depositStake(providerDid, MINIMUM_STAKE);
        vm.stopPrank();

        // Pre-approve escrow and streaming contracts for client
        vm.startPrank(client);
        usdc.approve(address(escrow), type(uint256).max);
        usdc.approve(address(streaming), type(uint256).max);
        vm.stopPrank();
    }

    // ================================================================
    // Happy Path: create -> fund -> deliver -> release (client approves)
    // ================================================================

    function test_Integration_HappyPath_ClientRelease() public {
        uint256 amount = 500 * 1e6; // $500
        uint256 deadline = block.timestamp + 7 days;

        uint256 clientBalBefore = usdc.balanceOf(client);
        uint256 providerBalBefore = usdc.balanceOf(provider);

        // 1. Client creates escrow
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.AWAITING_DEPOSIT));

        // 2. Client funds escrow
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.FUNDED));
        assertEq(usdc.balanceOf(address(escrow)), amount);

        // 3. Provider delivers work
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DELIVERED));
        assertEq(e.outputHash, outputHash);
        assertGt(e.deliveredAt, 0);

        // 4. Client releases payment
        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(client), clientBalBefore - amount);
        assertEq(usdc.balanceOf(provider), providerBalBefore + amount);

        // 5. Verify TrustRegistry recorded the successful transaction
        ITrustRegistry.TrustData memory providerTrust = trustRegistry.getTrustData(providerDid);
        assertEq(providerTrust.totalTransactions, 1);
        assertEq(providerTrust.successfulTransactions, 1);
        assertGt(providerTrust.reputationScore, 0);
    }

    // ================================================================
    // Happy Path: provider auto-release after 24h delay
    // ================================================================

    function test_Integration_HappyPath_ProviderAutoRelease() public {
        uint256 amount = 200 * 1e6;
        uint256 deadline = block.timestamp + 7 days;

        // Create, fund, deliver
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        // Provider cannot release before delay
        vm.prank(provider);
        vm.expectRevert(AgoraMeshEscrow.AutoReleaseNotReady.selector);
        escrow.releaseEscrow(escrowId);

        // Warp past auto-release delay
        vm.warp(block.timestamp + AUTO_RELEASE_DELAY + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        // Provider auto-releases
        vm.prank(provider);
        escrow.releaseEscrow(escrowId);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalBefore + amount);
    }

    // ================================================================
    // Timeout Path: client reclaims funds after deadline
    // ================================================================

    function test_Integration_TimeoutPath_ClientRefund() public {
        uint256 amount = 300 * 1e6;
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        uint256 clientBalBefore = usdc.balanceOf(client);

        // Warp past deadline
        vm.warp(deadline + 1);

        // Client claims timeout
        vm.prank(client);
        escrow.claimTimeout(escrowId);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalBefore + amount);

        // TrustRegistry recorded a failed transaction for provider
        ITrustRegistry.TrustData memory providerTrust = trustRegistry.getTrustData(providerDid);
        assertEq(providerTrust.totalTransactions, 1);
        assertEq(providerTrust.successfulTransactions, 0);
    }

    // ================================================================
    // Dispute Path (Tier 1): auto-resolution for small amounts
    // ================================================================

    function test_Integration_DisputePath_Tier1_AutoResolution() public {
        uint256 amount = 5 * 1e6; // $5 = Tier 1 (AUTO)
        uint256 deadline = block.timestamp + 7 days;

        // Create and fund escrow
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // Client initiates dispute on escrow
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence-data");

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DISPUTED));

        // Client creates dispute in dispute resolution contract
        bytes32 evidenceCID = keccak256("client-evidence");
        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, evidenceCID);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.AUTO));
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.EVIDENCE_PERIOD));

        // Warp past evidence period (no provider evidence submitted)
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Check auto-resolution: no provider evidence = 100% to client
        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);
        assertTrue(canResolve);
        assertEq(clientShare, 10000); // 100% to client

        uint256 clientBalBefore = usdc.balanceOf(client);

        // Execute auto-resolution
        vm.prank(client);
        disputeResolution.executeAutoResolution(disputeId);

        // Verify dispute settled
        d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));

        // Verify escrow resolved (full refund to client)
        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalBefore + amount);
    }

    // ================================================================
    // Dispute Path (Tier 1): auto-resolution with both evidence = 50/50
    // ================================================================

    function test_Integration_DisputePath_Tier1_BothEvidence_5050Split() public {
        uint256 amount = 8 * 1e6; // $8 = Tier 1
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // Provider delivers, then client disputes
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "dispute-evidence");

        // Client creates dispute with evidence
        vm.prank(client);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("client-evidence"));

        // Provider also submits evidence
        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, keccak256("provider-evidence"));

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Both evidence = 50/50 split
        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);
        assertTrue(canResolve);
        assertEq(clientShare, 5000); // 50%

        uint256 clientBalBefore = usdc.balanceOf(client);
        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(client);
        disputeResolution.executeAutoResolution(disputeId);

        // Verify 50/50 split
        uint256 clientExpected = (amount * 5000) / 10000; // 50%
        uint256 providerExpected = amount - clientExpected;
        assertEq(usdc.balanceOf(client), clientBalBefore + clientExpected);
        assertEq(usdc.balanceOf(provider), providerBalBefore + providerExpected);
    }

    // ================================================================
    // Dispute Path (Tier 2): AI-assisted with arbiter voting
    // ================================================================

    function test_Integration_DisputePath_Tier2_ArbiterVoting() public {
        uint256 amount = 500 * 1e6; // $500 = Tier 2 (AI_ASSISTED)
        uint256 deadline = block.timestamp + 7 days;

        // Create, fund, deliver
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        // Client initiates dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "dispute-evidence");

        // Client creates dispute in resolution contract (pays fee)
        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        assertEq(fee, 15 * 1e6); // 3% of $500 = $15

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("client-evidence"));
        vm.stopPrank();

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.AI_ASSISTED));

        // Provider submits evidence
        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, keccak256("provider-evidence"));

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis (transitions to VOTING)
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("ai-analysis"), 6000); // suggest 60% client

        d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.VOTING));

        // Arbiters vote (majority for provider)
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, keccak256("just1"));
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, keccak256("just2"));
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, keccak256("just3"));

        // Warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Finalize ruling
        disputeResolution.finalizeRuling(disputeId);

        d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.APPEALABLE));
        assertEq(d.clientShare, 0); // Provider wins
        assertEq(d.providerShare, 10000);

        // Warp past appeal period (no appeal filed)
        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        // Execute settlement
        disputeResolution.executeSettlement(disputeId);

        // Verify dispute settled
        d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));

        // Verify escrow resolved: full amount to provider
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalBefore + amount);
    }

    // ================================================================
    // Dispute Path (Tier 2): split decision by arbiters
    // ================================================================

    function test_Integration_DisputePath_Tier2_SplitDecision() public {
        uint256 amount = 100 * 1e6; // $100 = Tier 2
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "dispute");

        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Warp past evidence period
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Oracle submits AI analysis
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 7000);

        // Arbiters vote for 70/30 split
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, keccak256("j1"));
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, keccak256("j2"));
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 7000, keccak256("j3"));

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.clientShare, 7000);
        assertEq(d.providerShare, 3000);

        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        uint256 clientBalBefore = usdc.balanceOf(client);
        uint256 providerBalBefore = usdc.balanceOf(provider);

        disputeResolution.executeSettlement(disputeId);

        // 70% to client, 30% to provider
        assertEq(usdc.balanceOf(client), clientBalBefore + 70 * 1e6);
        assertEq(usdc.balanceOf(provider), providerBalBefore + 30 * 1e6);
    }

    // ================================================================
    // Dispute Path with Appeal: ruling overturned on appeal
    // ================================================================

    function test_Integration_DisputePath_WithAppeal() public {
        uint256 amount = 100 * 1e6; // $100 = Tier 2
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // First round: Oracle + voting -> favor client
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

        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(d.clientShare, 10000); // Initial ruling: 100% client
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.APPEALABLE));

        // Provider appeals
        uint256 appealFee = disputeResolution.calculateFee(IDisputeResolution.Tier.COMMUNITY, amount);
        vm.startPrank(provider);
        usdc.approve(address(disputeResolution), appealFee);
        disputeResolution.appeal(disputeId);
        vm.stopPrank();

        d = disputeResolution.getDispute(disputeId);
        assertEq(d.appealRound, 1);
        assertEq(uint256(d.tier), uint256(IDisputeResolution.Tier.COMMUNITY));
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.VOTING));

        // Second round (COMMUNITY round 1): need quorum of ceil(2/3 * 11) = 8 votes
        // Get selected arbiters and have them all vote for provider
        address[] memory selectedArbiters = disputeResolution.getArbiters(disputeId);

        for (uint256 i = 0; i < selectedArbiters.length; i++) {
            vm.prank(selectedArbiters[i]);
            disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_PROVIDER, 0, "");
        }

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        d = disputeResolution.getDispute(disputeId);
        assertEq(d.providerShare, 10000); // Overturned: 100% provider
        assertEq(d.clientShare, 0);

        // No further appeal, execute settlement
        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        disputeResolution.executeSettlement(disputeId);

        d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalBefore + amount);
    }

    // ================================================================
    // Cross-contract: Trust score updated after multiple transactions
    // ================================================================

    function test_Integration_CrossContract_TrustScoreEvolution() public {
        uint256 amount = 100 * 1e6;

        // Verify initial trust score reflects only stake (no transactions)
        ITrustRegistry.TrustData memory trustBefore = trustRegistry.getTrustData(providerDid);
        assertEq(trustBefore.totalTransactions, 0);

        // Complete 3 successful transactions
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(client);
            uint256 eid = escrow.createEscrow(
                clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
            );
            vm.prank(client);
            escrow.fundEscrow(eid);
            vm.prank(provider);
            escrow.confirmDelivery(eid, keccak256(abi.encodePacked("output-", i)));
            vm.prank(client);
            escrow.releaseEscrow(eid);
        }

        // Verify trust data
        ITrustRegistry.TrustData memory trustAfter = trustRegistry.getTrustData(providerDid);
        assertEq(trustAfter.totalTransactions, 3);
        assertEq(trustAfter.successfulTransactions, 3);
        assertGt(trustAfter.reputationScore, 0);
        assertGt(trustAfter.totalVolumeUsd, 0);

        // Trust score should reflect reputation + stake
        uint256 trustScore = trustRegistry.getTrustScore(providerDid);
        assertGt(trustScore, 0);
    }

    // ================================================================
    // Cross-contract: Dispute outcome affects reputation
    // ================================================================

    function test_Integration_CrossContract_DisputeAffectsReputation() public {
        uint256 amount = 100 * 1e6;

        // First, do a successful transaction
        vm.prank(client);
        uint256 eid1 = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(eid1);
        vm.prank(provider);
        escrow.confirmDelivery(eid1, outputHash);
        vm.prank(client);
        escrow.releaseEscrow(eid1);

        ITrustRegistry.TrustData memory trustAfterSuccess = trustRegistry.getTrustData(providerDid);
        assertEq(trustAfterSuccess.successfulTransactions, 1);
        assertEq(trustAfterSuccess.totalTransactions, 1);

        // Now do a disputed transaction that resolves against provider (full refund)
        vm.prank(client);
        uint256 eid2 = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(eid2);
        vm.prank(provider);
        escrow.confirmDelivery(eid2, outputHash);

        vm.prank(client);
        escrow.initiateDispute(eid2, "bad-delivery");

        // Direct arbiter resolution: full refund to client
        vm.startPrank(admin);
        escrow.grantRole(escrow.ARBITER_ROLE(), admin);
        escrow.resolveDispute(eid2, false, 0);
        vm.stopPrank();

        // Provider should have 1 success, 2 total (1 failed from dispute)
        ITrustRegistry.TrustData memory trustAfterDispute = trustRegistry.getTrustData(providerDid);
        assertEq(trustAfterDispute.totalTransactions, 2);
        assertEq(trustAfterDispute.successfulTransactions, 1);
    }

    // ================================================================
    // Cross-contract: DisputeResolution can resolve escrow
    // ================================================================

    function test_Integration_CrossContract_DisputeResolutionResolvesEscrow() public {
        uint256 amount = 100 * 1e6;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // Client initiates dispute (from FUNDED state, before delivery)
        vm.prank(client);
        escrow.initiateDispute(escrowId, "provider-unresponsive");

        // Create dispute in resolution contract
        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // Go through full voting process
        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("analysis"), 10000);

        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.FAVOR_CLIENT, 0, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        // Verify DisputeResolution can call escrow.resolveDispute
        uint256 clientBalBefore = usdc.balanceOf(client);
        disputeResolution.executeSettlement(disputeId);

        // Verify funds went to client
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalBefore + amount);
    }

    // ================================================================
    // Multiple escrows: concurrent escrows for same parties
    // ================================================================

    function test_Integration_MultipleEscrows_ConcurrentLifecycles() public {
        uint256 amount1 = 100 * 1e6;
        uint256 amount2 = 200 * 1e6;
        uint256 deadline = block.timestamp + 7 days;

        // Create two escrows concurrently
        vm.prank(client);
        uint256 eid1 = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount1, taskHash, deadline, address(0)
        );
        vm.prank(client);
        uint256 eid2 = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount2, keccak256("task-2"), deadline, address(0)
        );

        assertEq(eid1 + 1, eid2); // Sequential IDs

        // Fund both
        vm.prank(client);
        escrow.fundEscrow(eid1);
        vm.prank(client);
        escrow.fundEscrow(eid2);

        // Deliver first, dispute second
        vm.prank(provider);
        escrow.confirmDelivery(eid1, outputHash);
        vm.prank(client);
        escrow.releaseEscrow(eid1);

        // Second escrow disputes
        vm.prank(client);
        escrow.initiateDispute(eid2, "dispute-evidence");

        // Verify independent states
        IAgoraMeshEscrow.Escrow memory e1 = escrow.getEscrow(eid1);
        IAgoraMeshEscrow.Escrow memory e2 = escrow.getEscrow(eid2);
        assertEq(uint256(e1.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(uint256(e2.state), uint256(IAgoraMeshEscrow.State.DISPUTED));
    }

    // ================================================================
    // Edge case: dispute from FUNDED state (before delivery)
    // ================================================================

    function test_Integration_DisputeBeforeDelivery() public {
        uint256 amount = 5 * 1e6; // Tier 1

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // Provider initiates dispute from FUNDED state (e.g., unclear task spec)
        vm.prank(provider);
        escrow.initiateDispute(escrowId, "unclear-task");

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DISPUTED));

        // Create and auto-resolve dispute (provider submitted evidence, client didn't)
        vm.prank(provider);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("provider-evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // Only provider evidence -> 100% to provider
        (bool canResolve, uint256 clientShare) = disputeResolution.checkAutoResolution(disputeId);
        assertTrue(canResolve);
        assertEq(clientShare, 0); // 0% to client = 100% to provider

        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        disputeResolution.executeAutoResolution(disputeId);

        IAgoraMeshEscrow.Escrow memory eAfter = escrow.getEscrow(escrowId);
        assertEq(uint256(eAfter.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalBefore + amount);
    }

    // ================================================================
    // Edge case: fee pool accumulation in dispute resolution
    // ================================================================

    function test_Integration_FeePoolAccumulation() public {
        uint256 amount = 500 * 1e6; // Tier 2

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);

        uint256 poolBefore = disputeResolution.feePool();
        assertEq(poolBefore, 0);

        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        uint256 poolAfter = disputeResolution.feePool();
        assertEq(poolAfter, fee);
        assertEq(poolAfter, 15 * 1e6); // 3% of $500
    }

    // ================================================================
    // Edge case: cannot double-dispute the same escrow
    // ================================================================

    function test_Integration_CannotDoubleDispute() public {
        uint256 amount = 5 * 1e6;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        vm.prank(client);
        disputeResolution.createDispute(escrowId, keccak256("evidence"));

        // Second dispute creation should fail
        vm.prank(client);
        vm.expectRevert(TieredDisputeResolution.DisputeAlreadyExists.selector);
        disputeResolution.createDispute(escrowId, keccak256("evidence-2"));
    }

    // ================================================================
    // Full lifecycle: create -> fund -> deliver -> dispute -> Tier2 resolve -> verify balances
    // ================================================================

    function test_Integration_FullLifecycle_EndToEnd() public {
        uint256 amount = 200 * 1e6; // $200 = Tier 2
        uint256 deadline = block.timestamp + 14 days;

        // Track initial balance
        uint256 clientInitBal = usdc.balanceOf(client);

        // === Phase 1: Escrow Setup ===
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        assertEq(usdc.balanceOf(client), clientInitBal - amount);

        // === Phase 2: Delivery ===
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        // === Phase 3: Dispute ===
        vm.prank(client);
        escrow.initiateDispute(escrowId, "quality-issue");

        uint256 fee = disputeResolution.calculateFee(IDisputeResolution.Tier.AI_ASSISTED, amount);
        vm.startPrank(client);
        usdc.approve(address(disputeResolution), fee);
        uint256 disputeId = disputeResolution.createDispute(escrowId, keccak256("evidence"));
        vm.stopPrank();

        // === Phase 4: Evidence Period ===
        vm.prank(provider);
        disputeResolution.submitEvidence(disputeId, keccak256("counter-evidence"));

        vm.warp(block.timestamp + EVIDENCE_PERIOD + 1);

        // === Phase 5: AI Analysis + Voting ===
        vm.prank(oracle);
        disputeResolution.submitAIAnalysis(disputeId, keccak256("ai-report"), 4000);

        // Arbiters vote for 40% client / 60% provider
        vm.prank(arbiter1);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 4000, "");
        vm.prank(arbiter2);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 4000, "");
        vm.prank(arbiter3);
        disputeResolution.castVote(disputeId, IDisputeResolution.Vote.SPLIT, 4000, "");

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        disputeResolution.finalizeRuling(disputeId);

        // === Phase 6: Appeal Period (no appeal) ===
        vm.warp(block.timestamp + APPEAL_PERIOD + 1);

        // === Phase 7: Settlement ===
        uint256 clientBalBeforeSettlement = usdc.balanceOf(client);
        uint256 providerBalBeforeSettlement = usdc.balanceOf(provider);

        disputeResolution.executeSettlement(disputeId);

        // Verify final distribution: 40% client, 60% provider
        uint256 clientPortion = (amount * 4000) / 10000; // $80
        uint256 providerPortion = amount - clientPortion; // $120

        assertEq(usdc.balanceOf(client), clientBalBeforeSettlement + clientPortion);
        assertEq(usdc.balanceOf(provider), providerBalBeforeSettlement + providerPortion);

        // Verify escrow state
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));

        // Verify dispute state
        IDisputeResolution.Dispute memory d = disputeResolution.getDispute(disputeId);
        assertEq(uint256(d.state), uint256(IDisputeResolution.DisputeState.SETTLED));

        // Verify escrow contract has no remaining balance from this escrow
        // (the escrow contract balance might have other escrows)
    }

    // ================================================================
    // Protocol Fee: end-to-end escrow with protocol fee + facilitator
    // ================================================================

    function test_endToEnd_escrowWithProtocolFee() public {
        uint256 amount = 1000 * 1e6; // $1000

        // 1. Configure protocol fee (0.5%) and treasury
        vm.startPrank(admin);
        escrow.setTreasury(treasury);
        escrow.setProtocolFeeBp(50); // 0.5%
        vm.stopPrank();

        // 2. Create escrow with facilitator
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, block.timestamp + 7 days, facilitator
        );

        // 3. Fund escrow
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // 4. Confirm delivery
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        // Record balances before release
        uint256 providerBalBefore = usdc.balanceOf(provider);
        uint256 facilitatorBalBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalBefore = usdc.balanceOf(treasury);

        // 5. Release escrow (expect ProtocolFeeCollected event)
        vm.expectEmit(true, false, true, true, address(escrow));
        // fee = 1000e6 * 50 / 10000 = 5_000_000
        // facilitatorShare = 5_000_000 * 7000 / 10000 = 3_500_000
        // treasuryShare = 5_000_000 - 3_500_000 = 1_500_000
        emit IAgoraMeshEscrow.ProtocolFeeCollected(escrowId, 5_000_000, facilitator, 3_500_000, 1_500_000);
        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // 6. Verify distributions
        uint256 expectedFee = 5_000_000; // 0.5% of $1000
        uint256 expectedFacilitator = 3_500_000; // 70% of fee
        uint256 expectedTreasury = 1_500_000; // 30% of fee
        uint256 expectedProvider = amount - expectedFee; // 995_000_000

        assertEq(usdc.balanceOf(provider), providerBalBefore + expectedProvider, "Provider gets 99.5%");
        assertEq(usdc.balanceOf(facilitator), facilitatorBalBefore + expectedFacilitator, "Facilitator gets 70% of fee");
        assertEq(usdc.balanceOf(treasury), treasuryBalBefore + expectedTreasury, "Treasury gets 30% of fee");

        // 7. Verify token conservation: all outflows = original deposit
        uint256 totalOut = expectedProvider + expectedFacilitator + expectedTreasury;
        assertEq(totalOut, amount, "No tokens lost or created");

        // 8. Escrow contract should have zero balance for this escrow
        assertEq(usdc.balanceOf(address(escrow)), 0, "Escrow drained");
    }

    // ================================================================
    // Protocol Fee: end-to-end streaming with protocol fee + facilitator
    // ================================================================

    function test_endToEnd_streamWithProtocolFee() public {
        uint256 depositAmount = 1000 * 1e6; // $1000 USDC
        uint256 duration = 1000; // 1000 seconds

        // 1. Configure protocol fee (0.5%) and treasury on streaming
        vm.startPrank(admin);
        streaming.setTreasury(treasury);
        streaming.setProtocolFeeBp(50); // 0.5%
        vm.stopPrank();

        // 2. Create stream with facilitator
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid,
            provider,
            address(usdc),
            depositAmount,
            duration,
            true, // cancelableBySender
            false, // cancelableByRecipient
            facilitator
        );

        // Verify stream created
        IStreamingPayments.Stream memory s = streaming.getStream(streamId);
        assertEq(s.depositAmount, depositAmount);
        assertEq(s.facilitator, facilitator);

        // 3. Warp forward 500 seconds (50% streamed)
        vm.warp(block.timestamp + 500);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);
        assertEq(withdrawable, 500 * 1e6, "50% should be withdrawable");

        // Record balances
        uint256 recipientBalBefore = usdc.balanceOf(provider);
        uint256 facilitatorBalBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalBefore = usdc.balanceOf(treasury);

        // 4. Withdraw available amount
        vm.prank(provider);
        streaming.withdraw(streamId, withdrawable);

        // 5. Verify fee splits
        // fee = 500_000_000 * 50 / 10000 = 2_500_000
        // facilitatorShare = 2_500_000 * 7000 / 10000 = 1_750_000
        // treasuryShare = 2_500_000 - 1_750_000 = 750_000
        // netToRecipient = 500_000_000 - 2_500_000 = 497_500_000
        uint256 expectedFee = 2_500_000;
        uint256 expectedFacilitator = 1_750_000;
        uint256 expectedTreasury = 750_000;
        uint256 expectedNet = withdrawable - expectedFee;

        assertEq(usdc.balanceOf(provider), recipientBalBefore + expectedNet, "Recipient gets amount minus 0.5% fee");
        assertEq(usdc.balanceOf(facilitator), facilitatorBalBefore + expectedFacilitator, "Facilitator gets 70% of fee");
        assertEq(usdc.balanceOf(treasury), treasuryBalBefore + expectedTreasury, "Treasury gets 30% of fee");

        // Verify token conservation for this withdrawal
        uint256 totalOut = expectedNet + expectedFacilitator + expectedTreasury;
        assertEq(totalOut, withdrawable, "Sum of outflows equals withdrawal amount");

        // Remaining balance in stream
        assertEq(streaming.withdrawableAmountOf(streamId), 0, "Nothing more to withdraw at this point");
    }

    // ================================================================
    // Protocol Fee: escrow dispute with protocol fee deducted from both shares
    // ================================================================

    function test_endToEnd_escrowDisputeWithProtocolFee() public {
        // Amount: $200, split 70% client / 30% provider
        // Fee: 0.5% (50 bp), facilitator gets 70% of fee, treasury gets 30%
        //
        // providerShare = 60_000_000, clientShare = 140_000_000
        // Fee on provider: 300_000 (facilitator: 210_000, treasury: 90_000), net: 59_700_000
        // Fee on client:   700_000 (facilitator: 490_000, treasury: 210_000), net: 139_300_000
        // Total facilitator: 700_000, total treasury: 300_000

        // 1. Configure protocol fee (0.5%) and treasury
        vm.startPrank(admin);
        escrow.setTreasury(treasury);
        escrow.setProtocolFeeBp(50);
        vm.stopPrank();

        // 2. Create and fund escrow with facilitator
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid,
            providerDid,
            provider,
            address(usdc),
            200_000_000,
            taskHash,
            block.timestamp + 7 days,
            facilitator
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // 3. Provider delivers, then client disputes
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "quality-dispute");

        // Record balances before resolution
        uint256[4] memory balsBefore =
            [usdc.balanceOf(client), usdc.balanceOf(provider), usdc.balanceOf(facilitator), usdc.balanceOf(treasury)];

        // 4. Resolve dispute: 30% to provider (60_000_000), 70% to client (140_000_000)
        vm.startPrank(admin);
        escrow.grantRole(escrow.ARBITER_ROLE(), admin);
        escrow.resolveDispute(escrowId, true, 60_000_000);
        vm.stopPrank();

        // 5. Verify fee deducted from both provider and client shares
        assertEq(usdc.balanceOf(provider), balsBefore[1] + 59_700_000, "Provider gets 30% minus fee");
        assertEq(usdc.balanceOf(client), balsBefore[0] + 139_300_000, "Client gets 70% minus fee");

        // 6. Verify facilitator and treasury received correct splits
        assertEq(usdc.balanceOf(facilitator), balsBefore[2] + 700_000, "Facilitator gets 70% of both fees");
        assertEq(usdc.balanceOf(treasury), balsBefore[3] + 300_000, "Treasury gets 30% of both fees");

        // 7. Token conservation: all outflows = original $200 deposit
        assertEq(
            uint256(59_700_000 + 139_300_000 + 700_000 + 300_000), uint256(200_000_000), "No tokens lost or created"
        );

        // 8. Escrow contract drained
        assertEq(usdc.balanceOf(address(escrow)), 0, "Escrow drained");
    }
}
