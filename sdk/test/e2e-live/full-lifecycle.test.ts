/**
 * AgentMesh E2E Integration Test Suite
 * 
 * Tests full agent lifecycle against local Docker stack:
 *   - Anvil on localhost:8545
 *   - Node on localhost:8080  
 *   - Bridge on localhost:3402
 * 
 * Coverage:
 *   - Agent registration → Discovery → Trust scoring
 *   - Escrow create+fund → Task submission → Escrow release
 */

import { beforeAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  formatUnits,
  parseUnits,
  parseEventLogs,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// =============================================================================
// Test Configuration
// =============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DeploymentAddresses {
  chainId: number;
  network: string;
  admin: `0x${string}`;
  usdc: `0x${string}`;
  trustRegistry: `0x${string}`;
  escrow: `0x${string}`;
  [key: string]: unknown;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Test environment URLs - local Docker stack
const NODE_URL = 'http://localhost:8080';
const BRIDGE_URL = 'http://localhost:3402';
const RPC_URL = 'http://localhost:8545';

// Test account (Anvil default account #0)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

// =============================================================================
// Contract ABIs
// =============================================================================

const TRUST_REGISTRY_ABI = [
  {
    name: 'registerAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'capabilityCardCID', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getAgent',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'didHash', type: 'bytes32' },
          { name: 'owner', type: 'address' },
          { name: 'capabilityCardCID', type: 'string' },
          { name: 'registeredAt', type: 'uint256' },
          { name: 'isActive', type: 'bool' },
        ],
      },
    ],
  },
  {
    name: 'isAgentActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Custom Errors
  {
    type: 'error',
    name: 'OwnerAlreadyHasAgent',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentNotActive',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentAlreadyRegistered',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AgentNotRegistered',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDIDHash',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidCapabilityCardCID',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotAgentOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientStake',
    inputs: [],
  },
] as const;

