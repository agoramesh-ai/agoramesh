// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/TrustRegistry.sol";
import "../src/interfaces/IAgoraMeshEscrow.sol";
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

contract AgoraMeshEscrowTest is Test {
    AgoraMeshEscrow public escrow;
    TrustRegistry public registry;
    MockUSDC public usdc;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public arbiter = address(0x3);
    address public client = address(0x4);
    address public provider = address(0x5);

    bytes32 public clientDid = keccak256("did:agoramesh:client");
    bytes32 public providerDid = keccak256("did:agoramesh:provider");

    string public clientCID = "QmClientCapabilityCard123";
    string public providerCID = "QmProviderCapabilityCard456";

    bytes32 public taskHash = keccak256("task-specification-hash");
    bytes32 public outputHash = keccak256("task-output-hash");

    uint256 public constant MINIMUM_STAKE = 100 * 1e6; // 100 USDC
    uint256 public constant TASK_AMOUNT = 100 * 1e6; // 100 USDC
    uint256 public constant AUTO_RELEASE_DELAY = 24 hours;

    function setUp() public {
        // Deploy mock USDC
        usdc = new MockUSDC();

        // Deploy TrustRegistry
        vm.prank(admin);
        registry = new TrustRegistry(address(usdc), admin);

        // Deploy AgoraMeshEscrow
        vm.prank(admin);
        escrow = new AgoraMeshEscrow(address(registry), admin);

        // Grant roles on TrustRegistry
        vm.startPrank(admin);
        registry.grantRole(registry.ORACLE_ROLE(), oracle);
        registry.grantRole(registry.ARBITER_ROLE(), arbiter);
        // Grant ORACLE_ROLE to escrow contract so it can record transactions
        registry.grantRole(registry.ORACLE_ROLE(), address(escrow));
        vm.stopPrank();

        // Grant ARBITER_ROLE on escrow contract
        vm.startPrank(admin);
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
        vm.stopPrank();

        // Mint USDC to test users
        usdc.mint(client, 100_000 * 1e6);
        usdc.mint(provider, 100_000 * 1e6);

        // Register agents in TrustRegistry
        vm.prank(client);
        registry.registerAgent(clientDid, clientCID);

        vm.prank(provider);
        registry.registerAgent(providerDid, providerCID);

        // Stake minimum amount for both agents
        vm.prank(client);
        usdc.approve(address(registry), type(uint256).max);
        vm.prank(client);
        registry.depositStake(clientDid, MINIMUM_STAKE);

        vm.prank(provider);
        usdc.approve(address(registry), type(uint256).max);
        vm.prank(provider);
        registry.depositStake(providerDid, MINIMUM_STAKE);

        // Add USDC to allowed tokens
        vm.prank(admin);
        escrow.addAllowedToken(address(usdc));

        // Approve escrow contract to spend client's USDC
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ============ Helper Functions ============

    function _createAndFundEscrow() internal returns (uint256 escrowId) {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        escrowId = escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        vm.prank(client);
        escrow.fundEscrow(escrowId);
    }

    function _createFundAndDeliverEscrow() internal returns (uint256 escrowId) {
        escrowId = _createAndFundEscrow();

        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsRegistry() public {
        assertEq(address(escrow.trustRegistry()), address(registry));
    }

    function test_Constructor_RevertIfZeroRegistry() public {
        vm.expectRevert(AgoraMeshEscrow.InvalidTrustRegistry.selector);
        new AgoraMeshEscrow(address(0), admin);
    }

    function test_Constructor_RevertIfZeroAdmin() public {
        vm.expectRevert(AgoraMeshEscrow.InvalidAdmin.selector);
        new AgoraMeshEscrow(address(registry), address(0));
    }

    // ============ CreateEscrow Tests ============

    function test_CreateEscrow() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectEmit(true, true, true, true);
        emit IAgoraMeshEscrow.EscrowCreated(1, clientDid, providerDid, TASK_AMOUNT, deadline);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        assertEq(escrowId, 1);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.id, 1);
        assertEq(e.clientDid, clientDid);
        assertEq(e.providerDid, providerDid);
        assertEq(e.clientAddress, client);
        assertEq(e.providerAddress, provider);
        assertEq(e.amount, TASK_AMOUNT);
        assertEq(e.token, address(usdc));
        assertEq(e.taskHash, taskHash);
        assertEq(e.outputHash, bytes32(0));
        assertEq(e.deadline, deadline);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.AWAITING_DEPOSIT));
        assertEq(e.createdAt, block.timestamp);
        assertEq(e.deliveredAt, 0);
    }

    function test_CreateEscrow_IncrementingIds() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.startPrank(client);
        uint256 id1 =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
        uint256 id2 =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
        uint256 id3 =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    function test_CreateEscrow_RevertIfClientNotActive() public {
        // Deactivate client agent
        vm.prank(client);
        registry.deactivateAgent(clientDid);

        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.AgentNotActive.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_RevertIfProviderNotActive() public {
        // Deactivate provider agent
        vm.prank(provider);
        registry.deactivateAgent(providerDid);

        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.AgentNotActive.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_RevertIfZeroAmount() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidAmount.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(usdc), 0, taskHash, deadline);
    }

    function test_CreateEscrow_RevertIfDeadlineInPast() public {
        uint256 deadline = block.timestamp - 1;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidDeadline.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_RevertIfZeroProviderAddress() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidProviderAddress.selector);
        escrow.createEscrow(clientDid, providerDid, address(0), address(usdc), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_RevertIfZeroToken() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidToken.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(0), TASK_AMOUNT, taskHash, deadline);
    }

    // ============ FundEscrow Tests ============

    function test_FundEscrow() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(client);
        vm.expectEmit(true, false, false, false);
        emit IAgoraMeshEscrow.EscrowFunded(escrowId);
        escrow.fundEscrow(escrowId);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.FUNDED));
        assertEq(usdc.balanceOf(client), clientBalanceBefore - TASK_AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), TASK_AMOUNT);
    }

    function test_FundEscrow_RevertIfNotClient() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        vm.prank(provider);
        vm.expectRevert(AgoraMeshEscrow.NotClient.selector);
        escrow.fundEscrow(escrowId);
    }

    function test_FundEscrow_RevertIfAlreadyFunded() public {
        uint256 escrowId = _createAndFundEscrow();

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.fundEscrow(escrowId);
    }

    function test_FundEscrow_RevertIfEscrowNotFound() public {
        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.EscrowNotFound.selector);
        escrow.fundEscrow(999);
    }

    // ============ ConfirmDelivery Tests ============

    function test_ConfirmDelivery() public {
        uint256 escrowId = _createAndFundEscrow();

        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.TaskDelivered(escrowId, outputHash);
        escrow.confirmDelivery(escrowId, outputHash);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DELIVERED));
        assertEq(e.outputHash, outputHash);
        assertEq(e.deliveredAt, block.timestamp);
    }

    function test_ConfirmDelivery_RevertIfNotProvider() public {
        uint256 escrowId = _createAndFundEscrow();

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.NotProvider.selector);
        escrow.confirmDelivery(escrowId, outputHash);
    }

    function test_ConfirmDelivery_RevertIfNotFunded() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        vm.prank(provider);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.confirmDelivery(escrowId, outputHash);
    }

    // ============ ReleaseEscrow Tests ============

    function test_ReleaseEscrow_ByClient() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(client);
        vm.expectEmit(true, false, false, false);
        emit IAgoraMeshEscrow.EscrowReleased(escrowId);
        escrow.releaseEscrow(escrowId);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + TASK_AMOUNT);
    }

    function test_ReleaseEscrow_ByProviderAfterDelay() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        // Warp past auto-release delay
        vm.warp(block.timestamp + AUTO_RELEASE_DELAY + 1);

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        escrow.releaseEscrow(escrowId);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + TASK_AMOUNT);
    }

    function test_ReleaseEscrow_RevertIfProviderReleasesTooEarly() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        vm.prank(provider);
        vm.expectRevert(AgoraMeshEscrow.AutoReleaseNotReady.selector);
        escrow.releaseEscrow(escrowId);
    }

    function test_ReleaseEscrow_RevertIfNotDelivered() public {
        uint256 escrowId = _createAndFundEscrow();

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.releaseEscrow(escrowId);
    }

    function test_ReleaseEscrow_RevertIfUnauthorized() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        address randomUser = address(0x999);
        vm.prank(randomUser);
        vm.expectRevert(AgoraMeshEscrow.NotAuthorized.selector);
        escrow.releaseEscrow(escrowId);
    }

    // ============ FundAndRelease (Happy Path) Tests ============

    function test_FundAndRelease_HappyPath() public {
        uint256 deadline = block.timestamp + 1 days;

        // Record initial balances
        uint256 clientBalanceStart = usdc.balanceOf(client);
        uint256 providerBalanceStart = usdc.balanceOf(provider);

        // 1. Client creates escrow
        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        // Verify AWAITING_DEPOSIT state
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.AWAITING_DEPOSIT));

        // 2. Client funds escrow
        vm.prank(client);
        escrow.fundEscrow(escrowId);

        // Verify FUNDED state and token transfer
        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.FUNDED));
        assertEq(usdc.balanceOf(client), clientBalanceStart - TASK_AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), TASK_AMOUNT);

        // 3. Provider delivers task
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        // Verify DELIVERED state
        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DELIVERED));
        assertEq(e.outputHash, outputHash);

        // 4. Client releases payment
        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Verify RELEASED state and final balances
        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalanceStart + TASK_AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // Verify transaction was recorded in TrustRegistry
        ITrustRegistry.TrustData memory providerTrust = registry.getTrustData(providerDid);
        assertEq(providerTrust.totalTransactions, 1);
        assertEq(providerTrust.successfulTransactions, 1);
    }

    // ============ ClaimTimeout Tests ============

    function test_ClaimTimeout() public {
        uint256 escrowId = _createAndFundEscrow();

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        // Warp past deadline
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        vm.warp(e.deadline + 1);

        vm.prank(client);
        vm.expectEmit(true, false, false, false);
        emit IAgoraMeshEscrow.EscrowRefunded(escrowId);
        escrow.claimTimeout(escrowId);

        e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalanceBefore + TASK_AMOUNT);
    }

    function test_ClaimTimeout_RevertIfDeadlineNotPassed() public {
        uint256 escrowId = _createAndFundEscrow();

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.DeadlineNotPassed.selector);
        escrow.claimTimeout(escrowId);
    }

    function test_ClaimTimeout_RevertIfNotClient() public {
        uint256 escrowId = _createAndFundEscrow();

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        vm.warp(e.deadline + 1);

        vm.prank(provider);
        vm.expectRevert(AgoraMeshEscrow.NotClient.selector);
        escrow.claimTimeout(escrowId);
    }

    function test_ClaimTimeout_RevertIfNotFunded() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        vm.warp(deadline + 1);

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.claimTimeout(escrowId);
    }

    function test_ClaimTimeout_RevertIfAlreadyDelivered() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        vm.warp(e.deadline + 1);

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.claimTimeout(escrowId);
    }

    // ============ Dispute Tests ============

    function test_InitiateDispute_ByClient() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        bytes memory evidence = "ipfs://QmEvidence123";

        vm.prank(client);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.DisputeInitiated(escrowId, client);
        escrow.initiateDispute(escrowId, evidence);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DISPUTED));
    }

    function test_InitiateDispute_ByProvider() public {
        uint256 escrowId = _createAndFundEscrow();

        bytes memory evidence = "ipfs://QmEvidence456";

        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.DisputeInitiated(escrowId, provider);
        escrow.initiateDispute(escrowId, evidence);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.DISPUTED));
    }

    function test_InitiateDispute_RevertIfNotParty() public {
        uint256 escrowId = _createAndFundEscrow();

        address randomUser = address(0x999);
        vm.prank(randomUser);
        vm.expectRevert(AgoraMeshEscrow.NotParty.selector);
        escrow.initiateDispute(escrowId, "evidence");
    }

    function test_InitiateDispute_RevertIfNotFundedOrDelivered() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.initiateDispute(escrowId, "evidence");
    }

    // ============ DisputeResolution Tests ============

    function test_ResolveDispute_FullToProvider() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        // Arbiter resolves fully in favor of provider
        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.DisputeResolved(escrowId, true, TASK_AMOUNT);
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + TASK_AMOUNT);
    }

    function test_ResolveDispute_FullToClient() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        // Arbiter resolves fully in favor of client
        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.DisputeResolved(escrowId, false, 0);
        escrow.resolveDispute(escrowId, false, 0);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.REFUNDED));
        assertEq(usdc.balanceOf(client), clientBalanceBefore + TASK_AMOUNT);
    }

    function test_ResolveDispute_SplitFunds() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        uint256 providerShare = 60 * 1e6; // 60 USDC to provider
        uint256 clientShare = TASK_AMOUNT - providerShare; // 40 USDC to client

        // Arbiter splits funds
        vm.prank(arbiter);
        vm.expectEmit(true, false, false, true);
        emit IAgoraMeshEscrow.DisputeResolved(escrowId, true, providerShare);
        escrow.resolveDispute(escrowId, true, providerShare);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.RELEASED));
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + providerShare);
        assertEq(usdc.balanceOf(client), clientBalanceBefore + clientShare);
    }

    function test_ResolveDispute_RevertIfNotArbiter() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        vm.prank(client);
        vm.expectRevert();
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT);
    }

    function test_ResolveDispute_RevertIfNotDisputed() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        vm.prank(arbiter);
        vm.expectRevert(AgoraMeshEscrow.InvalidState.selector);
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT);
    }

    function test_ResolveDispute_RevertIfProviderShareExceedsAmount() public {
        uint256 escrowId = _createFundAndDeliverEscrow();

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        vm.prank(arbiter);
        vm.expectRevert(AgoraMeshEscrow.InvalidProviderShare.selector);
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT + 1);
    }

    // ============ Access Control Tests ============

    function test_AdminCanGrantArbiterRole() public {
        address newArbiter = address(0x100);
        bytes32 arbiterRole = escrow.ARBITER_ROLE();

        vm.prank(admin);
        escrow.grantRole(arbiterRole, newArbiter);

        assertTrue(escrow.hasRole(arbiterRole, newArbiter));
    }

    function test_NonAdminCannotGrantRoles() public {
        address newArbiter = address(0x100);
        bytes32 arbiterRole = escrow.ARBITER_ROLE();

        vm.prank(client);
        vm.expectRevert();
        escrow.grantRole(arbiterRole, newArbiter);
    }

    // ============ GetEscrow Tests ============

    function test_GetEscrow_ReturnsCorrectData() public {
        uint256 deadline = block.timestamp + 1 days;
        uint256 creationTime = block.timestamp;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);

        assertEq(e.id, escrowId);
        assertEq(e.clientDid, clientDid);
        assertEq(e.providerDid, providerDid);
        assertEq(e.clientAddress, client);
        assertEq(e.providerAddress, provider);
        assertEq(e.amount, TASK_AMOUNT);
        assertEq(e.token, address(usdc));
        assertEq(e.taskHash, taskHash);
        assertEq(e.deadline, deadline);
        assertEq(e.createdAt, creationTime);
    }

    // ============ Fuzz Tests ============

    function testFuzz_CreateEscrow(uint256 amount, uint256 deadlineOffset) public {
        vm.assume(amount > 0 && amount <= 100_000 * 1e6);
        vm.assume(deadlineOffset > 0 && deadlineOffset <= 90 days);

        uint256 deadline = block.timestamp + deadlineOffset;

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline);

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.amount, amount);
        assertEq(e.deadline, deadline);
    }

    function testFuzz_ResolveDispute_SplitFunds(uint256 providerShare) public {
        uint256 escrowId = _createFundAndDeliverEscrow();
        vm.assume(providerShare <= TASK_AMOUNT);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, providerShare);

        assertEq(usdc.balanceOf(provider), providerBalanceBefore + providerShare);
        assertEq(usdc.balanceOf(client), clientBalanceBefore + (TASK_AMOUNT - providerShare));
    }

    // ============ Token Whitelist Tests (C-5) ============

    function test_AddAllowedToken() public {
        address newToken = address(0xBEEF);

        vm.prank(admin);
        escrow.addAllowedToken(newToken);

        assertTrue(escrow.isTokenAllowed(newToken));
    }

    function test_RemoveAllowedToken() public {
        vm.startPrank(admin);
        escrow.addAllowedToken(address(usdc));
        escrow.removeAllowedToken(address(usdc));
        vm.stopPrank();

        assertFalse(escrow.isTokenAllowed(address(usdc)));
    }

    function test_AddAllowedToken_RevertsIfNotAdmin() public {
        vm.prank(client);
        vm.expectRevert();
        escrow.addAllowedToken(address(0xBEEF));
    }

    function test_CreateEscrow_RevertsIfTokenNotAllowed() public {
        // Deploy a non-whitelisted token
        MockUSDC otherToken = new MockUSDC();

        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.TokenNotAllowed.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(otherToken), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_SucceedsWithAllowedToken() public {
        // USDC should be allowed (added in setUp or via addAllowedToken)
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
        assertGt(escrowId, 0);
    }

    // ============ Max Deadline Tests (M-4) ============

    function test_CreateEscrow_RevertsIfDeadlineTooFar() public {
        uint256 deadline = block.timestamp + 91 days; // > 90 day max

        vm.prank(client);
        vm.expectRevert(AgoraMeshEscrow.DeadlineTooFar.selector);
        escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
    }

    function test_CreateEscrow_SucceedsAtMaxDeadline() public {
        uint256 deadline = block.timestamp + 90 days; // exactly at max

        vm.prank(client);
        uint256 escrowId =
            escrow.createEscrow(clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline);
        assertGt(escrowId, 0);
    }
}
