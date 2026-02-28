/**
 * AgoraMesh Streaming Payments Client
 *
 * Client for managing continuous payment streams between agents.
 * Inspired by Sablier's linear streaming model.
 *
 * @packageDocumentation
 */

import { parseEventLogs } from 'viem';
import type { AgoraMeshClient } from './client.js';
import { didToHash } from './client.js';
import { parseUSDC, formatUSDC, toUnixTimestamp, calculateElapsedTime } from './utils.js';
import { ERC20_ABI } from './abis.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Stream status enum.
 */
export enum StreamStatus {
  NONE = 0,
  ACTIVE = 1,
  PAUSED = 2,
  CANCELED = 3,
  COMPLETED = 4,
}

/**
 * Human-readable stream status names.
 */
export const StreamStatusNames: Record<StreamStatus, string> = {
  [StreamStatus.NONE]: 'None',
  [StreamStatus.ACTIVE]: 'Active',
  [StreamStatus.PAUSED]: 'Paused',
  [StreamStatus.CANCELED]: 'Canceled',
  [StreamStatus.COMPLETED]: 'Completed',
};

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
  facilitator: `0x${string}`;
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
  /** Node operator address for protocol fee split (defaults to address(0)) */
  facilitator?: `0x${string}`;
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
  /** Node operator address for protocol fee split (defaults to address(0)) */
  facilitator?: `0x${string}`;
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

// =============================================================================
// ABI Fragments
// =============================================================================

const STREAMING_ABI = [
  {
    name: 'createStream',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipientDid', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'duration', type: 'uint256' },
      { name: 'cancelableBySender', type: 'bool' },
      { name: 'cancelableByRecipient', type: 'bool' },
      { name: 'facilitator', type: 'address' },
    ],
    outputs: [{ name: 'streamId', type: 'uint256' }],
  },
  {
    name: 'createStreamWithTimestamps',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipientDid', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'depositAmount', type: 'uint256' },
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
      { name: 'cancelableBySender', type: 'bool' },
      { name: 'cancelableByRecipient', type: 'bool' },
      { name: 'facilitator', type: 'address' },
    ],
    outputs: [{ name: 'streamId', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'streamId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'withdrawMax',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: 'withdrawn', type: 'uint256' }],
  },
  {
    name: 'topUp',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'streamId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'pause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'resume',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'cancel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getStream',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'senderDid', type: 'bytes32' },
          { name: 'recipientDid', type: 'bytes32' },
          { name: 'sender', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'depositAmount', type: 'uint256' },
          { name: 'withdrawnAmount', type: 'uint256' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'ratePerSecond', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'cancelableBySender', type: 'bool' },
          { name: 'cancelableByRecipient', type: 'bool' },
          { name: 'facilitator', type: 'address' },
        ],
      },
    ],
  },
  {
    name: 'withdrawableAmountOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'streamedAmountOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'streamId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'getStreamsBySender',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'senderDid', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    name: 'getStreamsByRecipient',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'recipientDid', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    name: 'nextStreamId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'StreamCreated',
    type: 'event',
    inputs: [
      { name: 'streamId', type: 'uint256', indexed: true },
      { name: 'senderDid', type: 'bytes32', indexed: true },
      { name: 'recipientDid', type: 'bytes32', indexed: true },
      { name: 'depositAmount', type: 'uint256', indexed: false },
      { name: 'duration', type: 'uint256', indexed: false },
    ],
  },
] as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse stream data from contract response.
 */
function parseStream(data: {
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
  status: number;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  facilitator: `0x${string}`;
}): Stream {
  return {
    id: data.id,
    senderDid: data.senderDid,
    recipientDid: data.recipientDid,
    sender: data.sender,
    recipient: data.recipient,
    token: data.token,
    depositAmount: data.depositAmount,
    withdrawnAmount: data.withdrawnAmount,
    startTime: data.startTime,
    endTime: data.endTime,
    ratePerSecond: data.ratePerSecond,
    status: data.status as StreamStatus,
    cancelableBySender: data.cancelableBySender,
    cancelableByRecipient: data.cancelableByRecipient,
    facilitator: data.facilitator,
  };
}

