# Protocol Fee & Node Incentivization Design

**Date:** 2026-02-28
**Status:** Approved
**Author:** Design session with user

## Problem

AgoraMesh provides real value (trust scoring, escrow protection, agent discovery) but captures none of it financially. Successful escrow releases and streaming withdrawals transfer 100% to the provider. The only existing revenue comes from dispute fees (3-5%) and configurable NFT mint fees — both edge cases, not core flow.

**Current state:**
- x402 direct payments: 0% fee (P2P, no platform involvement)
- Escrow release: 0% fee (full amount to provider)
- Streaming withdraw: 0% fee (full amount to recipient)
- Dispute resolution: 3-5% fee (existing, keeps working)
- Agent NFT mint: configurable fee (existing, keeps working)

**Competitive context:**
- Nevermined: ~1% platform commission
- Ocean Protocol: 0.1-0.2% swap fees
- NFT marketplaces: 1-2.5%
- Trend: sub-1% for infrastructure layers

## Design Decisions

### 1. Hybrid Monetization (approved)

Fee only where AgoraMesh provides clear added value (escrow, streaming). x402 direct payments remain free as competitive advantage and adoption hook.

### 2. Fee Rate: 0.5% (approved)

- Below Nevermined (~1%), above Ocean (0.1-0.2%)
- Competitive positioning as affordable infrastructure
- Configurable by admin (can adjust without redeploy)
- Hard cap at 5% (MAX_FEE_BP = 500)
- Minimum fee: $0.01 USDC

### 3. Facilitator Model for Node Incentivization (approved)

Since anyone can run an AgoraMesh node, the protocol fee is split between the node operator who facilitated the transaction and the protocol treasury.

**Split: 70% facilitator / 30% treasury**

When a node creates an escrow or stream, it includes its wallet address as `facilitator`. The smart contract enforces the split — the node cannot take the treasury share, and the treasury cannot take the node share.

### 4. Fee Deduction Point: Provider Side (approved)

Fee is always deducted from the payout (provider/recipient side), never added to the deposit. The client pays exactly what they see — no hidden charges on the buyer side.

## Fee Structure

| Payment Method | Fee | Who Pays | Split |
|---|---|---|---|
| x402 direct | 0% | — | — |
| Escrow release | 0.5% of released amount | Deducted from provider payout | 70% facilitator, 30% treasury |
| Escrow dispute resolution | 0.5% of resolved amount | Deducted from winner payout | 70% facilitator, 30% treasury |
| Streaming withdraw | 0.5% of withdrawn amount | Deducted from recipient | 70% facilitator, 30% treasury |
| Streaming cancel | 0.5% of recipient portion | Deducted from recipient | 70% facilitator, 30% treasury |
| Dispute filing (existing) | 3-5% + minimum | Disputing party | 100% feePool (unchanged) |
| Agent NFT mint (existing) | Configurable | Minter | 100% treasury (unchanged) |

## Technical Design

### Smart Contract Changes

#### AgoraMeshEscrow.sol

**New state variables:**
```solidity
address public treasury;
uint256 public protocolFeeBp;  // default: 50 (0.5%)
uint256 public constant MAX_FEE_BP = 500;  // 5% hard cap
uint256 public constant MIN_FEE = 10_000;  // $0.01 USDC
uint256 private constant BP = 10_000;
uint256 public constant FACILITATOR_SHARE_BP = 7_000;  // 70%
```

**New field in Escrow struct:**
```solidity
struct Escrow {
    // ... existing fields ...
    address facilitator;  // Node operator address
}
```

**Function changes:**
- `createEscrow()` — add `address facilitator` parameter, store in struct
- `releaseEscrow()` — calculate fee, split 70/30, transfer net amount to provider
- `resolveDispute()` — same fee logic on resolved amounts
- New: `setTreasury(address)` — admin only
- New: `setProtocolFeeBp(uint256)` — admin only, capped at MAX_FEE_BP

**New events:**
```solidity
event ProtocolFeeCollected(
    uint256 indexed escrowId,
    uint256 totalFee,
    address indexed facilitator,
    uint256 facilitatorShare,
    uint256 treasuryShare
);
event TreasuryUpdated(address indexed newTreasury);
event ProtocolFeeUpdated(uint256 newFeeBp);
```

**Fee calculation (internal function):**
```solidity
function _deductAndTransferFee(
    address token,
    uint256 amount,
    address facilitator
) internal returns (uint256 netAmount) {
    uint256 fee = (amount * protocolFeeBp) / BP;
    if (fee < MIN_FEE && fee > 0) fee = MIN_FEE;
    if (fee > amount) fee = amount;  // safety

    if (fee > 0 && treasury != address(0)) {
        uint256 facilitatorShare = (fee * FACILITATOR_SHARE_BP) / BP;
        uint256 treasuryShare = fee - facilitatorShare;

        if (facilitator != address(0) && facilitatorShare > 0) {
            IERC20(token).safeTransfer(facilitator, facilitatorShare);
        } else {
            treasuryShare = fee;  // no facilitator → all to treasury
        }
        if (treasuryShare > 0) {
            IERC20(token).safeTransfer(treasury, treasuryShare);
        }

        emit ProtocolFeeCollected(escrowId, fee, facilitator, facilitatorShare, treasuryShare);
    }

    return amount - fee;
}
```

#### StreamingPayments.sol

