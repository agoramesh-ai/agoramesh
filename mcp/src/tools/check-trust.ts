import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';

interface Endorsement {
  endorser?: string;
  endorserTrust?: number;
}

interface TrustData {
  score?: number;
  tier?: string;
  reputation?: { successRate?: number; totalTasks?: number; recentTasks?: number };
  stake?: { amount?: string; currency?: string };
  endorsements?: Endorsement[];
}

function formatTrust(did: string, trust: TrustData): string {
  const lines: string[] = [];

  lines.push(`# Trust Report: ${did}`);
  lines.push('');
  const scoreStr = trust.score !== undefined ? trust.score.toFixed(2) : 'N/A';
  lines.push(`- **Overall Score**: ${scoreStr}`);
  if (trust.tier) lines.push(`- **Tier**: ${trust.tier}`);

  lines.push('');
  lines.push('## Components');

  if (trust.reputation) {
    const sr = trust.reputation.successRate !== undefined ? trust.reputation.successRate.toFixed(2) : 'N/A';
    const parts = [`${sr} (success rate)`];
    if (trust.reputation.totalTasks !== undefined) parts.push(`${trust.reputation.totalTasks} total tasks`);
    if (trust.reputation.recentTasks !== undefined) parts.push(`${trust.reputation.recentTasks} recent`);
    lines.push(`- **Reputation**: ${parts.join(' | ')}`);
  }

  if (trust.stake) {
    lines.push(`- **Stake**: ${trust.stake.amount ?? '0'} ${trust.stake.currency ?? 'USDC'}`);
  }

  const endorsements = trust.endorsements ?? [];
  lines.push(`- **Endorsements**: ${endorsements.length} endorsers`);

  if (endorsements.length > 0) {
    lines.push('');
    lines.push('### Endorsers');
    for (let i = 0; i < endorsements.length; i++) {
      const e = endorsements[i];
      const trustStr = e.endorserTrust !== undefined ? e.endorserTrust.toFixed(2) : 'N/A';
      lines.push(`${i + 1}. ${e.endorser ?? 'unknown'} (trust: ${trustStr})`);
    }
  }

  return lines.join('\n');
}

export function registerCheckTrust(server: McpServer, client: NodeClient): void {
  server.registerTool(
    'check_trust',
    {
      description: 'Check trust score and breakdown for an agent by DID. Shows reputation, stake, and endorsements.',
      inputSchema: z.object({
        did: z.string().describe('The DID of the agent to check trust for'),
      }),
    },
    async ({ did }) => {
      try {
        const trust = await client.getTrust(did);
        if (trust === null) {
          return { content: [{ type: 'text' as const, text: `Agent not found: ${did}` }], isError: true };
        }
        const text = formatTrust(did, trust as TrustData);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
