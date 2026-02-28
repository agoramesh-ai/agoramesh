/**
 * Shared formatting for agent data returned by MCP tools.
 * Handles both node API shape (x-agoramesh metadata) and semantic search results.
 */

interface SearchResult {
  did?: string;
  name?: string;
  description?: string;
  trust?: { score?: number; tier?: string };
  // Semantic search results may include these directly
  capabilities?: { id?: string; name?: string }[] | string[];
  pricing?: { model?: string; amount?: string; currency?: string };
  matchingSkills?: string[];
  // Node API full agent shape
  'x-agoramesh'?: {
    did?: string;
    trust_score?: number;
    pricing?: { base_price?: number; currency?: string; model?: string };
  };
  [key: string]: unknown;
}

export function formatAgent(agent: unknown): string {
  const a = agent as SearchResult;
  const lines: string[] = [];
  const meta = a['x-agoramesh'];

  const name = a.name ?? 'Unknown Agent';
  const did = meta?.did ?? a.did ?? 'N/A';

  lines.push(`## ${name}`);
  lines.push(`- **DID**: ${did}`);

  // Trust score — prefer computed (from trust object) over declared (x-agoramesh)
  const trustScore = a.trust?.score ?? meta?.trust_score;
  if (trustScore !== undefined) {
    const tier = a.trust?.tier ? ` (${a.trust.tier})` : '';
    lines.push(`- **Trust Score**: ${trustScore.toFixed(2)}${tier}`);
  }

  if (a.description) {
    lines.push(`- **Description**: ${a.description}`);
  }

  // Capabilities — array of objects or strings
  if (Array.isArray(a.capabilities) && a.capabilities.length > 0) {
    const names = a.capabilities.map((c) =>
      typeof c === 'string' ? c : (c as { name?: string }).name ?? (c as { id?: string }).id ?? '?'
    );
    lines.push(`- **Capabilities**: ${names.join(', ')}`);
  }

  if (a.matchingSkills?.length) {
    lines.push(`- **Matching**: ${a.matchingSkills.join(', ')}`);
  }

  // Pricing — from x-agoramesh or direct
  const pricing = meta?.pricing ?? a.pricing;
  if (pricing) {
    if ('base_price' in pricing && pricing.base_price !== undefined) {
      const price = ((pricing.base_price as number) / 1_000_000).toFixed(2);
      const model = pricing.model ? `/${pricing.model.replace('per_', '')}` : '';
      lines.push(`- **Pricing**: $${price} ${pricing.currency ?? 'USDC'}${model}`);
    } else if ('amount' in pricing) {
      const price = `${pricing.amount ?? '?'} ${pricing.currency ?? ''}`.trim();
      const model = pricing.model ? `/${pricing.model.replace('per_', '')}` : '';
      lines.push(`- **Pricing**: $${price}${model}`);
    }
  }

  return lines.join('\n');
}

export function formatAgentList(agents: unknown[], heading: string): string {
  const header = `# ${heading}\n\nFound ${agents.length} agent${agents.length === 1 ? '' : 's'}.\n`;
  const body = agents.map(formatAgent).join('\n\n');
  return `${header}\n${body}`;
}

/** Shared task result formatting for hire_agent and check_task tools. */
export interface TaskResultData {
  taskId: string;
  status: string;
  output?: string;
  error?: string;
  duration?: number;
}

export function formatTaskResult(result: TaskResultData, heading: string): string {
  const lines = [
    `# ${heading}`,
    '',
    `- **Task ID**: ${result.taskId}`,
    `- **Status**: ${result.status}`,
  ];

  if (result.status === 'failed') {
    lines.push(`- **Error**: ${result.error ?? 'Unknown error'}`);
  } else {
    if (result.duration !== undefined) lines.push(`- **Duration**: ${result.duration}s`);
    if (result.output) {
      lines.push('', '## Output', '', result.output);
    }
  }

  return lines.join('\n');
}
