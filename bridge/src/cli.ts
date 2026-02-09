#!/usr/bin/env node
import 'dotenv/config';
import { BridgeServer, BridgeServerConfig } from './server.js';
import { AgentConfig } from './types.js';
import { EscrowClient, didToHash } from './escrow.js';
import { loadAgentCardConfig } from './config.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { X402Config } from './middleware/x402.js';

function loadConfig(): AgentConfig {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      console.error(`❌ Missing required env: ${key}`);
      console.error(`   Copy .env.example to .env and fill in values`);
      process.exit(1);
    }
    return value;
  };

  return {
    name: process.env.AGENT_NAME || 'Claude Code Agent',
    description: process.env.AGENT_DESCRIPTION || 'AI-powered development agent',
    skills: (process.env.AGENT_SKILLS || 'typescript,javascript').split(','),
    pricePerTask: parseFloat(process.env.AGENT_PRICE_PER_TASK || '5'),
    privateKey: required('AGENT_PRIVATE_KEY'),
    workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),
    allowedCommands: (process.env.ALLOWED_COMMANDS || 'claude,git,npm,node').split(','),
    taskTimeout: parseInt(process.env.TASK_TIMEOUT || '300', 10),
  };
}

function parseBool(value?: string): boolean {
  if (!value) return false;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
}

async function main() {
  console.log('🚀 AgentMesh Bridge - Claude Code Worker');
  console.log('=========================================\n');

  const envConfig = loadConfig();
  const jsonConfig = loadAgentCardConfig();
  const config = { ...envConfig, ...jsonConfig };
  const port = parseInt(process.env.BRIDGE_PORT || '3402', 10);
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  const requireAuth = process.env.BRIDGE_REQUIRE_AUTH
    ? parseBool(process.env.BRIDGE_REQUIRE_AUTH)
    : process.env.NODE_ENV === 'production';
  const apiToken = process.env.BRIDGE_API_TOKEN;

  const serverConfig: BridgeServerConfig = {
    ...config,
    host,
    requireAuth,
    apiToken,
  };

  // Optional escrow integration
  const escrowAddress = process.env.ESCROW_ADDRESS;
  const escrowRpcUrl = process.env.ESCROW_RPC_URL;
  const providerDid = process.env.PROVIDER_DID;

  if (escrowAddress && escrowRpcUrl && providerDid) {
    const chainId = parseInt(process.env.ESCROW_CHAIN_ID || '8453', 10);
    serverConfig.escrowClient = new EscrowClient({
      escrowAddress: escrowAddress as `0x${string}`,
      rpcUrl: escrowRpcUrl,
      privateKey: config.privateKey as `0x${string}`,
      chainId,
    });
    serverConfig.providerDid = didToHash(providerDid);
    console.log(`[Bridge] Escrow enabled: ${escrowAddress} (chain ${chainId})`);
    console.log(`[Bridge] Provider DID: ${providerDid}`);
  }

  const x402Enabled = parseBool(process.env.X402_ENABLED);
  if (x402Enabled) {
    const usdcAddress = process.env.X402_USDC_ADDRESS;
    if (!usdcAddress) {
      console.error('❌ Missing required env: X402_USDC_ADDRESS');
      process.exit(1);
    }

    const payTo = process.env.X402_PAY_TO
      || privateKeyToAccount(config.privateKey as `0x${string}`).address;
    const validityPeriod = parseInt(process.env.X402_VALIDITY_PERIOD || '300', 10);

    const x402Config: X402Config = {
      payTo,
      usdcAddress: usdcAddress as `0x${string}`,
      priceUsdc: config.pricePerTask,
      network: process.env.X402_NETWORK || 'eip155:8453',
      validityPeriod,
    };

    serverConfig.x402 = x402Config;
  }

  const server = new BridgeServer(serverConfig);

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    console.log('\n[Bridge] Shutting down...');
    await server.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start(port);

  console.log('\n📡 Ready to receive tasks!');
  console.log(`   REST API: http://localhost:${port}/task`);
  console.log(`   WebSocket: ws://localhost:${port}`);
  console.log(`   Agent Card: http://localhost:${port}/.well-known/agent.json`);
  console.log('\nPress Ctrl+C to stop\n');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
