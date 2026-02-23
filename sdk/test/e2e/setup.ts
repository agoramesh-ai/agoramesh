/**
 * E2E Test Setup
 *
 * Test utilities for end-to-end integration tests.
 * Uses viem test utilities to mock blockchain interactions.
 *
 * @packageDocumentation
 */

import { vi, type MockInstance } from 'vitest';
import { keccak256, toHex, parseUnits, formatUnits, encodeAbiParameters, pad, numberToHex } from 'viem';
import type {
  CapabilityCard,
  TrustScore,
  TrustDetails,
  Escrow,
  EscrowState,
  AgentInfo,
  DiscoveryResult,
  Skill,
} from '../../src/types.js';
import { USDC_DECIMALS, BASIS_POINTS } from '../../src/types.js';

// =============================================================================
// Test Constants
// =============================================================================

/** Test chain ID (Base Sepolia) */
export const TEST_CHAIN_ID = 84532;

/** Test RPC URL */
export const TEST_RPC_URL = 'https://sepolia.base.org';

/** Test private keys for different test accounts */
export const TEST_PRIVATE_KEYS = {
  client: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const,
  provider: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
  endorser: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const,
};

/** Test addresses derived from private keys */
export const TEST_ADDRESSES = {
  client: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const,
  provider: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const,
  endorser: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const,
};

/** Mock contract addresses */
export const TEST_CONTRACT_ADDRESSES = {
  trustRegistry: '0x1111111111111111111111111111111111111111' as const,
  escrow: '0x2222222222222222222222222222222222222222' as const,
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
};

/** Test DIDs */
export const TEST_DIDS = {
  client: 'did:agoramesh:base:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  provider: 'did:agoramesh:base:0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  endorser: 'did:agoramesh:base:0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  unregistered: 'did:agoramesh:base:0x0000000000000000000000000000000000000000',
};

/** Test node URL */
export const TEST_NODE_URL = 'http://localhost:8080';

// =============================================================================
// Mock Data Generators
// =============================================================================

/**
 * Create a test skill.
 */
export function createTestSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill for testing purposes',
    tags: ['test', 'example'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
    pricing: {
      model: 'per_request',
      amount: '0.10',
      currency: 'USDC',
    },
    ...overrides,
  };
}

/**
 * Create a test capability card.
 */
export function createTestCapabilityCard(
  overrides: Partial<CapabilityCard> = {}
): CapabilityCard {
  return {
    $schema: 'https://agoramesh.ai/schemas/capability-card-v1.json',
    id: TEST_DIDS.provider,
    name: 'Test Agent',
    description: 'A test agent for testing purposes',
    version: '1.0.0',
    url: 'https://test-agent.example.com',
    protocolVersion: '1.0',
    provider: {
      name: 'Test Provider',
      url: 'https://example.com',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      x402Payments: true,
      escrow: true,
    },
    authentication: {
      schemes: ['did-auth'],
      didMethods: ['agoramesh'],
    },
    skills: [createTestSkill()],
    payment: {
      methods: ['escrow', 'x402'],
      currencies: ['USDC'],
      chains: ['base-sepolia'],
      addresses: {
        'base-sepolia': TEST_ADDRESSES.provider,
      },
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    ...overrides,
  };
}

/**
 * Create a test trust score.
 */
export function createTestTrustScore(
  overrides: Partial<TrustScore> = {}
): TrustScore {
  return {
    overall: 0.75,
    reputation: 0.8,
    stake: 0.6,
    endorsement: 0.5,
    ...overrides,
  };
}

/**
 * Create a zero trust score (for new agents).
 */
export function createZeroTrustScore(): TrustScore {
  return {
    overall: 0,
    reputation: 0,
    stake: 0,
    endorsement: 0,
  };
}

/**
 * Create test trust details.
 */
export function createTestTrustDetails(
  overrides: Partial<TrustDetails> = {}
): TrustDetails {
  return {
    scores: createTestTrustScore(),
    reputation: {
      totalTransactions: 100n,
      successfulTransactions: 95n,
      successRate: 9500, // 95%
      totalVolumeUsd: 50000_000000n, // $50,000 in USDC decimals
    },
    stake: {
      amount: 5000_000000n, // 5000 USDC
      unlockTime: 0n,
      pendingWithdrawal: 0n,
    },
    endorsements: [],
    ...overrides,
  };
}

/**
 * Create a test escrow.
 */
export function createTestEscrow(overrides: Partial<Escrow> = {}): Escrow {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    id: 1n,
    clientDid: keccak256(toHex(TEST_DIDS.client)),
    providerDid: keccak256(toHex(TEST_DIDS.provider)),
    clientAddress: TEST_ADDRESSES.client,
    providerAddress: TEST_ADDRESSES.provider,
    amount: parseUnits('100', USDC_DECIMALS), // 100 USDC
    token: TEST_CONTRACT_ADDRESSES.usdc,
    taskHash: keccak256(toHex('test-task')),
    outputHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    deadline: now + 86400n, // 24 hours from now
    state: 0 as EscrowState, // AWAITING_DEPOSIT
    createdAt: now,
    deliveredAt: 0n,
    ...overrides,
  };
}

