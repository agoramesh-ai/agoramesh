/**
 * AgoraMesh ERC-8004 Bridge Client
 *
 * Client for interacting with the ERC8004Bridge contract, which registers
 * AgoraMesh agents on the official ERC-8004 registries on Base Sepolia.
 *
 * @packageDocumentation
 */

import type { AgoraMeshClient } from './client.js';

// =============================================================================
// Constants
// =============================================================================

/** Official ERC-8004 IdentityRegistry on Base Sepolia */
export const ERC8004_IDENTITY_REGISTRY =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;

/** Official ERC-8004 ReputationRegistry on Base Sepolia */
export const ERC8004_REPUTATION_REGISTRY =
  '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;

// =============================================================================
// ABI Fragments
// =============================================================================

const ERC8004_BRIDGE_ABI = [
  {
    name: 'registerAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentTokenId', type: 'uint256' },
      { name: 'agentURI', type: 'string' },
    ],
    outputs: [{ name: 'erc8004AgentId', type: 'uint256' }],
  },
  {
    name: 'updateAgentURI',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentTokenId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'submitFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'erc8004AgentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'submitValidation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'erc8004AgentId', type: 'uint256' },
      { name: 'requestHash', type: 'bytes32' },
      { name: 'response', type: 'uint8' },
      { name: 'tag', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getERC8004AgentId',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentTokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getAgoraMeshTokenId',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'erc8004AgentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isRegistered',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'agentTokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'getAgoraMeshtadata',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentTokenId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    name: 'getReputationSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'erc8004AgentId', type: 'uint256' }],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    name: 'totalRegistered',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// =============================================================================
// Types
// =============================================================================

/** Result of registering an agent on ERC-8004 */
export interface ERC8004Registration {
  /** Transaction hash */
  txHash: `0x${string}`;
  /** The ERC-8004 agent ID assigned by the official registry */
  erc8004AgentId: bigint;
}

/** ERC-8004 reputation summary */
export interface ERC8004ReputationSummary {
  /** Total number of feedback entries */
  count: bigint;
  /** Aggregated feedback score */
  summaryValue: bigint;
  /** Decimal places in summaryValue */
  summaryValueDecimals: number;
}

// =============================================================================
// ERC8004BridgeClient
// =============================================================================

/**
 * Client for interacting with the AgoraMesh ERC-8004 Bridge.
 *
 * The bridge registers AgoraMesh agents on the official ERC-8004 registries
 * and allows submitting feedback and validations.
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const bridge = new ERC8004BridgeClient(client, '0xBridgeAddress...');
 *
 * // Register an agent
 * const result = await bridge.registerAgentOnERC8004(1n, 'ipfs://QmCapCard');
 * console.log(`ERC-8004 ID: ${result.erc8004AgentId}`);
 *
 * // Submit feedback
 * await bridge.submitFeedbackToERC8004(result.erc8004AgentId, 85n, 'quality', 'speed');
 * ```
 */
export class ERC8004BridgeClient {
  private readonly client: AgoraMeshClient;
  private readonly bridgeAddress: `0x${string}`;

