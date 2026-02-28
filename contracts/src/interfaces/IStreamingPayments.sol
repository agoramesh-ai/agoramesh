// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStreamingPayments - Interface for AgoraMesh Streaming Payments
/// @notice Enables continuous payment streams for ongoing agent services
/// @dev Inspired by Sablier's linear streaming model, optimized for agent marketplace
interface IStreamingPayments {
    // ============ Enums ============

    /// @notice Stream status
    enum StreamStatus {
        NONE, // Stream does not exist
        ACTIVE, // Stream is actively streaming
        PAUSED, // Stream is paused (by sender)
        CANCELED, // Stream was canceled early
        COMPLETED // Stream finished naturally
    }

    // ============ Structs ============

    /// @notice Payment stream information
    struct Stream {
        uint256 id;
        bytes32 senderDid; // Client DID
        bytes32 recipientDid; // Provider DID
        address sender; // Client address (for withdrawals)
        address recipient; // Provider address (for withdrawals)
        address token; // ERC20 token (USDC)
        uint256 depositAmount; // Total deposited
        uint256 withdrawnAmount; // Amount already withdrawn
        uint256 startTime; // When streaming starts
        uint256 endTime; // When streaming ends
        uint256 ratePerSecond; // Tokens per second
        StreamStatus status;
        bool cancelableBySender;
        bool cancelableByRecipient;
        address facilitator;
    }

    // ============ Events ============

    /// @notice Emitted when a stream is created
    event StreamCreated(
        uint256 indexed streamId,
        bytes32 indexed senderDid,
        bytes32 indexed recipientDid,
        address token,
        uint256 depositAmount,
        uint256 startTime,
        uint256 endTime
    );

    /// @notice Emitted when funds are withdrawn from a stream
    event Withdrawn(uint256 indexed streamId, address indexed to, uint256 amount);

    /// @notice Emitted when a stream is topped up
    event StreamToppedUp(uint256 indexed streamId, uint256 amount, uint256 newEndTime);

    /// @notice Emitted when a stream is paused
    event StreamPaused(uint256 indexed streamId);

    /// @notice Emitted when a stream is resumed
    event StreamResumed(uint256 indexed streamId);

    /// @notice Emitted when a stream is canceled
    event StreamCanceled(uint256 indexed streamId, uint256 senderRefund, uint256 recipientAmount);

    /// @notice Emitted when a stream completes naturally
    event StreamCompleted(uint256 indexed streamId);

    /// @notice Emitted when protocol fee is collected
    event ProtocolFeeCollected(
        uint256 indexed streamId,
        uint256 totalFee,
        address indexed facilitator,
        uint256 facilitatorShare,
        uint256 treasuryShare
    );

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Emitted when the protocol fee basis points are updated
    event ProtocolFeeUpdated(uint256 newFeeBp);

    // ============ Stream Lifecycle ============

    /// @notice Create a new payment stream
    /// @param recipientDid The provider's DID
    /// @param recipient The provider's address for withdrawals
    /// @param token The ERC20 token address
    /// @param depositAmount Total amount to stream
    /// @param duration Stream duration in seconds
    /// @param cancelableBySender Whether sender can cancel
    /// @param cancelableByRecipient Whether recipient can cancel
    /// @param facilitator Address of the facilitator for fee splitting (address(0) if none)
    /// @return streamId The new stream ID
    function createStream(
        bytes32 recipientDid,
        address recipient,
        address token,
        uint256 depositAmount,
        uint256 duration,
        bool cancelableBySender,
        bool cancelableByRecipient,
        address facilitator
    ) external returns (uint256 streamId);

    /// @notice Create a stream with specific start/end times
    /// @param recipientDid The provider's DID
    /// @param recipient The provider's address for withdrawals
    /// @param token The ERC20 token address
    /// @param depositAmount Total amount to stream
    /// @param startTime When streaming begins
    /// @param endTime When streaming ends
    /// @param cancelableBySender Whether sender can cancel
    /// @param cancelableByRecipient Whether recipient can cancel
    /// @param facilitator Address of the facilitator for fee splitting (address(0) if none)
    /// @return streamId The new stream ID
    function createStreamWithTimestamps(
        bytes32 recipientDid,
        address recipient,
        address token,
        uint256 depositAmount,
        uint256 startTime,
        uint256 endTime,
        bool cancelableBySender,
        bool cancelableByRecipient,
        address facilitator
    ) external returns (uint256 streamId);

    /// @notice Withdraw available funds from a stream
    /// @param streamId The stream ID
    /// @param amount Amount to withdraw
    function withdraw(uint256 streamId, uint256 amount) external;

    /// @notice Withdraw maximum available amount
    /// @param streamId The stream ID
    /// @return withdrawn The amount withdrawn
    function withdrawMax(uint256 streamId) external returns (uint256 withdrawn);

    /// @notice Top up an existing stream with additional funds
    /// @param streamId The stream ID
    /// @param amount Amount to add
    function topUp(uint256 streamId, uint256 amount) external;

    /// @notice Pause a stream (sender only)
    /// @param streamId The stream ID
    function pause(uint256 streamId) external;

    /// @notice Resume a paused stream (sender only)
    /// @param streamId The stream ID
    function resume(uint256 streamId) external;

    /// @notice Cancel a stream and distribute remaining funds
    /// @param streamId The stream ID
    function cancel(uint256 streamId) external;

    // ============ View Functions ============

    /// @notice Get stream details
    /// @param streamId The stream ID
    /// @return The stream struct
    function getStream(uint256 streamId) external view returns (Stream memory);

    /// @notice Get current withdrawable amount for recipient
    /// @param streamId The stream ID
    /// @return The withdrawable amount
    function withdrawableAmountOf(uint256 streamId) external view returns (uint256);

    /// @notice Get amount that has been streamed (vested)
    /// @param streamId The stream ID
    /// @return The streamed amount
    function streamedAmountOf(uint256 streamId) external view returns (uint256);

    /// @notice Get remaining balance in stream
    /// @param streamId The stream ID
    /// @return The remaining balance
    function balanceOf(uint256 streamId) external view returns (uint256);

    /// @notice Check if stream is active
    /// @param streamId The stream ID
    /// @return True if stream is actively streaming
    function isActive(uint256 streamId) external view returns (bool);

    /// @notice Get all streams for a sender
    /// @param senderDid The sender's DID
    /// @return Array of stream IDs
    function getStreamsBySender(bytes32 senderDid) external view returns (uint256[] memory);

    /// @notice Get all streams for a recipient
    /// @param recipientDid The recipient's DID
    /// @return Array of stream IDs
    function getStreamsByRecipient(bytes32 recipientDid) external view returns (uint256[] memory);

    /// @notice Get the next stream ID
    /// @return The next stream ID
    function nextStreamId() external view returns (uint256);
}