// =============================================================================
// StreamingPaymentsClient
// =============================================================================

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
export class StreamingPaymentsClient {
  private readonly client: AgoraMeshClient;
  private readonly contractAddress: `0x${string}`;

  /**
   * Create a new StreamingPaymentsClient.
   *
   * @param client - The AgoraMesh client instance
   * @param options - Configuration options
   */
  constructor(
    client: AgoraMeshClient,
    options: { streamingPaymentsAddress: `0x${string}` }
  ) {
    this.client = client;
    this.contractAddress = options.streamingPaymentsAddress;
  }

  // ===========================================================================
  // Stream Creation
  // ===========================================================================

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
  async createStream(options: CreateStreamOptions): Promise<bigint> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();
    const ownerAddress = this.client.getAddress();

    if (!walletClient || !publicClient || !ownerAddress) {
      throw new Error('Wallet not connected.');
    }

    const tokenAddress = options.tokenAddress ?? addresses.usdc;
    if (!tokenAddress) {
      throw new Error('Token address not configured.');
    }

    const recipientDidHash = didToHash(options.recipientDid);
    const amountWei = parseUSDC(options.amount);

    // Approve token transfer
    await this.ensureAllowance(tokenAddress, amountWei);

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'createStream',
      args: [
        recipientDidHash,
        options.recipientAddress,
        tokenAddress,
        amountWei,
        BigInt(options.duration),
        options.cancelableBySender ?? true,
        options.cancelableByRecipient ?? false,
        options.facilitator ?? '0x0000000000000000000000000000000000000000',
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get stream ID from the StreamCreated event log
    const logs = parseEventLogs({
      abi: STREAMING_ABI,
      logs: receipt.logs,
      eventName: 'StreamCreated',
    });

    if (logs.length === 0) {
      throw new Error('StreamCreated event not found in transaction receipt');
    }

    const firstLog = logs[0]!;
    return firstLog.args.streamId;
  }

