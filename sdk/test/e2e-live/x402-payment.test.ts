/**
 * x402 Payment Flow E2E Integration Test
 * 
 * Tests the complete x402 micropayment flow:
 * 1. Client requests resource without payment → 402 Payment Required
 * 2. Client receives payment requirements in header
 * 3. Client creates signed payment payload 
 * 4. Client retries request with payment → 200 Success
 * 5. Verify payment was validated and processed
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import { Server } from 'http';
import { generatePrivateKey } from 'viem/accounts';
import { 
  createX402Middleware,
  createSignedPaymentPayload,
  parsePaymentPayload,
  X402Config,
  X402_HEADERS,
  type X402Request,
  _resetUsedNonces
} from '../../../bridge/src/middleware/x402.js';

// =============================================================================
// Test Configuration
// =============================================================================

/** Test configuration for x402 middleware */
const TEST_X402_CONFIG: X402Config = {
  payTo: '0x1234567890123456789012345678901234567890',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  priceUsdc: 0.01, // 1 cent per request
  network: 'eip155:8453', // Base Mainnet
  validityPeriod: 300, // 5 minutes
  skipPaths: ['/health', '/.well-known/agent.json'], // Free endpoints
};

/** Test private key (Anvil account #5) */
const TEST_PRIVATE_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

/** Test payer address (derived from private key) */
const TEST_PAYER_ADDRESS = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

// =============================================================================
// Test Server Setup
// =============================================================================

