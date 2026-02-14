/**
 * Unit tests for StreamingPaymentsClient
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toHex, encodeAbiParameters, pad, numberToHex } from 'viem';
import {
  StreamingPaymentsClient,
  StreamStatus,
  StreamStatusNames,
  type Stream,
  type CreateStreamOptions,
} from '../../src/streaming.js';
import type { AgentMeClient } from '../../src/client.js';

const STREAM_CREATED_SELECTOR = keccak256(toHex('StreamCreated(uint256,bytes32,bytes32,uint256,uint256)'));

function createMockStreamCreatedLog(streamId: bigint) {
  const senderDid = pad('0x01' as `0x${string}`, { size: 32 });
  const recipientDid = pad('0x02' as `0x${string}`, { size: 32 });
  return {
    address: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    topics: [
      STREAM_CREATED_SELECTOR,
      pad(numberToHex(streamId), { size: 32 }),
      senderDid,
      recipientDid,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [100_000_000n, 3600n]
    ),
    blockNumber: 1n,
    transactionHash: '0x0' as `0x${string}`,
    transactionIndex: 0,
    blockHash: '0x0' as `0x${string}`,
    logIndex: 0,
    removed: false,
  };
}

// =============================================================================
// Mocks
// =============================================================================

function createMockClient(overrides: Partial<AgentMeClient> = {}): AgentMeClient {
  return {
    getWalletClient: vi.fn().mockReturnValue({
      writeContract: vi.fn().mockResolvedValue('0xtxhash'),
    }),
    getPublicClient: vi.fn().mockReturnValue({
      readContract: vi.fn().mockResolvedValue(1n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
    }),
    getContractAddresses: vi.fn().mockReturnValue({
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
    }),
    getAddress: vi.fn().mockReturnValue('0x1234567890123456789012345678901234567890' as `0x${string}`),
    ...overrides,
  } as unknown as AgentMeClient;
}

function createMockStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 1n,
    senderDid: '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`,
    recipientDid: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    sender: '0x1234567890123456789012345678901234567890' as `0x${string}`,
    recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
    depositAmount: 100_000_000n, // 100 USDC
    withdrawnAmount: 0n,
    startTime: BigInt(Math.floor(Date.now() / 1000) - 1800), // 30 mins ago
    endTime: BigInt(Math.floor(Date.now() / 1000) + 1800), // 30 mins from now
    ratePerSecond: 27777n, // ~100 USDC per hour
    status: StreamStatus.ACTIVE,
    cancelableBySender: true,
    cancelableByRecipient: false,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('StreamingPaymentsClient', () => {
  const STREAMING_ADDRESS = '0x9876543210987654321098765432109876543210' as `0x${string}`;

  describe('constructor', () => {
    it('should create a client with valid parameters', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      expect(streaming).toBeInstanceOf(StreamingPaymentsClient);
    });
  });

  describe('StreamStatus enum', () => {
    it('should have correct values', () => {
      expect(StreamStatus.NONE).toBe(0);
      expect(StreamStatus.ACTIVE).toBe(1);
      expect(StreamStatus.PAUSED).toBe(2);
      expect(StreamStatus.CANCELED).toBe(3);
      expect(StreamStatus.COMPLETED).toBe(4);
    });
  });

  describe('StreamStatusNames', () => {
    it('should have names for all statuses', () => {
      expect(StreamStatusNames[StreamStatus.NONE]).toBe('None');
      expect(StreamStatusNames[StreamStatus.ACTIVE]).toBe('Active');
      expect(StreamStatusNames[StreamStatus.PAUSED]).toBe('Paused');
      expect(StreamStatusNames[StreamStatus.CANCELED]).toBe('Canceled');
      expect(StreamStatusNames[StreamStatus.COMPLETED]).toBe('Completed');
    });
  });

  describe('createStream', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(
        streaming.createStream({
          recipientDid: 'did:agentme:base:0xtest',
          recipientAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
          amount: '100',
          duration: 3600,
        })
      ).rejects.toThrow('Wallet not connected');
    });

    it('should throw if token address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({}),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(
        streaming.createStream({
          recipientDid: 'did:agentme:base:0xtest',
          recipientAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
          amount: '100',
          duration: 3600,
        })
      ).rejects.toThrow('Token address not configured');
    });

    it('should use default cancelability settings', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(2n),
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockStreamCreatedLog(1n)],
          }),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await streaming.createStream({
        recipientDid: 'did:agentme:base:0xtest',
        recipientAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
        amount: '100',
        duration: 3600,
      });

      // Check that cancelableBySender defaults to true, cancelableByRecipient to false
      const lastCall = writeContract.mock.calls[writeContract.mock.calls.length - 1];
      expect(lastCall[0].args[5]).toBe(true); // cancelableBySender
      expect(lastCall[0].args[6]).toBe(false); // cancelableByRecipient
    });

    it('should return the created stream ID', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(5n),
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockStreamCreatedLog(4n)],
          }),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const streamId = await streaming.createStream({
        recipientDid: 'did:agentme:base:0xtest',
        recipientAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
        amount: '100',
        duration: 3600,
      });

      expect(streamId).toBe(4n); // from StreamCreated event log
    });
  });

  describe('withdraw', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(streaming.withdraw(1n, '50')).rejects.toThrow('Wallet not connected');
    });

    it('should call writeContract with correct parameters', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await streaming.withdraw(1n, '50');

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: STREAMING_ADDRESS,
          functionName: 'withdraw',
          args: [1n, 50_000_000n], // 50 USDC with 6 decimals
        })
      );
    });
  });

  describe('pause', () => {
    it('should call pause on the contract', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await streaming.pause(1n);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'pause',
          args: [1n],
        })
      );
    });
  });

  describe('resume', () => {
    it('should call resume on the contract', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await streaming.resume(1n);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'resume',
          args: [1n],
        })
      );
    });
  });

  describe('cancel', () => {
    it('should call cancel on the contract', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await streaming.cancel(1n);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'cancel',
          args: [1n],
        })
      );
    });
  });

  describe('topUp', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(streaming.topUp(1n, '50')).rejects.toThrow('Wallet not connected');
    });
  });

  describe('getStream', () => {
    it('should throw if client is not connected', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue(null),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(streaming.getStream(1n)).rejects.toThrow('Client is not connected');
    });

    it('should return parsed stream data', async () => {
      const mockStreamData = {
        id: 1n,
        senderDid: '0x1234' as `0x${string}`,
        recipientDid: '0xabcd' as `0x${string}`,
        sender: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        recipient: '0x2222222222222222222222222222222222222222' as `0x${string}`,
        token: '0x3333333333333333333333333333333333333333' as `0x${string}`,
        depositAmount: 100_000_000n,
        withdrawnAmount: 25_000_000n,
        startTime: 1700000000n,
        endTime: 1700003600n,
        ratePerSecond: 27777n,
        status: 1,
        cancelableBySender: true,
        cancelableByRecipient: false,
      };

      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(mockStreamData),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const stream = await streaming.getStream(1n);

      expect(stream.id).toBe(1n);
      expect(stream.depositAmount).toBe(100_000_000n);
      expect(stream.withdrawnAmount).toBe(25_000_000n);
      expect(stream.status).toBe(StreamStatus.ACTIVE);
      expect(stream.cancelableBySender).toBe(true);
      expect(stream.cancelableByRecipient).toBe(false);
    });
  });

  describe('isActive', () => {
    it('should return true for active stream', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(true),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isActive = await streaming.isActive(1n);

      expect(isActive).toBe(true);
    });

    it('should return false for inactive stream', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(false),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isActive = await streaming.isActive(1n);

      expect(isActive).toBe(false);
    });
  });

  describe('getStreamsBySender', () => {
    it('should return array of stream IDs', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue([1n, 2n, 5n]),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const streamIds = await streaming.getStreamsBySender('did:agentme:base:0xtest');

      expect(streamIds).toEqual([1n, 2n, 5n]);
    });
  });

  describe('getStreamsByRecipient', () => {
    it('should return array of stream IDs', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue([3n, 4n]),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const streamIds = await streaming.getStreamsByRecipient('did:agentme:base:0xprovider');

      expect(streamIds).toEqual([3n, 4n]);
    });
  });

  describe('formatStream', () => {
    it('should format stream correctly', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const stream = createMockStream();
      const formatted = streaming.formatStream(stream);

      expect(formatted.id).toBe('1');
      expect(formatted.depositAmount).toBe('100'); // 100 USDC
      expect(formatted.withdrawnAmount).toBe('0');
      expect(formatted.status).toBe('Active');
      expect(formatted.isActive).toBe(true);
      expect(formatted.progress).toBeGreaterThanOrEqual(0);
      expect(formatted.progress).toBeLessThanOrEqual(1);
    });

    it('should show correct progress at 50%', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const now = BigInt(Math.floor(Date.now() / 1000));
      const stream = createMockStream({
        startTime: now - 1800n, // 30 mins ago
        endTime: now + 1800n, // 30 mins from now
      });

      const formatted = streaming.formatStream(stream);

      // Should be approximately 50% (allowing for timing variance)
      expect(formatted.progress).toBeGreaterThan(0.4);
      expect(formatted.progress).toBeLessThan(0.6);
    });

    it('should show 0% progress before start', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const now = BigInt(Math.floor(Date.now() / 1000));
      const stream = createMockStream({
        startTime: now + 3600n, // 1 hour from now
        endTime: now + 7200n, // 2 hours from now
      });

      const formatted = streaming.formatStream(stream);

      expect(formatted.progress).toBe(0);
    });

    it('should show 100% progress after end', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const now = BigInt(Math.floor(Date.now() / 1000));
      const stream = createMockStream({
        startTime: now - 7200n, // 2 hours ago
        endTime: now - 3600n, // 1 hour ago
      });

      const formatted = streaming.formatStream(stream);

      expect(formatted.progress).toBe(1);
    });
  });

  describe('calculateRate', () => {
    it('should calculate rate per second correctly', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      // 100 USDC over 3600 seconds (1 hour)
      const rate = streaming.calculateRate('100', 3600);

      // 100 / 3600 = 0.027777...
      expect(parseFloat(rate)).toBeCloseTo(0.027777, 4);
    });

    it('should handle large amounts', () => {
      const mockClient = createMockClient();
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      // 10000 USDC over 86400 seconds (1 day)
      const rate = streaming.calculateRate('10000', 86400);

      // 10000 / 86400 = ~0.115740
      expect(parseFloat(rate)).toBeCloseTo(0.115740, 4);
    });
  });

  describe('isSender', () => {
    it('should return true when user is sender', async () => {
      const userAddress = '0x1234567890123456789012345678901234567890' as `0x${string}`;
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(userAddress),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ sender: userAddress })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isSender = await streaming.isSender(1n);

      expect(isSender).toBe(true);
    });

    it('should return false when user is not sender', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue('0xaaaabbbbccccddddeeeeffffgggghhhhiiiijjjj' as `0x${string}`),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ sender: '0x1234567890123456789012345678901234567890' as `0x${string}` })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isSender = await streaming.isSender(1n);

      expect(isSender).toBe(false);
    });
  });

  describe('isRecipient', () => {
    it('should return true when user is recipient', async () => {
      const userAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(userAddress),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ recipient: userAddress })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isRecipient = await streaming.isRecipient(1n);

      expect(isRecipient).toBe(true);
    });
  });

  describe('getTimeRemaining', () => {
    it('should return positive seconds for active stream', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ endTime: now + 1800n }) // 30 mins from now
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const remaining = await streaming.getTimeRemaining(1n);

      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(1800);
    });

    it('should return negative seconds for ended stream', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ endTime: now - 1800n }) // 30 mins ago
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const remaining = await streaming.getTimeRemaining(1n);

      expect(remaining).toBeLessThan(0);
    });
  });

  // ===========================================================================
  // Cancellation Fee Calculation Tests
  // ===========================================================================

  describe('getCancellationPreview', () => {
    it('should calculate amounts for recipient and sender at 50% progress', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              depositAmount: 100_000_000n, // 100 USDC
              withdrawnAmount: 0n,
              startTime: now - 1800n, // 30 mins ago
              endTime: now + 1800n, // 30 mins from now
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const preview = await streaming.getCancellationPreview(1n);

      // At 50% progress: recipient gets ~50 USDC, sender gets ~50 USDC
      expect(parseFloat(preview.recipientAmount)).toBeCloseTo(50, 0);
      expect(parseFloat(preview.senderRefund)).toBeCloseTo(50, 0);
      expect(preview.totalDeposit).toBe('100');
    });

    it('should account for already withdrawn amounts', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              depositAmount: 100_000_000n, // 100 USDC
              withdrawnAmount: 25_000_000n, // 25 USDC already withdrawn
              startTime: now - 1800n,
              endTime: now + 1800n,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const preview = await streaming.getCancellationPreview(1n);

      // At 50% progress: ~50 USDC streamed, 25 already withdrawn
      // Recipient gets: 50 - 25 = ~25 USDC more
      // Sender refund: 100 - 50 = ~50 USDC
      expect(parseFloat(preview.recipientAmount)).toBeCloseTo(25, 0);
      expect(parseFloat(preview.alreadyWithdrawn)).toBe(25);
    });

    it('should show zero refund when stream is complete', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              depositAmount: 100_000_000n,
              withdrawnAmount: 0n,
              startTime: now - 7200n, // 2 hours ago
              endTime: now - 3600n, // 1 hour ago (completed)
              status: StreamStatus.COMPLETED,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const preview = await streaming.getCancellationPreview(1n);

      // Completed stream: all goes to recipient
      expect(preview.senderRefund).toBe('0');
      expect(preview.recipientAmount).toBe('100');
    });
  });

  // ===========================================================================
  // Stuck Stream Recovery Tests
  // ===========================================================================

  describe('isStreamStuck', () => {
    it('should return true for stream past end time but still ACTIVE', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              endTime: now - 3600n, // 1 hour ago
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isStuck = await streaming.isStreamStuck(1n);

      expect(isStuck).toBe(true);
    });

    it('should return false for active stream before end time', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              endTime: now + 3600n, // 1 hour from now
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isStuck = await streaming.isStreamStuck(1n);

      expect(isStuck).toBe(false);
    });

    it('should return false for completed stream', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.COMPLETED,
              endTime: now - 3600n,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isStuck = await streaming.isStreamStuck(1n);

      expect(isStuck).toBe(false);
    });

    it('should return true for PAUSED stream past end time', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.PAUSED,
              endTime: now - 3600n,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const isStuck = await streaming.isStreamStuck(1n);

      expect(isStuck).toBe(true);
    });
  });

  describe('getStuckStreams', () => {
    it('should return all stuck streams for a sender DID', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const readContract = vi.fn()
        .mockResolvedValueOnce([1n, 2n, 3n]) // Stream IDs
        .mockResolvedValueOnce(createMockStream({ id: 1n, status: StreamStatus.ACTIVE, endTime: now - 3600n })) // Stuck
        .mockResolvedValueOnce(createMockStream({ id: 2n, status: StreamStatus.COMPLETED, endTime: now - 3600n })) // Not stuck
        .mockResolvedValueOnce(createMockStream({ id: 3n, status: StreamStatus.ACTIVE, endTime: now - 7200n })); // Stuck

      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({ readContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const stuckStreams = await streaming.getStuckStreams('did:agentme:base:0xsender');

      expect(stuckStreams).toHaveLength(2);
      expect(stuckStreams.map(s => s.id)).toEqual([1n, 3n]);
    });

    it('should return empty array when no stuck streams', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const readContract = vi.fn()
        .mockResolvedValueOnce([1n]) // Stream IDs
        .mockResolvedValueOnce(createMockStream({ id: 1n, status: StreamStatus.COMPLETED }));

      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({ readContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const stuckStreams = await streaming.getStuckStreams('did:agentme:base:0xsender');

      expect(stuckStreams).toHaveLength(0);
    });
  });

  describe('recoverStream', () => {
    it('should withdraw max and return recovered amount for stuck stream', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const readContract = vi.fn()
        .mockResolvedValueOnce(createMockStream({
          status: StreamStatus.ACTIVE,
          endTime: now - 3600n,
          depositAmount: 100_000_000n,
          withdrawnAmount: 0n,
        }))
        .mockResolvedValueOnce(100_000_000n); // withdrawable amount

      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract,
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
        }),
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const result = await streaming.recoverStream(1n);

      expect(result.success).toBe(true);
      expect(result.recoveredAmount).toBe('100');
      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'withdrawMax',
        })
      );
    });

    it('should throw if stream is not stuck', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              endTime: now + 3600n, // Still running
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      await expect(streaming.recoverStream(1n)).rejects.toThrow('Stream is not stuck');
    });
  });

  // ===========================================================================
  // Stream Health Monitoring Tests
  // ===========================================================================

  describe('getStreamHealth', () => {
    it('should return HEALTHY for active stream with normal progress', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              startTime: now - 1800n,
              endTime: now + 1800n,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const health = await streaming.getStreamHealth(1n);

      expect(health.status).toBe('HEALTHY');
      expect(health.issues).toHaveLength(0);
    });

    it('should return STUCK for stream past end time', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              endTime: now - 3600n,
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const health = await streaming.getStreamHealth(1n);

      expect(health.status).toBe('STUCK');
      expect(health.issues).toContain('Stream past end time but not completed');
    });

    it('should return WARNING for stream with low remaining time', async () => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({
              status: StreamStatus.ACTIVE,
              endTime: now + 60n, // Only 60 seconds left
            })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const health = await streaming.getStreamHealth(1n);

      expect(health.status).toBe('WARNING');
      expect(health.issues).toContain('Stream ending soon');
    });

    it('should return COMPLETED for finished stream', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockStream({ status: StreamStatus.COMPLETED })
          ),
        }),
      });
      const streaming = new StreamingPaymentsClient(mockClient, {
        streamingPaymentsAddress: STREAMING_ADDRESS,
      });

      const health = await streaming.getStreamHealth(1n);

      expect(health.status).toBe('COMPLETED');
    });
  });
});
