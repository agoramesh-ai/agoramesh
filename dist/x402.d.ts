/**
 * AgoraMesh x402 Payment Client
 *
 * Implements the x402 micropayment protocol for pay-per-request agent services.
 * x402 is ideal for small, trusted transactions where escrow overhead isn't needed.
 *
 * @packageDocumentation
 * @see https://docs.cdp.coinbase.com/x402/welcome
 */
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
export declare class X402Client {
    private readonly account;
    private readonly walletClient;
    private readonly networkId;
    /**
     * Create a new x402 client.
     *
     * @param config - Client configuration
     */
    constructor(config: X402Config);
    /**
     * Get the payer's address.
     */
    getAddress(): `0x${string}`;
    /**
     * Get the network identifier.
     */
    getNetworkId(): string;
    /**
     * Make an HTTP request with automatic x402 payment handling.
     *
     * @param url - Request URL
     * @param init - Fetch options
     * @param options - x402 options
     * @returns Fetch response
     */
    fetch(url: string | URL, init?: RequestInit, options?: X402FetchOptions): Promise<Response>;
    /**
     * Create a fetch wrapper with x402 payment handling.
     *
     * @param options - x402 options
     * @returns Wrapped fetch function
     */
    createFetchWrapper(options?: X402FetchOptions): typeof fetch;
    /**
     * Decode payment requirements from a 402 response header.
     *
     * @param header - The x-payment-required header value
     * @returns Decoded payment requirement
     */
    decodePaymentRequirement(header: string): PaymentRequirement;
    /**
     * Create a signed payment payload for a requirement.
     *
     * @param requirement - Payment requirement from 402 response
     * @returns Signed payment payload
     */
    createPaymentPayload(requirement: PaymentRequirement): Promise<PaymentPayload>;
    /**
     * Encode a payment payload for the request header.
     *
     * @param payload - Payment payload to encode
     * @returns Base64-encoded payload
     */
    encodePaymentPayload(payload: PaymentPayload): string;
    /**
     * Parse payment result from response headers.
     *
     * @param response - The HTTP response
     * @returns Payment settle response or null
     */
    getPaymentResult(response: Response): PaymentSettleResponse | null;
    /**
     * Check if a response indicates payment was successful.
     *
     * @param response - The HTTP response
     * @returns True if payment was successful
     */
    wasPaymentSuccessful(response: Response): boolean;
    /**
     * Create the message to sign for a payment.
     */
    private createPaymentMessage;
}
/**
 * Check if a response is a 402 Payment Required.
 */
export declare function isPaymentRequired(response: Response): boolean;
/**
 * Create a simple x402 client from a private key.
 *
 * @param privateKey - Private key with 0x prefix
 * @param chainId - Chain ID (default: Base Sepolia)
 * @returns X402Client instance
 */
export declare function createX402Client(privateKey: `0x${string}`, chainId?: number): X402Client;
/**
 * Wrap fetch with x402 payment handling.
 *
 * @param privateKey - Private key with 0x prefix
 * @param options - x402 options
 * @returns Wrapped fetch function
 */
export declare function wrapFetchWithX402(privateKey: `0x${string}`, options?: X402FetchOptions & {
    chainId?: number;
}): typeof fetch;
//# sourceMappingURL=x402.d.ts.map