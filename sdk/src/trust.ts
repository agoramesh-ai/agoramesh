/**
 * AgentMe Trust Client
 *
 * Client for interacting with the AgentMe trust layer.
 *
 * @packageDocumentation
 */

import type {
  TrustScore,
  TrustDetails,
  ReputationData,
  StakeInfo,
  Endorsement,
} from './types.js';
import type { AgentMeClient } from './client.js';
import { didToHash } from './client.js';
import { BASIS_POINTS } from './types.js';
import { parseUSDC, formatUSDC } from './utils.js';
import { ERC20_ABI } from './abis.js';

// =============================================================================
// ABI Fragments
// =============================================================================

const TRUST_REGISTRY_ABI = [
  {
    name: 'getTrustScore',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [{ name: 'compositeScore', type: 'uint256' }],
  },
  {
    name: 'getTrustDetails',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      { name: 'reputationScore', type: 'uint256' },
      { name: 'stakeScore', type: 'uint256' },
      { name: 'endorsementScore', type: 'uint256' },
      { name: 'compositeScore', type: 'uint256' },
    ],
  },
  {
    name: 'getReputation',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      { name: 'score', type: 'uint256' },
      { name: 'transactions', type: 'uint256' },
      { name: 'successRate', type: 'uint256' },
    ],
  },
  {
    name: 'getTrustData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'reputationScore', type: 'uint256' },
          { name: 'totalTransactions', type: 'uint256' },
          { name: 'successfulTransactions', type: 'uint256' },
          { name: 'totalVolumeUsd', type: 'uint256' },
          { name: 'lastActivityTimestamp', type: 'uint256' },
          { name: 'stakedAmount', type: 'uint256' },
          { name: 'stakeUnlockTime', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'getEndorsements',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'endorserDid', type: 'bytes32' },
          { name: 'endorseeDid', type: 'bytes32' },
          { name: 'timestamp', type: 'uint256' },
          { name: 'message', type: 'string' },
          { name: 'isActive', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'depositStake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'requestWithdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'unlockTime', type: 'uint256' }],
  },
  {
    name: 'executeWithdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [{ name: 'withdrawnAmount', type: 'uint256' }],
  },
  {
    name: 'endorse',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'endorseeDid', type: 'bytes32' },
      { name: 'message', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'revokeEndorsement',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'endorseeDid', type: 'bytes32' }],
    outputs: [],
  },
] as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a basis points score (0-10000) to a normalized score (0.0-1.0).
 */
function basisPointsToScore(bps: bigint): number {
  return Number(bps) / BASIS_POINTS;
}

// =============================================================================
// TrustClient
// =============================================================================

/**
 * Client for interacting with the AgentMe trust layer.
 *
 * The trust layer provides:
 * - Composite trust scores (reputation + stake + endorsements)
 * - Staking for economic commitment
 * - Endorsement system (web of trust)
 *
 * @example
 * ```typescript
 * const client = new AgentMeClient({ ... });
 * await client.connect();
 *
 * const trust = new TrustClient(client);
 *
 * // Get trust score
 * const score = await trust.getTrustScore('did:agentme:base:0x...');
 * console.log(`Trust: ${(score.overall * 100).toFixed(1)}%`);
 *
 * // Deposit stake
 * await trust.depositStake('did:agentme:base:0x...', '1000'); // 1000 USDC
 *
 * // Endorse another agent
 * await trust.endorse('did:agentme:base:0x...', 'Reliable partner');
 * ```
 */
export class TrustClient {
  private readonly client: AgentMeClient;

  /**
   * Create a new TrustClient.
   *
   * @param client - The AgentMe client instance
   */
  constructor(client: AgentMeClient) {
    this.client = client;
  }

  // ===========================================================================
  // Node HTTP API Queries
  // ===========================================================================

  /**
   * Get trust score from a node's REST API (no wallet/blockchain connection needed).
   *
   * @param did - The agent's DID
   * @param nodeUrl - The AgentMe node URL (e.g., 'https://api.agentme.cz')
   * @returns Trust score breakdown
   *
   * @example
   * ```typescript
   * const trust = new TrustClient(client);
   * const score = await trust.getTrustFromNode(
   *   'did:agentme:base:0x...',
   *   'https://api.agentme.cz'
   * );
   * console.log(`Trust: ${(score.overall * 100).toFixed(1)}%`);
   * ```
   */
  async getTrustFromNode(did: string, nodeUrl: string): Promise<TrustScore> {
    const response = await fetch(
      `${nodeUrl}/trust/${encodeURIComponent(did)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get trust from node: ${error}`);
    }

    const data = (await response.json()) as {
      did: string;
      score: number;
      reputation: number;
      stake_score: number;
      endorsement_score: number;
    };

