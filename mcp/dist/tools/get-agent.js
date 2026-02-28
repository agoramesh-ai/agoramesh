import { z } from 'zod';
function formatUsdc(raw) {
    return (raw / 1_000_000).toFixed(2);
}
function formatAgent(agent) {
    const lines = [];
    const meta = agent['x-agoramesh'];
    const did = meta?.did ?? agent.did;
    lines.push(`# ${agent.name ?? 'Unknown Agent'}`);
    lines.push('');
    if (did)
        lines.push(`- **DID**: ${did}`);
    if (agent.description)
        lines.push(`- **Description**: ${agent.description}`);
    if (agent.url)
        lines.push(`- **URL**: ${agent.url}`);
    // Trust & stake from x-agoramesh metadata
    if (meta) {
        lines.push('');
        lines.push('## Trust & Stake');
        if (meta.trust_score !== undefined)
            lines.push(`- **Trust Score**: ${meta.trust_score.toFixed(2)}`);
        if (meta.stake !== undefined)
            lines.push(`- **Stake**: ${formatUsdc(meta.stake)} USDC`);
        if (meta.payment_methods?.length)
            lines.push(`- **Payment Methods**: ${meta.payment_methods.join(', ')}`);
    }
    else if (agent.trust) {
        lines.push('');
        lines.push('## Trust');
        const score = agent.trust.score !== undefined ? agent.trust.score.toFixed(2) : 'N/A';
        const tier = agent.trust.tier ? ` (${agent.trust.tier})` : '';
        lines.push(`- **Score**: ${score}${tier}`);
    }
    // Pricing
    if (meta?.pricing) {
        lines.push('');
        lines.push('## Pricing');
        const price = meta.pricing.base_price !== undefined ? formatUsdc(meta.pricing.base_price) : '?';
        const currency = meta.pricing.currency ?? 'USDC';
        const model = meta.pricing.model ? `/${meta.pricing.model.replace('per_', '')}` : '';
        lines.push(`- **Price**: $${price} ${currency}${model}`);
    }
    // Capabilities (array from node API)
    const caps = agent.capabilities;
    if (Array.isArray(caps) && caps.length > 0) {
        lines.push('');
        lines.push('## Capabilities');
        for (const cap of caps) {
            const name = cap.name ?? cap.id ?? 'Unknown';
            const desc = cap.description;
            lines.push(`- **${name}**${desc ? `: ${desc}` : ''}`);
        }
    }
    // Skills fallback (SDK/bridge format)
    if (agent.skills && agent.skills.length > 0) {
        lines.push('');
        lines.push('## Skills');
        for (const skill of agent.skills) {
            lines.push(`- **${skill.name ?? 'Unnamed'}**${skill.description ? `: ${skill.description}` : ''}`);
        }
    }
    return lines.join('\n');
}
export function registerGetAgent(server, client) {
    server.registerTool('get_agent', {
        description: 'Get full details for an agent by DID, including capabilities, skills, pricing, and trust info.',
        inputSchema: z.object({
            did: z.string().describe('The DID of the agent to look up'),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async ({ did }) => {
        try {
            const agent = await client.getAgent(did);
            if (agent === null) {
                return { content: [{ type: 'text', text: `Agent not found: ${did}` }], isError: true };
            }
            const text = formatAgent(agent);
            return { content: [{ type: 'text', text }] };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
        }
    });
}