describe('x402 Payment Flow E2E Integration', () => {
  let app: Express;
  let server: Server;
  let serverUrl: string;

  beforeAll(async () => {
    // Reset nonce store for clean test state
    _resetUsedNonces();

    // Create Express app with x402 middleware
    app = express();
    app.use(express.json());

    // Apply x402 middleware globally
    app.use(createX402Middleware(TEST_X402_CONFIG));

    // Protected endpoint - requires payment
    app.post('/task', (req: Request, res: Response) => {
      const x402Req = req as X402Request;
      const payment = x402Req.x402Payment;
      
      res.json({
        success: true,
        message: 'Task executed successfully',
        taskId: 'task_12345',
        payment: payment ? {
          from: payment.from,
          amount: payment.amount,
          nonce: payment.nonce,
          timestamp: payment.timestamp,
        } : null,
      });
    });

    // Free endpoint - should not require payment
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Agent metadata endpoint - should not require payment
    app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
      res.json({ name: 'Test Agent', version: '1.0.0' });
    });

    // Start server on random port
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    serverUrl = `http://localhost:${address.port}`;
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  // ===========================================================================
  // Test Cases
  // ===========================================================================

  it('should return 402 Payment Required for protected endpoint without payment', async () => {
    const response = await request(app)
      .post('/task')
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    // Verify error response
    expect(response.body).toEqual({
      error: 'Payment Required',
      message: 'This endpoint requires payment via x402 protocol',
      paymentInfo: expect.objectContaining({
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '10000', // 0.01 USDC = 10,000 micro-USDC
        resource: TEST_X402_CONFIG.usdcAddress,
        payTo: TEST_X402_CONFIG.payTo,
        description: 'AgentMe task execution',
        validUntil: expect.any(Number),
      }),
    });

    // Verify payment required header is present
    const paymentRequiredHeader = response.headers[X402_HEADERS.PAYMENT_REQUIRED];
    expect(paymentRequiredHeader).toBeDefined();

    // Verify header contains base64-encoded payment requirement
    const decoded = Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8');
    const requirement = JSON.parse(decoded);
    expect(requirement).toEqual(response.body.paymentInfo);
  });

  it('should allow access to free endpoints without payment', async () => {
    // Health endpoint
    const healthResponse = await request(app)
      .get('/health')
      .expect(200);

    expect(healthResponse.body).toEqual({
      status: 'ok',
      timestamp: expect.any(Number),
    });

    // Agent metadata endpoint
    const agentResponse = await request(app)
      .get('/.well-known/agent.json')
      .expect(200);

    expect(agentResponse.body).toEqual({
      name: 'Test Agent',
      version: '1.0.0',
    });
  });

  it('should accept valid signed payment and process request', async () => {
    // Step 1: Get payment requirements
    const initialResponse = await request(app)
      .post('/task')
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    const paymentRequiredHeader = initialResponse.headers[X402_HEADERS.PAYMENT_REQUIRED];
    expect(paymentRequiredHeader).toBeDefined();

    // Step 2: Create signed payment payload
    const signedPayload = await createSignedPaymentPayload(
      TEST_X402_CONFIG,
      TEST_PRIVATE_KEY
    );

    // Verify the payload structure
    expect(signedPayload).toEqual({
      scheme: 'exact',
      network: 'eip155:8453',
      signature: expect.stringMatching(/^0x[0-9a-fA-F]{130}$/), // 65 bytes = 130 hex chars
      resource: TEST_X402_CONFIG.usdcAddress,
      amount: '10000', // 0.01 USDC in micro-USDC
      from: TEST_PAYER_ADDRESS,
      timestamp: expect.any(Number),
      nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), // UUID format
    });

    // Step 3: Make request with payment
    const paymentHeader = Buffer.from(JSON.stringify(signedPayload)).toString('base64');
    
    const paidResponse = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(200);

    // Step 4: Verify successful response
    expect(paidResponse.body).toEqual({
      success: true,
      message: 'Task executed successfully',
      taskId: 'task_12345',
      payment: {
        from: TEST_PAYER_ADDRESS,
        amount: '10000',
        nonce: signedPayload.nonce,
        timestamp: signedPayload.timestamp,
      },
    });
  });

  it('should reject invalid payment payload', async () => {
    // Create invalid payment payload (missing signature)
    const invalidPayload = {
      scheme: 'exact',
      network: 'eip155:8453',
      resource: TEST_X402_CONFIG.usdcAddress,
      amount: '10000',
      from: TEST_PAYER_ADDRESS,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      // Missing signature
    };

    const paymentHeader = Buffer.from(JSON.stringify(invalidPayload)).toString('base64');
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(400);

    expect(response.body).toEqual({
      error: 'Invalid Payment',
      message: 'Could not parse payment payload',
    });
  });

  it('should reject payment with invalid signature', async () => {
    // Create payload with fake signature
    const invalidPayload = {
      scheme: 'exact',
      network: 'eip155:8453',
      signature: '0x' + 'f'.repeat(130), // Fake signature
      resource: TEST_X402_CONFIG.usdcAddress,
      amount: '10000',
      from: TEST_PAYER_ADDRESS,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
    };

    const paymentHeader = Buffer.from(JSON.stringify(invalidPayload)).toString('base64');
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    expect(response.body.error).toBe('Payment Invalid');
    expect(response.body.message).toContain('signature');
  });

  it('should reject payment with insufficient amount', async () => {
    // Create signed payload with insufficient amount
    const config = { ...TEST_X402_CONFIG, priceUsdc: 100 }; // Much higher price
    const signedPayload = await createSignedPaymentPayload(config, TEST_PRIVATE_KEY);
    
    // But send the original lower amount
    const underPaidPayload = {
      ...signedPayload,
      amount: '1000', // Only 0.001 USDC instead of required 100 USDC
    };

    const paymentHeader = Buffer.from(JSON.stringify(underPaidPayload)).toString('base64');
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    expect(response.body.error).toBe('Payment Invalid');
    expect(response.body.message).toContain('amount');
  });

  it('should prevent replay attacks with same nonce', async () => {
    // Create signed payment payload
    const signedPayload = await createSignedPaymentPayload(
      TEST_X402_CONFIG,
      TEST_PRIVATE_KEY
    );

    const paymentHeader = Buffer.from(JSON.stringify(signedPayload)).toString('base64');

    // First request should succeed
    const firstResponse = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'First request' })
      .expect(200);

    expect(firstResponse.body.success).toBe(true);

    // Second request with same nonce should be rejected
    const secondResponse = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Replay attempt' })
      .expect(402);

    expect(secondResponse.body.error).toBe('Payment Invalid');
    expect(secondResponse.body.message).toContain('Nonce');
  });

  it('should reject expired payment', async () => {
    // Create payment with past timestamp
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    
    const config = { ...TEST_X402_CONFIG, validityPeriod: 300 }; // 5 minutes validity
    const signedPayload = await createSignedPaymentPayload(config, TEST_PRIVATE_KEY);
    
    // Override timestamp to simulate expired payment
    const expiredPayload = {
      ...signedPayload,
      timestamp: expiredTimestamp,
    };

    // Need to re-sign with the expired timestamp for valid signature
    const paymentMessage = JSON.stringify({
      scheme: expiredPayload.scheme,
      network: expiredPayload.network,
      resource: expiredPayload.resource,
      amount: expiredPayload.amount,
      from: expiredPayload.from,
      timestamp: expiredTimestamp,
      nonce: expiredPayload.nonce,
    });

    // For this test, we'll just use the expired payload as-is since signature verification
    // would require re-implementing the signing logic here
    const paymentHeader = Buffer.from(JSON.stringify(expiredPayload)).toString('base64');
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    expect(response.body.error).toBe('Payment Invalid');
    expect(response.body.message).toContain('expired');
  });

  it('should handle malformed payment header gracefully', async () => {
    // Send malformed base64
    const malformedHeader = 'not-valid-base64!@#';
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, malformedHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(400);

    expect(response.body).toEqual({
      error: 'Invalid Payment',
      message: 'Could not parse payment payload',
    });
  });

  it('should validate network mismatch', async () => {
    // Create payload with wrong network
    const wrongNetworkPayload = await createSignedPaymentPayload(
      { ...TEST_X402_CONFIG, network: 'eip155:1' }, // Ethereum mainnet instead of Base
      TEST_PRIVATE_KEY
    );

    const paymentHeader = Buffer.from(JSON.stringify(wrongNetworkPayload)).toString('base64');
    
    const response = await request(app)
      .post('/task')
      .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
      .send({ prompt: 'Hello, world!' })
      .expect(402);

    expect(response.body.error).toBe('Payment Invalid');
    expect(response.body.message).toContain('Network mismatch');
  });

  // ===========================================================================
  // Integration Test with Multiple Requests
  // ===========================================================================

  it('should handle multiple successful payments with different nonces', async () => {
    const tasks = [
      { prompt: 'Task 1', expectedTaskId: 'task_12345' },
      { prompt: 'Task 2', expectedTaskId: 'task_12345' },
      { prompt: 'Task 3', expectedTaskId: 'task_12345' },
    ];

    const usedNonces = new Set<string>();

    for (const [index, task] of tasks.entries()) {
      // Create unique payment for each request
      const signedPayload = await createSignedPaymentPayload(
        TEST_X402_CONFIG,
        TEST_PRIVATE_KEY
      );

      // Ensure nonce is unique across all requests
      expect(usedNonces.has(signedPayload.nonce)).toBe(false);
      usedNonces.add(signedPayload.nonce);

      const paymentHeader = Buffer.from(JSON.stringify(signedPayload)).toString('base64');
      
      const response = await request(app)
        .post('/task')
        .set(X402_HEADERS.PAYMENT_SIGNATURE, paymentHeader)
        .send({ prompt: task.prompt })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Task executed successfully',
        taskId: task.expectedTaskId,
        payment: {
          from: TEST_PAYER_ADDRESS,
          amount: '10000',
          nonce: signedPayload.nonce,
          timestamp: signedPayload.timestamp,
        },
      });
    }

    // Verify we processed multiple unique payments
    expect(usedNonces.size).toBe(tasks.length);
  });
});