    return {
      overall: data.score,
      reputation: data.reputation,
      stake: data.stake_score,
      endorsement: data.endorsement_score,
    };
  }

  // ===========================================================================
  // Trust Score Queries
  // ===========================================================================

  /**
   * Get the composite trust score for an agent.
   *
   * @param did - The agent's DID
   * @returns Trust score breakdown
   */
  async getTrustScore(did: string): Promise<TrustScore> {
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    const [reputationScore, stakeScore, endorsementScore, compositeScore] =
      await publicClient.readContract({
        address: addresses.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'getTrustDetails',
        args: [didHash],
      });

    return {
      overall: basisPointsToScore(compositeScore),
      reputation: basisPointsToScore(reputationScore),
      stake: basisPointsToScore(stakeScore),
      endorsement: basisPointsToScore(endorsementScore),
    };
  }

  /**
   * Get detailed trust information for an agent.
   *
   * @param did - The agent's DID
   * @returns Complete trust details including raw data
   */
  async getTrustDetails(did: string): Promise<TrustDetails> {
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    // Fetch all data in parallel
    const [trustScores, trustData, endorsements] = await Promise.all([
      publicClient.readContract({
        address: addresses.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'getTrustDetails',
        args: [didHash],
      }),
      publicClient.readContract({
        address: addresses.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'getTrustData',
        args: [didHash],
      }),
      publicClient.readContract({
        address: addresses.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'getEndorsements',
        args: [didHash],
      }),
    ]);

    const [reputationScore, stakeScore, endorsementScore, compositeScore] =
      trustScores;

    // Calculate success rate
    const totalTx = trustData.totalTransactions;
    const successfulTx = trustData.successfulTransactions;
    const successRate =
      totalTx > 0n ? Number((successfulTx * 10000n) / totalTx) : 0;

    return {
      scores: {
        overall: basisPointsToScore(compositeScore),
        reputation: basisPointsToScore(reputationScore),
        stake: basisPointsToScore(stakeScore),
        endorsement: basisPointsToScore(endorsementScore),
      },
      reputation: {
        totalTransactions: totalTx,
        successfulTransactions: successfulTx,
        successRate,
        totalVolumeUsd: trustData.totalVolumeUsd,
      },
      stake: {
        amount: trustData.stakedAmount,
        unlockTime: trustData.stakeUnlockTime,
        pendingWithdrawal: 0n, // Would need additional contract call
      },
      endorsements: endorsements.map((e) => ({
        endorserDid: e.endorserDid as `0x${string}`,
        endorseeDid: e.endorseeDid as `0x${string}`,
        timestamp: e.timestamp,
        message: e.message,
        isActive: e.isActive,
      })),
    };
  }

  /**
   * Get just the reputation data for an agent.
   *
   * @param did - The agent's DID
   * @returns Reputation data
   */
  async getReputation(did: string): Promise<ReputationData> {
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    const trustData = await publicClient.readContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'getTrustData',
      args: [didHash],
    });

    const totalTx = trustData.totalTransactions;
    const successfulTx = trustData.successfulTransactions;
    const successRate =
      totalTx > 0n ? Number((successfulTx * 10000n) / totalTx) : 0;

    return {
      totalTransactions: totalTx,
      successfulTransactions: successfulTx,
      successRate,
      totalVolumeUsd: trustData.totalVolumeUsd,
    };
  }

  /**
   * Get endorsements for an agent.
   *
   * @param did - The agent's DID
   * @returns Array of endorsements
   */
  async getEndorsements(did: string): Promise<Endorsement[]> {
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    const endorsements = await publicClient.readContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'getEndorsements',
      args: [didHash],
    });

    return endorsements.map((e) => ({
      endorserDid: e.endorserDid as `0x${string}`,
      endorseeDid: e.endorseeDid as `0x${string}`,
      timestamp: e.timestamp,
      message: e.message,
      isActive: e.isActive,
    }));
  }

  // ===========================================================================
  // Staking
  // ===========================================================================

  /**
   * Deposit stake for an agent.
   *
   * Requires USDC approval first. This method handles approval automatically.
   *
   * @param did - The agent's DID
   * @param amount - Amount to stake in USDC (human-readable, e.g., "1000")
   * @returns Transaction hash
   *
   * @example
   * ```typescript
   * // Stake 1000 USDC
   * const txHash = await trust.depositStake('did:agentme:base:0x...', '1000');
   * ```
   */
  async depositStake(did: string, amount: string): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();
    const ownerAddress = this.client.getAddress();

    if (!walletClient || !publicClient || !ownerAddress) {
      throw new Error('Wallet not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }
    if (!addresses.usdc) {
      throw new Error('USDC address not configured.');
    }

    const didHash = didToHash(did);
    const amountWei = parseUSDC(amount);

    // Check allowance and approve if needed
    const allowance = await publicClient.readContract({
      address: addresses.usdc,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [ownerAddress, addresses.trustRegistry],
    });

    if (allowance < amountWei) {
      // Approve exact amount (could also approve max uint256)
      const approveTxHash = await walletClient.writeContract({
        address: addresses.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [addresses.trustRegistry, amountWei],
      });

      // Wait for approval to be mined
      await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    }

    // Deposit stake
    const txHash = await walletClient.writeContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'depositStake',
      args: [didHash, amountWei],
    });

    return txHash;
  }

  /**
   * Request withdrawal of staked funds.
   *
   * Starts the 7-day cooldown period.
   *
   * @param did - The agent's DID
   * @param amount - Amount to withdraw in USDC (human-readable)
   * @returns Object with transaction hash and unlock timestamp
   */
  async requestWithdraw(
    did: string,
    amount: string
  ): Promise<{ txHash: `0x${string}`; unlockTime: bigint }> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);
    const amountWei = parseUSDC(amount);

    const txHash = await walletClient.writeContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'requestWithdraw',
      args: [didHash, amountWei],
    });

    // Wait for transaction to be mined
    await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    // Calculate unlock time based on 7-day cooldown
    // (Proper implementation would decode events from the receipt)
    const unlockTime =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(7 * 24 * 60 * 60);

    return { txHash, unlockTime };
  }

  /**
   * Execute a pending withdrawal after cooldown.
   *
   * @param did - The agent's DID
   * @returns Transaction hash
   */
  async executeWithdraw(did: string): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();
    const addresses = this.client.getContractAddresses();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    const txHash = await walletClient.writeContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'executeWithdraw',
      args: [didHash],
    });

    return txHash;
  }

  /**
   * Get stake information for an agent.
   *
   * @param did - The agent's DID
   * @returns Stake information
   */
  async getStakeInfo(did: string): Promise<StakeInfo> {
    const publicClient = this.client.getPublicClient();
    const addresses = this.client.getContractAddresses();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const didHash = didToHash(did);

    const trustData = await publicClient.readContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'getTrustData',
      args: [didHash],
    });

    return {
      amount: trustData.stakedAmount,
      unlockTime: trustData.stakeUnlockTime,
      pendingWithdrawal: 0n, // Would need to track separately
    };
  }

  /**
   * Get the human-readable stake amount.
   *
   * @param did - The agent's DID
   * @returns Stake amount as string (e.g., "1000.00")
   */
  async getStakeAmount(did: string): Promise<string> {
    const stakeInfo = await this.getStakeInfo(did);
    return formatUSDC(stakeInfo.amount);
  }

  // ===========================================================================
  // Endorsements
  // ===========================================================================

  /**
   * Endorse another agent.
   *
   * The caller must be a registered agent.
   *
   * @param endorseeDid - The DID of the agent to endorse
   * @param message - Optional endorsement message
   * @returns Transaction hash
   *
   * @example
   * ```typescript
   * await trust.endorse(
   *   'did:agentme:base:0x...',
   *   'Reliable partner for legal translations'
   * );
   * ```
   */
  async endorse(
    endorseeDid: string,
    message: string = ''
  ): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();
    const addresses = this.client.getContractAddresses();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const endorseeHash = didToHash(endorseeDid);

    const txHash = await walletClient.writeContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'endorse',
      args: [endorseeHash, message],
    });

    return txHash;
  }

  /**
   * Revoke an endorsement.
   *
   * @param endorseeDid - The DID of the agent to revoke endorsement from
   * @returns Transaction hash
   */
  async revokeEndorsement(endorseeDid: string): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();
    const addresses = this.client.getContractAddresses();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }
    if (!addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }

    const endorseeHash = didToHash(endorseeDid);

    const txHash = await walletClient.writeContract({
      address: addresses.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'revokeEndorsement',
      args: [endorseeHash],
    });

    return txHash;
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Check if an agent meets minimum trust requirements.
   *
   * @param did - The agent's DID
   * @param minTrust - Minimum required trust score (0.0-1.0)
   * @returns True if agent meets requirements
   */
  async meetsTrustRequirement(did: string, minTrust: number): Promise<boolean> {
    const score = await this.getTrustScore(did);
    return score.overall >= minTrust;
  }

  /**
   * Calculate escrow requirement based on trust score.
   *
   * Higher trust = lower escrow requirement.
   *
   * @param trustScore - Trust score (0.0-1.0)
   * @param taskValue - Task value in USDC
   * @returns Required escrow amount as string
   */
  calculateEscrowRequirement(trustScore: number, taskValue: string): string {
    // Use integer arithmetic to avoid floating-point precision issues.
    // Parse value as USDC cents (multiply by 100), do percentage in integers, format back.
    const [whole = '0', frac = ''] = taskValue.split('.');
    const fracPadded = (frac + '00').slice(0, 2); // pad/truncate to 2 decimal places
    const cents = BigInt(whole) * 100n + BigInt(fracPadded);

    let escrowPercentage: bigint;
    if (trustScore > 0.9) {
      escrowPercentage = 0n; // No escrow needed
    } else if (trustScore > 0.7) {
      escrowPercentage = 20n; // 20%
    } else if (trustScore > 0.5) {
      escrowPercentage = 50n; // 50%
    } else {
      escrowPercentage = 100n; // 100%
    }

    const escrowCents = (cents * escrowPercentage) / 100n;
    const resultWhole = escrowCents / 100n;
    const resultFrac = escrowCents % 100n;
    return `${resultWhole}.${resultFrac.toString().padStart(2, '0')}`;
  }

  /**
   * Format a trust score for display.
   *
   * @param score - Trust score (0.0-1.0)
   * @returns Formatted string (e.g., "85.5%")
   */
  formatTrustScore(score: number): string {
    return `${(score * 100).toFixed(1)}%`;
  }
}
