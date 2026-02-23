#!/usr/bin/env tsx
/**
 * AgoraMesh E2E Demo Script
 *
 * Exercises the full agent lifecycle against a live network:
 *   1. Load deployment addresses
 *   2. Connect SDK to chain with test wallet
 *   3. Check USDC balance
 *   4. Register an agent on TrustRegistry
 *   5. Discover agent via node HTTP API
 *   6. Create + fund escrow
 *   7. Submit task to bridge HTTP API
 *   8. Poll for task result
 *   9. Release escrow
 *  10. Verify trust score
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/e2e-demo.ts [--network sepolia|local]
 *
 * Prerequisites:
 *   - Deployed contracts (run `make deploy-sepolia` first)
 *   - ETH on Base Sepolia (faucet: https://portal.cdp.coinbase.com/products/faucet)
 *   - Test USDC on Base Sepolia
 */

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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';

// =============================================================================
// Config
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

// Parse CLI args
const args = process.argv.slice(2);
const networkIdx = args.indexOf('--network');
const network = networkIdx !== -1 ? (args[networkIdx + 1] ?? 'sepolia') : 'sepolia';

// Load deployment
const deploymentsDir = resolve(__dirname, '../../deployments');
const deploymentPath = resolve(deploymentsDir, `${network}.json`);
const deployment: DeploymentAddresses = JSON.parse(readFileSync(deploymentPath, 'utf-8'));

// Validate
if (deployment.trustRegistry === ZERO_ADDRESS) {
  console.error(`Contracts not deployed on ${network}. Run: make deploy-sepolia`);
  process.exit(1);
}

const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) {
  console.error('PRIVATE_KEY environment variable required.');
  console.error('Usage: PRIVATE_KEY=0x... npx tsx scripts/e2e-demo.ts');
  process.exit(1);
}

const NODE_URL = process.env.NODE_URL ?? 'http://localhost:8080';
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3402';
const RPC_URL = network === 'local' ? 'http://localhost:8545' : 'https://sepolia.base.org';
const chain = network === 'local' ? foundry : baseSepolia;

