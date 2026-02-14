import { createPublicClient, createWalletClient, http, parseUnits, keccak256, toHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const ESCROW = '0xBb2f0Eb0f064b62E2116fd79C12dA1dcEb58B695';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY environment variable required');
  process.exit(1);
}

const escrowAbi = [
  {
    name: 'createEscrow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'providerDidHash', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'taskHash', type: 'bytes32' }
    ],
    outputs: [{ name: 'escrowId', type: 'uint256' }]
  },
  {
    name: 'getEscrowCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const usdcAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });
  
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  console.log('💰 ESCROW PAYMENT FLOW DEMO\n');
  console.log('='.repeat(50));
  
  // Check USDC balance
  const balance = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  
  console.log('1️⃣  Check USDC Balance');
  console.log('   Address:', account.address);
  console.log('   USDC Balance:', (Number(balance) / 1e6).toFixed(2), 'USDC');
  
  if (balance === 0n) {
    console.log('\n⚠️  No testnet USDC! To get testnet USDC:');
    console.log('   1. Go to https://faucet.circle.com/');
    console.log('   2. Select "Base Sepolia"');
    console.log('   3. Enter address:', account.address);
    console.log('\n   Or mint from contract (if available)');
    return;
  }

  // Escrow flow would continue here...
  console.log('\n2️⃣  Would create escrow with:');
  console.log('   Amount: 0.01 USDC');
  console.log('   Provider DID: did:agentme:base-sepolia:test-agent-001');
  
  const escrowCount = await publicClient.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'getEscrowCount',
    args: [],
  });
  console.log('\n📊 Current escrow count:', escrowCount.toString());
}

main().catch(console.error);
