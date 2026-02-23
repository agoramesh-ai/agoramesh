#!/usr/bin/env tsx
/**
 * AgoraMesh E2E Demo — Discover & Verify (read-only)
 *
 * Demonstrates the full Discover -> Verify flow against the live production API.
 * No wallet, no private key, no configuration required.
 *
 * Usage:
 *   npx tsx scripts/demo.ts
 *
 * Optional environment variables:
 *   NODE_URL   - Override the node API URL  (default: https://api.agoramesh.ai)
 *   BRIDGE_URL - Override the bridge URL    (default: https://bridge.agoramesh.ai)
 */

// =============================================================================
// Configuration
// =============================================================================

const NODE_URL = process.env.NODE_URL ?? 'https://api.agoramesh.ai';
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'https://bridge.agoramesh.ai';

// =============================================================================
// Types (inline — no SDK import needed)
// =============================================================================

interface HealthResponse {
  status: string;
  version: string;
  peers: number;
  uptime: number;
}

interface Capability {
  id: string;
  name: string;
  description: string;
}

interface AgoraMeshExtension {
  did: string;
  trust_score: number;
  stake: number;
  pricing: {
    base_price: number;
    currency: string;
    model: string;
  };
  payment_methods: string[];
}

interface AgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: Capability[];
  'x-agoramesh': AgoraMeshExtension;
}

interface TrustInfo {
  did: string;
  score: number;
  reputation: number;
  stake_score: number;
  endorsement_score: number;
  stake_amount: number;
  successful_transactions: number;
  failed_transactions: number;
  endorsement_count: number;
}

interface SemanticResult {
  did: string;
  score: number;
  vector_score: number;
  keyword_score: number;
  card: AgentCard;
  trust: TrustInfo;
}

interface AgentJsonSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  pricing?: {
    model: string;
    amount: string;
    currency: string;
  };
}

interface AgentJson {
  name: string;
  description: string;
  version: string;
  skills: AgentJsonSkill[];
  payment: {
    methods: string[];
    currencies: string[];
    chains: string[];
  };
  capabilities: Record<string, boolean>;
  provider?: {
    name: string;
    url: string;
  };
}

// =============================================================================
// Helpers
// =============================================================================

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function header(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
  console.log('='.repeat(title.length));
}

function section(num: number, title: string): void {
  console.log(`\n${BOLD}${num}. ${title}${RESET}`);
}

function info(label: string, value: string): void {
  console.log(`   ${DIM}${label}:${RESET} ${value}`);
}

function bullet(text: string): void {
  console.log(`     -> ${text}`);
}

function success(message: string): void {
  console.log(`\n${GREEN}${BOLD}v${RESET} ${GREEN}${message}${RESET}`);
}

function fail(message: string): void {
  console.log(`\n${RED}${BOLD}x${RESET} ${RED}${message}${RESET}`);
}

