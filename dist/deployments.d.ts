/**
 * Deployment address loader.
 *
 * Reads contract addresses from the shared deployments/ directory
 * so all components (SDK, bridge, node) use the same source of truth.
 */
export interface DeploymentAddresses {
    chainId: number;
    network: string;
    admin: `0x${string}`;
    usdc: `0x${string}`;
    trustRegistry: `0x${string}`;
    chainRegistry: `0x${string}`;
    escrow: `0x${string}`;
    disputes: `0x${string}`;
    streaming: `0x${string}`;
    crossChain: `0x${string}`;
    namespaces: `0x${string}`;
    agentToken: `0x${string}`;
    nftReputation: `0x${string}`;
}
/**
 * Load deployment addresses for a network.
 *
 * @param network - "sepolia" | "mainnet" | "local"
 * @param deploymentsDir - Override path to deployments directory
 * @returns Deployment addresses
 * @throws If the deployment file doesn't exist or has zero addresses
 */
export declare function loadDeployment(network: 'sepolia' | 'mainnet' | 'local', deploymentsDir?: string): DeploymentAddresses;
/**
 * Check if deployment addresses have been filled in (not all zeros).
 */
export declare function isDeployed(deployment: DeploymentAddresses): boolean;
//# sourceMappingURL=deployments.d.ts.map