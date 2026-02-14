/**
 * Escrow Integration Module
 *
 * Integrates the Bridge with AgentMeEscrow contract for:
 * - Validating escrow status before task execution
 * - Confirming delivery after task completion
 * - Generating output hashes for verification
 *
 * @see contracts/src/AgentMeEscrow.sol
 */

import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, foundry } from 'viem/chains';
import { EscrowNotFoundError, EscrowOperationError, type Result, success, failure } from './errors.js';

/**
 * Escrow state enum matching the Solidity contract
 */
export enum EscrowState {
  AWAITING_DEPOSIT = 0,
  FUNDED = 1,
  DELIVERED = 2,
  DISPUTED = 3,
  RELEASED = 4,
  REFUNDED = 5,
}

/**
 * Escrow data structure from the contract
 */
export interface Escrow {
  id: bigint;
  clientDid: `0x${string}`;
  providerDid: `0x${string}`;
  clientAddress: `0x${string}`;
  providerAddress: `0x${string}`;
  amount: bigint;
  token: `0x${string}`;
  taskHash: `0x${string}`;
  outputHash: `0x${string}`;
  deadline: bigint;
  state: EscrowState;
  createdAt: bigint;
  deliveredAt: bigint;
}

/**
 * Configuration for escrow client
 */
export interface EscrowConfig {
  /** Address of the AgentMeEscrow contract */
  escrowAddress: `0x${string}`;
  /** RPC URL for the chain */
  rpcUrl: string;
  /** Private key for signing transactions (optional, required for confirmDelivery) */
  privateKey?: `0x${string}`;
  /** Chain ID (8453 for Base Mainnet, 84532 for Base Sepolia) */
  chainId?: number;
}

/**
 * Result of escrow validation
 */
export interface EscrowValidation {
  valid: boolean;
  error?: string;
  escrow?: Escrow;
}

