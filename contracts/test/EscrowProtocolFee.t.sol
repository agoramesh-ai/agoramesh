// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/TrustRegistry.sol";
import "../src/interfaces/IAgoraMeshEscrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC token for protocol fee testing
contract FeeTestMockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title Protocol Fee Tests for AgoraMeshEscrow
/// @notice TDD tests for protocol fee collection, splitting, and edge cases
contract EscrowProtocolFeeTest is Test {
    AgoraMeshEscrow public escrow;
    TrustRegistry public registry;
    FeeTestMockUSDC public usdc;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public arbiter = address(0x3);
    address public client = address(0x4);
    address public provider = address(0x5);
    address public facilitator = address(0x6);
    address public treasury = address(0x7);

    bytes32 public clientDid = keccak256("did:agoramesh:client");
    bytes32 public providerDid = keccak256("did:agoramesh:provider");

    string public clientCID = "QmClientCapabilityCard123";
    string public providerCID = "QmProviderCapabilityCard456";

    bytes32 public taskHash = keccak256("task-specification-hash");
    bytes32 public outputHash = keccak256("task-output-hash");

    uint256 public constant MINIMUM_STAKE = 100 * 1e6; // 100 USDC
    uint256 public constant TASK_AMOUNT = 10_000 * 1e6; // $10,000 USDC

    function setUp() public {
        // Deploy mock USDC
        usdc = new FeeTestMockUSDC();

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
        registry.grantRole(registry.ORACLE_ROLE(), address(escrow));
        vm.stopPrank();

        // Grant ARBITER_ROLE on escrow contract
        vm.startPrank(admin);
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
        vm.stopPrank();

        // Mint USDC to test users
        usdc.mint(client, 1_000_000 * 1e6);
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

        // Set treasury and protocol fee
        vm.startPrank(admin);
        escrow.setTreasury(treasury);
        escrow.setProtocolFeeBp(50); // 0.5%
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    function _createAndFundEscrow(address _facilitator) internal returns (uint256 escrowId) {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline, _facilitator
        );

        vm.prank(client);
        escrow.fundEscrow(escrowId);
    }

    function _createFundAndDeliverEscrow(address _facilitator) internal returns (uint256 escrowId) {
        escrowId = _createAndFundEscrow(_facilitator);

        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
    }

    // ============ setTreasury Tests ============

    function test_setTreasury_setsAddress() public {
        address newTreasury = address(0x99);
        vm.prank(admin);
        escrow.setTreasury(newTreasury);
        assertEq(escrow.treasury(), newTreasury);
    }

    function test_setTreasury_onlyAdmin() public {
        vm.prank(client);
        vm.expectRevert();
        escrow.setTreasury(address(0x99));
    }

    function test_setTreasury_revertIfZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(AgoraMeshEscrow.InvalidTreasury.selector);
        escrow.setTreasury(address(0));
    }

    // ============ setProtocolFeeBp Tests ============

    function test_setProtocolFeeBp_setsValue() public {
        vm.prank(admin);
        escrow.setProtocolFeeBp(100);
        assertEq(escrow.protocolFeeBp(), 100);
    }

    function test_setProtocolFeeBp_onlyAdmin() public {
        vm.prank(client);
        vm.expectRevert();
        escrow.setProtocolFeeBp(100);
    }

    function test_setProtocolFeeBp_revertIfExceedsMax() public {
        vm.prank(admin);
        vm.expectRevert(AgoraMeshEscrow.FeeTooHigh.selector);
        escrow.setProtocolFeeBp(501);
    }

    // ============ createEscrow Facilitator Tests ============

    function test_createEscrow_storesFacilitator() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline, facilitator
        );

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.facilitator, facilitator);
    }

    function test_createEscrow_zeroFacilitatorAllowed() public {
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), TASK_AMOUNT, taskHash, deadline, address(0)
        );

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.facilitator, address(0));
    }

    // ============ releaseEscrow Fee Tests ============

    function test_releaseEscrow_deductsProtocolFee() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Fee = 10_000 * 1e6 * 50 / 10_000 = 50 * 1e6 ($50)
        // Provider gets TASK_AMOUNT - fee = 10_000e6 - 50e6 = 9_950e6
        uint256 expectedFee = 50 * 1e6;
        uint256 expectedNet = TASK_AMOUNT - expectedFee;
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + expectedNet);
    }

    function test_releaseEscrow_splitsFee_70_30() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        uint256 facilitatorBalanceBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Fee = $50 (50 * 1e6)
        // Facilitator: 70% = 35 * 1e6
        // Treasury: 30% = 15 * 1e6
        uint256 totalFee = 50 * 1e6;
        uint256 facilitatorShare = (totalFee * 7_000) / 10_000; // 35e6
        uint256 treasuryShareExpected = totalFee - facilitatorShare; // 15e6

        assertEq(usdc.balanceOf(facilitator), facilitatorBalanceBefore + facilitatorShare);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + treasuryShareExpected);
    }

    function test_releaseEscrow_noFacilitator_allToTreasury() public {
        uint256 escrowId = _createFundAndDeliverEscrow(address(0));

        uint256 facilitatorBalanceBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Fee = $50, all to treasury (no facilitator)
        uint256 totalFee = 50 * 1e6;
        assertEq(usdc.balanceOf(facilitator), facilitatorBalanceBefore); // unchanged
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + totalFee);
    }

    function test_releaseEscrow_zeroFee_fullAmountToProvider() public {
        // Set fee to 0
        vm.prank(admin);
        escrow.setProtocolFeeBp(0);

        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        uint256 providerBalanceBefore = usdc.balanceOf(provider);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Full amount to provider, no fee
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + TASK_AMOUNT);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore); // unchanged
    }

    function test_releaseEscrow_emitsProtocolFeeCollected() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        uint256 totalFee = 50 * 1e6;
        uint256 facilitatorShare = (totalFee * 7_000) / 10_000;
        uint256 treasuryShareExpected = totalFee - facilitatorShare;

        vm.prank(client);
        vm.expectEmit(true, true, false, true);
        emit IAgoraMeshEscrow.ProtocolFeeCollected(
            escrowId, totalFee, facilitator, facilitatorShare, treasuryShareExpected
        );
        escrow.releaseEscrow(escrowId);
    }

    function test_releaseEscrow_minimumFee() public {
        // Create a small escrow where computed fee < MIN_FEE
        // Amount = $1 (1e6), fee at 0.5% = 5000 < MIN_FEE (10_000)
        uint256 smallAmount = 1 * 1e6; // $1
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), smallAmount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        uint256 providerBalanceBefore = usdc.balanceOf(provider);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Computed fee = 1e6 * 50 / 10_000 = 5000, below MIN_FEE (10_000)
        // MIN_FEE applied: 10_000
        // But safety cap: fee cannot exceed amount / 2 = 500_000
        // So fee = 10_000 (MIN_FEE)
        uint256 expectedFee = 10_000;
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + smallAmount - expectedFee);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + expectedFee);
    }

    // ============ resolveDispute Fee Tests ============

    function test_resolveDispute_deductsFeeFromProviderShare() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        // Arbiter resolves: 100% to provider
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT);

        // Fee = $50 on TASK_AMOUNT
        uint256 expectedFee = 50 * 1e6;
        assertEq(usdc.balanceOf(provider), providerBalanceBefore + TASK_AMOUNT - expectedFee);
    }

    function test_resolveDispute_splitScenario_singleFeeOnFullAmount() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);
        uint256 facilitatorBalanceBefore = usdc.balanceOf(facilitator);

        // 50/50 split: provider gets 50%, client gets 50%
        uint256 providerShare = 5_000 * 1e6; // $5,000

        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, providerShare);

        // Fee calculated ONCE on full amount: 10_000e6 * 50 / 10_000 = 50e6
        uint256 totalFee = 50 * 1e6;
        uint256 netAmount = TASK_AMOUNT - totalFee; // 9_950e6

        // Net amount distributed proportionally
        // Provider net: netAmount * providerShare / TASK_AMOUNT = 9_950e6 * 5_000e6 / 10_000e6 = 4_975e6
        uint256 expectedProviderNet = (netAmount * providerShare) / TASK_AMOUNT;
        // Client net: netAmount - expectedProviderNet
        uint256 expectedClientNet = netAmount - expectedProviderNet;

        assertEq(usdc.balanceOf(provider), providerBalanceBefore + expectedProviderNet);
        assertEq(usdc.balanceOf(client), clientBalanceBefore + expectedClientNet);

        // Total fee: $50 (single fee, not double)
        uint256 facilitatorFeeShare = (totalFee * 7_000) / 10_000;
        uint256 treasuryFeeShare = totalFee - facilitatorFeeShare;

        assertEq(usdc.balanceOf(facilitator), facilitatorBalanceBefore + facilitatorFeeShare);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + treasuryFeeShare);
    }

    function test_resolveDispute_50_50_split_feeSameAsFullRelease() public {
        // This test verifies the total fee is the same whether:
        // 1. Full amount released to provider
        // 2. 50/50 split between client and provider
        // Both should result in the same total fee (no double-charging)

        // Scenario 1: Full release
        uint256 escrowId1 = _createFundAndDeliverEscrow(address(0));
        vm.prank(client);
        escrow.initiateDispute(escrowId1, "evidence");

        uint256 treasury1Before = usdc.balanceOf(treasury);
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId1, true, TASK_AMOUNT);
        uint256 feeForFullRelease = usdc.balanceOf(treasury) - treasury1Before;

        // Scenario 2: 50/50 split
        uint256 escrowId2 = _createFundAndDeliverEscrow(address(0));
        vm.prank(client);
        escrow.initiateDispute(escrowId2, "evidence");

        uint256 treasury2Before = usdc.balanceOf(treasury);
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId2, true, TASK_AMOUNT / 2);
        uint256 feeForSplit = usdc.balanceOf(treasury) - treasury2Before;

        // Total fee should be the same regardless of split
        assertEq(feeForFullRelease, feeForSplit, "Fee should be same for full release and 50/50 split");
    }

    function test_resolveDispute_smallSplit_noDoubleMinFee() public {
        // Critical test: With small amounts, MIN_FEE gets applied to EACH share
        // separately, resulting in double the minimum fee.
        // Example: $1 escrow, 50/50 split -> each share is $0.50 -> each triggers MIN_FEE ($0.01)
        // Old behavior: 2x MIN_FEE = $0.02 total fee
        // Correct: 1x MIN_FEE = $0.01 total fee (fee calculated on full $1 once)

        uint256 smallAmount = 1 * 1e6; // $1
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), smallAmount, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 clientBefore = usdc.balanceOf(client);
        uint256 providerBefore = usdc.balanceOf(provider);

        // 50/50 split
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, smallAmount / 2);

        uint256 totalFeeCharged = usdc.balanceOf(treasury) - treasuryBefore;
        uint256 clientReceived = usdc.balanceOf(client) - clientBefore;
        uint256 providerReceived = usdc.balanceOf(provider) - providerBefore;

        // Fee should be calculated once on full $1: max(1e6 * 50 / 10000, MIN_FEE) = max(5000, 10000) = 10000
        // But safety cap: min(10000, 1e6/2) = min(10000, 500000) = 10000
        uint256 expectedFee = 10_000; // MIN_FEE applied once

        assertEq(totalFeeCharged, expectedFee, "Fee should be charged once, not doubled");
        assertEq(
            clientReceived + providerReceived + totalFeeCharged,
            smallAmount,
            "All funds must be accounted for"
        );
    }

    // ============ Fuzz Tests ============

    function testFuzz_releaseEscrow_feeNeverExceedsAmount(uint256 amount) public {
        // Bound amount to reasonable range (min $0.02 to ensure non-zero after fee, max $100K)
        amount = bound(amount, 20_000, 100_000 * 1e6);

        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), amount, taskHash, deadline, facilitator
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Provider should always receive something (fee capped at 50% of amount)
        uint256 providerReceived = usdc.balanceOf(provider) - providerBalanceBefore;
        assertGt(providerReceived, 0);
        assertLe(providerReceived, amount);
    }

    function testFuzz_setProtocolFeeBp_withinRange(uint256 feeBp) public {
        if (feeBp > 500) {
            vm.prank(admin);
            vm.expectRevert(AgoraMeshEscrow.FeeTooHigh.selector);
            escrow.setProtocolFeeBp(feeBp);
        } else {
            vm.prank(admin);
            escrow.setProtocolFeeBp(feeBp);
            assertEq(escrow.protocolFeeBp(), feeBp);
        }
    }
}
