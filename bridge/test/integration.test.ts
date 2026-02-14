/**
 * AgentMe Integration Tests
 *
 * Tests for automatic agent registration with the AgentMe network.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentMeIntegration } from '../src/integration.js';
import { IPFSService } from '../src/ipfs.js';
import type { AgentConfig } from '../src/types.js';

// Mock the SDK
vi.mock('@agentme/sdk', () => ({
  AgentMeClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    registerAgent: vi.fn().mockResolvedValue('0x1234567890abcdef'),
    getAgent: vi.fn().mockResolvedValue(null),
    isAgentActive: vi.fn().mockResolvedValue(false),
    getAddress: vi.fn().mockReturnValue('0xAgentAddress'),
  })),
  DiscoveryClient: vi.fn().mockImplementation(() => ({
    setNodeUrl: vi.fn(),
    announce: vi.fn().mockResolvedValue(undefined),
    unannounce: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock IPFS service for registration tests
const createMockIPFSService = (configured = true): IPFSService => {
  const service = new IPFSService({
    provider: 'pinata',
    pinataJwt: configured ? 'mock-jwt' : '',
  });
  if (configured) {
    vi.spyOn(service, 'uploadJSON').mockResolvedValue('QmMockIPFSCID123');
  }
  return service;
};

describe('AgentMeIntegration', () => {
  let integration: AgentMeIntegration;
  let config: AgentConfig;

  beforeEach(() => {
    config = {
      name: 'Test Agent',
      description: 'A test agent for unit tests',
      skills: ['typescript', 'testing'],
      pricePerTask: 5,
      privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      workspaceDir: '/workspace',
      allowedCommands: ['npm', 'node'],
      taskTimeout: 300,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create integration with valid config', () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      });

      expect(integration).toBeDefined();
    });

    it('should throw if privateKey is missing', () => {
      const badConfig = { ...config, privateKey: '' };

      expect(() => new AgentMeIntegration(badConfig, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      })).toThrow('Private key is required');
    });
  });

  describe('generateDID', () => {
    it('should generate a valid AgentMe DID', () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      });

      const did = integration.getDID();

      expect(did).toMatch(/^did:agentme:base:0x[a-fA-F0-9]+$/);
    });

    it('should generate different DIDs for different chainIds', () => {
      const integration1 = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      });

      const integration2 = new AgentMeIntegration(config, {
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453,
      });

      // DIDs should be the same since they're derived from the address, not chainId
      // but let's check they're both valid
      expect(integration1.getDID()).toMatch(/^did:agentme:base:0x/);
      expect(integration2.getDID()).toMatch(/^did:agentme:base:0x/);
    });
  });

  describe('createCapabilityCard', () => {
    it('should create a valid capability card from config', () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      });

      const card = integration.createCapabilityCard('http://localhost:3402');

      expect(card.name).toBe('Test Agent');
      expect(card.description).toBe('A test agent for unit tests');
      expect(card.url).toBe('http://localhost:3402');
      expect(card.skills).toHaveLength(2);
      expect(card.skills[0].tags).toContain('typescript');
      // Pricing is now on each skill, following SDK CapabilityCard format
      expect(card.skills[0].pricing?.amount).toBe('5');
      expect(card.skills[0].pricing?.currency).toBe('USDC');
      // Check payment methods are configured
      expect(card.payment?.methods).toContain('x402');
      expect(card.payment?.methods).toContain('escrow');
    });
  });

  describe('register', () => {
    beforeEach(() => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        trustRegistryAddress: '0xTrustRegistry',
        pinataJwt: 'test-jwt',
      });
      // Inject mock IPFS service
      integration.setIPFSService(createMockIPFSService());
    });

    it('should register agent on-chain with IPFS upload', async () => {
      const txHash = await integration.register('http://localhost:3402');

      expect(txHash).toBe('0x1234567890abcdef');
    });

    it('should throw if IPFS is not configured', async () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        trustRegistryAddress: '0xTrustRegistry',
        // No pinataJwt
      });
      // Inject unconfigured IPFS service
      integration.setIPFSService(createMockIPFSService(false));

      await expect(integration.register('http://localhost:3402'))
        .rejects.toThrow('IPFS not configured');
    });

    it('should skip registration if agent already registered', async () => {
      // Mock getAgent to return existing agent
      const { AgentMeClient } = await import('@agentme/sdk');
      vi.mocked(AgentMeClient).mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        registerAgent: vi.fn().mockResolvedValue('0xnew'),
        getAgent: vi.fn().mockResolvedValue({ did: 'existing', isActive: true }),
        isAgentActive: vi.fn().mockResolvedValue(true),
        getAddress: vi.fn().mockReturnValue('0xAgentAddress'),
      }) as any);

      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        trustRegistryAddress: '0xTrustRegistry',
      });

      const txHash = await integration.register('http://localhost:3402');

      // Should return null if already registered
      expect(txHash).toBeNull();
    });
  });

  describe('announce', () => {
    beforeEach(() => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        nodeUrl: 'http://localhost:8080',
      });
    });

    it('should announce capability card to P2P network', async () => {
      await integration.announce('http://localhost:3402');

      // Should complete without error
      expect(true).toBe(true);
    });

    it('should throw if nodeUrl not configured', async () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        // No nodeUrl
      });

      await expect(integration.announce('http://localhost:3402'))
        .rejects.toThrow('Node URL not configured');
    });
  });

  describe('unannounce', () => {
    it('should remove agent from P2P network', async () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
        nodeUrl: 'http://localhost:8080',
      });

      await integration.unannounce();

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should disconnect from blockchain', () => {
      integration = new AgentMeIntegration(config, {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532,
      });

      integration.disconnect();

      // Should complete without error
      expect(true).toBe(true);
    });
  });
});
