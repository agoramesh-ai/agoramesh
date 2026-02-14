// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/TrustRegistry.sol";
import "../src/AgentMeshEscrow.sol";
import "../src/TieredDisputeResolution.sol";
import "../src/StreamingPayments.sol";
import "../src/ChainRegistry.sol";
import "../src/CrossChainTrustSync.sol";
import "../src/VerifiedNamespaces.sol";
import "../src/AgentToken.sol";
import "../src/NFTBoundReputation.sol";

/// @title Deploy - AgentMe Deployment Script
/// @notice Deploys all AgentMe contracts to Base L2
/// @dev Run with: forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    // ============ USDC Addresses ============
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ============ LayerZero V2 Endpoints ============
    // Source: https://docs.layerzero.network/v2/deployments/deployed-contracts
    address constant LZ_ENDPOINT_SEPOLIA = 0x6EDCE65403992e310A62460808c4b910D972f10f;
    address constant LZ_ENDPOINT_MAINNET = 0x1a44076050125825900e736c501f859c50fE728c;

    // ============ Chain IDs ============
    uint256 constant BASE_MAINNET_CHAIN_ID = 8453;

    // ============ Deployed Addresses (stored to avoid stack depth issues) ============
    struct DeployedContracts {
        address trustRegistry;
        address chainRegistry;
        address escrow;
        address disputes;
        address streaming;
        address crossChain;
        address namespaces;
        address agentToken;
        address nftReputation;
    }

    function run() external virtual {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerPrivateKey);

        // Select addresses based on chain
        bool isMainnet = block.chainid == BASE_MAINNET_CHAIN_ID;
        address usdc = isMainnet ? USDC_MAINNET : USDC_SEPOLIA;
        address lzEndpoint = isMainnet ? LZ_ENDPOINT_MAINNET : LZ_ENDPOINT_SEPOLIA;

        console.log("Deploying AgentMe to chain:", block.chainid);
        console.log("Admin:", admin);
        console.log("USDC:", usdc);
        console.log("LayerZero Endpoint:", lzEndpoint);

        vm.startBroadcast(deployerPrivateKey);

        DeployedContracts memory c = _deployContracts(admin, usdc, lzEndpoint);
        _configureRoles(c);
        _configureChainRegistry(c.chainRegistry, c.trustRegistry, usdc, lzEndpoint, isMainnet);

        vm.stopBroadcast();

        _logSummary(c, isMainnet, admin);
    }

    function _deployContracts(address admin, address usdc, address lzEndpoint)
        internal
        returns (DeployedContracts memory c)
    {
        // 1. TrustRegistry (core identity & reputation)
        c.trustRegistry = address(new TrustRegistry(usdc, admin));
        console.log("1. TrustRegistry deployed at:", c.trustRegistry);

        // 2. ChainRegistry (multi-chain configuration)
        c.chainRegistry = address(new ChainRegistry(admin));
        console.log("2. ChainRegistry deployed at:", c.chainRegistry);

        // 3. Escrow (one-time payments)
        c.escrow = address(new AgentMeshEscrow(c.trustRegistry, admin));
        console.log("3. AgentMeshEscrow deployed at:", c.escrow);

        // 4. TieredDisputeResolution
        c.disputes = address(new TieredDisputeResolution(c.escrow, c.trustRegistry, usdc, admin));
        console.log("4. TieredDisputeResolution deployed at:", c.disputes);

        // 5. StreamingPayments
        c.streaming = address(new StreamingPayments(admin, c.trustRegistry));
        console.log("5. StreamingPayments deployed at:", c.streaming);

        // 6. CrossChainTrustSync (LayerZero V2 OApp)
        c.crossChain = address(new CrossChainTrustSync(c.chainRegistry, lzEndpoint, admin));
        console.log("6. CrossChainTrustSync deployed at:", c.crossChain);

        // 7. VerifiedNamespaces (ENS-inspired registry)
        c.namespaces = address(new VerifiedNamespaces(admin));
        console.log("7. VerifiedNamespaces deployed at:", c.namespaces);

        // 8. AgentToken (ERC-721 + ERC-2981 for agent ownership)
        c.agentToken = address(new AgentToken("AgentMe Agents", "AGENT", usdc, admin, admin));
        console.log("8. AgentToken deployed at:", c.agentToken);

        // 9. NFTBoundReputation (reputation tied to agent NFTs)
        c.nftReputation = address(new NFTBoundReputation(c.agentToken, usdc, admin));
        console.log("9. NFTBoundReputation deployed at:", c.nftReputation);
    }

    function _configureRoles(DeployedContracts memory c) internal {
        console.log("\nConfiguring roles...");

        TrustRegistry registry = TrustRegistry(c.trustRegistry);
        NFTBoundReputation nftRep = NFTBoundReputation(c.nftReputation);

        // Grant escrow the ORACLE_ROLE to record transactions on TrustRegistry
        registry.grantRole(registry.ORACLE_ROLE(), c.escrow);
        console.log("- Granted ORACLE_ROLE to Escrow on TrustRegistry");

        // Grant disputes the ARBITER_ROLE on TrustRegistry
        registry.grantRole(registry.ARBITER_ROLE(), c.disputes);
        console.log("- Granted ARBITER_ROLE to DisputeResolution on TrustRegistry");

        // Grant escrow the ORACLE_ROLE on NFTBoundReputation
        nftRep.grantRole(nftRep.ORACLE_ROLE(), c.escrow);
        console.log("- Granted ORACLE_ROLE to Escrow on NFTBoundReputation");

        // Grant disputes the ARBITER_ROLE on NFTBoundReputation
        nftRep.grantRole(nftRep.ARBITER_ROLE(), c.disputes);
        console.log("- Granted ARBITER_ROLE to DisputeResolution on NFTBoundReputation");
    }

    function _configureChainRegistry(
        address chainRegistryAddr,
        address trustRegistryAddr,
        address usdc,
        address lzEndpoint,
        bool isMainnet
    ) internal {
        console.log("\nConfiguring chain registry...");

        ChainRegistry chainReg = ChainRegistry(chainRegistryAddr);
        uint64 currentChainId = uint64(block.chainid);

        // Add current chain
        chainReg.addChain(currentChainId, isMainnet ? "Base Mainnet" : "Base Sepolia", !isMainnet);
        console.log("- Added current chain to ChainRegistry");

        // Set addresses
        chainReg.setTrustRegistry(currentChainId, trustRegistryAddr);
        console.log("- Set TrustRegistry address");

        chainReg.setUSDCAddress(currentChainId, usdc);
        console.log("- Set USDC address");

        chainReg.setEndpoint(currentChainId, lzEndpoint);
        console.log("- Set LayerZero endpoint");
    }

    function _logSummary(DeployedContracts memory c, bool isMainnet, address admin) internal view {
        console.log("\n========================================");
        console.log("        DEPLOYMENT SUMMARY");
        console.log("========================================");
        console.log("Chain ID:", block.chainid);
        console.log("Network:", isMainnet ? "Base Mainnet" : "Base Sepolia");
        console.log("Admin:", admin);
        console.log("");
        console.log("Core Infrastructure:");
        console.log("  TrustRegistry:           ", c.trustRegistry);
        console.log("  ChainRegistry:           ", c.chainRegistry);
        console.log("");
        console.log("Payment Layer:");
        console.log("  AgentMeshEscrow:         ", c.escrow);
        console.log("  TieredDisputeResolution: ", c.disputes);
        console.log("  StreamingPayments:       ", c.streaming);
        console.log("");
        console.log("Cross-Chain Layer:");
        console.log("  CrossChainTrustSync:     ", c.crossChain);
        console.log("");
        console.log("Identity & Namespace Layer:");
        console.log("  VerifiedNamespaces:      ", c.namespaces);
        console.log("");
        console.log("Agent Tokenization Layer:");
        console.log("  AgentToken:              ", c.agentToken);
        console.log("  NFTBoundReputation:      ", c.nftReputation);
        console.log("========================================");
    }
}
