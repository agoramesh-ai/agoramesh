/**
 * AgentMe SDK Types
 *
 * Core type definitions for the AgentMe TypeScript SDK.
 *
 * @packageDocumentation
 */

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for the AgentMe client.
 */
export interface AgentMeConfig {
  /** RPC URL for blockchain connection */
  rpcUrl: string;
  /** Chain ID (8453 for Base Mainnet, 84532 for Base Sepolia) */
  chainId: number;
  /** Optional private key for signing transactions (hex string with 0x prefix) */
  privateKey?: `0x${string}`;
  /** TrustRegistry contract address */
  trustRegistryAddress?: `0x${string}`;
  /** AgentMeEscrow contract address */
  escrowAddress?: `0x${string}`;
  /** USDC token address */
  usdcAddress?: `0x${string}`;
}

/**
 * Contract addresses for a specific network.
 */
export interface ContractAddresses {
  trustRegistry: `0x${string}`;
  escrow: `0x${string}`;
  usdc: `0x${string}`;
}

// =============================================================================
// Capability Card Types (A2A Compatible)
// =============================================================================

/**
 * Skill/capability that an agent can perform.
 */
export interface Skill {
  /** Unique skill identifier */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Detailed description of the skill */
  description?: string;
  /** Tags for discovery */
  tags?: string[];
  /** JSON Schema for input validation */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for output validation */
  outputSchema?: Record<string, unknown>;
  /** Supported input content types */
  inputModes?: string[];
  /** Supported output content types */
  outputModes?: string[];
  /** Skill-specific pricing (overrides agent default) */
  pricing?: Pricing;
  /** Service level agreement */
  sla?: ServiceLevelAgreement;
  /** Example inputs and outputs */
  examples?: SkillExample[];
}

/**
 * Example input/output for a skill.
 */
export interface SkillExample {
  input: unknown;
  output: unknown;
}

/**
 * Service level agreement for a skill.
 */
export interface ServiceLevelAgreement {
  /** Average response time in ISO 8601 duration format (e.g., "PT2M") */
  avgResponseTime?: string;
  /** Maximum response time in ISO 8601 duration format */
  maxResponseTime?: string;
  /** Expected availability (0.0-1.0) */
  availability?: number;
}

/**
 * Pricing information for agent services.
 */
export interface Pricing {
  /** Pricing model type */
  model: 'per_request' | 'per_unit' | 'per_second' | 'quoted';
  /** Unit of measurement (for per_unit pricing) */
  unit?: 'word' | 'character' | 'token' | 'image' | 'minute' | 'second';
  /** Price amount (as string for precision) */
  amount: string;
  /** Currency (e.g., "USDC", "DAI") */
  currency: string;
  /** Minimum charge amount */
  minimum?: string;
  /** Whether escrow is required for this service */
  escrowRequired?: boolean;
}

/**
 * Provider/organization information.
 */
export interface Provider {
  /** Organization name */
  name: string;
  /** Organization URL */
  url?: string;
  /** Contact email */
  contact?: string;
}

/**
 * Authentication configuration for an agent.
 */
export interface Authentication {
  /** Supported authentication schemes */
  schemes: string[];
  /** Supported DID methods (if using DID auth) */
  didMethods?: string[];
  /** Instructions for authentication */
  instructions?: string;
}

/**
 * Payment configuration for an agent.
 */
export interface PaymentConfig {
  /** Supported payment methods */
  methods: ('x402' | 'escrow' | 'streaming')[];
  /** Supported currencies */
  currencies: string[];
  /** Supported chains */
  chains: string[];
  /** Payment addresses by chain */
  addresses: Record<string, `0x${string}`>;
  /** Escrow contract address (if applicable) */
  escrowContract?: `0x${string}`;
}

/**
 * A2A-compatible Capability Card with AgentMe extensions.
 */
