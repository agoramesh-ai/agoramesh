# AgentMe Payment Layer Specification

**Version:** 1.0.0
**Status:** Draft
**x402 Compatible:** Yes
**AP2 Compatible:** Yes

---

## Overview

The Payment Layer enables micropayments between AI agents using the x402 protocol. It supports direct payments, escrow for untrusted parties, and streaming payments for long-running tasks.

## x402 Protocol Integration

AgentMe is fully compatible with the [x402 protocol](https://x402.org/) developed by Coinbase.

### Flow Diagram

```
Agent A (Client)                    Agent B (Provider)
       │                                    │
       │  1. GET /translate                 │
       │───────────────────────────────────▶│
       │                                    │
       │  2. 402 Payment Required           │
       │     {amount, currency, recipient}  │
       │◀───────────────────────────────────│
       │                                    │
       │  3. [Pay on-chain]                 │
       │                                    │
       │  4. GET /translate                 │
       │     X-Payment-Proof: <receipt>     │
       │───────────────────────────────────▶│
       │                                    │
       │  5. 200 OK                         │
       │     {result: "translated text"}    │
       │◀───────────────────────────────────│
```

## Payment Methods

| Method | Use Case | Trust Required | Fee |
|--------|----------|----------------|-----|
| **Direct (x402)** | Trusted parties, low-value | High | ~$0.001 |
| **Escrow** | New relationships | Low | ~$0.01 |
| **Streaming** | Long-running tasks | Medium | Per-second |

## Implementation

### Server-Side (Agent Provider)

```typescript
// TypeScript - Express server with x402 middleware
import express from 'express';
import { x402Middleware } from '@x402/express';
import { AgentMeTrust } from '@agentme/sdk';

const app = express();
const trust = new AgentMeTrust();

// Dynamic pricing based on trust score
app.use('/translate', async (req, res, next) => {
  const clientDid = req.headers['x-agent-did'];
  const trustScore = await trust.getScore(clientDid);

  // Trusted clients get better rates
  const price = trustScore > 0.9 ? '0.03' : '0.05';
  const escrowRequired = trustScore < 0.7;

  const config = {
    price,
    token: 'USDC',
    network: 'base',
    recipient: process.env.AGENT_WALLET,
    facilitatorUrl: 'https://facilitator.x402.dev',
    escrowRequired,
    escrowContract: escrowRequired ? process.env.ESCROW_CONTRACT : undefined
  };

  return x402Middleware(config)(req, res, next);
});

app.post('/translate', async (req, res) => {
  const { text, sourceLang, targetLang } = req.body;

  // Perform translation
  const result = await translateDocument(text, sourceLang, targetLang);

  // Record successful transaction for reputation
  await trust.recordTransaction({
    clientDid: req.headers['x-agent-did'],
    providerDid: process.env.AGENT_DID,
    volumeUsd: parseFloat(req.x402.amount),
    successful: true
  });

  res.json({ result, wordCount: text.split(' ').length });
});

app.listen(4021);
```

### Client-Side (Agent Consumer)

```typescript
// TypeScript - Agent client with automatic payment handling
import { AgentMeClient, DiscoveryResult } from '@agentme/sdk';
import { wrapAxiosWithPayment, x402Client } from '@x402/axios';
import { privateKeyToAccount } from 'viem/accounts';

const signer = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const x402 = new x402Client();
x402.registerExactEvmScheme({ signer });

const agentme = new AgentMeClient({
  did: process.env.AGENT_DID,
  x402Client: x402
});

async function translateWithBestAgent(document: string): Promise<string> {
  // 1. Discover translation agents
  const agents = await agentme.discover({
    query: 'translate legal documents Czech to English',
    minTrust: 0.8,
    maxPrice: '0.10'
  });

  if (agents.length === 0) {
    throw new Error('No suitable agents found');
  }

  // 2. Select best agent (highest trust/price ratio)
  const bestAgent = agents.sort((a, b) =>
    (b.trust.score / parseFloat(b.pricing.amount)) -
    (a.trust.score / parseFloat(a.pricing.amount))
  )[0];

  console.log(`Selected agent: ${bestAgent.name} (trust: ${bestAgent.trust.score})`);

  // 3. Execute with automatic payment
  // x402 wrapper handles 402 → pay → retry automatically
  const response = await agentme.execute(bestAgent, {
    skill: 'translate.legal',
    input: { text: document, sourceLang: 'cs', targetLang: 'en' }
  });

  return response.result;
}

// Usage
const translated = await translateWithBestAgent(czechDocument);
console.log(translated);
```

## Escrow System

### When Escrow is Required

| Client Trust Score | Escrow Requirement |
|-------------------|-------------------|
| > 0.9 | None (instant payment) |
| 0.7 - 0.9 | 20% of task value |
| 0.5 - 0.7 | 50% of task value |
| < 0.5 | 100% + milestone-based release |

### Escrow Smart Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract AgentMeEscrow is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ARBITRATOR_ROLE = keccak256("ARBITRATOR_ROLE");

    enum State {
        AWAITING_DEPOSIT,
        FUNDED,
        DELIVERED,
        DISPUTED,
        RELEASED,
        REFUNDED
    }

    struct Escrow {
        bytes32 clientDid;
        bytes32 providerDid;
        address clientAddress;
        address providerAddress;
        uint256 amount;
        IERC20 token;
        bytes32 taskHash;           // Hash of task specification
        bytes32 expectedOutputHash; // Optional: hash of expected output
        uint256 deadline;
        State state;
        uint256 createdAt;
    }

    mapping(uint256 => Escrow) public escrows;
    uint256 public nextEscrowId;

    event EscrowCreated(uint256 indexed escrowId, bytes32 clientDid, bytes32 providerDid, uint256 amount);
    event EscrowFunded(uint256 indexed escrowId);
    event TaskDelivered(uint256 indexed escrowId, bytes32 outputHash);
    event EscrowReleased(uint256 indexed escrowId);
    event EscrowRefunded(uint256 indexed escrowId);
    event DisputeInitiated(uint256 indexed escrowId, address initiator);
    event DisputeResolved(uint256 indexed escrowId, bool releasedToProvider, uint256 amount);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address tokenAddress,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline
    ) external returns (uint256 escrowId) {
        require(amount > 0, "Amount must be positive");
        require(deadline > block.timestamp, "Deadline must be future");

        escrowId = nextEscrowId++;

        escrows[escrowId] = Escrow({
            clientDid: clientDid,
            providerDid: providerDid,
            clientAddress: msg.sender,
            providerAddress: providerAddress,
            amount: amount,
            token: IERC20(tokenAddress),
            taskHash: taskHash,
            expectedOutputHash: bytes32(0),
            deadline: deadline,
            state: State.AWAITING_DEPOSIT,
            createdAt: block.timestamp
        });

        emit EscrowCreated(escrowId, clientDid, providerDid, amount);
    }

    function fundEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.AWAITING_DEPOSIT, "Invalid state");
        require(msg.sender == escrow.clientAddress, "Not client");

        // Transfer tokens to escrow
        escrow.token.safeTransferFrom(msg.sender, address(this), escrow.amount);
        escrow.state = State.FUNDED;

        emit EscrowFunded(escrowId);
    }

    function confirmDelivery(uint256 escrowId, bytes32 outputHash) external {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.FUNDED, "Invalid state");
        require(msg.sender == escrow.providerAddress, "Not provider");

        escrow.expectedOutputHash = outputHash;
        escrow.state = State.DELIVERED;

        emit TaskDelivered(escrowId, outputHash);
    }

    function releaseEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == State.FUNDED || escrow.state == State.DELIVERED,
            "Invalid state"
        );
        require(msg.sender == escrow.clientAddress, "Not client");

        // Checks-Effects-Interactions pattern
        escrow.state = State.RELEASED;
        escrow.token.safeTransfer(escrow.providerAddress, escrow.amount);

        emit EscrowReleased(escrowId);
    }

    function initiateDispute(uint256 escrowId, bytes calldata evidence) external {
        Escrow storage escrow = escrows[escrowId];
        require(
            escrow.state == State.FUNDED || escrow.state == State.DELIVERED,
            "Invalid state"
        );
        require(
            msg.sender == escrow.clientAddress || msg.sender == escrow.providerAddress,
            "Not party to escrow"
        );

        escrow.state = State.DISPUTED;

        emit DisputeInitiated(escrowId, msg.sender);
        // Evidence is handled by dispute resolution contract
    }

    function resolveDispute(
        uint256 escrowId,
        bool releaseToProvider,
        uint256 providerShare // Basis points (0-10000)
    ) external onlyRole(ARBITRATOR_ROLE) nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.DISPUTED, "Not disputed");
        require(providerShare <= 10000, "Invalid share");

        uint256 providerAmount = (escrow.amount * providerShare) / 10000;
        uint256 clientAmount = escrow.amount - providerAmount;

        escrow.state = releaseToProvider ? State.RELEASED : State.REFUNDED;

        if (providerAmount > 0) {
            escrow.token.safeTransfer(escrow.providerAddress, providerAmount);
        }
        if (clientAmount > 0) {
            escrow.token.safeTransfer(escrow.clientAddress, clientAmount);
        }

        emit DisputeResolved(escrowId, releaseToProvider, providerAmount);
    }

    function claimTimeout(uint256 escrowId) external nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.FUNDED, "Invalid state");
        require(block.timestamp > escrow.deadline, "Deadline not passed");
        require(msg.sender == escrow.clientAddress, "Not client");

        escrow.state = State.REFUNDED;
        escrow.token.safeTransfer(escrow.clientAddress, escrow.amount);

        emit EscrowRefunded(escrowId);
    }
}
```

## Streaming Payments

For long-running tasks (transcription, continuous monitoring, etc.):

```typescript
// Streaming payment client
import { StreamingPayment } from '@agentme/sdk';

