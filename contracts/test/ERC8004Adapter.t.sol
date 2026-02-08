// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ERC8004Adapter.sol";
import "../src/TrustRegistry.sol";
import "../src/AgentToken.sol";
import "../src/MockUSDC.sol";

/// @title ERC8004Adapter Tests
/// @notice Comprehensive tests for the ERC-8004 read-only adapter
contract ERC8004AdapterTest is Test {
    ERC8004Adapter public adapter;
    TrustRegistry public registry;
    AgentToken public agentToken;
    MockUSDC public usdc;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public alice = address(0x4);
    address public bob = address(0x5);
    address public treasury = address(0x6);

    bytes32 public aliceDid = keccak256("did:agentmesh:alice");
    bytes32 public bobDid = keccak256("did:agentmesh:bob");

    string public aliceCID = "QmAliceCapabilityCard123";
    string public bobCID = "QmBobCapabilityCard456";
    string public aliceTokenURI = "ipfs://QmAliceTokenUri";
    string public bobTokenURI = "ipfs://QmBobTokenUri";

    uint256 public aliceTokenId;

    function setUp() public {
        // Deploy MockUSDC
        usdc = new MockUSDC();

        // Deploy TrustRegistry
        vm.prank(admin);
        registry = new TrustRegistry(address(usdc), admin);

        // Grant oracle role
        vm.startPrank(admin);
        registry.grantRole(registry.ORACLE_ROLE(), oracle);
        vm.stopPrank();

        // Deploy AgentToken
        vm.prank(admin);
        agentToken = new AgentToken("AgentMesh Agents", "AGENT", address(usdc), treasury, admin);

        // Deploy ERC8004Adapter
        adapter = new ERC8004Adapter(address(registry), address(agentToken));

        // Mint USDC to test users
        usdc.mint(alice, 100_000 * 1e6);
        usdc.mint(bob, 100_000 * 1e6);

        // Approve USDC for AgentToken (mint fee) and TrustRegistry (staking)
        vm.prank(alice);
        usdc.approve(address(agentToken), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(registry), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(agentToken), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(registry), type(uint256).max);

        // Register alice in TrustRegistry
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        // Mint alice's agent token in AgentToken
        vm.prank(alice);
        aliceTokenId = agentToken.mintAgent(aliceDid, aliceCID, aliceTokenURI, 500);
    }

    // ============ Identity Tests - Write Functions Revert ============

    function test_Register_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ReadOnlyAdapter.selector);
        adapter.register("some-uri");
    }

    function test_SetAgentURI_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ReadOnlyAdapter.selector);
        adapter.setAgentURI(aliceTokenId, "new-uri");
    }

    function test_SetMetadata_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ReadOnlyAdapter.selector);
        adapter.setMetadata(aliceTokenId, "key", "value");
    }

    // ============ Identity Tests - View Functions ============

    function test_GetAgentWallet() public {
        address wallet = adapter.getAgentWallet(aliceTokenId);
        assertEq(wallet, alice);
    }

    function test_GetMetadata_DidHash() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "didHash");
        bytes32 decoded = abi.decode(result, (bytes32));
        assertEq(decoded, aliceDid);
    }

    function test_GetMetadata_CapabilityCID() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "capabilityCID");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, aliceCID);
    }

    function test_GetMetadata_IsActive() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "isActive");
        bool decoded = abi.decode(result, (bool));
        assertTrue(decoded);
    }

    function test_GetMetadata_UnknownKey() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "unknownKey");
        assertEq(result.length, 0);
    }

    function test_GetMetadata_AgentNotFound() public {
        uint256 nonExistentId = 999;
        vm.expectRevert(ERC8004Adapter.AgentNotFound.selector);
        adapter.getMetadata(nonExistentId, "didHash");
    }

    // ============ Reputation Tests ============

    function test_GetIdentityRegistry() public {
        address identityRegistry = adapter.getIdentityRegistry();
        assertEq(identityRegistry, address(adapter));
    }

    function test_GetSummary_Reputation_NoData() public {
        address[] memory clients = new address[](0);
        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) =
            adapter.getSummary(aliceTokenId, clients, "", "");

        assertEq(count, 0);
        assertEq(summaryValue, 0);
        assertEq(summaryValueDecimals, 2);
    }

    function test_GetSummary_Reputation_WithData() public {
        // Record some transactions via the oracle
        vm.startPrank(oracle);
        registry.recordTransaction(aliceDid, 100_00, true);
        registry.recordTransaction(aliceDid, 200_00, true);
        registry.recordTransaction(aliceDid, 50_00, false);
        vm.stopPrank();

        address[] memory clients = new address[](0);
        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) =
            adapter.getSummary(aliceTokenId, clients, "", "");

        assertEq(count, 3);
        assertTrue(summaryValue > 0);
        assertEq(summaryValueDecimals, 2);
    }

    function test_ReadFeedback_ReturnsZero() public {
        (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked) =
            adapter.readFeedback(aliceTokenId, alice, 0);

        assertEq(value, 0);
        assertEq(valueDecimals, 0);
        assertEq(bytes(tag1).length, 0);
        assertEq(bytes(tag2).length, 0);
        assertFalse(isRevoked);
    }

    function test_GetClients_ReturnsEmpty() public {
        address[] memory clients = adapter.getClients(aliceTokenId);
        assertEq(clients.length, 0);
    }

    function test_GetLastIndex_ReturnsZero() public {
        uint64 lastIndex = adapter.getLastIndex(aliceTokenId, alice);
        assertEq(lastIndex, 0);
    }

    // ============ Validation Tests ============

    function test_GetValidationStatus_ReturnsZero() public {
        bytes32 requestHash = keccak256("some-request");
        (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        ) = adapter.getValidationStatus(requestHash);

        assertEq(validatorAddress, address(0));
        assertEq(agentId, 0);
        assertEq(response, 0);
        assertEq(responseHash, bytes32(0));
        assertEq(bytes(tag).length, 0);
        assertEq(lastUpdate, 0);
    }

    function test_GetSummary_Validation_NoData() public {
        address[] memory validators = new address[](0);
        (uint64 count, uint8 averageResponse) = adapter.getSummary(aliceTokenId, validators, "");

        assertEq(count, 0);
        assertEq(averageResponse, 0);
    }

    function test_GetSummary_Validation_HighTrust() public {
        // Give alice high trust: full stake + many successful transactions
        vm.prank(alice);
        registry.depositStake(aliceDid, 10_000 * 1e6); // Full reference stake

        vm.startPrank(oracle);
        for (uint256 i = 0; i < 100; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        vm.stopPrank();

        // Verify trust score is > 5000
        uint256 trustScore = registry.getTrustScore(aliceDid);
        assertTrue(trustScore > 5000, "Trust score should be > 5000 for this test");

        address[] memory validators = new address[](0);
        (uint64 count, uint8 averageResponse) = adapter.getSummary(aliceTokenId, validators, "");

        assertEq(count, 1);
        assertEq(averageResponse, 1); // valid
    }

    function test_GetSummary_Validation_LowTrust() public {
        // Give alice low trust: small stake, some failed transactions
        vm.prank(alice);
        registry.depositStake(aliceDid, 100 * 1e6); // Minimum stake

        vm.startPrank(oracle);
        registry.recordTransaction(aliceDid, 100_00, true);
        registry.recordTransaction(aliceDid, 100_00, false);
        vm.stopPrank();

        // Verify trust score is <= 5000
        uint256 trustScore = registry.getTrustScore(aliceDid);
        assertTrue(trustScore <= 5000, "Trust score should be <= 5000 for this test");

        address[] memory validators = new address[](0);
        (uint64 count, uint8 averageResponse) = adapter.getSummary(aliceTokenId, validators, "");

        assertEq(count, 1);
        assertEq(averageResponse, 2); // invalid
    }

    function test_GetAgentValidations_ReturnsEmpty() public {
        bytes32[] memory validations = adapter.getAgentValidations(aliceTokenId);
        assertEq(validations.length, 0);
    }

    // ============ Metadata - registeredAt ============

    function test_GetMetadata_RegisteredAt() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "registeredAt");
        uint256 decoded = abi.decode(result, (uint256));
        // registeredAt should be the block.timestamp when alice registered
        assertTrue(decoded > 0, "registeredAt should be non-zero");
    }

    // ============ ValueOverflow Tests ============

    function test_GetSummary_Reputation_OverflowTransactions() public {
        // Mock getReputation to return transactions > type(uint64).max
        bytes32 didHash = aliceDid;
        uint256 hugeTransactions = uint256(type(uint64).max) + 1;
        vm.mockCall(
            address(registry),
            abi.encodeWithSelector(registry.getReputation.selector, didHash),
            abi.encode(uint256(5000), hugeTransactions, uint256(10000))
        );

        address[] memory clients = new address[](0);
        vm.expectRevert(ERC8004Adapter.ValueOverflow.selector);
        adapter.getSummary(aliceTokenId, clients, "", "");
    }

    function test_GetSummary_Reputation_OverflowScore() public {
        // Mock getReputation to return score > int128.max
        bytes32 didHash = aliceDid;
        uint256 hugeScore = uint256(uint128(type(int128).max)) + 1;
        vm.mockCall(
            address(registry),
            abi.encodeWithSelector(registry.getReputation.selector, didHash),
            abi.encode(hugeScore, uint256(10), uint256(10000))
        );

        address[] memory clients = new address[](0);
        vm.expectRevert(ERC8004Adapter.ValueOverflow.selector);
        adapter.getSummary(aliceTokenId, clients, "", "");
    }

    // ============ Constructor - ZeroAddress Tests ============

    function test_Constructor_ZeroTrustRegistry_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ZeroAddress.selector);
        new ERC8004Adapter(address(0), address(agentToken));
    }

    function test_Constructor_ZeroAgentToken_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ZeroAddress.selector);
        new ERC8004Adapter(address(registry), address(0));
    }

    // ============ Convenience Tests ============

    function test_GetAgentIdByDid() public {
        uint256 tokenId = adapter.getAgentIdByDid(aliceDid);
        assertEq(tokenId, aliceTokenId);
    }
}
