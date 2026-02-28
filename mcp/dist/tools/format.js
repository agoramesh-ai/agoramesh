/**
 * Shared formatting for agent data returned by MCP tools.
 * Handles both node API shape (x-agoramesh metadata) and semantic search results.
 */
export function formatAgent(agent) {
    const a = agent;
    const lines = [];
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
        const names = a.capabilities.map((c) => typeof c === 'string' ? c : c.name ?? c.id ?? '?');
        lines.push(`- **Capabilities**: ${names.join(', ')}`);
    }
    if (a.matchingSkills?.length) {
        lines.push(`- **Matching**: ${a.matchingSkills.join(', ')}`);
    }
    // Pricing — from x-agoramesh or direct
    const pricing = meta?.pricing ?? a.pricing;
    if (pricing) {
        if ('base_price' in pricing && pricing.base_price !== undefined) {
            const price = (pricing.base_price / 1_000_000).toFixed(2);
            const model = pricing.model ? `/${pricing.model.replace('per_', '')}` : '';
            lines.push(`- **Pricing**: $${price} ${pricing.currency ?? 'USDC'}${model}`);
        }
        else if ('amount' in pricing) {
            const price = `${pricing.amount ?? '?'} ${pricing.currency ?? ''}`.trim();
            const model = pricing.model ? `/${pricing.model.replace('per_', '')}` : '';
            lines.push(`- **Pricing**: $${price}${model}`);
        }
    }
    return lines.join('\n');
}
export function formatAgentList(agents, heading) {
    const header = `# ${heading}\n\nFound ${agents.length} agent${agents.length === 1 ? '' : 's'}.\n`;
    const body = agents.map(formatAgent).join('\n\n');
    return `${header}\n${body}`;
}