const stream = await StreamingPayment.create({
  provider: agentDid,
  maxAmount: '100.00',  // USDC
  ratePerSecond: '0.01',
  token: 'USDC',
  chain: 'base'
});

// Start task
const task = await agentme.execute(provider, {
  skill: 'transcribe.realtime',
  input: { audioStreamUrl },
  paymentStream: stream
});

// Payment flows automatically as task runs
task.on('progress', (progress) => {
  console.log(`Progress: ${progress}%, Spent: $${stream.totalPaid}`);
});

// Complete or cancel
await task.complete(); // Settles final amount
// OR
await task.cancel();   // Refunds remaining deposit
```

## Supported Currencies

| Currency | Chain | Contract Address |
|----------|-------|-----------------|
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDC | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| DAI | Base | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` |
| EURC | Base | `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` |

## Network Configuration

### Base Mainnet

```json
{
  "chainId": 8453,
  "rpcUrl": "https://mainnet.base.org",
  "explorerUrl": "https://basescan.org",
  "escrowContract": "0x...",
  "trustRegistry": "0x..."
}
```

### Base Sepolia (Testnet)

```json
{
  "chainId": 84532,
  "rpcUrl": "https://sepolia.base.org",
  "explorerUrl": "https://sepolia.basescan.org",
  "escrowContract": "0x...",
  "trustRegistry": "0x..."
}
```

## Fee Structure

| Operation | Cost |
|-----------|------|
| Direct x402 payment | ~$0.001 (gas only) |
| Escrow creation | ~$0.005 |
| Escrow release | ~$0.003 |
| Dispute initiation | ~$0.01 |
| Streaming payment (per settlement) | ~$0.002 |

## Security Considerations

1. **Never expose private keys** - Use HSM or secure enclaves in production
2. **Validate payment receipts** - Verify on-chain before delivering service
3. **Set reasonable timeouts** - Prevent funds from being locked indefinitely
4. **Monitor for front-running** - Consider using commit-reveal for sensitive operations

## See Also

- [x402 Protocol Documentation](https://x402.org/)
- [Google AP2 Protocol](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [Trust Layer Specification](./trust-layer.md)
- [Dispute Resolution Specification](./dispute-resolution.md)
