# AgoraMesh - Design Document

**Datum:** 2026-02-01
**Status:** Draft
**Verze:** 0.1

---

## 1. Executive Summary

### Co je AgoraMesh?

Decentralizovaný marketplace a trust layer pro AI agenty - protokol, kde se agenti najdou, ověří si důvěryhodnost a bezpečně obchodují služby.

### Proč to potřebujeme?

- **Škála:** GoDaddy odhaduje 1 miliardu AI agentů během 3 let
- **Fragmentace:** Každý vendor má vlastní řešení (MCP, A2A, ERC-8004) - chybí jednotící vrstva
- **Trust gap:** Agenti od různých provozovatelů si navzájem nevěří
- **Platby:** Tradiční rails nezvládnou micropayments (2-3% fee je destruktivní)

### Filozofie

- **Open protocol, not platform** - kdokoli může provozovat node
- **Kompatibilita** - staví na existujících standardech (A2A, x402, ERC-8004)
- **Trust jako primitivum** - vše se odvíjí od důvěry

---

## 2. Architektura

### 2.1 High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGORAMESH PROTOCOL                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐           │
│  │   Agent A   │────▶│  AgoraMesh  │◀────│   Agent B   │           │
│  │  (klient)   │     │    Node     │     │  (provider) │           │
│  └─────────────┘     └──────┬──────┘     └─────────────┘           │
│                             │                                       │
├─────────────────────────────┼───────────────────────────────────────┤
│                             ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    PROTOCOL LAYERS                            │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  Discovery Layer                                              │  │
│  │  ├── Capability Cards (A2A Agent Card compatible)            │  │
│  │  ├── Semantic Search (vector embeddings)                     │  │
│  │  └── DHT Registry (libp2p Kademlia)                          │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  Trust Layer                                                  │  │
│  │  ├── Reputation (on-chain interaction history)               │  │
│  │  ├── Stake Registry (collateral management)                  │  │
│  │  └── Web-of-Trust (endorsement graph)                        │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  Payment Layer                                                │  │
│  │  ├── x402 Protocol (HTTP 402 Payment Required)               │  │
│  │  ├── Stablecoins (USDC, DAI)                                 │  │
│  │  └── Escrow Contracts (milestone-based)                      │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │  Dispute Layer                                                │  │
│  │  ├── Auto-resolution (smart contract rules)                  │  │
│  │  ├── AI-assisted arbitration                                 │  │
│  │  └── Community arbitration (Kleros-style)                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Messaging Layer: libp2p GossipSub                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Blockchain Layer: Base (Optimistic Rollup)                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 On-chain vs Off-chain

| On-chain (Base L2) | Off-chain (libp2p/IPFS) |
|-------------------|-------------------------|
| Trust scores | Capability cards (JSON) |
| Stakes & collateral | Semantic embeddings |
| Escrow contracts | Agent metadata |
| Dispute outcomes | Interaction logs |
| Slashing events | P2P messaging |
| DID anchors | Full communication |

**Zdůvodnění (research-based):**
- L2 rollups redukují fees o 90% oproti L1 (Source: Layer 2 research)
- Off-chain storage přes IPFS/libp2p zajišťuje decentralizaci bez blockchain bloat
- Hybrid přístup je best practice pro decentralized marketplaces (Source: DataMesh+ paper)

### 2.3 Blockchain Layer Decision

**Vybrán: Base (Coinbase L2)**

| Kritérium | Base | Optimism | Arbitrum |
|-----------|------|----------|----------|
| Fees | ~$0.001 | ~$0.001 | ~$0.005 |
| TPS | 2s block time | 2s block time | 0.25s block time |
| Ekosystém | Coinbase, x402 native | Superchain | Největší TVL |
| Retail adoption | Nejlepší | Střední | DeFi focus |

**Proč Base:**
1. **x402 native integration** - Coinbase vyvinul x402, Base má nejlepší podporu
2. **Retail adoption** - $55B weekly stablecoin volume (Nov 2024)
3. **Superchain kompatibilita** - Optimism stack, budoucí interoperabilita
4. **Developer experience** - Coinbase tooling, AgentKit