/**
 * Create a test agent info (on-chain).
 */
export function createTestAgentInfo(
  overrides: Partial<AgentInfo> = {}
): AgentInfo {
  return {
    didHash: keccak256(toHex(TEST_DIDS.provider)),
    owner: TEST_ADDRESSES.provider,
    capabilityCardCID: 'ipfs://QmTest1234567890',
    registeredAt: BigInt(Math.floor(Date.now() / 1000) - 86400), // 1 day ago
    isActive: true,
    ...overrides,
  };
}

/**
 * Create a test discovery result.
 */
export function createTestDiscoveryResult(
  overrides: Partial<DiscoveryResult> = {}
): DiscoveryResult {
  return {
    did: TEST_DIDS.provider,
    name: 'Test Agent',
    description: 'A test agent for testing purposes',
    url: 'https://test-agent.example.com',
    trust: createTestTrustScore(),
    pricing: {
      model: 'per_request',
      amount: '0.10',
      currency: 'USDC',
    },
    matchingSkills: [createTestSkill()],
    ...overrides,
  };
}

// =============================================================================
// Mock Event Log Helpers
// =============================================================================

const ESCROW_CREATED_SELECTOR = keccak256(toHex('EscrowCreated(uint256,bytes32,bytes32,uint256,uint256)'));
const STREAM_CREATED_SELECTOR = keccak256(toHex('StreamCreated(uint256,bytes32,bytes32,uint256,uint256)'));

function createMockEscrowCreatedLog(escrowId: bigint, clientDid: `0x${string}`, providerDid: `0x${string}`, amount: bigint, deadline: bigint) {
  return {
    address: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    topics: [
      ESCROW_CREATED_SELECTOR,
      pad(numberToHex(escrowId), { size: 32 }),
      clientDid,
      providerDid,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [amount, deadline]
    ),
    blockNumber: 1n,
    transactionHash: '0x0' as `0x${string}`,
    transactionIndex: 0,
    blockHash: '0x0' as `0x${string}`,
    logIndex: 0,
    removed: false,
  };
}

function createMockStreamCreatedLog(streamId: bigint, senderDid: `0x${string}`, recipientDid: `0x${string}`, depositAmount: bigint, duration: bigint) {
  return {
    address: '0x0000000000000000000000000000000000000002' as `0x${string}`,
    topics: [
      STREAM_CREATED_SELECTOR,
      pad(numberToHex(streamId), { size: 32 }),
      senderDid,
      recipientDid,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [depositAmount, duration]
    ),
    blockNumber: 1n,
    transactionHash: '0x0' as `0x${string}`,
    transactionIndex: 0,
    blockHash: '0x0' as `0x${string}`,
    logIndex: 0,
    removed: false,
  };
}

// =============================================================================
// Mock Helpers
// =============================================================================

/**
 * Convert a trust score to basis points (0-10000).
 */
export function scoreToBasisPoints(score: number): bigint {
  return BigInt(Math.floor(score * BASIS_POINTS));
}

/**
 * Stream data for mock streaming payments.
 */
export interface MockStream {
  id: bigint;
  senderDid: `0x${string}`;
  recipientDid: `0x${string}`;
  sender: `0x${string}`;
  recipient: `0x${string}`;
  token: `0x${string}`;
  depositAmount: bigint;
  withdrawnAmount: bigint;
  startTime: bigint;
  endTime: bigint;
  ratePerSecond: bigint;
  status: number;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
}

