/**
 * AgoraMesh Streaming Payments Client
 *
 * Client for managing continuous payment streams between agents.
 * Inspired by Sablier's linear streaming model.
 *
 * @packageDocumentation
 */
import type { AgoraMeshClient } from './client.js';
/**
 * Stream status enum.
 */
export declare enum StreamStatus {
    NONE = 0,
    ACTIVE = 1,
    PAUSED = 2,
    CANCELED = 3,
    COMPLETED = 4
}
/**
 * Human-readable stream status names.
 */
export declare const StreamStatusNames: Record<StreamStatus, string>;
/**
 * Payment stream information.
 */
export interface Stream {
    id: bigint;
    senderDid: `0x${string}`;
    recipientDid: `0x${string}`;
    sender: `0x${string}`;
    recipient: `0x${string}`;
    token: `0x${string}`;
    depositAmount: bigint;
    withdrawnAmount: bigint;
    startTime: bigint;
    endTime: bigint;
    ratePerSecond: bigint;
    status: StreamStatus;
    cancelableBySender: boolean;
    cancelableByRecipient: boolean;
}
/**
 * Options for creating a stream.
 */
export interface CreateStreamOptions {
    /** Provider's DID */
    recipientDid: string;
    /** Provider's wallet address */
    recipientAddress: `0x${string}`;
    /** Amount to stream (human-readable, e.g., "100" for 100 USDC) */
    amount: string;
    /** Duration in seconds */
    duration: number;
    /** Whether the sender can cancel the stream */
    cancelableBySender?: boolean;
    /** Whether the recipient can cancel the stream */
    cancelableByRecipient?: boolean;
    /** Token address (defaults to USDC) */
    tokenAddress?: `0x${string}`;
}
/**
 * Options for creating a stream with specific timestamps.
 */
export interface CreateStreamWithTimestampsOptions {
    /** Provider's DID */
    recipientDid: string;
    /** Provider's wallet address */
    recipientAddress: `0x${string}`;
    /** Amount to stream (human-readable) */
    amount: string;
    /** Start time (Unix timestamp or Date) */
    startTime: number | Date;
    /** End time (Unix timestamp or Date) */
    endTime: number | Date;
    /** Whether the sender can cancel the stream */
    cancelableBySender?: boolean;
    /** Whether the recipient can cancel the stream */
    cancelableByRecipient?: boolean;
    /** Token address (defaults to USDC) */
    tokenAddress?: `0x${string}`;
}
/**
 * Formatted stream information for display.
 */
export interface FormattedStream {
    id: string;
    depositAmount: string;
    withdrawnAmount: string;
    withdrawableAmount: string;
    status: string;
    startTime: Date;
    endTime: Date;
    ratePerSecond: string;
    progress: number;
    isActive: boolean;
}
/**
 * Cancellation preview showing fund distribution.
 */
export interface CancellationPreview {
    /** Amount that would go to recipient (human-readable) */
    recipientAmount: string;
    /** Amount already withdrawn by recipient (human-readable) */
    alreadyWithdrawn: string;
    /** Amount that would be refunded to sender (human-readable) */
    senderRefund: string;
    /** Total deposit amount (human-readable) */
    totalDeposit: string;
    /** Whether the stream can be canceled */
    canCancel: boolean;
}
/**
 * Stream health status.
 */
export type StreamHealthStatus = 'HEALTHY' | 'WARNING' | 'STUCK' | 'COMPLETED' | 'CANCELED' | 'PAUSED';
/**
 * Stream health information.
 */
export interface StreamHealth {
    /** Current health status */
    status: StreamHealthStatus;
    /** List of detected issues */
    issues: string[];
    /** Time remaining in seconds (negative if past end) */
    timeRemaining: number;
    /** Current progress percentage (0-1) */
    progress: number;
}
/**
 * Recovery result.
 */
export interface RecoveryResult {
    /** Whether recovery was successful */
    success: boolean;
    /** Amount recovered (human-readable) */
    recoveredAmount: string;
    /** Transaction hash if any */
    txHash?: `0x${string}`;
}
/**
 * Client for managing streaming payments between agents.
 *
 * Streaming payments enable continuous, time-based payment flows for
 * ongoing agent services like monitoring, processing, or subscriptions.
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const streaming = new StreamingPaymentsClient(client, {
 *   streamingPaymentsAddress: '0x...',
 * });
 *
 * // Create a 1-hour stream of 100 USDC
 * const streamId = await streaming.createStream({
 *   recipientDid: 'did:agoramesh:base:0x...',
 *   recipientAddress: '0x...',
 *   amount: '100',
 *   duration: 3600, // 1 hour in seconds
 * });
 *
 * // Recipient can withdraw available funds
 * const withdrawn = await streaming.withdrawMax(streamId);
 * ```
 */
