// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ERC8004Adapter.sol";
import "../src/TrustRegistry.sol";
import "../src/AgentToken.sol";
import "../src/MockUSDC.sol";
import "../src/interfaces/IERC8004Identity.sol";

// ============ Mock Canonical ERC-8004 Registries ============

/// @notice Mock canonical ERC-8004 IdentityRegistry for dual registration testing
contract MockCanonicalIdentityRegistry is IERC8004IdentityRegistry {
    uint256 private _nextAgentId = 1;
    mapping(uint256 => string) private _agentURIs;
    mapping(uint256 => address) private _agentOwners;
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _agentURIs[agentId] = agentURI;
        _agentOwners[agentId] = msg.sender;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _agentURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _metadata[agentId][keccak256(bytes(metadataKey))] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentOwners[agentId];
    }

    // Test helper
    function getAgentURI(uint256 agentId) external view returns (string memory) {
        return _agentURIs[agentId];
    }
}

/// @notice Mock canonical ERC-8004 ReputationRegistry
contract MockCanonicalReputationRegistry is IERC8004ReputationRegistry {
    address private _identityRegistry;

    constructor(address identityReg) {
        _identityRegistry = identityReg;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        return (0, 0, 2);
    }

    function readFeedback(uint256, address, uint64)
        external
        pure
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        return (0, 0, "", "", false);
    }

    function getClients(uint256) external pure returns (address[] memory) {
        return new address[](0);
    }

    function getLastIndex(uint256, address) external pure returns (uint64) {
        return 0;
    }
}

// ============ Test Contract ============

