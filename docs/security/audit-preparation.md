# AgentMe Smart Contract Security Audit Preparation

**Date:** 2026-02-02
**Auditor:** Security Audit Preparation Team
**Contracts Version:** Solidity ^0.8.24
**Network:** Base L2 (Mainnet & Sepolia Testnet)

---

## Executive Summary

This document provides a comprehensive security analysis of the AgentMe smart contract suite in preparation for a formal security audit. The contracts implement a decentralized marketplace and trust layer for AI agents, including agent registration, reputation management, escrow payments, streaming payments, dispute resolution, cross-chain synchronization, verified namespaces, and NFT-bound agent tokens.

### Contracts Analyzed

| Contract | SLOC | Purpose | Risk Level |
|----------|------|---------|------------|
| TrustRegistry.sol | ~530 | Agent registration, reputation, staking, endorsements | HIGH |
| AgentMeEscrow.sol | ~320 | Escrow for agent transactions | HIGH |
| StreamingPayments.sol | ~385 | Sablier-inspired payment streams | HIGH |
| TieredDisputeResolution.sol | ~570 | Multi-tier dispute resolution | HIGH |
| ChainRegistry.sol | ~245 | Multi-chain configuration registry | MEDIUM |
| CrossChainTrustSync.sol | ~295 | Cross-chain trust score sync | MEDIUM |
| VerifiedNamespaces.sol | ~365 | ENS-inspired namespace registry | MEDIUM |
| AgentToken.sol | ~345 | ERC-721 agent tokens with revenue sharing | HIGH |
| NFTBoundReputation.sol | ~340 | NFT-bound reputation system | HIGH |

---

## 1. TrustRegistry.sol

### Overview
The TrustRegistry contract manages agent registration, reputation tracking, staking with cooldown periods, and endorsements between agents.

### Positive Findings

1. **Proper Use of OpenZeppelin Contracts**
   - Uses `AccessControlEnumerable` for role-based access control
   - Uses `ReentrancyGuard` to prevent reentrancy attacks
   - Uses `SafeERC20` for safe token transfers

2. **Reentrancy Protection**
   - All external functions involving token transfers (`depositStake`, `executeWithdraw`, `slash`) are protected with `nonReentrant` modifier

3. **Access Control**
   - `ORACLE_ROLE` for recording transactions
   - `ARBITER_ROLE` for slashing operations
   - Proper owner verification with `_requireOwner` helper

4. **Cooldown Mechanism**
   - 7-day stake withdrawal cooldown prevents flash loan attacks
   - Only one pending withdrawal allowed at a time

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Front-Running Risk in Endorsement Score Calculation**
   - **Location:** `_calculateEndorsementScore()` (lines 478-505)
   - **Issue:** The endorsement score calculation reads endorser reputation scores. An attacker could front-run a trust score query by temporarily boosting endorser reputations through self-dealing transactions.
   - **Recommendation:** Consider time-weighted average reputation or snapshot-based scoring.

2. **Slashed Funds Destination**
   - **Location:** `slash()` function (lines 268-293)
   - **Issue:** Slashed funds are sent to `getRoleMember(DEFAULT_ADMIN_ROLE, 0)` which assumes the first admin is always the treasury. If admin role membership changes, funds could go to wrong address.
   - **Recommendation:** Add an explicit treasury address state variable.

#### MEDIUM SEVERITY

3. **Owner-to-Agent Mapping Immutability**
   - **Location:** `registerAgent()` and `_ownerToAgent` mapping
   - **Issue:** Once an owner registers an agent, they cannot register another even if the first agent is deactivated. The mapping is never cleared.
   - **Recommendation:** Consider allowing re-registration after agent deactivation or adding an `unregisterAgent` function.

4. **Endorsement Array Unbounded Growth**
   - **Location:** `_endorsements` mapping
   - **Issue:** While `MAX_ENDORSEMENTS` limits per-agent endorsements, the endorsement data includes a `message` string which could be used for gas griefing.
   - **Recommendation:** Add message length limit validation.

5. **Integer Division in Score Calculations**
   - **Location:** `_calculateReputationScore()` (lines 410-441)
   - **Issue:** The formula `data.totalVolumeUsd / 100_00` appears to have an error (should likely be `100_000_000` for cents to $100 units).
   - **Recommendation:** Review and validate all division operations for precision.

#### LOW SEVERITY

