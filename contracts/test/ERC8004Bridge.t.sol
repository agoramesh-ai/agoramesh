// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ERC8004Bridge.sol";
import "../src/interfaces/IERC8004Identity.sol";

// ============ Mock Contracts ============

/// @notice Mock ERC-8004 IdentityRegistry for testing
contract MockIdentityRegistry is IERC8004IdentityRegistry {
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

/// @notice Mock ERC-8004 ReputationRegistry for testing
contract MockReputationRegistry is IERC8004ReputationRegistry {
    address private _identityRegistry;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

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

/// @title ERC8004Bridge Tests
/// @notice Tests for the ERC-8004 Bridge with mock registries
contract ERC8004BridgeTest is Test {
    ERC8004Bridge public bridge;
    MockIdentityRegistry public identityRegistry;
    MockReputationRegistry public reputationRegistry;

    address public owner = address(0x1);
    address public nonOwner = address(0x2);

    uint256 public agentTokenId1 = 100;
    uint256 public agentTokenId2 = 200;
    string public agentURI1 = "ipfs://QmAgent1CapabilityCard";
    string public agentURI2 = "ipfs://QmAgent2CapabilityCard";

    function setUp() public {
        // Deploy mock registries
        identityRegistry = new MockIdentityRegistry();
        reputationRegistry = new MockReputationRegistry(address(identityRegistry));

        // Deploy bridge
        vm.prank(owner);
        bridge = new ERC8004Bridge(address(identityRegistry), address(reputationRegistry), owner);
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsRegistries() public {
        assertEq(address(bridge.identityRegistry()), address(identityRegistry));
        assertEq(address(bridge.reputationRegistry()), address(reputationRegistry));
        assertEq(bridge.owner(), owner);
        assertEq(bridge.totalRegistered(), 0);
    }

    function test_Constructor_ZeroIdentityRegistry_Reverts() public {
        vm.expectRevert(ERC8004Bridge.ZeroAddress.selector);
        new ERC8004Bridge(address(0), address(reputationRegistry), owner);
    }

    function test_Constructor_ZeroReputationRegistry_Reverts() public {
        vm.expectRevert(ERC8004Bridge.ZeroAddress.selector);
        new ERC8004Bridge(address(identityRegistry), address(0), owner);
    }

    // ============ Registration Tests ============

    function test_RegisterAgent_Success() public {
        vm.prank(owner);
        uint256 erc8004Id = bridge.registerAgent(agentTokenId1, agentURI1);

        assertEq(erc8004Id, 1); // First registration in mock
        assertEq(bridge.agoraMeshToERC8004(agentTokenId1), 1);
        assertEq(bridge.erc8004ToAgoraMesh(1), agentTokenId1);
        assertEq(bridge.totalRegistered(), 1);
        assertTrue(bridge.isRegistered(agentTokenId1));
    }

    function test_RegisterAgent_EmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ERC8004Bridge.AgentRegistered(agentTokenId1, 1, agentURI1);

        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);
    }

    function test_RegisterAgent_MultipleAgents() public {
        vm.startPrank(owner);
        uint256 id1 = bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 id2 = bridge.registerAgent(agentTokenId2, agentURI2);
        vm.stopPrank();

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(bridge.totalRegistered(), 2);
        assertEq(bridge.agoraMeshToERC8004(agentTokenId1), 1);
        assertEq(bridge.agoraMeshToERC8004(agentTokenId2), 2);
    }

    function test_RegisterAgent_AlreadyRegistered_Reverts() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        vm.expectRevert(abi.encodeWithSelector(ERC8004Bridge.AgentAlreadyRegistered.selector, agentTokenId1));
        bridge.registerAgent(agentTokenId1, "different-uri");
        vm.stopPrank();
    }

    function test_RegisterAgent_NonOwner_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.registerAgent(agentTokenId1, agentURI1);
    }

    function test_RegisterAgent_URIStoredInRegistry() public {
        vm.prank(owner);
        uint256 erc8004Id = bridge.registerAgent(agentTokenId1, agentURI1);

        string memory storedURI = identityRegistry.getAgentURI(erc8004Id);
        assertEq(storedURI, agentURI1);
    }

    // ============ Update URI Tests ============

    function test_UpdateAgentURI_Success() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        string memory newURI = "ipfs://QmUpdatedURI";
        bridge.updateAgentURI(agentTokenId1, newURI);
        vm.stopPrank();

        string memory storedURI = identityRegistry.getAgentURI(1);
        assertEq(storedURI, newURI);
    }

    function test_UpdateAgentURI_EmitsEvent() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        vm.expectEmit(true, false, false, true);
        emit ERC8004Bridge.AgentURIUpdated(1, "ipfs://QmNewURI");
        bridge.updateAgentURI(agentTokenId1, "ipfs://QmNewURI");
        vm.stopPrank();
    }

    function test_UpdateAgentURI_NotRegistered_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ERC8004Bridge.AgentNotRegistered.selector, agentTokenId1));
        bridge.updateAgentURI(agentTokenId1, "new-uri");
    }

    function test_UpdateAgentURI_NonOwner_Reverts() public {
        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.updateAgentURI(agentTokenId1, "new-uri");
    }

    // ============ Feedback Tests ============

    function test_SubmitFeedback_EmitsEvent() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 erc8004Id = bridge.agoraMeshToERC8004(agentTokenId1);

        vm.expectEmit(true, true, false, true);
        emit ERC8004Bridge.FeedbackSubmitted(erc8004Id, owner, 85, "quality", "speed");
        bridge.submitFeedback(erc8004Id, 85, "quality", "speed");
        vm.stopPrank();
    }

    function test_SubmitFeedback_NegativeValue() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 erc8004Id = bridge.agoraMeshToERC8004(agentTokenId1);

        vm.expectEmit(true, true, false, true);
        emit ERC8004Bridge.FeedbackSubmitted(erc8004Id, owner, -50, "reliability", "");
        bridge.submitFeedback(erc8004Id, -50, "reliability", "");
        vm.stopPrank();
    }

    function test_SubmitFeedback_NonOwner_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.submitFeedback(1, 85, "quality", "speed");
    }

    // ============ Validation Tests ============

    function test_SubmitValidation_EmitsEvent() public {
        bytes32 requestHash = keccak256("validation-request-1");

        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 erc8004Id = bridge.agoraMeshToERC8004(agentTokenId1);

        vm.expectEmit(true, true, false, true);
        emit ERC8004Bridge.ValidationSubmitted(erc8004Id, requestHash, 1, "capability-check");
        bridge.submitValidation(erc8004Id, requestHash, 1, "capability-check");
        vm.stopPrank();
    }

    function test_SubmitValidation_AllResponseCodes() public {
        vm.startPrank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 erc8004Id = bridge.agoraMeshToERC8004(agentTokenId1);

        // 0 = pending
        bridge.submitValidation(erc8004Id, keccak256("req-0"), 0, "pending");
        // 1 = valid
        bridge.submitValidation(erc8004Id, keccak256("req-1"), 1, "valid");
        // 2 = invalid
        bridge.submitValidation(erc8004Id, keccak256("req-2"), 2, "invalid");
        // 3 = inconclusive
        bridge.submitValidation(erc8004Id, keccak256("req-3"), 3, "inconclusive");
        vm.stopPrank();
    }

    function test_SubmitValidation_NonOwner_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.submitValidation(1, keccak256("req"), 1, "tag");
    }

    // ============ View Function Tests ============

    function test_GetERC8004AgentId() public {
        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        assertEq(bridge.getERC8004AgentId(agentTokenId1), 1);
    }

    function test_GetERC8004AgentId_NotRegistered() public {
        assertEq(bridge.getERC8004AgentId(agentTokenId1), 0);
    }

    function test_GetAgoraMeshTokenId() public {
        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        assertEq(bridge.getAgoraMeshTokenId(1), agentTokenId1);
    }

    function test_IsRegistered() public {
        assertFalse(bridge.isRegistered(agentTokenId1));

        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        assertTrue(bridge.isRegistered(agentTokenId1));
    }

    function test_GetAgoraMeshtadata() public {
        vm.prank(owner);
        bridge.registerAgent(agentTokenId1, agentURI1);

        // Set metadata on the mock registry directly
        uint256 erc8004Id = bridge.agoraMeshToERC8004(agentTokenId1);
        identityRegistry.setMetadata(erc8004Id, "category", abi.encode("AI Assistant"));

        bytes memory result = bridge.getAgoraMeshtadata(agentTokenId1, "category");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, "AI Assistant");
    }

    function test_GetAgoraMeshtadata_NotRegistered_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ERC8004Bridge.AgentNotRegistered.selector, agentTokenId1));
        bridge.getAgoraMeshtadata(agentTokenId1, "category");
    }

    function test_GetReputationSummary() public {
        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) = bridge.getReputationSummary(1);
        assertEq(count, 0);
        assertEq(summaryValue, 0);
        assertEq(summaryValueDecimals, 2);
    }

    // ============ Admin Function Tests ============

    function test_SetIdentityRegistry() public {
        MockIdentityRegistry newRegistry = new MockIdentityRegistry();

        vm.expectEmit(true, false, false, false);
        emit ERC8004Bridge.IdentityRegistryUpdated(address(newRegistry));

        vm.prank(owner);
        bridge.setIdentityRegistry(address(newRegistry));

        assertEq(address(bridge.identityRegistry()), address(newRegistry));
    }

    function test_SetIdentityRegistry_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ERC8004Bridge.ZeroAddress.selector);
        bridge.setIdentityRegistry(address(0));
    }

    function test_SetIdentityRegistry_NonOwner_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.setIdentityRegistry(address(0x999));
    }

    function test_SetReputationRegistry() public {
        MockReputationRegistry newRegistry = new MockReputationRegistry(address(identityRegistry));

        vm.expectEmit(true, false, false, false);
        emit ERC8004Bridge.ReputationRegistryUpdated(address(newRegistry));

        vm.prank(owner);
        bridge.setReputationRegistry(address(newRegistry));

        assertEq(address(bridge.reputationRegistry()), address(newRegistry));
    }

    function test_SetReputationRegistry_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(ERC8004Bridge.ZeroAddress.selector);
        bridge.setReputationRegistry(address(0));
    }

    function test_SetReputationRegistry_NonOwner_Reverts() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nonOwner));
        bridge.setReputationRegistry(address(0x999));
    }

    // ============ Bidirectional Mapping Tests ============

    function test_BidirectionalMapping_Consistency() public {
        vm.startPrank(owner);
        uint256 erc8004Id1 = bridge.registerAgent(agentTokenId1, agentURI1);
        uint256 erc8004Id2 = bridge.registerAgent(agentTokenId2, agentURI2);
        vm.stopPrank();

        // Forward mapping
        assertEq(bridge.agoraMeshToERC8004(agentTokenId1), erc8004Id1);
        assertEq(bridge.agoraMeshToERC8004(agentTokenId2), erc8004Id2);

        // Reverse mapping
        assertEq(bridge.erc8004ToAgoraMesh(erc8004Id1), agentTokenId1);
        assertEq(bridge.erc8004ToAgoraMesh(erc8004Id2), agentTokenId2);

        // No cross-contamination
        assertTrue(erc8004Id1 != erc8004Id2);
    }

    // ============ Fuzz Tests ============

    function testFuzz_RegisterAgent(uint256 tokenId, string calldata uri) public {
        vm.assume(tokenId != 0); // Token ID 0 is reserved
        vm.assume(bytes(uri).length > 0 && bytes(uri).length < 1000);

        vm.prank(owner);
        uint256 erc8004Id = bridge.registerAgent(tokenId, uri);

        assertTrue(erc8004Id > 0);
        assertEq(bridge.agoraMeshToERC8004(tokenId), erc8004Id);
        assertEq(bridge.erc8004ToAgoraMesh(erc8004Id), tokenId);
    }
}