Same pattern as Escrow:
- Add `treasury`, `protocolFeeBp`, `FACILITATOR_SHARE_BP` state variables
- Add `facilitator` field to Stream struct
- `createStream()` — add `address facilitator` parameter
- `withdraw()` / `withdrawMax()` — deduct fee from withdrawn amount
- `cancel()` — deduct fee from recipient portion only (sender refund is untouched)
- Same admin functions and events

#### Unchanged Contracts
- `TieredDisputeResolution.sol` — existing fee system stays as-is
- `AgentToken.sol` — mint fee stays as-is
- `TrustRegistry.sol` — no changes
- `NFTBoundReputation.sol` — no changes

### Bridge Changes

#### config.ts
Add protocol fee configuration:
```typescript
const ProtocolFeesSchema = z.object({
    escrowFeeBp: z.number().min(0).max(500).default(50),
    streamingFeeBp: z.number().min(0).max(500).default(50),
    facilitatorAddress: z.string(),  // node's own wallet
});
```

#### escrow.ts
- Pass `facilitatorAddress` from config when calling `createEscrow()`
- Update escrow validation to account for fee deduction in expected payout

#### x402.ts
- No changes (x402 remains free)

### Deployment Changes

#### Deploy.s.sol
After deploying contracts:
```solidity
AgoraMeshEscrow(escrow).setTreasury(treasuryAddress);
AgoraMeshEscrow(escrow).setProtocolFeeBp(50);  // 0.5%

StreamingPayments(streaming).setTreasury(treasuryAddress);
StreamingPayments(streaming).setProtocolFeeBp(50);  // 0.5%
```

### Test Plan (TDD)

Tests to write BEFORE implementation:

**AgoraMeshEscrow tests:**
1. `test_releaseEscrow_deductsProtocolFee` — verify provider receives amount - 0.5%
2. `test_releaseEscrow_splitsFee_70_30` — verify facilitator gets 70%, treasury 30%
3. `test_releaseEscrow_noFacilitator_allToTreasury` — facilitator=address(0)
4. `test_releaseEscrow_zeroFee_fullAmountToProvider` — protocolFeeBp=0
5. `test_releaseEscrow_minimumFee` — small amounts hit $0.01 minimum
6. `test_releaseEscrow_feeCannotExceedAmount` — safety check
7. `test_setProtocolFeeBp_cannotExceedMax` — revert on > 500
8. `test_setTreasury_onlyAdmin` — access control
9. `test_resolveDispute_deductsFee` — fee on dispute resolution
10. `test_createEscrow_storesFacilitator` — facilitator stored correctly
11. `test_protocolFeeCollected_event` — event emitted with correct values

**StreamingPayments tests:**
12. `test_withdraw_deductsProtocolFee` — fee on withdrawal
13. `test_withdrawMax_deductsProtocolFee` — fee on max withdrawal
14. `test_cancel_deductsFeeFromRecipientOnly` — sender refund untouched
15. `test_cancel_splitsFee_70_30` — facilitator/treasury split
16. `test_createStream_storesFacilitator` — facilitator stored

**Integration tests:**
17. `test_endToEnd_escrowWithFee` — create → fund → deliver → release with fee
18. `test_endToEnd_streamWithFee` — create → withdraw → verify fee deducted

### Website Changes

#### New: Pricing Page (`/pricing/`)
- Transparent fee breakdown table
- Comparison with competitors (Nevermined, Ocean)
- Calculator: "If your agent earns $X/month, AgoraMesh fee = $Y"
- Emphasis: x402 direct = free, escrow/streaming = 0.5%
- Node operator section: "Run a node, earn 70% of protocol fees"

#### Update: FAQ
Add question: "How does AgoraMesh make money?"
Answer: "AgoraMesh charges a 0.5% protocol fee on escrow and streaming payments — transactions where the platform holds funds and provides protection. Direct x402 payments between trusted agents are always free. 70% of fees go to the node operator who facilitated the transaction."

#### Update: Developer Docs
- Document fee structure for providers
- Show fee calculation examples
- Document facilitator parameter in escrow/streaming APIs
- Update API reference with new parameters

#### Update: llms.txt
Add fee information for machine-readable consumption.

### Revenue Projections

At 0.5% blended rate (escrow + streaming only):

| Monthly Volume | Protocol Revenue | Treasury (30%) | Per Node (70% / N nodes) |
|---|---|---|---|
| $10K | $50 | $15 | $35/N |
| $100K | $500 | $150 | $350/N |
| $1M | $5,000 | $1,500 | $3,500/N |
| $10M | $50,000 | $15,000 | $35,000/N |

Note: x402 direct payments (likely majority of volume initially) generate $0.

### Risks & Mitigations

1. **Agents bypass escrow for direct x402** — Expected and acceptable. Escrow provides real value (protection), agents who need it will pay 0.5%.
2. **Fake facilitator addresses** — Treasury share (30%) is always enforced by contract. Worst case: agent runs own node and keeps 70% that would go to a real node. This is self-facilitating, which is fine.
3. **Fee too high drives adoption down** — Fee is admin-configurable, can be reduced to 0 anytime. Start at 0.5% and adjust.
4. **Breaking existing escrows** — New fee only applies to escrows created after upgrade. Existing escrows release at 0%.
5. **Precision loss on small amounts** — MIN_FEE of $0.01 prevents dust. Amounts below $2 would pay minimum fee (effectively >0.5%).

### Migration

- Deploy updated contracts to Base Sepolia testnet first
- Run full test suite including fee scenarios
- Deploy to Base mainnet with `protocolFeeBp = 50` (0.5%)
- Existing escrows/streams are unaffected (no facilitator field)
- Bridge update to pass facilitator address
- Website update with pricing page
