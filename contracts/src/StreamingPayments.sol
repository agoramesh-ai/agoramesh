// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IStreamingPayments.sol";
import "./TrustRegistry.sol";

/// @title StreamingPayments - Continuous Payment Streams for AgentMe
/// @notice Enables time-based streaming of payments from clients to agent providers
/// @dev Inspired by Sablier's linear streaming model, optimized for agent services
contract StreamingPayments is IStreamingPayments, AccessControlEnumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Precision multiplier for rate calculations (1e18)
    /// @dev Prevents precision loss in ratePerSecond calculation
    uint256 public constant PRECISION = 1e18;

    // ============ State Variables ============

    /// @notice Reference to the TrustRegistry for agent verification
    TrustRegistry public immutable trustRegistry;

    /// @notice Counter for stream IDs
    uint256 private _nextStreamId;

    /// @notice Mapping from stream ID to Stream struct
    mapping(uint256 => Stream) private _streams;

    /// @notice Mapping from sender DID to their stream IDs
    mapping(bytes32 => uint256[]) private _senderStreams;

    /// @notice Mapping from recipient DID to their stream IDs
    mapping(bytes32 => uint256[]) private _recipientStreams;

    /// @notice Pause start times for calculating adjusted durations
    mapping(uint256 => uint256) private _pauseStartTimes;

    /// @notice Total accumulated pause duration for each stream
    mapping(uint256 => uint256) private _totalPauseDuration;

    /// @notice Scaled rate per second (with PRECISION) for accurate streaming
    /// @dev scaledRate = depositAmount * PRECISION / duration
    mapping(uint256 => uint256) private _scaledRatePerSecond;

    /// @notice Amount streamed at the time of cancellation
    mapping(uint256 => uint256) private _streamedAtCancel;

    // ============ Constructor ============

    /// @notice Deploy the StreamingPayments contract
    /// @param admin The admin address
    /// @param registry The TrustRegistry address
    constructor(address admin, address registry) {
        require(admin != address(0), "Invalid admin");
        require(registry != address(0), "Invalid registry");

        trustRegistry = TrustRegistry(registry);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _nextStreamId = 1;
    }

    // ============ Stream Creation ============

    /// @inheritdoc IStreamingPayments
    function createStream(
        bytes32 recipientDid,
        address recipient,
        address token,
        uint256 depositAmount,
        uint256 duration,
        bool cancelableBySender,
        bool cancelableByRecipient
    ) external nonReentrant returns (uint256 streamId) {
        require(duration > 0, "Duration must be > 0");
        return _createStreamInternal(
            recipientDid,
            recipient,
            token,
            depositAmount,
            block.timestamp,
            block.timestamp + duration,
            cancelableBySender,
            cancelableByRecipient
        );
    }

    /// @inheritdoc IStreamingPayments
    function createStreamWithTimestamps(
        bytes32 recipientDid,
        address recipient,
        address token,
        uint256 depositAmount,
        uint256 startTime,
        uint256 endTime,
        bool cancelableBySender,
        bool cancelableByRecipient
    ) external nonReentrant returns (uint256 streamId) {
        require(startTime >= block.timestamp, "Start time in past");
        require(endTime > startTime, "End before start");
        return _createStreamInternal(
            recipientDid, recipient, token, depositAmount, startTime, endTime, cancelableBySender, cancelableByRecipient
        );
    }

    /// @dev Internal function to create a stream
    function _createStreamInternal(
        bytes32 recipientDid,
        address recipient,
        address token,
        uint256 depositAmount,
        uint256 startTime,
        uint256 endTime,
        bool cancelableBySender,
        bool cancelableByRecipient
    ) internal returns (uint256 streamId) {
        require(depositAmount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");

        // Get sender's DID
        bytes32 senderDid = _getSenderDid(msg.sender);
        require(senderDid != bytes32(0), "Sender not registered");

        // Calculate rate per second with PRECISION to prevent precision loss
        uint256 duration = endTime - startTime;
        // Store scaled rate for accurate mid-stream calculations
        uint256 scaledRate = (depositAmount * PRECISION) / duration;
        // Legacy ratePerSecond for backward compatibility (may have precision loss)
        uint256 ratePerSecond = depositAmount / duration;

        // Transfer tokens from sender
        IERC20(token).safeTransferFrom(msg.sender, address(this), depositAmount);

        // Create stream
        streamId = _nextStreamId++;
        _streams[streamId] = Stream({
            id: streamId,
            senderDid: senderDid,
            recipientDid: recipientDid,
            sender: msg.sender,
            recipient: recipient,
            token: token,
            depositAmount: depositAmount,
            withdrawnAmount: 0,
            startTime: startTime,
            endTime: endTime,
            ratePerSecond: ratePerSecond,
            status: StreamStatus.ACTIVE,
            cancelableBySender: cancelableBySender,
            cancelableByRecipient: cancelableByRecipient
        });

        // Store the scaled rate for precision calculations
        _scaledRatePerSecond[streamId] = scaledRate;

        // Track streams
        _senderStreams[senderDid].push(streamId);
        _recipientStreams[recipientDid].push(streamId);

        emit StreamCreated(streamId, senderDid, recipientDid, token, depositAmount, startTime, endTime);
    }

    // ============ Withdrawals ============

    /// @inheritdoc IStreamingPayments
    function withdraw(uint256 streamId, uint256 amount) external nonReentrant {
        Stream storage stream = _streams[streamId];
        require(msg.sender == stream.recipient, "Not recipient");
        require(amount > 0, "Amount must be > 0");

        uint256 withdrawable = withdrawableAmountOf(streamId);
        require(amount <= withdrawable, "Exceeds withdrawable");

        stream.withdrawnAmount += amount;

        // Check if stream is completed
        if (stream.withdrawnAmount == stream.depositAmount && block.timestamp >= _adjustedEndTime(streamId)) {
            stream.status = StreamStatus.COMPLETED;
            emit StreamCompleted(streamId);
        }

        IERC20(stream.token).safeTransfer(stream.recipient, amount);
        emit Withdrawn(streamId, stream.recipient, amount);
    }

    /// @inheritdoc IStreamingPayments
    function withdrawMax(uint256 streamId) external nonReentrant returns (uint256 withdrawn) {
        Stream storage stream = _streams[streamId];
        require(msg.sender == stream.recipient, "Not recipient");

        withdrawn = withdrawableAmountOf(streamId);
        if (withdrawn == 0) return 0;

        stream.withdrawnAmount += withdrawn;

        // Check if stream is completed
        if (stream.withdrawnAmount == stream.depositAmount && block.timestamp >= _adjustedEndTime(streamId)) {
            stream.status = StreamStatus.COMPLETED;
            emit StreamCompleted(streamId);
        }

        IERC20(stream.token).safeTransfer(stream.recipient, withdrawn);
        emit Withdrawn(streamId, stream.recipient, withdrawn);
    }

    // ============ Top Up ============

    /// @inheritdoc IStreamingPayments
    function topUp(uint256 streamId, uint256 amount) external nonReentrant {
        Stream storage stream = _streams[streamId];
        require(msg.sender == stream.sender, "Not sender");
        require(stream.status == StreamStatus.ACTIVE || stream.status == StreamStatus.PAUSED, "Stream not active");
        require(amount > 0, "Amount must be > 0");

        // Transfer additional tokens
        IERC20(stream.token).safeTransferFrom(msg.sender, address(this), amount);

        // Extend stream duration based on current scaled rate (maintains constant rate)
        // additionalDuration = amount * PRECISION / scaledRate
        uint256 scaledRate = _scaledRatePerSecond[streamId];
        uint256 additionalDuration = (amount * PRECISION) / scaledRate;
        stream.depositAmount += amount;
        stream.endTime += additionalDuration;
        // Rate stays unchanged - additionalDuration is calculated to maintain it.
        // Recalculating would introduce rounding errors.

        emit StreamToppedUp(streamId, amount, stream.endTime);
    }

    // ============ Pause/Resume ============

    /// @inheritdoc IStreamingPayments
    function pause(uint256 streamId) external {
        Stream storage stream = _streams[streamId];
        require(msg.sender == stream.sender, "Not sender");
        require(stream.status == StreamStatus.ACTIVE, "Not active");

        stream.status = StreamStatus.PAUSED;
        _pauseStartTimes[streamId] = block.timestamp;

        emit StreamPaused(streamId);
    }

    /// @inheritdoc IStreamingPayments
    function resume(uint256 streamId) external {
        Stream storage stream = _streams[streamId];
        require(msg.sender == stream.sender, "Not sender");
        require(stream.status == StreamStatus.PAUSED, "Not paused");

        // Calculate pause duration and adjust
        uint256 pauseDuration = block.timestamp - _pauseStartTimes[streamId];
        _totalPauseDuration[streamId] += pauseDuration;
        stream.endTime += pauseDuration;

        stream.status = StreamStatus.ACTIVE;
        _pauseStartTimes[streamId] = 0;

        emit StreamResumed(streamId);
    }

    // ============ Cancel ============

    /// @inheritdoc IStreamingPayments
    function cancel(uint256 streamId) external nonReentrant {
        Stream storage stream = _streams[streamId];
        require(stream.status == StreamStatus.ACTIVE || stream.status == StreamStatus.PAUSED, "Stream not active");

        // Check cancelability
        bool canCancel = false;
        if (msg.sender == stream.sender && stream.cancelableBySender) {
            canCancel = true;
        } else if (msg.sender == stream.recipient && stream.cancelableByRecipient) {
            canCancel = true;
        }
        require(canCancel, "Not cancelable");

        // Calculate amounts
        uint256 streamedAmount = streamedAmountOf(streamId);
        uint256 recipientAmount = streamedAmount - stream.withdrawnAmount;
        uint256 senderRefund = stream.depositAmount - streamedAmount;

        // Store streamed amount at cancellation for future queries
        _streamedAtCancel[streamId] = streamedAmount;

        stream.status = StreamStatus.CANCELED;

        // Transfer to recipient
        if (recipientAmount > 0) {
            IERC20(stream.token).safeTransfer(stream.recipient, recipientAmount);
        }

        // Refund sender
        if (senderRefund > 0) {
            IERC20(stream.token).safeTransfer(stream.sender, senderRefund);
        }

        emit StreamCanceled(streamId, senderRefund, recipientAmount);
    }

    // ============ View Functions ============

    /// @inheritdoc IStreamingPayments
    function getStream(uint256 streamId) external view returns (Stream memory) {
        return _streams[streamId];
    }

    /// @inheritdoc IStreamingPayments
    function withdrawableAmountOf(uint256 streamId) public view returns (uint256) {
        Stream storage stream = _streams[streamId];
        if (stream.status == StreamStatus.CANCELED || stream.status == StreamStatus.COMPLETED) {
            return 0;
        }

        uint256 streamed = streamedAmountOf(streamId);
        return streamed - stream.withdrawnAmount;
    }

    /// @inheritdoc IStreamingPayments
    function streamedAmountOf(uint256 streamId) public view returns (uint256) {
        Stream storage stream = _streams[streamId];

        if (stream.status == StreamStatus.NONE) return 0;
        if (stream.status == StreamStatus.CANCELED) {
            // Return the streamed amount stored at cancellation time
            return _streamedAtCancel[streamId];
        }

        // Calculate effective current time
        uint256 effectiveTime = block.timestamp;
        if (stream.status == StreamStatus.PAUSED) {
            // When paused, use the pause start time
            effectiveTime = _pauseStartTimes[streamId];
        }

        // Adjust for any historical pause durations
        uint256 adjustedEndTime = _adjustedEndTime(streamId);

        if (effectiveTime < stream.startTime) return 0;
        if (effectiveTime >= adjustedEndTime) return stream.depositAmount;

        // Calculate elapsed time since start (excluding pauses)
        uint256 elapsed = effectiveTime - stream.startTime;
        if (_totalPauseDuration[streamId] > 0 && !_isPaused(streamId)) {
            elapsed -= _totalPauseDuration[streamId];
        }

        // Use scaled rate for precise calculation, then remove PRECISION scaling
        return (_scaledRatePerSecond[streamId] * elapsed) / PRECISION;
    }

    /// @inheritdoc IStreamingPayments
    function balanceOf(uint256 streamId) external view returns (uint256) {
        Stream storage stream = _streams[streamId];
        return stream.depositAmount - stream.withdrawnAmount;
    }

    /// @inheritdoc IStreamingPayments
    function isActive(uint256 streamId) external view returns (bool) {
        return _streams[streamId].status == StreamStatus.ACTIVE;
    }

    /// @inheritdoc IStreamingPayments
    function getStreamsBySender(bytes32 senderDid) external view returns (uint256[] memory) {
        return _senderStreams[senderDid];
    }

    /// @inheritdoc IStreamingPayments
    function getStreamsByRecipient(bytes32 recipientDid) external view returns (uint256[] memory) {
        return _recipientStreams[recipientDid];
    }

    /// @inheritdoc IStreamingPayments
    function nextStreamId() external view returns (uint256) {
        return _nextStreamId;
    }

    // ============ Internal Functions ============

    /// @dev Get the sender's DID from TrustRegistry
    function _getSenderDid(address sender) internal view returns (bytes32) {
        return trustRegistry.getAgentByOwner(sender);
    }

    /// @dev Check if stream is currently paused
    function _isPaused(uint256 streamId) internal view returns (bool) {
        return _streams[streamId].status == StreamStatus.PAUSED;
    }

    /// @dev Get adjusted end time accounting for pauses
    /// @dev Note: resume() already extends endTime by completed pause durations,
    ///      so we only need to account for any ongoing (current) pause.
    function _adjustedEndTime(uint256 streamId) internal view returns (uint256) {
        Stream storage stream = _streams[streamId];

        // Only add current ongoing pause duration if currently paused
        if (_isPaused(streamId)) {
            uint256 currentPauseDuration = block.timestamp - _pauseStartTimes[streamId];
            return stream.endTime + currentPauseDuration;
        }

        return stream.endTime;
    }
}