6. **Missing Event for Pending Withdrawal Cancellation**
   - **Location:** `slash()` function (lines 283-286)
   - **Issue:** When slashing cancels a pending withdrawal, no event is emitted.
   - **Recommendation:** Emit an event when pending withdrawal is cancelled.

7. **No Pagination for Endorsements**
   - **Location:** `getEndorsements()` function
   - **Issue:** Returns entire endorsement array which could hit gas limits.
   - **Recommendation:** Consider adding pagination.

### Gas Optimization Opportunities

1. **Endorsement Loop in Score Calculation**
   - `_calculateEndorsementScore()` loops through all endorsements which is O(n) complexity.
   - Consider caching or incremental calculation.

2. **Multiple Storage Reads**
   - `_calculateTrustDetails()` reads storage multiple times.
   - Consider using memory variables to reduce SLOAD operations.

---

## 2. AgentMeEscrow.sol

### Overview
Manages escrow for agent-to-agent transactions with state machine-based lifecycle and dispute resolution integration.

### Positive Findings

1. **Proper State Machine**
   - Clear escrow lifecycle states (AWAITING_DEPOSIT -> FUNDED -> DELIVERED -> RELEASED/REFUNDED)
   - State transitions are properly validated

2. **Security Measures**
   - `nonReentrant` modifier on all fund-transferring functions
   - `SafeERC20` for token transfers
   - Agent activity verification via TrustRegistry

3. **Auto-Release Delay**
   - 24-hour delay prevents provider from immediately claiming funds without client review

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Missing ORACLE_ROLE on Contract**
   - **Location:** `_recordTransaction()` (lines 299-315)
   - **Issue:** The escrow contract calls `trustRegistry.recordTransaction()` which requires `ORACLE_ROLE`, but the escrow contract likely doesn't have this role. The try-catch silently ignores failures.
   - **Recommendation:** Ensure escrow contract has ORACLE_ROLE or redesign the integration. Silent failures could lead to reputation not being tracked.

2. **No Minimum Amount Validation**
   - **Location:** `createEscrow()` function
   - **Issue:** While `amount > 0` is checked, there's no minimum escrow amount. Dust escrows could be used to spam the contract or manipulate reputation.
   - **Recommendation:** Add minimum escrow amount threshold.

#### MEDIUM SEVERITY

3. **Arbitrary Token Acceptance**
   - **Location:** `createEscrow()` function
   - **Issue:** Any token address can be used. Malicious tokens could implement transfer hooks or have fee-on-transfer behavior.
   - **Recommendation:** Consider whitelisting approved tokens or at least documenting this risk.

4. **Provider Address Mismatch Risk**
   - **Location:** `createEscrow()` function
   - **Issue:** `providerAddress` is user-provided and separate from the provider's DID. No validation that `providerAddress` is actually associated with `providerDid`.
   - **Recommendation:** Consider validating that providerAddress matches the TrustRegistry owner for providerDid.

5. **Dispute Resolution Race Condition**
   - **Location:** `initiateDispute()` function
   - **Issue:** Both parties can race to initiate dispute. First disputer's evidence is stored, but second caller's evidence is lost.
   - **Recommendation:** Allow both parties to submit evidence even after dispute initiation.

#### LOW SEVERITY

6. **No Escrow Cancellation Before Funding**
   - **Issue:** Once created, an escrow cannot be cancelled before funding.
   - **Recommendation:** Consider adding cancellation mechanism for AWAITING_DEPOSIT state.

7. **Volume Conversion Precision Loss**
   - **Location:** `_recordTransaction()` (line 306)
   - **Issue:** `volumeUsd / 10000` loses precision for small transactions.
   - **Recommendation:** Document the minimum volume that will be recorded.

### Gas Optimization Opportunities

1. **Duplicate Storage Reads**
   - Multiple functions read the same escrow from storage multiple times.
   - Cache in memory where possible.

---

## 3. StreamingPayments.sol

### Overview
Implements Sablier-inspired linear payment streams with pause/resume functionality.

### Positive Findings

1. **Comprehensive Streaming Model**
   - Support for both duration-based and timestamp-based stream creation
   - Pause/resume functionality
   - Top-up capability for stream extension