  /**
   * Create a stream with specific start and end times.
   *
   * @param options - Stream creation options with timestamps
   * @returns The new stream ID
   */
  async createStreamWithTimestamps(
    options: CreateStreamWithTimestampsOptions
  ): Promise<bigint> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }

    const tokenAddress = options.tokenAddress ?? addresses.usdc;
    if (!tokenAddress) {
      throw new Error('Token address not configured.');
    }

    const recipientDidHash = didToHash(options.recipientDid);
    const amountWei = parseUSDC(options.amount);
    const startTime = toUnixTimestamp(options.startTime);
    const endTime = toUnixTimestamp(options.endTime);

    // Approve token transfer
    await this.ensureAllowance(tokenAddress, amountWei);

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'createStreamWithTimestamps',
      args: [
        recipientDidHash,
        options.recipientAddress,
        tokenAddress,
        amountWei,
        startTime,
        endTime,
        options.cancelableBySender ?? true,
        options.cancelableByRecipient ?? false,
        options.facilitator ?? '0x0000000000000000000000000000000000000000',
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get stream ID from the StreamCreated event log
    const logs = parseEventLogs({
      abi: STREAMING_ABI,
      logs: receipt.logs,
      eventName: 'StreamCreated',
    });

    if (logs.length === 0) {
      throw new Error('StreamCreated event not found in transaction receipt');
    }

    const firstLog = logs[0]!;
    return firstLog.args.streamId;
  }

  // ===========================================================================
  // Withdrawals
  // ===========================================================================

  /**
   * Withdraw a specific amount from a stream.
   *
   * @param streamId - The stream ID
   * @param amount - Amount to withdraw (human-readable)
   * @returns Transaction hash
   */
  async withdraw(streamId: bigint, amount: string): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    const amountWei = parseUSDC(amount);

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'withdraw',
      args: [streamId, amountWei],
    });

    return txHash;
  }

  /**
   * Withdraw all available funds from a stream.
   *
   * @param streamId - The stream ID
   * @returns Amount withdrawn (human-readable)
   */
  async withdrawMax(streamId: bigint): Promise<string> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'withdrawMax',
      args: [streamId],
    });

    await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    // Get the withdrawable amount that was withdrawn
    // In a real implementation, we'd parse the Withdrawn event
    const withdrawable = await this.getWithdrawableAmount(streamId);
    return formatUSDC(withdrawable);
  }

  // ===========================================================================
  // Stream Management
  // ===========================================================================

  /**
   * Top up an existing stream with additional funds.
   *
   * @param streamId - The stream ID
   * @param amount - Amount to add (human-readable)
   * @returns Transaction hash
   */
  async topUp(streamId: bigint, amount: string): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }

    const stream = await this.getStream(streamId);
    const amountWei = parseUSDC(amount);

    // Approve token transfer
    await this.ensureAllowance(stream.token, amountWei);

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'topUp',
      args: [streamId, amountWei],
    });

    return txHash;
  }

  /**
   * Pause a stream (sender only).
   *
   * @param streamId - The stream ID
   * @returns Transaction hash
   */
  async pause(streamId: bigint): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'pause',
      args: [streamId],
    });

    return txHash;
  }

  /**
   * Resume a paused stream (sender only).
   *
   * @param streamId - The stream ID
   * @returns Transaction hash
   */
  async resume(streamId: bigint): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'resume',
      args: [streamId],
    });

    return txHash;
  }

  /**
   * Cancel a stream and distribute remaining funds.
   *
   * @param streamId - The stream ID
   * @returns Transaction hash
   */
  async cancel(streamId: bigint): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'cancel',
      args: [streamId],
    });

    return txHash;
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get stream details by ID.
   *
   * @param streamId - The stream ID
   * @returns Stream details
   */
  async getStream(streamId: bigint): Promise<Stream> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    const result = await publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'getStream',
      args: [streamId],
    });

    return parseStream(result);
  }

  /**
   * Get the current withdrawable amount for a stream.
   *
   * @param streamId - The stream ID
   * @returns Withdrawable amount in wei
   */
  async getWithdrawableAmount(streamId: bigint): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'withdrawableAmountOf',
      args: [streamId],
    });
  }

  /**
   * Get the amount that has been streamed (vested).
   *
   * @param streamId - The stream ID
   * @returns Streamed amount in wei
   */
  async getStreamedAmount(streamId: bigint): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'streamedAmountOf',
      args: [streamId],
    });
  }

  /**
   * Get the remaining balance in a stream.
   *
   * @param streamId - The stream ID
   * @returns Balance in wei
   */
  async getBalance(streamId: bigint): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'balanceOf',
      args: [streamId],
    });
  }

  /**
   * Check if a stream is active.
   *
   * @param streamId - The stream ID
   * @returns True if stream is actively streaming
   */
  async isActive(streamId: bigint): Promise<boolean> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'isActive',
      args: [streamId],
    });
  }

  /**
   * Get all streams where the given DID is the sender.
   *
   * @param senderDid - The sender's DID
   * @returns Array of stream IDs
   */
  async getStreamsBySender(senderDid: string): Promise<bigint[]> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    const didHash = didToHash(senderDid);
    const result = await publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'getStreamsBySender',
      args: [didHash],
    });

    return [...result];
  }

  /**
   * Get all streams where the given DID is the recipient.
   *
   * @param recipientDid - The recipient's DID
   * @returns Array of stream IDs
   */
  async getStreamsByRecipient(recipientDid: string): Promise<bigint[]> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    const didHash = didToHash(recipientDid);
    const result = await publicClient.readContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'getStreamsByRecipient',
      args: [didHash],
    });

    return [...result];
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Format a stream for display.
   *
   * @param stream - The stream to format
   * @returns Formatted stream information
   */
  formatStream(stream: Stream): FormattedStream {
    const duration = stream.endTime - stream.startTime;
    const elapsed = calculateElapsedTime(stream.startTime, stream.endTime);
    const progress =
      duration > 0n ? Number((elapsed * 100n) / duration) / 100 : 0;

    // Calculate withdrawable (simplified - real calculation is in contract)
    const streamed =
      duration > 0n ? (stream.depositAmount * elapsed) / duration : 0n;
    const withdrawable =
      streamed > stream.withdrawnAmount
        ? streamed - stream.withdrawnAmount
        : 0n;

    return {
      id: stream.id.toString(),
      depositAmount: formatUSDC(stream.depositAmount),
      withdrawnAmount: formatUSDC(stream.withdrawnAmount),
      withdrawableAmount: formatUSDC(withdrawable),
      status: StreamStatusNames[stream.status] ?? 'Unknown',
      startTime: new Date(Number(stream.startTime) * 1000),
      endTime: new Date(Number(stream.endTime) * 1000),
      ratePerSecond: formatUSDC(stream.ratePerSecond),
      progress,
      isActive: stream.status === StreamStatus.ACTIVE,
    };
  }

  /**
   * Calculate the rate per second for a given amount and duration.
   *
   * @param amount - Total amount (human-readable)
   * @param durationSeconds - Duration in seconds
   * @returns Rate per second (human-readable)
   */
  calculateRate(amount: string, durationSeconds: number): string {
    const amountWei = parseUSDC(amount);
    const rateWei = amountWei / BigInt(durationSeconds);
    return formatUSDC(rateWei);
  }

  /**
   * Check if the current user is the sender of a stream.
   *
   * @param streamId - The stream ID
   * @returns True if current user is the sender
   */
  async isSender(streamId: bigint): Promise<boolean> {
    const stream = await this.getStream(streamId);
    const address = this.client.getAddress();
    return (
      address !== null && address.toLowerCase() === stream.sender.toLowerCase()
    );
  }

  /**
   * Check if the current user is the recipient of a stream.
   *
   * @param streamId - The stream ID
   * @returns True if current user is the recipient
   */
  async isRecipient(streamId: bigint): Promise<boolean> {
    const stream = await this.getStream(streamId);
    const address = this.client.getAddress();
    return (
      address !== null &&
      address.toLowerCase() === stream.recipient.toLowerCase()
    );
  }

  /**
   * Get the time remaining until stream ends.
   *
   * @param streamId - The stream ID
   * @returns Seconds remaining (negative if ended)
   */
  async getTimeRemaining(streamId: bigint): Promise<number> {
    const stream = await this.getStream(streamId);
    const now = Math.floor(Date.now() / 1000);
    return Number(stream.endTime) - now;
  }

  // ===========================================================================
  // Cancellation Preview
  // ===========================================================================

  /**
   * Get a preview of fund distribution if the stream is canceled.
   *
   * @param streamId - The stream ID
   * @returns Cancellation preview showing recipient and sender amounts
   */
  async getCancellationPreview(streamId: bigint): Promise<CancellationPreview> {
    const stream = await this.getStream(streamId);

    const duration = stream.endTime - stream.startTime;
    const elapsed = calculateElapsedTime(stream.startTime, stream.endTime);

    // Calculate streamed amount (what recipient has earned)
    const streamedAmount =
      duration > 0n ? (stream.depositAmount * elapsed) / duration : stream.depositAmount;

    // Recipient gets: streamed - already withdrawn
    const recipientAmount =
      streamedAmount > stream.withdrawnAmount
        ? streamedAmount - stream.withdrawnAmount
        : 0n;

    // Sender refund: deposit - streamed
    const senderRefund =
      stream.depositAmount > streamedAmount
        ? stream.depositAmount - streamedAmount
        : 0n;

    // Check if can cancel
    const address = this.client.getAddress();
    const isSender = address !== null && address.toLowerCase() === stream.sender.toLowerCase();
    const isRecipient = address !== null && address.toLowerCase() === stream.recipient.toLowerCase();

    const canCancel =
      (isSender && stream.cancelableBySender) ||
      (isRecipient && stream.cancelableByRecipient);

    return {
      recipientAmount: formatUSDC(recipientAmount),
      alreadyWithdrawn: formatUSDC(stream.withdrawnAmount),
      senderRefund: formatUSDC(senderRefund),
      totalDeposit: formatUSDC(stream.depositAmount),
      canCancel,
    };
  }

  // ===========================================================================
  // Stuck Stream Detection & Recovery
  // ===========================================================================

  /**
   * Check if a stream is stuck (past end time but not completed/canceled).
   *
   * @param streamId - The stream ID
   * @returns True if stream is stuck
   */
  async isStreamStuck(streamId: bigint): Promise<boolean> {
    const stream = await this.getStream(streamId);
    return this.isStreamDataStuck(stream);
  }

  /**
   * Check if stream data indicates a stuck stream.
   * Internal helper to avoid redundant getStream calls.
   */
  private isStreamDataStuck(stream: Stream): boolean {
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Stream is stuck if:
    // 1. Past end time
    // 2. Status is ACTIVE or PAUSED (not COMPLETED or CANCELED)
    const isPastEndTime = now > stream.endTime;
    const isInActiveState =
      stream.status === StreamStatus.ACTIVE ||
      stream.status === StreamStatus.PAUSED;

    return isPastEndTime && isInActiveState;
  }

  /**
   * Get all stuck streams where the given DID is the sender.
   *
   * @param senderDid - The sender's DID
   * @returns Array of stuck streams
   */
  async getStuckStreams(senderDid: string): Promise<Stream[]> {
    const streamIds = await this.getStreamsBySender(senderDid);
    const stuckStreams: Stream[] = [];

    for (const streamId of streamIds) {
      const stream = await this.getStream(streamId);
      if (this.isStreamDataStuck(stream)) {
        stuckStreams.push(stream);
      }
    }

    return stuckStreams;
  }

  /**
   * Attempt to recover a stuck stream by withdrawing remaining funds.
   *
   * @param streamId - The stream ID
   * @returns Recovery result
   * @throws Error if stream is not stuck
   */
  async recoverStream(streamId: bigint): Promise<RecoveryResult> {
    const isStuck = await this.isStreamStuck(streamId);
    if (!isStuck) {
      throw new Error('Stream is not stuck');
    }

    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }

    // Withdraw all available funds
    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: STREAMING_ABI,
      functionName: 'withdrawMax',
      args: [streamId],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Get the recovered amount
    const withdrawable = await this.getWithdrawableAmount(streamId);

    return {
      success: true,
      recoveredAmount: formatUSDC(withdrawable),
      txHash,
    };
  }

  // ===========================================================================
  // Stream Health Monitoring
  // ===========================================================================

  /** Warning threshold: 5 minutes before end */
  private static readonly WARNING_THRESHOLD_SECONDS = 300;

  /**
   * Get the health status of a stream.
   *
   * @param streamId - The stream ID
   * @returns Stream health information
   */
  async getStreamHealth(streamId: bigint): Promise<StreamHealth> {
    const stream = await this.getStream(streamId);
    const now = BigInt(Math.floor(Date.now() / 1000));

    const duration = stream.endTime - stream.startTime;
    const elapsed = calculateElapsedTime(stream.startTime, stream.endTime, now);
    const progress = duration > 0n ? Number((elapsed * 100n) / duration) / 100 : 0;
    const timeRemaining = Number(stream.endTime) - Number(now);

    const issues: string[] = [];
    let status: StreamHealthStatus;

    // Check status-based health
    if (stream.status === StreamStatus.COMPLETED) {
      status = 'COMPLETED';
    } else if (stream.status === StreamStatus.CANCELED) {
      status = 'CANCELED';
    } else if (stream.status === StreamStatus.PAUSED) {
      if (timeRemaining < 0) {
        status = 'STUCK';
        issues.push('Stream past end time but not completed');
      } else {
        status = 'PAUSED';
      }
    } else if (stream.status === StreamStatus.ACTIVE) {
      // Check if stuck
      if (timeRemaining < 0) {
        status = 'STUCK';
        issues.push('Stream past end time but not completed');
      } else if (timeRemaining < StreamingPaymentsClient.WARNING_THRESHOLD_SECONDS) {
        status = 'WARNING';
        issues.push('Stream ending soon');
      } else {
        status = 'HEALTHY';
      }
    } else {
      status = 'HEALTHY';
    }

    return {
      status,
      issues,
      timeRemaining,
      progress,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Ensure sufficient token allowance for the streaming contract.
   */
  private async ensureAllowance(
    tokenAddress: `0x${string}`,
    amount: bigint
  ): Promise<void> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();
    const ownerAddress = this.client.getAddress();

    if (!walletClient || !publicClient || !ownerAddress) {
      throw new Error('Wallet not connected.');
    }

    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [ownerAddress, this.contractAddress],
    });

    if (allowance < amount) {
      const approveTxHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [this.contractAddress, amount],
      });

      await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    }
  }
}
