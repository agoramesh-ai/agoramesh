// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgentToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 1000000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title AgentToken Tests
/// @notice TDD tests for the AgentToken contract
contract AgentTokenTest is Test {
    AgentToken public agentToken;
    MockUSDC public usdc;

    address public admin = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public treasury = address(0x4);

    // Test DIDs
    bytes32 public constant DID1 = keccak256("did:agoramesh:base:0x1111");
    bytes32 public constant DID2 = keccak256("did:agoramesh:base:0x2222");

    // Test metadata
    string public constant CAPABILITY_CID = "ipfs://QmTest1234";
    string public constant TOKEN_URI = "ipfs://QmTokenUri1234";

    // Events
    event AgentMinted(uint256 indexed tokenId, bytes32 indexed didHash, address indexed owner);
    event AgentBurned(uint256 indexed tokenId, bytes32 indexed didHash);
    event RevenueDeposited(uint256 indexed tokenId, uint256 amount);
    event RevenueClaimed(uint256 indexed tokenId, address indexed claimant, uint256 amount);
    event RoyaltySet(uint256 indexed tokenId, uint96 royaltyBps);
    event MintFeeSet(uint256 fee);
    event TreasurySet(address treasury);

    function setUp() public {
        vm.startPrank(admin);

        usdc = new MockUSDC();
        agentToken = new AgentToken("AgoraMesh Agents", "AGENT", address(usdc), treasury, admin);

        // Transfer USDC to test users
        usdc.transfer(user1, 10000 * 10 ** 6);
        usdc.transfer(user2, 10000 * 10 ** 6);

        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsName() public {
        assertEq(agentToken.name(), "AgoraMesh Agents");
    }

    function test_Constructor_SetsSymbol() public {
        assertEq(agentToken.symbol(), "AGENT");
    }

    function test_Constructor_SetsAdmin() public {
        assertTrue(agentToken.hasRole(agentToken.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_SetsTreasury() public {
        assertEq(agentToken.treasury(), treasury);
    }

    function test_Constructor_RevertsIfUSDCIsZero() public {
        vm.expectRevert(AgentToken.InvalidAddress.selector);
        new AgentToken("Test", "TEST", address(0), treasury, admin);
    }

    function test_Constructor_RevertsIfTreasuryIsZero() public {
        vm.expectRevert(AgentToken.InvalidAddress.selector);
        new AgentToken("Test", "TEST", address(usdc), address(0), admin);
    }

    function test_Constructor_RevertsIfAdminIsZero() public {
        vm.expectRevert(AgentToken.InvalidAddress.selector);
        new AgentToken("Test", "TEST", address(usdc), treasury, address(0));
    }

    // ============ Mint Agent Tests ============

    function test_MintAgent_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);

        vm.expectEmit(true, true, true, false);
        emit AgentMinted(1, DID1, user1);

        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        assertEq(tokenId, 1);
        assertEq(agentToken.ownerOf(tokenId), user1);
        assertEq(agentToken.tokenURI(tokenId), TOKEN_URI);

        (bytes32 didHash, string memory capCID, uint256 mintedAt, bool active) = agentToken.getAgentInfo(tokenId);
        assertEq(didHash, DID1);
        assertEq(capCID, CAPABILITY_CID);
        assertGt(mintedAt, 0);
        assertTrue(active);

        vm.stopPrank();
    }

    function test_MintAgent_PaysMintFee() public {
        vm.startPrank(admin);
        agentToken.setMintFee(100 * 10 ** 6); // 100 USDC
        vm.stopPrank();

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        uint256 treasuryAfter = usdc.balanceOf(treasury);
        assertEq(treasuryAfter - treasuryBefore, 100 * 10 ** 6);
    }

    function test_MintAgent_RevertsIfDIDAlreadyMinted() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        vm.expectRevert(AgentToken.AgentAlreadyMinted.selector);
        agentToken.mintAgent(DID1, "other-cid", "other-uri", 500);

        vm.stopPrank();
    }

    function test_MintAgent_RevertsIfRoyaltyTooHigh() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);

        vm.expectRevert(AgentToken.RoyaltyTooHigh.selector);
        agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 1001); // Max is 10%

        vm.stopPrank();
    }

    // ============ Transfer Tests ============

    function test_Transfer_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        agentToken.transferFrom(user1, user2, tokenId);

        assertEq(agentToken.ownerOf(tokenId), user2);
        vm.stopPrank();
    }

    // ============ Burn Tests ============

    function test_BurnAgent_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        vm.expectEmit(true, true, false, false);
        emit AgentBurned(tokenId, DID1);

        agentToken.burnAgent(tokenId);

        vm.expectRevert();
        agentToken.ownerOf(tokenId);

        vm.stopPrank();
    }

    function test_BurnAgent_RevertsIfNotOwner() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        vm.startPrank(user2);
        vm.expectRevert(AgentToken.NotTokenOwner.selector);
        agentToken.burnAgent(tokenId);
        vm.stopPrank();
    }

    // ============ Revenue Sharing Tests ============

    function test_DepositRevenue_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        vm.startPrank(user2);
        usdc.approve(address(agentToken), type(uint256).max);

        vm.expectEmit(true, false, false, true);
        emit RevenueDeposited(tokenId, 1000 * 10 ** 6);

        agentToken.depositRevenue(tokenId, 1000 * 10 ** 6);

        assertEq(agentToken.getAccumulatedRevenue(tokenId), 1000 * 10 ** 6);
        vm.stopPrank();
    }

    function test_ClaimRevenue_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        // Deposit revenue
        vm.startPrank(user2);
        usdc.approve(address(agentToken), type(uint256).max);
        agentToken.depositRevenue(tokenId, 1000 * 10 ** 6);
        vm.stopPrank();

        uint256 balanceBefore = usdc.balanceOf(user1);

        vm.startPrank(user1);
        vm.expectEmit(true, true, false, true);
        emit RevenueClaimed(tokenId, user1, 1000 * 10 ** 6);

        agentToken.claimRevenue(tokenId);

        uint256 balanceAfter = usdc.balanceOf(user1);
        assertEq(balanceAfter - balanceBefore, 1000 * 10 ** 6);
        assertEq(agentToken.getAccumulatedRevenue(tokenId), 0);
        vm.stopPrank();
    }

    function test_ClaimRevenue_RevertsIfNotOwner() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        // Deposit revenue
        vm.startPrank(user2);
        usdc.approve(address(agentToken), type(uint256).max);
        agentToken.depositRevenue(tokenId, 1000 * 10 ** 6);

        vm.expectRevert(AgentToken.NotTokenOwner.selector);
        agentToken.claimRevenue(tokenId);
        vm.stopPrank();
    }

    function test_ClaimRevenue_RevertsIfNoRevenue() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        vm.expectRevert(AgentToken.NoRevenueToClaim.selector);
        agentToken.claimRevenue(tokenId);
        vm.stopPrank();
    }

    // ============ Royalty Tests ============

    function test_RoyaltyInfo_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500); // 5% royalty
        vm.stopPrank();

        (address receiver, uint256 royaltyAmount) = agentToken.royaltyInfo(tokenId, 1000 * 10 ** 6);
        assertEq(receiver, user1);
        assertEq(royaltyAmount, 50 * 10 ** 6); // 5% of 1000
    }

    function test_SetRoyalty_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        vm.expectEmit(true, false, false, true);
        emit RoyaltySet(tokenId, 250);

        agentToken.setRoyalty(tokenId, 250); // 2.5%

        (address receiver, uint256 royaltyAmount) = agentToken.royaltyInfo(tokenId, 1000 * 10 ** 6);
        assertEq(receiver, user1);
        assertEq(royaltyAmount, 25 * 10 ** 6); // 2.5% of 1000
        vm.stopPrank();
    }

    // ============ Admin Functions Tests ============

    function test_SetMintFee_Success() public {
        vm.startPrank(admin);

        vm.expectEmit(false, false, false, true);
        emit MintFeeSet(50 * 10 ** 6);

        agentToken.setMintFee(50 * 10 ** 6);

        assertEq(agentToken.mintFee(), 50 * 10 ** 6);
        vm.stopPrank();
    }

    function test_SetTreasury_Success() public {
        address newTreasury = address(0x5);

        vm.startPrank(admin);

        vm.expectEmit(false, false, false, true);
        emit TreasurySet(newTreasury);

        agentToken.setTreasury(newTreasury);

        assertEq(agentToken.treasury(), newTreasury);
        vm.stopPrank();
    }

    function test_SetTreasury_RevertsIfNotAdmin() public {
        vm.startPrank(user1);
        vm.expectRevert();
        agentToken.setTreasury(address(0x5));
        vm.stopPrank();
    }

    // ============ View Functions Tests ============

    function test_GetTokenByDID_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        assertEq(agentToken.getTokenByDID(DID1), tokenId);
    }

    function test_GetTokenByDID_ReturnsZeroIfNotMinted() public {
        assertEq(agentToken.getTokenByDID(DID1), 0);
    }

    function test_IsAgentActive_True() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        assertTrue(agentToken.isAgentActive(tokenId));
    }

    function test_TotalAgents() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);

        assertEq(agentToken.totalAgents(), 0);

        agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        assertEq(agentToken.totalAgents(), 1);

        agentToken.mintAgent(DID2, "cid2", "uri2", 500);
        assertEq(agentToken.totalAgents(), 2);

        vm.stopPrank();
    }

    // ============ Update Capability CID Tests ============

    function test_UpdateCapabilityCID_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        string memory newCID = "ipfs://QmNewCID";
        agentToken.updateCapabilityCID(tokenId, newCID);

        (, string memory capCID,,) = agentToken.getAgentInfo(tokenId);
        assertEq(capCID, newCID);
        vm.stopPrank();
    }

    function test_UpdateCapabilityCID_RevertsIfNotOwner() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        vm.stopPrank();

        vm.startPrank(user2);
        vm.expectRevert(AgentToken.NotTokenOwner.selector);
        agentToken.updateCapabilityCID(tokenId, "new-cid");
        vm.stopPrank();
    }

    // ============ Deactivate/Activate Tests ============

    function test_DeactivateAgent_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);

        agentToken.deactivateAgent(tokenId);

        assertFalse(agentToken.isAgentActive(tokenId));
        vm.stopPrank();
    }

    function test_ActivateAgent_Success() public {
        vm.startPrank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, 500);
        agentToken.deactivateAgent(tokenId);
        agentToken.activateAgent(tokenId);

        assertTrue(agentToken.isAgentActive(tokenId));
        vm.stopPrank();
    }

    // ============ Supports Interface Tests ============

    function test_SupportsInterface_ERC721() public {
        assertTrue(agentToken.supportsInterface(0x80ac58cd)); // ERC721
    }

    function test_SupportsInterface_ERC2981() public {
        assertTrue(agentToken.supportsInterface(0x2a55205a)); // ERC2981 (Royalties)
    }

    // ============ Royalty BPS Transfer Tests (C-6) ============

    function test_RoyaltyPreservedOnTransfer() public {
        uint96 originalBps = 500; // 5%

        vm.prank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        vm.prank(user1);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, originalBps);

        // Verify royalty before transfer
        (address receiver1, uint256 amount1) = agentToken.royaltyInfo(tokenId, 10000);
        assertEq(receiver1, user1);
        assertEq(amount1, originalBps); // 500 BPS of 10000 = 500

        // Transfer to user2
        vm.prank(user1);
        agentToken.transferFrom(user1, user2, tokenId);

        // Verify royalty after transfer - receiver should change, BPS must be preserved
        (address receiver2, uint256 amount2) = agentToken.royaltyInfo(tokenId, 10000);
        assertEq(receiver2, user2);
        assertEq(amount2, originalBps); // BPS must remain 500
    }

    function test_RoyaltyBPS_PreservedWithDifferentSalePrice() public {
        uint96 originalBps = 750; // 7.5%

        vm.prank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        vm.prank(user1);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, originalBps);

        // Transfer to user2
        vm.prank(user1);
        agentToken.transferFrom(user1, user2, tokenId);

        // Check royalty with a different sale price
        (, uint256 amount) = agentToken.royaltyInfo(tokenId, 100 ether);
        // 750/10000 * 100 ether = 7.5 ether
        assertEq(amount, 7.5 ether);
    }

    function test_RoyaltyBPS_PreservedAcrossMultipleTransfers() public {
        uint96 originalBps = 300; // 3%

        vm.prank(user1);
        usdc.approve(address(agentToken), type(uint256).max);
        vm.prank(user1);
        uint256 tokenId = agentToken.mintAgent(DID1, CAPABILITY_CID, TOKEN_URI, originalBps);

        // Transfer user1 -> user2
        vm.prank(user1);
        agentToken.transferFrom(user1, user2, tokenId);

        // Transfer user2 -> user1
        vm.prank(user2);
        agentToken.transferFrom(user2, user1, tokenId);

        // BPS must still be 300
        (, uint256 amount) = agentToken.royaltyInfo(tokenId, 10000);
        assertEq(amount, 300);
    }
}