export interface CapabilityCard {
  /** JSON Schema reference */
  $schema?: string;
  /** Agent's DID (Decentralized Identifier) */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Agent description */
  description: string;
  /** Semantic version of agent implementation */
  version: string;
  /** Primary A2A endpoint URL */
  url: string;
  /** A2A protocol version */
  protocolVersion?: string;
  /** Provider/organization information */
  provider?: Provider;
  /** Agent capabilities (streaming, push notifications, etc.) */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
    x402Payments?: boolean;
    escrow?: boolean;
  };
  /** Authentication configuration */
  authentication?: Authentication;
  /** Skills/capabilities offered by the agent */
  skills: Skill[];
  /** Trust information (AgentMe extension) */
  trust?: TrustInfo;
  /** Payment configuration */
  payment?: PaymentConfig;
  /** Default input content types */
  defaultInputModes?: string[];
  /** Default output content types */
  defaultOutputModes?: string[];
  /** Documentation URL */
  documentationUrl?: string;
  /** Terms of service URL */
  termsOfServiceUrl?: string;
  /** Privacy policy URL */
  privacyPolicyUrl?: string;
  /** Metadata */
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    registeredAt?: string;
  };
}

// =============================================================================
// Trust Types
// =============================================================================

/**
 * Trust tier classification.
 */
export type TrustTier = 'new' | 'active' | 'verified' | 'trusted';

/**
 * Reputation data for an agent.
 */
export interface ReputationData {
  /** Total number of transactions */
  totalTransactions: bigint;
  /** Number of successful transactions */
  successfulTransactions: bigint;
  /** Success rate (0-10000 basis points) */
  successRate: number;
  /** Total volume in USD (as cents) */
  totalVolumeUsd: bigint;
  /** Average rating (if applicable) */
  avgRating?: number;
  /** Number of disputes */
  disputes?: number;
  /** Number of disputes won */
  disputesWon?: number;
}

/**
 * Stake information for an agent.
 */
export interface StakeInfo {
  /** Staked amount in USDC (6 decimals) */
  amount: bigint;
  /** When stake can be withdrawn (0 if no pending withdrawal) */
  unlockTime: bigint;
  /** Pending withdrawal amount */
  pendingWithdrawal: bigint;
}

/**
 * Endorsement from one agent to another.
 */
export interface Endorsement {
  /** Endorser's DID hash */
  endorserDid: `0x${string}`;
  /** Endorsee's DID hash */
  endorseeDid: `0x${string}`;
  /** Timestamp of endorsement */
  timestamp: bigint;
  /** Optional message */
  message: string;
  /** Whether the endorsement is active */
  isActive: boolean;
}

/**
 * Trust score breakdown.
 */
export interface TrustScore {
  /** Overall composite trust score (0.0-1.0) */
  overall: number;
  /** Reputation component (0.0-1.0) */
  reputation: number;
  /** Stake component (0.0-1.0) */
  stake: number;
  /** Endorsement component (0.0-1.0) */
  endorsement: number;
}

/**
 * Complete trust information for an agent.
 */
export interface TrustInfo {
  /** Composite trust score (0.0-1.0) */
  score: number;
  /** Trust tier classification */
  tier: TrustTier;
  /** Detailed reputation data */
  reputation?: ReputationData;
  /** Stake information */
  stake?: {
    amount: string;
    currency: string;
    lockedUntil?: string;
  };
  /** List of endorsements */
  endorsements?: Array<{
    endorser: string;
    endorserName?: string;
    endorserTrust?: number;
    endorsedAt: string;
    message?: string;
  }>;
  /** Verification credentials */
  verifications?: Array<{
    type: string;
    issuer: string;
    issuedAt: string;
    credential?: string;
  }>;
}

/**
 * Detailed trust data returned from contract.
 */
export interface TrustDetails {
  /** Trust score breakdown */
  scores: TrustScore;
  /** Reputation data */
  reputation: ReputationData;
  /** Stake information */
  stake: StakeInfo;
  /** List of endorsements */
  endorsements: Endorsement[];
}

// =============================================================================
// Agent Types
// =============================================================================

/**
 * On-chain agent information.
 */
export interface AgentInfo {
  /** DID hash */
  didHash: `0x${string}`;
  /** Owner address */
  owner: `0x${string}`;
  /** IPFS CID of capability card */
  capabilityCardCID: string;
  /** Registration timestamp */
  registeredAt: bigint;
  /** Whether agent is active */
  isActive: boolean;
}

/**
 * Complete agent data combining on-chain and off-chain information.
 */
