import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const TRUST_REGISTRY = '0x9f84Bda10F11ff6F423154f591F387dAa866c8D6';
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY environment variable required');
  process.exit(1);
}

const abi = [
  {
    name: 'registerAgent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'didHash', type: 'bytes32' },
      { name: 'capabilityCardCID', type: 'string' }
    ],
    outputs: []
  },
  {
    name: 'getAgentByOwner',
    type: 'function', 
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'didHash', type: 'bytes32' },
          { name: 'owner', type: 'address' },
          { name: 'capabilityCardCID', type: 'string' },
          { name: 'stakedAmount', type: 'uint256' },
          { name: 'registeredAt', type: 'uint256' },
          { name: 'isActive', type: 'bool' },
          { name: 'totalTasksCompleted', type: 'uint256' },
          { name: 'totalTasksFailed', type: 'uint256' },
          { name: 'totalEarnings', type: 'uint256' }
        ]
      }
    ]
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

  // Create DID and hash it
  const did = 'did:agoramesh:base-sepolia:test-agent-001';
  const didHash = keccak256(toHex(did));
  const capabilityCardCID = 'ipfs://QmTestAgentCard123'; // Would be actual IPFS CID

  console.log('📝 Registering agent on TrustRegistry...');
  console.log('   DID:', did);
  console.log('   DID Hash:', didHash);
  console.log('   Card CID:', capabilityCardCID);
  
  const hash = await walletClient.writeContract({
    address: TRUST_REGISTRY,
    abi,
    functionName: 'registerAgent',
    args: [didHash, capabilityCardCID],
  });
  
  console.log('⏳ Transaction sent:', hash);
  console.log('   View: https://sepolia.basescan.org/tx/' + hash);
  
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('✅ Agent registered! Block:', receipt.blockNumber);
  
  // Verify registration
  const agent = await publicClient.readContract({
    address: TRUST_REGISTRY,
    abi,
    functionName: 'getAgentByOwner',
    args: [account.address],
  });
  
  console.log('\n📊 On-chain Agent Data:');
  console.log('   DID Hash:', agent.didHash);
  console.log('   Owner:', agent.owner);
  console.log('   Card CID:', agent.capabilityCardCID);
  console.log('   Active:', agent.isActive);
  console.log('   Staked:', agent.stakedAmount.toString(), 'wei');
}

main().catch(e => {
  console.error('Error:', e.shortMessage || e.message);
  process.exit(1);
});
