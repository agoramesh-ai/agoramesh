/**
 * BridgeServer Escrow Integration Tests (TDD)
 *
 * Tests the integration between BridgeServer and EscrowClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { EscrowClient, EscrowState, EscrowConfig, Escrow, EscrowValidation } from '../src/escrow.js';
import { BridgeServer, BridgeServerConfig } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

// Mock the ClaudeExecutor to avoid actual Claude Code execution
vi.mock('../src/executor.js', () => ({
  ClaudeExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({
      taskId: 'test-task-1',
      status: 'completed',
      output: 'Task completed successfully',
      duration: 1234,
    }),
    cancelTask: vi.fn().mockReturnValue(true),
  })),
}));

// Base agent config for tests
const BASE_CONFIG: AgentConfig = {
  name: 'test-agent',
  description: 'Test agent for escrow integration',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['ls', 'cat'],
  taskTimeout: 300,
};

// Sample escrow data
const FUNDED_ESCROW: Escrow = {
  id: 1n,
  clientDid: '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`,
  providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222' as `0x${string}`,
  clientAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  providerAddress: '0x2222222222222222222222222222222222222222' as `0x${string}`,
  amount: 10000000n,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
  taskHash: '0x3333333333333333333333333333333333333333333333333333333333333333' as `0x${string}`,
  outputHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  state: EscrowState.FUNDED,
  createdAt: BigInt(Math.floor(Date.now() / 1000) - 600),
  deliveredAt: 0n,
};

// ========== TDD Tests: Escrow Validation Before Task Execution ==========

describe('BridgeServer Escrow Integration', () => {
  let server: BridgeServer;
  let mockEscrowClient: {
    validateEscrow: ReturnType<typeof vi.fn>;
    confirmDelivery: ReturnType<typeof vi.fn>;
    getEscrow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Create mock escrow client
    mockEscrowClient = {
      validateEscrow: vi.fn(),
      confirmDelivery: vi.fn(),
      getEscrow: vi.fn(),
    };

    // Default: escrow validation passes
    mockEscrowClient.validateEscrow.mockResolvedValue({
      valid: true,
      escrow: FUNDED_ESCROW,
    } as EscrowValidation);

    mockEscrowClient.confirmDelivery.mockResolvedValue(
      '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`
    );
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('task execution with escrow validation', () => {
    it('rejects task when escrow is not FUNDED', async () => {
      mockEscrowClient.validateEscrow.mockResolvedValue({
        valid: false,
        error: 'Invalid escrow state: AWAITING_DEPOSIT. Expected: FUNDED',
        escrow: { ...FUNDED_ESCROW, state: EscrowState.AWAITING_DEPOSIT },
      } as EscrowValidation);

      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0); // Random port

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-1',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1',
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('Escrow Validation Failed');
      expect(res.body.message).toContain('AWAITING_DEPOSIT');
    });

    it('rejects task when escrow deadline has passed', async () => {
      mockEscrowClient.validateEscrow.mockResolvedValue({
        valid: false,
        error: 'Escrow deadline has passed',
        escrow: { ...FUNDED_ESCROW, deadline: BigInt(Math.floor(Date.now() / 1000) - 100) },
      } as EscrowValidation);

      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-2',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1',
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('Escrow Validation Failed');
      expect(res.body.message).toContain('deadline');
    });

    it('rejects task when escrow not found', async () => {
      mockEscrowClient.validateEscrow.mockResolvedValue({
        valid: false,
        error: 'Escrow not found',
      } as EscrowValidation);

      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-3',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '999',
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('Escrow Validation Failed');
      expect(res.body.message).toContain('not found');
    });

    it('accepts task when escrow is valid', async () => {
      mockEscrowClient.validateEscrow.mockResolvedValue({
        valid: true,
        escrow: FUNDED_ESCROW,
      } as EscrowValidation);

      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-4',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1',
        });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
    });

    it('accepts task without escrowId (no escrow validation)', async () => {
      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-5',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          // No escrowId - direct payment or trust-based
        });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      expect(mockEscrowClient.validateEscrow).not.toHaveBeenCalled();
    });
  });

  // ========== TDD Tests: Delivery Confirmation After Task Completion ==========

  describe('delivery confirmation after task completion', () => {
    it('calls confirmDelivery after successful task with escrow', async () => {
      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-6',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1',
        });

      // Wait for async task execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockEscrowClient.confirmDelivery).toHaveBeenCalledWith(
        1n,
        expect.any(String)
      );
    });

    it('does not call confirmDelivery for tasks without escrow', async () => {
      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-7',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          // No escrowId
        });

      // Wait for async task execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockEscrowClient.confirmDelivery).not.toHaveBeenCalled();
    });

    it('logs error but returns result when confirmDelivery fails', async () => {
      mockEscrowClient.confirmDelivery.mockRejectedValue(new Error('Transaction reverted'));

      const config: BridgeServerConfig = {
        ...BASE_CONFIG,
        escrowClient: mockEscrowClient as unknown as EscrowClient,
        providerDid: '0x2222222222222222222222222222222222222222222222222222222222222222',
      };

      server = new BridgeServer(config);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-8',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1',
        });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);

      // Wait for async task execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      // confirmDelivery should have been called
      expect(mockEscrowClient.confirmDelivery).toHaveBeenCalled();
    });
  });

  // ========== TDD Tests: Server Without Escrow Client ==========

  describe('server without escrow client', () => {
    it('accepts tasks normally when no escrow client configured', async () => {
      server = new BridgeServer(BASE_CONFIG);
      await server.start(0);

      const port = server.getPort();
      const res = await request(`http://localhost:${port}`)
        .post('/task')
        .send({
          taskId: 'test-task-9',
          type: 'prompt',
          prompt: 'Hello world',
          clientDid: 'did:agoramesh:base:client1',
          escrowId: '1', // Even with escrowId, should work (just not validated)
        });

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
    });
  });
});
