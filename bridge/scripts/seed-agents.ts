#!/usr/bin/env tsx
/**
 * Seed demo agents into the AgoraMesh P2P network.
 * Usage: npx tsx scripts/seed-agents.ts [nodeUrl]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedAgent {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  payment: Record<string, unknown>;
}

async function main() {
  const nodeUrl = process.argv[2] || process.env.AGORAMESH_NODE_URL || 'https://api.agoramesh.ai';
  const adminToken = process.env.AGORAMESH_ADMIN_TOKEN;

  console.log(`Seeding agents to: ${nodeUrl}`);

  const fixturesPath = resolve(__dirname, '../fixtures/seed-agents.json');
  const agents: SeedAgent[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

  let success = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`;
      }

      const response = await fetch(`${nodeUrl}/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(agent),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        console.log(`  ✓ ${agent.name}`);
        success++;
      } else {
        const text = await response.text();
        console.error(`  ✗ ${agent.name}: ${response.status} ${text}`);
        failed++;
      }
    } catch (error) {
      console.error(`  ✗ ${agent.name}: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} registered, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
