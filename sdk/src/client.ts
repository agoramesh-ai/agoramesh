/**
 * AgentMe Client
 *
 * Main client for interacting with the AgentMe network.
 *
 * @packageDocumentation
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

import type {
  AgentMeConfig,
  ContractAddresses,
  CapabilityCard,
  Agent,
  AgentInfo,
} from './types.js';

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_USDC,
} from './types.js';

// =============================================================================
// ABI Fragments
// =============================================================================

const TRUST_REGISTRY_ABI = [
  {
    name: 'registerAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'capabilityCardCID', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'updateCapabilityCard',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'newCID', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'deactivateAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'getAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'didHash', type: 'bytes32' },
          { name: 'owner', type: 'address' },
          { name: 'capabilityCardCID', type: 'string' },
          { name: 'registeredAt', type: 'uint256' },
          { name: 'isActive', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'isAgentActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Custom Errors
  {
    type: 'error',
    name: 'OwnerAlreadyHasAgent',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentNotActive',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentAlreadyRegistered',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentNotRegistered',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDIDHash',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidCapabilityCardCID',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotAgentOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientStake',
    inputs: [],
  },
] as const;

// =============================================================================
// DID Validation
// =============================================================================

/**
 * Valid DID patterns for AgentMe (W3C DID spec compliant).
 *
 * Supported DID methods:
 * - did:agentme:[network]:[identifier] - AgentMe native DIDs
 * - did:web:[network]:[identifier] - Web DIDs
 * - did:key:[multibase-key] - Key DIDs (multibase-encoded public keys starting with 'z')
 * - did:ethr:[address] or did:ethr:[network]:[address] - Ethereum DIDs
 */

// AgentMe/Web DID: did:(agentme|web):[method]:[identifier]
// Method must be lowercase, identifier alphanumeric
const DID_AGENTME_WEB_PATTERN = /^did:(agentme|web):[a-z]+:[a-zA-Z0-9]+$/;

// Key DID: did:key:z[base58-multicodec-key]
// Must start with 'z' (multibase prefix for base58btc) followed by alphanumeric chars
const DID_KEY_PATTERN = /^did:key:z[a-zA-Z0-9]{32,}$/;

// Ethereum DID: did:ethr:[address] or did:ethr:[network]:[address]
// Address must be 0x followed by 40 hex characters
const DID_ETHR_PATTERN = /^did:ethr:(?:[a-zA-Z0-9]+:)?0x[a-fA-F0-9]{40}$/;

/**
 * Validate a DID string format according to W3C DID spec.
 *
 * Supported formats:
 * - did:agentme:base:abc123 (AgentMe native)
 * - did:web:ethereum:ABC123 (Web DID)
 * - did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK (Key DID)
 * - did:ethr:0xb9c5714089478a327f09197987f16f9e5d936e8a (Ethereum DID)
 * - did:ethr:mainnet:0xb9c5714089478a327f09197987f16f9e5d936e8a (Ethereum DID with network)
 *
 * Invalid patterns:
 * - agentme:base:abc123 (missing did: prefix)
 * - did:invalid:base:abc123 (unsupported method)
 * - did:KEY:... (uppercase method not allowed)
 * - did:key:abc123 (key must start with 'z' for multibase)
 * - did:ethr:0x123 (address too short)
 *
 * @param did - The DID string to validate
 * @throws Error if DID format is invalid
 */
