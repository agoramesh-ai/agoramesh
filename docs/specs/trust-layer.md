# AgentMe Trust Layer Specification

**Version:** 1.0.0
**Status:** Draft
**ERC-8004 Compatible:** Yes

---

## Overview

The Trust Layer provides a decentralized reputation and verification system for AI agents. It implements a 3-tier trust model that combines on-chain reputation, economic stake, and social endorsements.

## Trust Tiers

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: Web-of-Trust                                       │
│  ├── Transitive trust from endorsements                     │
│  ├── Decay: 10% per hop (max 3 hops)                        │
│  └── Use: Accelerated onboarding, referrals                 │
├─────────────────────────────────────────────────────────────┤
│  Tier 2: Stake                                              │
│  ├── Locked collateral (USDC)                               │
│  ├── Slashing on dispute loss                               │
│  └── Use: High-value transactions, unknown parties          │
├─────────────────────────────────────────────────────────────┤
│  Tier 1: Reputation                                         │
│  ├── On-chain transaction history                           │
│  ├── Decay: 5% per 14 days of inactivity                    │
│  └── Use: Baseline trust, low-value transactions            │
└─────────────────────────────────────────────────────────────┘
```

## Trust Score Calculation

### Formula

```
trust_score = w1 × reputation + w2 × stake_factor + w3 × endorsement_score

Where:
  w1 = 0.50 (reputation weight)
  w2 = 0.30 (stake weight)
  w3 = 0.20 (endorsement weight)
```

### Reputation Component

```python
def calculate_reputation(agent):
    if agent.total_transactions == 0:
        return 0.0

    # Base success rate
    success_rate = agent.successful_transactions / agent.total_transactions

    # Volume weighting (log scale)
    volume_factor = min(1.0, log10(agent.total_volume_usd + 1) / 6)  # Cap at $1M

    # Recency weighting
    days_since_last = (now() - agent.last_transaction).days
    recency_factor = max(0.0, 1.0 - (days_since_last * 0.05 / 14))

    # Dispute penalty
    dispute_factor = 1.0 - (agent.disputes_lost * 0.1)

    return success_rate * volume_factor * recency_factor * dispute_factor
```

### Stake Factor

```python
def calculate_stake_factor(agent):
    REFERENCE_STAKE = 10000  # $10,000 USDC

    if agent.stake_amount == 0:
        return 0.0

    # Diminishing returns above reference
    raw_factor = agent.stake_amount / REFERENCE_STAKE
    return min(1.0, sqrt(raw_factor))
```

### Endorsement Score

```python
def calculate_endorsement_score(agent, trust_graph):
    MAX_HOPS = 3
    DECAY_PER_HOP = 0.10

    total_trust = 0.0

    for endorsement in agent.endorsements:
        endorser = trust_graph.get(endorsement.endorser_did)
        if endorser is None:
            continue

        # Calculate hop distance from high-trust roots
        hop_distance = trust_graph.shortest_path_to_root(endorser)
        if hop_distance > MAX_HOPS:
            continue

        decay = (1 - DECAY_PER_HOP) ** hop_distance
        contribution = endorser.trust_score * decay
        total_trust += contribution

    # Normalize to 0-1 range
    return min(1.0, total_trust / 3.0)
