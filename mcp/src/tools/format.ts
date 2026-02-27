/**
 * Shared formatting for agent data returned by MCP tools.
 */

interface AgentData {
  did?: string;
  name?: string;
  description?: string;
  capabilities?: string[];
  pricing?: { model?: string; amount?: string; currency?: string };
  trust?: { score?: number; tier?: string };
  [key: string]: unknown;
}

export function formatAgent(agent: unknown): string {
  const a = agent as AgentData;
  const lines: string[] = [];

  lines.push(`## ${a.name ?? 'Unknown Agent'}`);
  lines.push(`- **DID**: ${a.did ?? 'N/A'}`);

  if (a.trust) {
    const tier = a.trust.tier ? ` (${a.trust.tier})` : '';
    lines.push(`- **Trust Score**: ${a.trust.score ?? 'N/A'}${tier}`);
  }

  if (a.description) {
    lines.push(`- **Description**: ${a.description}`);
  }

  if (a.capabilities?.length) {
    lines.push(`- **Skills**: ${a.capabilities.join(', ')}`);
  }

  if (a.pricing) {
    const price = `${a.pricing.amount ?? '?'} ${a.pricing.currency ?? ''}`.trim();
    const model = a.pricing.model ? `/${a.pricing.model.replace('per_', '')}` : '';
    lines.push(`- **Pricing**: $${price}${model}`);
  }

  return lines.join('\n');
}

export function formatAgentList(agents: unknown[], heading: string): string {
  const header = `# ${heading}\n\nFound ${agents.length} agent${agents.length === 1 ? '' : 's'}.\n`;
  const body = agents.map(formatAgent).join('\n\n');
  return `${header}\n${body}`;
}
