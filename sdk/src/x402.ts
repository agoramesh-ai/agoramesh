/**
 * AgoraMesh x402 Payment Client
 *
 * Implements the x402 micropayment protocol for pay-per-request agent services.
 * x402 is ideal for small, trusted transactions where escrow overhead isn't needed.
 *
 * @packageDocumentation
 * @see https://docs.cdp.coinbase.com/x402/welcome
 */

import { createWalletClient, http, parseUnits, type WalletClient, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

// =============================================================================
// Types
// =============================================================================

/**
 * x402 payment configuration.
 */
export interface X402Config {
  /** Private key for signing payments (with 0x prefix) */
  privateKey: `0x${string}`;
  /** Chain ID (8453 for Base Mainnet, 84532 for Base Sepolia) */
  chainId: number;
  /** RPC URL (optional, uses default if not provided) */
  rpcUrl?: string;
}

/**
 * Payment requirements from a 402 response.
 */
export interface PaymentRequirement {
  /** Network identifier (e.g., "eip155:84532" for Base Sepolia) */
  network: string;
  /** Payment receiver address */
  receiver: `0x${string}`;
  /** Amount to pay (as string) */
  amount: string;
  /** Token address (USDC) */
  token: `0x${string}`;
  /** Optional payment description */
  description?: string;
  /** Payment expiration timestamp */
  expiresAt?: number;
  /** Facilitator URL (Coinbase-hosted service) */
  facilitatorUrl?: string;
}

/**
 * Payment payload to send with retry request.
 */
export interface PaymentPayload {
  /** Signature of the payment authorization */
  signature: `0x${string}`;
  /** Payer address */
  payer: `0x${string}`;
  /** Original payment requirement */
  requirement: PaymentRequirement;
  /** Timestamp of signature */
  timestamp: number;
  /** Unique nonce to prevent replay attacks */
  nonce: string;
}

/**
 * Response from a successful x402 payment.
 */
export interface PaymentSettleResponse {
  /** Whether payment was successful */
  success: boolean;
  /** Transaction hash (if on-chain) */
  transaction?: `0x${string}`;
  /** Network where payment was settled */
  network: string;
  /** Payer address */
  payer: `0x${string}`;
}

/**
 * Options for creating a payment-enabled fetch wrapper.
 */
export interface X402FetchOptions {
  /** Maximum amount willing to pay per request (in USDC) */
  maxAmount?: string;
  /** Whether to automatically retry on 402 (default: true) */
  autoRetry?: boolean;
  /** Callback when payment is made */
  onPayment?: (payment: PaymentPayload) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** x402 header for payment requirements */
const PAYMENT_REQUIRED_HEADER = 'x-payment-required';

/** x402 header for payment signature */
const PAYMENT_SIGNATURE_HEADER = 'x-payment';

/** x402 header for payment result */
const PAYMENT_RESULT_HEADER = 'x-payment-response';

// =============================================================================
// X402Client
// =============================================================================

/**
 * Client for making x402-enabled HTTP requests.
 *
 * x402 enables instant micropayments over HTTP using the 402 Payment Required
 * status code. It's ideal for pay-per-request agent services.
 *
 * @example
 * ```typescript
 * const x402 = new X402Client({
 *   privateKey: '0x...',
 *   chainId: 84532, // Base Sepolia
 * });
 *
 * // Make a request - payment is handled automatically
 * const response = await x402.fetch('https://agent.example.com/api/task', {
 *   method: 'POST',
 *   body: JSON.stringify({ prompt: 'Hello' }),
 * });
 *
 * console.log(await response.json());
 * ```
 */
export class X402Client {
  private readonly account: Account;
  private readonly walletClient: WalletClient;
  private readonly networkId: string;

  /**
   * Create a new x402 client.
   *
   * @param config - Client configuration
   */
  constructor(config: X402Config) {
    this.account = privateKeyToAccount(config.privateKey);
    this.networkId = `eip155:${config.chainId}`;

    const chain = config.chainId === 8453 ? base : baseSepolia;
    const rpcUrl = config.rpcUrl ?? (config.chainId === 8453 
      ? 'https://mainnet.base.org' 
      : 'https://sepolia.base.org');

    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(rpcUrl),
    });
  }

  /**
   * Get the payer's address.
   */
  getAddress(): `0x${string}` {
    return this.account.address;
  }

  /**
   * Get the network identifier.
   */
  getNetworkId(): string {
    return this.networkId;
  }

  /**
   * Make an HTTP request with automatic x402 payment handling.
   *
   * @param url - Request URL
   * @param init - Fetch options
   * @param options - x402 options
   * @returns Fetch response
   */
  async fetch(
    url: string | URL,
    init?: RequestInit,
    options?: X402FetchOptions
  ): Promise<Response> {
    const maxAmount = options?.maxAmount ?? '1'; // Default max 1 USDC for micropayments
    const autoRetry = options?.autoRetry ?? true;

    // Make initial request
    let response = await fetch(url, init);

    // Handle 402 Payment Required
    if (response.status === 402 && autoRetry) {
      const requirementHeader = response.headers.get(PAYMENT_REQUIRED_HEADER);

      if (!requirementHeader) {
        throw new Error('402 response missing payment requirement header');
      }

      const requirement = this.decodePaymentRequirement(requirementHeader);

      // Check if payment requirement has expired
      if (requirement.expiresAt && Date.now() / 1000 > requirement.expiresAt) {
        throw new Error('Payment requirement has expired');
      }

      // Validate payment amount is positive
      const amountWei = parseUnits(requirement.amount, 6);
      if (amountWei <= 0n) {
        throw new Error('Payment amount must be positive');
      }

      // Validate payment amount using BigInt for precision
      if (amountWei > parseUnits(maxAmount, 6)) {
        throw new Error(
          `Payment amount ${requirement.amount} exceeds maximum ${maxAmount}`
        );
      }

      // Create and sign payment
      const payload = await this.createPaymentPayload(requirement);

      // Invoke callback if provided
      options?.onPayment?.(payload);

      // Retry request with payment
      response = await fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          [PAYMENT_SIGNATURE_HEADER]: this.encodePaymentPayload(payload),
        },
      });
    }

    return response;
  }

  /**
   * Create a fetch wrapper with x402 payment handling.
   *
   * @param options - x402 options
   * @returns Wrapped fetch function
   */
  createFetchWrapper(options?: X402FetchOptions): typeof fetch {
    return (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL
        ? input
        : input.url;
      return this.fetch(url, init, options);
    };
  }

  /**
   * Decode payment requirements from a 402 response header.
   *
   * @param header - The x-payment-required header value
   * @returns Decoded payment requirement
   */
  decodePaymentRequirement(header: string): PaymentRequirement {
    try {
      // x402 uses base64-encoded JSON
      const decoded = atob(header);
      const requirement = JSON.parse(decoded) as PaymentRequirement;
      
      // Validate required fields
      if (!requirement.network || !requirement.receiver || !requirement.amount) {
        throw new Error('Invalid payment requirement: missing required fields');
      }

      return requirement;
    } catch (error) {
      throw new Error(`Failed to decode payment requirement: ${error}`);
    }
  }

  /**
   * Create a signed payment payload for a requirement.
   *
   * @param requirement - Payment requirement from 402 response
   * @returns Signed payment payload
   */
  async createPaymentPayload(requirement: PaymentRequirement): Promise<PaymentPayload> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();

    // Create the message to sign
    const message = this.createPaymentMessage(requirement, timestamp, nonce);

    // Sign the message
    const signature = await this.walletClient.signMessage({
      account: this.account,
      message,
    });

    return {
      signature,
      payer: this.account.address,
      requirement,
      timestamp,
      nonce,
    };
  }

  /**
   * Encode a payment payload for the request header.
   *
   * @param payload - Payment payload to encode
   * @returns Base64-encoded payload
   */
  encodePaymentPayload(payload: PaymentPayload): string {
    return btoa(JSON.stringify(payload));
  }

  /**
   * Parse payment result from response headers.
   *
   * @param response - The HTTP response
   * @returns Payment settle response or null
   */
  getPaymentResult(response: Response): PaymentSettleResponse | null {
    const resultHeader = response.headers.get(PAYMENT_RESULT_HEADER);
    if (!resultHeader) return null;

    try {
      const decoded = atob(resultHeader);
      return JSON.parse(decoded) as PaymentSettleResponse;
    } catch {
      return null;
    }
  }

  /**
   * Check if a response indicates payment was successful.
   *
   * @param response - The HTTP response
   * @returns True if payment was successful
   */
  wasPaymentSuccessful(response: Response): boolean {
    const result = this.getPaymentResult(response);
    return result?.success ?? false;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Create the message to sign for a payment.
   */
  private createPaymentMessage(requirement: PaymentRequirement, timestamp: number, nonce: string): string {
    // Standard x402 message format
    return [
      'x402 Payment Authorization',
      `Network: ${requirement.network}`,
      `Receiver: ${requirement.receiver}`,
      `Amount: ${requirement.amount}`,
      `Token: ${requirement.token}`,
      `Timestamp: ${timestamp}`,
      `Nonce: ${nonce}`,
    ].join('\n');
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a response is a 402 Payment Required.
 */
export function isPaymentRequired(response: Response): boolean {
  return response.status === 402;
}

/**
 * Create a simple x402 client from a private key.
 *
 * @param privateKey - Private key with 0x prefix
 * @param chainId - Chain ID (default: Base Sepolia)
 * @returns X402Client instance
 */
export function createX402Client(
  privateKey: `0x${string}`,
  chainId: number = 84532
): X402Client {
  return new X402Client({ privateKey, chainId });
}

/**
 * Wrap fetch with x402 payment handling.
 *
 * @param privateKey - Private key with 0x prefix
 * @param options - x402 options
 * @returns Wrapped fetch function
 */
export function wrapFetchWithX402(
  privateKey: `0x${string}`,
  options?: X402FetchOptions & { chainId?: number }
): typeof fetch {
  const client = createX402Client(privateKey, options?.chainId);
  return client.createFetchWrapper(options);
}
