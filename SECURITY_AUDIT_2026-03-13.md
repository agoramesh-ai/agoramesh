# Internal Security Audit — 2026-03-13

Automated review of AgoraMesh Solidity contracts via Paperclip/Codex CTO agent.
Forge test suite: **560 passed, 0 failed.**

## Findings

### HIGH-1: StreamingPayments — Pause Accounting Bug
**File:** `contracts/src/StreamingPayments.sol` (lines ~387-403)
**Impact:** Recipient can withdraw more than entitled after pause cycles.
**Detail:** `streamedAmountOf` paused-path does not subtract `_totalPauseDuration`, causing over-accrual during subsequent pauses.
**Fix:** Subtract cumulative pause duration in paused-path calculation.

### HIGH-2: TieredDisputeResolution — Voting Deadlock
**File:** `contracts/src/TieredDisputeResolution.sol` (lines ~327-329, ~639-649)
**Impact:** Dispute can become permanently stuck in VOTING state.
**Detail:** `finalizeRuling` enforces quorum based on theoretical required arbiters, but `_selectArbiters` may select fewer than required when pool is undersized.
**Fix:** Cap quorum requirement to actual selected arbiter count, or prevent dispute escalation when pool is insufficient.

### MEDIUM-3: AgentToken — Stale Royalty After Transfer
**File:** `contracts/src/AgentToken.sol` (lines ~221-228, ~339-342)
**Impact:** Royalty settings silently revert to stale values on transfer.
**Detail:** `setRoyalty` does not update `_agents[tokenId].royaltyBps`, but `_update` reapplies royalty from that stored field.
**Fix:** Ensure `setRoyalty` writes to `_agents[tokenId].royaltyBps`.

### MEDIUM-4: Escrow + TrustRegistry — Volume Unit Mismatch
**Files:** `contracts/src/AgoraMeshEscrow.sol` (lines ~483-486), `contracts/src/TrustRegistry.sol` (line ~490)
**Impact:** Provider reputation underweighted by ~100x.
**Detail:** Escrow converts amount to cents (`/10000`) before `recordTransaction`, while TrustRegistry math expects 6-decimal USD units for `totalVolumeUsd`.
**Fix:** Align unit conversion — either remove `/10000` in escrow or adjust TrustRegistry expectations.

## Notes
- Reentrancy protections and state-transition guards are solid.
- `CrossChainTrustSync` is intentionally a skeleton — consistent with docs.
- Recommend fixing HIGH findings before mainnet.
