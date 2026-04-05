/**
 * AgoraMesh SDK Error Classes
 *
 * Provides descriptive, actionable error messages with error codes
 * to help developers quickly diagnose and fix issues.
 *
 * @packageDocumentation
 */

/**
 * Error codes for AgoraMesh SDK errors.
 * Format: AGORA_<CATEGORY>_<SPECIFIC>
 */
export enum AgoraMeshErrorCode {
  // Client errors (1xx)
  CLIENT_NOT_CONNECTED = 'AGORA_CLIENT_NOT_CONNECTED',
  CLIENT_ALREADY_CONNECTED = 'AGORA_CLIENT_ALREADY_CONNECTED',
  CLIENT_CONNECTION_FAILED = 'AGORA_CLIENT_CONNECTION_FAILED',
  WALLET_NOT_CONNECTED = 'AGORA_WALLET_NOT_CONNECTED',

  // Configuration errors (2xx)
  ESCROW_NOT_CONFIGURED = 'AGORA_ESCROW_NOT_CONFIGURED',
  TOKEN_NOT_CONFIGURED = 'AGORA_TOKEN_NOT_CONFIGURED',
  TRUST_REGISTRY_NOT_CONFIGURED = 'AGORA_TRUST_REGISTRY_NOT_CONFIGURED',
  USDC_NOT_CONFIGURED = 'AGORA_USDC_NOT_CONFIGURED',
  NODE_URL_NOT_CONFIGURED = 'AGORA_NODE_URL_NOT_CONFIGURED',

  // Validation errors (3xx)
  INVALID_DID_FORMAT = 'AGORA_INVALID_DID_FORMAT',
  UNSUPPORTED_CHAIN = 'AGORA_UNSUPPORTED_CHAIN',
  EMBEDDING_DIMENSION_MISMATCH = 'AGORA_EMBEDDING_DIMENSION_MISMATCH',

  // Transaction errors (4xx)
  ESCROW_EVENT_NOT_FOUND = 'AGORA_ESCROW_EVENT_NOT_FOUND',
  STREAM_EVENT_NOT_FOUND = 'AGORA_STREAM_EVENT_NOT_FOUND',
  STREAM_NOT_STUCK = 'AGORA_STREAM_NOT_STUCK',

  // Discovery errors (5xx)
  DISCOVERY_SEARCH_FAILED = 'AGORA_DISCOVERY_SEARCH_FAILED',
  DISCOVERY_ANNOUNCE_FAILED = 'AGORA_DISCOVERY_ANNOUNCE_FAILED',
  DISCOVERY_NOT_SUPPORTED = 'AGORA_DISCOVERY_NOT_SUPPORTED',
  DISCOVERY_TIMEOUT = 'AGORA_DISCOVERY_TIMEOUT',
  SSRF_BLOCKED = 'AGORA_SSRF_BLOCKED',
  PRIVATE_ADDRESS_BLOCKED = 'AGORA_PRIVATE_ADDRESS_BLOCKED',

  // Semantic errors (6xx)
  EMBEDDING_FAILED = 'AGORA_EMBEDDING_FAILED',
  OPENAI_EMBEDDING_FAILED = 'AGORA_OPENAI_EMBEDDING_FAILED',
  COHERE_EMBEDDING_FAILED = 'AGORA_COHERE_EMBEDDING_FAILED',

  // Payment errors (7xx)
  PAYMENT_REQUIREMENT_MISSING = 'AGORA_PAYMENT_REQUIREMENT_MISSING',
  PAYMENT_REQUIREMENT_EXPIRED = 'AGORA_PAYMENT_REQUIREMENT_EXPIRED',
  PAYMENT_INVALID_AMOUNT = 'AGORA_PAYMENT_INVALID_AMOUNT',
  PAYMENT_UNSUPPORTED_NETWORK = 'AGORA_PAYMENT_UNSUPPORTED_NETWORK',
  PAYMENT_DECODE_FAILED = 'AGORA_PAYMENT_DECODE_FAILED',
  PAYMENT_INVALID_REQUIREMENT = 'AGORA_PAYMENT_INVALID_REQUIREMENT',

  // Agent errors (8xx)
  AGENT_NO_URL = 'AGORA_AGENT_NO_URL',
  AGENT_NO_PAYMENT_ADDRESS = 'AGORA_AGENT_NO_PAYMENT_ADDRESS',

  // Escrow errors (9xx)
  ESCROW_NOT_FOUND = 'AGORA_ESCROW_NOT_FOUND',
  ESCROW_OPERATION_FAILED = 'AGORA_ESCROW_OPERATION_FAILED',

  // Bridge payment errors (10xx)
  PAYMENT_VALIDATION_FAILED = 'AGORA_PAYMENT_VALIDATION_FAILED',
  PAYMENT_PARSE_FAILED = 'AGORA_PAYMENT_PARSE_FAILED',

  // Registration errors (11xx)
  REGISTRATION_FAILED = 'AGORA_REGISTRATION_FAILED',

  // Node/network errors (12xx)
  NODE_REQUEST_FAILED = 'AGORA_NODE_REQUEST_FAILED',
  BRIDGE_NOT_CONFIGURED = 'AGORA_BRIDGE_NOT_CONFIGURED',
}

/**
 * Base error class for all AgoraMesh SDK errors.
 * Includes an error code and optional context for debugging.
 */
export class AgoraMeshError extends Error {
  /** Machine-readable error code */
  readonly code: AgoraMeshErrorCode;
  /** Additional context for debugging */
  readonly context?: Record<string, unknown>;

  constructor(
    code: AgoraMeshErrorCode,
    message: string,
    context?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AgoraMeshError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Error thrown when the client is not connected but an operation requires it.
 */
export class ClientNotConnectedError extends AgoraMeshError {
  constructor(operation: string) {
    super(
      AgoraMeshErrorCode.CLIENT_NOT_CONNECTED,
      `Client is not connected — cannot ${operation}. Call client.connect() before using this method.`,
      { operation },
    );
    this.name = 'ClientNotConnectedError';
  }
}

/**
 * Error thrown when no wallet (private key) is configured but an operation requires signing.
 */
export class WalletNotConnectedError extends AgoraMeshError {
  constructor(operation: string) {
    super(
      AgoraMeshErrorCode.WALLET_NOT_CONNECTED,
      `Wallet not connected — cannot ${operation}. Provide a privateKey in AgoraMeshConfig to enable write operations.`,
      { operation },
    );
    this.name = 'WalletNotConnectedError';
  }
}

/**
 * Error thrown when a required contract address is not configured.
 */
export class ConfigurationError extends AgoraMeshError {
  constructor(
    code: AgoraMeshErrorCode,
    configName: string,
    operation: string,
  ) {
    super(
      code,
      `${configName} not configured — cannot ${operation}. Set ${configName} in AgoraMeshConfig or ContractAddresses.`,
      { configName, operation },
    );
    this.name = 'ConfigurationError';
  }
}