/**
 * Create a mock public client for read operations.
 */
export function createMockPublicClient() {
  const registeredAgents = new Map<string, AgentInfo>();
  const trustScores = new Map<string, TrustScore>();
  const escrows = new Map<bigint, Escrow>();
  const extendedAgentData = new Map<string, {
    owner: `0x${string}`;
    trustScore: TrustScore;
    successfulTransactions: number;
    failedTransactions: number;
    totalVolume: bigint;
  }>();
  const streams = new Map<bigint, MockStream>();
  // Use object to allow mutation from wallet client
  const state = { nextEscrowId: 1n, nextStreamId: 1n };
  // Pending receipt logs keyed by tx hash (populated by writeContract, consumed by waitForTransactionReceipt)
  const pendingReceiptLogs = new Map<string, unknown[]>();

  const mockClient = {
    registeredAgents,
    trustScores,
    escrows,
    extendedAgentData,
    streams,
    // Getter/setter for nextEscrowId so we can access and modify it
    get nextEscrowId() { return state.nextEscrowId; },
    set nextEscrowId(value: bigint) { state.nextEscrowId = value; },
    get nextStreamId() { return state.nextStreamId; },
    set nextStreamId(value: bigint) { state.nextStreamId = value; },

    getChainId: vi.fn().mockResolvedValue(TEST_CHAIN_ID),

    readContract: vi.fn().mockImplementation(async ({ functionName, args }) => {
      switch (functionName) {
        case 'getAgent': {
          const didHash = args[0] as `0x${string}`;
          const agent = registeredAgents.get(didHash);
          if (!agent) {
            return {
              didHash,
              owner: '0x0000000000000000000000000000000000000000',
              capabilityCardCID: '',
              registeredAt: 0n,
              isActive: false,
            };
          }
          return agent;
        }

        case 'isAgentActive': {
          const didHash = args[0] as `0x${string}`;
          const agent = registeredAgents.get(didHash);
          return agent?.isActive ?? false;
        }

        case 'getTrustScore': {
          const didHash = args[0] as `0x${string}`;
          const score = trustScores.get(didHash);
          return scoreToBasisPoints(score?.overall ?? 0);
        }

        case 'getTrustDetails': {
          const didHash = args[0] as `0x${string}`;
          const score = trustScores.get(didHash) ?? createZeroTrustScore();
          return [
            scoreToBasisPoints(score.reputation),
            scoreToBasisPoints(score.stake),
            scoreToBasisPoints(score.endorsement),
            scoreToBasisPoints(score.overall),
          ];
        }

        case 'getTrustData': {
          const didHash = args[0] as `0x${string}`;
          const score = trustScores.get(didHash);
          if (!score) {
            return {
              reputationScore: 0n,
              totalTransactions: 0n,
              successfulTransactions: 0n,
              totalVolumeUsd: 0n,
              lastActivityTimestamp: 0n,
              stakedAmount: 0n,
              stakeUnlockTime: 0n,
            };
          }
          return {
            reputationScore: scoreToBasisPoints(score.reputation),
            totalTransactions: 100n,
            successfulTransactions: 95n,
            totalVolumeUsd: 50000_000000n,
            lastActivityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
            stakedAmount: parseUnits('5000', USDC_DECIMALS),
            stakeUnlockTime: 0n,
          };
        }

        case 'getEndorsements': {
          return [];
        }

        case 'getEscrow': {
          const escrowId = args[0] as bigint;
          const escrow = escrows.get(escrowId);
          if (!escrow) {
            throw new Error(`Escrow ${escrowId} not found`);
          }
          return escrow;
        }

        case 'nextEscrowId': {
          return state.nextEscrowId;
        }

        case 'allowance': {
          // Mock sufficient allowance
          return parseUnits('1000000', USDC_DECIMALS);
        }

        // Streaming payments
        case 'getStream': {
          const streamId = args[0] as bigint;
          const stream = streams.get(streamId);
          if (!stream) {
            throw new Error(`Stream ${streamId} not found`);
          }
          return stream;
        }

        case 'nextStreamId': {
          return state.nextStreamId;
        }

        case 'withdrawableAmountOf': {
          const streamId = args[0] as bigint;
          const stream = streams.get(streamId);
          if (!stream) return 0n;

          const now = BigInt(Math.floor(Date.now() / 1000));
          const duration = stream.endTime - stream.startTime;
          const elapsed = now < stream.startTime ? 0n :
                          now > stream.endTime ? duration :
                          now - stream.startTime;

          const streamed = duration > 0n ? (stream.depositAmount * elapsed) / duration : 0n;
          return streamed > stream.withdrawnAmount ? streamed - stream.withdrawnAmount : 0n;
        }

        case 'streamedAmountOf': {
          const streamId = args[0] as bigint;
          const stream = streams.get(streamId);
          if (!stream) return 0n;

          const now = BigInt(Math.floor(Date.now() / 1000));
          const duration = stream.endTime - stream.startTime;
          const elapsed = now < stream.startTime ? 0n :
                          now > stream.endTime ? duration :
                          now - stream.startTime;

          return duration > 0n ? (stream.depositAmount * elapsed) / duration : 0n;
        }

        case 'balanceOf': {
          const streamId = args[0] as bigint;
          const stream = streams.get(streamId);
          if (!stream) return 0n;
          return stream.depositAmount - stream.withdrawnAmount;
        }

        case 'isActive': {
          const streamId = args[0] as bigint;
          const stream = streams.get(streamId);
          return stream?.status === 1; // StreamStatus.ACTIVE
        }

        default:
          throw new Error(`Unhandled readContract: ${functionName}`);
      }
    }),

    waitForTransactionReceipt: vi.fn().mockImplementation(async ({ hash }: { hash: string }) => {
      const logs = pendingReceiptLogs.get(hash) ?? [];
      pendingReceiptLogs.delete(hash);
      return { status: 'success', blockNumber: 1n, logs };
    }),

    pendingReceiptLogs,
  };

  return mockClient;
}