export interface Agent {
  /** Agent's DID */
  did: string;
  /** DID hash (for contract interactions) */
  didHash: `0x${string}`;
  /** Owner's Ethereum address */
  address: `0x${string}`;
  /** IPFS CID of capability card (from on-chain registry) */
  capabilityCardCID?: string;
  /** Capability card (fetched from IPFS or DHT) */
  capabilityCard?: CapabilityCard;
  /** Trust score */
  trustScore?: TrustScore;
  /** Whether agent is active on-chain */
  isActive: boolean;
}

// =============================================================================
// Escrow Types
// =============================================================================

/**
 * Escrow state machine states.
 */
export enum EscrowState {
  /** Escrow created, waiting for client to fund */
  AWAITING_DEPOSIT = 0,
  /** Client has deposited funds */
  FUNDED = 1,
  /** Provider has confirmed delivery */
  DELIVERED = 2,
  /** Either party has initiated a dispute */
  DISPUTED = 3,
  /** Funds released to provider */
  RELEASED = 4,
  /** Funds refunded to client */
  REFUNDED = 5,
}

/**
 * Human-readable escrow state names.
 */
export const EscrowStateNames: Record<EscrowState, string> = {
  [EscrowState.AWAITING_DEPOSIT]: 'Awaiting Deposit',
  [EscrowState.FUNDED]: 'Funded',
  [EscrowState.DELIVERED]: 'Delivered',
  [EscrowState.DISPUTED]: 'Disputed',
  [EscrowState.RELEASED]: 'Released',
  [EscrowState.REFUNDED]: 'Refunded',
};

/**
 * Complete escrow record.
 */
export interface Escrow {
  /** Unique escrow ID */
  id: bigint;
  /** Client agent's DID hash */
  clientDid: `0x${string}`;
  /** Provider agent's DID hash */
  providerDid: `0x${string}`;
  /** Client's wallet address */
  clientAddress: `0x${string}`;
  /** Provider's wallet address */
  providerAddress: `0x${string}`;
  /** Escrowed amount (in token decimals) */
  amount: bigint;
  /** Payment token address */
  token: `0x${string}`;
  /** Hash of task specification */
  taskHash: `0x${string}`;
  /** Hash of delivered output */
  outputHash: `0x${string}`;
  /** Deadline timestamp */
  deadline: bigint;
  /** Current state */
  state: EscrowState;
  /** Creation timestamp */
  createdAt: bigint;
  /** Delivery confirmation timestamp */
  deliveredAt: bigint;
}

/**
 * Options for creating an escrow.
 */
export interface CreateEscrowOptions {
  /** Provider agent's DID */
  providerDid: string;
  /** Provider's wallet address */
  providerAddress: `0x${string}`;
  /** Amount in USDC (human-readable, e.g., "10.50") */
  amount: string;
  /** Hash of task specification */
  taskHash: `0x${string}`;
  /** Deadline as Unix timestamp or Date */
  deadline: number | Date;
  /** Token address (defaults to USDC) */
  tokenAddress?: `0x${string}`;
}

// =============================================================================
// Discovery Types
// =============================================================================

/**
 * Options for searching agents.
 */
export interface SearchOptions {
  /** Minimum trust score (0.0-1.0) */
  minTrust?: number;
  /** Maximum price for the service */
  maxPrice?: string;
  /** Required skills/tags */
  tags?: string[];
  /** Currency filter */
  currency?: string;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Discovery result item.
 */
export interface DiscoveryResult {
  /** Agent's DID */
  did: string;
  /** Agent name */
  name: string;
  /** Agent description */
  description: string;
  /** Agent endpoint URL */
  url: string;
  /** Trust score */
  trust: TrustScore;
  /** Pricing information */
  pricing?: Pricing;
  /** Matching skills */
  matchingSkills: Skill[];
}

// =============================================================================
// Constants
// =============================================================================

/** Base Mainnet chain ID */
export const BASE_MAINNET_CHAIN_ID = 8453;

/** Base Sepolia chain ID */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** USDC contract on Base Mainnet */
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** USDC contract on Base Sepolia */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

/** Base Mainnet RPC URL */
export const BASE_MAINNET_RPC = 'https://mainnet.base.org';

/** Base Sepolia RPC URL */
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

/** Basis points denominator (100%) */
export const BASIS_POINTS = 10000;

/** USDC decimals */
export const USDC_DECIMALS = 6;
