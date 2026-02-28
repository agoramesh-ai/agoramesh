// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/StreamingPayments.sol";
import "../src/TrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract StreamingPaymentsTest is Test {
    StreamingPayments public streaming;
    TrustRegistry public registry;
    MockUSDC public usdc;

    address public admin = address(1);
    address public oracle = address(2);
    address public client = address(3);
    address public provider = address(4);

    bytes32 public clientDid;
    bytes32 public providerDid;
    string public clientCid = "QmClientCapabilityCard123";
    string public providerCid = "QmProviderCapabilityCard456";

    uint256 public constant DEPOSIT_AMOUNT = 1000 * 1e6; // 1000 USDC
    uint256 public constant STREAM_DURATION = 30 days;

    function setUp() public {
        // Deploy contracts
        usdc = new MockUSDC();
        registry = new TrustRegistry(admin, address(usdc));
        streaming = new StreamingPayments(admin, address(registry));

        // Setup DIDs
        clientDid = keccak256(abi.encodePacked("did:agoramesh:base:", client));
        providerDid = keccak256(abi.encodePacked("did:agoramesh:base:", provider));

        // Register agents
        vm.startPrank(client);
        registry.registerAgent(clientDid, clientCid);
        vm.stopPrank();

        vm.startPrank(provider);
        registry.registerAgent(providerDid, providerCid);
        vm.stopPrank();

        // Fund client
        usdc.mint(client, DEPOSIT_AMOUNT * 10);

        // Approve streaming contract
        vm.prank(client);
        usdc.approve(address(streaming), type(uint256).max);
    }

    // ============ Stream Creation Tests ============

    function test_createStream_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid,
            provider,
            address(usdc),
            DEPOSIT_AMOUNT,
            STREAM_DURATION,
            true, // cancelableBySender
            false, // cancelableByRecipient
            address(0)
        );

        assertEq(streamId, 1, "First stream should have ID 1");

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(stream.senderDid, clientDid, "Sender DID mismatch");
        assertEq(stream.recipientDid, providerDid, "Recipient DID mismatch");
        assertEq(stream.sender, client, "Sender address mismatch");
        assertEq(stream.recipient, provider, "Recipient address mismatch");
        assertEq(stream.token, address(usdc), "Token mismatch");
        assertEq(stream.depositAmount, DEPOSIT_AMOUNT, "Deposit amount mismatch");
        assertEq(stream.withdrawnAmount, 0, "Initial withdrawn should be 0");
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.ACTIVE), "Status should be ACTIVE");
        assertTrue(stream.cancelableBySender, "Should be cancelable by sender");
        assertFalse(stream.cancelableByRecipient, "Should not be cancelable by recipient");
    }

    function test_createStream_incrementingIds() public {
        vm.startPrank(client);

        uint256 id1 = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        uint256 id2 = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        uint256 id3 = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    function test_createStream_revertIfZeroAmount() public {
        vm.prank(client);
        vm.expectRevert(StreamingPayments.InvalidDepositAmount.selector);
        streaming.createStream(providerDid, provider, address(usdc), 0, STREAM_DURATION, true, false, address(0));
    }

    function test_createStream_revertIfZeroDuration() public {
        vm.prank(client);
        vm.expectRevert(StreamingPayments.InvalidDuration.selector);
        streaming.createStream(providerDid, provider, address(usdc), DEPOSIT_AMOUNT, 0, true, false, address(0));
    }

    function test_createStream_revertIfZeroRecipient() public {
        vm.prank(client);
        vm.expectRevert(StreamingPayments.InvalidRecipient.selector);
        streaming.createStream(
            providerDid, address(0), address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
    }

    function test_createStream_revertIfSenderNotRegistered() public {
        address unregistered = address(99);
        usdc.mint(unregistered, DEPOSIT_AMOUNT);

        vm.startPrank(unregistered);
        usdc.approve(address(streaming), DEPOSIT_AMOUNT);
        vm.expectRevert(StreamingPayments.SenderNotRegistered.selector);
        streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        vm.stopPrank();
    }

    function test_createStreamWithTimestamps_success() public {
        uint256 startTime = block.timestamp + 1 hours;
        uint256 endTime = startTime + STREAM_DURATION;

        vm.prank(client);
        uint256 streamId = streaming.createStreamWithTimestamps(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, startTime, endTime, true, false, address(0)
        );

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(stream.startTime, startTime, "Start time mismatch");
        assertEq(stream.endTime, endTime, "End time mismatch");
    }

    function test_createStreamWithTimestamps_revertIfStartInPast() public {
        uint256 startTime = block.timestamp - 1;
        uint256 endTime = block.timestamp + STREAM_DURATION;

        vm.prank(client);
        vm.expectRevert(StreamingPayments.StartTimeInPast.selector);
        streaming.createStreamWithTimestamps(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, startTime, endTime, true, false, address(0)
        );
    }

    function test_createStreamWithTimestamps_revertIfEndBeforeStart() public {
        uint256 startTime = block.timestamp + 1 hours;
        uint256 endTime = startTime - 1;

        vm.prank(client);
        vm.expectRevert(StreamingPayments.EndBeforeStart.selector);
        streaming.createStreamWithTimestamps(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, startTime, endTime, true, false, address(0)
        );
    }

    // ============ Rate Calculation Tests ============

    function test_ratePerSecond_calculation() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);

        // Rate should be depositAmount / duration
        uint256 expectedRate = DEPOSIT_AMOUNT / STREAM_DURATION;
        assertEq(stream.ratePerSecond, expectedRate, "Rate per second mismatch");
    }

    // ============ Withdrawal Tests ============

    function test_withdrawableAmountOf_afterHalfDuration() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Warp to halfway through stream
        vm.warp(block.timestamp + STREAM_DURATION / 2);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);

        // Should be approximately half (accounting for rounding from integer division)
        // Note: rate = 1000 USDC / 30 days = ~385.8 but becomes 385 due to integer division
        // This causes ~1.04 USDC loss at half-duration, so we use 2 USDC tolerance
        uint256 expectedMin = (DEPOSIT_AMOUNT / 2) - 2e6; // Allow 2 USDC tolerance
        uint256 expectedMax = (DEPOSIT_AMOUNT / 2) + 2e6;
        assertTrue(
            withdrawable >= expectedMin && withdrawable <= expectedMax, "Withdrawable amount outside expected range"
        );
    }

    function test_withdrawableAmountOf_afterFullDuration() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Warp to after stream ends
        vm.warp(block.timestamp + STREAM_DURATION + 1);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);
        assertEq(withdrawable, DEPOSIT_AMOUNT, "Should be able to withdraw full amount");
    }

    function test_withdraw_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Warp to halfway
        vm.warp(block.timestamp + STREAM_DURATION / 2);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(provider);
        streaming.withdraw(streamId, withdrawable);

        uint256 providerBalanceAfter = usdc.balanceOf(provider);
        assertEq(providerBalanceAfter - providerBalanceBefore, withdrawable, "Provider should receive withdrawn amount");

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(stream.withdrawnAmount, withdrawable, "Withdrawn amount not updated");
    }

    function test_withdraw_revertIfNotRecipient() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.warp(block.timestamp + STREAM_DURATION / 2);

        vm.prank(client); // Wrong person trying to withdraw
        vm.expectRevert(StreamingPayments.NotRecipient.selector);
        streaming.withdraw(streamId, 100e6);
    }

    function test_withdraw_revertIfAmountExceedsAvailable() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.warp(block.timestamp + STREAM_DURATION / 2);
        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);

        vm.prank(provider);
        vm.expectRevert(StreamingPayments.ExceedsWithdrawable.selector);
        streaming.withdraw(streamId, withdrawable + 1);
    }

    function test_withdrawMax_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.warp(block.timestamp + STREAM_DURATION / 2);
        uint256 expectedWithdrawable = streaming.withdrawableAmountOf(streamId);

        vm.prank(provider);
        uint256 withdrawn = streaming.withdrawMax(streamId);

        assertEq(withdrawn, expectedWithdrawable, "Should withdraw max available");
    }

    // ============ Top Up Tests ============

    function test_topUp_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        IStreamingPayments.Stream memory streamBefore = streaming.getStream(streamId);

        vm.prank(client);
        streaming.topUp(streamId, DEPOSIT_AMOUNT);

        IStreamingPayments.Stream memory streamAfter = streaming.getStream(streamId);

        assertEq(streamAfter.depositAmount, DEPOSIT_AMOUNT * 2, "Deposit should double");
        assertTrue(streamAfter.endTime > streamBefore.endTime, "End time should extend");
    }

    function test_topUp_revertIfNotSender() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.prank(provider);
        vm.expectRevert(StreamingPayments.NotSender.selector);
        streaming.topUp(streamId, DEPOSIT_AMOUNT);
    }

    function test_topUp_revertIfStreamNotActive() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Cancel the stream
        vm.prank(client);
        streaming.cancel(streamId);

        vm.prank(client);
        vm.expectRevert(StreamingPayments.StreamNotActive.selector);
        streaming.topUp(streamId, DEPOSIT_AMOUNT);
    }

    // ============ Pause/Resume Tests ============

    function test_pause_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.prank(client);
        streaming.pause(streamId);

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.PAUSED), "Status should be PAUSED");
    }

    function test_pause_revertIfNotSender() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.prank(provider);
        vm.expectRevert(StreamingPayments.NotSender.selector);
        streaming.pause(streamId);
    }

    function test_resume_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.prank(client);
        streaming.pause(streamId);

        vm.prank(client);
        streaming.resume(streamId);

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.ACTIVE), "Status should be ACTIVE");
    }

    function test_resume_revertIfNotPaused() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.prank(client);
        vm.expectRevert(StreamingPayments.NotPaused.selector);
        streaming.resume(streamId);
    }

    // ============ Cancel Tests ============

    function test_cancel_bySender_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Warp to halfway
        vm.warp(block.timestamp + STREAM_DURATION / 2);

        uint256 clientBalanceBefore = usdc.balanceOf(client);
        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(client);
        streaming.cancel(streamId);

        uint256 clientBalanceAfter = usdc.balanceOf(client);
        uint256 providerBalanceAfter = usdc.balanceOf(provider);

        // Provider should get streamed amount, client should get remainder
        assertTrue(providerBalanceAfter > providerBalanceBefore, "Provider should receive streamed amount");
        assertTrue(clientBalanceAfter > clientBalanceBefore, "Client should receive refund");

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.CANCELED), "Status should be CANCELED");
    }

    function test_cancel_bySender_revertIfNotCancelable() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid,
            provider,
            address(usdc),
            DEPOSIT_AMOUNT,
            STREAM_DURATION,
            false, // NOT cancelable by sender
            false,
            address(0)
        );

        vm.prank(client);
        vm.expectRevert(StreamingPayments.NotCancelable.selector);
        streaming.cancel(streamId);
    }

    function test_cancel_byRecipient_success() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid,
            provider,
            address(usdc),
            DEPOSIT_AMOUNT,
            STREAM_DURATION,
            false,
            true, // cancelable by recipient
            address(0)
        );

        vm.warp(block.timestamp + STREAM_DURATION / 2);

        vm.prank(provider);
        streaming.cancel(streamId);

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.CANCELED), "Status should be CANCELED");
    }

    function test_cancel_byRecipient_revertIfNotCancelable() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid,
            provider,
            address(usdc),
            DEPOSIT_AMOUNT,
            STREAM_DURATION,
            true,
            false, // NOT cancelable by recipient
            address(0)
        );

        vm.prank(provider);
        vm.expectRevert(StreamingPayments.NotCancelable.selector);
        streaming.cancel(streamId);
    }

    // ============ Stream Completion Tests ============

    function test_streamCompletion_afterEndTime() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // Warp past end time
        vm.warp(block.timestamp + STREAM_DURATION + 1);

        // Withdraw full amount
        vm.prank(provider);
        streaming.withdrawMax(streamId);

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(uint8(stream.status), uint8(IStreamingPayments.StreamStatus.COMPLETED), "Status should be COMPLETED");
    }

    // ============ View Function Tests ============

    function test_streamedAmountOf() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        // At start, nothing streamed
        assertEq(streaming.streamedAmountOf(streamId), 0, "Nothing streamed at start");

        // After half duration
        vm.warp(block.timestamp + STREAM_DURATION / 2);
        uint256 streamed = streaming.streamedAmountOf(streamId);
        assertTrue(streamed > 0 && streamed <= DEPOSIT_AMOUNT / 2 + 1e6, "Half should be streamed");
    }

    function test_balanceOf() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        assertEq(streaming.balanceOf(streamId), DEPOSIT_AMOUNT, "Full balance at start");

        // After half, withdraw half
        vm.warp(block.timestamp + STREAM_DURATION / 2);
        vm.prank(provider);
        streaming.withdrawMax(streamId);

        uint256 balance = streaming.balanceOf(streamId);
        assertTrue(balance < DEPOSIT_AMOUNT && balance >= DEPOSIT_AMOUNT / 2 - 1e6, "About half should remain");
    }

    function test_isActive() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        assertTrue(streaming.isActive(streamId), "Should be active");

        vm.prank(client);
        streaming.pause(streamId);
        assertFalse(streaming.isActive(streamId), "Should not be active when paused");
    }

    function test_getStreamsBySender() public {
        vm.startPrank(client);
        streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        vm.stopPrank();

        uint256[] memory senderStreams = streaming.getStreamsBySender(clientDid);
        assertEq(senderStreams.length, 2, "Should have 2 streams");
    }

    function test_getStreamsByRecipient() public {
        vm.startPrank(client);
        streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );
        vm.stopPrank();

        uint256[] memory recipientStreams = streaming.getStreamsByRecipient(providerDid);
        assertEq(recipientStreams.length, 2, "Should have 2 streams");
    }

    // ============ Fuzz Tests ============

    function testFuzz_createStream(uint256 amount, uint256 duration) public {
        // Bound inputs to reasonable values
        amount = bound(amount, 1e6, 1e12); // 1 to 1M USDC
        duration = bound(duration, 1 hours, 365 days);

        usdc.mint(client, amount);

        vm.prank(client);
        uint256 streamId =
            streaming.createStream(providerDid, provider, address(usdc), amount, duration, true, false, address(0));

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
        assertEq(stream.depositAmount, amount);
        assertTrue(stream.endTime - stream.startTime == duration);
    }

    function testFuzz_withdraw(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, STREAM_DURATION);

        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        vm.warp(block.timestamp + elapsed);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);

        if (withdrawable > 0) {
            vm.prank(provider);
            streaming.withdraw(streamId, withdrawable);

            IStreamingPayments.Stream memory stream = streaming.getStream(streamId);
            assertEq(stream.withdrawnAmount, withdrawable);
        }
    }

    // ============ Precision Loss Tests (CRITICAL FIX) ============

    /// @notice Tests that mid-stream calculations don't lose significant funds
    /// @dev This test exposes the precision loss bug in ratePerSecond calculation
    /// @dev Current: ratePerSecond = depositAmount / duration causes truncation
    /// @dev Expected: Use scaled arithmetic to prevent precision loss
    function test_NoPrecisionLossAtMidStream() public {
        uint256 deposit = 100 * 1e6; // 100 USDC
        uint256 duration = 365 days;

        usdc.mint(client, deposit);

        vm.prank(client);
        uint256 streamId =
            streaming.createStream(providerDid, provider, address(usdc), deposit, duration, true, false, address(0));

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);

        // Calculate the precision loss from ratePerSecond
        // rate = 100_000_000 / 31_536_000 = 3 (truncated from 3.17...)
        uint256 expectedRate = deposit / duration;
        assertEq(stream.ratePerSecond, expectedRate, "Rate should match expected");

        // Check precision at mid-stream (50% elapsed)
        uint256 halfDuration = duration / 2;
        vm.warp(block.timestamp + halfDuration);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);
        uint256 idealWithdrawable = (deposit * halfDuration) / duration;

        // CRITICAL: The actual withdrawable should be close to the ideal (50% of deposit)
        // With current precision loss: rate * elapsed = 3 * 15768000 = 47304000 (47.3 USDC instead of 50 USDC)
        // That's a loss of ~2.7 USDC at mid-stream!

        // Calculate percentage error: should be less than 0.01% (1 basis point)
        // For USDC with 6 decimals, 1 bp of 100 USDC = 10000 (0.01 USDC)
        uint256 maxAcceptableLoss = deposit / 10000; // 0.01% tolerance

        // This assertion will FAIL with current implementation
        // Because the loss is much larger than 0.01%
        uint256 loss =
            idealWithdrawable > withdrawable ? idealWithdrawable - withdrawable : withdrawable - idealWithdrawable;
        assertTrue(loss <= maxAcceptableLoss, "Mid-stream precision loss exceeds 0.01% threshold");
    }

    /// @notice Tests precision loss over 1 year stream with 1 USDC
    /// @dev Edge case that amplifies precision issues
    function test_SmallAmountPrecisionLoss() public {
        uint256 deposit = 1 * 1e6; // 1 USDC
        uint256 duration = 365 days;

        usdc.mint(client, deposit);

        vm.prank(client);
        uint256 streamId =
            streaming.createStream(providerDid, provider, address(usdc), deposit, duration, true, false, address(0));

        IStreamingPayments.Stream memory stream = streaming.getStream(streamId);

        // With 1 USDC over 1 year: rate = 1_000_000 / 31_536_000 = 0 (COMPLETE LOSS!)
        // This means streamedAmountOf() will return 0 until the stream ends

        // Warp to 50% duration
        vm.warp(block.timestamp + duration / 2);

        uint256 withdrawable = streaming.withdrawableAmountOf(streamId);

        // CRITICAL: With scaled math, this should be ~500000 (0.5 USDC)
        // With current implementation, rate = 0, so withdrawable = 0
        // This is a CRITICAL vulnerability - provider receives NOTHING mid-stream

        // This assertion will FAIL - expecting at least 40% of deposit at 50% time
        assertTrue(withdrawable >= (deposit * 40) / 100, "Small streams should not have zero withdrawable mid-stream");
    }

    /// @notice Tests that streaming calculations use sufficient precision internally
    /// @dev Verifies the PRECISION constant is being used for calculations
    /// @dev Note: stream.ratePerSecond is a legacy field for backward compatibility
    function test_StreamingCalculationsUseSufficientPrecision() public {
        uint256 deposit = 100 * 1e6; // 100 USDC
        uint256 duration = 365 days;

        usdc.mint(client, deposit);

        vm.prank(client);
        uint256 streamId =
            streaming.createStream(providerDid, provider, address(usdc), deposit, duration, true, false, address(0));

        // Verify the PRECISION constant is accessible
        assertEq(streaming.PRECISION(), 1e18, "PRECISION should be 1e18");

        // The real test is behavioral: verify mid-stream calculations are accurate
        // If internal scaled rate is used correctly, mid-stream withdrawable should be precise

        // At 10% duration
        vm.warp(block.timestamp + duration / 10);
        uint256 withdrawableAt10Pct = streaming.withdrawableAmountOf(streamId);
        uint256 expected10Pct = deposit / 10;
        uint256 tolerance = deposit / 10000; // 0.01% tolerance
        assertTrue(
            withdrawableAt10Pct >= expected10Pct - tolerance && withdrawableAt10Pct <= expected10Pct + tolerance,
            "10% calculation should be accurate"
        );

        // At 90% duration
        vm.warp(block.timestamp + duration * 8 / 10); // Already at 10%, go 80% more
        uint256 withdrawableAt90Pct = streaming.withdrawableAmountOf(streamId);
        uint256 expected90Pct = deposit * 9 / 10;
        assertTrue(
            withdrawableAt90Pct >= expected90Pct - tolerance && withdrawableAt90Pct <= expected90Pct + tolerance,
            "90% calculation should be accurate"
        );
    }

    /// @notice Tests that total withdrawable over stream duration equals deposit
    /// @dev Comprehensive test for precision across multiple withdrawals
    function test_TotalWithdrawnEqualsDeposit() public {
        uint256 deposit = 100 * 1e6; // 100 USDC
        uint256 duration = 365 days;

        usdc.mint(client, deposit);

        vm.prank(client);
        uint256 streamId =
            streaming.createStream(providerDid, provider, address(usdc), deposit, duration, true, false, address(0));

        uint256 totalWithdrawn = 0;
        uint256 startTime = block.timestamp;

        // Withdraw 12 times (monthly)
        for (uint256 i = 1; i <= 12; i++) {
            vm.warp(startTime + (duration * i) / 12);

            uint256 withdrawable = streaming.withdrawableAmountOf(streamId);
            if (withdrawable > 0) {
                vm.prank(provider);
                streaming.withdraw(streamId, withdrawable);
                totalWithdrawn += withdrawable;
            }
        }

        // After all monthly withdrawals (at 100% duration), should have ~full deposit
        // Allow 0.1% tolerance for rounding in test timing
        uint256 tolerance = deposit / 1000;
        assertTrue(totalWithdrawn >= deposit - tolerance, "Monthly withdrawals should total near deposit amount");
    }

    // ============ TopUp Rate Fix Tests (C-8) ============

    function test_topUp_rateRecalculation_midstream() public {
        // Create a 30-day stream with 1000 USDC
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        uint256 startTime = block.timestamp;

        // Warp to halfway (15 days)
        vm.warp(startTime + STREAM_DURATION / 2);

        // At halfway, ~500 USDC should be streamed
        uint256 streamedBeforeTopUp = streaming.streamedAmountOf(streamId);
        assertApproxEqRel(streamedBeforeTopUp, DEPOSIT_AMOUNT / 2, 0.01e18); // within 1%

        // Top up with another 1000 USDC
        vm.prank(client);
        streaming.topUp(streamId, DEPOSIT_AMOUNT);

        // Immediately after top-up, streamed amount should NOT jump
        uint256 streamedAfterTopUp = streaming.streamedAmountOf(streamId);
        assertApproxEqRel(streamedAfterTopUp, DEPOSIT_AMOUNT / 2, 0.01e18); // still ~500

        // Warp to original end time (15 more days)
        vm.warp(startTime + STREAM_DURATION);

        // Should NOT be able to withdraw more than was deposited
        uint256 streamedAtOrigEnd = streaming.streamedAmountOf(streamId);
        assertTrue(streamedAtOrigEnd <= DEPOSIT_AMOUNT * 2, "Streamed cannot exceed total deposit");

        // Wait for the full extended duration to complete
        IStreamingPayments.Stream memory s = streaming.getStream(streamId);
        vm.warp(s.endTime);

        // At the end, total streamed should equal total deposit (2000 USDC)
        uint256 finalStreamed = streaming.streamedAmountOf(streamId);
        assertEq(finalStreamed, DEPOSIT_AMOUNT * 2, "Final streamed should equal total deposit");
    }

    function test_topUp_withdrawAfterTopUp_noOverwithdraw() public {
        vm.prank(client);
        uint256 streamId = streaming.createStream(
            providerDid, provider, address(usdc), DEPOSIT_AMOUNT, STREAM_DURATION, true, false, address(0)
        );

        uint256 startTime = block.timestamp;

        // Warp to halfway
        vm.warp(startTime + STREAM_DURATION / 2);

        // Withdraw everything available
        vm.prank(provider);
        uint256 w1 = streaming.withdrawMax(streamId);
        assertGt(w1, 0);

        // Top up with another 1000 USDC
        vm.prank(client);
        streaming.topUp(streamId, DEPOSIT_AMOUNT);

        // Warp to end of extended stream
        IStreamingPayments.Stream memory s = streaming.getStream(streamId);
        vm.warp(s.endTime);

        // Withdraw the rest
        vm.prank(provider);
        uint256 w2 = streaming.withdrawMax(streamId);

        // Total withdrawn should equal total deposited (2000 USDC)
        assertEq(w1 + w2, DEPOSIT_AMOUNT * 2, "Total withdrawn must equal total deposited");
    }
}