  /**
   * Create a new ERC8004BridgeClient.
   *
   * @param client - The AgoraMesh client instance
   * @param bridgeAddress - Address of the deployed ERC8004Bridge contract
   */
  constructor(client: AgoraMeshClient, bridgeAddress: `0x${string}`) {
    this.client = client;
    this.bridgeAddress = bridgeAddress;
  }

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Register an AgoraMesh agent on the official ERC-8004 IdentityRegistry.
   *
   * @param agentTokenId - The AgoraMesh token ID to register
   * @param agentURI - The agent metadata URI (e.g., IPFS CID)
   * @returns Transaction hash and the assigned ERC-8004 agent ID
   */
  async registerAgentOnERC8004(
    agentTokenId: bigint,
    agentURI: string
  ): Promise<ERC8004Registration> {
    const walletClient = this.client.getWalletClient();
    const publicClient = this.client.getPublicClient();

    if (!walletClient || !publicClient) {
      throw new Error('Wallet not connected.');
    }

    const txHash = await walletClient.writeContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'registerAgent',
      args: [agentTokenId, agentURI],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    // Read the ERC-8004 agent ID from the mapping after registration
    const erc8004AgentId = await publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'getERC8004AgentId',
      args: [agentTokenId],
    });

    return {
      txHash: receipt.transactionHash,
      erc8004AgentId,
    };
  }

  /**
   * Update an agent's URI on the official ERC-8004 IdentityRegistry.
   *
   * @param agentTokenId - The AgoraMesh token ID
   * @param newURI - The new metadata URI
   * @returns Transaction hash
   */
  async updateAgentURI(
    agentTokenId: bigint,
    newURI: string
  ): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    return walletClient.writeContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'updateAgentURI',
      args: [agentTokenId, newURI],
    });
  }

  // ===========================================================================
  // Feedback
  // ===========================================================================

  /**
   * Submit feedback for an agent to the official ERC-8004 ReputationRegistry.
   *
   * @param erc8004AgentId - The ERC-8004 agent ID
   * @param value - Feedback value (signed, supports negative)
   * @param tag1 - Primary categorization tag
   * @param tag2 - Secondary categorization tag
   * @returns Transaction hash
   */
  async submitFeedbackToERC8004(
    erc8004AgentId: bigint,
    value: bigint,
    tag1: string,
    tag2: string
  ): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    return walletClient.writeContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'submitFeedback',
      args: [erc8004AgentId, value, tag1, tag2],
    });
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Submit a validation response for an agent.
   *
   * @param erc8004AgentId - The ERC-8004 agent ID
   * @param requestHash - Unique validation request hash
   * @param response - Response code (0=pending, 1=valid, 2=invalid, 3=inconclusive)
   * @param tag - Category tag
   * @returns Transaction hash
   */
  async submitValidation(
    erc8004AgentId: bigint,
    requestHash: `0x${string}`,
    response: number,
    tag: string
  ): Promise<`0x${string}`> {
    const walletClient = this.client.getWalletClient();

    if (!walletClient) {
      throw new Error('Wallet not connected.');
    }

    return walletClient.writeContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'submitValidation',
      args: [erc8004AgentId, requestHash, response, tag],
    });
  }

  // ===========================================================================
  // View Functions
  // ===========================================================================

  /**
   * Get the ERC-8004 agent ID for an AgoraMesh token ID.
   *
   * @param agentTokenId - The AgoraMesh token ID
   * @returns The ERC-8004 agent ID (0n if not registered)
   */
  async getERC8004AgentId(agentTokenId: bigint): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'getERC8004AgentId',
      args: [agentTokenId],
    });
  }

  /**
   * Get the AgoraMesh token ID for an ERC-8004 agent ID.
   *
   * @param erc8004AgentId - The ERC-8004 agent ID
   * @returns The AgoraMesh token ID (0n if not mapped)
   */
  async getAgoraMeshTokenId(erc8004AgentId: bigint): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'getAgoraMeshTokenId',
      args: [erc8004AgentId],
    });
  }

  /**
   * Check if an AgoraMesh agent is registered on ERC-8004.
   *
   * @param agentTokenId - The AgoraMesh token ID
   * @returns True if registered
   */
  async isRegistered(agentTokenId: bigint): Promise<boolean> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'isRegistered',
      args: [agentTokenId],
    });
  }

  /**
   * Get agent metadata from the official ERC-8004 IdentityRegistry.
   *
   * @param agentTokenId - The AgoraMesh token ID
   * @param metadataKey - The metadata key to query
   * @returns Raw metadata value as hex bytes
   */
  async getAgoraMeshtadata(
    agentTokenId: bigint,
    metadataKey: string
  ): Promise<`0x${string}`> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'getAgoraMeshtadata',
      args: [agentTokenId, metadataKey],
    });
  }

  /**
   * Get reputation summary from the official ERC-8004 ReputationRegistry.
   *
   * @param erc8004AgentId - The ERC-8004 agent ID
   * @returns Reputation summary
   */
  async getReputationSummary(
    erc8004AgentId: bigint
  ): Promise<ERC8004ReputationSummary> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    const [count, summaryValue, summaryValueDecimals] =
      await publicClient.readContract({
        address: this.bridgeAddress,
        abi: ERC8004_BRIDGE_ABI,
        functionName: 'getReputationSummary',
        args: [erc8004AgentId],
      });

    return {
      count,
      summaryValue,
      summaryValueDecimals,
    };
  }

  /**
   * Get total number of agents registered through the bridge.
   *
   * @returns Total registered agent count
   */
  async getTotalRegistered(): Promise<bigint> {
    const publicClient = this.client.getPublicClient();

    if (!publicClient) {
      throw new Error('Client is not connected.');
    }

    return publicClient.readContract({
      address: this.bridgeAddress,
      abi: ERC8004_BRIDGE_ABI,
      functionName: 'totalRegistered',
    });
  }
}
