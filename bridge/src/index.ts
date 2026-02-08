// Public API
export { BridgeServer } from './server.js';
export type { BridgeServerConfig } from './server.js';
export { ClaudeExecutor } from './executor.js';
export { AgentMeshIntegration } from './integration.js';
export { IPFSService } from './ipfs.js';

// Error Types
export {
  AgentMeshError,
  EscrowNotFoundError,
  EscrowOperationError,
  PaymentValidationError,
  PaymentParseError,
  RegistrationError,
  success,
  failure,
  isSuccess,
  isFailure,
} from './errors.js';
export type { Result } from './errors.js';

// Escrow Integration
export {
  EscrowClient,
  EscrowState,
  generateOutputHash,
  didToHash,
} from './escrow.js';
export type {
  Escrow,
  EscrowConfig,
  EscrowValidation,
  EscrowTaskContext,
} from './escrow.js';

// x402 Payment Middleware
export {
  createX402Middleware,
  createPaymentRequirement,
  parsePaymentPayload,
  validatePayment,
  createTestPaymentPayload,
  X402_HEADERS,
} from './middleware/index.js';
export type { X402Config, X402Request, PaymentRequirement, PaymentPayload } from './middleware/index.js';

// AI Arbitration (Tier 2 Dispute Resolution)
export { AIArbitrationService } from './ai-arbitration.js';
export type {
  AIArbitrationConfig,
  AIArbitrationResult,
  ArbitrationOutcome,
  AnalysisScores,
  PreliminaryRuling,
  DisputeEvidence,
  TaskSpecification,
  Deliverable,
  CommunicationLog,
  AdditionalEvidenceItem,
  RequestedOutcome,
  EvidenceValidationResult,
  ArbiterVote,
  VoteTallyResult,
  ValidationRequest,
  ArbitrationRequest,
  ArbitrationFullResult,
} from './ai-arbitration.js';

// Types
export type { IntegrationConfig } from './integration.js';
export type { IPFSConfig, IPFSProvider, PinataMetadata } from './ipfs.js';
export type {
  TaskInput,
  TaskResult,
  AgentConfig,
  RichAgentConfig,
  BridgeEvents
} from './types.js';
export { TaskInputSchema, TaskResultSchema } from './types.js';

// Config Loader
export { loadAgentCardConfig, AgentCardConfigSchema } from './config.js';
