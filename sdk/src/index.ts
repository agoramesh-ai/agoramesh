/**
 * AgentMesh SDK
 *
 * TypeScript SDK for interacting with the AgentMesh decentralized agent marketplace.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import {
 *   AgentMeshClient,
 *   DiscoveryClient,
 *   TrustClient,
 *   PaymentClient,
 *   BASE_SEPOLIA_CHAIN_ID,
 * } from '@agentme/sdk';
 *
 * // Create and connect client
 * const client = new AgentMeshClient({
 *   rpcUrl: 'https://sepolia.base.org',
 *   chainId: BASE_SEPOLIA_CHAIN_ID,
 *   privateKey: '0x...',
 *   trustRegistryAddress: '0x...',
 *   escrowAddress: '0x...',
 * });
 *
 * await client.connect();
 *
 * // Use discovery to find agents
 * const discovery = new DiscoveryClient(client, 'http://localhost:8080');
 * const results = await discovery.search('translate legal documents', {
 *   minTrust: 0.8,
 *   maxPrice: '0.10',
 * });
 *
 * // Check trust scores
 * const trust = new TrustClient(client);
 * const score = await trust.getTrustScore('did:agentmesh:base:0x...');
 *
 * // Create escrow for payment
 * const payment = new PaymentClient(client, 'did:agentmesh:base:0x...');
 * const escrowId = await payment.createAndFundEscrow({
 *   providerDid: 'did:agentmesh:base:0x...',
 *   providerAddress: '0x...',
 *   amount: '100',
 *   taskHash: '0x...',
 *   deadline: Date.now() + 24 * 60 * 60 * 1000,
 * });
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Configuration
  AgentMeshConfig,
  ContractAddresses,

  // Capability Card
  CapabilityCard,
  Skill,
  SkillExample,
  ServiceLevelAgreement,
  Pricing,
  Provider,
  Authentication,
  PaymentConfig,

  // Trust
  TrustTier,
  TrustScore,
  TrustInfo,
  TrustDetails,
  ReputationData,
  StakeInfo,
  Endorsement,

  // Agent
  AgentInfo,
  Agent,

  // Escrow
  Escrow,
  CreateEscrowOptions,

  // Discovery
  SearchOptions,
  DiscoveryResult,
} from './types.js';

export {
  // Escrow state enum
  EscrowState,
  EscrowStateNames,

  // Constants
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_USDC,
  BASE_MAINNET_RPC,
  BASE_SEPOLIA_RPC,
  BASIS_POINTS,
  USDC_DECIMALS,
} from './types.js';

// =============================================================================
// Client
// =============================================================================

export { AgentMeshClient, createClient, didToHash } from './client.js';

// =============================================================================
// Utilities
// =============================================================================

export {
  parseUSDC,
  formatUSDC,
  toUnixTimestamp,
  calculateElapsedTime,
} from './utils.js';

// =============================================================================
// Discovery
// =============================================================================

export { DiscoveryClient } from './discovery.js';

// =============================================================================
// Trust
// =============================================================================

export { TrustClient } from './trust.js';

// =============================================================================
// Payment
// =============================================================================

export { PaymentClient } from './payment.js';

// =============================================================================
// x402 Micropayments
// =============================================================================

export {
  X402Client,
  createX402Client,
  wrapFetchWithX402,
  isPaymentRequired,
} from './x402.js';

export type {
  X402Config,
  PaymentRequirement,
  PaymentPayload,
  PaymentSettleResponse,
  X402FetchOptions,
} from './x402.js';

// =============================================================================
// Semantic Search
// =============================================================================

export {
  SemanticSearchClient,
  createOpenAIEmbedder,
  createCohereEmbedder,
  createSimpleEmbedder,
} from './semantic.js';

export type {
  Embedding,
  EmbeddingFunction,
  SemanticSearchConfig,
  SemanticSearchResult,
  OpenAIEmbedderOptions,
  CohereEmbedderOptions,
} from './semantic.js';

// =============================================================================
// Streaming Payments
// =============================================================================

export {
  StreamingPaymentsClient,
  StreamStatus,
  StreamStatusNames,
} from './streaming.js';

export type {
  Stream,
  CreateStreamOptions,
  CreateStreamWithTimestampsOptions,
  FormattedStream,
  CancellationPreview,
  StreamHealth,
  StreamHealthStatus,
  RecoveryResult,
} from './streaming.js';

// =============================================================================
// Cross-Chain Trust Sync
// =============================================================================

export { CrossChainTrustClient } from './crosschain.js';

export type {
  CrossChainConfig,
  CachedTrustScore,
  ChainInfo,
  RequestTrustSyncOptions,
  SyncTrustScoreOptions,
  QuoteSyncFeeOptions,
  SyncResult,
} from './crosschain.js';

// =============================================================================
// Deployments
// =============================================================================

export { loadDeployment, isDeployed } from './deployments.js';

export type { DeploymentAddresses } from './deployments.js';
