/**
 * Deployment address loader.
 *
 * Reads contract addresses from the shared deployments/ directory
 * so all components (SDK, bridge, node) use the same source of truth.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Load deployment addresses for a network.
 *
 * @param network - "sepolia" | "mainnet" | "local"
 * @param deploymentsDir - Override path to deployments directory
 * @returns Deployment addresses
 * @throws If the deployment file doesn't exist or has zero addresses
 */
export function loadDeployment(
  network: 'sepolia' | 'mainnet' | 'local',
  deploymentsDir?: string
): DeploymentAddresses {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dir =
    deploymentsDir ??
    // npm package: deployments/ is sibling to dist/
    // monorepo: deployments/ is at repo root (two levels up from sdk/dist/)
    (existsSync(resolve(__dirname, '../deployments'))
      ? resolve(__dirname, '../deployments')
      : resolve(__dirname, '../../deployments'));
  const filePath = resolve(dir, `${network}.json`);

  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as DeploymentAddresses;

  return data;
}

/**
 * Check if deployment addresses have been filled in (not all zeros).
 */
export function isDeployed(deployment: DeploymentAddresses): boolean {
  return deployment.trustRegistry !== ZERO_ADDRESS && deployment.escrow !== ZERO_ADDRESS;
}
