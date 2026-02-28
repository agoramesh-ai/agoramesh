// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/StreamingPayments.sol";
import "../src/TrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing (6 decimals like USDC)
contract FeeTestMockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @title StreamingProtocolFee Tests
/// @notice TDD tests for protocol fee logic in StreamingPayments
contract StreamingProtocolFeeTest is Test {
    StreamingPayments public streaming;
    TrustRegistry public registry;
    FeeTestMockUSDC public usdc;

    address public admin = address(0x1);
    address public client = address(0x4);
    address public provider = address(0x5);
    address public facilitator = address(0x6);
    address public treasury = address(0x7);

    bytes32 public clientDid;
    bytes32 public providerDid;

    uint256 public constant DEPOSIT_AMOUNT = 1000 * 1e6; // 1000 USDC
    uint256 public constant STREAM_DURATION = 30 days;

    function setUp() public {
        // Deploy contracts
        usdc = new FeeTestMockUSDC();
        registry = new TrustRegistry(address(usdc), admin);
        streaming = new StreamingPayments(admin, address(registry));

        // Setup DIDs
        clientDid = keccak256(abi.encodePacked("did:agoramesh:base:", client));
        providerDid = keccak256(abi.encodePacked("did:agoramesh:base:", provider));

        // Register agents
        vm.prank(client);
        registry.registerAgent(clientDid, "QmClientCid");

        vm.prank(provider);
        registry.registerAgent(providerDid, "QmProviderCid");

        // Fund client
        usdc.mint(client, DEPOSIT_AMOUNT * 10);

        // Approve streaming contract
        vm.prank(client);
        usdc.approve(address(streaming), type(uint256).max);

        // Set treasury and protocolFeeBp=50 (0.5%)
        vm.startPrank(admin);
        streaming.setTreasury(treasury);
        streaming.setProtocolFeeBp(50);
        vm.stopPrank();
    }

    // ============ Admin Function Tests ============

    function test_setTreasury_setsAddress() public {
        address newTreasury = address(0x99);
        vm.prank(admin);
        streaming.setTreasury(newTreasury);
        assertEq(streaming.treasury(), newTreasury, "Treasury should be updated");
    }

    function test_setProtocolFeeBp_setsValue() public {
        vm.prank(admin);
        streaming.setProtocolFeeBp(100); // 1%
        assertEq(streaming.protocolFeeBp(), 100, "Protocol fee should be updated");
    }

    // ============ Facilitator Storage Test ============

    function test_createStream_storesFacilitator() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(stream.facilitator, facilitator, "Facilitator should be stored in struct");
    }

    // ============ Withdraw Fee Tests ============

    function test_withdraw_deductsProtocolFee() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        // Warp past end time so full amount is available
        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        streaming.withdraw(streamId, DEPOSIT_AMOUNT);

        uint256 providerBalAfter = usdc.balanceOf(provider);
        uint256 received = providerBalAfter - providerBalBefore;

        // Fee = 1000 USDC * 50 / 10000 = 5 USDC = 5_000_000
        uint256 expectedFee = (DEPOSIT_AMOUNT * 50) / 10_000;
        uint256 expectedNet = DEPOSIT_AMOUNT - expectedFee;

        assertEq(received, expectedNet, "Recipient should get amount minus 0.5% fee");
    }

    function test_withdraw_splitsFee_70_30() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 facilitatorBalBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalBefore = usdc.balanceOf(treasury);

        vm.prank(provider);
        streaming.withdraw(streamId, DEPOSIT_AMOUNT);

        uint256 totalFee = (DEPOSIT_AMOUNT * 50) / 10_000; // 5 USDC
        uint256 expectedFacilitatorShare = (totalFee * 7_000) / 10_000; // 70% = 3.5 USDC
        uint256 expectedTreasuryShare = totalFee - expectedFacilitatorShare; // 30% = 1.5 USDC

        assertEq(
            usdc.balanceOf(facilitator) - facilitatorBalBefore,
            expectedFacilitatorShare,
            "Facilitator should get 70% of fee"
        );
        assertEq(
            usdc.balanceOf(treasury) - treasuryBalBefore,
            expectedTreasuryShare,
            "Treasury should get 30% of fee"
        );
    }

    function test_withdrawMax_deductsProtocolFee() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        streaming.withdrawMax(streamId);

        uint256 providerBalAfter = usdc.balanceOf(provider);
        uint256 received = providerBalAfter - providerBalBefore;

        uint256 expectedFee = (DEPOSIT_AMOUNT * 50) / 10_000;
        uint256 expectedNet = DEPOSIT_AMOUNT - expectedFee;

        assertEq(received, expectedNet, "WithdrawMax should deduct 0.5% fee");
    }

    // ============ Cancel Fee Tests ============

    function test_cancel_deductsFeeFromRecipientOnly() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        // Warp to halfway
        vm.warp(block.timestamp + STREAM_DURATION / 2);

        uint256 streamedAmount = streaming.streamedAmountOf(streamId);
        uint256 recipientAmount = streamedAmount; // no prior withdrawals
        uint256 senderRefund = DEPOSIT_AMOUNT - streamedAmount;

        uint256 clientBalBefore = usdc.balanceOf(client);
        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(client);
        streaming.cancel(streamId);

        uint256 clientBalAfter = usdc.balanceOf(client);
        uint256 providerBalAfter = usdc.balanceOf(provider);

        // Sender refund should be untouched (no fee)
        assertEq(clientBalAfter - clientBalBefore, senderRefund, "Sender refund should have no fee deduction");

        // Recipient should get less due to fee
        uint256 fee = (recipientAmount * 50) / 10_000;
        uint256 expectedRecipientNet = recipientAmount - fee;
        assertEq(
            providerBalAfter - providerBalBefore,
            expectedRecipientNet,
            "Recipient portion should have fee deducted"
        );
    }

    function test_cancel_splitsFee_70_30() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        vm.warp(block.timestamp + STREAM_DURATION / 2);

        uint256 streamedAmount = streaming.streamedAmountOf(streamId);
        uint256 recipientAmount = streamedAmount;

        uint256 facilitatorBalBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBalBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        streaming.cancel(streamId);

        uint256 totalFee = (recipientAmount * 50) / 10_000;
        uint256 expectedFacilitatorShare = (totalFee * 7_000) / 10_000;
        uint256 expectedTreasuryShare = totalFee - expectedFacilitatorShare;

        assertEq(
            usdc.balanceOf(facilitator) - facilitatorBalBefore,
            expectedFacilitatorShare,
            "Cancel: facilitator should get 70% of fee"
        );
        assertEq(
            usdc.balanceOf(treasury) - treasuryBalBefore,
            expectedTreasuryShare,
            "Cancel: treasury should get 30% of fee"
        );
    }

    // ============ Edge Case Tests ============

    function test_withdraw_zeroFee_fullAmount() public {
        // Set protocolFeeBp to 0
        vm.prank(admin);
        streaming.setProtocolFeeBp(0);

        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, facilitator
        );

        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        streaming.withdraw(streamId, DEPOSIT_AMOUNT);

        uint256 received = usdc.balanceOf(provider) - providerBalBefore;
        assertEq(received, DEPOSIT_AMOUNT, "Zero fee should mean full amount to recipient");
    }

    function test_withdraw_noFacilitator_allToTreasury() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 treasuryBalBefore = usdc.balanceOf(treasury);
        uint256 facilitatorBalBefore = usdc.balanceOf(facilitator);

        vm.prank(provider);
        streaming.withdraw(streamId, DEPOSIT_AMOUNT);

        uint256 totalFee = (DEPOSIT_AMOUNT * 50) / 10_000;

        assertEq(
            usdc.balanceOf(treasury) - treasuryBalBefore,
            totalFee,
            "No facilitator: 100% of fee should go to treasury"
        );
        assertEq(
            usdc.balanceOf(facilitator),
            facilitatorBalBefore,
            "No facilitator: facilitator balance should not change"
        );
    }

    // ============ Fuzz Tests ============

    function testFuzz_withdraw_feeNeverExceedsAmount(uint256 amount, uint256 feeBp) public {
        amount = bound(amount, 1e6, 1e12); // 1 USDC to 1M USDC
        feeBp = bound(feeBp, 1, 500); // 0.01% to 5%

        vm.prank(admin);
        streaming.setProtocolFeeBp(feeBp);

        usdc.mint(client, amount);

        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), amount, STREAM_DURATION, true, false, facilitator
        );

        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 providerBalBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        streaming.withdraw(streamId, amount);

        uint256 received = usdc.balanceOf(provider) - providerBalBefore;
        assertGt(received, 0, "Recipient should always get > 0");
        assertLe(received, amount, "Recipient should never get more than amount");
    }
}