/**
 * Create a mock wallet client for write operations.
 */
export function createMockWalletClient(mockPublicClient: ReturnType<typeof createMockPublicClient>) {
  return {
    account: {
      address: TEST_ADDRESSES.client,
    },

    writeContract: vi.fn().mockImplementation(async ({ functionName, args }) => {
      const txHash = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}` as `0x${string}`;

      switch (functionName) {
        case 'registerAgent': {
          const didHash = args[0] as `0x${string}`;
          const capabilityCardCID = args[1] as string;
          mockPublicClient.registeredAgents.set(didHash, {
            didHash,
            owner: TEST_ADDRESSES.client,
            capabilityCardCID,
            registeredAt: BigInt(Math.floor(Date.now() / 1000)),
            isActive: true,
          });
          break;
        }

        case 'updateCapabilityCard': {
          const didHash = args[0] as `0x${string}`;
          const newCID = args[1] as string;
          const agent = mockPublicClient.registeredAgents.get(didHash);
          if (agent) {
            agent.capabilityCardCID = newCID;
          }
          break;
        }

        case 'deactivateAgent': {
          const didHash = args[0] as `0x${string}`;
          const agent = mockPublicClient.registeredAgents.get(didHash);
          if (agent) {
            agent.isActive = false;
          }
          break;
        }

        case 'createEscrow': {
          const createdEscrowId = mockPublicClient.nextEscrowId;
          const escrow = createTestEscrow({
            id: createdEscrowId,
            clientDid: args[0] as `0x${string}`,
            providerDid: args[1] as `0x${string}`,
            providerAddress: args[2] as `0x${string}`,
            token: args[3] as `0x${string}`,
            amount: args[4] as bigint,
            taskHash: args[5] as `0x${string}`,
            deadline: args[6] as bigint,
            state: 0 as EscrowState, // AWAITING_DEPOSIT
          });
          mockPublicClient.escrows.set(escrow.id, escrow);
          mockPublicClient.nextEscrowId++;
          mockPublicClient.pendingReceiptLogs.set(txHash, [
            createMockEscrowCreatedLog(createdEscrowId, args[0] as `0x${string}`, args[1] as `0x${string}`, args[4] as bigint, args[6] as bigint),
          ]);
          break;
        }

        case 'fundEscrow': {
          const escrowId = args[0] as bigint;
          const escrow = mockPublicClient.escrows.get(escrowId);
          if (escrow) {
            escrow.state = 1 as EscrowState; // FUNDED
          }
          break;
        }

        case 'confirmDelivery': {
          const escrowId = args[0] as bigint;
          const outputHash = args[1] as `0x${string}`;
          const escrow = mockPublicClient.escrows.get(escrowId);
          if (escrow) {
            escrow.state = 2 as EscrowState; // DELIVERED
            escrow.outputHash = outputHash;
            escrow.deliveredAt = BigInt(Math.floor(Date.now() / 1000));
          }
          break;
        }

        case 'releaseEscrow': {
          const escrowId = args[0] as bigint;
          const escrow = mockPublicClient.escrows.get(escrowId);
          if (escrow) {
            escrow.state = 4 as EscrowState; // RELEASED
          }
          break;
        }

        case 'initiateDispute': {
          const escrowId = args[0] as bigint;
          const escrow = mockPublicClient.escrows.get(escrowId);
          if (escrow) {
            escrow.state = 3 as EscrowState; // DISPUTED
          }
          break;
        }

        case 'claimTimeout': {
          const escrowId = args[0] as bigint;
          const escrow = mockPublicClient.escrows.get(escrowId);
          if (escrow) {
            escrow.state = 5 as EscrowState; // REFUNDED
          }
          break;
        }

        case 'depositStake': {
          const didHash = args[0] as `0x${string}`;
          const amount = args[1] as bigint;
          const score = mockPublicClient.trustScores.get(didHash) ?? createZeroTrustScore();
          // Increase stake score based on amount
          const stakeScore = Math.min(1.0, Math.sqrt(Number(formatUnits(amount, USDC_DECIMALS)) / 10000));
          mockPublicClient.trustScores.set(didHash, {
            ...score,
            stake: stakeScore,
            overall: 0.5 * score.reputation + 0.3 * stakeScore + 0.2 * score.endorsement,
          });
          break;
        }

        case 'endorse': {
          const endorseeDid = args[0] as `0x${string}`;
          const score = mockPublicClient.trustScores.get(endorseeDid) ?? createZeroTrustScore();
          // Increase endorsement score
          const newEndorsementScore = Math.min(1.0, score.endorsement + 0.2);
          mockPublicClient.trustScores.set(endorseeDid, {
            ...score,
            endorsement: newEndorsementScore,
            overall: 0.5 * score.reputation + 0.3 * score.stake + 0.2 * newEndorsementScore,
          });
          break;
        }

        case 'approve':
          // ERC20 approve - no state change needed
          break;

        // Streaming payments
        case 'createStream': {
          const recipientDidHash = args[0] as `0x${string}`;
          const recipient = args[1] as `0x${string}`;
          const token = args[2] as `0x${string}`;
          const depositAmount = args[3] as bigint;
          const duration = args[4] as bigint;
          const cancelableBySender = args[5] as boolean;
          const cancelableByRecipient = args[6] as boolean;

          const createdStreamId = mockPublicClient.nextStreamId;
          const now = BigInt(Math.floor(Date.now() / 1000));
          const stream: MockStream = {
            id: createdStreamId,
            senderDid: keccak256(toHex(TEST_ADDRESSES.client)),
            recipientDid: recipientDidHash,
            sender: TEST_ADDRESSES.client,
            recipient,
            token,
            depositAmount,
            withdrawnAmount: 0n,
            startTime: now,
            endTime: now + duration,
            ratePerSecond: duration > 0n ? depositAmount / duration : 0n,
            status: 1, // ACTIVE
            cancelableBySender,
            cancelableByRecipient,
          };
          mockPublicClient.streams.set(stream.id, stream);
          mockPublicClient.nextStreamId++;
          mockPublicClient.pendingReceiptLogs.set(txHash, [
            createMockStreamCreatedLog(createdStreamId, keccak256(toHex(TEST_ADDRESSES.client)), recipientDidHash, depositAmount, duration),
          ]);
          break;
        }

        case 'withdraw': {
          const streamId = args[0] as bigint;
          const amount = args[1] as bigint;
          const stream = mockPublicClient.streams.get(streamId);
          if (stream) {
            stream.withdrawnAmount += amount;
          }
          break;
        }

        case 'withdrawMax': {
          const streamId = args[0] as bigint;
          const stream = mockPublicClient.streams.get(streamId);
          if (stream) {
            const now = BigInt(Math.floor(Date.now() / 1000));
            const duration = stream.endTime - stream.startTime;
            const elapsed = now < stream.startTime ? 0n :
                            now > stream.endTime ? duration :
                            now - stream.startTime;
            const streamed = duration > 0n ? (stream.depositAmount * elapsed) / duration : stream.depositAmount;
            const withdrawable = streamed > stream.withdrawnAmount ? streamed - stream.withdrawnAmount : 0n;
            stream.withdrawnAmount += withdrawable;
          }
          break;
        }

        case 'cancel': {
          const streamId = args[0] as bigint;
          const stream = mockPublicClient.streams.get(streamId);
          if (stream) {
            stream.status = 3; // CANCELED
          }
          break;
        }

        case 'pause': {
          const streamId = args[0] as bigint;
          const stream = mockPublicClient.streams.get(streamId);
          if (stream) {
            stream.status = 2; // PAUSED
          }
          break;
        }

        case 'resume': {
          const streamId = args[0] as bigint;
          const stream = mockPublicClient.streams.get(streamId);
          if (stream) {
            stream.status = 1; // ACTIVE
          }
          break;
        }
      }

      return txHash;
    }),
  };
}

/**
 * Create a mock fetch function for discovery API calls.
 */
export function createMockFetch() {
  const announcedCards = new Map<string, CapabilityCard>();

  const mockFetch = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const method = options?.method ?? 'GET';

    // Semantic search endpoint (GET /agents/semantic?q=...)
    if (path === '/agents/semantic' && method === 'GET') {
      const query = urlObj.searchParams.get('q') ?? '';
      const minTrust = parseFloat(urlObj.searchParams.get('minTrust') ?? '0');
      const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);

      // Split query into words for matching
      const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

      // Helper for fuzzy word matching (common prefix or one contains the other)
      const wordsMatch = (text: string, word: string): boolean => {
        const t = text.toLowerCase();
        const w = word.toLowerCase();
        // Direct contains check
        if (t.includes(w) || w.includes(t)) return true;
        // Common prefix matching (at least 5 chars or full shorter word)
        const minLen = Math.min(t.length, w.length, 5);
        if (minLen >= 4 && t.substring(0, minLen) === w.substring(0, minLen)) return true;
        return false;
      };

      // Helper to check if a card matches a single word
      const cardMatchesWord = (card: CapabilityCard, word: string): boolean => {
        // Check name (each word in name)
        if (card.name.toLowerCase().split(/\s+/).some((w) => wordsMatch(w, word))) {
          return true;
        }
        // Check description (each word)
        if (card.description.toLowerCase().split(/\s+/).some((w) => wordsMatch(w, word))) {
          return true;
        }
        // Check skills
        if (card.skills.some((s) =>
          s.name.toLowerCase().split(/\s+/).some((w) => wordsMatch(w, word)) ||
          s.tags?.some((t) => wordsMatch(t, word))
        )) {
          return true;
        }
        return false;
      };

      // Return mock results as SemanticSearchResult array (node format)
      let results = Array.from(announcedCards.values())
        .filter((card) => {
          const matchesQuery = queryWords.length === 0 || queryWords.every((word) =>
            cardMatchesWord(card, word)
          );
          const cardTrust = card.trust?.score ?? 0.75;
          const meetsTrust = cardTrust >= minTrust;
          return matchesQuery && meetsTrust;
        })
        .map((card) => ({
          did: card.id,
          score: 0.9,
          vector_score: 0.85,
          keyword_score: 0.95,
          card: {
            name: card.name,
            description: card.description,
            url: card.url,
            capabilities: card.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
            })),
            agoramesh: {
              did: card.id,
              trust_score: card.trust?.score ?? 0.75,
              pricing: card.skills[0]?.pricing ? {
                base_price: parseFloat(card.skills[0].pricing.amount),
                currency: card.skills[0].pricing.currency,
                model: card.skills[0].pricing.model,
              } : undefined,
            },
          },
        }));

      // Apply limit
      results = results.slice(0, limit);

      // Node returns a direct array, not { results: [] }
      return {
        ok: true,
        json: async () => results,
      };
    }

    // Keyword search endpoint (GET /agents?q=...)
    if (path === '/agents' && method === 'GET') {
      const query = urlObj.searchParams.get('q') ?? '';
      const tags = query.split(',').map((t) => t.trim()).filter(Boolean);

      // Return mock results as CapabilityCard array (node format)
      const results = Array.from(announcedCards.values())
        .filter((card) => {
          if (tags.length === 0) return true;
          return card.skills.some((skill) => skill.tags?.some((t) => tags.includes(t)));
        })
        .map((card) => ({
          name: card.name,
          description: card.description,
          url: card.url,
          capabilities: card.skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
          })),
          agoramesh: {
            did: card.id,
            trust_score: card.trust?.score ?? 0.75,
          },
        }));

      // Node returns a direct array
      return {
        ok: true,
        json: async () => results,
      };
    }

    // Get capability card by DID (GET /agents/{did})
    if (path.startsWith('/agents/') && !path.includes('/semantic') && method === 'GET') {
      const did = decodeURIComponent(path.split('/agents/')[1]);
      const card = announcedCards.get(did);

      if (card) {
        return {
          ok: true,
          json: async () => card,
        };
      }

      return {
        ok: false,
        status: 404,
        text: async () => 'Agent not found',
      };
    }

    // Register agent (POST /agents)
    if (path === '/agents' && method === 'POST') {
      const card = JSON.parse(options?.body as string) as CapabilityCard;
      announcedCards.set(card.id, card);

      return {
        ok: true,
        json: async () => ({ success: true }),
      };
    }

    // Default: not found
    return {
      ok: false,
      status: 404,
      text: async () => 'Not found',
    };
  });

  return {
    mockFetch,
    announcedCards,
  };
}

// =============================================================================
// Test Setup Helpers
// =============================================================================

/**
 * Setup mock clients for testing.
 */
export function setupMockClients() {
  const mockPublicClient = createMockPublicClient();
  const mockWalletClient = createMockWalletClient(mockPublicClient);

  return {
    mockPublicClient,
    mockWalletClient,
  };
}

/**
 * Extended agent data for testing trust score updates.
 */
export interface ExtendedAgentData {
  owner: `0x${string}`;
  trustScore: TrustScore;
  successfulTransactions: number;
  failedTransactions: number;
  totalVolume: bigint;
}

/**
 * Register a test agent in the mock system.
 */
export function registerTestAgent(
  mockPublicClient: ReturnType<typeof createMockPublicClient>,
  did: string,
  options: {
    owner?: `0x${string}`;
    capabilityCardCID?: string;
    isActive?: boolean;
    trustScore?: TrustScore;
    successfulTransactions?: number;
    failedTransactions?: number;
    totalVolume?: bigint;
  } = {}
) {
  const didHash = keccak256(toHex(did));

  mockPublicClient.registeredAgents.set(didHash, {
    didHash,
    owner: options.owner ?? TEST_ADDRESSES.provider,
    capabilityCardCID: options.capabilityCardCID ?? 'ipfs://QmTest1234567890',
    registeredAt: BigInt(Math.floor(Date.now() / 1000)),
    isActive: options.isActive ?? true,
  });

  const trustScore = options.trustScore ?? createZeroTrustScore();
  mockPublicClient.trustScores.set(didHash, trustScore);

  // Store extended agent data for test manipulation
  mockPublicClient.extendedAgentData.set(didHash, {
    owner: options.owner ?? TEST_ADDRESSES.provider,
    trustScore,
    successfulTransactions: options.successfulTransactions ?? 0,
    failedTransactions: options.failedTransactions ?? 0,
    totalVolume: options.totalVolume ?? 0n,
  });
}

/**
 * Create a funded escrow in the mock system.
 */
export function createFundedEscrow(
  mockPublicClient: ReturnType<typeof createMockPublicClient>,
  options: Partial<Escrow> = {}
): bigint {
  const escrowId = mockPublicClient.nextEscrowId;
  const escrow = createTestEscrow({
    id: escrowId,
    state: 1 as EscrowState, // FUNDED
    ...options,
  });

  mockPublicClient.escrows.set(escrowId, escrow);
  mockPublicClient.nextEscrowId++;

  return escrowId;
}

/**
 * Advance time in the mock system (for testing timeouts).
 */
export function advanceTime(
  mockPublicClient: ReturnType<typeof createMockPublicClient>,
  escrowId: bigint,
  seconds: number
) {
  const escrow = mockPublicClient.escrows.get(escrowId);
  if (escrow) {
    // Move deadline to the past
    escrow.deadline = BigInt(Math.floor(Date.now() / 1000) - seconds);
  }
}
