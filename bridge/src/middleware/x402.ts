/**
 * x402 Payment Middleware
 *
 * Implements HTTP 402 Payment Required flow for micropayments.
 * Uses the x402 protocol (Coinbase standard) for USDC payments on Base L2.
 *
 * @see https://docs.cdp.coinbase.com/x402/welcome
 */

import { Request, Response, NextFunction } from 'express';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'crypto';
import { PaymentParseError, type Result, success, failure } from '../errors.js';

// Nonce store for replay protection
const usedNonces = new Map<string, number>(); // nonce -> timestamp

/**
 * Reset the nonce store. Only for testing.
 * @internal
 */
export function _resetUsedNonces(): void {
  usedNonces.clear();
}

// Clean expired nonces every 5 minutes
// unref() allows the process to exit if this is the only timer remaining
const nonceCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [nonce, timestamp] of usedNonces.entries()) {
    if (timestamp < cutoff) {
      usedNonces.delete(nonce);
    }
  }
}, 5 * 60 * 1000);
nonceCleanupTimer.unref();

/**
 * x402 PaymentRequirement object
 */
export interface PaymentRequirement {
  /** Payment scheme (e.g., 'exact') */
  scheme: string;
  /** CAIP-2 network identifier (e.g., 'eip155:8453' for Base) */
  network: string;
  /** Amount in smallest unit (e.g., USDC has 6 decimals) */
  maxAmountRequired: string;
  /** Token contract address */
  resource: string;
  /** Recipient wallet address */
  payTo: string;
  /** Description of what's being paid for */
  description: string;
  /** Payment deadline (Unix timestamp) */
  validUntil: number;
}

/**
 * x402 PaymentPayload from client
 */
export interface PaymentPayload {
  /** Payment scheme used */
  scheme: string;
  /** CAIP-2 network identifier */
  network: string;
  /** Transaction signature or hash */
  signature: string;
  /** Token contract address */
  resource: string;
  /** Payment amount */
  amount: string;
  /** Payer address */
  from: string;
  /** Timestamp when payment was created */
  timestamp: number;
  /** Nonce for replay protection */
  nonce: string;
}

/**
 * Express Request augmented with x402 payment data.
 * Middleware attaches the validated payment to the request object.
 */
export interface X402Request extends Request {
  x402Payment?: PaymentPayload;
}

/**
 * Configuration for x402 middleware
 */
export interface X402Config {
  /** Recipient wallet address */
  payTo: string;
  /** USDC contract address on Base */
  usdcAddress: string;
  /** Price in USDC (as decimal, e.g., 0.01 for 1 cent) */
  priceUsdc: number;
  /** Network identifier (default: 'eip155:8453' for Base Mainnet) */
  network?: string;
  /** Payment validity period in seconds (default: 300 = 5 minutes) */
  validityPeriod?: number;
  /** Optional facilitator URL for payment verification */
  facilitatorUrl?: string;
  /** Whether to skip payment for health/info endpoints */
  skipPaths?: string[];
}

/**
 * Header names used in x402 protocol
 */
export const X402_HEADERS = {
  /** Server response header with payment requirements */
  PAYMENT_REQUIRED: 'x-payment-required',
  /** Client request header with payment proof */
  PAYMENT_SIGNATURE: 'x-payment',
} as const;

/**
 * Creates x402 payment requirement object
 */
export function createPaymentRequirement(config: X402Config): PaymentRequirement {
  const network = config.network || 'eip155:8453'; // Base Mainnet
  const validityPeriod = config.validityPeriod || 300; // 5 minutes
  const amountInMicroUsdc = Math.floor(config.priceUsdc * 1_000_000); // USDC has 6 decimals

  return {
    scheme: 'exact',
    network,
    maxAmountRequired: amountInMicroUsdc.toString(),
    resource: config.usdcAddress,
    payTo: config.payTo,
    description: 'AgentMesh task execution',
    validUntil: Math.floor(Date.now() / 1000) + validityPeriod,
  };
}

/**
 * Parses payment payload from x-payment header with proper error handling
 *
 * Note: Only validates JSON structure, not content validity.
 * Signature validation happens in validatePayment() to return proper 402 status.
 */
