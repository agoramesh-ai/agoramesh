/**
 * Agent Registration E2E Tests
 *
 * Tests for agent registration, update, and deactivation flows.
 *
 * @packageDocumentation
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { keccak256, toHex } from 'viem';
import { AgoraMeshClient, didToHash } from '../../src/client.js';
import {
  TEST_CHAIN_ID,
  TEST_RPC_URL,
  TEST_PRIVATE_KEYS,
  TEST_ADDRESSES,
  TEST_CONTRACT_ADDRESSES,
  TEST_DIDS,
  createTestCapabilityCard,
  createMockPublicClient,
  createMockWalletClient,
  registerTestAgent,
} from './setup.js';

describe('Agent Registration E2E', () => {
  let client: AgoraMeshClient;
  let mockPublicClient: ReturnType<typeof createMockPublicClient>;
  let mockWalletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    // Create fresh mocks
    mockPublicClient = createMockPublicClient();
    mockWalletClient = createMockWalletClient(mockPublicClient);

    // Create client with test config
    client = new AgoraMeshClient({
      rpcUrl: TEST_RPC_URL,
      chainId: TEST_CHAIN_ID,
      privateKey: TEST_PRIVATE_KEYS.client,
      trustRegistryAddress: TEST_CONTRACT_ADDRESSES.trustRegistry,
      escrowAddress: TEST_CONTRACT_ADDRESSES.escrow,
      usdcAddress: TEST_CONTRACT_ADDRESSES.usdc,
    });

    // Mock the internal clients
    // @ts-expect-error - accessing private property for testing
    client.publicClient = mockPublicClient;
    // @ts-expect-error - accessing private property for testing
    client.walletClient = mockWalletClient;
    // @ts-expect-error - accessing private property for testing
    client.account = { address: TEST_ADDRESSES.client };
    // @ts-expect-error - accessing private property for testing
    client.connected = true;
  });

  describe('registerAgent', () => {
    it('should register a new agent with capability card', async () => {
      const capabilityCard = createTestCapabilityCard({
        id: TEST_DIDS.client,
      });
      const capabilityCardCID = 'ipfs://QmNewAgent1234567890';

      // Register the agent
      const txHash = await client.registerAgent(capabilityCard, capabilityCardCID);

      // Verify transaction was sent
      expect(txHash).toBeDefined();
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // Verify writeContract was called correctly
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith({
        address: TEST_CONTRACT_ADDRESSES.trustRegistry,
        abi: expect.any(Array),
        functionName: 'registerAgent',
        args: [didToHash(TEST_DIDS.client), capabilityCardCID],
      });

      // Verify agent is now registered in mock
      const didHash = didToHash(TEST_DIDS.client);
      const registeredAgent = mockPublicClient.registeredAgents.get(didHash);
      expect(registeredAgent).toBeDefined();
      expect(registeredAgent?.owner).toBe(TEST_ADDRESSES.client);
      expect(registeredAgent?.capabilityCardCID).toBe(capabilityCardCID);
      expect(registeredAgent?.isActive).toBe(true);
    });

    it('should generate correct DID hash', () => {
      const did = 'did:agoramesh:base:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      const hash = didToHash(did);

      // Hash should be deterministic
      expect(hash).toBe(keccak256(toHex(did)));

      // Hash should be bytes32
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should throw when not connected', async () => {
      // Disconnect client
      client.disconnect();

      const capabilityCard = createTestCapabilityCard();

      await expect(
        client.registerAgent(capabilityCard, 'ipfs://Qm...')
      ).rejects.toThrow('Client is not connected');
    });

    it('should throw when TrustRegistry not configured', async () => {
      // Create client without TrustRegistry
      const clientWithoutRegistry = new AgoraMeshClient({
        rpcUrl: TEST_RPC_URL,
        chainId: TEST_CHAIN_ID,
        privateKey: TEST_PRIVATE_KEYS.client,
      });

      // Mock connection
      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.publicClient = mockPublicClient;
      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.walletClient = mockWalletClient;
      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.account = { address: TEST_ADDRESSES.client };
      // @ts-expect-error - accessing private property for testing
      clientWithoutRegistry.connected = true;

      const capabilityCard = createTestCapabilityCard();

      await expect(
        clientWithoutRegistry.registerAgent(capabilityCard, 'ipfs://Qm...')
      ).rejects.toThrow('TrustRegistry address not configured');
    });
  });

  describe('updateCapabilityCard', () => {
    it('should update an existing agent capability card', async () => {
      // First register an agent
      const did = TEST_DIDS.client;
      const originalCID = 'ipfs://QmOriginal1234567890';
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.client,
        capabilityCardCID: originalCID,
      });

      // Update the capability card
      const newCID = 'ipfs://QmUpdated1234567890';
      const txHash = await client.updateCapabilityCard(did, newCID);

      // Verify transaction was sent
      expect(txHash).toBeDefined();

      // Verify writeContract was called correctly
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith({
        address: TEST_CONTRACT_ADDRESSES.trustRegistry,
        abi: expect.any(Array),
        functionName: 'updateCapabilityCard',
        args: [didToHash(did), newCID],
      });

      // Verify agent CID was updated in mock
      const didHash = didToHash(did);
      const updatedAgent = mockPublicClient.registeredAgents.get(didHash);
      expect(updatedAgent?.capabilityCardCID).toBe(newCID);
    });

    it('should keep agent active after update', async () => {
      // Register an agent
      const did = TEST_DIDS.client;
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.client,
        isActive: true,
      });

      // Update capability card
      await client.updateCapabilityCard(did, 'ipfs://QmNew1234567890');

      // Agent should still be active
      const didHash = didToHash(did);
      const agent = mockPublicClient.registeredAgents.get(didHash);
      expect(agent?.isActive).toBe(true);
    });
  });

  describe('deactivateAgent', () => {
    it('should deactivate a registered agent', async () => {
      // Register an active agent
      const did = TEST_DIDS.client;
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.client,
        isActive: true,
      });

      // Deactivate the agent
      const txHash = await client.deactivateAgent(did);

      // Verify transaction was sent
      expect(txHash).toBeDefined();

      // Verify writeContract was called correctly
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith({
        address: TEST_CONTRACT_ADDRESSES.trustRegistry,
        abi: expect.any(Array),
        functionName: 'deactivateAgent',
        args: [didToHash(did)],
      });

      // Verify agent is now inactive
      const didHash = didToHash(did);
      const agent = mockPublicClient.registeredAgents.get(didHash);
      expect(agent?.isActive).toBe(false);
    });

    it('should keep agent data after deactivation', async () => {
      // Register an agent
      const did = TEST_DIDS.client;
      const cid = 'ipfs://QmTestCID1234567890';
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.client,
        capabilityCardCID: cid,
      });

      // Deactivate
      await client.deactivateAgent(did);

      // Agent data should still exist
      const didHash = didToHash(did);
      const agent = mockPublicClient.registeredAgents.get(didHash);
      expect(agent).toBeDefined();
      expect(agent?.owner).toBe(TEST_ADDRESSES.client);
      expect(agent?.capabilityCardCID).toBe(cid);
      expect(agent?.isActive).toBe(false);
    });
  });

  describe('getAgent', () => {
    it('should return agent info for registered agent', async () => {
      // Register an agent
      const did = TEST_DIDS.provider;
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.provider,
        capabilityCardCID: 'ipfs://QmProvider1234567890',
        isActive: true,
      });

      // Get the agent
      const agent = await client.getAgent(did);

      expect(agent).toBeDefined();
      expect(agent?.did).toBe(did);
      expect(agent?.didHash).toBe(didToHash(did));
      expect(agent?.address).toBe(TEST_ADDRESSES.provider);
      expect(agent?.isActive).toBe(true);
    });

    it('should return null for unregistered agent', async () => {
      const agent = await client.getAgent(TEST_DIDS.unregistered);

      expect(agent).toBeNull();
    });

    it('should return inactive agent info', async () => {
      // Register an inactive agent
      const did = TEST_DIDS.provider;
      registerTestAgent(mockPublicClient, did, {
        owner: TEST_ADDRESSES.provider,
        isActive: false,
      });

      const agent = await client.getAgent(did);

      expect(agent).toBeDefined();
      expect(agent?.isActive).toBe(false);
    });
  });

  describe('isAgentActive', () => {
    it('should return true for active agent', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        isActive: true,
      });

      const isActive = await client.isAgentActive(TEST_DIDS.provider);

      expect(isActive).toBe(true);
    });

    it('should return false for inactive agent', async () => {
      registerTestAgent(mockPublicClient, TEST_DIDS.provider, {
        isActive: false,
      });

      const isActive = await client.isAgentActive(TEST_DIDS.provider);

      expect(isActive).toBe(false);
    });

    it('should return false for unregistered agent', async () => {
      const isActive = await client.isAgentActive(TEST_DIDS.unregistered);

      expect(isActive).toBe(false);
    });
  });

  describe('Client lifecycle', () => {
    it('should track connection state', () => {
      // Fresh client should not be connected
      const freshClient = new AgoraMeshClient({
        rpcUrl: TEST_RPC_URL,
        chainId: TEST_CHAIN_ID,
      });

      expect(freshClient.isConnected()).toBe(false);

      // After mock connection
      expect(client.isConnected()).toBe(true);

      // After disconnect
      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should return correct config values', () => {
      expect(client.rpcUrl).toBe(TEST_RPC_URL);
      expect(client.chainId).toBe(TEST_CHAIN_ID);
    });

    it('should return contract addresses', () => {
      const addresses = client.getContractAddresses();

      expect(addresses.trustRegistry).toBe(TEST_CONTRACT_ADDRESSES.trustRegistry);
      expect(addresses.escrow).toBe(TEST_CONTRACT_ADDRESSES.escrow);
      expect(addresses.usdc).toBe(TEST_CONTRACT_ADDRESSES.usdc);
    });

    it('should return account address when wallet configured', () => {
      expect(client.getAddress()).toBe(TEST_ADDRESSES.client);
    });
  });
});
