// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/VerifiedNamespaces.sol";
import "../src/MockUSDC.sol";

/// @title VerifiedNamespaces Tests
/// @notice TDD tests for the VerifiedNamespaces contract
contract VerifiedNamespacesTest is Test {
    VerifiedNamespaces public namespaces;
    MockUSDC public usdc;

    address public admin = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public verifier = address(0x4);
    address public treasury = address(0x5);

    uint256 public constant REGISTRATION_FEE = 1_000000; // 1 USDC
    uint256 public constant EXPIRATION_PERIOD = 365 days;

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
    event NamespaceRenewed(bytes32 indexed namespaceHash, uint256 newExpiresAt);
    event NamespaceReclaimed(bytes32 indexed namespaceHash, address indexed previousOwner);
    event TreasurySet(address indexed treasury);

    function setUp() public {
        usdc = new MockUSDC();

        vm.startPrank(admin);
        namespaces = new VerifiedNamespaces(admin, address(usdc), treasury);
        namespaces.grantRole(namespaces.VERIFIER_ROLE(), verifier);
        vm.stopPrank();

        // Fund users with USDC and approve
        usdc.mint(user1, 100_000000); // 100 USDC
        usdc.mint(user2, 100_000000);

        vm.prank(user1);
        usdc.approve(address(namespaces), type(uint256).max);
        vm.prank(user2);
        usdc.approve(address(namespaces), type(uint256).max);
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsAdmin() public {
        assertTrue(namespaces.hasRole(namespaces.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_SetsPaymentToken() public {
        assertEq(address(namespaces.paymentToken()), address(usdc));
    }

    function test_Constructor_SetsTreasury() public {
        assertEq(namespaces.treasury(), treasury);
    }

    function test_Constructor_RevertsIfAdminIsZero() public {
        vm.expectRevert(VerifiedNamespaces.InvalidAdmin.selector);
        new VerifiedNamespaces(address(0), address(usdc), treasury);
    }

    function test_Constructor_RevertsIfPaymentTokenIsZero() public {
        vm.expectRevert(VerifiedNamespaces.InvalidAddress.selector);
        new VerifiedNamespaces(admin, address(0), treasury);
    }

    function test_Constructor_RevertsIfTreasuryIsZero() public {
        vm.expectRevert(VerifiedNamespaces.InvalidTreasury.selector);
        new VerifiedNamespaces(admin, address(usdc), address(0));
    }

    // ============ Register Namespace Tests ============

    function test_RegisterNamespace_Success() public {
        vm.startPrank(user1);

        uint256 balBefore = usdc.balanceOf(user1);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

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

        // Fee was collected
        assertEq(usdc.balanceOf(user1), balBefore - REGISTRATION_FEE);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + REGISTRATION_FEE);

        vm.stopPrank();
    }

    function test_RegisterNamespace_SetsExpiration() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        assertFalse(namespaces.isExpired(NS_OPENAI));

        // Warp past expiration
        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);
        assertTrue(namespaces.isExpired(NS_OPENAI));
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

    function test_RegisterNamespace_RevertsIfInsufficientBalance() public {
        address poorUser = address(0x99);
        vm.prank(poorUser);
        usdc.approve(address(namespaces), type(uint256).max);

        vm.prank(poorUser);
        vm.expectRevert(); // SafeERC20 will revert
        namespaces.registerNamespace(NS_OPENAI);
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

    function test_VerifyNamespace_ClearsExpiration() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Before verification, it can expire
        assertFalse(namespaces.isExpired(NS_OPENAI));

        vm.prank(verifier);
        namespaces.verifyNamespace(NS_OPENAI);

        // After verification, it never expires even after the period
        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);
        assertFalse(namespaces.isExpired(NS_OPENAI));
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

    // ============ Renew Namespace Tests ============

    function test_RenewNamespace_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Warp forward 300 days (not expired yet)
        vm.warp(block.timestamp + 300 days);

        vm.startPrank(user1);
        uint256 balBefore = usdc.balanceOf(user1);

        namespaces.renewNamespace(NS_OPENAI);

        // Fee was collected
        assertEq(usdc.balanceOf(user1), balBefore - REGISTRATION_FEE);

        // Should not be expired even after original expiry
        vm.warp(block.timestamp + 200 days);
        assertFalse(namespaces.isExpired(NS_OPENAI));

        vm.stopPrank();
    }

    function test_RenewNamespace_ExtendsFromCurrentExpiry() public {
        uint256 startTime = block.timestamp;

        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);
        // expiresAt = startTime + 365 days

        // Renew while still active (200 days in)
        vm.warp(startTime + 200 days);
        vm.prank(user1);
        namespaces.renewNamespace(NS_OPENAI);
        // expiresAt should be (startTime + 365 days) + 365 days = startTime + 730 days

        // At 700 days, should not be expired
        vm.warp(startTime + 700 days);
        assertFalse(namespaces.isExpired(NS_OPENAI));

        // At 731 days, should be expired
        vm.warp(startTime + 731 days);
        assertTrue(namespaces.isExpired(NS_OPENAI));
    }

    function test_RenewNamespace_ExtendsFromNowIfAlreadyExpired() public {
        uint256 startTime = block.timestamp;

        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Let it expire
        vm.warp(startTime + EXPIRATION_PERIOD + 100 days);
        assertTrue(namespaces.isExpired(NS_OPENAI));

        // Renew after expiry
        vm.prank(user1);
        namespaces.renewNamespace(NS_OPENAI);

        // Should now be valid
        assertFalse(namespaces.isExpired(NS_OPENAI));

        // Should expire 365 days from now, not from original expiry
        vm.warp(startTime + EXPIRATION_PERIOD + 100 days + EXPIRATION_PERIOD + 1);
        assertTrue(namespaces.isExpired(NS_OPENAI));
    }

    function test_RenewNamespace_RevertsIfNotOwner() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user2);
        vm.expectRevert(VerifiedNamespaces.NotNamespaceOwner.selector);
        namespaces.renewNamespace(NS_OPENAI);
    }

    function test_RenewNamespace_RevertsIfVerified() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(verifier);
        namespaces.verifyNamespace(NS_OPENAI);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.NamespaceIsVerified.selector);
        namespaces.renewNamespace(NS_OPENAI);
    }

    function test_RenewNamespace_EmitsEvent() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.startPrank(user1);
        vm.expectEmit(true, false, false, false);
        emit NamespaceRenewed(keccak256(bytes(NS_OPENAI)), 0); // Don't check data
        namespaces.renewNamespace(NS_OPENAI);
        vm.stopPrank();
    }

    // ============ Reclaim Expired Tests ============

    function test_ReclaimExpired_Success() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Link an agent first
        vm.prank(user1);
        namespaces.linkAgent(NS_OPENAI, DID1);

        // Warp past expiration
        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);

        // Anyone can reclaim
        vm.prank(user2);
        vm.expectEmit(true, true, false, false);
        emit NamespaceReclaimed(keccak256(bytes(NS_OPENAI)), user1);
        namespaces.reclaimExpired(NS_OPENAI);

        // Namespace is now available
        assertTrue(namespaces.isNamespaceAvailable(NS_OPENAI));

        // Linked agents are cleared
        bytes32[] memory agents = namespaces.getLinkedAgents(NS_OPENAI);
        assertEq(agents.length, 0);

        // Total namespaces decreased
        assertEq(namespaces.totalNamespaces(), 0);
    }

    function test_ReclaimExpired_RemovesFromOwnerList() public {
        vm.startPrank(user1);
        namespaces.registerNamespace(NS_OPENAI);
        namespaces.registerNamespace(NS_ANTHROPIC);
        vm.stopPrank();

        assertEq(namespaces.getNamespacesByOwner(user1).length, 2);

        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);
        namespaces.reclaimExpired(NS_OPENAI);

        assertEq(namespaces.getNamespacesByOwner(user1).length, 1);
    }

    function test_ReclaimExpired_RevertsIfNotExpired() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.expectRevert(VerifiedNamespaces.NamespaceNotExpired.selector);
        namespaces.reclaimExpired(NS_OPENAI);
    }

    function test_ReclaimExpired_RevertsIfVerified() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(verifier);
        namespaces.verifyNamespace(NS_OPENAI);

        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);

        vm.expectRevert(VerifiedNamespaces.NamespaceIsVerified.selector);
        namespaces.reclaimExpired(NS_OPENAI);
    }

    function test_ReclaimExpired_NamespaceCanBeReRegistered() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.warp(block.timestamp + EXPIRATION_PERIOD + 1);
        namespaces.reclaimExpired(NS_OPENAI);

        // Now user2 can register it
        vm.prank(user2);
        namespaces.registerNamespace(NS_OPENAI);

        (address owner,,,,,) = namespaces.getNamespace(NS_OPENAI);
        assertEq(owner, user2);
    }

    // ============ IsExpired Tests ============

    function test_IsExpired_FalseForNonExistent() public {
        assertFalse(namespaces.isExpired(NS_OPENAI));
    }

    function test_IsExpired_FalseForFreshRegistration() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        assertFalse(namespaces.isExpired(NS_OPENAI));
    }

    function test_IsExpired_FalseForVerified() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(verifier);
        namespaces.verifyNamespace(NS_OPENAI);

        vm.warp(block.timestamp + EXPIRATION_PERIOD * 10);
        assertFalse(namespaces.isExpired(NS_OPENAI));
    }

    function test_IsExpired_TrueAfterPeriod() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.warp(block.timestamp + EXPIRATION_PERIOD);
        assertFalse(namespaces.isExpired(NS_OPENAI)); // Exactly at boundary: not expired

        vm.warp(block.timestamp + 1);
        assertTrue(namespaces.isExpired(NS_OPENAI)); // Past boundary: expired
    }

    // ============ Set Treasury Tests ============

    function test_SetTreasury_Success() public {
        address newTreasury = address(0x99);

        vm.startPrank(admin);
        vm.expectEmit(true, false, false, false);
        emit TreasurySet(newTreasury);
        namespaces.setTreasury(newTreasury);
        vm.stopPrank();

        assertEq(namespaces.treasury(), newTreasury);
    }

    function test_SetTreasury_RevertsIfNotAdmin() public {
        vm.prank(user1);
        vm.expectRevert();
        namespaces.setTreasury(address(0x99));
    }

    function test_SetTreasury_RevertsIfZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(VerifiedNamespaces.InvalidTreasury.selector);
        namespaces.setTreasury(address(0));
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

    // ============ Metadata Size Limit Tests ============

    function test_SetMetadata_RevertsIfKeyTooLong() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Create a key that exceeds 64 bytes
        bytes memory longKeyBytes = new bytes(65);
        for (uint256 i = 0; i < 65; i++) {
            longKeyBytes[i] = "a";
        }
        string memory longKey = string(longKeyBytes);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.MetadataKeyTooLong.selector);
        namespaces.setMetadata(NS_OPENAI, longKey, "value");
    }

    function test_SetMetadata_RevertsIfValueTooLong() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Create a value that exceeds 1024 bytes
        bytes memory longValueBytes = new bytes(1025);
        for (uint256 i = 0; i < 1025; i++) {
            longValueBytes[i] = "a";
        }
        string memory longValue = string(longValueBytes);

        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.MetadataValueTooLong.selector);
        namespaces.setMetadata(NS_OPENAI, "website", longValue);
    }

    function test_SetMetadata_AcceptsMaxKeyLength() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Create a key that is exactly 64 bytes (should succeed)
        bytes memory maxKeyBytes = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            maxKeyBytes[i] = "a";
        }
        string memory maxKey = string(maxKeyBytes);

        vm.prank(user1);
        namespaces.setMetadata(NS_OPENAI, maxKey, "value");
        assertEq(namespaces.getMetadata(NS_OPENAI, maxKey), "value");
    }

    function test_SetMetadata_AcceptsMaxValueLength() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Create a value that is exactly 1024 bytes (should succeed)
        bytes memory maxValueBytes = new bytes(1024);
        for (uint256 i = 0; i < 1024; i++) {
            maxValueBytes[i] = "a";
        }
        string memory maxValue = string(maxValueBytes);

        vm.prank(user1);
        namespaces.setMetadata(NS_OPENAI, "description", maxValue);
        assertEq(namespaces.getMetadata(NS_OPENAI, "description"), maxValue);
    }

    function test_SetMetadata_AcceptsEmptyValue() public {
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        vm.prank(user1);
        namespaces.setMetadata(NS_OPENAI, "key", "");
        assertEq(namespaces.getMetadata(NS_OPENAI, "key"), "");
    }

    function test_MetadataConstants() public {
        assertEq(namespaces.MAX_METADATA_KEY_LENGTH(), 64);
        assertEq(namespaces.MAX_METADATA_VALUE_LENGTH(), 1024);
    }

    // ============ L-06: ReserveNamespace Ownership Check ============

    function test_ReserveNamespace_RevertsIfAlreadyRegistered() public {
        // Register a namespace first
        vm.prank(user1);
        namespaces.registerNamespace(NS_OPENAI);

        // Try to reserve it - should revert because it's already owned
        vm.prank(admin);
        vm.expectRevert(VerifiedNamespaces.NamespaceAlreadyExists.selector);
        namespaces.reserveNamespace(NS_OPENAI);
    }

    function test_ReserveNamespace_SucceedsForUnregistered() public {
        vm.prank(admin);
        namespaces.reserveNamespace(NS_OPENAI);

        // Verify it's now reserved (can't register)
        vm.prank(user1);
        vm.expectRevert(VerifiedNamespaces.NamespaceReserved.selector);
        namespaces.registerNamespace(NS_OPENAI);
    }

    // ============ Fee & Expiration Constants Tests ============

    function test_RegistrationFeeConstant() public {
        assertEq(namespaces.REGISTRATION_FEE(), 1_000000);
    }

    function test_ExpirationPeriodConstant() public {
        assertEq(namespaces.EXPIRATION_PERIOD(), 365 days);
    }
}
