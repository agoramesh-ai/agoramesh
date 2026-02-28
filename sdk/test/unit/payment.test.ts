/**
 * PaymentClient Unit Tests
 *
 * Tests for the escrow-based payment system between agents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toHex, encodeAbiParameters, pad, numberToHex } from 'viem';
import { PaymentClient } from '../../src/payment.js';
import { EscrowState, EscrowStateNames } from '../../src/types.js';
import type { AgoraMeshClient } from '../../src/client.js';
import type { Escrow, CreateEscrowOptions } from '../../src/types.js';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_CLIENT_DID = 'did:agoramesh:base:0xclient';
const TEST_PROVIDER_DID = 'did:agoramesh:base:0xprovider';
const TEST_ESCROW_ADDRESS = '0x7A582cf5e3e3326D4B13C8F0D60dCEa29b156b28' as `0x${string}`;
const TEST_USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const TEST_CLIENT_ADDRESS = '0x1234567890123456789012345678901234567890' as `0x${string}`;
const TEST_PROVIDER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const TEST_TASK_HASH = keccak256(toHex('test task description'));
const ESCROW_CREATED_SELECTOR = keccak256(toHex('EscrowCreated(uint256,bytes32,bytes32,uint256,uint256)'));

// =============================================================================
// Mock Helpers
// =============================================================================

function createMockEscrowCreatedLog(escrowId: bigint) {
  const clientDid = pad('0x01' as `0x${string}`, { size: 32 });
  const providerDid = pad('0x02' as `0x${string}`, { size: 32 });
  return {
    address: TEST_ESCROW_ADDRESS,
    topics: [
      ESCROW_CREATED_SELECTOR,
      pad(numberToHex(escrowId), { size: 32 }),
      clientDid,
      providerDid,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [100_000_000n, BigInt(Math.floor(Date.now() / 1000) + 86400)]
    ),
    blockNumber: 1n,
    transactionHash: '0xabc123' as `0x${string}`,
    transactionIndex: 0,
    blockHash: '0x0' as `0x${string}`,
    logIndex: 0,
    removed: false,
  };
}

function createMockClient(overrides: Partial<AgoraMeshClient> = {}): AgoraMeshClient {
  return {
    getWalletClient: vi.fn().mockReturnValue({
      writeContract: vi.fn().mockResolvedValue('0xtxhash'),
    }),
    getPublicClient: vi.fn().mockReturnValue({
      readContract: vi.fn().mockResolvedValue(1n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
    }),
    getContractAddresses: vi.fn().mockReturnValue({
      escrow: TEST_ESCROW_ADDRESS,
      usdc: TEST_USDC_ADDRESS,
    }),
    getAddress: vi.fn().mockReturnValue(TEST_CLIENT_ADDRESS),
    ...overrides,
  } as unknown as AgoraMeshClient;
}

function createMockEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 1n,
    clientDid: keccak256(toHex(TEST_CLIENT_DID)),
    providerDid: keccak256(toHex(TEST_PROVIDER_DID)),
    clientAddress: TEST_CLIENT_ADDRESS,
    providerAddress: TEST_PROVIDER_ADDRESS,
    amount: 100_000_000n, // 100 USDC
    token: TEST_USDC_ADDRESS,
    taskHash: TEST_TASK_HASH,
    outputHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400), // 24 hours from now
    state: EscrowState.FUNDED,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    deliveredAt: 0n,
    facilitator: ZERO_ADDRESS,
    ...overrides,
  };
}

function createDefaultEscrowOptions(): CreateEscrowOptions {
  return {
    providerDid: TEST_PROVIDER_DID,
    providerAddress: TEST_PROVIDER_ADDRESS,
    amount: '100',
    taskHash: TEST_TASK_HASH,
    deadline: Date.now() + 86400000, // 24 hours from now in ms
  };
}

// =============================================================================
// EscrowState Enum Tests
// =============================================================================

describe('EscrowState', () => {
  it('should have correct numeric values', () => {
    expect(EscrowState.AWAITING_DEPOSIT).toBe(0);
    expect(EscrowState.FUNDED).toBe(1);
    expect(EscrowState.DELIVERED).toBe(2);
    expect(EscrowState.DISPUTED).toBe(3);
    expect(EscrowState.RELEASED).toBe(4);
    expect(EscrowState.REFUNDED).toBe(5);
  });
});

describe('EscrowStateNames', () => {
  it('should have human-readable names for all states', () => {
    expect(EscrowStateNames[EscrowState.AWAITING_DEPOSIT]).toBe('Awaiting Deposit');
    expect(EscrowStateNames[EscrowState.FUNDED]).toBe('Funded');
    expect(EscrowStateNames[EscrowState.DELIVERED]).toBe('Delivered');
    expect(EscrowStateNames[EscrowState.DISPUTED]).toBe('Disputed');
    expect(EscrowStateNames[EscrowState.RELEASED]).toBe('Released');
    expect(EscrowStateNames[EscrowState.REFUNDED]).toBe('Refunded');
  });
});

// =============================================================================
// PaymentClient Tests
// =============================================================================

describe('PaymentClient', () => {
  describe('constructor', () => {
    it('should create a client with valid parameters', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      expect(payment).toBeInstanceOf(PaymentClient);
    });
  });

  // ===========================================================================
  // createEscrow
  // ===========================================================================

  describe('createEscrow', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.createEscrow(createDefaultEscrowOptions())).rejects.toThrow(
        'Wallet not connected'
      );
    });

    it('should throw if public client is not connected', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.createEscrow(createDefaultEscrowOptions())).rejects.toThrow(
        'Wallet not connected'
      );
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.createEscrow(createDefaultEscrowOptions())).rejects.toThrow(
        'Escrow address not configured'
      );
    });

    it('should throw if token address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ escrow: TEST_ESCROW_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.createEscrow(createDefaultEscrowOptions())).rejects.toThrow(
        'Token address not configured'
      );
    });

    it('should call writeContract with correct parameters', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockEscrowCreatedLog(1n)],
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.createEscrow(createDefaultEscrowOptions());

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TEST_ESCROW_ADDRESS,
          functionName: 'createEscrow',
        })
      );

      // Verify the args include correct DID hashes, provider address, token, amount, etc.
      const callArgs = writeContract.mock.calls[0]![0].args;
      expect(callArgs[0]).toBe(keccak256(toHex(TEST_CLIENT_DID))); // clientDidHash
      expect(callArgs[1]).toBe(keccak256(toHex(TEST_PROVIDER_DID))); // providerDidHash
      expect(callArgs[2]).toBe(TEST_PROVIDER_ADDRESS); // providerAddress
      expect(callArgs[3]).toBe(TEST_USDC_ADDRESS); // token
      expect(callArgs[4]).toBe(100_000_000n); // amount (100 USDC)
      expect(callArgs[5]).toBe(TEST_TASK_HASH); // taskHash
      expect(callArgs[7]).toBe(ZERO_ADDRESS); // facilitator defaults to zero
    });

    it('should return escrow ID from event log', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockEscrowCreatedLog(42n)],
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const escrowId = await payment.createEscrow(createDefaultEscrowOptions());

      expect(escrowId).toBe(42n);
    });

    it('should throw if no EscrowCreated event in receipt', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [], // No matching logs
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.createEscrow(createDefaultEscrowOptions())).rejects.toThrow(
        'EscrowCreated event not found'
      );
    });

    it('should use custom token address when provided', async () => {
      const customToken = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockEscrowCreatedLog(1n)],
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.createEscrow({
        ...createDefaultEscrowOptions(),
        tokenAddress: customToken,
      });

      const callArgs = writeContract.mock.calls[0]![0].args;
      expect(callArgs[3]).toBe(customToken);
    });

    it('should use custom facilitator when provided', async () => {
      const facilitator = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockEscrowCreatedLog(1n)],
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.createEscrow({
        ...createDefaultEscrowOptions(),
        facilitator,
      });

      const callArgs = writeContract.mock.calls[0]![0].args;
      expect(callArgs[7]).toBe(facilitator);
    });
  });

  // ===========================================================================
  // createAndFundEscrow
  // ===========================================================================

  describe('createAndFundEscrow', () => {
    it('should create and fund escrow in sequence', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const readContract = vi.fn()
        .mockResolvedValueOnce(createMockEscrow({ state: EscrowState.AWAITING_DEPOSIT }))
        .mockResolvedValueOnce(100_000_000n); // allowance check

      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          readContract,
          waitForTransactionReceipt: vi.fn().mockResolvedValue({
            logs: [createMockEscrowCreatedLog(5n)],
          }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const escrowId = await payment.createAndFundEscrow(createDefaultEscrowOptions());

      expect(escrowId).toBe(5n);
      // Should have been called at least twice: createEscrow + fundEscrow
      expect(writeContract).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // fundEscrow
  // ===========================================================================

  describe('fundEscrow', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.fundEscrow(1n)).rejects.toThrow('Wallet not connected');
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.fundEscrow(1n)).rejects.toThrow('Escrow address not configured');
    });

    it('should approve token if allowance is insufficient', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const readContract = vi.fn()
        .mockResolvedValueOnce(createMockEscrow({ amount: 100_000_000n })) // getEscrow
        .mockResolvedValueOnce(0n); // allowance (zero = needs approval)

      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          readContract,
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.fundEscrow(1n);

      // First call: approve, second call: fundEscrow
      expect(writeContract).toHaveBeenCalledTimes(2);
      expect(writeContract.mock.calls[0]![0].functionName).toBe('approve');
      expect(writeContract.mock.calls[1]![0].functionName).toBe('fundEscrow');
    });

    it('should skip approval if allowance is sufficient', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const readContract = vi.fn()
        .mockResolvedValueOnce(createMockEscrow({ amount: 100_000_000n })) // getEscrow
        .mockResolvedValueOnce(200_000_000n); // allowance (more than enough)

      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
        getPublicClient: vi.fn().mockReturnValue({
          readContract,
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.fundEscrow(1n);

      // Only fundEscrow, no approve
      expect(writeContract).toHaveBeenCalledTimes(1);
      expect(writeContract.mock.calls[0]![0].functionName).toBe('fundEscrow');
    });

    it('should return transaction hash', async () => {
      const readContract = vi.fn()
        .mockResolvedValueOnce(createMockEscrow({ amount: 100_000_000n }))
        .mockResolvedValueOnce(200_000_000n); // sufficient allowance

      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({
          writeContract: vi.fn().mockResolvedValue('0xfundtxhash'),
        }),
        getPublicClient: vi.fn().mockReturnValue({
          readContract,
          waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [] }),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const txHash = await payment.fundEscrow(1n);

      expect(txHash).toBe('0xfundtxhash');
    });
  });

  // ===========================================================================
  // confirmDelivery
  // ===========================================================================

  describe('confirmDelivery', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const outputHash = keccak256(toHex('output data'));

      await expect(payment.confirmDelivery(1n, outputHash)).rejects.toThrow(
        'Wallet not connected'
      );
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const outputHash = keccak256(toHex('output data'));

      await expect(payment.confirmDelivery(1n, outputHash)).rejects.toThrow(
        'Escrow address not configured'
      );
    });

    it('should call writeContract with correct parameters', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const outputHash = keccak256(toHex('output data'));

      await payment.confirmDelivery(1n, outputHash);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TEST_ESCROW_ADDRESS,
          functionName: 'confirmDelivery',
          args: [1n, outputHash],
        })
      );
    });
  });

  // ===========================================================================
  // releaseEscrow
  // ===========================================================================

  describe('releaseEscrow', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.releaseEscrow(1n)).rejects.toThrow('Wallet not connected');
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.releaseEscrow(1n)).rejects.toThrow('Escrow address not configured');
    });

    it('should call writeContract with correct parameters', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const txHash = await payment.releaseEscrow(1n);

      expect(txHash).toBe('0xtxhash');
      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TEST_ESCROW_ADDRESS,
          functionName: 'releaseEscrow',
          args: [1n],
        })
      );
    });
  });

  // ===========================================================================
  // claimTimeout
  // ===========================================================================

  describe('claimTimeout', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.claimTimeout(1n)).rejects.toThrow('Wallet not connected');
    });

    it('should call writeContract with correct parameters', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const txHash = await payment.claimTimeout(1n);

      expect(txHash).toBe('0xtxhash');
      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'claimTimeout',
          args: [1n],
        })
      );
    });
  });

  // ===========================================================================
  // initiateDispute
  // ===========================================================================

  describe('initiateDispute', () => {
    it('should throw if wallet is not connected', async () => {
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.initiateDispute(1n)).rejects.toThrow('Wallet not connected');
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.initiateDispute(1n)).rejects.toThrow('Escrow address not configured');
    });

    it('should call writeContract with default empty evidence', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await payment.initiateDispute(1n);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'initiateDispute',
          args: [1n, '0x'],
        })
      );
    });

    it('should call writeContract with provided evidence', async () => {
      const writeContract = vi.fn().mockResolvedValue('0xtxhash');
      const mockClient = createMockClient({
        getWalletClient: vi.fn().mockReturnValue({ writeContract }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const evidence = '0xdeadbeef' as `0x${string}`;

      await payment.initiateDispute(1n, evidence);

      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'initiateDispute',
          args: [1n, evidence],
        })
      );
    });
  });

  // ===========================================================================
  // getEscrow
  // ===========================================================================

  describe('getEscrow', () => {
    it('should throw if client is not connected', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue(null),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.getEscrow(1n)).rejects.toThrow('Client is not connected');
    });

    it('should throw if escrow address is not configured', async () => {
      const mockClient = createMockClient({
        getContractAddresses: vi.fn().mockReturnValue({ usdc: TEST_USDC_ADDRESS }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      await expect(payment.getEscrow(1n)).rejects.toThrow('Escrow address not configured');
    });

    it('should return parsed escrow data', async () => {
      const escrowData = {
        id: 1n,
        clientDid: keccak256(toHex(TEST_CLIENT_DID)),
        providerDid: keccak256(toHex(TEST_PROVIDER_DID)),
        clientAddress: TEST_CLIENT_ADDRESS,
        providerAddress: TEST_PROVIDER_ADDRESS,
        amount: 100_000_000n,
        token: TEST_USDC_ADDRESS,
        taskHash: TEST_TASK_HASH,
        outputHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        deadline: 1700100000n,
        state: 1,
        createdAt: 1700000000n,
        deliveredAt: 0n,
        facilitator: ZERO_ADDRESS,
      };

      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(escrowData),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const escrow = await payment.getEscrow(1n);

      expect(escrow.id).toBe(1n);
      expect(escrow.amount).toBe(100_000_000n);
      expect(escrow.state).toBe(EscrowState.FUNDED);
      expect(escrow.clientAddress).toBe(TEST_CLIENT_ADDRESS);
      expect(escrow.providerAddress).toBe(TEST_PROVIDER_ADDRESS);
      expect(escrow.token).toBe(TEST_USDC_ADDRESS);
    });
  });

  // ===========================================================================
  // canClaimTimeout
  // ===========================================================================

  describe('canClaimTimeout', () => {
    it('should return true when escrow is funded and deadline passed', async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({
              state: EscrowState.FUNDED,
              deadline: pastDeadline,
            })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const canClaim = await payment.canClaimTimeout(1n);

      expect(canClaim).toBe(true);
    });

    it('should return false when deadline has not passed', async () => {
      const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 86400); // 24 hours from now
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({
              state: EscrowState.FUNDED,
              deadline: futureDeadline,
            })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const canClaim = await payment.canClaimTimeout(1n);

      expect(canClaim).toBe(false);
    });

    it('should return false when escrow is not in FUNDED state', async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({
              state: EscrowState.RELEASED,
              deadline: pastDeadline,
            })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const canClaim = await payment.canClaimTimeout(1n);

      expect(canClaim).toBe(false);
    });

    it('should return false for AWAITING_DEPOSIT state even with passed deadline', async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({
              state: EscrowState.AWAITING_DEPOSIT,
              deadline: pastDeadline,
            })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const canClaim = await payment.canClaimTimeout(1n);

      expect(canClaim).toBe(false);
    });
  });

  // ===========================================================================
  // getTimeUntilDeadline
  // ===========================================================================

  describe('getTimeUntilDeadline', () => {
    it('should return positive seconds for future deadline', async () => {
      const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ deadline: futureDeadline })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const remaining = await payment.getTimeUntilDeadline(1n);

      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(3600);
    });

    it('should return negative seconds for past deadline', async () => {
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600);
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ deadline: pastDeadline })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const remaining = await payment.getTimeUntilDeadline(1n);

      expect(remaining).toBeLessThan(0);
    });
  });

  // ===========================================================================
  // getEscrowAmount
  // ===========================================================================

  describe('getEscrowAmount', () => {
    it('should return formatted USDC amount', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ amount: 100_000_000n }) // 100 USDC
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const amount = await payment.getEscrowAmount(1n);

      expect(amount).toBe('100');
    });

    it('should format fractional amounts', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ amount: 50_500_000n }) // 50.5 USDC
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const amount = await payment.getEscrowAmount(1n);

      expect(amount).toBe('50.5');
    });
  });

  // ===========================================================================
  // getEscrowStateName
  // ===========================================================================

  describe('getEscrowStateName', () => {
    it('should return state name for FUNDED escrow', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ state: EscrowState.FUNDED })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const name = await payment.getEscrowStateName(1n);

      expect(name).toBe('Funded');
    });

    it('should return state name for DISPUTED escrow', async () => {
      const mockClient = createMockClient({
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ state: EscrowState.DISPUTED })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const name = await payment.getEscrowStateName(1n);

      expect(name).toBe('Disputed');
    });
  });

  // ===========================================================================
  // isClient / isProvider
  // ===========================================================================

  describe('isClient', () => {
    it('should return true when current user is the client', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(TEST_CLIENT_ADDRESS),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ clientAddress: TEST_CLIENT_ADDRESS })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isClient(1n);

      expect(result).toBe(true);
    });

    it('should return false when current user is not the client', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(TEST_PROVIDER_ADDRESS),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ clientAddress: TEST_CLIENT_ADDRESS })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isClient(1n);

      expect(result).toBe(false);
    });

    it('should return false when address is null', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(null),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(createMockEscrow()),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isClient(1n);

      expect(result).toBe(false);
    });

    it('should be case-insensitive for address comparison', async () => {
      const upperCaseAddress = TEST_CLIENT_ADDRESS.toUpperCase() as `0x${string}`;
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(upperCaseAddress),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ clientAddress: TEST_CLIENT_ADDRESS })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isClient(1n);

      expect(result).toBe(true);
    });
  });

  describe('isProvider', () => {
    it('should return true when current user is the provider', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(TEST_PROVIDER_ADDRESS),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ providerAddress: TEST_PROVIDER_ADDRESS })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isProvider(1n);

      expect(result).toBe(true);
    });

    it('should return false when current user is not the provider', async () => {
      const mockClient = createMockClient({
        getAddress: vi.fn().mockReturnValue(TEST_CLIENT_ADDRESS),
        getPublicClient: vi.fn().mockReturnValue({
          readContract: vi.fn().mockResolvedValue(
            createMockEscrow({ providerAddress: TEST_PROVIDER_ADDRESS })
          ),
        }),
      });
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const result = await payment.isProvider(1n);

      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // formatEscrow
  // ===========================================================================

  describe('formatEscrow', () => {
    it('should format escrow for display', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const escrow = createMockEscrow({
        id: 42n,
        amount: 100_000_000n,
        state: EscrowState.FUNDED,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.id).toBe('42');
      expect(formatted.amount).toBe('100');
      expect(formatted.state).toBe('Funded');
      expect(formatted.deadline).toBeInstanceOf(Date);
      expect(formatted.isOverdue).toBe(false);
    });

    it('should mark funded escrow as overdue when deadline passed', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const escrow = createMockEscrow({
        state: EscrowState.FUNDED,
        deadline: BigInt(Math.floor(Date.now() / 1000) - 3600), // 1 hour ago
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.isOverdue).toBe(true);
    });

    it('should not mark non-funded escrow as overdue even with passed deadline', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const escrow = createMockEscrow({
        state: EscrowState.RELEASED,
        deadline: BigInt(Math.floor(Date.now() / 1000) - 3600),
      });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.isOverdue).toBe(false);
    });

    it('should format deadline as Date object', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);
      const deadlineUnix = 1700100000n;
      const escrow = createMockEscrow({ deadline: deadlineUnix });

      const formatted = payment.formatEscrow(escrow);

      expect(formatted.deadline.getTime()).toBe(Number(deadlineUnix) * 1000);
    });

    it('should handle all escrow states', () => {
      const mockClient = createMockClient();
      const payment = new PaymentClient(mockClient, TEST_CLIENT_DID);

      const states = [
        EscrowState.AWAITING_DEPOSIT,
        EscrowState.FUNDED,
        EscrowState.DELIVERED,
        EscrowState.DISPUTED,
        EscrowState.RELEASED,
        EscrowState.REFUNDED,
      ];

      for (const state of states) {
        const escrow = createMockEscrow({ state });
        const formatted = payment.formatEscrow(escrow);
        expect(formatted.state).toBe(EscrowStateNames[state]);
      }
    });
  });
});