2. **Security Measures**
   - `nonReentrant` on all token-transferring functions
   - Proper sender/recipient verification

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Precision Loss in Rate Calculation**
   - **Location:** `_createStreamInternal()` (lines 116-117)
   - **Issue:** `ratePerSecond = depositAmount / duration` truncates. For small amounts or long durations, this can result in significant loss. Example: 1 USDC over 1 year = 0 rate per second.
   - **Recommendation:** Use higher precision (e.g., multiply by 1e18 before division) or validate minimum rate.

2. **Top-Up Duration Calculation**
   - **Location:** `topUp()` function (lines 194-209)
   - **Issue:** `additionalDuration = amount / stream.ratePerSecond` can overflow if ratePerSecond is 0 (due to previous precision loss).
   - **Recommendation:** Add check for ratePerSecond > 0 before division.

#### MEDIUM SEVERITY

3. **Pause Duration Accounting**
   - **Location:** `streamedAmountOf()` (lines 297-326)
   - **Issue:** The pause duration calculation is complex and could have edge cases. When paused, historical pause duration is subtracted but this could result in negative elapsed time in edge cases.
   - **Recommendation:** Add comprehensive fuzz testing for pause/resume scenarios.

4. **Stream Completion Race**
   - **Location:** `withdraw()` and `withdrawMax()`
   - **Issue:** If stream completes exactly at withdrawal, there's no verification that all funds are accounted for due to rounding.
   - **Recommendation:** Add final settlement logic to handle dust amounts.

5. **Sender DID Validation Bypass**
   - **Location:** `_createStreamInternal()` (lines 112-113)
   - **Issue:** If sender is not registered in TrustRegistry, stream creation reverts. However, once a stream is created, sender DID is not re-validated for operations like pause/cancel.
   - **Recommendation:** Document this design decision or add ongoing validation.

#### LOW SEVERITY

6. **Missing Stream Existence Check in Public Views**
   - **Location:** Various view functions
   - **Issue:** View functions don't check if stream ID exists, returning default values for non-existent streams.
   - **Recommendation:** Consider reverting for non-existent streams.

7. **Cancelability Flags Immutable**
   - **Issue:** `cancelableBySender` and `cancelableByRecipient` cannot be changed after stream creation.
   - **Recommendation:** Consider adding update functionality.

### Gas Optimization Opportunities

1. **Repeated Pause State Calculations**
   - `_isPaused()` and pause duration calculations are repeated across functions.
   - Consider caching in local variables.

---

## 4. TieredDisputeResolution.sol

### Overview
Implements three-tier dispute resolution: automatic (< $10), AI-assisted ($10-$1000), and community voting (> $1000).

### Positive Findings

1. **Well-Structured Tier System**
   - Clear tier thresholds and fee structures
   - Appeal mechanism with escalating jury sizes (5 -> 11 -> 23 -> 47)
   - Maximum 4 appeal rounds

2. **Time-Locked Phases**
   - Evidence period: 48 hours
   - Voting period: 24 hours
   - Appeal period: 48 hours

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Unimplemented Arbiter Selection**
   - **Location:** `_selectArbiters()` (lines 549-569)
   - **Issue:** The arbiter selection is a placeholder that doesn't actually select arbiters. The `_arbiters` mapping is never populated with real addresses.
   - **Recommendation:** CRITICAL: Implement proper arbiter selection before deployment. Consider using Chainlink VRF for randomness.

2. **Anyone Can Vote**
   - **Location:** `castVote()` function (lines 233-274)
   - **Issue:** Comment says "In production, would verify against `_arbiters[disputeId]`" but no verification is implemented. Anyone can vote.
   - **Recommendation:** CRITICAL: Implement arbiter verification.

3. **Fee Pool Never Distributed**
   - **Location:** `feePool` state variable
   - **Issue:** Fees accumulate in `feePool` but there's no function to distribute them to arbiters or withdraw them.
   - **Recommendation:** Implement fee distribution mechanism.

#### MEDIUM SEVERITY

4. **Auto-Resolution Logic Flawed**
   - **Location:** `checkAutoResolution()` (lines 407-440)
   - **Issue:** If only one party submits evidence, the other party automatically loses. This could be gamed by submitting minimal evidence.
   - **Recommendation:** Consider more nuanced auto-resolution criteria.

5. **Appeal Fee Token Mismatch**
   - **Location:** `appeal()` function (lines 332-373)
   - **Issue:** Function is marked `payable` (accepting ETH) but collects fee in `paymentToken` (USDC). The `msg.value` is never used or refunded.
   - **Recommendation:** Remove `payable` modifier or implement native token handling.

