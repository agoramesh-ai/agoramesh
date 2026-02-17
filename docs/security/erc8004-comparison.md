# ERC-8004 Comparison: Mantle Deployment vs AgentMe Implementation

> Last updated: 2026-02-17

## 1. Mantle ERC-8004 Deployment Summary

**Date:** 2026-02-16 (announced via PRNewswire)

**What they deployed:** The official ERC-8004 reference contracts from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts). These are the same singleton contracts deployed across 15+ chains (Ethereum, Base, Arbitrum, Optimism, etc.) using deterministic CREATE2 addresses.

**Contract Addresses on Mantle Mainnet (WIP):**
| Contract | Address |
|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ValidationRegistry | Not listed yet (WIP) |

**Authors:** Marco De Rossi (MetaMask), Davide Crapis (EF), Jordan Ellis (Google), Erik Reppel (Coinbase)

**Architecture:** Three separate UUPS-upgradeable singleton contracts:

### 1.1 IdentityRegistryUpgradeable
- ERC-721 + URIStorage (each agent = NFT)
- Arbitrary key-value metadata (`setMetadata` / `getMetadata`)
- Reserved `agentWallet` key — separate from NFT owner (agent's operational wallet)
- EIP-712 signed `setAgentWallet` with ERC-1271 smart wallet support
- Multiple `register()` overloads: no-arg, with URI, with URI + batch metadata
- Ownable + UUPS upgradeable
- **No staking, no reputation** — pure identity

### 1.2 ReputationRegistryUpgradeable
- Per-client, per-agent feedback entries (1-indexed)
- Signed int128 values with configurable decimals (supports negative feedback)
- Tag-based categorization (tag1, tag2)
- Feedback URI + hash for off-chain detail with on-chain integrity
- `revokeFeedback()` by original submitter
- `appendResponse()` — anyone can respond to feedback (dispute/context)
- Anti-sybil: self-feedback blocked (`isAuthorizedOrOwner` check)
- Client tracking for enumeration
- **No aggregation on-chain** — `getSummary` not implemented in contract (event-based off-chain)

### 1.3 ValidationRegistryUpgradeable
- Request/response model: agent owner requests validation, validator responds
- Response codes 0-100 (not just binary valid/invalid)
- Tag-based filtering
- On-chain `getSummary` with validator + tag filters
- Per-agent and per-validator request tracking

---

## 2. AgentMe Implementation

### Core Contracts

| Contract | Description |
|---|---|
| **TrustRegistry.sol** | Monolithic: registration + reputation + staking + endorsements |
| **NFTBoundReputation.sol** | Token-bound reputation (bound to AgentToken NFTs) |
| **AgentToken.sol** | ERC-721 agent identity |
| **ERC8004Adapter.sol** | Read-only adapter exposing ERC-8004 interfaces |
| **TieredDisputeResolution.sol** | 3-tier dispute system (auto / AI / community) |
| **CrossChainTrustSync.sol** | LayerZero-based cross-chain trust score sync |
| **StreamingPayments.sol** | Payment streaming for agent services |
| **VerifiedNamespaces.sol** | DNS-like namespace verification |

### Key Design Choices
- **DID-hash based** identity (bytes32) vs ERC-8004's uint256 token ID
- **Monolithic TrustRegistry** with composite trust score (50% reputation + 30% stake + 20% endorsements)
- **USDC staking** with 7-day cooldown, $100 minimum, slashing by ARBITER_ROLE
- **Oracle-recorded** transactions (not permissionless feedback)
- **Endorsement system** (peer-to-peer, max 10 per agent, quality-weighted)
- **Non-upgradeable** contracts (immutable deployment)

---

## 3. Feature Comparison

| Feature | ERC-8004 (Mantle) | AgentMe |
|---|---|---|
| **Identity** | ERC-721 + URIStorage, UUPS upgradeable | ERC-721 (AgentToken) + TrustRegistry, non-upgradeable |
| **Identity Metadata** | Arbitrary key-value (flexible) | Fixed struct (didHash, capabilityCID, registeredAt, isActive) |
| **Agent Wallet** | Separate from NFT owner, EIP-712 signed | Owner = wallet (no separation) |
| **Smart Wallet Support** | ERC-1271 `isValidSignature` | ❌ Not implemented |
| **Registration** | Permissionless, multiple overloads | Permissionless, single function |
| **Reputation Model** | Per-client feedback entries, signed values | Oracle-recorded aggregate (success rate + volume + tx count) |
| **Negative Feedback** | ✅ Signed int128 | ❌ Binary success/fail only |
| **Feedback Tags** | ✅ tag1 + tag2 categorization | ❌ No categorization |
| **Feedback Revocation** | ✅ By original submitter | ❌ Not applicable (oracle model) |
| **Feedback Response** | ✅ appendResponse() by anyone | ❌ Not applicable |
| **Self-Feedback Prevention** | ✅ isAuthorizedOrOwner check | N/A (oracle controls recording) |
| **Staking** | ❌ Not in standard | ✅ USDC staking, $100 min, 7-day cooldown, slashing |
| **Endorsements** | ❌ Not in standard | ✅ Peer-to-peer, max 10, quality-weighted |
| **Composite Trust Score** | ❌ No on-chain scoring | ✅ Weighted: 50% rep + 30% stake + 20% endorsements |
| **Validation** | Full request/response model with validators | ❌ Mapped via adapter (stub responses) |
| **Dispute Resolution** | ❌ Not in standard | ✅ 3-tier (auto <$10, AI $10-$1k, community >$1k) |
| **Cross-Chain** | Same addresses on all chains (CREATE2) | ✅ LayerZero-based trust score sync |
| **Upgradeability** | UUPS proxy pattern | Non-upgradeable (immutable) |
| **Payments** | ❌ Not in standard | ✅ StreamingPayments, escrow |
| **Namespaces** | ❌ Not in standard | ✅ VerifiedNamespaces (DNS-like) |
| **ERC-8004 Compatibility** | ✅ Native | ✅ Via read-only ERC8004Adapter |

---

## 4. Key Differences Analysis

### 4.1 Philosophy
- **ERC-8004:** Minimal, modular singletons. Identity, Reputation, Validation are cleanly separated. No economic mechanisms on-chain — designed as a coordination/discovery layer.
- **AgentMe:** Opinionated, feature-rich. Integrates economic incentives (staking, slashing, escrow, payments) directly into the trust layer. More of a "full stack" for agent economy.

### 4.2 Reputation: Permissionless vs Oracle
- **ERC-8004:** Anyone can submit feedback (with anti-sybil via owner check). Rich structured feedback with tags, URIs, revocation, and responses. Decentralized.
- **AgentMe:** Only ORACLE_ROLE can record transactions. Simpler (success rate + volume), but centralized trust assumption on the oracle.

### 4.3 What ERC-8004 Has That We Don't
1. **Arbitrary metadata** — flexible key-value vs our fixed struct
2. **Agent wallet separation** — operational wallet ≠ owner (important for account abstraction)
3. **EIP-712 + ERC-1271** — gasless wallet assignment with smart wallet support
4. **Rich feedback model** — signed values, tags, URIs, revocation, responses
5. **Real Validation Registry** — request/response with actual validator workflow
6. **UUPS upgradeability** — can fix bugs, evolve protocol

### 4.4 What We Have That ERC-8004 Doesn't
1. **Economic staking** — skin in the game ($100-$10k USDC)
2. **Slashing mechanism** — punish bad actors, with arbiter role
3. **Endorsement system** — social proof weighted by endorser quality
4. **Composite trust score** — single queryable number combining all signals
5. **Dispute resolution** — automated 3-tier system
6. **Cross-chain trust sync** — LayerZero bridge for trust scores
7. **Streaming payments + escrow** — full payment infrastructure
8. **Verified namespaces** — domain-verified agent identity

---

## 5. Our ERC8004Adapter Assessment

The `ERC8004Adapter.sol` provides **read-only compatibility** but has significant gaps:

| Interface | Implementation Status |
|---|---|
| Identity: `register()` | ❌ Reverts (ReadOnlyAdapter) |
| Identity: `getMetadata()` | ✅ Maps 4 keys (didHash, capabilityCID, registeredAt, isActive) |
| Identity: `getAgentWallet()` | ✅ Returns token owner |
| Reputation: `getSummary()` | ⚠️ Returns aggregate score, ignores client/tag filters |
| Reputation: `readFeedback()` | ❌ Returns zeros (no per-client feedback) |
| Reputation: `getClients()` | ❌ Returns empty array |
| Validation: `getValidationStatus()` | ❌ Returns zeros (stub) |
| Validation: `getSummary()` | ⚠️ Maps trust score to binary valid/invalid |
| Validation: `getAgentValidations()` | ❌ Returns empty array |

**Verdict:** The adapter allows basic discovery (identity + aggregate reputation) but cannot participate in the ERC-8004 feedback/validation ecosystem. Agents registered only in AgentMe are invisible to ERC-8004 clients expecting `giveFeedback()` or `validationRequest()` flows.

---

## 6. Recommendations

### Immediate (Compatibility)
1. **Dual registration** — register agents in both AgentMe and the canonical ERC-8004 IdentityRegistry on target chains
2. **Implement `giveFeedback` relay** — accept ERC-8004 feedback events and relay to our reputation system
3. **Add agent wallet separation** — support operational wallets distinct from owner

### Medium-term (Feature Parity)
4. **Add arbitrary metadata** support to AgentToken
5. **Implement real ValidationRegistry integration** — allow external validators to attest our agents
6. **Add ERC-1271 support** for smart wallet compatibility

### Strategic (Differentiation)
7. **Keep staking + slashing** — this is our moat. ERC-8004 has no economic security
8. **Keep composite trust score** — useful for quick trust decisions
9. **Position as "ERC-8004 + economic security"** — standard-compatible but with added guarantees
10. **Consider UUPS upgradeability** for future contracts — immutable is safer but limits evolution

---

## 7. Market Context

Mantle's deployment (2026-02-16) is part of a wave — BNB Chain deployed ERC-8004 on 2026-02-04. The standard is being adopted as the de facto agent identity/reputation layer across EVM chains. Our ERC8004Adapter gives us partial compatibility, but **full interoperability requires native participation in the ERC-8004 registries**, not just a read-only wrapper.

The reference contracts use **deterministic CREATE2 addresses** across all chains (`0x8004A169...` for Identity, `0x8004BAa1...` for Reputation), making cross-chain agent discovery trivial. This is a significant network effect advantage we should plug into rather than compete against.
