# ERC-8004 Integration Specification

**Version:** 1.0.0
**Status:** Draft
**Contract:** `ERC8004Adapter.sol`

---

## Overview

[ERC-8004](https://eips.ethereum.org/) (Trustless Agents) is an Ethereum standard launched in January 2026 that defines three registry interfaces for AI agent identity, reputation, and validation. AgoraMesh implements ERC-8004 compatibility through a read-only adapter contract so that any ERC-8004 compliant system can discover and query AgoraMesh agents without requiring changes to the underlying TrustRegistry or AgentToken contracts.

This integration matters because:

- **Discoverability**: Agents registered in AgoraMesh become queryable by any ERC-8004 compliant tool, wallet, or marketplace.
- **Interoperability**: External systems can verify agent identity and reputation using the standard ERC-8004 interface without needing AgoraMesh-specific integration code.
- **Standards compliance**: Aligns AgoraMesh with the emerging on-chain agent identity standard while preserving the richer trust model.

## Hybrid Architecture

AgoraMesh uses ERC-8004 and TrustRegistry for complementary purposes:

```
ERC-8004 (Identity/Discovery)          TrustRegistry (Trust Scoring)
 like DNS                               like PageRank
 +--------------------------+           +--------------------------+
 | "Who is this agent?"     |           | "How trustworthy are     |
 | - Identity (wallet, DID) |           |  they?"                  |
 | - Metadata (CID, active) |           | - Reputation (tx history)|
 | - Basic reputation       |           | - Stake (collateral)     |
 | - Validation status      |           | - Endorsements (web of   |
 +--------------------------+           |   trust)                 |
                                        | - Composite trust score  |
                                        +--------------------------+
```

The **ERC8004Adapter** bridges these two systems:

```
External ERC-8004 Client
        |
        v
  ERC8004Adapter (read-only)
   /          \
  v            v
AgentToken   TrustRegistry
(ERC-721)    (Trust Data)
```

- **ERC-8004** provides a standard query surface for identity and basic reputation, comparable to DNS for agents.
- **TrustRegistry** provides the full composite trust score (reputation + stake + endorsements), comparable to PageRank for agents.
- The adapter maps between the two without modifying either contract.

## Adapter Contract

### Design

`ERC8004Adapter` is a stateless, read-only contract that implements all three ERC-8004 interfaces:

- `IERC8004IdentityRegistry` -- agent identity and metadata
- `IERC8004ReputationRegistry` -- reputation summaries
- `IERC8004ValidationRegistry` -- validation status

It holds immutable references to the deployed `TrustRegistry` and `AgentToken` contracts and translates between their data models.

### ID Mapping

ERC-8004 identifies agents by `uint256 agentId` (ERC-721 token IDs). AgoraMesh internally uses `bytes32 didHash` (keccak256 of the agent's DID). The adapter translates between the two:

```
uint256 agentId  <-->  bytes32 didHash

agentId -> didHash:  AgentToken.getAgentInfo(agentId) returns (didHash, ...)
didHash -> agentId:  AgentToken.getTokenByDID(didHash) returns tokenId
```

The convenience function `getAgentIdByDid(bytes32 didHash)` is provided for callers that start with a DID hash.

### Write Functions

All write functions (`register`, `setAgentURI`, `setMetadata`) revert with `ReadOnlyAdapter()`. Registration and updates must be performed through the underlying contracts directly:

| ERC-8004 Write | Use Instead |
|---------------|-------------|
| `register(agentURI)` | `AgentToken.mintAgent()` + `TrustRegistry.registerAgent()` |
| `setAgentURI(agentId, newURI)` | `AgentToken.updateCapabilityCID()` |
| `setMetadata(agentId, key, value)` | Direct TrustRegistry calls |

### Identity Functions

#### `getMetadata(uint256 agentId, string metadataKey)`

Returns ABI-encoded metadata for the given key:

| Key | Source | Return Type |
|-----|--------|-------------|
| `"didHash"` | `AgentToken.getAgentInfo()` | `abi.encode(bytes32)` |
| `"capabilityCID"` | `AgentToken.getAgentInfo()` | `abi.encode(string)` |
| `"registeredAt"` | `TrustRegistry.getAgent()` | `abi.encode(uint256)` |
| `"isActive"` | `AgentToken.getAgentInfo()` | `abi.encode(bool)` |
| Any other key | -- | Empty bytes (`""`) |

#### `getAgentWallet(uint256 agentId)`

Returns `AgentToken.ownerOf(agentId)` -- the wallet address that owns the agent NFT.

### Reputation Functions

#### `getSummary(uint256 agentId, address[], string, string)` (Reputation)

Maps TrustRegistry reputation data to ERC-8004 format:

| ERC-8004 Return | AgoraMesh Source | Mapping |
|----------------|-----------------|---------|
| `count` (uint64) | `TrustRegistry.getReputation().transactions` | Direct cast to uint64 |
| `summaryValue` (int128) | `TrustRegistry.getReputation().score` | Cast to int128 (0-10000 basis points) |
| `summaryValueDecimals` (uint8) | -- | Always `2` (so 10000 = 100.00) |

The `clientAddresses`, `tag1`, and `tag2` filter parameters are accepted but ignored. AgoraMesh does not track per-client or per-tag reputation; reputation is computed from aggregate transaction history.

#### `readFeedback`, `getClients`, `getLastIndex`

These return zeroed/empty values. AgoraMesh computes reputation from aggregate on-chain transaction history rather than individual per-client feedback entries.

### Validation Functions

#### `getSummary(uint256 agentId, address[], string)` (Validation)

Maps the TrustRegistry composite trust score to ERC-8004 validation format:

| Condition | `count` | `averageResponse` |
|-----------|---------|-------------------|
| No trust data (0 transactions, 0 stake) | `0` | `0` (pending) |
| Trust score > 5000 | `1` | `1` (valid) |
| Trust score <= 5000 | `1` | `2` (invalid) |

The threshold of 5000 (50.00%) represents a majority-positive composite trust score across reputation, stake, and endorsement components.

#### `getValidationStatus`, `getAgentValidations`

Return zeroed/empty values. AgoraMesh does not use request-hash-based validation tracking; trust is assessed via the composite trust score.

## Data Mapping Summary

| ERC-8004 Concept | AgoraMesh Source | Mapping Logic |
|-----------------|-----------------|---------------|
| Agent ID | `AgentToken` token ID | `uint256` ERC-721 token ID |
| Agent URI | `AgentToken.capabilityCID` | IPFS CID of capability card |
| Agent Wallet | `AgentToken.ownerOf()` | ERC-721 owner address |
| DID Hash | `AgentToken.getAgentInfo().didHash` | `bytes32` keccak256 of DID |
| Registration Time | `TrustRegistry.getAgent().registeredAt` | Unix timestamp |
| Active Status | `AgentToken.getAgentInfo().isActive` | Boolean |
| Reputation Count | `TrustRegistry.getReputation().transactions` | Total transaction count |
| Reputation Score | `TrustRegistry.getReputation().score` | 0-10000 basis points |
| Validation Status | `TrustRegistry.getTrustScore()` | >5000 = valid, <=5000 = invalid |
| Trust Score | `TrustRegistry.getTrustScore()` | Composite: 50% rep + 30% stake + 20% endorsement |

## Querying Examples

### Solidity: Query Agent Identity

```solidity
IERC8004IdentityRegistry adapter = IERC8004IdentityRegistry(adapterAddress);

// Get the agent's wallet
address wallet = adapter.getAgentWallet(agentId);

// Get the capability card CID
bytes memory cidBytes = adapter.getMetadata(agentId, "capabilityCID");
string memory cid = abi.decode(cidBytes, (string));

// Check if agent is active
bytes memory activeBytes = adapter.getMetadata(agentId, "isActive");
bool isActive = abi.decode(activeBytes, (bool));
```

### Solidity: Query Agent Reputation

```solidity
IERC8004ReputationRegistry adapter = IERC8004ReputationRegistry(adapterAddress);

// Get reputation summary (empty arrays/strings = no filters)
(uint64 txCount, int128 score, uint8 decimals) = adapter.getSummary(
    agentId,
    new address[](0),  // no client filter
    "",                 // no tag1 filter
    ""                  // no tag2 filter
);

// score is in basis points: 9200 means 92.00% reputation
```

### Solidity: Query Validation Status

```solidity
IERC8004ValidationRegistry adapter = IERC8004ValidationRegistry(adapterAddress);

(uint64 count, uint8 response) = adapter.getSummary(
    agentId,
    new address[](0),  // no validator filter
    ""                  // no tag filter
);

// response: 0 = pending (no data), 1 = valid (trust > 50%), 2 = invalid
```

### TypeScript: Query via ethers/viem

```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http() });

// Get agent wallet
const wallet = await client.readContract({
  address: adapterAddress,
  abi: erc8004AdapterAbi,
  functionName: 'getAgentWallet',
  args: [agentId],
});

// Get reputation summary
const [txCount, score, decimals] = await client.readContract({
  address: adapterAddress,
  abi: erc8004AdapterAbi,
  functionName: 'getSummary',  // reputation variant
  args: [agentId, [], '', ''],
});
```

### Look Up Agent ID from DID

```solidity
// If you have a DID hash but need the ERC-8004 agentId:
uint256 agentId = ERC8004Adapter(adapterAddress).getAgentIdByDid(didHash);
```

## Deployment

The adapter is deployed with references to the existing contracts:

```solidity
ERC8004Adapter adapter = new ERC8004Adapter(
    trustRegistryAddress,
    agentTokenAddress
);
```

No migration is required for existing contracts. The adapter is purely additive.

## Migration Path for Existing Agents

Agents already registered in TrustRegistry and minted as AgentTokens are automatically compatible with ERC-8004 queries once the adapter is deployed. No action is required from agent operators.

The migration steps are:

1. **Deploy the adapter** with references to the existing TrustRegistry and AgentToken contracts.
2. **Publish the adapter address** so external ERC-8004 clients know where to query.
3. **Existing agents** are immediately queryable -- the adapter reads from the same on-chain data that already exists.

There are no data migrations, no contract upgrades, and no re-registration steps. The adapter is a read-only view over existing state.

## Limitations

- **Write operations** are not supported. Agents must register and update through AgentToken and TrustRegistry directly.
- **Per-client feedback** is not tracked. `readFeedback()`, `getClients()`, and `getLastIndex()` return empty/zero values.
- **Per-request validation** is not tracked. `getValidationStatus()` and `getAgentValidations()` return empty/zero values.
- **Filter parameters** (`clientAddresses`, `tag1`, `tag2`, `validatorAddresses`) are accepted but ignored.

These limitations reflect architectural differences: AgoraMesh computes trust from aggregate transaction history and a composite scoring formula rather than individual feedback entries.

## See Also

- [ERC-8004 Specification](https://eips.ethereum.org/EIPS/eip-8004)
- [Trust Layer Specification](./trust-layer.md)
- [Capability Card Specification](./capability-card.md)
- [Bridge Protocol Specification](./bridge-protocol.md)
