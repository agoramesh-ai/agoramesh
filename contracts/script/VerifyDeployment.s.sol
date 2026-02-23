// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/TrustRegistry.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/TieredDisputeResolution.sol";
import "../src/StreamingPayments.sol";
import "../src/ChainRegistry.sol";
import "../src/CrossChainTrustSync.sol";
import "../src/VerifiedNamespaces.sol";
import "../src/AgentToken.sol";
import "../src/NFTBoundReputation.sol";

/// @title VerifyDeployment - Post-deployment verification script
/// @notice Reads on-chain state to confirm all contracts are properly deployed and configured.
///         Loads addresses from deployments/<network>.json.
/// @dev Run with: forge script script/VerifyDeployment.s.sol --rpc-url base_sepolia
contract VerifyDeployment is Script {
    uint256 constant BASE_MAINNET_CHAIN_ID = 8453;

    struct Addrs {
        address trustRegistry;
        address chainRegistry;
        address escrow;
        address disputes;
        address streaming;
        address crossChain;
        address namespaces;
        address agentToken;
        address nftReputation;
        address admin;
        address usdc;
    }

    function run() external view {
        bool isMainnet = block.chainid == BASE_MAINNET_CHAIN_ID;
        string memory network = isMainnet ? "mainnet" : "sepolia";
        string memory jsonPath = string.concat(vm.projectRoot(), "/../deployments/", network, ".json");

        console.log("========================================");
        console.log("  DEPLOYMENT VERIFICATION");
        console.log("========================================");
        console.log("Chain ID:", block.chainid);
        console.log("Network:", isMainnet ? "Base Mainnet" : "Base Sepolia");
        console.log("Loading from:", jsonPath);
        console.log("");

        string memory json = vm.readFile(jsonPath);
        Addrs memory a = _parseAddrs(json);

        _logAddrs(a);
        _verifyCode(a);
        _verifyTrustRegistry(a);
        _verifyEscrow(a);
        _verifyDisputes(a);
        _verifyStreaming(a);
        _verifyNFTReputation(a);
        _verifyAgentToken(a);
        _verifyChainRegistry(a);

        console.log("\n========================================");
        console.log("  ALL CHECKS PASSED");
        console.log("========================================");
    }

    function _parseAddrs(string memory json) internal view returns (Addrs memory a) {
        a.trustRegistry = vm.parseJsonAddress(json, ".trustRegistry");
        a.chainRegistry = vm.parseJsonAddress(json, ".chainRegistry");
        a.escrow = vm.parseJsonAddress(json, ".escrow");
        a.disputes = vm.parseJsonAddress(json, ".disputes");
        a.streaming = vm.parseJsonAddress(json, ".streaming");
        a.crossChain = vm.parseJsonAddress(json, ".crossChain");
        a.namespaces = vm.parseJsonAddress(json, ".namespaces");
        a.agentToken = vm.parseJsonAddress(json, ".agentToken");
        a.nftReputation = vm.parseJsonAddress(json, ".nftReputation");
        a.admin = vm.parseJsonAddress(json, ".admin");
        a.usdc = vm.parseJsonAddress(json, ".usdc");
    }

    function _logAddrs(Addrs memory a) internal view {
        console.log("Loaded addresses:");
        console.log("  TrustRegistry:           ", a.trustRegistry);
        console.log("  ChainRegistry:           ", a.chainRegistry);
        console.log("  AgoraMeshEscrow:         ", a.escrow);
        console.log("  TieredDisputeResolution: ", a.disputes);
        console.log("  StreamingPayments:       ", a.streaming);
        console.log("  CrossChainTrustSync:     ", a.crossChain);
        console.log("  VerifiedNamespaces:      ", a.namespaces);
        console.log("  AgentToken:              ", a.agentToken);
        console.log("  NFTBoundReputation:      ", a.nftReputation);
        console.log("  Admin:                   ", a.admin);
        console.log("  USDC:                    ", a.usdc);
        console.log("");
    }

    // ====== Contract Code Checks ======

    function _verifyCode(Addrs memory a) internal view {
        console.log("--- 1. Contract Code Checks ---");
        _checkHasCode("TrustRegistry", a.trustRegistry);
        _checkHasCode("ChainRegistry", a.chainRegistry);
        _checkHasCode("AgoraMeshEscrow", a.escrow);
        _checkHasCode("TieredDisputeResolution", a.disputes);
        _checkHasCode("StreamingPayments", a.streaming);
        _checkHasCode("CrossChainTrustSync", a.crossChain);
        _checkHasCode("VerifiedNamespaces", a.namespaces);
        _checkHasCode("AgentToken", a.agentToken);
        _checkHasCode("NFTBoundReputation", a.nftReputation);
    }

    // ====== TrustRegistry ======

    function _verifyTrustRegistry(Addrs memory a) internal view {
        console.log("\n--- 2. TrustRegistry Configuration ---");
        TrustRegistry reg = TrustRegistry(a.trustRegistry);

        _check("Staking token is USDC", address(reg.stakingToken()) == a.usdc);
        _check("Admin role granted", reg.hasRole(reg.DEFAULT_ADMIN_ROLE(), a.admin));
        _check("Escrow has ORACLE_ROLE", reg.hasRole(reg.ORACLE_ROLE(), a.escrow));
        _check("Disputes has ARBITER_ROLE", reg.hasRole(reg.ARBITER_ROLE(), a.disputes));
    }

    // ====== AgoraMeshEscrow ======

    function _verifyEscrow(Addrs memory a) internal view {
        console.log("\n--- 3. AgoraMeshEscrow Configuration ---");
        AgoraMeshEscrow esc = AgoraMeshEscrow(a.escrow);

        _check("TrustRegistry reference correct", address(esc.trustRegistry()) == a.trustRegistry);
        _check("Admin role granted", esc.hasRole(esc.DEFAULT_ADMIN_ROLE(), a.admin));
        _check("USDC is whitelisted", esc.isTokenAllowed(a.usdc));
        _check("Disputes has ARBITER_ROLE", esc.hasRole(esc.ARBITER_ROLE(), a.disputes));
    }

    // ====== TieredDisputeResolution ======

    function _verifyDisputes(Addrs memory a) internal view {
        console.log("\n--- 4. TieredDisputeResolution Configuration ---");
        TieredDisputeResolution dis = TieredDisputeResolution(a.disputes);

        _check("Escrow reference correct", address(dis.escrow()) == a.escrow);
        _check("TrustRegistry reference correct", address(dis.trustRegistry()) == a.trustRegistry);
        _check("Payment token is USDC", address(dis.paymentToken()) == a.usdc);
        _check("Admin role granted", dis.hasRole(dis.DEFAULT_ADMIN_ROLE(), a.admin));
    }

    // ====== StreamingPayments ======

    function _verifyStreaming(Addrs memory a) internal view {
        console.log("\n--- 5. StreamingPayments Configuration ---");
        StreamingPayments str = StreamingPayments(a.streaming);

        _check("TrustRegistry reference correct", address(str.trustRegistry()) == a.trustRegistry);
        _check("Admin role granted", str.hasRole(str.DEFAULT_ADMIN_ROLE(), a.admin));
    }

    // ====== NFTBoundReputation ======

    function _verifyNFTReputation(Addrs memory a) internal view {
        console.log("\n--- 6. NFTBoundReputation Configuration ---");
        NFTBoundReputation nft = NFTBoundReputation(a.nftReputation);

        _check("AgentToken reference correct", address(nft.agentToken()) == a.agentToken);
        _check("Staking token is USDC", address(nft.stakingToken()) == a.usdc);
        _check("Admin role granted", nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), a.admin));
        _check("Escrow has ORACLE_ROLE", nft.hasRole(nft.ORACLE_ROLE(), a.escrow));
        _check("Disputes has ARBITER_ROLE", nft.hasRole(nft.ARBITER_ROLE(), a.disputes));
    }

    // ====== AgentToken ======

    function _verifyAgentToken(Addrs memory a) internal view {
        console.log("\n--- 7. AgentToken Configuration ---");
        AgentToken tok = AgentToken(a.agentToken);

        _check("USDC reference correct", address(tok.usdc()) == a.usdc);
        _check("Treasury is admin", tok.treasury() == a.admin);
        _check("Admin role granted", tok.hasRole(tok.DEFAULT_ADMIN_ROLE(), a.admin));
    }

    // ====== ChainRegistry ======

    function _verifyChainRegistry(Addrs memory a) internal view {
        console.log("\n--- 8. ChainRegistry Configuration ---");
        ChainRegistry cr = ChainRegistry(a.chainRegistry);

        _check("Admin role granted", cr.hasRole(cr.DEFAULT_ADMIN_ROLE(), a.admin));
    }

    // ====== Helpers ======

    function _checkHasCode(string memory name, address addr) internal view {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        if (size == 0) {
            console.log("  FAIL:", name, "has no code at", addr);
            revert(string.concat("No code at ", name));
        }
        console.log("  PASS:", name, "has code");
    }

    function _check(string memory description, bool condition) internal view {
        if (!condition) {
            console.log("  FAIL:", description);
            revert(string.concat("Check failed: ", description));
        }
        console.log("  PASS:", description);
    }
}
