/**
 * AgentMesh Integration
 *
 * Handles automatic registration and announcement to the AgentMesh network.
 */

import { createHash } from 'crypto';
import type { AgentConfig } from './types.js';
import { IPFSService } from './ipfs.js';
import { RegistrationError, type Result, success, failure } from './errors.js';

// Import SDK types
import type {
  CapabilityCard,
  Skill,
  AgentMeshConfig,
  AgentMeshClient,
  DiscoveryClient,
} from '@agentme/sdk';

/**
 * Configuration for AgentMesh integration.
 */
export interface IntegrationConfig {
  /** RPC URL for the blockchain */
  rpcUrl: string;
  /** Chain ID (84532 for Base Sepolia, 8453 for Base Mainnet) */
  chainId: number;
  /** Trust Registry contract address */
  trustRegistryAddress?: string;
  /** AgentMesh node URL for P2P discovery */
  nodeUrl?: string;
  /** IPFS gateway for capability card retrieval */
  ipfsGateway?: string;
  /** Pinata JWT for IPFS uploads */
  pinataJwt?: string;
}

/**
 * Handles integration with the AgentMesh network.
 *
 * Provides methods to:
 * - Register agent on-chain
 * - Announce capability card to P2P network
 * - Generate DID from private key
 */
export class AgentMeshIntegration {
  private readonly agentConfig: AgentConfig;
  private readonly integrationConfig: IntegrationConfig;
  private readonly did: string;
  private client: AgentMeshClient | null = null;
  private discovery: DiscoveryClient | null = null;
  private ipfsService: IPFSService;
  private connected = false;

  /**
   * Create a new AgentMesh integration.
   *
   * @param agentConfig - The agent's configuration
   * @param integrationConfig - AgentMesh network configuration
   * @throws Error if privateKey is missing
   */
  constructor(agentConfig: AgentConfig, integrationConfig: IntegrationConfig) {
    if (!agentConfig.privateKey || agentConfig.privateKey === '') {
      throw new Error('Private key is required for AgentMesh integration');
    }

    this.agentConfig = agentConfig;
    this.integrationConfig = integrationConfig;

    // Initialize IPFS service
    this.ipfsService = new IPFSService({
      provider: 'pinata',
      pinataJwt: integrationConfig.pinataJwt || '',
      gateway: integrationConfig.ipfsGateway,
    });

    // Generate DID from private key
    // In real implementation, this would derive the address from the key
    this.did = this.generateDID(agentConfig.privateKey);
  }

  /**
   * Set a custom IPFS service (for testing or alternative providers).
   *
   * @param service - The IPFS service to use
   */
  setIPFSService(service: IPFSService): void {
    this.ipfsService = service;
  }

  /**
   * Generate a DID from the private key.
   *
   * Format: did:agentmesh:base:0x{address}
   */
  private generateDID(privateKey: string): string {
    // In a real implementation, we'd use viem to derive the address
    // For now, use a cryptographic hash of the key
    const hash = this.secureHash(privateKey);
    return `did:agentmesh:base:${hash}`;
  }

  /**
   * Cryptographic hash function for DID generation.
   * Uses SHA-256, truncated to 20 bytes (Ethereum address length).
   */
  private secureHash(input: string): string {
    const hash = createHash('sha256').update(input).digest('hex');
    // Take first 40 hex chars (20 bytes) to match Ethereum address format
    return '0x' + hash.slice(0, 40);
  }

  /**
   * Get the agent's DID.
   */
  getDID(): string {
    return this.did;
  }

  /**
   * Create a capability card from the agent config.
   *
   * @param endpoint - The public URL where this agent is accessible
   * @returns A valid capability card compatible with SDK's CapabilityCard type
   */
  createCapabilityCard(endpoint: string): CapabilityCard {
    // Convert simple skill strings to SDK Skill format
    const skills: Skill[] = this.agentConfig.skills.map((skill, index) => ({
      id: `skill-${index}`,
      name: skill,
      description: `Capability: ${skill}`,
      tags: [skill],
      pricing: {
        model: 'per_request' as const,
        amount: String(this.agentConfig.pricePerTask),
        currency: 'USDC',
      },
    }));

    return {
      id: this.did,
      name: this.agentConfig.name,
      description: this.agentConfig.description,
      url: endpoint,
      version: '1.0.0',
      skills,
      authentication: {
        schemes: ['none'], // Bridge handles auth separately
      },
      payment: {
        methods: ['x402', 'escrow'],
        currencies: ['USDC'],
        chains: ['base'],
        addresses: {
          base: this.getAddress() as `0x${string}`,
        },
      },
      capabilities: {
        streaming: false,
        pushNotifications: false,
        x402Payments: true,
        escrow: true,
      },
    };
  }