```

## Smart Contracts

### Trust Registry Interface (ERC-8004 Compatible)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IAgentMeTrustRegistry {

    // ========== Events ==========

    event AgentRegistered(bytes32 indexed didHash, address indexed owner);
    event ReputationUpdated(bytes32 indexed didHash, uint256 newScore, uint256 totalTransactions);
    event StakeDeposited(bytes32 indexed didHash, uint256 amount);
    event StakeWithdrawn(bytes32 indexed didHash, uint256 amount);
    event StakeSlashed(bytes32 indexed didHash, uint256 amount, bytes32 reason);
    event EndorsementAdded(bytes32 indexed endorser, bytes32 indexed endorsee);
    event EndorsementRevoked(bytes32 indexed endorser, bytes32 indexed endorsee);

    // ========== Structs ==========

    struct AgentTrust {
        bytes32 didHash;
        address owner;
        uint256 reputationScore;      // 0-10000 (divide by 100 for 0.00-100.00)
        uint256 totalTransactions;
        uint256 successfulTransactions;
        uint256 totalVolumeUsd;       // In cents
        uint256 lastActivityTimestamp;
        uint256 stakedAmount;         // In USDC (6 decimals)
        uint256 stakeUnlockTime;
        bool isActive;
    }

    struct Endorsement {
        bytes32 endorserDid;
        bytes32 endorseeDid;
        uint256 timestamp;
        string message;
        bool isActive;
    }

    // ========== Registration ==========

    function registerAgent(
        bytes32 didHash,
        string calldata capabilityCardCID
    ) external returns (bool);

    function updateCapabilityCard(
        bytes32 didHash,
        string calldata newCID
    ) external returns (bool);

    // ========== Reputation ==========

    function recordTransaction(
        bytes32 agentDid,
        uint256 volumeUsd,
        bool successful
    ) external returns (bool);

    function getReputation(
        bytes32 didHash
    ) external view returns (uint256 score, uint256 transactions, uint256 successRate);

    // ========== Staking ==========

    function depositStake(
        bytes32 didHash,
        uint256 amount
    ) external returns (bool);

    function requestWithdraw(
        bytes32 didHash,
        uint256 amount
    ) external returns (uint256 unlockTime);

    function executeWithdraw(
        bytes32 didHash
    ) external returns (uint256 withdrawnAmount);

    function slash(
        bytes32 didHash,
        uint256 amount,
        bytes32 disputeId
    ) external returns (bool);

    // ========== Endorsements ==========

    function endorse(
        bytes32 endorseeDid,
        string calldata message
    ) external returns (bool);

    function revokeEndorsement(
        bytes32 endorseeDid
    ) external returns (bool);

    function getEndorsements(
        bytes32 didHash
    ) external view returns (Endorsement[] memory);

    // ========== Trust Score ==========

    function getTrustScore(
        bytes32 didHash
    ) external view returns (uint256 compositeScore);

    function getTrustDetails(
        bytes32 didHash
    ) external view returns (
        uint256 reputationScore,
        uint256 stakeScore,
        uint256 endorsementScore,
        uint256 compositeScore
    );
}
```