export function parsePaymentPayloadResult(header: string): Result<PaymentPayload, PaymentParseError> {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    const payload = JSON.parse(decoded) as PaymentPayload;

    // Only validate that required structural fields exist (not their content)
    // This allows empty strings to pass through to validation stage
    if (payload.scheme === undefined || payload.network === undefined || payload.signature === undefined) {
      return failure(new PaymentParseError('Missing required payment fields', header));
    }

    return success(payload);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return failure(new PaymentParseError('Failed to decode or parse payment payload', header, err));
  }
}

/**
 * Parses payment payload from x-payment header (legacy compatibility)
 *
 * @deprecated Use parsePaymentPayloadResult() for proper error handling
 */
export function parsePaymentPayload(header: string): PaymentPayload | null {
  const result = parsePaymentPayloadResult(header);
  return result.success ? result.value : null;
}

/**
 * Creates the canonical message that should be signed for a payment.
 * This format is used by both signer and verifier.
 */
export function createPaymentMessage(payment: PaymentPayload): string {
  const { signature: _signature, ...paymentWithoutSig } = payment;
  return JSON.stringify(paymentWithoutSig);
}

/**
 * Verifies that the payment signature is valid and matches the claimed payer address.
 * Uses ECDSA signature recovery via viem's recoverMessageAddress.
 *
 * @param payload - The payment payload to verify
 * @returns Object with valid flag and optional error message
 */
export async function verifyPaymentSignature(
  payload: PaymentPayload
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Check signature is present and has minimum length (65 bytes = 130 hex chars + 0x prefix)
    if (!payload.signature || payload.signature.length < 132) {
      return { valid: false, error: 'Invalid or missing signature' };
    }

    // Validate signature format (must be hex)
    if (!/^0x[0-9a-fA-F]+$/.test(payload.signature)) {
      return { valid: false, error: 'Invalid signature format' };
    }

    // Create the message that was signed
    const message = createPaymentMessage(payload);

    // Recover the signer address from the signature
    const recoveredAddress = await recoverMessageAddress({
      message,
      signature: payload.signature as Hex,
    });

    // Verify the recovered address matches the claimed payer
    if (recoveredAddress.toLowerCase() !== payload.from.toLowerCase()) {
      return { valid: false, error: 'Signer address mismatch - signature does not match payer' };
    }

    return { valid: true };
  } catch (_error) {
    // Signature recovery failed - invalid signature
    return { valid: false, error: 'Invalid signature - recovery failed' };
  }
}

/**
 * Validates payment payload against requirements (synchronous checks only)
 */
export function validatePaymentBasic(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
  validityPeriodSecs: number = 300
): { valid: boolean; error?: string } {
  // Check scheme matches
  if (payload.scheme !== requirement.scheme) {
    return { valid: false, error: 'Payment scheme mismatch' };
  }

  // Check network matches
  if (payload.network !== requirement.network) {
    return { valid: false, error: 'Network mismatch' };
  }

  // Check amount is sufficient
  const paidAmount = BigInt(payload.amount);
  const requiredAmount = BigInt(requirement.maxAmountRequired);
  if (paidAmount < requiredAmount) {
    return { valid: false, error: 'Insufficient payment amount' };
  }

  // Check recipient matches
  if (payload.resource.toLowerCase() !== requirement.resource.toLowerCase()) {
    return { valid: false, error: 'Token contract mismatch' };
  }

  // Check payment is not expired
  const now = Math.floor(Date.now() / 1000);
  if (payload.timestamp + validityPeriodSecs < now) {
    return { valid: false, error: 'Payment expired' };
  }

  // Note: Nonce replay protection is handled by the middleware (createX402Middleware)
  // which records nonces before async validation to prevent race conditions.
  // Direct callers should implement their own nonce checking if needed.

  return { valid: true };
}

/**
 * Validates payment payload against requirements including signature verification
 */
export async function validatePaymentFull(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
  validityPeriodSecs: number = 300
): Promise<{ valid: boolean; error?: string }> {
  // First do basic validation
  const basicValidation = validatePaymentBasic(payload, requirement, validityPeriodSecs);
  if (!basicValidation.valid) {
    return basicValidation;
  }

  // Then verify signature
  const signatureValidation = await verifyPaymentSignature(payload);
  if (!signatureValidation.valid) {
    return signatureValidation;
  }

  return { valid: true };
}

/**
 * Validates payment payload against requirements
 * @deprecated Use validatePaymentFull for proper signature verification
 */
