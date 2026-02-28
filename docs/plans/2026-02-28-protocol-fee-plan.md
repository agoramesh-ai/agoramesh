# Protocol Fee Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 0.5% protocol fee to escrow and streaming payments with 70/30 facilitator/treasury split.

**Architecture:** Fee is deducted from provider payouts (not added to client deposits). Each escrow/stream stores a `facilitator` address (the node operator). On release/withdraw, the contract splits the fee 70% to facilitator, 30% to treasury. x402 direct payments remain free.

**Tech Stack:** Solidity 0.8.24 (Foundry), TypeScript (vitest), Astro (website)

**Design doc:** `docs/plans/2026-02-28-protocol-fee-design.md`

---

### Task 1: Update IAgoraMeshEscrow Interface

**Files:**
- Modify: `contracts/src/interfaces/IAgoraMeshEscrow.sol`

**Step 1: Add facilitator field to Escrow struct**

In `contracts/src/interfaces/IAgoraMeshEscrow.sol`, add `facilitator` to the Escrow struct (after `deliveredAt` on line 36):

```solidity
    struct Escrow {
        uint256 id;
        bytes32 clientDid;
        bytes32 providerDid;
        address clientAddress;
        address providerAddress;
        uint256 amount;
        address token;
        bytes32 taskHash;
        bytes32 outputHash;
        uint256 deadline;
        State state;
        uint256 createdAt;
        uint256 deliveredAt;
        address facilitator;  // NEW: Node operator who facilitated this escrow
    }
```

**Step 2: Add new events**

After `DisputeResolved` event (line 66), add:

```solidity
    /// @notice Emitted when protocol fee is collected
    event ProtocolFeeCollected(
        uint256 indexed escrowId,
        uint256 totalFee,
        address indexed facilitator,
        uint256 facilitatorShare,
        uint256 treasuryShare
    );

    /// @notice Emitted when treasury address is updated
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Emitted when protocol fee basis points is updated
    event ProtocolFeeUpdated(uint256 newFeeBp);
```

**Step 3: Add facilitator parameter to createEscrow**

Update `createEscrow` function signature (line 85-93) to include `address facilitator`:

```solidity
    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline,
        address facilitator  // NEW
    ) external returns (uint256 escrowId);
```

**Step 4: Verify contracts still compile**

Run: `cd /home/lada/projects/agoramesh/contracts && forge build 2>&1 | head -20`
Expected: Compilation errors (implementation doesn't match interface yet — that's expected)

**Step 5: Commit interface changes**

```bash
cd /home/lada/projects/agoramesh
git add contracts/src/interfaces/IAgoraMeshEscrow.sol
git commit -m "feat(contracts): add facilitator and protocol fee to IAgoraMeshEscrow interface"
```

---

### Task 2: Write Failing Escrow Protocol Fee Tests

**Files:**
- Create: `contracts/test/EscrowProtocolFee.t.sol`

**Step 1: Write the failing test file**