export declare class StreamingPaymentsClient {
    private readonly client;
    private readonly contractAddress;
    /**
     * Create a new StreamingPaymentsClient.
     *
     * @param client - The AgoraMesh client instance
     * @param options - Configuration options
     */
    constructor(client: AgoraMeshClient, options: {
        streamingPaymentsAddress: `0x${string}`;
    });
    /**
     * Create a new payment stream.
     *
     * @param options - Stream creation options
     * @returns The new stream ID
     *
     * @example
     * ```typescript
     * const streamId = await streaming.createStream({
     *   recipientDid: 'did:agoramesh:base:0x...',
     *   recipientAddress: '0x...',
     *   amount: '100', // 100 USDC
     *   duration: 3600, // 1 hour
     * });
     * ```
     */
    createStream(options: CreateStreamOptions): Promise<bigint>;
    /**
     * Create a stream with specific start and end times.
     *
     * @param options - Stream creation options with timestamps
     * @returns The new stream ID
     */
    createStreamWithTimestamps(options: CreateStreamWithTimestampsOptions): Promise<bigint>;
    /**
     * Withdraw a specific amount from a stream.
     *
     * @param streamId - The stream ID
     * @param amount - Amount to withdraw (human-readable)
     * @returns Transaction hash
     */
    withdraw(streamId: bigint, amount: string): Promise<`0x${string}`>;
    /**
     * Withdraw all available funds from a stream.
     *
     * @param streamId - The stream ID
     * @returns Amount withdrawn (human-readable)
     */
    withdrawMax(streamId: bigint): Promise<string>;
    /**
     * Top up an existing stream with additional funds.
     *
     * @param streamId - The stream ID
     * @param amount - Amount to add (human-readable)
     * @returns Transaction hash
     */
    topUp(streamId: bigint, amount: string): Promise<`0x${string}`>;
    /**
     * Pause a stream (sender only).
     *
     * @param streamId - The stream ID
     * @returns Transaction hash
     */
    pause(streamId: bigint): Promise<`0x${string}`>;
    /**
     * Resume a paused stream (sender only).
     *
     * @param streamId - The stream ID
     * @returns Transaction hash
     */
    resume(streamId: bigint): Promise<`0x${string}`>;
    /**
     * Cancel a stream and distribute remaining funds.
     *
     * @param streamId - The stream ID
     * @returns Transaction hash
     */
    cancel(streamId: bigint): Promise<`0x${string}`>;
    /**
     * Get stream details by ID.
     *
     * @param streamId - The stream ID
     * @returns Stream details
     */
    getStream(streamId: bigint): Promise<Stream>;
    /**
     * Get the current withdrawable amount for a stream.
     *
     * @param streamId - The stream ID
     * @returns Withdrawable amount in wei
     */
    getWithdrawableAmount(streamId: bigint): Promise<bigint>;
    /**
     * Get the amount that has been streamed (vested).
     *
     * @param streamId - The stream ID
     * @returns Streamed amount in wei
     */
    getStreamedAmount(streamId: bigint): Promise<bigint>;
    /**
     * Get the remaining balance in a stream.
     *
     * @param streamId - The stream ID
     * @returns Balance in wei
     */
    getBalance(streamId: bigint): Promise<bigint>;
    /**
     * Check if a stream is active.
     *
     * @param streamId - The stream ID
     * @returns True if stream is actively streaming
     */
    isActive(streamId: bigint): Promise<boolean>;
    /**
     * Get all streams where the given DID is the sender.
     *
     * @param senderDid - The sender's DID
     * @returns Array of stream IDs
     */
    getStreamsBySender(senderDid: string): Promise<bigint[]>;
    /**
     * Get all streams where the given DID is the recipient.
     *
     * @param recipientDid - The recipient's DID
     * @returns Array of stream IDs
     */
    getStreamsByRecipient(recipientDid: string): Promise<bigint[]>;
    /**
     * Format a stream for display.
     *
     * @param stream - The stream to format
     * @returns Formatted stream information
     */
    formatStream(stream: Stream): FormattedStream;
    /**
     * Calculate the rate per second for a given amount and duration.
     *
     * @param amount - Total amount (human-readable)
     * @param durationSeconds - Duration in seconds
     * @returns Rate per second (human-readable)
     */
    calculateRate(amount: string, durationSeconds: number): string;
    /**
     * Check if the current user is the sender of a stream.
     *
     * @param streamId - The stream ID
     * @returns True if current user is the sender
     */
    isSender(streamId: bigint): Promise<boolean>;
    /**
     * Check if the current user is the recipient of a stream.
     *
     * @param streamId - The stream ID
     * @returns True if current user is the recipient
     */
    isRecipient(streamId: bigint): Promise<boolean>;
    /**
     * Get the time remaining until stream ends.
     *
     * @param streamId - The stream ID
     * @returns Seconds remaining (negative if ended)
     */
    getTimeRemaining(streamId: bigint): Promise<number>;
    /**
     * Get a preview of fund distribution if the stream is canceled.
     *
     * @param streamId - The stream ID
     * @returns Cancellation preview showing recipient and sender amounts
     */
    getCancellationPreview(streamId: bigint): Promise<CancellationPreview>;
    /**
     * Check if a stream is stuck (past end time but not completed/canceled).
     *
     * @param streamId - The stream ID
     * @returns True if stream is stuck
     */
    isStreamStuck(streamId: bigint): Promise<boolean>;
    /**
     * Check if stream data indicates a stuck stream.
     * Internal helper to avoid redundant getStream calls.
     */
    private isStreamDataStuck;
    /**
     * Get all stuck streams where the given DID is the sender.
     *
     * @param senderDid - The sender's DID
     * @returns Array of stuck streams
     */
    getStuckStreams(senderDid: string): Promise<Stream[]>;
    /**
     * Attempt to recover a stuck stream by withdrawing remaining funds.
     *
     * @param streamId - The stream ID
     * @returns Recovery result
     * @throws Error if stream is not stuck
     */
    recoverStream(streamId: bigint): Promise<RecoveryResult>;
    /** Warning threshold: 5 minutes before end */
    private static readonly WARNING_THRESHOLD_SECONDS;
    /**
     * Get the health status of a stream.
     *
     * @param streamId - The stream ID
     * @returns Stream health information
     */
    getStreamHealth(streamId: bigint): Promise<StreamHealth>;
    /**
     * Ensure sufficient token allowance for the streaming contract.
     */
    private ensureAllowance;
}
//# sourceMappingURL=streaming.d.ts.map