export function validatePayment(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
  validityPeriodSecs?: number
): { valid: boolean; error?: string } {
  // For backward compatibility, delegate to basic validation
  // New code should use validatePaymentFull
  return validatePaymentBasic(payload, requirement, validityPeriodSecs);
}

/**
 * Creates Express middleware for x402 payments
 *
 * @example
 * ```typescript
 * const paymentMiddleware = createX402Middleware({
 *   payTo: '0x1234...',
 *   usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
 *   priceUsdc: 0.01,
 * });
 *
 * app.post('/task', paymentMiddleware, taskHandler);
 * ```
 */
export function createX402Middleware(config: X402Config) {
  const skipPaths = config.skipPaths || ['/health', '/.well-known/agent.json'];

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip payment for excluded paths
    if (skipPaths.some((path) => req.path === path || req.path.startsWith(path))) {
      return next();
    }

    // Check for payment header
    const paymentHeader = req.headers[X402_HEADERS.PAYMENT_SIGNATURE] as string | undefined;

    if (!paymentHeader) {
      // No payment - return 402 with payment requirements
      const requirement = createPaymentRequirement(config);
      const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');

      res.setHeader(X402_HEADERS.PAYMENT_REQUIRED, encoded);
      return res.status(402).json({
        error: 'Payment Required',
        message: 'This endpoint requires payment via x402 protocol',
        paymentInfo: requirement,
      });
    }

    // Parse and validate payment
    const payment = parsePaymentPayload(paymentHeader);
    if (!payment) {
      return res.status(400).json({
        error: 'Invalid Payment',
        message: 'Could not parse payment payload',
      });
    }

    const requirement = createPaymentRequirement(config);

    // Check nonce store size to prevent unbounded growth (M-6)
    const MAX_NONCE_STORE_SIZE = 100_000;
    if (usedNonces.size >= MAX_NONCE_STORE_SIZE) {
      return res.status(503).json({ error: 'Server overloaded, try again later' });
    }

    // Check nonce not already used before recording
    if (!payment.nonce || usedNonces.has(payment.nonce)) {
      return res.status(402).json({
        error: 'Payment Invalid',
        message: 'Nonce missing or already used',
        paymentInfo: requirement,
      });
    }

    // Record nonce immediately to prevent race condition (H-5)
    usedNonces.set(payment.nonce, Date.now());

    // Use full validation with signature verification
    const validation = await validatePaymentFull(payment, requirement, config.validityPeriod);

    if (!validation.valid) {
      // Do NOT roll back nonce - prevents replay attacks where attacker
      // submits invalid payment to "free" a nonce for later reuse
      return res.status(402).json({
        error: 'Payment Invalid',
        message: validation.error,
        paymentInfo: requirement,
      });
    }

    // Payment valid - attach to request and continue
    (req as X402Request).x402Payment = payment;
    next();
  };
}

/**
 * Creates a valid payment payload for testing (with mock signature - use createSignedPaymentPayload for real signatures)
 */
export function createTestPaymentPayload(config: X402Config): PaymentPayload {
  const amountInMicroUsdc = Math.floor(config.priceUsdc * 1_000_000);
  return {
    scheme: 'exact',
    network: config.network || 'eip155:8453',
    signature: '0x' + 'a'.repeat(130), // Mock signature - will fail real verification
    resource: config.usdcAddress,
    amount: amountInMicroUsdc.toString(),
    from: '0x' + '1'.repeat(40),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomUUID(),
  };
}

/**
 * Creates a payment payload with a real ECDSA signature for testing.
 * This signature will pass verification.
 *
 * @param config - x402 configuration
 * @param privateKey - Private key to sign with (hex string with 0x prefix)
 * @returns Signed payment payload
 */
export async function createSignedPaymentPayload(
  config: X402Config,
  privateKey: Hex
): Promise<PaymentPayload> {
  const account = privateKeyToAccount(privateKey);
  const amountInMicroUsdc = Math.floor(config.priceUsdc * 1_000_000);

  // Create the payment payload without signature first
  const paymentData = {
    scheme: 'exact',
    network: config.network || 'eip155:8453',
    resource: config.usdcAddress,
    amount: amountInMicroUsdc.toString(),
    from: account.address,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomUUID(),
  };

  // Create the message to sign
  const message = JSON.stringify(paymentData);

  // Sign the message
  const signature = await account.signMessage({ message });

  return {
    ...paymentData,
    signature,
  };
}
