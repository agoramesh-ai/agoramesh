# AgentMe - Project Context

## What is this?

AgentMe is a decentralized marketplace and trust layer for AI agents. It enables agents to discover each other, verify trustworthiness, and safely transact services.

## Project Status

**Phase:** Early Implementation
**Last Updated:** 2026-02-01

## Repository Structure

```
agentme/
├── bridge/              # Local AI agent bridge (Claude Code worker)
│   ├── src/
│   │   ├── cli.ts       # CLI entry point
│   │   ├── server.ts    # HTTP + WebSocket server
│   │   ├── executor.ts  # Claude Code executor
│   │   └── types.ts     # TypeScript types
│   └── README.md
├── contracts/           # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── TrustRegistry.sol
│   │   └── AgentMeEscrow.sol
│   └── test/
├── deploy/              # Deployment configurations
│   ├── k8s/             # Kubernetes manifests
│   └── production/      # Production docker-compose, nginx, setup
├── node/                # Rust P2P node (libp2p)
│   └── src/
├── sdk/                 # TypeScript SDK
│   └── src/
├── docs/                # Documentation
│   ├── plans/           # Design documents
│   ├── specs/           # Protocol specifications
│   ├── tutorials/       # Step-by-step guides
│   └── reference/       # Reference material
└── Makefile             # Build commands
```

## Documentation Structure

```
docs/
├── plans/
│   ├── 2026-02-01-agentme-design.md    # Original design document
│   ├── 2026-02-01-implementation-plan.md  # Implementation plan
│   └── 2026-02-02-competitive-analysis.md # Competitive analysis
├── specs/
│   ├── capability-card.md                 # Agent Card specification
│   ├── trust-layer.md                     # Trust system & smart contracts
│   ├── payment-layer.md                   # x402 & escrow specification
│   ├── dispute-resolution.md              # Tiered dispute system
│   └── bridge-protocol.md                 # Bridge HTTP/WS API
├── tutorials/
│   ├── getting-started.md                 # Quick start for SDK developers
│   ├── running-a-node.md                  # Node operator guide
│   └── running-local-agent.md             # Run Claude Code as worker
├── security/
│   └── audit-preparation.md               # Security audit checklist
└── reference/
    ├── glossary.md                        # Terms and definitions
    ├── error-codes.md                     # Error codes reference
    ├── real-world-systems.md              # Design validation sources
    └── faq.md                             # Frequently asked questions
```

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Blockchain | Base L2 | Low fees (~$0.001), x402 native, EVM |
| P2P Network | libp2p (Kademlia + GossipSub) | Battle-tested, IPFS/Ethereum proven |
| Node Language | Rust | rust-libp2p powers 42% of Ethereum (Lighthouse), active maintenance, memory safety |
| Contracts | Solidity | EVM standard, OpenZeppelin ecosystem |
| SDK | TypeScript | Developer adoption, x402/viem compatibility |
| Payments | x402 Protocol | Coinbase standard, micropayment native |
| Identity | W3C DID | Interoperable, self-sovereign |

## Core Components

1. **Discovery Layer**
   - A2A-compatible Capability Cards
   - Semantic search (vector embeddings)
   - Decentralized registry (libp2p Kademlia DHT)

2. **Trust Layer** (ERC-8004 compatible)
   - Reputation (on-chain history)
   - Stake (collateral + slashing)
   - Web-of-Trust (endorsement graph)

3. **Payment Layer** (x402 compatible)
   - Direct micropayments (USDC)
   - Escrow with trust-based requirements
   - Streaming payments

4. **Dispute Layer**
   - Automatic (smart contract rules) for < $10
   - AI-assisted for $10-$1000
   - Community arbitration (Kleros-style) for > $1000

## Trust Score Formula

```
trust_score = 0.50 × reputation + 0.30 × stake_factor + 0.20 × endorsement_score

reputation = success_rate × volume_factor × recency_factor × dispute_factor
stake_factor = min(1.0, sqrt(staked_amount / 10000))  # Reference: $10,000 USDC
endorsement_score = sum(endorser_trust × 0.9^hops) / 3.0  # Max 3 hops
```

## Network Configuration

| Network | Chain ID | RPC | USDC Contract |
|---------|----------|-----|---------------|
| Base Mainnet | 8453 | https://mainnet.base.org | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia | 84532 | https://sepolia.base.org | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

## Standards Compatibility

- [A2A Protocol](https://a2a-protocol.org/) - Agent discovery & communication
- [x402 Protocol](https://x402.org/) - HTTP 402 micropayments
- [ERC-8004](https://eips.ethereum.org/) - Trustless Agents standard
- [W3C DID](https://www.w3.org/TR/did-core/) - Decentralized Identifiers
- [libp2p](https://libp2p.io/) - P2P networking

## Development Commands

```bash
# Build everything
make build

# Run tests
make test

# Lint code
make lint

# Install dependencies (SDK + Bridge)
make install-deps

# Bridge specific
make run-bridge           # Start bridge in dev mode
make build-bridge         # Build bridge

# Contracts
make deploy-testnet       # Deploy to Base Sepolia
make deploy-mainnet       # Deploy to Base Mainnet
```

## Key Files to Read First

1. `README.md` - Project overview
2. `docs/tutorials/getting-started.md` - Quick start for SDK
3. `docs/tutorials/running-local-agent.md` - Run Claude Code as worker
4. `docs/specs/capability-card.md` - Agent Card format
5. `docs/specs/bridge-protocol.md` - Bridge HTTP/WS API
6. `docs/specs/trust-layer.md` - Trust system details
7. `docs/specs/dispute-resolution.md` - Dispute resolution tiers
8. `bridge/README.md` - Bridge module documentation

## Research Sources

Documentation is based on research from:
- ERC-8004 Ethereum standard (launched Jan 2026)
- x402 Protocol (Coinbase, 35M+ transactions)
- Kleros (1,600+ disputes, 80%+ juror coherence)
- libp2p GossipSub v1.1 specification
- A2A Protocol Agent Card specification
- Base L2 deployment guides
- See `docs/reference/real-world-systems.md` for detailed analysis

## Implementation Status

- [x] Protocol specifications (capability card, trust, payment, dispute, bridge)
- [x] Rust node (libp2p networking, DHT discovery, trust scoring, HTTP API)
- [x] Solidity contracts (TrustRegistry, Escrow, dispute resolution + extras)
- [x] TypeScript SDK (client, trust, payment, discovery, x402)
- [x] Bridge module (Claude Code executor, escrow integration, HTTP/WS server)
- [ ] Integration testing (end-to-end agent workflow)
- [ ] Deploy to Base Sepolia testnet
- [ ] Security audit
- [ ] Mainnet launch