/// @title ERC8004Adapter Tests
/// @notice Comprehensive tests for the ERC-8004 adapter with dual registration and feedback relay
contract ERC8004AdapterTest is Test {
    ERC8004Adapter public adapter;
    TrustRegistry public registry;
    AgentToken public agentToken;
    MockUSDC public usdc;
    MockCanonicalIdentityRegistry public canonicalIdentity;
    MockCanonicalReputationRegistry public canonicalReputation;

    address public admin = address(0x1);
    address public oracle = address(0x2);
    address public relayer = address(0x3);
    address public alice = address(0x4);
    address public bob = address(0x5);
    address public treasury = address(0x6);
    address public nonOwner = address(0x7);

    bytes32 public aliceDid = keccak256("did:agoramesh:alice");
    bytes32 public bobDid = keccak256("did:agoramesh:bob");

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
        agentToken = new AgentToken("AgoraMesh Agents", "AGENT", address(usdc), treasury, admin);

        // Deploy mock canonical registries
        canonicalIdentity = new MockCanonicalIdentityRegistry();
        canonicalReputation = new MockCanonicalReputationRegistry(address(canonicalIdentity));

        // Deploy ERC8004Adapter with admin and configure
        vm.startPrank(admin);
        adapter = new ERC8004Adapter(address(registry), address(agentToken), admin);
        adapter.grantRole(adapter.RELAY_ROLE(), relayer);
        registry.grantRole(registry.ORACLE_ROLE(), address(adapter));
        adapter.setCanonicalIdentityRegistry(address(canonicalIdentity));
        adapter.setCanonicalReputationRegistry(address(canonicalReputation));
        vm.stopPrank();

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

    // ============ Constructor Tests ============

    function test_Constructor_SetsValues() public {
        assertEq(address(adapter.trustRegistry()), address(registry));
        assertEq(address(adapter.agentToken()), address(agentToken));
        assertEq(adapter.defaultFeedbackVolumeUsd(), 100_00);
        assertTrue(adapter.hasRole(adapter.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(adapter.hasRole(adapter.RELAY_ROLE(), admin));
    }

    function test_Constructor_ZeroTrustRegistry_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ZeroAddress.selector);
        new ERC8004Adapter(address(0), address(agentToken), admin);
    }

    function test_Constructor_ZeroAgentToken_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ZeroAddress.selector);
        new ERC8004Adapter(address(registry), address(0), admin);
    }

    function test_Constructor_ZeroAdmin_Reverts() public {
        vm.expectRevert(ERC8004Adapter.ZeroAddress.selector);
        new ERC8004Adapter(address(registry), address(agentToken), address(0));
    }

    // ============ Dual Registration Tests ============

    function test_Register_DualRegistration() public {
        vm.prank(alice);
        uint256 agentId = adapter.register("ipfs://QmAliceCapCard");

        assertEq(agentId, aliceTokenId);
        assertTrue(adapter.isDualRegistered(aliceTokenId));
        assertEq(adapter.totalDualRegistered(), 1);

        // Verify canonical registry received the registration
        uint256 canonicalId = adapter.agoraMeshToCanonical(aliceTokenId);
        assertTrue(canonicalId > 0);
        assertEq(adapter.canonicalToAgoraMesh(canonicalId), aliceTokenId);
    }

    function test_Register_EmitsEvents() public {
        vm.expectEmit(true, true, false, true);
        emit ERC8004Adapter.DualRegistered(aliceTokenId, 1, "ipfs://QmAliceCapCard");

        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");
    }

    function test_Register_AlreadyRegistered_Reverts() public {
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");

        vm.expectRevert(abi.encodeWithSelector(ERC8004Adapter.AlreadyRegisteredOnCanonical.selector, aliceTokenId));
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard2");
    }

    function test_Register_NoAgent_Reverts() public {
        vm.expectRevert(ERC8004Adapter.AgentNotFound.selector);
        vm.prank(nonOwner);
        adapter.register("ipfs://QmNoAgent");
    }

    function test_Register_WithoutCanonicalRegistry() public {
        // Deploy a fresh adapter without canonical registry
        ERC8004Adapter freshAdapter = new ERC8004Adapter(address(registry), address(agentToken), admin);

        // Should still succeed but not dual-register
        vm.prank(alice);
        uint256 agentId = freshAdapter.register("ipfs://QmAliceCapCard");

        assertEq(agentId, aliceTokenId);
        assertFalse(freshAdapter.isDualRegistered(aliceTokenId));
        assertEq(freshAdapter.totalDualRegistered(), 0);
    }

    // ============ SetAgentURI Tests ============

    function test_SetAgentURI_ForwardsToCanonical() public {
        // First register
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");

        // Update URI
        vm.prank(alice);
        adapter.setAgentURI(aliceTokenId, "ipfs://QmNewURI");

        // Verify on canonical registry
        uint256 canonicalId = adapter.agoraMeshToCanonical(aliceTokenId);
        string memory storedURI = canonicalIdentity.getAgentURI(canonicalId);
        assertEq(storedURI, "ipfs://QmNewURI");
    }

    function test_SetAgentURI_NotOwner_Reverts() public {
        vm.expectRevert(ERC8004Adapter.NotAgentOwner.selector);
        vm.prank(bob);
        adapter.setAgentURI(aliceTokenId, "ipfs://QmHack");
    }

    // ============ SetMetadata Tests ============

    function test_SetMetadata_ForwardsToCanonical() public {
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");

        vm.prank(alice);
        adapter.setMetadata(aliceTokenId, "description", abi.encode("AI Assistant"));

        uint256 canonicalId = adapter.agoraMeshToCanonical(aliceTokenId);
        bytes memory result = canonicalIdentity.getMetadata(canonicalId, "description");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, "AI Assistant");
    }

    function test_SetMetadata_NotOwner_Reverts() public {
        vm.expectRevert(ERC8004Adapter.NotAgentOwner.selector);
        vm.prank(bob);
        adapter.setMetadata(aliceTokenId, "key", "value");
    }

    // ============ Feedback Relay Tests ============

    function test_RelayFeedback_PositiveSuccess() public {
        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 85, 0);

        // Verify TrustRegistry was updated
        (uint256 score, uint256 transactions,) = registry.getReputation(aliceDid);
        assertEq(transactions, 1);
        assertTrue(score > 0);
    }

    function test_RelayFeedback_NegativeFail() public {
        // First add a successful tx so we can see the failure effect
        vm.prank(oracle);
        registry.recordTransaction(aliceDid, 100_00, true);

        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, -50, 0);

        (, uint256 transactions,) = registry.getReputation(aliceDid);
        assertEq(transactions, 2);
    }

    function test_RelayFeedback_ZeroFeedbackIsFail() public {
        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 0, 0);

        (, uint256 transactions, uint256 successRate) = registry.getReputation(aliceDid);
        assertEq(transactions, 1);
        assertEq(successRate, 0); // 0% success
    }

    function test_RelayFeedback_CustomVolume() public {
        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 100, 500_00); // $500 volume

        (, uint256 transactions,) = registry.getReputation(aliceDid);
        assertEq(transactions, 1);
    }

    function test_RelayFeedback_DefaultVolume() public {
        assertEq(adapter.defaultFeedbackVolumeUsd(), 100_00);

        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 100, 0); // Use default

        (, uint256 transactions,) = registry.getReputation(aliceDid);
        assertEq(transactions, 1);
    }

    function test_RelayFeedback_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ERC8004Adapter.FeedbackRelayed(aliceTokenId, 85, true, 100_00);

        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 85, 0);
    }

    function test_RelayFeedback_NonRelayer_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        adapter.relayFeedback(aliceTokenId, 85, 0);
    }

    function test_RelayFeedback_AgentNotFound_Reverts() public {
        vm.prank(relayer);
        vm.expectRevert(ERC8004Adapter.AgentNotFound.selector);
        adapter.relayFeedback(999, 85, 0);
    }

    // ============ Batch Feedback Relay Tests ============

    function test_RelayFeedbackBatch() public {
        // Register bob
        vm.prank(bob);
        registry.registerAgent(bobDid, bobCID);
        vm.prank(bob);
        uint256 bobTokenId = agentToken.mintAgent(bobDid, bobCID, bobTokenURI, 500);

        uint256[] memory agentIds = new uint256[](2);
        agentIds[0] = aliceTokenId;
        agentIds[1] = bobTokenId;

        int128[] memory values = new int128[](2);
        values[0] = 90;
        values[1] = -20;

        uint256[] memory volumes = new uint256[](2);
        volumes[0] = 0; // default
        volumes[1] = 200_00; // $200

        vm.prank(relayer);
        adapter.relayFeedbackBatch(agentIds, values, volumes);

        // Verify alice got success
        (, uint256 aliceTx,) = registry.getReputation(aliceDid);
        assertEq(aliceTx, 1);

        // Verify bob got failure
        (, uint256 bobTx,) = registry.getReputation(bobDid);
        assertEq(bobTx, 1);
    }

    function test_RelayFeedbackBatch_LengthMismatch_Reverts() public {
        uint256[] memory agentIds = new uint256[](2);
        int128[] memory values = new int128[](1);
        uint256[] memory volumes = new uint256[](2);

        vm.prank(relayer);
        vm.expectRevert();
        adapter.relayFeedbackBatch(agentIds, values, volumes);
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

    function test_GetMetadata_RegisteredAt() public {
        bytes memory result = adapter.getMetadata(aliceTokenId, "registeredAt");
        uint256 decoded = abi.decode(result, (uint256));
        assertTrue(decoded > 0, "registeredAt should be non-zero");
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
        vm.prank(alice);
        registry.depositStake(aliceDid, 10_000 * 1e6);

        vm.startPrank(oracle);
        for (uint256 i = 0; i < 100; i++) {
            registry.recordTransaction(aliceDid, 100_00, true);
        }
        vm.stopPrank();

        uint256 trustScore = registry.getTrustScore(aliceDid);
        assertTrue(trustScore > 5000, "Trust score should be > 5000 for this test");

        address[] memory validators = new address[](0);
        (uint64 count, uint8 averageResponse) = adapter.getSummary(aliceTokenId, validators, "");

        assertEq(count, 1);
        assertEq(averageResponse, 1); // valid
    }

    function test_GetSummary_Validation_LowTrust() public {
        vm.prank(alice);
        registry.depositStake(aliceDid, 100 * 1e6);

        vm.startPrank(oracle);
        registry.recordTransaction(aliceDid, 100_00, true);
        registry.recordTransaction(aliceDid, 100_00, false);
        vm.stopPrank();

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

    // ============ ValueOverflow Tests ============

    function test_GetSummary_Reputation_OverflowTransactions() public {
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

    // ============ Convenience Tests ============

    function test_GetAgentIdByDid() public {
        uint256 tokenId = adapter.getAgentIdByDid(aliceDid);
        assertEq(tokenId, aliceTokenId);
    }

    function test_GetCanonicalAgentId_NotRegistered() public {
        assertEq(adapter.getCanonicalAgentId(aliceTokenId), 0);
    }

    function test_GetCanonicalAgentId_AfterDualRegistration() public {
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");

        uint256 canonicalId = adapter.getCanonicalAgentId(aliceTokenId);
        assertTrue(canonicalId > 0);
    }

    function test_IsDualRegistered() public {
        assertFalse(adapter.isDualRegistered(aliceTokenId));

        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");

        assertTrue(adapter.isDualRegistered(aliceTokenId));
    }

    // ============ Admin Tests ============

    function test_SetCanonicalIdentityRegistry() public {
        address newRegistry = address(0x999);
        vm.prank(admin);
        adapter.setCanonicalIdentityRegistry(newRegistry);

        assertEq(address(adapter.canonicalIdentityRegistry()), newRegistry);
    }

    function test_SetCanonicalIdentityRegistry_NonAdmin_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        adapter.setCanonicalIdentityRegistry(address(0x999));
    }

    function test_SetCanonicalReputationRegistry() public {
        address newRegistry = address(0x888);
        vm.prank(admin);
        adapter.setCanonicalReputationRegistry(newRegistry);

        assertEq(address(adapter.canonicalReputationRegistry()), newRegistry);
    }

    function test_SetDefaultFeedbackVolumeUsd() public {
        vm.prank(admin);
        adapter.setDefaultFeedbackVolumeUsd(500_00);

        assertEq(adapter.defaultFeedbackVolumeUsd(), 500_00);
    }

    function test_SetDefaultFeedbackVolumeUsd_NonAdmin_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        adapter.setDefaultFeedbackVolumeUsd(500_00);
    }

    // ============ Integration: Feedback Relay Updates Trust Score ============

    function test_Integration_FeedbackRelayAffectsTrustScore() public {
        // Stake first so trust score is meaningful
        vm.prank(alice);
        registry.depositStake(aliceDid, 1_000 * 1e6);

        // Relay multiple positive feedbacks
        vm.startPrank(relayer);
        for (uint256 i = 0; i < 10; i++) {
            adapter.relayFeedback(aliceTokenId, 90, 100_00);
        }
        vm.stopPrank();

        // Verify trust score improved
        uint256 trustScore = registry.getTrustScore(aliceDid);
        assertTrue(trustScore > 0, "Trust score should be positive after positive feedback");

        // Verify through the adapter's validation summary
        address[] memory validators = new address[](0);
        (uint64 count, uint8 averageResponse) = adapter.getSummary(aliceTokenId, validators, "");
        assertEq(count, 1);
        assertTrue(averageResponse > 0);
    }

    function test_Integration_DualRegistrationAndFeedbackRelay() public {
        // Step 1: Dual register
        vm.prank(alice);
        adapter.register("ipfs://QmAliceCapCard");
        assertTrue(adapter.isDualRegistered(aliceTokenId));

        // Step 2: Relay some feedback
        vm.prank(relayer);
        adapter.relayFeedback(aliceTokenId, 85, 0);

        // Step 3: Verify both systems are updated
        (, uint256 transactions,) = registry.getReputation(aliceDid);
        assertEq(transactions, 1);

        uint256 canonicalId = adapter.getCanonicalAgentId(aliceTokenId);
        assertTrue(canonicalId > 0);
    }
}