6. **Vote Counting Tie Scenario**
   - **Location:** `finalizeRuling()` (lines 277-328)
   - **Issue:** If `clientVotes == providerVotes` and both are greater than `splitCount`, the result falls through to 50/50 split, which may not be the intended behavior.
   - **Recommendation:** Document tie-breaking rules or implement explicit handling.

#### LOW SEVERITY

7. **No Dispute Cancellation**
   - **Issue:** Once created, a dispute cannot be cancelled by mutual agreement.
   - **Recommendation:** Consider adding mutual settlement functionality.

8. **Missing Evidence Period Extension**
   - **Issue:** Evidence period is fixed at 48 hours with no extension mechanism.
   - **Recommendation:** Consider allowing extensions in exceptional cases.

### Gas Optimization Opportunities

1. **Vote Array Iteration**
   - `finalizeRuling()` iterates through all votes array.
   - Consider maintaining running tallies during voting.

---

## 5. ChainRegistry.sol

### Overview
Manages supported blockchain network configurations for multi-chain deployment.

### Positive Findings

1. **Simple and Clean Design**
   - Clear separation of chain metadata from addresses
   - Proper admin-only access control
   - Efficient array management with swap-and-pop deletion

### Vulnerabilities and Concerns

#### MEDIUM SEVERITY

1. **No Validation of External Addresses**
   - **Location:** `setTrustRegistry()`, `setUSDCAddress()`, `setEndpoint()`
   - **Issue:** Only checks for zero address. No validation that addresses are actual contracts or implement expected interfaces.
   - **Recommendation:** Consider adding interface checks using `supportsInterface` or code size checks.

2. **Chain Removal Leaves Orphan References**
   - **Location:** `removeChain()` function
   - **Issue:** If other contracts hold references to removed chain IDs, they may not be updated.
   - **Recommendation:** Consider implementing an observer pattern or using a soft-delete approach.

#### LOW SEVERITY

3. **Duplicate Chain ID Type**
   - **Issue:** Uses `uint64` for chain ID but other contracts might use `uint256`.
   - **Recommendation:** Ensure consistency across all contracts.

4. **No Batch Operations**
   - **Issue:** Adding multiple chains requires multiple transactions.
   - **Recommendation:** Consider batch add functionality for initial deployment.

### Gas Optimization Opportunities

1. **Loop-Based Active/Testnet Queries**
   - `getActiveChains()`, `getTestnets()`, `getMainnets()` use O(n) loops.
   - Consider maintaining separate arrays for each category.

---

## 6. CrossChainTrustSync.sol

### Overview
Manages cross-chain trust score synchronization using LayerZero V2 pattern.

### Positive Findings

1. **LayerZero V2 Ready Architecture**
   - Prepared for OApp integration
   - Message encoding/decoding functions implemented
   - Cache TTL for stale data management

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Incomplete LayerZero Integration**
   - **Location:** `requestSync()` function (lines 118-132)
   - **Issue:** The actual LayerZero send is commented out. Only an event is emitted, not actual cross-chain message.
   - **Recommendation:** CRITICAL: Complete LayerZero integration before deployment.

2. **No Message Verification**
   - **Location:** `_handleTrustSync()` function (lines 174-183)
   - **Issue:** The function is internal and could be called by inheriting contracts without proper source verification.
   - **Recommendation:** Ensure proper `_lzReceive` implementation verifies sender.

#### MEDIUM SEVERITY

3. **Cache TTL Manipulation**
   - **Location:** `setCacheTTL()` function
   - **Issue:** Admin can set TTL to 0, making all caches immediately stale, or to very high values, keeping stale data.
   - **Recommendation:** Add min/max bounds for cache TTL.

4. **Primary Chain Validation**
   - **Location:** `isPrimaryChain()` function
   - **Issue:** Uses `block.chainid` which returns uint256 but `primaryChainId` is uint64. Type mismatch could cause issues.
   - **Recommendation:** Ensure type consistency.

5. **Batch Cache Without Atomicity**
   - **Location:** `batchCacheTrustScores()` function
   - **Issue:** If one score is invalid, the entire batch fails. Partial updates are not possible.
   - **Recommendation:** Consider skip-on-error option.

#### LOW SEVERITY