// ABI fragments for the escrow contract
const ESCROW_ABI = [
  {
    name: 'getEscrow',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'clientDid', type: 'bytes32' },
          { name: 'providerDid', type: 'bytes32' },
          { name: 'clientAddress', type: 'address' },
          { name: 'providerAddress', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'taskHash', type: 'bytes32' },
          { name: 'outputHash', type: 'bytes32' },
          { name: 'deadline', type: 'uint256' },
          { name: 'state', type: 'uint8' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'deliveredAt', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'confirmDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'outputHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/**
 * Escrow Client for interacting with AgentMeEscrow contract
 *
 * @example
 * ```typescript
 * const client = new EscrowClient({
 *   escrowAddress: '0x...',
 *   rpcUrl: 'https://mainnet.base.org',
 *   privateKey: '0x...',
 * });
 *
 * // Validate before task execution
 * const validation = await client.validateEscrow(escrowId, providerDid);
 * if (!validation.valid) {
 *   throw new Error(validation.error);
 * }
 *
 * // Confirm delivery after task completion
 * await client.confirmDelivery(escrowId, taskOutput);
 * ```
 */
export class EscrowClient {
  private readonly config: EscrowConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's chain-parameterized generics are impractical to thread through
  private readonly publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's chain-parameterized generics are impractical to thread through
  private readonly walletClient?: any;
  private readonly account?: ReturnType<typeof privateKeyToAccount>;

  constructor(config: EscrowConfig) {
    this.config = config;

    // Determine chain (31337 = local Anvil for development)
    const chain =
      config.chainId === 31337 ? foundry
      : config.chainId === 84532 ? baseSepolia
      : base;

    // Create public client for reads
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    // Create wallet client for writes (if private key provided)
    if (config.privateKey) {
      this.account = privateKeyToAccount(config.privateKey);
      this.walletClient = createWalletClient({
        chain,
        transport: http(config.rpcUrl),
        account: this.account,
      });
    }
  }

  /**
   * Get escrow details by ID
   *
   * @returns Result with Escrow on success, or typed error on failure
   */
  async getEscrowResult(escrowId: bigint): Promise<Result<Escrow, EscrowNotFoundError | EscrowOperationError>> {
    try {
      const result = await this.publicClient.readContract({
        address: this.config.escrowAddress,
        abi: ESCROW_ABI,
        functionName: 'getEscrow',
        args: [escrowId],
      });

      // Check if escrow exists (id will be 0 if not found)
      if (result.id === 0n) {
        return failure(new EscrowNotFoundError(escrowId.toString()));
      }

      return success({
        id: result.id,
        clientDid: result.clientDid,
        providerDid: result.providerDid,
        clientAddress: result.clientAddress,
        providerAddress: result.providerAddress,
        amount: result.amount,
        token: result.token,
        taskHash: result.taskHash,
        outputHash: result.outputHash,
        deadline: result.deadline,
        state: result.state as EscrowState,
        createdAt: result.createdAt,
        deliveredAt: result.deliveredAt,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return failure(new EscrowOperationError(`Failed to get escrow ${escrowId}`, 'getEscrow', err));
    }
  }

  /**
   * Get escrow details by ID (legacy compatibility)
   *
   * @deprecated Use getEscrowResult() for proper error handling
   */
  async getEscrow(escrowId: bigint): Promise<Escrow | null> {
    const result = await this.getEscrowResult(escrowId);
    return result.success ? result.value : null;
  }

  /**
   * Validate escrow before task execution
   *
   * Checks:
   * 1. Escrow exists
   * 2. State is FUNDED
   * 3. Provider DID matches
   * 4. Deadline hasn't passed
   */
  async validateEscrow(escrowId: bigint, providerDid: `0x${string}`): Promise<EscrowValidation> {
    const escrow = await this.getEscrow(escrowId);

    if (!escrow) {
      return { valid: false, error: 'Escrow not found' };
    }

    // Check state is FUNDED
    if (escrow.state !== EscrowState.FUNDED) {
      const stateName = EscrowState[escrow.state];
      return {
        valid: false,
        error: `Invalid escrow state: ${stateName}. Expected: FUNDED`,
        escrow,
      };
    }

    // Check provider DID matches
    if (escrow.providerDid.toLowerCase() !== providerDid.toLowerCase()) {
      return {
        valid: false,
        error: 'Provider DID mismatch',
        escrow,
      };
    }

    // Check deadline hasn't passed
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (escrow.deadline < now) {
      return {
        valid: false,
        error: 'Escrow deadline has passed',
        escrow,
      };
    }

    return { valid: true, escrow };
  }

  /**
   * Confirm task delivery on-chain
   *
   * @param escrowId - The escrow ID
   * @param taskOutput - The task output (will be hashed)
   * @returns Transaction hash
   */
  async confirmDelivery(escrowId: bigint, taskOutput: string): Promise<`0x${string}`> {
    if (!this.walletClient || !this.account) {
      throw new Error('Private key required for confirmDelivery');
    }

    // Generate output hash
    const outputHash = generateOutputHash(taskOutput);

    // Send transaction
    const hash = await this.walletClient.writeContract({
      address: this.config.escrowAddress,
      abi: ESCROW_ABI,
      functionName: 'confirmDelivery',
      args: [escrowId, outputHash],
    });

    return hash;
  }

  /**
   * Get escrow state name
   */
  static getStateName(state: EscrowState): string {
    return EscrowState[state] || 'UNKNOWN';
  }
}

/**
 * Generate output hash from task output
 *
 * Uses keccak256 hash of the output string.
 * This allows on-chain verification of delivered output.
 */
export function generateOutputHash(output: string): `0x${string}` {
  return keccak256(toHex(output));
}

/**
 * Convert DID string to bytes32 hash
 */
export function didToHash(did: string): `0x${string}` {
  return keccak256(toHex(did));
}

/**
 * Escrow validation result type for use in task handlers
 */
export interface EscrowTaskContext {
  escrowId: bigint;
  escrow: Escrow;
  outputHash?: `0x${string}`;
}