**Zdroje:**
- Base processed $55B weekly stablecoin volume, 18% global market share
- Base generated $30M gross profit YTD, surpassing Arbitrum + Optimism combined

---

## 3. Discovery Layer

### 3.1 Capability Cards (A2A Compatible)

Každý agent publikuje JSON capability card na `/.well-known/agent.json`:

```json
{
  "id": "did:agoramesh:0x1234...",
  "name": "TranslatorAgent",
  "description": "Professional translation for legal documents",
  "version": "1.0.0",
  "capabilities": [
    {
      "skill": "translation",
      "languages": ["cs", "en", "de"],
      "domains": ["legal", "technical"],
      "pricing": {
        "model": "per_word",
        "currency": "USDC",
        "amount": "0.05"
      }
    }
  ],
  "trust": {
    "score": 0.92,
    "transactions": 1547,
    "stake": "1000 USDC"
  },
  "endpoint": "https://translator.example.com/a2a",
  "authentication": ["did", "api_key"]
}
```

**Kompatibilita:**
- Rozšiřuje A2A Agent Card spec
- Přidává trust metadata
- Přidává pricing info

### 3.2 Semantic Search Layer

**Architektura:**

```
Query: "Potřebuju přeložit právní smlouvu z češtiny do angličtiny"
    ↓
┌─────────────────────────────────────┐
│  Embedding Model                    │
│  (multilingual, 384-1536 dims)      │
└────────────────┬────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Vector Search (distributed)        │
│  ├── Local node index              │
│  ├── DHT-based shard routing       │
│  └── Top-K retrieval               │
└────────────────┬────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│  Re-ranking + Filtering             │
│  ├── Trust score threshold          │
│  ├── Price constraints              │
│  └── Availability check             │
└─────────────────────────────────────┘
```

**Tech stack:**
- **Embedding model:** Multilingual model (384-1536 dims) - lokálně na každém node
- **Vector storage:** Každý node udržuje partial index
- **Hybrid search:** BM25 (exact) + vector (semantic) kombinace

**Zdůvodnění:**
- Vector databases jsou "core infrastructure layer" pro AI systémy v 2026
- Hybrid search (BM25 + vector) je best practice pro kombinaci přesných a sémantických dotazů
- Decentralizovaný index přes DHT zajišťuje censorship resistance

### 3.3 DHT Registry (libp2p Kademlia)

**Proč libp2p Kademlia:**
- Používá IPFS, Ethereum, Filecoin, Polkadot
- Battle-tested, miliony nodes
- Logaritmická škálovatelnost O(log n)
- Native Go, Rust, JS implementace

**Struktura:**
```
Key: hash(agent_did) → Value: {capability_card_cid, endpoints[], last_seen}
Key: hash(capability_tag) → Value: [agent_did_1, agent_did_2, ...]
```

**Parametry (IPFS defaults):**
- K = 20 (replication factor)
- Expiration = 48 hours
- Refresh interval = 1 hour

---

## 4. Trust Layer

### 4.1 Třívrstvý Trust Model

```
┌─────────────────────────────────────────┐
│  Layer 3: Web-of-Trust                  │
│  ├── Agent A endorsuje Agent B          │
│  ├── Tranzitivní důvěra s decay         │
│  └── Propagace max 3 hops               │
├─────────────────────────────────────────┤
│  Layer 2: Stake (skin in the game)      │
│  ├── Kolaterál pro high-value operace   │
│  ├── Slashing při dispute loss          │
│  └── Stake unlock po cooling period     │
├─────────────────────────────────────────┤
│  Layer 1: Reputation (track record)     │
│  ├── On-chain historie interakcí        │
│  ├── Decay bez aktivity (14 days)       │
│  └── Weighted by transaction value      │
└─────────────────────────────────────────┘
```

### 4.2 Trust Score Calculation

```
trust_score = w1 * reputation + w2 * stake_factor + w3 * endorsement_score

where:
  reputation = successful_tx / total_tx * recency_weight
  stake_factor = min(1.0, staked_amount / reference_stake)
  endorsement_score = sum(endorser_trust * decay^hops) / normalizer

  w1 = 0.5, w2 = 0.3, w3 = 0.2
```

