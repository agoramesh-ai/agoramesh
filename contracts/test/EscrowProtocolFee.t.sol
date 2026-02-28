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

    function test_resolveDispute_splitScenario_feeOnBothShares() public {
        uint256 escrowId = _createFundAndDeliverEscrow(facilitator);

        vm.prank(client);
        escrow.initiateDispute(escrowId, "evidence");

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);
        uint256 treasuryBalanceBefore = usdc.balanceOf(treasury);
        uint256 facilitatorBalanceBefore = usdc.balanceOf(facilitator);

        // 60/40 split: provider gets 60%, client gets 40%
        uint256 providerShare = 6_000 * 1e6; // $6,000
        uint256 clientShare = 4_000 * 1e6; // $4,000

        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, providerShare);

        // Fee on provider share: 6_000e6 * 50 / 10_000 = 30e6
        uint256 providerFee = 30 * 1e6;
        // Fee on client share: 4_000e6 * 50 / 10_000 = 20e6
        uint256 clientFee = 20 * 1e6;

        assertEq(usdc.balanceOf(provider), providerBalanceBefore + providerShare - providerFee);
        assertEq(usdc.balanceOf(client), clientBalanceBefore + clientShare - clientFee);

        // Total fees collected
        uint256 totalFees = providerFee + clientFee; // $50
        uint256 facilitatorTotal = (providerFee * 7_000) / 10_000 + (clientFee * 7_000) / 10_000;
        uint256 treasuryTotal = totalFees - facilitatorTotal;

        assertEq(usdc.balanceOf(facilitator), facilitatorBalanceBefore + facilitatorTotal);
        assertEq(usdc.balanceOf(treasury), treasuryBalanceBefore + treasuryTotal);
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
