import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';

interface AgentSkill {
  name?: string;
  tags?: string[];
  pricing?: { model?: string; amount?: string; currency?: string };
}

interface AgentData {
  did?: string;
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  trust?: { score?: number; tier?: string };
  skills?: AgentSkill[];
  capabilities?: Record<string, unknown>;
}

function formatAgent(agent: AgentData): string {
  const lines: string[] = [];

  lines.push(`# ${agent.name ?? 'Unknown Agent'}`);
  lines.push('');
  if (agent.did) lines.push(`- **DID**: ${agent.did}`);
  if (agent.description) lines.push(`- **Description**: ${agent.description}`);
  if (agent.version) lines.push(`- **Version**: ${agent.version}`);
  if (agent.url) lines.push(`- **URL**: ${agent.url}`);

  if (agent.trust) {
    lines.push('');
    lines.push('## Trust');
    const score = agent.trust.score !== undefined ? agent.trust.score : 'N/A';
    const tier = agent.trust.tier ? ` (${agent.trust.tier})` : '';
    lines.push(`- **Score**: ${score}${tier}`);
  }

  if (agent.skills && agent.skills.length > 0) {
    lines.push('');
    lines.push('## Skills');
    for (const skill of agent.skills) {
      lines.push(`### ${skill.name ?? 'Unnamed Skill'}`);
      if (skill.tags && skill.tags.length > 0) {
        lines.push(`- Tags: ${skill.tags.join(', ')}`);
      }
      if (skill.pricing) {
        const amount = skill.pricing.amount ?? '?';
        const model = skill.pricing.model ?? 'unknown';
        lines.push(`- Pricing: $${amount}/${model.replace('per_', '')}`);
      }
    }
  }

  if (agent.capabilities && Object.keys(agent.capabilities).length > 0) {
    lines.push('');
    lines.push('## Capabilities');
    const capLabels: Record<string, string> = {
      streaming: 'Streaming',
      x402Payments: 'x402 Payments',
    };
    for (const [key, value] of Object.entries(agent.capabilities)) {
      const label = capLabels[key] ?? key;
      lines.push(`- ${label}: ${value ? 'Yes' : 'No'}`);
    }
  }

  return lines.join('\n');
}

export function registerGetAgent(server: McpServer, client: NodeClient): void {
  server.registerTool(
    'get_agent',
    {
      description: 'Get full details for an agent by DID, including capabilities, skills, pricing, and trust info.',
      inputSchema: z.object({
        did: z.string().describe('The DID of the agent to look up'),
      }),
    },
    async ({ did }) => {
      try {
        const agent = await client.getAgent(did);
        if (agent === null) {
          return { content: [{ type: 'text' as const, text: `Agent not found: ${did}` }], isError: true };
        }
        const text = formatAgent(agent as AgentData);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}
