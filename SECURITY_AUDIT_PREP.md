# AgentMesh — Security Audit Preparation

## Overview

AgentMesh is a decentralized agent-to-agent commerce protocol built on Base L2 (Ethereum). This document prepares auditors with project context, known risks, and test coverage data.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgentMesh Protocol                    │
├──────────────┬──────────────┬──────────────┬────────────┤
│  Discovery   │    Trust     │   Payment    │  Dispute   │
│  (libp2p     │  (ERC-8004   │  (x402 +     │  (Auto →   │
│   DHT +      │   Trust +    │   Escrow +   │   AI →     │
│   Semantic)  │   Stake)     │   Streaming) │   DAO)     │
├──────────────┴──────────────┴──────────────┴────────────┤
│              Base L2 (Ethereum)  •  USDC                │
└─────────────────────────────────────────────────────────┘
```

## Components

### Solidity Contracts (`contracts/src/`)
| Contract | Description | LOC |
|----------|-------------|-----|
| `TrustRegistry.sol` | Agent registration, trust scores, staking | ~400 |
| `AgentMeshEscrow.sol` | Task escrow with tiered disputes | ~350 |
| `StreamingPayments.sol` | Continuous payment streams | ~300 |
| `AgentToken.sol` | ERC-20 governance token | ~150 |
| `CrossChainSync.sol` | Cross-chain trust synchronization | ~200 |
| `NFTBoundReputation.sol` | Soulbound reputation NFTs | ~200 |
| `VerifiedNamespaces.sol` | Agent namespace management | ~200 |
| `ERC8004Adapter.sol` | ERC-8004 trust standard adapter | ~100 |

### TypeScript SDK (`sdk/src/`)
Client library for interacting with all contracts + discovery layer.

### Rust Node (`node/`)
P2P discovery node using libp2p (Kademlia DHT, GossipSub).

### Bridge (`bridge/`)
Claude Code worker that executes tasks on behalf of agents.

## Test Coverage

### Solidity (Foundry)
- **381 tests, 0 failures**
- Test suites: TrustRegistry (49), Escrow (51), Streaming (41), CrossChain (26), Disputes (29), Namespaces (36), NFTReputation (30), AgentToken (37), ERC8004 (36), ChainRegistry (28), DeployLocal (2), StreamingPayments (16)

### TypeScript SDK (Vitest)
- **375 unit tests, 0 failures**
- **23 E2E integration tests, 0 failures** (live Anvil + Node + Bridge)
- Coverage: **78.5% statements, 62.4% branches, 90.5% functions, 79.8% lines**

### Rust Node (Cargo)
- Unit + integration tests (run via `cargo test`)

## Known Risks & Considerations

### Critical
1. **Escrow fund custody** — Contract holds USDC during task execution. Re-entrancy protected via `nonReentrant`.
2. **Trust score manipulation** — Sybil attacks on reputation system. Mitigated by staking requirement.
3. **Dispute resolution** — Tiered system (auto → AI → community). AI arbitration is centralized initially.

### Medium
4. **Cross-chain sync** — Trust data bridged between chains. Relies on bridge security.
5. **Streaming payment drainage** — Long-running streams could drain funds if rate misconfigured.
6. **Agent impersonation** — DID ownership verified on-chain but off-chain agent cards are self-reported.

### Low
7. **Namespace squatting** — First-come-first-served namespace registration.
8. **Gas griefing** — Dispute initiation costs gas but could be used to grief providers.

## Access Control

- `DEFAULT_ADMIN_ROLE` — Contract deployer, can add allowed tokens
- `ARBITER_ROLE` — Can resolve disputes (initially admin, later DAO)
- Agent registration — Permissionless (one agent per wallet)
- Escrow creation — Requires active agent registration

## External Dependencies

### On-chain
- OpenZeppelin Contracts v5 (AccessControl, ReentrancyGuard, SafeERC20, ERC721)
- USDC (Circle) on Base L2

### Off-chain
- libp2p (P2P networking)
- RocksDB (local agent storage)
- OpenAI API (AI arbitration — not consensus-critical)

## Deployment

- **Testnet:** Base Sepolia (deployed, addresses in `deployments/sepolia.json`)
- **Local:** Anvil + Docker Compose (fully automated)
- **Mainnet:** Not yet deployed

## How to Run Tests

```bash
# Solidity
cd contracts && forge test -vvv

# TypeScript SDK (unit)
cd sdk && npm test

# TypeScript SDK (E2E — requires local Docker stack)
cd sdk && npm run test:e2e

# Rust Node
cd node && cargo test
```

## Contact

- GitHub: https://github.com/agentmecz/agentme
- Email: prdko@agentme.cz