  /**
   * Get the wallet address derived from the private key.
   * @returns The Ethereum address
   */
  private getAddress(): string {
    // Use viem to derive address from private key
    try {
      // In real implementation, use privateKeyToAccount from viem
      // For now, return a placeholder based on the DID
      const didParts = this.did.split(':');
      return didParts[didParts.length - 1] || '0x0000000000000000000000000000000000000000';
    } catch {
      return '0x0000000000000000000000000000000000000000';
    }
  }

  /**
   * Connect to the blockchain.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return;

    try {
      // Dynamic import to avoid requiring SDK at module load time
      const { AgentMeshClient, DiscoveryClient } = await import('@agentme/sdk');

      const clientConfig: AgentMeshConfig = {
        rpcUrl: this.integrationConfig.rpcUrl,
        chainId: this.integrationConfig.chainId,
        privateKey: this.agentConfig.privateKey as `0x${string}`,
        trustRegistryAddress: this.integrationConfig.trustRegistryAddress as `0x${string}` | undefined,
      };

      this.client = new AgentMeshClient(clientConfig);
      await this.client.connect();

      this.discovery = new DiscoveryClient(this.client);
      if (this.integrationConfig.nodeUrl) {
        this.discovery.setNodeUrl(this.integrationConfig.nodeUrl);
      }

      this.connected = true;
    } catch (error) {
      // SDK not available - log warning but continue
      console.warn('[Integration] AgentMesh SDK not available:', error);
      throw error;
    }
  }

  /**
   * Register the agent on-chain with Result-based error handling.
   *
   * @param endpoint - The public URL where this agent is accessible
   * @returns Result with transaction hash on success, or RegistrationError on failure
   */
  async registerResult(
    endpoint: string
  ): Promise<Result<{ txHash: string; isNew: boolean }, RegistrationError>> {
    try {
      await this.ensureConnected();

      // Check if already registered (client guaranteed non-null after ensureConnected)
      const existingAgent = await this.client!.getAgent(this.did);
      if (existingAgent && existingAgent.isActive) {
        console.log(`[Integration] Agent already registered: ${this.did}`);
        // Return success with isNew=false to indicate already registered
        return success({ txHash: '', isNew: false });
      }

      const card = this.createCapabilityCard(endpoint);

      // Upload capability card to IPFS
      let capabilityCardCID: string;
      if (this.ipfsService.isConfigured()) {
        console.log('[Integration] Uploading capability card to IPFS...');
        capabilityCardCID = await this.ipfsService.uploadJSON(card, {
          name: `agentmesh-capability-card-${this.did}`,
          keyvalues: {
            type: 'capability-card',
            did: this.did,
            version: card.version,
          },
        });
        console.log(`[Integration] Uploaded to IPFS: ${capabilityCardCID}`);
      } else {
        return failure(
          new RegistrationError(
            'IPFS not configured. Set PINATA_JWT environment variable or pinataJwt in config.',
            this.did
          )
        );
      }

      const txHash = await this.client!.registerAgent(card, capabilityCardCID);
      console.log(`[Integration] Agent registered: ${txHash}`);

      return success({ txHash, isNew: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return failure(new RegistrationError(`Registration failed: ${err.message}`, this.did, err));
    }
  }

  /**
   * Register the agent on-chain (legacy compatibility).
   *
   * @param endpoint - The public URL where this agent is accessible
   * @returns Transaction hash, or null if already registered
   * @throws Error if IPFS is not configured or registration fails
   * @deprecated Use registerResult() for proper error handling
   */
  async register(endpoint: string): Promise<string | null> {
    const result = await this.registerResult(endpoint);

    if (!result.success) {
      throw new Error(result.error.message);
    }

    return result.value.isNew ? result.value.txHash : null;
  }

  /**
   * Announce the capability card to the P2P network.
   *
   * @param endpoint - The public URL where this agent is accessible
   */
  async announce(endpoint: string): Promise<void> {
    if (!this.integrationConfig.nodeUrl) {
      throw new Error('Node URL not configured for P2P announcement');
    }

    await this.ensureConnected();

    const card = this.createCapabilityCard(endpoint);
    await this.discovery!.announce(card);

    console.log(`[Integration] Announced to P2P network: ${this.did}`);
  }

  /**
   * Remove the agent from the P2P network.
   */
  async unannounce(): Promise<void> {
    if (!this.integrationConfig.nodeUrl) {
      throw new Error('Node URL not configured for P2P announcement');
    }

    await this.ensureConnected();
    await this.discovery!.unannounce(this.did);

    console.log(`[Integration] Removed from P2P network: ${this.did}`);
  }

  /**
   * Disconnect from the blockchain.
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
    }
    this.client = null;
    this.discovery = null;
    this.connected = false;
  }
}