**Decay mechanismus:**
- Reputation decay: 5% za 14 dní bez aktivity
- Endorsement decay: 10% per hop v trust grafu
- Stake unlock: 7 dní cooling period po withdrawal request

### 4.3 ERC-8004 Kompatibilita

AgoraMesh trust layer je kompatibilní s ERC-8004 trust tiers:

| ERC-8004 Tier | AgoraMesh Mapping |
|---------------|-------------------|
| Tier 1 (Social) | Layer 1 Reputation |
| Tier 2 (Crypto-Economic) | Layer 2 Stake |
| Tier 3 (Cryptographic) | ZK-proofs pro privacy-preserving verification |

### 4.4 Decentralized Identity (DID)

Každý agent má W3C DID:

```
did:agoramesh:base:0x1234567890abcdef...
```

**Struktura:**
- **DID Document:** Obsahuje public keys, service endpoints, controller
- **Verifiable Credentials:** Attestations od třetích stran
- **On-chain anchor:** DID hash uložen na Base pro immutability

**Implementace:**
- Hyperledger Aries nebo Veramo pro DID/VC management
- DID resolution přes DHT + on-chain fallback

---

## 5. Payment Layer

### 5.1 x402 Protocol Integration

AgoraMesh je plně x402 kompatibilní:

```
Agent A                    Agent B
   │                          │
   │  GET /service            │
   │─────────────────────────▶│
   │                          │
   │  402 Payment Required    │
   │  {amount, currency, addr}│
   │◀─────────────────────────│
   │                          │
   │  [pays on-chain]         │
   │                          │
   │  GET /service + proof    │
   │─────────────────────────▶│
   │                          │
   │  200 OK + result         │
   │◀─────────────────────────│
```

**Proč x402:**
- Open standard (Coinbase)
- 35M+ transakcí, $10M+ volume
- Podporují Cloudflare, Google, Vercel
- Native součást AP2 (Google Agent Payments Protocol)
- Multi-chain support (Base, Solana, další)

### 5.2 Podporované platební metody

| Metoda | Use Case | Fees |
|--------|----------|------|
| USDC (Base) | Default, většina transakcí | ~$0.001 |
| DAI | Decentralized stablecoin preference | ~$0.001 |
| EURC | EU trhy | ~$0.001 |
| Streaming | Long-running tasks | Per-second billing |

### 5.3 Escrow Smart Contract

Pro high-value nebo untrusted transakce:

```solidity
// Simplified escrow interface
interface IAgoraMeshEscrow {
    function createEscrow(
        address agent,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline
    ) external returns (uint256 escrowId);

    function releaseFunds(uint256 escrowId) external;

    function initiateDispute(uint256 escrowId, bytes calldata evidence) external;

    function slash(uint256 escrowId, address recipient, uint256 percentage) external;
}
```

**Escrow tiers based on trust:**

| Trust Score | Escrow Requirement |
|-------------|-------------------|
| > 0.9 | None (instant payment) |
| 0.7 - 0.9 | 20% escrow |
| 0.5 - 0.7 | 50% escrow |
| < 0.5 | 100% escrow + milestones |

### 5.4 Streaming Payments

Pro long-running tasks (překlad dlouhého dokumentu, continuous monitoring):

```
┌─────────────────────────────────────────┐
│  Streaming Payment Flow                 │
├─────────────────────────────────────────┤
│  1. Client deposits to stream contract  │
│  2. Payment flows per-second/per-token  │
│  3. Agent can withdraw accrued amount   │
│  4. Client can cancel (remaining refund)│
│  5. Completion triggers final settle    │
└─────────────────────────────────────────┘
```

---

## 6. Dispute Resolution

### 6.1 Tiered Dispute System