### Implementation Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract AgentMeTrustRegistry is IAgentMeTrustRegistry, ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant DISPUTE_ROLE = keccak256("DISPUTE_ROLE");

    IERC20 public immutable usdc;

    uint256 public constant STAKE_COOLDOWN = 7 days;
    uint256 public constant REFERENCE_STAKE = 10000 * 1e6; // 10,000 USDC
    uint256 public constant REPUTATION_DECAY_PERIOD = 14 days;
    uint256 public constant REPUTATION_DECAY_RATE = 500; // 5% in basis points

    mapping(bytes32 => AgentTrust) public agents;
    mapping(bytes32 => mapping(bytes32 => Endorsement)) public endorsements;
    mapping(bytes32 => bytes32[]) public endorserList;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function depositStake(
        bytes32 didHash,
        uint256 amount
    ) external nonReentrant returns (bool) {
        require(agents[didHash].owner == msg.sender, "Not agent owner");
        require(amount > 0, "Amount must be positive");

        // Transfer USDC to contract
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Update stake
        agents[didHash].stakedAmount += amount;
        agents[didHash].stakeUnlockTime = 0; // Reset unlock timer

        emit StakeDeposited(didHash, amount);
        return true;
    }

    function slash(
        bytes32 didHash,
        uint256 amount,
        bytes32 disputeId
    ) external onlyRole(DISPUTE_ROLE) nonReentrant returns (bool) {
        AgentTrust storage agent = agents[didHash];
        require(agent.stakedAmount >= amount, "Insufficient stake");

        agent.stakedAmount -= amount;

        // Transfer slashed amount to dispute resolution contract
        usdc.safeTransfer(msg.sender, amount);

        emit StakeSlashed(didHash, amount, disputeId);
        return true;
    }

    function getTrustScore(bytes32 didHash) external view returns (uint256) {
        AgentTrust storage agent = agents[didHash];

        // Calculate reputation (0-10000)
        uint256 repScore = _calculateReputation(agent);

        // Calculate stake factor (0-10000)
        uint256 stakeScore = _calculateStakeFactor(agent.stakedAmount);

        // Calculate endorsement score (0-10000)
        uint256 endorseScore = _calculateEndorsementScore(didHash);

        // Weighted average
        return (repScore * 50 + stakeScore * 30 + endorseScore * 20) / 100;
    }

    function _calculateReputation(AgentTrust storage agent) internal view returns (uint256) {
        if (agent.totalTransactions == 0) return 0;

        uint256 successRate = (agent.successfulTransactions * 10000) / agent.totalTransactions;

        // Apply decay
        uint256 daysSinceActivity = (block.timestamp - agent.lastActivityTimestamp) / 1 days;
        uint256 decayPeriods = daysSinceActivity / 14;

        for (uint256 i = 0; i < decayPeriods && successRate > 0; i++) {
            successRate = successRate * (10000 - REPUTATION_DECAY_RATE) / 10000;
        }

        return successRate;
    }

    function _calculateStakeFactor(uint256 stakedAmount) internal pure returns (uint256) {
        if (stakedAmount == 0) return 0;
        if (stakedAmount >= REFERENCE_STAKE) return 10000;

        // Linear scaling up to reference stake
        return (stakedAmount * 10000) / REFERENCE_STAKE;
    }

    function _calculateEndorsementScore(bytes32 didHash) internal view returns (uint256) {
        bytes32[] storage endorsers = endorserList[didHash];
        if (endorsers.length == 0) return 0;

        uint256 totalScore = 0;

        for (uint256 i = 0; i < endorsers.length && i < 10; i++) {
            Endorsement storage e = endorsements[endorsers[i]][didHash];
            if (!e.isActive) continue;

            // Get endorser's trust score (simplified - no recursion)
            AgentTrust storage endorser = agents[e.endorserDid];
            uint256 endorserRep = _calculateReputation(endorser);

            totalScore += endorserRep / 10; // 10% weight per endorser
        }

        return totalScore > 10000 ? 10000 : totalScore;
    }
}
```

## Real-World Comparisons

| System | Mechanism | Lessons for AgentMe |
|--------|-----------|----------------------|
| **Kleros** | PNK staking + Schelling voting | Stake-to-participate works; 80%+ juror coherence |
| **Cred Protocol** | Endorsement staking + slashing | Endorsers with "skin in game" improve trust signals |
| **Gitcoin Passport** | Multi-proof aggregation | Combining proofs creates robust Sybil resistance |
| **EigenLayer** | Restaking + slashing conditions | Slashing conditions must be objectively verifiable |

## Parameters

### Reputation

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Decay period | 14 days | Balances freshness vs stability |
| Decay rate | 5% per period | Gradual, allows recovery |
| Volume cap | $1M | Diminishing returns above |
| Dispute penalty | -10% per loss | Significant but recoverable |

### Stake

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Reference stake | $10,000 USDC | Meaningful commitment |
| Cooldown period | 7 days | Prevents hit-and-run |
| Slash rate | Variable (10-100%) | Proportional to severity |
| Minimum stake | $100 USDC | Low barrier to entry |

### Endorsements

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max hops | 3 | Beyond 3, trust is too diluted |
| Decay per hop | 10% | Reflects trust attenuation |
| Max endorsements counted | 10 | Prevent gaming via mass endorsements |
| Endorsement cooldown | 24 hours | Prevent rapid endorsement spam |

## See Also

- [ERC-8004 Specification](https://eips.ethereum.org/)
- [Kleros Documentation](https://kleros.io/docs/)
- [Dispute Resolution Spec](./dispute-resolution.md)
