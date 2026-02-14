import { createPublicClient, createWalletClient, http, parseUnits, keccak256, toHex, formatUnits, parseEventLogs } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Contract addresses
const ESCROW = '0xBb2f0Eb0f064b62E2116fd79C12dA1dcEb58B695';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TRUST_REGISTRY = '0x9f84Bda10F11ff6F423154f591F387dAa866c8D6';
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY environment variable required');
  process.exit(1);
}
const CLIENT_PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}`;
if (!CLIENT_PRIVATE_KEY) {
  console.error('CLIENT_PRIVATE_KEY environment variable required');
  process.exit(1);
}

const trustAbi = [
  { name: 'registerAgent', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'didHash', type: 'bytes32' }, { name: 'capabilityCardCID', type: 'string' }], outputs: [] },
  { name: 'isAgentActive', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'didHash', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const usdcAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const escrowAbi = [
  { name: 'createEscrow', type: 'function', stateMutability: 'nonpayable', 
    inputs: [
      { name: 'clientDid', type: 'bytes32' },
      { name: 'providerDid', type: 'bytes32' },
      { name: 'providerAddress', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'taskHash', type: 'bytes32' },
      { name: 'deadline', type: 'uint256' }
    ], 
    outputs: [{ name: 'escrowId', type: 'uint256' }] },
  { name: 'fundEscrow', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }], outputs: [] },
  { name: 'confirmDelivery', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }, { name: 'outputHash', type: 'bytes32' }], outputs: [] },
  { name: 'releaseEscrow', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'escrowId', type: 'uint256' }], outputs: [] },
  { name: 'getEscrow', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'escrowId', type: 'uint256' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'id', type: 'uint256' },
      { name: 'clientDid', type: 'bytes32' },
      { name: 'providerDid', type: 'bytes32' },
      { name: 'clientAddress', type: 'address' },
      { name: 'providerAddress', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'taskHash', type: 'bytes32' },
      { name: 'status', type: 'uint8' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'completedAt', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]}]
  },
  // Event for getting escrowId
  { name: 'EscrowCreated', type: 'event',
    inputs: [
      { name: 'escrowId', type: 'uint256', indexed: true },
      { name: 'clientDid', type: 'bytes32', indexed: true },
      { name: 'providerDid', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false }
    ]
  }
] as const;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const providerAccount = privateKeyToAccount(PRIVATE_KEY);
  const clientAccount = privateKeyToAccount(CLIENT_PRIVATE_KEY);
  
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });
  
  const providerWallet = createWalletClient({
    account: providerAccount,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  const clientWallet = createWalletClient({
    account: clientAccount,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  const providerDid = 'did:agentme:base-sepolia:test-agent-001';
  const clientDid = 'did:agentme:base-sepolia:test-client-001';
  const providerDidHash = keccak256(toHex(providerDid));
  const clientDidHash = keccak256(toHex(clientDid));
  
  const taskDescription = 'Review my TypeScript code for security issues';
  const taskHash = keccak256(toHex(taskDescription));
  const outputHash = keccak256(toHex('Code review complete: No critical issues found'));
  const paymentAmount = parseUnits('1', 6);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           AGENTME ESCROW PAYMENT FLOW                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('👤 Provider:', providerAccount.address);
  console.log('👤 Client:', clientAccount.address);

  // Setup
  console.log('\n━━━ STEP 0: Setup ━━━');
  const clientActive = await publicClient.readContract({
    address: TRUST_REGISTRY, abi: trustAbi, functionName: 'isAgentActive', args: [clientDidHash]
  });
  
  if (!clientActive) {
    const ethBalance = await publicClient.getBalance({ address: clientAccount.address });
    if (ethBalance === 0n) {
      console.log('   Funding client with ETH...');
      const h = await providerWallet.sendTransaction({ to: clientAccount.address, value: parseUnits('0.0001', 18) });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    console.log('   Registering client...');
    const h = await clientWallet.writeContract({
      address: TRUST_REGISTRY, abi: trustAbi, functionName: 'registerAgent',
      args: [clientDidHash, 'ipfs://QmClient']
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log('   ✅ Client registered');
  } else {
    console.log('   ✅ Client already registered');
  }

  const clientUsdc = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [clientAccount.address]
  });
  if (clientUsdc < paymentAmount) {
    console.log('   Sending USDC to client...');
    const h = await providerWallet.writeContract({
      address: USDC, abi: usdcAbi, functionName: 'transfer',
      args: [clientAccount.address, parseUnits('2', 6)]
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log('   ✅ 2 USDC sent');
  }

  // Balances
  console.log('\n━━━ STEP 1: Initial Balances ━━━');
  const providerBefore = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [providerAccount.address]
  });
  const clientBefore = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [clientAccount.address]
  });
  console.log('   Provider:', formatUnits(providerBefore, 6), 'USDC');
  console.log('   Client:', formatUnits(clientBefore, 6), 'USDC');

  // Create escrow
  console.log('\n━━━ STEP 2: Create Escrow ━━━');
  const createHash = await clientWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: 'createEscrow',
    args: [clientDidHash, providerDidHash, providerAccount.address, USDC, paymentAmount, taskHash, deadline]
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  
  // Get escrowId from event using type-safe parseEventLogs
  const escrowLogs = parseEventLogs({
    abi: escrowAbi,
    logs: createReceipt.logs,
    eventName: 'EscrowCreated',
  });

  let escrowId = 1n;
  if (escrowLogs.length > 0) {
    escrowId = escrowLogs[0].args.escrowId;
  }
  console.log('   ✅ Escrow #' + escrowId + ' created');

  // Approve and fund
  console.log('\n━━━ STEP 3: Fund Escrow ━━━');
  console.log('   Approving USDC...');
  const approveHash = await clientWallet.writeContract({
    address: USDC, abi: usdcAbi, functionName: 'approve',
    args: [ESCROW, paymentAmount]
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  
  console.log('   Funding escrow...');
  const fundHash = await clientWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: 'fundEscrow',
    args: [escrowId]
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log('   ✅ 1 USDC locked in escrow');

  // Provider works
  console.log('\n━━━ STEP 4: Provider Works ━━━');
  console.log('   ⏳ Performing code review...');
  await sleep(2000);
  console.log('   ✅ Work complete!');

  // Confirm delivery
  console.log('\n━━━ STEP 5: Confirm Delivery ━━━');
  const confirmHash = await providerWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: 'confirmDelivery',
    args: [escrowId, outputHash]
  });
  await publicClient.waitForTransactionReceipt({ hash: confirmHash });
  console.log('   ✅ Delivery confirmed');

  // Release payment
  console.log('\n━━━ STEP 6: Release Payment ━━━');
  const releaseHash = await clientWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: 'releaseEscrow',
    args: [escrowId]
  });
  await publicClient.waitForTransactionReceipt({ hash: releaseHash });
  console.log('   ✅ Payment released!');

  // Final
  console.log('\n━━━ FINAL BALANCES ━━━');
  const providerAfter = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [providerAccount.address]
  });
  const clientAfter = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [clientAccount.address]
  });
  console.log('   Provider:', formatUnits(providerBefore, 6), '→', formatUnits(providerAfter, 6), 'USDC');
  console.log('   Client:', formatUnits(clientBefore, 6), '→', formatUnits(clientAfter, 6), 'USDC');
  console.log('   Provider earned: +' + formatUnits(providerAfter - providerBefore, 6), 'USDC 🎉');

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  PAYMENT COMPLETE ✅                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\nBasescan: https://sepolia.basescan.org/tx/' + releaseHash);
}

main().catch(e => {
  console.error('\n❌ Error:', e.shortMessage || e.message);
});