Create `contracts/test/EscrowProtocolFee.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/TrustRegistry.sol";
import "../src/interfaces/IAgoraMeshEscrow.sol";
import "../src/interfaces/ITrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDC token for testing
contract MockUSDC6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract EscrowProtocolFeeTest is Test {
    AgoraMeshEscrow public escrow;
    TrustRegistry public registry;
    MockUSDC6 public usdc;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public arbiter = address(0x3);
    address public client = address(0x4);
    address public provider = address(0x5);
    address public facilitator = address(0x6);
    address public treasury = address(0x7);

    bytes32 public clientDid = keccak256("did:agoramesh:client");
    bytes32 public providerDid = keccak256("did:agoramesh:provider");
    string public clientCID = "QmClientCID";
    string public providerCID = "QmProviderCID";
    bytes32 public taskHash = keccak256("task-spec");
    bytes32 public outputHash = keccak256("task-output");

    uint256 public constant MINIMUM_STAKE = 100 * 1e6;
    uint256 public constant TASK_AMOUNT = 10_000 * 1e6;  // $10,000 USDC
    uint256 public constant PROTOCOL_FEE_BP = 50;         // 0.5%

    function setUp() public {
        usdc = new MockUSDC6();

        vm.prank(admin);
        registry = new TrustRegistry(address(usdc), admin);

        vm.prank(admin);
        escrow = new AgoraMeshEscrow(address(registry), admin);

        // Grant roles
        vm.startPrank(admin);
        registry.grantRole(registry.ORACLE_ROLE(), oracle);
        registry.grantRole(registry.ARBITER_ROLE(), arbiter);
        registry.grantRole(registry.ORACLE_ROLE(), address(escrow));
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
        vm.stopPrank();

        // Mint tokens
        usdc.mint(client, 1_000_000 * 1e6);
        usdc.mint(provider, 1_000_000 * 1e6);

        // Register agents
        vm.prank(client);
        registry.registerAgent(clientDid, clientCID);
        vm.prank(provider);
        registry.registerAgent(providerDid, providerCID);

        // Stake
        vm.startPrank(client);
        usdc.approve(address(registry), type(uint256).max);
        registry.depositStake(clientDid, MINIMUM_STAKE);
        vm.stopPrank();

        // Setup token whitelist & approvals
        vm.prank(admin);
        escrow.addAllowedToken(address(usdc));
        vm.prank(client);
        usdc.approve(address(escrow), type(uint256).max);

        // Configure protocol fee
        vm.startPrank(admin);
        escrow.setTreasury(treasury);
        escrow.setProtocolFeeBp(PROTOCOL_FEE_BP);
        vm.stopPrank();
    }

    // ============ Helper Functions ============

    function _createEscrowWithFacilitator() internal returns (uint256 escrowId) {
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc),
            TASK_AMOUNT, taskHash, deadline, facilitator
        );
    }

    function _createFundAndDeliver() internal returns (uint256 escrowId) {
        escrowId = _createEscrowWithFacilitator();
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);
    }

    // ============ Treasury & Fee Config Tests ============

    function test_setTreasury_setsAddress() public {
        assertEq(escrow.treasury(), treasury);
    }

    function test_setTreasury_onlyAdmin() public {
        vm.prank(client);
        vm.expectRevert();
        escrow.setTreasury(address(0x99));
    }

    function test_setTreasury_revertIfZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert();
        escrow.setTreasury(address(0));
    }

    function test_setProtocolFeeBp_setsValue() public {
        assertEq(escrow.protocolFeeBp(), PROTOCOL_FEE_BP);
    }

    function test_setProtocolFeeBp_onlyAdmin() public {
        vm.prank(client);
        vm.expectRevert();
        escrow.setProtocolFeeBp(100);
    }

    function test_setProtocolFeeBp_revertIfExceedsMax() public {
        vm.prank(admin);
        vm.expectRevert();
        escrow.setProtocolFeeBp(501);  // MAX_FEE_BP is 500
    }

    // ============ CreateEscrow with Facilitator ============

    function test_createEscrow_storesFacilitator() public {
        uint256 escrowId = _createEscrowWithFacilitator();
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.facilitator, facilitator);
    }

    function test_createEscrow_zeroFacilitatorAllowed() public {
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc),
            TASK_AMOUNT, taskHash, deadline, address(0)
        );
        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.facilitator, address(0));
    }

    // ============ ReleaseEscrow with Fee ============

    function test_releaseEscrow_deductsProtocolFee() public {
        uint256 escrowId = _createFundAndDeliver();

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Expected: provider gets amount - 0.5% fee
        uint256 expectedFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;
        uint256 expectedNet = TASK_AMOUNT - expectedFee;
        assertEq(usdc.balanceOf(provider), providerBefore + expectedNet);
    }

    function test_releaseEscrow_splitsFee_70_30() public {
        uint256 escrowId = _createFundAndDeliver();

        uint256 facilitatorBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        uint256 totalFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;  // $50
        uint256 facilitatorShare = (totalFee * 7_000) / 10_000;        // $35
        uint256 treasuryShare = totalFee - facilitatorShare;            // $15

        assertEq(usdc.balanceOf(facilitator), facilitatorBefore + facilitatorShare);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + treasuryShare);
    }

    function test_releaseEscrow_noFacilitator_allToTreasury() public {
        // Create escrow with facilitator = address(0)
        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc),
            TASK_AMOUNT, taskHash, deadline, address(0)
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        uint256 totalFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;
        assertEq(usdc.balanceOf(treasury), treasuryBefore + totalFee);
    }

    function test_releaseEscrow_zeroFee_fullAmountToProvider() public {
        // Set fee to 0
        vm.prank(admin);
        escrow.setProtocolFeeBp(0);

        uint256 escrowId = _createFundAndDeliver();
        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        assertEq(usdc.balanceOf(provider), providerBefore + TASK_AMOUNT);
    }

    function test_releaseEscrow_emitsProtocolFeeCollected() public {
        uint256 escrowId = _createFundAndDeliver();

        uint256 totalFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;
        uint256 facilitatorShare = (totalFee * 7_000) / 10_000;
        uint256 treasuryShare = totalFee - facilitatorShare;

        vm.prank(client);
        vm.expectEmit(true, true, true, true);
        emit IAgoraMeshEscrow.ProtocolFeeCollected(
            escrowId, totalFee, facilitator, facilitatorShare, treasuryShare
        );
        escrow.releaseEscrow(escrowId);
    }

    function test_releaseEscrow_minimumFee() public {
        // Create a very small escrow ($1 USDC)
        uint256 smallAmount = 1 * 1e6;
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc),
            smallAmount, taskHash, deadline, facilitator
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // 0.5% of $1 = $0.005 = 5000 (in 6 decimal USDC)
        // This is below MIN_FEE ($0.01 = 10000), so MIN_FEE applies
        uint256 expectedFee = 10_000;  // $0.01 minimum
        uint256 expectedNet = smallAmount - expectedFee;
        assertEq(usdc.balanceOf(provider), providerBefore + expectedNet);
    }

    // ============ Dispute Resolution with Fee ============

    function test_resolveDispute_deductsFeeFromProviderShare() public {
        uint256 escrowId = _createFundAndDeliver();

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 facilitatorBefore = usdc.balanceOf(facilitator);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        // Resolve: 100% to provider
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, TASK_AMOUNT);

        uint256 totalFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;
        uint256 facilitatorShare = (totalFee * 7_000) / 10_000;
        uint256 treasuryShare = totalFee - facilitatorShare;

        assertEq(usdc.balanceOf(provider), providerBefore + TASK_AMOUNT - totalFee);
        assertEq(usdc.balanceOf(facilitator), facilitatorBefore + facilitatorShare);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + treasuryShare);
    }

    function test_resolveDispute_splitScenario_feeOnBothShares() public {
        uint256 escrowId = _createFundAndDeliver();

        vm.prank(client);
        escrow.initiateDispute(escrowId, "");

        uint256 providerShare = TASK_AMOUNT / 2;  // 50/50 split
        uint256 clientShare = TASK_AMOUNT - providerShare;

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, providerShare);

        // Fee deducted from total amount, distributed proportionally
        uint256 totalFee = (TASK_AMOUNT * PROTOCOL_FEE_BP) / 10_000;
        uint256 providerFee = (providerShare * PROTOCOL_FEE_BP) / 10_000;
        uint256 clientFee = (clientShare * PROTOCOL_FEE_BP) / 10_000;

        assertEq(usdc.balanceOf(provider), providerBefore + providerShare - providerFee);
        assertEq(usdc.balanceOf(client), clientBefore + clientShare - clientFee);
    }

    // ============ Fuzz Tests ============

    function testFuzz_releaseEscrow_feeNeverExceedsAmount(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 1_000_000 * 1e6);

        uint256 deadline = block.timestamp + 1 days;
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc),
            amount, taskHash, deadline, facilitator
        );
        vm.prank(client);
        escrow.fundEscrow(escrowId);
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, outputHash);

        uint256 providerBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        // Provider always receives something
        assertGt(usdc.balanceOf(provider), providerBefore);
    }

    function testFuzz_setProtocolFeeBp_withinRange(uint256 feeBp) public {
        vm.assume(feeBp <= 500);
        vm.prank(admin);
        escrow.setProtocolFeeBp(feeBp);
        assertEq(escrow.protocolFeeBp(), feeBp);
    }
}
```

