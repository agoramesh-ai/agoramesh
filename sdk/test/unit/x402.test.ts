/**
 * x402 Payment Client Unit Tests
 *
 * Tests for the x402 micropayment protocol integration.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  X402Client,
  createX402Client,
  wrapFetchWithX402,
  isPaymentRequired,
  type PaymentRequirement,
  type X402Config,
} from '../../src/x402.js';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_CHAIN_ID = 84532; // Base Sepolia
const TEST_RECEIVER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`;
const TEST_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a test payment requirement.
 */
function createTestRequirement(
  overrides: Partial<PaymentRequirement> = {}
): PaymentRequirement {
  return {
    network: 'eip155:84532',
    receiver: TEST_RECEIVER,
    amount: '0.10',
    token: TEST_USDC,
    ...overrides,
  };
}

/**
 * Encode a payment requirement as base64 (x402 format).
 */
function encodeRequirement(requirement: PaymentRequirement): string {
  return btoa(JSON.stringify(requirement));
}

/**
 * Create a mock 402 response.
 */
function create402Response(requirement: PaymentRequirement): Response {
  return new Response(null, {
    status: 402,
    headers: {
      'x-payment-required': encodeRequirement(requirement),
    },
  });
}

/**
 * Create a mock 200 OK response.
 */
function create200Response(data: unknown = { success: true }): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('X402Client', () => {
  let config: X402Config;

  beforeEach(() => {
    config = {
      privateKey: TEST_PRIVATE_KEY,
      chainId: TEST_CHAIN_ID,
    };
  });

  describe('Constructor', () => {
    it('should create client with valid config', () => {
      const client = new X402Client(config);

      expect(client).toBeInstanceOf(X402Client);
      expect(client.getAddress()).toBe(TEST_ADDRESS);
      expect(client.getNetworkId()).toBe('eip155:84532');
    });

    it('should create client for Base Mainnet', () => {
      const mainnetConfig: X402Config = {
        privateKey: TEST_PRIVATE_KEY,
        chainId: 8453, // Base Mainnet
      };

      const client = new X402Client(mainnetConfig);

      expect(client.getNetworkId()).toBe('eip155:8453');
    });

    it('should use custom RPC URL when provided', () => {
      const customConfig: X402Config = {
        ...config,
        rpcUrl: 'https://custom.rpc.url',
      };

      const client = new X402Client(customConfig);
      expect(client).toBeInstanceOf(X402Client);
    });
  });

  describe('decodePaymentRequirement', () => {
    it('should decode valid payment requirement', () => {
      const client = new X402Client(config);
      const requirement = createTestRequirement();
      const encoded = encodeRequirement(requirement);

      const decoded = client.decodePaymentRequirement(encoded);

      expect(decoded.network).toBe(requirement.network);
      expect(decoded.receiver).toBe(requirement.receiver);
      expect(decoded.amount).toBe(requirement.amount);
      expect(decoded.token).toBe(requirement.token);
    });

    it('should decode requirement with optional fields', () => {
      const client = new X402Client(config);
      const requirement = createTestRequirement({
        description: 'Payment for agent task',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        facilitatorUrl: 'https://custom.facilitator.url',
      });
      const encoded = encodeRequirement(requirement);

      const decoded = client.decodePaymentRequirement(encoded);

      expect(decoded.description).toBe('Payment for agent task');
      expect(decoded.expiresAt).toBeDefined();
      expect(decoded.facilitatorUrl).toBe('https://custom.facilitator.url');
    });

    it('should throw on invalid base64', () => {
      const client = new X402Client(config);

      expect(() => client.decodePaymentRequirement('not-valid-base64!')).toThrow(
        /Failed to decode payment requirement/
      );
    });

    it('should throw on invalid JSON', () => {
      const client = new X402Client(config);
      const invalidJson = btoa('not valid json');

      expect(() => client.decodePaymentRequirement(invalidJson)).toThrow(
        /Failed to decode payment requirement/
      );
    });

    it('should throw on missing required fields', () => {
      const client = new X402Client(config);
      const incomplete = btoa(JSON.stringify({ network: 'eip155:84532' }));

      expect(() => client.decodePaymentRequirement(incomplete)).toThrow(
        /Invalid payment requirement/
      );
    });
  });

  describe('createPaymentPayload', () => {
    it('should create valid payment payload', async () => {
      const client = new X402Client(config);
      const requirement = createTestRequirement();

      const payload = await client.createPaymentPayload(requirement);

      expect(payload.signature).toMatch(/^0x[0-9a-f]+$/i);
      expect(payload.payer).toBe(TEST_ADDRESS);
      expect(payload.requirement).toEqual(requirement);
      expect(payload.timestamp).toBeGreaterThan(0);
    });

    it('should include timestamp in payload', async () => {
      const client = new X402Client(config);
      const requirement = createTestRequirement();
      const before = Math.floor(Date.now() / 1000);

      const payload = await client.createPaymentPayload(requirement);

      const after = Math.floor(Date.now() / 1000);
      expect(payload.timestamp).toBeGreaterThanOrEqual(before);
      expect(payload.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('encodePaymentPayload', () => {
    it('should encode payload as base64', async () => {
      const client = new X402Client(config);
      const requirement = createTestRequirement();
      const payload = await client.createPaymentPayload(requirement);

      const encoded = client.encodePaymentPayload(payload);

      // Should be valid base64
      const decoded = JSON.parse(atob(encoded));
      expect(decoded.signature).toBe(payload.signature);
      expect(decoded.payer).toBe(payload.payer);
    });
  });

  describe('fetch', () => {
    let client: X402Client;
    let originalFetch: typeof fetch;

    beforeEach(() => {
      client = new X402Client(config);
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should pass through successful requests', async () => {
      global.fetch = vi.fn().mockResolvedValue(create200Response({ data: 'test' }));

      const response = await client.fetch('https://api.example.com/task');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ data: 'test' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle 402 and retry with payment', async () => {
      const requirement = createTestRequirement();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(create402Response(requirement))
        .mockResolvedValueOnce(create200Response({ success: true }));
      global.fetch = mockFetch;

      const response = await client.fetch('https://api.example.com/task');

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check that second call includes payment header
      const secondCall = mockFetch.mock.calls[1];
      const headers = secondCall[1]?.headers as Record<string, string>;
      expect(headers['x-payment']).toBeDefined();
    });

    it('should respect maxAmount option', async () => {
      const requirement = createTestRequirement({ amount: '100.00' });
      global.fetch = vi.fn().mockResolvedValue(create402Response(requirement));

      await expect(
        client.fetch('https://api.example.com/task', undefined, {
          maxAmount: '50.00',
        })
      ).rejects.toThrow(/exceeds configured maximum/);
    });

    it('should call onPayment callback', async () => {
      const requirement = createTestRequirement();
      const onPayment = vi.fn();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(create402Response(requirement))
        .mockResolvedValueOnce(create200Response());

      await client.fetch('https://api.example.com/task', undefined, {
        onPayment,
      });

      expect(onPayment).toHaveBeenCalledTimes(1);
      expect(onPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          signature: expect.any(String),
          payer: TEST_ADDRESS,
        })
      );
    });

    it('should not retry when autoRetry is false', async () => {
      const requirement = createTestRequirement();
      global.fetch = vi.fn().mockResolvedValue(create402Response(requirement));

      const response = await client.fetch('https://api.example.com/task', undefined, {
        autoRetry: false,
      });

      expect(response.status).toBe(402);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should throw on 402 without payment header', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 402 })
      );

      await expect(client.fetch('https://api.example.com/task')).rejects.toThrow(
        /missing the/
      );
    });

    it('should forward request options', async () => {
      global.fetch = vi.fn().mockResolvedValue(create200Response());

      await client.fetch('https://api.example.com/task', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'test' }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/task',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ prompt: 'test' }),
        })
      );
    });
  });

  describe('createFetchWrapper', () => {
    it('should create a wrapped fetch function', () => {
      const client = new X402Client(config);

      const wrappedFetch = client.createFetchWrapper();

      expect(typeof wrappedFetch).toBe('function');
    });

    it('should use wrapper options for all requests', async () => {
      const client = new X402Client(config);
      const originalFetch = global.fetch;
      const onPayment = vi.fn();

      const wrappedFetch = client.createFetchWrapper({
        maxAmount: '10.00',
        onPayment,
      });

      const requirement = createTestRequirement({ amount: '5.00' });
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(create402Response(requirement))
        .mockResolvedValueOnce(create200Response());

      await wrappedFetch('https://api.example.com/task');

      expect(onPayment).toHaveBeenCalled();

      global.fetch = originalFetch;
    });
  });

  describe('getPaymentResult', () => {
    it('should parse payment result from response header', () => {
      const client = new X402Client(config);
      const result = {
        success: true,
        transaction: '0x1234567890abcdef' as `0x${string}`,
        network: 'eip155:84532',
        payer: TEST_ADDRESS,
      };
      const response = new Response(null, {
        headers: {
          'x-payment-response': btoa(JSON.stringify(result)),
        },
      });

      const parsed = client.getPaymentResult(response);

      expect(parsed?.success).toBe(true);
      expect(parsed?.transaction).toBe('0x1234567890abcdef');
      expect(parsed?.network).toBe('eip155:84532');
    });

    it('should return null when header is missing', () => {
      const client = new X402Client(config);
      const response = new Response(null);

      const result = client.getPaymentResult(response);

      expect(result).toBeNull();
    });

    it('should return null for invalid header', () => {
      const client = new X402Client(config);
      const response = new Response(null, {
        headers: {
          'x-payment-response': 'invalid-base64!',
        },
      });

      const result = client.getPaymentResult(response);

      expect(result).toBeNull();
    });
  });

  describe('wasPaymentSuccessful', () => {
    it('should return true for successful payment', () => {
      const client = new X402Client(config);
      const result = { success: true, network: 'eip155:84532', payer: TEST_ADDRESS };
      const response = new Response(null, {
        headers: {
          'x-payment-response': btoa(JSON.stringify(result)),
        },
      });

      expect(client.wasPaymentSuccessful(response)).toBe(true);
    });

    it('should return false for failed payment', () => {
      const client = new X402Client(config);
      const result = { success: false, network: 'eip155:84532', payer: TEST_ADDRESS };
      const response = new Response(null, {
        headers: {
          'x-payment-response': btoa(JSON.stringify(result)),
        },
      });

      expect(client.wasPaymentSuccessful(response)).toBe(false);
    });

    it('should return false when no payment result', () => {
      const client = new X402Client(config);
      const response = new Response(null);

      expect(client.wasPaymentSuccessful(response)).toBe(false);
    });
  });
});

