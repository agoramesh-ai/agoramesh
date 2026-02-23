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

/// @title DeployAll - Full AgoraMesh Deployment with Configuration
/// @notice Deploys ALL contracts, configures cross-contract permissions, whitelists USDC,
///         and saves deployment addresses to JSON. This is the canonical testnet deployment script.
/// @dev Run with: forge script script/DeployAll.s.sol --rpc-url base_sepolia --broadcast --verify
contract DeployAll is Script {
    // ============ USDC Addresses ============
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ============ LayerZero V2 Endpoints ============
    address constant LZ_ENDPOINT_SEPOLIA = 0x6EDCE65403992e310A62460808c4b910D972f10f;
    address constant LZ_ENDPOINT_MAINNET = 0x1a44076050125825900e736c501f859c50fE728c;

    // ============ Chain IDs ============
    uint256 constant BASE_MAINNET_CHAIN_ID = 8453;

    // ============ Deployed Addresses ============
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

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerPrivateKey);

        bool isMainnet = block.chainid == BASE_MAINNET_CHAIN_ID;
        address usdc = isMainnet ? USDC_MAINNET : USDC_SEPOLIA;
        address lzEndpoint = isMainnet ? LZ_ENDPOINT_MAINNET : LZ_ENDPOINT_SEPOLIA;

        console.log("========================================");
        console.log("  AGORAMESH FULL DEPLOYMENT");
        console.log("========================================");
        console.log("Chain ID:", block.chainid);
        console.log("Network:", isMainnet ? "Base Mainnet" : "Base Sepolia");
        console.log("Admin:", admin);
        console.log("USDC:", usdc);
        console.log("LayerZero Endpoint:", lzEndpoint);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // Phase 1: Deploy all contracts
        console.log("--- Phase 1: Deploying Contracts ---");
        DeployedContracts memory c = _deployContracts(admin, usdc, lzEndpoint);

        // Phase 2: Configure cross-contract roles
        console.log("\n--- Phase 2: Configuring Roles ---");
        _configureRoles(c);

        // Phase 3: Whitelist USDC on escrow
        console.log("\n--- Phase 3: Whitelisting Tokens ---");
        _configureTokenWhitelist(c.escrow, usdc);

        // Phase 4: Configure TieredDisputeResolution with escrow address
        // (already done via constructor, but grant ARBITER_ROLE on escrow)
        console.log("\n--- Phase 4: Configuring Dispute Resolution ---");
        _configureDisputeResolution(c.escrow, c.disputes);

        // Phase 5: Configure ChainRegistry
        console.log("\n--- Phase 5: Configuring Chain Registry ---");
        _configureChainRegistry(c.chainRegistry, c.trustRegistry, usdc, lzEndpoint, isMainnet);

        vm.stopBroadcast();

        // Phase 6: Save deployment addresses
        console.log("\n--- Phase 6: Saving Deployment ---");
        _saveDeployment(c, isMainnet, admin, usdc);

        // Phase 7: Log summary
        _logSummary(c, isMainnet, admin, usdc);
    }

    function _deployContracts(address admin, address usdc, address lzEndpoint)
        internal
        returns (DeployedContracts memory c)
    {
        // 1. TrustRegistry (core identity & reputation)
        c.trustRegistry = address(new TrustRegistry(usdc, admin));
        console.log("  1. TrustRegistry:", c.trustRegistry);

        // 2. ChainRegistry (multi-chain configuration)
        c.chainRegistry = address(new ChainRegistry(admin));
        console.log("  2. ChainRegistry:", c.chainRegistry);

        // 3. AgoraMeshEscrow (payment escrow)
        c.escrow = address(new AgoraMeshEscrow(c.trustRegistry, admin));
        console.log("  3. AgoraMeshEscrow:", c.escrow);

        // 4. TieredDisputeResolution (dispute handling)
        c.disputes = address(new TieredDisputeResolution(c.escrow, c.trustRegistry, usdc, admin));
        console.log("  4. TieredDisputeResolution:", c.disputes);

        // 5. StreamingPayments (continuous payments)
        c.streaming = address(new StreamingPayments(admin, c.trustRegistry));
        console.log("  5. StreamingPayments:", c.streaming);

        // 6. CrossChainTrustSync (LayerZero V2 OApp)
        c.crossChain = address(new CrossChainTrustSync(c.chainRegistry, lzEndpoint, admin));
        console.log("  6. CrossChainTrustSync:", c.crossChain);

        // 7. VerifiedNamespaces (ENS-inspired registry)
        c.namespaces = address(new VerifiedNamespaces(admin));
        console.log("  7. VerifiedNamespaces:", c.namespaces);

        // 8. AgentToken (ERC-721 agent ownership)
        c.agentToken = address(new AgentToken("AgoraMesh Agents", "AGENT", usdc, admin, admin));
        console.log("  8. AgentToken:", c.agentToken);

        // 9. NFTBoundReputation (reputation tied to agent NFTs)
        c.nftReputation = address(new NFTBoundReputation(c.agentToken, usdc, admin));
        console.log("  9. NFTBoundReputation:", c.nftReputation);
    }

    function _configureRoles(DeployedContracts memory c) internal {
        TrustRegistry registry = TrustRegistry(c.trustRegistry);
        NFTBoundReputation nftRep = NFTBoundReputation(c.nftReputation);

        // Grant escrow ORACLE_ROLE on TrustRegistry (to record transactions)
        registry.grantRole(registry.ORACLE_ROLE(), c.escrow);
        console.log("  - TrustRegistry: ORACLE_ROLE -> Escrow");

        // Grant disputes ARBITER_ROLE on TrustRegistry (to slash stakes)
        registry.grantRole(registry.ARBITER_ROLE(), c.disputes);
        console.log("  - TrustRegistry: ARBITER_ROLE -> DisputeResolution");

        // Grant escrow ORACLE_ROLE on NFTBoundReputation (to record transactions)
        nftRep.grantRole(nftRep.ORACLE_ROLE(), c.escrow);
        console.log("  - NFTBoundReputation: ORACLE_ROLE -> Escrow");

        // Grant disputes ARBITER_ROLE on NFTBoundReputation (to slash)
        nftRep.grantRole(nftRep.ARBITER_ROLE(), c.disputes);
        console.log("  - NFTBoundReputation: ARBITER_ROLE -> DisputeResolution");
    }

    function _configureTokenWhitelist(address escrowAddr, address usdc) internal {
        AgoraMeshEscrow escrowContract = AgoraMeshEscrow(escrowAddr);

        // Add USDC to the escrow token whitelist
        escrowContract.addAllowedToken(usdc);
        console.log("  - Escrow: whitelisted USDC token");
    }

    function _configureDisputeResolution(address escrowAddr, address disputesAddr) internal {
        AgoraMeshEscrow escrowContract = AgoraMeshEscrow(escrowAddr);

        // Grant TieredDisputeResolution the ARBITER_ROLE on escrow (to resolve disputes)
        escrowContract.grantRole(escrowContract.ARBITER_ROLE(), disputesAddr);
        console.log("  - Escrow: ARBITER_ROLE -> DisputeResolution");
    }

    function _configureChainRegistry(
        address chainRegistryAddr,
        address trustRegistryAddr,
        address usdc,
        address lzEndpoint,
        bool isMainnet
    ) internal {
        ChainRegistry chainReg = ChainRegistry(chainRegistryAddr);
        uint64 currentChainId = uint64(block.chainid);

        chainReg.addChain(currentChainId, isMainnet ? "Base Mainnet" : "Base Sepolia", !isMainnet);
        console.log("  - Added current chain to registry");

        chainReg.setTrustRegistry(currentChainId, trustRegistryAddr);
        console.log("  - Set TrustRegistry address on chain registry");

        chainReg.setUSDCAddress(currentChainId, usdc);
        console.log("  - Set USDC address on chain registry");

        chainReg.setEndpoint(currentChainId, lzEndpoint);
        console.log("  - Set LayerZero endpoint on chain registry");
    }

    function _saveDeployment(DeployedContracts memory c, bool isMainnet, address admin, address usdc) internal {
        string memory network = isMainnet ? "mainnet" : "sepolia";
        string memory outputDir = string.concat(vm.projectRoot(), "/../deployments");

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "network", isMainnet ? "Base Mainnet" : "Base Sepolia");
        vm.serializeAddress(obj, "admin", admin);
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeAddress(obj, "trustRegistry", c.trustRegistry);
        vm.serializeAddress(obj, "chainRegistry", c.chainRegistry);
        vm.serializeAddress(obj, "escrow", c.escrow);
        vm.serializeAddress(obj, "disputes", c.disputes);
        vm.serializeAddress(obj, "streaming", c.streaming);
        vm.serializeAddress(obj, "crossChain", c.crossChain);
        vm.serializeAddress(obj, "namespaces", c.namespaces);
        vm.serializeAddress(obj, "agentToken", c.agentToken);
        string memory json = vm.serializeAddress(obj, "nftReputation", c.nftReputation);

        string memory outputPath = string.concat(outputDir, "/", network, ".json");
        vm.writeJson(json, outputPath);
        console.log("  Deployment saved to:", outputPath);
    }

    function _logSummary(DeployedContracts memory c, bool isMainnet, address admin, address usdc) internal view {
        console.log("\n========================================");
        console.log("  DEPLOYMENT COMPLETE");
        console.log("========================================");
        console.log("Chain:", block.chainid, isMainnet ? "(Mainnet)" : "(Sepolia)");
        console.log("Admin:", admin);
        console.log("USDC:", usdc);
        console.log("");
        console.log("Contracts:");
        console.log("  TrustRegistry:           ", c.trustRegistry);
        console.log("  ChainRegistry:           ", c.chainRegistry);
        console.log("  AgoraMeshEscrow:         ", c.escrow);
        console.log("  TieredDisputeResolution: ", c.disputes);
        console.log("  StreamingPayments:       ", c.streaming);
        console.log("  CrossChainTrustSync:     ", c.crossChain);
        console.log("  VerifiedNamespaces:      ", c.namespaces);
        console.log("  AgentToken:              ", c.agentToken);
        console.log("  NFTBoundReputation:      ", c.nftReputation);
        console.log("");
        console.log("Configuration:");
        console.log("  USDC whitelisted on Escrow: YES");
        console.log("  Escrow ORACLE_ROLE on TrustRegistry: YES");
        console.log("  Disputes ARBITER_ROLE on TrustRegistry: YES");
        console.log("  Disputes ARBITER_ROLE on Escrow: YES");
        console.log("  Escrow ORACLE_ROLE on NFTBoundReputation: YES");
        console.log("  Disputes ARBITER_ROLE on NFTBoundReputation: YES");
        console.log("  ChainRegistry configured: YES");
        console.log("========================================");
    }
}
