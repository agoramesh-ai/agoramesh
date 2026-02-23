/**
 * Deployment address loader.
 *
 * Reads contract addresses from the shared deployments/ directory
 * so all components (SDK, bridge, node) use the same source of truth.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/**
 * Load deployment addresses for a network.
 *
 * @param network - "sepolia" | "mainnet" | "local"
 * @param deploymentsDir - Override path to deployments directory
 * @returns Deployment addresses
 * @throws If the deployment file doesn't exist or has zero addresses
 */
export function loadDeployment(network, deploymentsDir) {
    const dir = deploymentsDir ??
        resolve(dirname(fileURLToPath(import.meta.url)), '../../deployments');
    const filePath = resolve(dir, `${network}.json`);
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return data;
}
/**
 * Check if deployment addresses have been filled in (not all zeros).
 */
export function isDeployed(deployment) {
    return deployment.trustRegistry !== ZERO_ADDRESS && deployment.escrow !== ZERO_ADDRESS;
}
//# sourceMappingURL=deployments.js.map