6. **Placeholder Fee Estimation**
   - **Location:** `quoteSyncFee()` function (lines 248-262)
   - **Issue:** Uses a placeholder calculation `message.length * 1 gwei` which won't reflect actual LayerZero fees.
   - **Recommendation:** Document this is placeholder or implement proper fee quoting.

### Gas Optimization Opportunities

1. **Peer Array Management**
   - `getSupportedDestinations()` iterates through all peers.
   - Consider maintaining count of active peers separately.

---

## 7. VerifiedNamespaces.sol

### Overview
Implements ENS-inspired namespace registry for organization verification.

### Positive Findings

1. **Clean ENS-Inspired Design**
   - Namespace registration, verification, and transfer
   - Agent linking mechanism
   - Metadata storage

2. **Case-Insensitive Namespaces**
   - Proper lowercase normalization
   - Hash-based collision resistance

### Vulnerabilities and Concerns

#### MEDIUM SEVERITY

1. **Name Validation Insufficient**
   - **Location:** `_validateAndHashName()` function (lines 296-317)
   - **Issue:** Only validates length (3-32 chars). No validation for allowed characters. Could register namespaces with special characters, unicode, etc.
   - **Recommendation:** Add alphanumeric and hyphen-only validation.

2. **Reserved Namespace Bypass**
   - **Location:** `reserveNamespace()` function
   - **Issue:** Reservation happens after normalization hash. An attacker could register "RESERVED" before admin reserves "reserved".
   - **Recommendation:** Pre-deploy with critical reservations or use deployment script.

3. **Verification Without Revocation**
   - **Location:** `verifyNamespace()` function
   - **Issue:** `VERIFIER_ROLE` can verify but cannot unverify. Only admin can revoke.
   - **Recommendation:** Consider allowing verifier to also unverify.

#### LOW SEVERITY

4. **Unbounded Metadata Storage**
   - **Location:** `setMetadata()` function
   - **Issue:** No limits on key or value length. Could be used for storage-based griefing.
   - **Recommendation:** Add length limits for keys and values.

5. **Missing Namespace Existence Check in Views**
   - **Location:** Various view functions like `getMetadata()`
   - **Issue:** Returns empty values for non-existent namespaces instead of reverting.
   - **Recommendation:** Consider reverting for non-existent namespaces.

### Gas Optimization Opportunities

1. **Double Normalization**
   - `_validateAndHashName()` normalizes, then `registerNamespace()` also calls `_toLowercase()`.
   - Consider returning normalized string from validation function.

---

## 8. AgentToken.sol

### Overview
ERC-721 tokens representing AI agents with ERC-2981 royalty support and revenue sharing.

### Positive Findings

1. **Standard Compliance**
   - Proper ERC-721 implementation with URI storage
   - ERC-2981 royalty support
   - Capped royalty at 10%

2. **Revenue Distribution**
   - Clean deposit/claim mechanism for agent revenue
   - Revenue claimed before burn to prevent loss

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Royalty Update on Transfer Bug**
   - **Location:** `_update()` override (lines 328-339)
   - **Issue:** The royalty calculation `royaltyInfo(tokenId, 10000)` returns the royalty AMOUNT for 10000 value, not the BPS. This is then incorrectly cast to `uint96` and used as BPS.
   - **Example:** If royalty is 5% (500 BPS), `royaltyInfo(tokenId, 10000)` returns 500. This is then used as the new royalty, which is 5%, correct by accident but mathematically wrong approach.
   - **Recommendation:** Store royalty BPS separately or use proper getter.

2. **DID Hash Zero Check Missing**
   - **Location:** `mintAgent()` function (line 124)
   - **Issue:** `_didToToken[didHash] != 0` fails to detect if `didHash == bytes32(0)` was minted (token ID 0 is never used due to pre-increment).
   - **However:** Pre-increment means tokenId starts at 1, so this is actually safe. But the logic is confusing.
   - **Recommendation:** Add explicit `didHash != bytes32(0)` check.

#### MEDIUM SEVERITY

3. **Revenue Loss on Transfer**
   - **Location:** `_update()` override
   - **Issue:** When token is transferred, accumulated revenue is not claimed or transferred. New owner inherits accumulated revenue.
   - **Recommendation:** Either auto-claim on transfer or document this behavior clearly.