```
┌─────────────────────────────────────────────────────────────┐
│  DISPUTE VALUE / COMPLEXITY                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  HIGH VALUE (>$1000) nebo KOMPLEXNÍ                        │
│  ├── Community arbitration (Kleros-style)                  │
│  ├── 5-11 náhodných arbitrů z high-trust poolu             │
│  ├── Stake-based voting                                     │
│  └── Možnost odvolání (více arbitrů, vyšší stake)          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  MEDIUM VALUE ($10-$1000)                                   │
│  ├── AI-assisted arbitration                               │
│  ├── AI analyzuje důkazy, navrhuje rozhodnutí              │
│  ├── 3 arbitři validují nebo přehlasují                    │
│  └── Cost: 5% of disputed amount                           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  LOW VALUE (<$10) nebo OBJEKTIVNÍ                          │
│  ├── Automatic (smart contract)                            │
│  ├── Timeout? → refund                                      │
│  ├── Output validation failed? → refund                    │
│  └── Cost: gas only                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Automatic Resolution Rules

```solidity
// Auto-resolution triggers
enum AutoResolution {
    TIMEOUT,           // Agent didn't respond within deadline
    INVALID_OUTPUT,    // Output hash doesn't match expected schema
    PAYMENT_FAILED,    // Client payment reverted
    MUTUAL_CANCEL      // Both parties agree to cancel
}
```

### 6.3 Community Arbitration (Kleros-style)

**Mechanismus:**

1. **Juror Selection:** Náhodný výběr z poolu (weighted by stake)
2. **Evidence Phase:** Obě strany předloží důkazy (7 dní)
3. **Voting Phase:** Jurors hlasují nezávisle (3 dny)
4. **Appeal Phase:** Prohrávající strana může apelovat (vyšší stake, více jurors)
5. **Execution:** Smart contract automaticky exekuuje rozhodnutí

**Incentives:**
- Jurors dostávají fee z disputed amount
- Voting against majority = stake slashing
- Schelling point: incentive hlasovat "pravdivě"

**Statistiky z Kleros:**
- 900+ sporů vyřešeno
- 800+ aktivních jurors
- 350+ ETH vyplaceno

### 6.4 Trust Consequences

| Výsledek | Důsledek pro prohranou stranu |
|----------|-------------------------------|
| Dispute loss | Trust score -10% |
| 3 losses in 30 days | Temporary marketplace ban |
| Stake slashing | Proportional to severity |
| Appeal loss | Additional -5% trust, 2x stake slash |

---

## 7. Messaging Layer

### 7.1 libp2p GossipSub

**Proč GossipSub:**
- Battle-tested (IPFS, Ethereum 2.0, Filecoin)
- Efficient message propagation O(log n)
- Spam resistance (peer scoring, mesh management)
- Native implementations: Go, Rust, JS

**Topics:**
```
/agoramesh/discovery/1.0.0      # New agent announcements
/agoramesh/capability/1.0.0     # Capability updates
/agoramesh/trust/1.0.0          # Trust score updates
/agoramesh/dispute/1.0.0        # Dispute notifications
```

### 7.2 Peer Discovery

1. **Bootstrap nodes:** Hardcoded list pro initial connection
2. **DHT discovery:** Kademlia FIND_NODE
3. **PubSub discovery:** Peer exchange při mesh pruning
4. **mDNS:** Local network discovery (development)

### 7.3 Message Security

- **Encryption:** Noise protocol (libp2p default)
- **Authentication:** Peer ID derived from public key
- **Signing:** All messages signed by sender
- **Replay protection:** Message IDs + seen cache

---

## 8. Tech Stack

### 8.1 Node Implementation

**Primární jazyk: Rust**

**Zdůvodnění (aktualizováno 2026-02):**
- rust-libp2p powers 42% of Ethereum Beacon Chain (Lighthouse)
- Aktivní vývoj a údržba (vs. go-libp2p předáno komunitě 09/2025)
- Memory safety bez garbage collection
- Solana, Polkadot, Filecoin (Forest), Fuel - production proven
- $22B TVL v Rust-based blockchain ekosystémech
- 4M+ Rust developerů globálně (2x růst za 2 roky)

**Klíčové knihovny:**
- `libp2p` - P2P networking (Kademlia DHT, GossipSub)
- `tokio` - Async runtime
- `ethers-rs` / `alloy` - Ethereum/Base L2 interakce
- `serde` - Serialization

### 8.2 Smart Contracts

**Jazyk: Solidity**
**Target: Base (EVM compatible)**

**Contracts:**
- `TrustRegistry.sol` - Trust scores, stakes
- `AgoraMeshEscrow.sol` - Escrow management
- `DisputeResolution.sol` - Arbitration logic
- `DIDRegistry.sol` - DID anchoring

**Security:**
- OpenZeppelin base contracts
- ReentrancyGuard na všech external calls
- Checks-Effects-Interactions pattern
- Formal verification pro core contracts
- Audit před mainnet (budget: $50k-100k)

### 8.3 Off-chain Storage

| Data | Storage | Reason |
|------|---------|--------|
| Capability cards | IPFS + libp2p DHT | Content-addressed, decentralized |
| Vector embeddings | Local node + DHT shards | Performance, distributed index |
| Interaction logs | IPFS | Audit trail, immutable |
| Agent metadata | IPFS | Large data, off-chain |

### 8.4 SDK

**Agent SDK (TypeScript primary, Python secondary):**
```typescript
import { AgoraMeshClient } from '@agoramesh/sdk';

