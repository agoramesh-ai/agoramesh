// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/VerifiedNamespaces.sol";

/// @title VerifiedNamespaces Tests
/// @notice TDD tests for the VerifiedNamespaces contract
contract VerifiedNamespacesTest is Test {
    VerifiedNamespaces public namespaces;

    address public admin = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public verifier = address(0x4);

    // Test DIDs
    bytes32 public constant DID1 = keccak256("did:agoramesh:base:0x1111");
    bytes32 public constant DID2 = keccak256("did:agoramesh:base:0x2222");

    // Test namespaces
    string public constant NS_OPENAI = "openai";
    string public constant NS_ANTHROPIC = "anthropic";
    string public constant NS_GOOGLE = "google";

    // Events
    event NamespaceRegistered(bytes32 indexed namespaceHash, address indexed owner, string name);
    event NamespaceTransferred(bytes32 indexed namespaceHash, address indexed from, address indexed to);
    event NamespaceVerified(bytes32 indexed namespaceHash, address indexed verifier);
    event NamespaceRevoked(bytes32 indexed namespaceHash);
    event AgentLinked(bytes32 indexed namespaceHash, bytes32 indexed didHash);
    event AgentUnlinked(bytes32 indexed namespaceHash, bytes32 indexed didHash);
    event MetadataUpdated(bytes32 indexed namespaceHash, string key, string value);
    event RegistrationFeeSet(uint256 fee);
    event VerificationFeeSet(uint256 fee);

    function setUp() public {
        vm.startPrank(admin);
        namespaces = new VerifiedNamespaces(admin);
        namespaces.grantRole(namespaces.VERIFIER_ROLE(), verifier);
        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsAdmin() public {
        assertTrue(namespaces.hasRole(namespaces.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_RevertsIfAdminIsZero() public {
        vm.expectRevert(VerifiedNamespaces.InvalidAdmin.selector);
        new VerifiedNamespaces(address(0));
    }

    // ============ Register Namespace Tests ============

    function test_RegisterNamespace_Success() public {
        vm.startPrank(user1);

        vm.expectEmit(true, true, false, true);
        emit NamespaceRegistered(keccak256(bytes(NS_OPENAI)), user1, NS_OPENAI);

        namespaces.registerNamespace(NS_OPENAI);

        (address owner, string memory name, bool verified, bool active, uint256 registeredAt, uint256 linkedAgents) =
            namespaces.getNamespace(NS_OPENAI);

        assertEq(owner, user1);
        assertEq(name, NS_OPENAI);
        assertFalse(verified);
        assertTrue(active);
        assertGt(registeredAt, 0);
        assertEq(linkedAgents, 0);

        vm.stopPrank();
    }

    function test_RegisterNamespace_RevertsIfAlreadyExists() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert(VerifiedNamespaces.NamespaceAlreadyExists.selector);
        namespaces.registerNamespace(NS_OPENAI);
    }

    function test_RegisterNamespace_RevertsIfNameEmpty() public {
        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.InvalidNamespaceName.selector);
        namespaces.registerNamespace("");
    }

    function test_RegisterNamespace_RevertsIfNameTooShort() public {
        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.InvalidNamespaceName.selector);
        namespaces.registerNamespace("ab");
    }

    function test_RegisterNamespace_RevertsIfNameTooLong() public {
        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.InvalidNamespaceName.selector);
        namespaces.registerNamespace("thisnameiswaytoolongforanamespace12345678901234567890");
    }

    function test_RegisterNamespace_NormalizesToLowercase() public {
        vm.prank(user1);
        namespaces.registerNamespace("OpenAI");

        // Should be normalized to lowercase
        (address owner,,,,,) = namespaces.getNamespace("openai");
        assertEq(owner, user1);

        // Original case should also resolve
        (owner,,,,,) = namespaces.getNamespace("OpenAI");
        assertEq(owner, user1);
    }

    // ============ Transfer Namespace Tests ============

    function test_TransferNamespace_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);

        vm.expectEmit(true, true, true, false);
        emit NamespaceTransferred(keccak256(bytes(NS_OPENAI)), user1, user2);

        namespaces.transferNamespace(NS_OPENAI, user2);

        (address owner,,,,,) = namespaces.getNamespace(NS_OPENAI);
        assertEq(owner, user2);

        vm.stopPrank();
    }

    function test_TransferNamespace_RevertsIfNotOwner() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert(VerifiedNamespaces.NotNamespaceOwner.selector);
        namespaces.transferNamespace(NS_OPENAI, user2);
    }

    function test_TransferNamespace_RevertsIfToZeroAddress() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.InvalidAddress.selector);
        namespaces.transferNamespace(NS_OPENAI, address(0));
    }

    // ============ Verify Namespace Tests ============

    function test_VerifyNamespace_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(verifier);

        vm.expectEmit(true, true, false, false);
        emit NamespaceVerified(keccak256(bytes(NS_OPENAI)), verifier);

        namespaces.verifyNamespace(NS_OPENAI);

        (,, bool verified,,,) = namespaces.getNamespace(NS_OPENAI);
        assertTrue(verified);

        vm.stopPrank();
    }

    function test_VerifyNamespace_RevertsIfNotVerifier() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert();
        namespaces.verifyNamespace(NS_OPENAI);
    }

    function test_VerifyNamespace_RevertsIfNotExists() public {
        vm.prank(verifier);
        vm.expectRevert(VerifiedNamespaces.NamespaceNotFound.selector);
        namespaces.verifyNamespace(NS_OPENAI);
    }

    // ============ Revoke Namespace Tests ============

    function test_RevokeNamespace_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(admin);

        vm.expectEmit(true, false, false, false);
        emit NamespaceRevoked(keccak256(bytes(NS_OPENAI)));

        namespaces.revokeNamespace(NS_OPENAI);

        (,,, bool active,,) = namespaces.getNamespace(NS_OPENAI);
        assertFalse(active);

        vm.stopPrank();
    }

    function test_RevokeNamespace_RevertsIfNotAdmin() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert();
        namespaces.revokeNamespace(NS_OPENAI);
    }

    // ============ Link Agent Tests ============

    function test_LinkAgent_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);

        vm.expectEmit(true, true, false, false);
        emit AgentLinked(keccak256(bytes(NS_OPENAI)), DID1);

        namespaces.linkAgent(NS_OPENAI, DID1);

        assertTrue(namespaces.isAgentLinked(NS_OPENAI, DID1));

        (,,,,, uint256 linkedAgents) = namespaces.getNamespace(NS_OPENAI);
        assertEq(linkedAgents, 1);

        vm.stopPrank();
    }

    function test_LinkAgent_MultipleAgents() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        namespaces.linkAgent(NS_OPENAI, DID1);
        namespaces.linkAgent(NS_OPENAI, DID2);

        assertTrue(namespaces.isAgentLinked(NS_OPENAI, DID1));
        assertTrue(namespaces.isAgentLinked(NS_OPENAI, DID2));

        (,,,,, uint256 linkedAgents) = namespaces.getNamespace(NS_OPENAI);
        assertEq(linkedAgents, 2);

        vm.stopPrank();
    }

    function test_LinkAgent_RevertsIfNotOwner() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert(VerifiedNamespaces.NotNamespaceOwner.selector);
        namespaces.linkAgent(NS_OPENAI, DID1);
    }

    function test_LinkAgent_RevertsIfAlreadyLinked() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        namespaces.linkAgent(NS_OPENAI, DID1);

        vm.expectRevert(VerifiedNamespaces.AgentAlreadyLinked.selector);
        namespaces.linkAgent(NS_OPENAI, DID1);

        vm.stopPrank();
    }

    // ============ Unlink Agent Tests ============

    function test_UnlinkAgent_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        namespaces.linkAgent(NS_OPENAI, DID1);

        vm.expectEmit(true, true, false, false);
        emit AgentUnlinked(keccak256(bytes(NS_OPENAI)), DID1);

        namespaces.unlinkAgent(NS_OPENAI, DID1);

        assertFalse(namespaces.isAgentLinked(NS_OPENAI, DID1));

        (,,,,, uint256 linkedAgents) = namespaces.getNamespace(NS_OPENAI);
        assertEq(linkedAgents, 0);

        vm.stopPrank();
    }

    function test_UnlinkAgent_RevertsIfNotLinked() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.AgentNotLinked.selector);
        namespaces.unlinkAgent(NS_OPENAI, DID1);
    }

    // ============ Set Metadata Tests ============

    function test_SetMetadata_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);

        vm.expectEmit(true, false, false, true);
        emit MetadataUpdated(keccak256(bytes(NS_OPENAI)), "website", "https://openai.com");

        namespaces.setMetadata(NS_OPENAI, "website", "https://openai.com");

        assertEq(namespaces.getMetadata(NS_OPENAI, "website"), "https://openai.com");

        vm.stopPrank();
    }

    function test_SetMetadata_MultipleKeys() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        namespaces.setMetadata(NS_OPENAI, "website", "https://openai.com");
        namespaces.setMetadata(NS_OPENAI, "twitter", "@OpenAI");
        namespaces.setMetadata(NS_OPENAI, "description", "AI Research Company");

        assertEq(namespaces.getMetadata(NS_OPENAI, "website"), "https://openai.com");
        assertEq(namespaces.getMetadata(NS_OPENAI, "twitter"), "@OpenAI");
        assertEq(namespaces.getMetadata(NS_OPENAI, "description"), "AI Research Company");

        vm.stopPrank();
    }

    // ============ Get Linked Agents Tests ============

    function test_GetLinkedAgents_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        namespaces.linkAgent(NS_OPENAI, DID1);
        namespaces.linkAgent(NS_OPENAI, DID2);

        bytes32[] memory agents = namespaces.getLinkedAgents(NS_OPENAI);
        assertEq(agents.length, 2);

        vm.stopPrank();
    }

    function test_GetLinkedAgents_Empty() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        bytes32[] memory agents = namespaces.getLinkedAgents(NS_OPENAI);
        assertEq(agents.length, 0);
    }

    // ============ Is Namespace Available Tests ============

    function test_IsNamespaceAvailable_True() public {
        assertTrue(namespaces.isNamespaceAvailable(NS_OPENAI));
    }

    function test_IsNamespaceAvailable_FalseAfterRegistration() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        assertFalse(namespaces.isNamespaceAvailable(NS_OPENAI));
    }

    // ============ Get Namespace By Owner Tests ============

    function test_GetNamespacesByOwner_Success() public {
        vm.startPrank(user1);
        namespaces.registerNamespace(NS_OPENAI);
        namespaces.registerNamespace(NS_ANTHROPIC);
        vm.stopPrank();

        bytes32[] memory owned = namespaces.getNamespacesByOwner(user1);
        assertEq(owned.length, 2);
    }

    function test_GetNamespacesByOwner_Empty() public {
        bytes32[] memory owned = namespaces.getNamespacesByOwner(user1);
        assertEq(owned.length, 0);
    }

    // ============ Namespace Hash Tests ============

    function test_GetNamespaceHash_Consistent() public {
        bytes32 hash1 = namespaces.getNamespaceHash(NS_OPENAI);
        bytes32 hash2 = namespaces.getNamespaceHash("openai");
        bytes32 hash3 = namespaces.getNamespaceHash("OpenAI");

        // All should produce the same hash (lowercase normalization)
        assertEq(hash1, hash2);
        assertEq(hash2, hash3);
    }

    // ============ Total Namespaces Tests ============

    function test_TotalNamespaces() public {
        assertEq(namespaces.totalNamespaces(), 0);

        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);
        assertEq(namespaces.totalNamespaces(), 1);

        vm.prank(user2);
        namespaces.registerNamespace(NS_ANTHROPIC);
        assertEq(namespaces.totalNamespaces(), 2);
    }

    // ============ Verified Count Tests ============

    function test_VerifiedNamespacesCount() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        namespaces.registerNamespace(NS_ANTHROPIC);

        assertEq(namespaces.verifiedNamespacesCount(), 0);

        vm.prank(verifier);
        namespaces.verifyNamespace(NS_OPENAI);

        assertEq(namespaces.verifiedNamespacesCount(), 1);
    }

    // ============ Reserved Namespace Tests ============

    function test_ReserveNamespace_Success() public {
        vm.prank(admin);
        namespaces.reserveNamespace(NS_GOOGLE);

        assertFalse(namespaces.isNamespaceAvailable(NS_GOOGLE));
    }

    function test_ReserveNamespace_RevertsIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        namespaces.reserveNamespace(NS_GOOGLE);
    }

    function test_RegisterNamespace_RevertsIfReserved() public {
        vm.prank(admin);
        namespaces.reserveNamespace(NS_GOOGLE);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.NamespaceReserved.selector);
        namespaces.registerNamespace(NS_GOOGLE);
    }
}
