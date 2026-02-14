// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MockUSDC.sol";
import "../src/TrustRegistry.sol";
import "../src/AgentMeshEscrow.sol";
import "../src/TieredDisputeResolution.sol";
import "../src/StreamingPayments.sol";
import "../src/ChainRegistry.sol";
import "../src/CrossChainTrustSync.sol";
import "../src/VerifiedNamespaces.sol";
import "../src/AgentToken.sol";
import "../src/NFTBoundReputation.sol";
import "../src/ERC8004Adapter.sol";

/// @title DeployLocal - Deploy all contracts to local Anvil with MockUSDC
/// @notice Deploys MockUSDC, mints test tokens, then deploys all AgentMe contracts.
///         Writes addresses to deployments/local.json for other components.
/// @dev Run with: forge script script/DeployLocal.s.sol --rpc-url localhost --broadcast
contract DeployLocal is Script {
    /// @dev Stub LayerZero endpoint for local (CrossChainTrustSync requires one)
    address constant LZ_ENDPOINT_STUB = address(1);

    struct DeployedContracts {
        address usdc;
        address trustRegistry;
        address chainRegistry;
        address escrow;
        address disputes;
        address streaming;
        address crossChain;
        address namespaces;
        address agentToken;
        address nftReputation;
        address erc8004Adapter;
    }

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerPrivateKey);

        console.log("Deploying AgentMe to local Anvil (chain 31337)");
        console.log("Admin:", admin);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy MockUSDC and mint test tokens
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC deployed at:", address(usdc));

        // Mint 1M USDC to admin for testing
        usdc.mint(admin, 1_000_000 * 1e6);
        console.log("Minted 1,000,000 USDC to admin");

        // 2. Deploy core contracts
        DeployedContracts memory c;
        c.usdc = address(usdc);

        c.trustRegistry = address(new TrustRegistry(c.usdc, admin));
        console.log("TrustRegistry:", c.trustRegistry);

        c.chainRegistry = address(new ChainRegistry(admin));
        console.log("ChainRegistry:", c.chainRegistry);

        c.escrow = address(new AgentMeshEscrow(c.trustRegistry, admin));
        console.log("AgentMeshEscrow:", c.escrow);

        c.disputes = address(new TieredDisputeResolution(c.escrow, c.trustRegistry, c.usdc, admin));
        console.log("TieredDisputeResolution:", c.disputes);

        c.streaming = address(new StreamingPayments(admin, c.trustRegistry));
        console.log("StreamingPayments:", c.streaming);

        c.crossChain = address(new CrossChainTrustSync(c.chainRegistry, LZ_ENDPOINT_STUB, admin));
        console.log("CrossChainTrustSync:", c.crossChain);

        c.namespaces = address(new VerifiedNamespaces(admin));
        console.log("VerifiedNamespaces:", c.namespaces);

        c.agentToken = address(new AgentToken("AgentMe Agents", "AGENT", c.usdc, admin, admin));
        console.log("AgentToken:", c.agentToken);

        c.nftReputation = address(new NFTBoundReputation(c.agentToken, c.usdc, admin));
        console.log("NFTBoundReputation:", c.nftReputation);

        c.erc8004Adapter = address(new ERC8004Adapter(c.trustRegistry, c.agentToken));
        console.log("ERC8004Adapter:", c.erc8004Adapter);

        // 3. Configure roles
        TrustRegistry registry = TrustRegistry(c.trustRegistry);
        NFTBoundReputation nftRep = NFTBoundReputation(c.nftReputation);
        AgentMeshEscrow escrowContract = AgentMeshEscrow(c.escrow);

        registry.grantRole(registry.ORACLE_ROLE(), c.escrow);
        registry.grantRole(registry.ARBITER_ROLE(), c.disputes);
        nftRep.grantRole(nftRep.ORACLE_ROLE(), c.escrow);
        nftRep.grantRole(nftRep.ARBITER_ROLE(), c.disputes);

        // Whitelist USDC as allowed payment token in escrow
        escrowContract.addAllowedToken(c.usdc);
        console.log("USDC whitelisted in escrow");

        console.log("Roles configured");

        vm.stopBroadcast();

        // 4. Save deployment addresses
        _saveDeployment(c, admin);
    }

    function _saveDeployment(DeployedContracts memory c, address admin) internal {
        string memory outputDir = string.concat(vm.projectRoot(), "/../deployments");

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", 31337);
        vm.serializeString(obj, "network", "Local Anvil");
        vm.serializeAddress(obj, "admin", admin);
        vm.serializeAddress(obj, "usdc", c.usdc);
        vm.serializeAddress(obj, "trustRegistry", c.trustRegistry);
        vm.serializeAddress(obj, "chainRegistry", c.chainRegistry);
        vm.serializeAddress(obj, "escrow", c.escrow);
        vm.serializeAddress(obj, "disputes", c.disputes);
        vm.serializeAddress(obj, "streaming", c.streaming);
        vm.serializeAddress(obj, "crossChain", c.crossChain);
        vm.serializeAddress(obj, "namespaces", c.namespaces);
        vm.serializeAddress(obj, "agentToken", c.agentToken);
        vm.serializeAddress(obj, "nftReputation", c.nftReputation);
        string memory json = vm.serializeAddress(obj, "erc8004Adapter", c.erc8004Adapter);

        string memory outputPath = string.concat(outputDir, "/local.json");
        vm.writeJson(json, outputPath);
        console.log("\nDeployment saved to:", outputPath);
    }
}
