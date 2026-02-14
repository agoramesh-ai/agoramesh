// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Deploy.s.sol";
import "forge-std/Script.sol";

/// @title SaveDeployment - Deploy and save addresses to JSON
/// @notice Extends Deploy to persist contract addresses for other components
/// @dev Run with: forge script script/SaveDeployment.s.sol --rpc-url base_sepolia --broadcast
contract SaveDeployment is Deploy {
    function run() external override {
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
        _saveDeployment(c, isMainnet, admin, usdc);
    }

    function _saveDeployment(DeployedContracts memory c, bool isMainnet, address admin, address usdc) internal {
        string memory network = isMainnet ? "mainnet" : "sepolia";
        string memory outputDir = string.concat(vm.projectRoot(), "/../deployments");

        // Build JSON using vm.serializeAddress
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
        console.log("\nDeployment saved to:", outputPath);
    }
}