4. **No Cooldown on Royalty Changes**
   - **Location:** `setRoyalty()` function
   - **Issue:** Owner can change royalty at any time. Could front-run sales to maximize royalty.
   - **Recommendation:** Consider adding cooldown period for royalty changes.

5. **Burn Prevents Future DID Minting**
   - **Location:** `burnAgent()` function
   - **Issue:** When burned, `_didToToken[didHash]` is deleted, allowing the same DID to be minted again. This could be intentional or a security issue.
   - **Recommendation:** Document whether DID re-registration is allowed.

#### LOW SEVERITY

6. **No Mint Cap**
   - **Issue:** Unlimited agents can be minted.
   - **Recommendation:** Consider if supply cap is needed.

7. **Treasury Zero Check Only on Set**
   - **Issue:** Constructor checks treasury != 0 but `setTreasury()` allows setting to valid address. Both check, so this is fine.

### Gas Optimization Opportunities

1. **Revenue Claim on Burn**
   - Could be made more efficient by not checking if `_accumulatedRevenue > 0` twice.

---

## 9. NFTBoundReputation.sol

### Overview
Reputation system bound to AgentToken NFTs, where reputation follows the token on transfer.

### Positive Findings

1. **NFT-Bound Design**
   - Reputation automatically transfers with NFT ownership
   - No separate reputation transfer needed

2. **Batch Operations**
   - `batchRecordTransactions()` for efficient oracle operations

### Vulnerabilities and Concerns

#### HIGH SEVERITY

1. **Token Existence Check Try-Catch Abuse**
   - **Location:** `_requireTokenExists()` (lines 312-321)
   - **Issue:** Uses try-catch on external call which consumes all gas on failure in some edge cases. If AgentToken contract is malicious or self-destructs, behavior is undefined.
   - **Recommendation:** Consider adding additional validation or using a direct interface check.

2. **No Stake Withdrawal Mechanism**
   - **Location:** `depositStake()` and `slash()` functions
   - **Issue:** Users can deposit stake but there's no way to withdraw it normally. Only slashing reduces stake.
   - **Recommendation:** CRITICAL: Add stake withdrawal mechanism with cooldown.

#### MEDIUM SEVERITY

3. **Stake Bounds Issue**
   - **Location:** `depositStake()` function (line 168)
   - **Issue:** Initial deposit must meet `MINIMUM_STAKE`, but slashing can reduce below minimum with no re-stake requirement.
   - **Recommendation:** Document or enforce minimum stake maintenance.

4. **Treasury Initialized to Admin**
   - **Location:** Constructor (line 103)
   - **Issue:** `treasury = _admin` sets treasury to admin. If admin is a multisig, slashed funds go to multisig which might not be intended.
   - **Recommendation:** Consider separate treasury parameter.

5. **Volume Conversion Inconsistency**
   - **Location:** `calculateReputationScore()` (line 267)
   - **Issue:** `data.totalVolumeUsd / 100_000_000` differs from TrustRegistry's `data.totalVolumeUsd / 100_00`. Inconsistent formulas.
   - **Recommendation:** Standardize volume handling across contracts.

#### LOW SEVERITY

6. **No Reputation Transfer Event**
   - **Issue:** `ReputationTransferred` event is declared but never emitted.
   - **Recommendation:** Emit on NFT transfer detection or remove unused event.

7. **Missing Batch Validation**
   - **Location:** `batchRecordTransactions()` function
   - **Issue:** Continues recording even if some tokens don't exist (via _requireTokenExists revert).
   - **Recommendation:** Consider skip-on-error option for batch operations.

### Gas Optimization Opportunities

1. **External Calls in Loops**
   - `batchRecordTransactions()` makes external `ownerOf` call for each token.
   - Consider batch verification if possible.

---

## Cross-Contract Security Concerns

### 1. Role Consistency
Multiple contracts use `ORACLE_ROLE` and `ARBITER_ROLE` but they are defined separately in each contract. Ensure the same addresses are granted these roles across all contracts.

### 2. Trust Registry Dependencies
- AgentMeEscrow depends on TrustRegistry for agent verification
- StreamingPayments depends on TrustRegistry for sender DID lookup
- NFTBoundReputation is independent (uses AgentToken instead)

**Risk:** If TrustRegistry is compromised or upgraded, dependent contracts may malfunction.

### 3. Token Assumptions
All contracts assume USDC with 6 decimals. If deployed with different tokens:
- Volume calculations will be incorrect
- Minimum stake amounts will be wrong
- Fee calculations may overflow or underflow