// =============================================================================
// ABIs
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
  {
    name: 'getTrustScore',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [{ name: 'compositeScore', type: 'uint256' }],
  },
  {
    name: 'getTrustDetails',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }],
    outputs: [
      { name: 'reputationScore', type: 'uint256' },
      { name: 'stakeScore', type: 'uint256' },
      { name: 'endorsementScore', type: 'uint256' },
      { name: 'compositeScore', type: 'uint256' },
    ],
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
    name: 'confirmDelivery',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'outputHash', type: 'bytes32' },
    ],
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
          { name: 'createdAt', type: 'uint256' },
          { name: 'deliveredAt', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'EscrowCreated',
    type: 'event',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
      { name: 'clientDid', type: 'bytes32', indexed: true },
      { name: 'providerDid', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
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
// Helpers
// =============================================================================

function log(step: number, message: string) {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`  Step ${step}: ${message}`);
  console.log(`[${'='.repeat(60)}]`);
}

function didToHash(did: string): `0x${string}` {
  return keccak256(toHex(did));
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const ESCROW_STATE_NAMES: Record<number, string> = {
  0: 'AWAITING_DEPOSIT',
  1: 'FUNDED',
  2: 'DELIVERED',
  3: 'DISPUTED',
  4: 'RELEASED',
  5: 'REFUNDED',
};

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('='.repeat(62));
  console.log('  AgoraMesh E2E Demo');
  console.log(`  Network: ${deployment.network} (chain ${deployment.chainId})`);
  console.log('='.repeat(62));

  // -- Setup clients --
  const account = privateKeyToAccount(privateKey);
  console.log(`\nWallet (client): ${account.address}`);

  // Use a second account for the provider
  // Local: Anvil account #1, Testnet: PROVIDER_PRIVATE_KEY env var (optional)
  let providerPrivateKey: `0x${string}` | undefined;
  if (network === 'local') {
    // Safety: only use hardcoded Anvil key when RPC points to local development chain
    if (!RPC_URL.includes('localhost') && !RPC_URL.includes('127.0.0.1') && !RPC_URL.includes('anvil')) {
      console.error('Refusing to use hardcoded Anvil key with non-local RPC URL:', RPC_URL);
      process.exit(1);
    }
    providerPrivateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as `0x${string}`;
  } else {
    providerPrivateKey = process.env.PROVIDER_PRIVATE_KEY as `0x${string}` | undefined;
  }
  const providerAccount = providerPrivateKey ? privateKeyToAccount(providerPrivateKey) : null;
  const hasSeparateProvider = providerAccount !== null && providerAccount.address !== account.address;
  if (hasSeparateProvider) {
    console.log(`Wallet (provider): ${providerAccount.address}`);
  } else if (!providerPrivateKey) {
    console.log('(No separate provider wallet — skipping provider-specific steps)');
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  });

  const providerWalletClient = hasSeparateProvider
    ? createWalletClient({ account: providerAccount, chain, transport: http(RPC_URL) })
    : walletClient;

  // Agent identities — check if wallets already have registered agents
  let clientDid = `did:agoramesh:base:client${Date.now().toString(36)}`;
  let clientDidHash = didToHash(clientDid);
  // Use bridge's provider DID if available (matches PROVIDER_DID env in bridge)
  const bridgeProviderDid = process.env.PROVIDER_DID ?? `did:agoramesh:local:agent-001`;
  let providerDid = bridgeProviderDid;
  let providerDidHash = didToHash(providerDid);

  // Check if client wallet already has a registered agent (reuse it)
  const existingClientDid = await publicClient.readContract({
    address: deployment.trustRegistry,
    abi: [{ name: 'getAgentByOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: 'didHash', type: 'bytes32' }] }],
    functionName: 'getAgentByOwner',
    args: [account.address],
  });
  if (existingClientDid && existingClientDid !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
    clientDidHash = existingClientDid;
    clientDid = `(existing: ${existingClientDid.slice(0, 10)}...)`;
  }

  // Check if provider wallet already has a registered agent
  if (hasSeparateProvider) {
    const existingProviderDid = await publicClient.readContract({
      address: deployment.trustRegistry,
      abi: [{ name: 'getAgentByOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: 'didHash', type: 'bytes32' }] }],
      functionName: 'getAgentByOwner',
      args: [providerAccount.address],
    });
    if (existingProviderDid && existingProviderDid !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      providerDidHash = existingProviderDid;
      providerDid = `(existing: ${existingProviderDid.slice(0, 10)}...)`;
    }
  }

  console.log(`Client DID: ${clientDid}`);
  console.log(`Provider DID: ${providerDid}`);

  // =========================================================================
  // Step 1: Check balances
  // =========================================================================
  log(1, 'Checking balances');

  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log(`  ETH balance: ${formatUnits(ethBalance, 18)} ETH`);

  if (ethBalance === 0n) {
    console.error('  No ETH! Get testnet ETH from faucet.');
    process.exit(1);
  }

  let usdcBalance = await publicClient.readContract({
    address: deployment.usdc,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log(`  USDC balance: ${formatUnits(usdcBalance, 6)} USDC`);

  // =========================================================================
  // Step 2: Register client agent on TrustRegistry
  // =========================================================================
  log(2, 'Registering client agent on TrustRegistry');

  try {
    const registerClientTx = await walletClient.writeContract({
      address: deployment.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'registerAgent',
      args: [clientDidHash, 'ipfs://QmE2EClientCapabilityCard'],
    });
    console.log(`  TX: ${registerClientTx}`);

    const clientReceipt = await publicClient.waitForTransactionReceipt({
      hash: registerClientTx,
    });
    console.log(`  Status: ${clientReceipt.status}`);
    console.log(`  Gas used: ${clientReceipt.gasUsed}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('0x621197a9') || msg.includes('OwnerAlreadyHasAgent')
      || msg.includes('0xe098d3ee') || msg.includes('AgentAlreadyRegistered')) {
      console.log('  Already registered - continuing');
    } else {
      throw err;
    }
  }

  // Verify registration
  const isClientActive = await publicClient.readContract({
    address: deployment.trustRegistry,
    abi: TRUST_REGISTRY_ABI,
    functionName: 'isAgentActive',
    args: [clientDidHash],
  });
  console.log(`  Client active: ${isClientActive}`);

  // =========================================================================
  // Step 3: Register provider agent on TrustRegistry
  // =========================================================================
  log(3, 'Registering provider agent on TrustRegistry');

  if (hasSeparateProvider) {
    try {
      const registerProviderTx = await providerWalletClient.writeContract({
        address: deployment.trustRegistry,
        abi: TRUST_REGISTRY_ABI,
        functionName: 'registerAgent',
        args: [providerDidHash, 'ipfs://QmE2EProviderCapabilityCard'],
      });
      console.log(`  TX: ${registerProviderTx}`);

      const providerReceipt = await publicClient.waitForTransactionReceipt({
        hash: registerProviderTx,
      });
      console.log(`  Status: ${providerReceipt.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('0x621197a9') || msg.includes('OwnerAlreadyHasAgent')
        || msg.includes('0xe098d3ee') || msg.includes('AgentAlreadyRegistered')) {
        console.log('  Already registered - continuing');
      } else {
        throw err;
      }
    }

    const isActive = await publicClient.readContract({
      address: deployment.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'isAgentActive',
      args: [providerDidHash],
    });
    console.log(`  Provider active: ${isActive}`);
  } else {
    // Single wallet mode: use client agent as provider too
    console.log('  Skipped (single wallet mode - client agent acts as provider)');
  }

  // =========================================================================
  // Step 4: Discovery via node HTTP API (optional - skipped if node not running)
  // =========================================================================
  log(4, 'Discovery via node HTTP API');

  try {
    const healthRes = await fetch(`${NODE_URL}/health`);
    if (healthRes.ok) {
      const health = await healthRes.json();
      console.log(`  Node healthy: ${JSON.stringify(health)}`);

      // Try registering agent with node (A2A CapabilityCard format)
      const capabilityCard = {
        name: 'E2E Test Provider',
        description: 'End-to-end test provider agent for code review and debugging',
        url: BRIDGE_URL,
        capabilities: [
          { id: 'code-review', name: 'Code Review', description: 'Review code for bugs and improvements' },
          { id: 'debugging', name: 'Debugging', description: 'Debug and fix code issues' },
        ],
        'x-agoramesh': {
          did: providerDid,
          trust_score: 0.5,
          payment_methods: ['escrow', 'x402'],
          pricing: { base_price: 1000000, currency: 'USDC', model: 'per_request' },
        },
      };
      const registerRes = await fetch(`${NODE_URL}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capabilityCard),
      });
      console.log(`  Register with node: ${registerRes.status}`);
      if (!registerRes.ok) {
        const errBody = await registerRes.text();
        console.log(`  Register error: ${errBody}`);
      }

      // Brief delay for indexing
      await sleep(500);

      // Keyword search
      const searchRes = await fetch(`${NODE_URL}/agents?q=review`);
      if (searchRes.ok) {
        const agents = await searchRes.json();
        console.log(`  Keyword search: found ${Array.isArray(agents) ? agents.length : 0} agent(s)`);
      }

      // Semantic search
      const semanticRes = await fetch(`${NODE_URL}/agents/semantic?q=help+me+review+my+code`);
      if (semanticRes.ok) {
        const results = await semanticRes.json();
        console.log(`  Semantic search: found ${Array.isArray(results) ? results.length : 0} agent(s)`);
        if (Array.isArray(results) && results.length > 0) {
          const top = results[0];
          console.log(`    Top result: ${top.card?.name ?? 'unknown'} (score: ${top.score?.toFixed(3) ?? 'N/A'})`);
        }
      }
    } else {
      console.log('  Node not reachable, skipping discovery step');
    }
  } catch {
    console.log('  Node not running at', NODE_URL, '- skipping discovery');
  }

  // =========================================================================
  // Step 5: Create escrow (skip if no USDC)
  // =========================================================================
  const escrowAmount = parseUnits('1', 6); // 1 USDC

  // Auto-mint USDC on local network if balance is zero
  if (usdcBalance < escrowAmount && deployment.chainId === 31337) {
    log(5, 'Minting test USDC (local network)');
    try {
      const mintTx = await walletClient.writeContract({
        address: deployment.usdc,
        abi: [{ name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }],
        functionName: 'mint',
        args: [account.address, parseUnits('10', 6)],
      });
      await publicClient.waitForTransactionReceipt({ hash: mintTx });
      usdcBalance = await publicClient.readContract({
        address: deployment.usdc,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      }) as bigint;
      console.log(`  Minted 10 USDC, balance: ${formatUnits(usdcBalance, 6)} USDC`);
    } catch (err) {
      console.log(`  Mint failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (usdcBalance >= escrowAmount) {
    log(5, 'Creating escrow (1 USDC)');

    const taskDescription = 'Review the code in src/main.ts for bugs';
    const taskHash = keccak256(toHex(taskDescription));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60); // 24 hours

    const createTx = await walletClient.writeContract({
      address: deployment.escrow,
      abi: ESCROW_ABI,
      functionName: 'createEscrow',
      args: [
        clientDidHash,
        hasSeparateProvider ? providerDidHash : clientDidHash,
        hasSeparateProvider ? providerAccount.address : account.address,
        deployment.usdc,
        escrowAmount,
        taskHash,
        deadline,
      ],
    });
    console.log(`  Create TX: ${createTx}`);

    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });

    // Get escrow ID from EscrowCreated event
    const escrowLogs = parseEventLogs({
      abi: ESCROW_ABI,
      logs: createReceipt.logs,
      eventName: 'EscrowCreated',
    });
    const escrowId = escrowLogs[0].args.escrowId;
    console.log(`  Escrow ID: ${escrowId}`);

    // =========================================================================
    // Step 6: Fund escrow
    // =========================================================================
    log(6, 'Funding escrow');

    // Approve USDC
    const approveTx = await walletClient.writeContract({
      address: deployment.usdc,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [deployment.escrow, escrowAmount],
    });
    console.log(`  Approve TX: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    // Fund
    const fundTx = await walletClient.writeContract({
      address: deployment.escrow,
      abi: ESCROW_ABI,
      functionName: 'fundEscrow',
      args: [escrowId],
    });
    console.log(`  Fund TX: ${fundTx}`);
    await publicClient.waitForTransactionReceipt({ hash: fundTx });

    // Verify state
    const escrow = await publicClient.readContract({
      address: deployment.escrow,
      abi: ESCROW_ABI,
      functionName: 'getEscrow',
      args: [escrowId],
    });
    console.log(`  Escrow state: ${ESCROW_STATE_NAMES[escrow.state] ?? escrow.state}`);
    console.log(`  Amount: ${formatUnits(escrow.amount, 6)} USDC`);

    // =========================================================================
    // Step 7: Submit task to bridge (optional)
    // =========================================================================
    log(7, 'Submitting task to bridge');

    try {
      const bridgeHealth = await fetch(`${BRIDGE_URL}/health`);
      if (bridgeHealth.ok) {
        const taskPayload = {
          taskId: `e2e-${Date.now()}`,
          type: 'code-review',
          prompt: taskDescription,
          timeout: 60,
          clientDid: clientDid,
          escrowId: escrowId.toString(),
        };

        const bridgeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.BRIDGE_API_TOKEN) {
          bridgeHeaders['Authorization'] = `Bearer ${process.env.BRIDGE_API_TOKEN}`;
        }

        const taskRes = await fetch(`${BRIDGE_URL}/task`, {
          method: 'POST',
          headers: bridgeHeaders,
          body: JSON.stringify(taskPayload),
        });

        if (taskRes.ok) {
          const taskAck = await taskRes.json();
          console.log(`  Task accepted: ${JSON.stringify(taskAck)}`);

          // Step 8: Poll for result
          log(8, 'Polling for task result');
          const taskId = taskPayload.taskId;
          let attempts = 0;
          const maxAttempts = 12;

          while (attempts < maxAttempts) {
            await sleep(5000);
            const statusRes = await fetch(`${BRIDGE_URL}/task/${taskId}`);

            if (statusRes.status === 404) {
              console.log('  Task completed (no longer pending)');
              break;
            }

            if (statusRes.ok) {
              const status = await statusRes.json();
              console.log(`  Attempt ${attempts + 1}: ${JSON.stringify(status.status)}`);
            }

            attempts++;
          }
        } else {
          console.log(`  Bridge returned ${taskRes.status}: ${await taskRes.text()}`);
        }
      } else {
        console.log('  Bridge not reachable, skipping task submission');
      }
    } catch {
      console.log('  Bridge not running at', BRIDGE_URL, '- skipping task steps');
    }

    // =========================================================================
    // Step 9: Confirm delivery (provider confirms task completion)
    // =========================================================================
    log(9, 'Confirming delivery');

    const preConfirmEscrow = await publicClient.readContract({
      address: deployment.escrow,
      abi: ESCROW_ABI,
      functionName: 'getEscrow',
      args: [escrowId],
    });

    if (preConfirmEscrow.state === 1 /* FUNDED */) {
      try {
        const providerClient = hasSeparateProvider ? providerWalletClient : walletClient;
        const outputHash = keccak256(toHex('demo-task-output-result'));
        const confirmTx = await providerClient.writeContract({
          address: deployment.escrow,
          abi: ESCROW_ABI,
          functionName: 'confirmDelivery',
          args: [escrowId, outputHash],
        });
        console.log(`  Confirm TX: ${confirmTx}`);
        await publicClient.waitForTransactionReceipt({ hash: confirmTx });
        console.log(`  Delivery confirmed by provider ✓`);
      } catch (err) {
        console.log(`  Confirm failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (preConfirmEscrow.state >= 2) {
      console.log(`  Already past FUNDED state (${ESCROW_STATE_NAMES[preConfirmEscrow.state] ?? preConfirmEscrow.state})`);
    }

    // =========================================================================
    // Step 10: Release escrow (client releases funds to provider)
    // =========================================================================
    log(10, 'Releasing escrow');

    const preReleaseEscrow = await publicClient.readContract({
      address: deployment.escrow,
      abi: ESCROW_ABI,
      functionName: 'getEscrow',
      args: [escrowId],
    });
    const preState = ESCROW_STATE_NAMES[preReleaseEscrow.state] ?? preReleaseEscrow.state;

    if (preReleaseEscrow.state === 4 /* RELEASED */) {
      console.log(`  Escrow already released ✓`);
    } else if (preReleaseEscrow.state === 2 /* DELIVERED */) {
      try {
        const releaseTx = await walletClient.writeContract({
          address: deployment.escrow,
          abi: ESCROW_ABI,
          functionName: 'releaseEscrow',
          args: [escrowId],
        });
        console.log(`  Release TX: ${releaseTx}`);
        await publicClient.waitForTransactionReceipt({ hash: releaseTx });

        const finalEscrow = await publicClient.readContract({
          address: deployment.escrow,
          abi: ESCROW_ABI,
          functionName: 'getEscrow',
          args: [escrowId],
        });
        console.log(`  Final state: ${ESCROW_STATE_NAMES[finalEscrow.state] ?? finalEscrow.state}`);
      } catch (err) {
        console.log(`  Release failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log(`  Escrow in state ${preState} — cannot release yet (needs DELIVERED state)`);
    }
  } else {
    log(5, 'Skipping escrow steps (insufficient USDC balance)');
    console.log(`  Need at least 1 USDC. Current: ${formatUnits(usdcBalance, 6)} USDC`);
    console.log('  Get test USDC from Base Sepolia faucet');
  }

  // =========================================================================
  // Step 11: Verify trust score
  // =========================================================================
  log(11, 'Verifying trust scores on-chain');

  const [repScore, stakeScore, endorseScore, compositeScore] =
    await publicClient.readContract({
      address: deployment.trustRegistry,
      abi: TRUST_REGISTRY_ABI,
      functionName: 'getTrustDetails',
      args: [clientDidHash],
    });

  console.log(`  Client trust score:`);
  console.log(`    Reputation: ${Number(repScore) / 100}%`);
  console.log(`    Stake:      ${Number(stakeScore) / 100}%`);
  console.log(`    Endorsement:${Number(endorseScore) / 100}%`);
  console.log(`    Composite:  ${Number(compositeScore) / 100}%`);

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n' + '='.repeat(62));
  console.log('  E2E Demo Complete!');
  console.log('='.repeat(62));
  console.log(`  Network:        ${deployment.network}`);
  console.log(`  TrustRegistry:  ${deployment.trustRegistry}`);
  console.log(`  Escrow:         ${deployment.escrow}`);
  console.log(`  Client DID:     ${clientDid}`);
  console.log(`  Provider DID:   ${providerDid}`);
  console.log('='.repeat(62));
}

main().catch((err) => {
  console.error('\nE2E Demo failed:', err);
  process.exit(1);
});