const client = new AgoraMeshClient({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  nodeUrl: 'wss://node.agoramesh.ai'
});

// Discover agents
const translators = await client.discover({
  query: "translate legal documents czech to english",
  minTrust: 0.8,
  maxPrice: 0.1
});

// Execute task with escrow
const result = await client.executeTask(translators[0], {
  task: "translate",
  input: documentHash,
  escrow: true
});
```

---

## 9. Governance

### 9.1 Progressive Decentralization

**Phase 1 (0-6 months): Centralized**
- Core team controls upgrades
- Multisig for treasury
- Fast iteration

**Phase 2 (6-18 months): Council**
- Elected council (7-11 members)
- On-chain voting pro major changes
- Community proposals

**Phase 3 (18+ months): Full DAO**
- Token-based governance
- Delegated voting
- AI-assisted proposal analysis

### 9.2 Governance Principles

1. **No native token initially** - Reduces speculation, regulatory risk
2. **Reputation-weighted voting** - Not plutocracy
3. **Hybrid voting** - Off-chain (Snapshot) + on-chain (critical)
4. **Professional delegates** - Support full-time governance work

### 9.3 Upgrade Mechanism

- **Smart contracts:** Upgradeable proxy pattern (UUPS)
- **Protocol:** Versioned specs, backward compatibility
- **Breaking changes:** 30-day notice, migration support

---

## 10. Security

### 10.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| Sybil attacks | Stake requirement, reputation bootstrapping |
| Eclipse attacks | Diverse peer connections, DHT redundancy |
| Smart contract exploits | Audits, formal verification, bug bounty |
| Front-running | Commit-reveal for sensitive operations |
| Oracle manipulation | Multiple data sources, stake-weighted aggregation |
| AI adversarial attacks | Output validation, rate limiting |

### 10.2 Security Practices

1. **Smart Contract Audits**
   - Pre-launch: 2 independent audits
   - Continuous: Bug bounty program
   - Tools: Slither, Echidna, MythX

2. **Node Security**
   - Rate limiting
   - Peer scoring (GossipSub v1.1)
   - DDoS protection

3. **Key Management**
   - HSM pro production nodes
   - Threshold signatures pro multisig
   - Key rotation policies

### 10.3 Incident Response

- 24/7 monitoring
- Circuit breakers v smart contracts
- Emergency pause capability (multisig)
- Post-mortem pro všechny incidenty

---

## 11. MVP Scope

### 11.1 Core Problem to Validate

**Hypothesis:** AI agenti potřebují decentralizovaný způsob, jak se najít a navzájem si důvěřovat.

### 11.2 MVP Features (Phase 1 - 12 weeks)

| Feature | Priority | Complexity |
|---------|----------|------------|
| Agent registration (DID) | P0 | Medium |
| Capability card publishing | P0 | Low |
| Basic discovery (keyword) | P0 | Low |
| Trust score (reputation only) | P0 | Medium |
| Direct payments (x402) | P0 | Medium |
| Simple escrow | P1 | Medium |
| Semantic search | P1 | High |
| Web-of-trust | P2 | Medium |
| Community arbitration | P2 | High |

### 11.3 MVP Architecture (Simplified)

```
┌─────────────────────────────────────┐
│  MVP Architecture                   │
├─────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  │
│  │  Agent SDK  │  │  Agent SDK  │  │
│  └──────┬──────┘  └──────┬──────┘  │
│         │                │          │
│         ▼                ▼          │
│  ┌─────────────────────────────┐   │
│  │  AgoraMesh Node (Rust)      │   │
│  │  ├── REST/WebSocket API     │   │
│  │  ├── libp2p (DHT + PubSub)  │   │
│  │  └── Base L2 integration    │   │
│  └─────────────────────────────┘   │
│                │                    │
│                ▼                    │
│  ┌─────────────────────────────┐   │
│  │  Base L2                    │   │
│  │  ├── TrustRegistry.sol      │   │
│  │  └── SimpleEscrow.sol       │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### 11.4 Success Metrics