describe('Utility Functions', () => {
  describe('isPaymentRequired', () => {
    it('should return true for 402 response', () => {
      const response = new Response(null, { status: 402 });

      expect(isPaymentRequired(response)).toBe(true);
    });

    it('should return false for 200 response', () => {
      const response = new Response(null, { status: 200 });

      expect(isPaymentRequired(response)).toBe(false);
    });

    it('should return false for other error responses', () => {
      expect(isPaymentRequired(new Response(null, { status: 400 }))).toBe(false);
      expect(isPaymentRequired(new Response(null, { status: 401 }))).toBe(false);
      expect(isPaymentRequired(new Response(null, { status: 403 }))).toBe(false);
      expect(isPaymentRequired(new Response(null, { status: 500 }))).toBe(false);
    });
  });

  describe('createX402Client', () => {
    it('should create client with private key only', () => {
      const client = createX402Client(TEST_PRIVATE_KEY);

      expect(client).toBeInstanceOf(X402Client);
      expect(client.getNetworkId()).toBe('eip155:84532'); // Default to Base Sepolia
    });

    it('should create client with custom chain ID', () => {
      const client = createX402Client(TEST_PRIVATE_KEY, 8453);

      expect(client.getNetworkId()).toBe('eip155:8453');
    });
  });

  describe('wrapFetchWithX402', () => {
    it('should create wrapped fetch function', () => {
      const wrappedFetch = wrapFetchWithX402(TEST_PRIVATE_KEY);

      expect(typeof wrappedFetch).toBe('function');
    });

    it('should use provided chain ID', () => {
      const wrappedFetch = wrapFetchWithX402(TEST_PRIVATE_KEY, {
        chainId: 8453,
      });

      expect(typeof wrappedFetch).toBe('function');
    });
  });
});

describe('Edge Cases', () => {
  it('should handle large payment amounts', async () => {
    const client = new X402Client({
      privateKey: TEST_PRIVATE_KEY,
      chainId: TEST_CHAIN_ID,
    });
    const requirement = createTestRequirement({ amount: '999999999.99' });

    const payload = await client.createPaymentPayload(requirement);

    expect(payload.requirement.amount).toBe('999999999.99');
  });

  it('should handle zero payment amount', async () => {
    const client = new X402Client({
      privateKey: TEST_PRIVATE_KEY,
      chainId: TEST_CHAIN_ID,
    });
    const requirement = createTestRequirement({ amount: '0' });

    const payload = await client.createPaymentPayload(requirement);

    expect(payload.requirement.amount).toBe('0');
  });

  it('should handle URL objects in fetch', async () => {
    const client = new X402Client({
      privateKey: TEST_PRIVATE_KEY,
      chainId: TEST_CHAIN_ID,
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(create200Response());

    const url = new URL('https://api.example.com/task');
    await client.fetch(url);

    expect(global.fetch).toHaveBeenCalledWith(url, undefined);

    global.fetch = originalFetch;
  });
});
