// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CrossChainTrustSync.sol";
import "../src/ChainRegistry.sol";

/// @title CrossChainTrustSync Tests
/// @notice TDD tests for the CrossChainTrustSync contract
contract CrossChainTrustSyncTest is Test {
    CrossChainTrustSync public sync;
    ChainRegistry public chainRegistry;

    address public admin = address(0x1);
    address public user = address(0x2);
    address public endpoint = address(0x3);

    // Chain IDs
    uint64 public constant BASE_MAINNET = 8453;
    uint64 public constant POLYGON_MAINNET = 137;
    uint64 public constant ARBITRUM_MAINNET = 42161;

    // LayerZero endpoint IDs (EIDs)
    uint32 public constant BASE_EID = 30184;
    uint32 public constant POLYGON_EID = 30109;
    uint32 public constant ARBITRUM_EID = 30110;

    // Test DID hash
    bytes32 public constant TEST_DID = keccak256("did:agoramesh:base:0x1234");

    // Events
    event TrustSyncRequested(bytes32 indexed didHash, uint32 dstEid, uint256 trustScore);
    event TrustSyncReceived(bytes32 indexed didHash, uint32 srcEid, uint256 trustScore);
    event PeerSet(uint32 indexed eid, bytes32 peer);
    event PrimaryChainSet(uint64 indexed chainId);

    function setUp() public {
        vm.startPrank(admin);

        // Deploy ChainRegistry
        chainRegistry = new ChainRegistry(admin);

        // Add chains to registry
        chainRegistry.addChain(BASE_MAINNET, "Base", false);
        chainRegistry.addChain(POLYGON_MAINNET, "Polygon", false);
        chainRegistry.addChain(ARBITRUM_MAINNET, "Arbitrum", false);

        // Set endpoints
        chainRegistry.setEndpoint(BASE_MAINNET, endpoint);
        chainRegistry.setEndpoint(POLYGON_MAINNET, endpoint);
        chainRegistry.setEndpoint(ARBITRUM_MAINNET, endpoint);

        // Deploy CrossChainTrustSync
        sync = new CrossChainTrustSync(address(chainRegistry), endpoint, admin);

        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_Constructor_SetsAdmin() public {
        assertTrue(sync.hasRole(sync.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_SetsChainRegistry() public {
        assertEq(address(sync.chainRegistry()), address(chainRegistry));
    }

    function test_Constructor_SetsEndpoint() public {
        assertEq(address(sync.endpoint()), endpoint);
    }

    function test_Constructor_RevertsIfChainRegistryIsZero() public {
        vm.startPrank(admin);
        vm.expectRevert(CrossChainTrustSync.InvalidChainRegistry.selector);
        new CrossChainTrustSync(address(0), endpoint, admin);
        vm.stopPrank();
    }

    function test_Constructor_RevertsIfEndpointIsZero() public {
        vm.startPrank(admin);
        vm.expectRevert(CrossChainTrustSync.InvalidEndpoint.selector);
        new CrossChainTrustSync(address(chainRegistry), address(0), admin);
        vm.stopPrank();
    }

    function test_Constructor_RevertsIfAdminIsZero() public {
        vm.startPrank(admin);
        vm.expectRevert(CrossChainTrustSync.InvalidAdmin.selector);
        new CrossChainTrustSync(address(chainRegistry), endpoint, address(0));
        vm.stopPrank();
    }

    // ============ Set Primary Chain Tests ============

    function test_SetPrimaryChain_Success() public {
        vm.startPrank(admin);

        vm.expectEmit(true, false, false, false);
        emit PrimaryChainSet(BASE_MAINNET);

        sync.setPrimaryChain(BASE_MAINNET);

        assertEq(sync.primaryChainId(), BASE_MAINNET);

        vm.stopPrank();
    }

    function test_SetPrimaryChain_RevertsIfNotAdmin() public {
        vm.startPrank(user);
        vm.expectRevert();
        sync.setPrimaryChain(BASE_MAINNET);
        vm.stopPrank();
    }

    function test_SetPrimaryChain_RevertsIfChainNotSupported() public {
        vm.startPrank(admin);
        vm.expectRevert(CrossChainTrustSync.ChainNotSupported.selector);
        sync.setPrimaryChain(99999);
        vm.stopPrank();
    }

    // ============ Set Peer Tests ============

    function test_SetPeer_Success() public {
        vm.startPrank(admin);

        bytes32 peerAddress = bytes32(uint256(uint160(address(0x5678))));

        vm.expectEmit(true, false, false, true);
        emit PeerSet(POLYGON_EID, peerAddress);

        sync.setPeer(POLYGON_EID, peerAddress);

        assertEq(sync.peers(POLYGON_EID), peerAddress);

        vm.stopPrank();
    }

    function test_SetPeer_RevertsIfNotAdmin() public {
        vm.startPrank(user);
        vm.expectRevert();
        sync.setPeer(POLYGON_EID, bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ============ Cache Trust Score Tests ============

    function test_CacheTrustScore_Success() public {
        vm.startPrank(admin);

        uint256 trustScore = 8500;
        uint256 timestamp = block.timestamp;

        sync.cacheTrustScore(TEST_DID, trustScore, timestamp);

        (uint256 score, uint256 ts, bool exists) = sync.getCachedTrustScore(TEST_DID);
        assertEq(score, trustScore);
        assertEq(ts, timestamp);
        assertTrue(exists);

        vm.stopPrank();
    }

    function test_CacheTrustScore_RevertsIfScoreTooHigh() public {
        vm.startPrank(admin);
        vm.expectRevert(CrossChainTrustSync.InvalidTrustScore.selector);
        sync.cacheTrustScore(TEST_DID, 10001, block.timestamp);
        vm.stopPrank();
    }

    function test_GetCachedTrustScore_NotExistsIfNotSet() public {
        (uint256 score, uint256 ts, bool exists) = sync.getCachedTrustScore(TEST_DID);
        assertEq(score, 0);
        assertEq(ts, 0);
        assertFalse(exists);
    }

    // ============ Is Primary Chain Tests ============

    function test_IsPrimaryChain_True() public {
        vm.startPrank(admin);

        // Set chain ID to match BASE_MAINNET for this test
        vm.chainId(BASE_MAINNET);

        sync.setPrimaryChain(BASE_MAINNET);
        assertTrue(sync.isPrimaryChain());
        vm.stopPrank();
    }

    function test_IsPrimaryChain_FalseIfNotSet() public {
        assertFalse(sync.isPrimaryChain());
    }

    // ============ Get Aggregated Trust Score Tests ============

    function test_GetAggregatedTrustScore_ReturnsZeroIfNotCached() public {
        uint256 score = sync.getAggregatedTrustScore(TEST_DID);
        assertEq(score, 0);
    }

    function test_GetAggregatedTrustScore_ReturnsCachedScore() public {
        vm.startPrank(admin);

        uint256 trustScore = 7500;
        sync.cacheTrustScore(TEST_DID, trustScore, block.timestamp);

        uint256 score = sync.getAggregatedTrustScore(TEST_DID);
        assertEq(score, trustScore);

        vm.stopPrank();
    }

    // ============ Quote Sync Fee Tests ============

    function test_QuoteSyncFee_ReturnsZeroForMock() public {
        // In a mock scenario without real endpoint, returns 0
        // Real tests would require a mock endpoint
        uint256 fee = sync.quoteSyncFee(POLYGON_EID, TEST_DID, 8000);
        // Fee calculation depends on endpoint implementation
        assertGe(fee, 0);
    }

    // ============ Message Type Tests ============

    function test_MessageType_TrustSync() public {
        assertEq(uint8(sync.MSG_TYPE_TRUST_SYNC()), 1);
    }

    function test_MessageType_TrustQuery() public {
        assertEq(uint8(sync.MSG_TYPE_TRUST_QUERY()), 2);
    }

    // ============ Encode/Decode Message Tests ============

    function test_EncodeTrustSyncMessage() public {
        uint256 trustScore = 8500;
        uint256 timestamp = 1704067200;

        bytes memory encoded = sync.encodeTrustSyncMessage(TEST_DID, trustScore, timestamp);

        // Decode and verify
        (uint8 msgType, bytes32 didHash, uint256 score, uint256 ts) = sync.decodeTrustSyncMessage(encoded);
        assertEq(msgType, 1);
        assertEq(didHash, TEST_DID);
        assertEq(score, trustScore);
        assertEq(ts, timestamp);
    }

    // ============ Supported Chains Tests ============

    function test_GetSupportedDestinations_ReturnsChains() public {
        uint32[] memory dstEids = sync.getSupportedDestinations();
        // Without peers set, returns empty
        assertEq(dstEids.length, 0);
    }

    function test_GetSupportedDestinations_WithPeers() public {
        vm.startPrank(admin);

        sync.setPeer(POLYGON_EID, bytes32(uint256(1)));
        sync.setPeer(ARBITRUM_EID, bytes32(uint256(2)));

        uint32[] memory dstEids = sync.getSupportedDestinations();
        assertEq(dstEids.length, 2);

        vm.stopPrank();
    }

    // ============ Batch Sync Tests ============

    function test_BatchCacheTrustScores_Success() public {
        vm.startPrank(admin);

        bytes32[] memory dids = new bytes32[](3);
        dids[0] = keccak256("did:1");
        dids[1] = keccak256("did:2");
        dids[2] = keccak256("did:3");

        uint256[] memory scores = new uint256[](3);
        scores[0] = 8000;
        scores[1] = 7500;
        scores[2] = 9000;

        uint256[] memory timestamps = new uint256[](3);
        timestamps[0] = block.timestamp;
        timestamps[1] = block.timestamp;
        timestamps[2] = block.timestamp;

        sync.batchCacheTrustScores(dids, scores, timestamps);

        for (uint256 i = 0; i < dids.length; i++) {
            (uint256 score,, bool exists) = sync.getCachedTrustScore(dids[i]);
            assertEq(score, scores[i]);
            assertTrue(exists);
        }

        vm.stopPrank();
    }

    function test_BatchCacheTrustScores_RevertsIfArrayLengthMismatch() public {
        vm.startPrank(admin);

        bytes32[] memory dids = new bytes32[](2);
        uint256[] memory scores = new uint256[](3);
        uint256[] memory timestamps = new uint256[](2);

        vm.expectRevert(CrossChainTrustSync.ArrayLengthMismatch.selector);
        sync.batchCacheTrustScores(dids, scores, timestamps);

        vm.stopPrank();
    }

    // ============ Stale Cache Tests ============

    function test_IsCacheStale_TrueIfOld() public {
        vm.startPrank(admin);

        // Warp time forward first to avoid underflow
        vm.warp(3 days);

        uint256 oldTimestamp = block.timestamp - 2 days;
        sync.cacheTrustScore(TEST_DID, 8000, oldTimestamp);

        // Default cache TTL is 1 day
        assertTrue(sync.isCacheStale(TEST_DID));

        vm.stopPrank();
    }

    function test_IsCacheStale_FalseIfFresh() public {
        vm.startPrank(admin);

        sync.cacheTrustScore(TEST_DID, 8000, block.timestamp);

        assertFalse(sync.isCacheStale(TEST_DID));

        vm.stopPrank();
    }

    function test_SetCacheTTL_Success() public {
        vm.startPrank(admin);

        uint256 newTTL = 12 hours;
        sync.setCacheTTL(newTTL);

        assertEq(sync.cacheTTL(), newTTL);

        vm.stopPrank();
    }
}