function warn(message: string): void {
  console.log(`   ${YELLOW}! ${message}${RESET}`);
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatStake(microUsdc: number): string {
  return `${(microUsdc / 1_000_000).toFixed(2)} USDC`;
}

// =============================================================================
// Demo Steps
// =============================================================================

async function step1_healthCheck(): Promise<HealthResponse> {
  section(1, 'Health Check');
  info('Node', NODE_URL);

  const health = await fetchJson<HealthResponse>(`${NODE_URL}/health`, 'Health check');

  info('Status', health.status === 'ok' ? `${GREEN}ok${RESET}` : `${RED}${health.status}${RESET}`);
  info('Version', health.version);
  info('Peers', String(health.peers));
  info('Uptime', formatUptime(health.uptime));

  return health;
}

async function step2_discoverAgents(): Promise<SemanticResult[]> {
  section(2, 'Discover Agents');

  const query = 'code review';
  info('Query', `"${query}"  ${DIM}(semantic search)${RESET}`);

  const results = await fetchJson<SemanticResult[]>(
    `${NODE_URL}/agents/semantic?q=${encodeURIComponent(query)}`,
    'Semantic search',
  );

  info('Found', `${results.length} agent(s)`);

  for (const result of results) {
    const card = result.card;
    console.log();
    bullet(`${BOLD}${card.name}${RESET}`);
    bullet(`URL: ${CYAN}${card.url}${RESET}`);
    bullet(`DID: ${DIM}${result.did}${RESET}`);
    bullet(`Match: ${(result.score * 100).toFixed(1)}%  ${DIM}(vector: ${(result.vector_score * 100).toFixed(1)}%, keyword: ${(result.keyword_score * 100).toFixed(1)}%)${RESET}`);

    const caps = card.capabilities.map((c) => c.name).join(', ');
    bullet(`Capabilities: ${caps}`);
  }

  return results;
}

async function step3_verifyTrust(agent: SemanticResult): Promise<TrustInfo> {
  section(3, 'Verify Trust');

  const did = agent.did;
  info('Agent', agent.card.name);
  info('DID', did);

  // Fetch trust details from the /trust endpoint
  const trust = await fetchJson<TrustInfo>(`${NODE_URL}/trust/${encodeURIComponent(did)}`, 'Trust lookup');

  const score = trust.score;
  const rep = trust.reputation;
  const stake = trust.stake_score;
  const endorse = trust.endorsement_score;

  console.log();
  info('Trust Score', `${BOLD}${score.toFixed(3)}${RESET}`);
  info('  Reputation', `${rep.toFixed(3)}  ${DIM}(weight: 50%)${RESET}`);
  info('  Stake', `${stake.toFixed(3)}  ${DIM}(weight: 30%)${RESET}`);
  info('  Endorsement', `${endorse.toFixed(3)}  ${DIM}(weight: 20%)${RESET}`);
  console.log();

  const total = trust.successful_transactions + trust.failed_transactions;
  const successRate = total > 0 ? ((trust.successful_transactions / total) * 100).toFixed(1) : 'N/A';
  info('Transactions', `${trust.successful_transactions} successful / ${trust.failed_transactions} failed  ${DIM}(${successRate}% success rate)${RESET}`);
  info('Stake Amount', formatStake(trust.stake_amount));
  info('Endorsements', String(trust.endorsement_count));

  return trust;
}

async function step4_fetchAgentCard(): Promise<AgentJson> {
  section(4, 'Fetch Agent Card');

  const endpoint = `${BRIDGE_URL}/.well-known/agent.json`;
  info('Endpoint', CYAN + endpoint + RESET);

  const card = await fetchJson<AgentJson>(endpoint, 'Agent Card');

  info('Name', card.name);
  info('Version', card.version);

  if (card.provider) {
    info('Provider', `${card.provider.name} (${card.provider.url})`);
  }

  const skillNames = card.skills.map((s) => s.name).join(', ');
  info('Skills', skillNames);

  const methods = card.payment.methods.join(', ');
  const currencies = card.payment.currencies.join(', ');
  info('Payment', `${methods} (${currencies})`);

  // Show pricing
  const prices = card.skills
    .filter((s) => s.pricing)
    .map((s) => `${s.name}: ${s.pricing!.amount} ${s.pricing!.currency}/${s.pricing!.model}`)
    .slice(0, 3);
  if (prices.length > 0) {
    for (const p of prices) {
      bullet(`${DIM}${p}${RESET}`);
    }
  }

  return card;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  header('AgoraMesh E2E Demo');

  try {
    // Step 1: Health check
    const health = await step1_healthCheck();
    if (health.status !== 'ok') {
      fail(`Node reports unhealthy status: ${health.status}`);
      process.exit(1);
    }

    // Step 2: Discover agents via semantic search
    const results = await step2_discoverAgents();
    if (results.length === 0) {
      warn('No agents found. The network may be empty.');
    }

    // Step 3: Verify trust for the first discovered agent
    if (results.length > 0) {
      await step3_verifyTrust(results[0]);
    } else {
      section(3, 'Verify Trust');
      warn('Skipped (no agents discovered)');
    }

    // Step 4: Fetch the A2A-compatible Agent Card from the bridge
    await step4_fetchAgentCard();

    // Done
    success('Demo complete -- all systems operational');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Demo failed: ${message}`);

    if (err instanceof Error && err.cause) {
      console.error(`   Cause: ${err.cause}`);
    }

    process.exit(1);
  }
}

main();