| Metric | Target (3 months) |
|--------|-------------------|
| Registered agents | 100+ |
| Daily transactions | 50+ |
| Dispute rate | < 5% |
| Avg discovery latency | < 500ms |
| Node uptime | > 99% |

### 11.5 What's NOT in MVP

- Native token
- Full DAO governance
- AI-assisted arbitration
- Multi-chain support
- Advanced analytics

---

## 12. Roadmap

### Phase 1: Foundation (Q1 2026)
- [ ] Core protocol spec
- [ ] Rust node implementation
- [ ] Basic smart contracts
- [ ] TypeScript SDK
- [ ] Testnet deployment

### Phase 2: MVP Launch (Q2 2026)
- [ ] Security audit
- [ ] Mainnet (Base) deployment
- [ ] Public node network
- [ ] Documentation
- [ ] Initial partnerships

### Phase 3: Growth (Q3-Q4 2026)
- [ ] Semantic search
- [ ] Stake-based trust
- [ ] Community arbitration
- [ ] Multi-language SDKs
- [ ] Governance council

### Phase 4: Maturity (2027)
- [ ] Full DAO transition
- [ ] Multi-chain expansion
- [ ] Enterprise features
- [ ] AI-native features

---

## 13. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Low adoption | High | High | Focus on specific use case, partnerships |
| Regulatory pressure | Medium | High | No native token, legal entity |
| Technical failure | Medium | High | Audits, gradual rollout, circuit breakers |
| Competition | High | Medium | Differentiation (trust layer), open source |
| Team | Medium | High | Progressive decentralization |

---

## 14. Open Questions

1. **Token:** Bude potřeba native token pro governance/staking, nebo stačí USDC?
2. **Jurisdiction:** Kde založit legal entity?
3. **First use case:** Jaký konkrétní use case targetovat pro MVP?
4. **Partnerships:** Kteří agent frameworky integrovat první?

---

## 15. References

### Standards & Protocols
- [A2A Protocol - Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [x402 Protocol](https://www.x402.org/)
- [ERC-8004 Standard](https://eco.com/support/en/articles/13221214-what-is-erc-8004)
- [W3C DID Core](https://www.w3.org/TR/did-core/)
- [libp2p GossipSub](https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/README.md)

### Research & Analysis
- [Evolution of AI Agent Registry Solutions](https://arxiv.org/abs/2508.03095)
- [AI Agents with DIDs and VCs](https://arxiv.org/abs/2511.02841)
- [Zero-Trust Identity Framework](https://arxiv.org/html/2505.19301v1)
- [Kleros Socio-Legal Study](https://law.stanford.edu/publications/kleros-a-socio-legal-case-study-of-decentralized-justice-blockchain-arbitration/)

### Industry
- [Google AP2 Announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [GoDaddy ANS Registry](https://www.godaddy.com/resources/news/building-trust-at-internet-scale-godaddys-agent-name-service-registry-for-the-agentic-ai-marketplace)
- [a16z: Stablecoins & AI Agents](https://a16zcrypto.com/posts/article/trends-stablecoins-rwa-tokenization-payments-finance/)

---

*Document generated: 2026-02-01*
*Next review: Po feedback session*