**Step 2: Verify tests fail (contracts don't compile yet)**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test --match-path "test/EscrowProtocolFee.t.sol" 2>&1 | tail -10`
Expected: Compilation errors (setTreasury, setProtocolFeeBp, facilitator don't exist yet)

**Step 3: Commit failing tests**

```bash
cd /home/lada/projects/agoramesh
git add contracts/test/EscrowProtocolFee.t.sol
git commit -m "test(contracts): add failing protocol fee tests for escrow (TDD red)"
```

---

### Task 3: Implement Protocol Fee in AgoraMeshEscrow

**Files:**
- Modify: `contracts/src/AgoraMeshEscrow.sol`

**Step 1: Add state variables and errors**

After line 40 (`mapping(address => bool) private _allowedTokens;`), add:

```solidity
    /// @notice Protocol treasury address
    address public treasury;

    /// @notice Protocol fee in basis points (default 0, max 500 = 5%)
    uint256 public protocolFeeBp;

    /// @notice Maximum protocol fee (5%)
    uint256 public constant MAX_FEE_BP = 500;

    /// @notice Minimum fee amount ($0.01 USDC = 10000 in 6 decimals)
    uint256 public constant MIN_FEE = 10_000;

    /// @notice Basis points denominator
    uint256 private constant BP = 10_000;

    /// @notice Facilitator share of protocol fee (70%)
    uint256 public constant FACILITATOR_SHARE_BP = 7_000;
```

After `DeadlineTooFar` error (line 61), add:

```solidity
    error InvalidTreasury();
    error FeeTooHigh();
```

**Step 2: Add facilitator to createEscrow**

Update `createEscrow` function signature (line 83-91) to add `address facilitator` parameter.
Update the Escrow struct initialization (line 120-134) to include `facilitator: facilitator`.

```solidity
    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline,
        address facilitator  // NEW
    ) external override returns (uint256 escrowId) {
        // ... existing validations unchanged ...

        _escrows[escrowId] = Escrow({
            id: escrowId,
            clientDid: clientDid,
            providerDid: providerDid,
            clientAddress: msg.sender,
            providerAddress: providerAddress,
            amount: amount,
            token: token,
            taskHash: taskHash,
            outputHash: bytes32(0),
            deadline: deadline,
            state: State.AWAITING_DEPOSIT,
            createdAt: block.timestamp,
            deliveredAt: 0,
            facilitator: facilitator  // NEW
        });

        emit EscrowCreated(escrowId, clientDid, providerDid, amount, deadline);
    }
```

**Step 3: Add fee deduction to releaseEscrow**

Replace line 200 (`IERC20(e.token).safeTransfer(e.providerAddress, e.amount);`) with:

```solidity
        // Deduct protocol fee and transfer
        uint256 netAmount = _deductAndTransferFee(e.token, e.amount, e.facilitator, escrowId);
        IERC20(e.token).safeTransfer(e.providerAddress, netAmount);
```

**Step 4: Add fee deduction to resolveDispute**

Replace lines 264-270 (the transfer block in resolveDispute) with:

```solidity
        // Transfer funds with fee deduction
        if (providerShare > 0) {
            uint256 netProvider = _deductAndTransferFee(e.token, providerShare, e.facilitator, escrowId);
            IERC20(e.token).safeTransfer(e.providerAddress, netProvider);
        }
        if (clientShare > 0) {
            uint256 netClient = _deductAndTransferFee(e.token, clientShare, e.facilitator, escrowId);
            IERC20(e.token).safeTransfer(e.clientAddress, netClient);
        }
```

**Step 5: Add admin functions**

After `isTokenAllowed` (line 334), before Internal Functions section, add:

```solidity
    // ============ Protocol Fee Functions ============

    /// @notice Set the protocol treasury address
    /// @param _treasury New treasury address
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert InvalidTreasury();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Set the protocol fee in basis points
    /// @param _feeBp New fee in basis points (max 500 = 5%)
    function setProtocolFeeBp(uint256 _feeBp) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBp > MAX_FEE_BP) revert FeeTooHigh();
        protocolFeeBp = _feeBp;
        emit ProtocolFeeUpdated(_feeBp);
    }
```

**Step 6: Add internal fee calculation function**

After `_recordTransaction` (line 364), add:

```solidity
    /// @notice Deduct protocol fee and transfer to facilitator/treasury
    /// @param token Token address
    /// @param amount Amount to deduct fee from
    /// @param _facilitator Node operator address
    /// @param escrowId Escrow ID for event
    /// @return netAmount Amount after fee deduction
    function _deductAndTransferFee(
        address token,
        uint256 amount,
        address _facilitator,
        uint256 escrowId
    ) internal returns (uint256 netAmount) {
        if (protocolFeeBp == 0 || treasury == address(0)) {
            return amount;
        }

        uint256 fee = (amount * protocolFeeBp) / BP;

        // Apply minimum fee
        if (fee > 0 && fee < MIN_FEE) {
            fee = MIN_FEE;
        }

        // Safety: fee cannot exceed amount
        if (fee >= amount) {
            fee = amount / 2;  // Cap at 50% as safety
        }

        if (fee > 0) {
            uint256 facilitatorShare;
            uint256 treasuryShare;

            if (_facilitator != address(0)) {
                facilitatorShare = (fee * FACILITATOR_SHARE_BP) / BP;
                treasuryShare = fee - facilitatorShare;
                IERC20(token).safeTransfer(_facilitator, facilitatorShare);
            } else {
                treasuryShare = fee;
            }

            IERC20(token).safeTransfer(treasury, treasuryShare);

            emit ProtocolFeeCollected(escrowId, fee, _facilitator, facilitatorShare, treasuryShare);
        }

        return amount - fee;
    }
```

**Step 7: Run tests to verify they pass**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test --match-path "test/EscrowProtocolFee.t.sol" -vvv 2>&1 | tail -30`
Expected: All tests PASS

**Step 8: Run ALL existing tests to verify no regressions**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test 2>&1 | tail -20`
Expected: Existing tests will FAIL because `createEscrow` signature changed. Fix them in next step.

**Step 9: Update existing test calls to include facilitator parameter**

In `contracts/test/AgentMeshEscrow.t.sol`, update all `createEscrow` calls to add `address(0)` as the last argument (no facilitator in legacy tests). Search and replace all occurrences of the pattern:

```
escrow.createEscrow(clientDid, providerDid, provider, address(usdc), AMOUNT, taskHash, deadline)
```
→
```
escrow.createEscrow(clientDid, providerDid, provider, address(usdc), AMOUNT, taskHash, deadline, address(0))
```

Do the same for `contracts/test/Integration.t.sol` and `contracts/test/DisputeResolution.t.sol`.

**Step 10: Run full test suite**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test 2>&1 | tail -20`
Expected: ALL tests PASS

**Step 11: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/src/AgoraMeshEscrow.sol contracts/src/interfaces/IAgoraMeshEscrow.sol contracts/test/
git commit -m "feat(contracts): implement protocol fee in AgoraMeshEscrow with facilitator split"
```

---

### Task 4: Update IStreamingPayments Interface

**Files:**
- Modify: `contracts/src/interfaces/IStreamingPayments.sol`

**Step 1: Add facilitator to Stream struct**

In `IStreamingPayments.sol`, add `facilitator` field to Stream struct (after `cancelableByRecipient` on line 36):

```solidity
    struct Stream {
        // ... existing fields ...
        bool cancelableByRecipient;
        address facilitator;  // NEW: Node operator address
    }
```

**Step 2: Add new events**

After `StreamCompleted` event (line 68), add:

```solidity
    event ProtocolFeeCollected(
        uint256 indexed streamId,
        uint256 totalFee,
        address indexed facilitator,
        uint256 facilitatorShare,
        uint256 treasuryShare
    );
    event TreasuryUpdated(address indexed newTreasury);
    event ProtocolFeeUpdated(uint256 newFeeBp);
```

**Step 3: Add facilitator to createStream signatures**

Update both `createStream` (line 81-89) and `createStreamWithTimestamps` (line 101-110) to include `address facilitator` parameter.

**Step 4: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/src/interfaces/IStreamingPayments.sol
git commit -m "feat(contracts): add facilitator and protocol fee to IStreamingPayments interface"
```

---

### Task 5: Write Failing Streaming Protocol Fee Tests

**Files:**
- Create: `contracts/test/StreamingProtocolFee.t.sol`

**Step 1: Write the test file**

Create `contracts/test/StreamingProtocolFee.t.sol` with tests for:
- `test_setTreasury_setsAddress`
- `test_setProtocolFeeBp_setsValue`
- `test_createStream_storesFacilitator`
- `test_withdraw_deductsProtocolFee` — verify recipient gets amount - 0.5%
- `test_withdraw_splitsFee_70_30` — verify facilitator/treasury split
- `test_withdrawMax_deductsProtocolFee`
- `test_cancel_deductsFeeFromRecipientOnly` — sender refund is untouched
- `test_cancel_splitsFee_70_30`
- `test_withdraw_zeroFee_fullAmount` — protocolFeeBp=0
- `test_withdraw_noFacilitator_allToTreasury`
- `testFuzz_withdraw_feeNeverExceedsAmount`

Follow same patterns as EscrowProtocolFee.t.sol: setUp with registry, stream creation, token minting, fee configuration.

**Step 2: Verify tests fail**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test --match-path "test/StreamingProtocolFee.t.sol" 2>&1 | tail -10`
Expected: Compilation errors

**Step 3: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/test/StreamingProtocolFee.t.sol
git commit -m "test(contracts): add failing protocol fee tests for streaming (TDD red)"
```

---

### Task 6: Implement Protocol Fee in StreamingPayments

**Files:**
- Modify: `contracts/src/StreamingPayments.sol`

**Step 1: Add state variables**

After line 51 (`mapping(uint256 => uint256) private _streamedAtCancel;`), add:

```solidity
    address public treasury;
    uint256 public protocolFeeBp;
    uint256 public constant MAX_FEE_BP = 500;
    uint256 public constant MIN_FEE = 10_000;
    uint256 private constant BP = 10_000;
    uint256 public constant FACILITATOR_SHARE_BP = 7_000;
```

**Step 2: Add facilitator to _createStreamInternal**

Update `_createStreamInternal` signature (line 111-119) to include `address _facilitator`.
Add `facilitator: _facilitator` to Stream struct init (line 140-155).
Update both `createStream` and `createStreamWithTimestamps` to pass the new parameter.

**Step 3: Add fee deduction to withdraw/withdrawMax**

In `withdraw()` (line 186), replace the direct transfer with:
```solidity
        uint256 netAmount = _deductAndTransferFee(stream.token, amount, _streams[streamId].facilitator, streamId);
        IERC20(stream.token).safeTransfer(stream.recipient, netAmount);
```

Same pattern for `withdrawMax()` (line 206).

**Step 4: Add fee deduction to cancel**

In `cancel()` (lines 291-294), deduct fee only from `recipientAmount`:
```solidity
        if (recipientAmount > 0) {
            uint256 netRecipient = _deductAndTransferFee(stream.token, recipientAmount, stream.facilitator, streamId);
            IERC20(stream.token).safeTransfer(stream.recipient, netRecipient);
        }
        // Sender refund is untouched - no fee on refund
        if (senderRefund > 0) {
            IERC20(stream.token).safeTransfer(stream.sender, senderRefund);
        }
```

**Step 5: Add admin functions and _deductAndTransferFee**

Copy the same pattern from AgoraMeshEscrow: `setTreasury()`, `setProtocolFeeBp()`, `_deductAndTransferFee()`.

**Step 6: Update existing streaming tests**

Add `address(0)` facilitator parameter to all existing `createStream` and `createStreamWithTimestamps` calls in `contracts/test/StreamingPayments.t.sol`.

**Step 7: Run all tests**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test 2>&1 | tail -20`
Expected: ALL tests PASS

**Step 8: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/src/StreamingPayments.sol contracts/src/interfaces/IStreamingPayments.sol contracts/test/
git commit -m "feat(contracts): implement protocol fee in StreamingPayments with facilitator split"
```

---

### Task 7: Update Deployment Script

**Files:**
- Modify: `contracts/script/Deploy.s.sol`

**Step 1: Add treasury configuration after contract deployment**

After `_configureRoles(c)` call (line 61), add a new `_configureProtocolFees(c)` call:

```solidity
    function _configureProtocolFees(DeployedContracts memory c) internal {
        console.log("\nConfiguring protocol fees...");

        address admin = msg.sender;  // treasury = admin initially

        AgoraMeshEscrow escrowContract = AgoraMeshEscrow(c.escrow);
        escrowContract.setTreasury(admin);
        escrowContract.setProtocolFeeBp(50);  // 0.5%
        console.log("- Escrow: treasury set, fee = 0.5%");

        StreamingPayments streamingContract = StreamingPayments(c.streaming);
        streamingContract.setTreasury(admin);
        streamingContract.setProtocolFeeBp(50);  // 0.5%
        console.log("- Streaming: treasury set, fee = 0.5%");
    }
```

**Step 2: Run deployment test**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test --match-path "test/Deploy.t.sol" 2>&1 | tail -10`
Expected: PASS (or update test if it calls createEscrow)

**Step 3: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/script/Deploy.s.sol
git commit -m "feat(contracts): configure protocol fees in deployment script"
```

---

### Task 8: Update Bridge Escrow Integration

**Files:**
- Modify: `bridge/src/escrow.ts`

**Step 1: Add facilitator to Escrow interface**

In `bridge/src/escrow.ts`, add `facilitator` field to Escrow interface (after `deliveredAt` on line 45):

```typescript
export interface Escrow {
  // ... existing fields ...
  deliveredAt: bigint;
  facilitator: `0x${string}`;  // NEW
}
```

**Step 2: Update ABI**

Add `facilitator` to the getEscrow ABI tuple components (after `deliveredAt` component on line 95):

```typescript
          { name: 'facilitator', type: 'address' },
```

**Step 3: Update getEscrowResult to map facilitator**

In `getEscrowResult` method (line 186-200), add:
```typescript
        facilitator: result.facilitator,
```

**Step 4: Add createEscrow ABI and method**

Add `createEscrow` to the ESCROW_ABI with the new `facilitator` parameter, and add a `createEscrow` method to `EscrowClient` that passes `this.account?.address ?? '0x0'` as facilitator.

**Step 5: Run bridge tests**

Run: `cd /home/lada/projects/agoramesh/bridge && npm test 2>&1 | tail -20`
Expected: PASS (or update mocks if tests create escrow data)

**Step 6: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/escrow.ts
git commit -m "feat(bridge): add facilitator support to escrow client"
```

---

### Task 9: Update Documentation

**Files:**
- Modify: `docs/specs/payment-layer.md`
- Modify: `docs/reference/faq.md`
- Modify: `docs/tutorials/running-a-node.md`

**Step 1: Update payment-layer.md**

Add "Protocol Fees" section explaining:
- 0.5% fee on escrow release and streaming withdraw
- 70/30 facilitator/treasury split
- x402 remains free
- Fee is deducted from provider payout

**Step 2: Update FAQ**

Add to Payments section:
- "Does AgoraMesh charge fees?" → 0.5% on escrow/streaming, x402 free
- "How do node operators earn money?" → 70% of protocol fees

**Step 3: Update running-a-node.md**

Add section about node operator revenue:
- Node wallet is registered as facilitator
- Earns 70% of 0.5% fee on transactions through their node
- Revenue example calculation

**Step 4: Commit**

```bash
cd /home/lada/projects/agoramesh
git add docs/
git commit -m "docs: add protocol fee documentation to specs, FAQ, and node guide"
```

---

### Task 10: Update Website

**Files:**
- Modify: Website source (Astro) to add pricing info
- Modify: `/var/www/agoramesh/llms.txt` (or regenerate)

**Step 1: Find website source**

Check for Astro source in `/home/lada/projects/agoramesh/website/` or similar directory.

**Step 2: Add pricing section to landing page or create pricing page**

Add transparent fee breakdown:
- x402 Direct: FREE
- Escrow: 0.5% (deducted from provider)
- Streaming: 0.5% (deducted from recipient)
- Node operators earn 70% of fees

**Step 3: Update FAQ on website**

Add "How does AgoraMesh make money?" to embedded FAQ.

**Step 4: Update llms.txt**

Add fee information:
```
## Fees
- x402 direct payments: 0% (free, peer-to-peer)
- Escrow payments: 0.5% protocol fee (deducted from provider payout)
- Streaming payments: 0.5% protocol fee (deducted from recipient)
- Fee split: 70% to node operator (facilitator), 30% to protocol treasury
- Dispute filing: 3% (Tier 2) or 5% (Tier 3) + minimum
```

**Step 5: Build and deploy website**

Run the Astro build and copy to `/var/www/agoramesh/`.

**Step 6: Commit**

```bash
cd /home/lada/projects/agoramesh
git add website/ docs/
git commit -m "feat(website): add pricing information and fee transparency"
```

---

### Task 11: Final Integration Test & Gas Report

**Files:**
- Modify: `contracts/test/Integration.t.sol`

**Step 1: Add integration test**

Add to `Integration.t.sol`:

```solidity
function test_endToEnd_escrowWithProtocolFee() public {
    // Configure fee
    vm.startPrank(admin);
    escrow.setTreasury(treasury);
    escrow.setProtocolFeeBp(50);
    vm.stopPrank();

    // Full lifecycle: create → fund → deliver → release
    // Verify: provider gets 99.5%, facilitator gets 0.35%, treasury gets 0.15%
}

function test_endToEnd_streamWithProtocolFee() public {
    // Configure fee
    // Full lifecycle: create → withdraw → verify fee
}
```

**Step 2: Run full test suite with gas report**

Run: `cd /home/lada/projects/agoramesh/contracts && forge test --gas-report 2>&1 | tail -40`
Expected: ALL PASS, gas report shows reasonable overhead for fee logic

**Step 3: Commit**

```bash
cd /home/lada/projects/agoramesh
git add contracts/test/Integration.t.sol
git commit -m "test(contracts): add end-to-end integration tests with protocol fees"
```

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | IAgoraMeshEscrow interface | 1 modified | — |
| 2 | Escrow fee tests (TDD red) | 1 created | 14 tests |
| 3 | Escrow fee implementation (TDD green) | 2 modified + test fixes | All pass |
| 4 | IStreamingPayments interface | 1 modified | — |
| 5 | Streaming fee tests (TDD red) | 1 created | 11 tests |
| 6 | Streaming fee implementation (TDD green) | 2 modified + test fixes | All pass |
| 7 | Deploy script | 1 modified | — |
| 8 | Bridge escrow client | 1 modified | Bridge tests pass |
| 9 | Documentation | 3 modified | — |
| 10 | Website | Multiple | — |
| 11 | Integration tests + gas | 1 modified | E2E pass |

**Total: ~11 commits, 25+ new tests, 8-10 files modified**