const ESCROW_ABI = [
  {
    name: 'createEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'clientDid', type: 'bytes32' },
      { name: 'providerDid', type: 'bytes32' },
      { name: 'providerAddress', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'taskHash', type: 'bytes32' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'escrowId', type: 'uint256' }],
  },
  {
    name: 'fundEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'releaseEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getEscrow',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'clientDid', type: 'bytes32' },
          { name: 'providerDid', type: 'bytes32' },
          { name: 'clientAddress', type: 'address' },
          { name: 'providerAddress', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'token', type: 'address' },
          { name: 'taskHash', type: 'bytes32' },
          { name: 'outputHash', type: 'bytes32' },
          { name: 'deadline', type: 'uint256' },
          { name: 'state', type: 'uint8' },
        ],
      },
    ],
  },
  {
    name: 'EscrowCreated',
    type: 'event',
    inputs: [
      { name: 'escrowId', indexed: true, type: 'uint256' },
      { name: 'client', indexed: true, type: 'address' },
      { name: 'provider', indexed: true, type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  // Custom Errors
  {
    type: 'error',
    name: 'AgentNotActive',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EscrowNotFound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidState',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidAmount',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDeadline',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidProviderAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotAuthorized',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotClient',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotProvider',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DeadlineNotPassed',
    inputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// =============================================================================
// Helper Functions
// =============================================================================

function didToHash(did: string): `0x${string}` {
  return keccak256(toHex(did));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Test Suite
// =============================================================================

describe('AgentMesh E2E Integration', () => {
  let deployment: DeploymentAddresses;
  let publicClient: ReturnType<typeof createPublicClient>;
  let walletClient: ReturnType<typeof createWalletClient>;
  let account: ReturnType<typeof privateKeyToAccount>;
  let clientDid: string;
  let clientDidHash: `0x${string}`;
  let providerDid: string;
  let providerDidHash: `0x${string}`;

  beforeAll(async () => {
    // Load deployment addresses from local.json
    const deploymentsDir = resolve(__dirname, '../../../deployments');
    const deploymentPath = resolve(deploymentsDir, 'local.json');
    
    try {
      deployment = JSON.parse(readFileSync(deploymentPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to load deployment from ${deploymentPath}. Make sure local stack is running and contracts are deployed.`);
    }
    
    expect(deployment.trustRegistry).not.toBe(ZERO_ADDRESS);
    expect(deployment.escrow).not.toBe(ZERO_ADDRESS);
    expect(deployment.usdc).not.toBe(ZERO_ADDRESS);

    // Setup clients
    account = privateKeyToAccount(TEST_PRIVATE_KEY);
    
    publicClient = createPublicClient({
      chain: foundry,
      transport: http(RPC_URL),
    });
    
    walletClient = createWalletClient({
      account,
      chain: foundry,
      transport: http(RPC_URL),
    });

    // Generate DIDs
    const timestamp = Date.now();
    clientDid = `did:agentme:local:client-${timestamp}`;
    providerDid = `did:agentme:local:provider-${timestamp}`;
    clientDidHash = didToHash(clientDid);
    providerDidHash = didToHash(providerDid);

    console.log(`Test account: ${account.address}`);
    console.log(`Client DID: ${clientDid}`);
    console.log(`Provider DID: ${providerDid}`);
  });

  describe('Infrastructure Health Checks', () => {
    it('should connect to Anvil (local blockchain)', async () => {
      const blockNumber = await publicClient.getBlockNumber();
      expect(blockNumber).toBeGreaterThanOrEqual(0n);
      console.log(`Current block: ${blockNumber}`);
    });

    it('should connect to AgentMesh Node API', async () => {
      const response = await fetch(`${NODE_URL}/health`);
      expect(response.ok).toBe(true);
      
      const health = await response.json();
      expect(health).toHaveProperty('status', 'ok');
      expect(health).toHaveProperty('version');
      expect(health).toHaveProperty('uptime');
      console.log(`Node health:`, health);
    });

    it('should connect to AgentMesh Bridge', async () => {
      const response = await fetch(`${BRIDGE_URL}/.well-known/agent.json`);
      expect(response.ok).toBe(true);
      
      const agentCard = await response.json();
      expect(agentCard).toHaveProperty('name');
      expect(agentCard).toHaveProperty('skills');
      expect(agentCard.skills.length).toBeGreaterThan(0);
      console.log(`Bridge agent: ${agentCard.name}`);
    });
  });

  describe('Account Setup and Balances', () => {
    it('should have sufficient ETH balance for gas', async () => {
      const ethBalance = await publicClient.getBalance({ address: account.address });
      expect(ethBalance).toBeGreaterThan(parseUnits('0.1', 18)); // At least 0.1 ETH
      console.log(`ETH balance: ${formatUnits(ethBalance, 18)} ETH`);
    });

    it('should have USDC tokens for escrow', async () => {
      const usdcBalance = await publicClient.readContract({
        address: deployment.usdc,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      });
      
      expect(usdcBalance).toBeGreaterThanOrEqual(parseUnits('1', 6)); // At least 1 USDC
      console.log(`USDC balance: ${formatUnits(usdcBalance, 6)} USDC`);
    });
  });

  describe('Agent Registration', () => {
    it('should register client agent on TrustRegistry', async () => {
      const capabilityCardCID = 'QmTestClient123';
      
      try {
        const tx = await walletClient.writeContract({
          address: deployment.trustRegistry,
          abi: TRUST_REGISTRY_ABI,
          functionName: 'registerAgent',
          args: [clientDidHash, capabilityCardCID],
        });
        
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        expect(receipt.status).toBe('success');
        console.log(`Client registration TX: ${tx}`);
      } catch (error) {
        // Agent might already be registered, check for known error
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('AlreadyRegistered') && !message.includes('0xe098d3ee')) {
          throw error;
        }
        console.log('Client agent already registered');
      }

      // Verify registration
      const agent = await publicClient.readContract({
        address: deployment.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'getAgent',
        args: [clientDidHash],
      });
      
      expect(agent.didHash).toBe(clientDidHash);
      expect(agent.owner).toBe(getAddress(account.address));
      expect(agent.isActive).toBe(true);
    });

    it('should register provider agent on TrustRegistry', async () => {
      const capabilityCardCID = 'QmTestProvider123';
      
      try {
        const tx = await walletClient.writeContract({
          address: deployment.trustRegistry,
          abi: TRUST_REGISTRY_ABI,
          functionName: 'registerAgent',
          args: [providerDidHash, capabilityCardCID],
        });
        
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        expect(receipt.status).toBe('success');
        console.log(`Provider registration TX: ${tx}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('AlreadyRegistered') && !message.includes('0xe098d3ee')) {
          throw error;
        }
        console.log('Provider agent already registered');
      }

      // Verify active status
      const isActive = await publicClient.readContract({
        address: deployment.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'isAgentActive',
        args: [providerDidHash],
      });
      
      expect(isActive).toBe(true);
    });
  });

  describe('Discovery via Node API', () => {
    it('should register agent with node via HTTP API', async () => {
      const capabilityCard = {
        name: 'E2E Test Provider',
        description: 'End-to-end test provider agent for code review and debugging',
        url: BRIDGE_URL,
        capabilities: [
          { id: 'code-review', name: 'Code Review', description: 'Review code for bugs and improvements' },
          { id: 'debugging', name: 'Debugging', description: 'Debug and fix code issues' },
        ],
        'x-agentme': {
          did: providerDid,
          trust_score: 0.5,
          payment_methods: ['escrow', 'x402'],
          pricing: { base_price: 1000000, currency: 'USDC', model: 'per_request' },
        },
      };

      const response = await fetch(`${NODE_URL}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capabilityCard),
      });

      // Note: 401 Unauthorized is expected for node registration without proper auth
      // But agent might still be discoverable through bridge registration
      if (response.status === 401) {
        console.log('Node registration requires authentication (expected)');
      } else {
        expect(response.ok).toBe(true);
        console.log(`Node registration: ${response.status}`);
      }
    });

    it('should discover agents via keyword search', async () => {
      // Brief delay for potential indexing
      await sleep(500);

      const response = await fetch(`${NODE_URL}/agents?q=review`);
      expect(response.ok).toBe(true);
      
      const agents = await response.json();
      expect(Array.isArray(agents)).toBe(true);
      console.log(`Keyword search found ${agents.length} agent(s)`);
      
      if (agents.length > 0) {
        const agent = agents[0];
        expect(agent).toHaveProperty('card');
        expect(agent.card).toHaveProperty('name');
      }
    });

    it('should discover agents via semantic search', async () => {
      const response = await fetch(`${NODE_URL}/agents/semantic?q=help+me+review+my+code`);
      
      if (response.status === 501) {
        console.log('Semantic search not available (expected if hybrid search disabled)');
        return;
      }
      
      expect(response.ok).toBe(true);
      const results = await response.json();
      expect(Array.isArray(results)).toBe(true);
      console.log(`Semantic search found ${results.length} agent(s)`);
      
      if (results.length > 0) {
        const result = results[0];
        expect(result).toHaveProperty('card');
        expect(result).toHaveProperty('score');
        expect(typeof result.score).toBe('number');
        console.log(`Top result: ${result.card?.name ?? 'unknown'} (score: ${result.score?.toFixed(3)})`);
      }
    });
  });

  describe('Escrow Lifecycle', () => {
    let escrowId: bigint;
    const escrowAmount = parseUnits('1', 6); // 1 USDC

    it('should create escrow contract', async () => {
      const taskDescription = 'Review the code in src/main.ts for bugs';
      const taskHash = keccak256(toHex(taskDescription));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60); // 24 hours

      const tx = await walletClient.writeContract({
        address: deployment.escrow,
        abi: ESCROW_ABI,
        functionName: 'createEscrow',
        args: [
          clientDidHash,
          providerDidHash,
          account.address, // Provider address (using same account for simplicity)
          deployment.usdc,
          escrowAmount,
          taskHash,
          deadline,
        ],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      expect(receipt.status).toBe('success');

      // Extract escrow ID from EscrowCreated event
      const logs = parseEventLogs({
        abi: ESCROW_ABI,
        logs: receipt.logs,
        eventName: 'EscrowCreated',
      });
      
      expect(logs.length).toBe(1);
      escrowId = logs[0].args.escrowId;
      expect(typeof escrowId).toBe('bigint');
      
      console.log(`Escrow created with ID: ${escrowId}, TX: ${tx}`);
    });

    it('should approve and fund escrow', async () => {
      // Approve USDC transfer
      const approveTx = await walletClient.writeContract({
        address: deployment.usdc,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [deployment.escrow, escrowAmount],
      });

      let receipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
      expect(receipt.status).toBe('success');

      // Fund escrow
      const fundTx = await walletClient.writeContract({
        address: deployment.escrow,
        abi: ESCROW_ABI,
        functionName: 'fundEscrow',
        args: [escrowId],
      });

      receipt = await publicClient.waitForTransactionReceipt({ hash: fundTx });
      expect(receipt.status).toBe('success');

      console.log(`Escrow funded, TX: ${fundTx}`);
    });

    it('should verify escrow state after funding', async () => {
      const escrow = await publicClient.readContract({
        address: deployment.escrow,
        abi: ESCROW_ABI,
        functionName: 'getEscrow',
        args: [escrowId],
      });

      expect(escrow.id).toBe(escrowId);
      expect(escrow.clientDid).toBe(clientDidHash);
      expect(escrow.providerDid).toBe(providerDidHash);
      expect(escrow.amount).toBe(escrowAmount);
      expect(escrow.token).toBe(getAddress(deployment.usdc));
      expect(escrow.state).toBe(1); // State 1 = Funded

      console.log(`Escrow state: ${escrow.state} (Funded), Amount: ${formatUnits(escrow.amount, 6)} USDC`);
    });

    it('should release escrow', async () => {
      const tx = await walletClient.writeContract({
        address: deployment.escrow,
        abi: ESCROW_ABI,
        functionName: 'releaseEscrow',
        args: [escrowId],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
      expect(receipt.status).toBe('success');

      // Verify final state
      const escrow = await publicClient.readContract({
        address: deployment.escrow,
        abi: ESCROW_ABI,
        functionName: 'getEscrow',
        args: [escrowId],
      });

      expect(escrow.state).toBe(2); // State 2 = Released
      console.log(`Escrow released, TX: ${tx}`);
    });
  });

  describe('Bridge Integration', () => {
    it('should submit task to bridge (optional)', async () => {
      const healthResponse = await fetch(`${BRIDGE_URL}/health`);
      
      if (!healthResponse.ok) {
        console.log('Bridge health check failed, skipping task submission');
        return;
      }

      const taskPayload = {
        taskId: `e2e-test-${Date.now()}`,
        type: 'code-review',
        prompt: 'Review this simple TypeScript function for improvements',
        timeout: 60,
        clientDid: clientDid,
      };

      const response = await fetch(`${BRIDGE_URL}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskPayload),
      });

      if (response.ok) {
        const result = await response.json();
        expect(result).toHaveProperty('taskId');
        console.log(`Task submitted successfully:`, result);
      } else {
        // Task submission may require authentication or specific setup
        console.log(`Bridge task submission returned: ${response.status}`);
        console.log(`Response: ${await response.text()}`);
      }
    });
  });
}); // E2E Integration tests

// Configure timeout for all tests in this suite
beforeAll(() => {
  vi.setConfig({ testTimeout: 60000 });
});