export function validateDID(did: string): void {
  if (!did) {
    throw new Error(`Invalid DID format: ${did}`);
  }

  // Check which DID method is being used and validate accordingly
  if (did.startsWith('did:agentme:') || did.startsWith('did:web:')) {
    if (!DID_AGENTME_WEB_PATTERN.test(did)) {
      throw new Error(`Invalid DID format: ${did}`);
    }
  } else if (did.startsWith('did:key:')) {
    if (!DID_KEY_PATTERN.test(did)) {
      throw new Error(`Invalid DID format: ${did}`);
    }
  } else if (did.startsWith('did:ethr:')) {
    if (!DID_ETHR_PATTERN.test(did)) {
      throw new Error(`Invalid DID format: ${did}`);
    }
  } else {
    // Unsupported DID method
    throw new Error(`Invalid DID format: ${did}`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the chain configuration for a given chain ID.
 */
function getChain(chainId: number): Chain {
  switch (chainId) {
    case BASE_MAINNET_CHAIN_ID:
      return base;
    case BASE_SEPOLIA_CHAIN_ID:
      return baseSepolia;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/**
 * Get default contract addresses for a chain.
 */
function getDefaultAddresses(chainId: number): Partial<ContractAddresses> {
  switch (chainId) {
    case BASE_MAINNET_CHAIN_ID:
      return {
        usdc: BASE_MAINNET_USDC,
      };
    case BASE_SEPOLIA_CHAIN_ID:
      return {
        usdc: BASE_SEPOLIA_USDC,
      };
    default:
      return {};
  }
}

/**
 * Convert a DID string to a bytes32 hash.
 *
 * @param did - The DID string to hash
 * @returns The keccak256 hash of the DID as a hex string
 * @throws Error if DID format is invalid
 */
export function didToHash(did: string): `0x${string}` {
  validateDID(did);
  return keccak256(toHex(did));
}

/**
 * Parse a contract struct result into an AgentInfo object.
 */
function parseAgentInfo(result: {
  didHash: `0x${string}`;
  owner: `0x${string}`;
  capabilityCardCID: string;
  registeredAt: bigint;
  isActive: boolean;
}): AgentInfo {
  return {
    didHash: result.didHash,
    owner: result.owner,
    capabilityCardCID: result.capabilityCardCID,
    registeredAt: result.registeredAt,
    isActive: result.isActive,
  };
}

// =============================================================================
// AgentMeClient
// =============================================================================

/**
 * Main client for interacting with the AgentMe network.
 *
 * @example
 * ```typescript
 * const client = new AgentMeClient({
 *   rpcUrl: 'https://sepolia.base.org',
 *   chainId: 84532,
 *   privateKey: '0x...',
 *   trustRegistryAddress: '0x...',
 * });
 *
 * await client.connect();
 *
 * // Register an agent
 * await client.registerAgent(capabilityCard, 'ipfs://Qm...');
 *
 * // Get agent info
 * const agent = await client.getAgent('did:agentme:base:0x...');
 * ```
 */
export class AgentMeClient {
  private readonly config: AgentMeConfig;
  private readonly chain: Chain;
  private readonly addresses: Partial<ContractAddresses>;

  private publicClient: PublicClient<Transport, Chain> | null = null;
  private walletClient: WalletClient<Transport, Chain, Account> | null = null;
  private account: Account | null = null;
  private connected = false;

  /**
   * Create a new AgentMe client.
   *
   * @param config - Client configuration
   */
  constructor(config: AgentMeConfig) {
    this.config = config;
    this.chain = getChain(config.chainId);
    this.addresses = {
      ...getDefaultAddresses(config.chainId),
      trustRegistry: config.trustRegistryAddress,
      escrow: config.escrowAddress,
      usdc: config.usdcAddress ?? getDefaultAddresses(config.chainId).usdc,
    };
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Connect to the blockchain.
   *
   * @throws Error if already connected or if connection fails
   */
  async connect(): Promise<void> {
    if (this.connected) {
      throw new Error('Client is already connected');
    }

    // Create public client for read operations
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(this.config.rpcUrl),
    });

    // Verify connection by fetching chain ID
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.config.chainId) {
      throw new Error(
        `Chain ID mismatch: expected ${this.config.chainId}, got ${chainId}`
      );
    }

    // Create wallet client if private key provided
    if (this.config.privateKey) {
      this.account = privateKeyToAccount(this.config.privateKey);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: this.chain,
        transport: http(this.config.rpcUrl),
      });
    }

    this.connected = true;
  }

  /**
   * Disconnect from the blockchain.
   */
  disconnect(): void {
    this.publicClient = null;
    this.walletClient = null;
    this.account = null;
    this.connected = false;
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ===========================================================================
  // Agent Registration & Management
  // ===========================================================================

  /**
   * Register a new agent on-chain.
   *
   * @param card - The agent's capability card
   * @param capabilityCardCID - IPFS CID where the capability card is stored
   * @returns Transaction hash
   * @throws Error if not connected or no wallet configured
   */
  async registerAgent(
    card: CapabilityCard,
    capabilityCardCID: string
  ): Promise<`0x${string}`> {
    this.requireWallet();
    this.requireTrustRegistry();

    const didHash = didToHash(card.id);

    const hash = await this.walletClient!.writeContract({
      address: this.addresses.trustRegistry!,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'registerAgent',
      args: [didHash, capabilityCardCID],
    });

    return hash;
  }

  /**
   * Update an agent's capability card.
   *
   * @param did - The agent's DID
   * @param newCID - New IPFS CID for the capability card
   * @returns Transaction hash
   */
  async updateCapabilityCard(
    did: string,
    newCID: string
  ): Promise<`0x${string}`> {
    this.requireWallet();
    this.requireTrustRegistry();

    const didHash = didToHash(did);

    const hash = await this.walletClient!.writeContract({
      address: this.addresses.trustRegistry!,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'updateCapabilityCard',
      args: [didHash, newCID],
    });

    return hash;
  }

  /**
   * Deactivate an agent.
   *
   * @param did - The agent's DID
   * @returns Transaction hash
   */
  async deactivateAgent(did: string): Promise<`0x${string}`> {
    this.requireWallet();
    this.requireTrustRegistry();

    const didHash = didToHash(did);

    const hash = await this.walletClient!.writeContract({
      address: this.addresses.trustRegistry!,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'deactivateAgent',
      args: [didHash],
    });

    return hash;
  }

  /**
   * Get an agent by DID.
   *
   * @param did - The agent's DID
   * @returns Agent data or null if not found
   */
  async getAgent(did: string): Promise<Agent | null> {
    this.requireConnection();
    this.requireTrustRegistry();

    const didHash = didToHash(did);

    const result = await this.publicClient!.readContract({
      address: this.addresses.trustRegistry!,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'getAgent',
      args: [didHash],
    });

    const agentInfo = parseAgentInfo(result);

    // Check if agent is registered (owner != zero address)
    if (agentInfo.owner === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return {
      did,
      didHash,
      address: agentInfo.owner,
      capabilityCardCID: agentInfo.capabilityCardCID || undefined,
      isActive: agentInfo.isActive,
    };
  }

  /**
   * Check if an agent is active.
   *
   * @param did - The agent's DID
   * @returns True if the agent is active
   */
  async isAgentActive(did: string): Promise<boolean> {
    this.requireConnection();
    this.requireTrustRegistry();

    const didHash = didToHash(did);

    const result = await this.publicClient!.readContract({
      address: this.addresses.trustRegistry!,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'isAgentActive',
      args: [didHash],
    });

    return result;
  }

  // ===========================================================================
  // Accessors
  // ===========================================================================

  /**
   * Get the RPC URL.
   */
  get rpcUrl(): string {
    return this.config.rpcUrl;
  }

  /**
   * Get the chain ID.
   */
  get chainId(): number {
    return this.config.chainId;
  }

  /**
   * Get the public client for advanced operations.
   */
  getPublicClient(): PublicClient<Transport, Chain> | null {
    return this.publicClient;
  }

  /**
   * Get the wallet client for advanced operations.
   */
  getWalletClient(): WalletClient<Transport, Chain, Account> | null {
    return this.walletClient;
  }

  /**
   * Get the account address.
   */
  getAddress(): `0x${string}` | null {
    return this.account?.address ?? null;
  }

  /**
   * Get contract addresses.
   */
  getContractAddresses(): Partial<ContractAddresses> {
    return { ...this.addresses };
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Ensure the client is connected.
   */
  private requireConnection(): void {
    if (!this.connected || !this.publicClient) {
      throw new Error('Client is not connected. Call connect() first.');
    }
  }

  /**
   * Ensure a wallet is configured.
   */
  private requireWallet(): void {
    this.requireConnection();
    if (!this.walletClient || !this.account) {
      throw new Error('No wallet configured. Provide a privateKey in config.');
    }
  }

  /**
   * Ensure TrustRegistry address is configured.
   */
  private requireTrustRegistry(): void {
    if (!this.addresses.trustRegistry) {
      throw new Error('TrustRegistry address not configured.');
    }
  }

}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new AgentMe client.
 *
 * @param config - Client configuration
 * @returns A new AgentMeClient instance
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   rpcUrl: 'https://sepolia.base.org',
 *   chainId: 84532,
 * });
 * ```
 */
export function createClient(config: AgentMeConfig): AgentMeClient {
  return new AgentMeClient(config);
}