### 4. Upgrade Path
None of the contracts are upgradeable. Consider:
- Using proxy patterns for core contracts
- Implementing migration mechanisms
- Adding emergency pause functionality to all contracts

---

## Centralization Risks

### Critical Admin Powers

| Contract | Admin Capability | Risk |
|----------|------------------|------|
| TrustRegistry | Grant/revoke ORACLE and ARBITER roles | Can manipulate reputation |
| AgentMeEscrow | Grant ARBITER role, resolve disputes | Can steal escrowed funds |
| StreamingPayments | Admin role (minimal powers) | Low risk |
| TieredDisputeResolution | Grant ORACLE role, configure contracts | Can manipulate dispute outcomes |
| ChainRegistry | Add/remove chains, set addresses | Can redirect to malicious contracts |
| CrossChainTrustSync | Set peers, cache scores | Can inject false trust scores |
| VerifiedNamespaces | Revoke namespaces, reserve names | Can censor organizations |
| AgentToken | Set mint fee, set treasury | Can drain mint fees |
| NFTBoundReputation | Grant ORACLE/ARBITER roles, set treasury | Can manipulate reputation, steal slashed funds |

### Recommendations
1. Use multi-sig for all admin roles
2. Implement time-locks for sensitive operations
3. Consider DAO governance for protocol parameters
4. Add emergency pause mechanisms with time-limited powers

---

## Recommendations Summary

### Critical (Must Fix Before Deployment)

1. **TieredDisputeResolution:** Implement actual arbiter selection and voting verification
2. **CrossChainTrustSync:** Complete LayerZero integration
3. **NFTBoundReputation:** Add stake withdrawal mechanism
4. **AgentMeEscrow:** Grant ORACLE_ROLE to escrow contract or redesign

### High Priority

5. **TrustRegistry:** Add explicit treasury address instead of using first admin
6. **StreamingPayments:** Fix precision loss in rate calculation
7. **AgentToken:** Fix royalty BPS calculation in transfer
8. **VerifiedNamespaces:** Add character validation for namespace names

### Medium Priority

9. Add minimum escrow amounts
10. Implement token whitelist for payments
11. Add emergency pause to all contracts
12. Implement proper fee distribution in dispute resolution
13. Add time-locks for admin operations
14. Standardize volume/amount handling across contracts

### Pre-Audit Checklist

- [ ] Complete all placeholder implementations
- [ ] Add comprehensive NatSpec documentation
- [ ] Implement fuzz testing for all math operations
- [ ] Add invariant testing for state machines
- [ ] Create deployment scripts with proper role setup
- [ ] Document all admin operations and their risks
- [ ] Implement monitoring/alerting infrastructure
- [ ] Create incident response playbook

---

## Testing Recommendations

### Unit Tests Required
- State machine transitions for all escrow states
- Edge cases in streaming payment calculations
- Endorsement score with 0, 1, and MAX endorsements
- Trust score at boundary conditions
- Dispute resolution with various vote distributions

### Fuzz Testing Required
- Amount calculations in all payment flows
- Time-based calculations (pause durations, cooldowns)
- Rate per second calculations with various amounts/durations

### Integration Tests Required
- Cross-contract role verification
- End-to-end escrow with dispute resolution
- Cross-chain trust sync simulation

### Invariant Tests Required
- Total staked amount == sum of individual stakes
- Escrow funds always match state
- Stream withdrawable + withdrawn == deposit amount

---

## Appendix: Contract Dependency Graph

```
                    +----------------+
                    | ChainRegistry  |
                    +-------+--------+
                            |
                            v
                +----------------------+
                | CrossChainTrustSync  |
                +----------------------+

+------------------+      +---------------+
|  TrustRegistry   |<-----| AgentMeEscrow|
+--------+---------+      +-------+-------+
         |                        |
         v                        v
+-----------------+    +------------------------+
|StreamingPayments|    |TieredDisputeResolution|
+-----------------+    +------------------------+

+----------------+     +--------------------+
|  AgentToken    |<----|  NFTBoundReputation|
+----------------+     +--------------------+

+--------------------+
| VerifiedNamespaces |  (standalone)
+--------------------+
```

---

**Document Version:** 1.0
**Last Updated:** 2026-02-02
**Next Review:** Before formal audit engagement
