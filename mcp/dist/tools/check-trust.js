import { z } from 'zod';
function formatUsdc(raw) {
    return (raw / 1_000_000).toFixed(2);
}
function formatTrust(did, trust) {
    const lines = [];
    lines.push(`# Trust Report: ${did}`);
    lines.push('');
    const scoreStr = trust.score !== undefined ? trust.score.toFixed(2) : 'N/A';
    lines.push(`- **Overall Score**: ${scoreStr}`);
    if (trust.tier)
        lines.push(`- **Tier**: ${trust.tier}`);
    lines.push('');
    lines.push('## Components (weight: 50% reputation + 30% stake + 20% endorsement)');
    // Reputation component (flat field from node)
    if (trust.reputation !== undefined) {
        lines.push(`- **Reputation Score**: ${trust.reputation.toFixed(4)}`);
        const total = trust.successful_transactions ?? 0;
        const failed = trust.failed_transactions ?? 0;
        if (total > 0 || failed > 0) {
            const successRate = total / (total + failed);
            lines.push(`  - Success rate: ${(successRate * 100).toFixed(1)}% (${total} successful, ${failed} failed)`);
        }
    }
    // Stake component
    if (trust.stake_score !== undefined) {
        lines.push(`- **Stake Score**: ${trust.stake_score.toFixed(4)}`);
        if (trust.stake_amount !== undefined) {
            lines.push(`  - Staked: ${formatUsdc(trust.stake_amount)} USDC`);
        }
    }
    // Endorsement component
    if (trust.endorsement_score !== undefined) {
        lines.push(`- **Endorsement Score**: ${trust.endorsement_score.toFixed(4)}`);
        if (trust.endorsement_count !== undefined) {
            lines.push(`  - Endorsers: ${trust.endorsement_count}`);
        }
    }
    // Fallback: nested endorsements array (SDK/bridge format)
    const endorsements = trust.endorsements ?? [];
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
export function registerCheckTrust(server, client) {
    server.registerTool('check_trust', {
        description: 'Check trust score and breakdown for an agent by DID. Shows reputation, stake, and endorsements.',
        inputSchema: z.object({
            did: z.string().describe('The DID of the agent to check trust for'),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async ({ did }) => {
        try {
            const trust = await client.getTrust(did);
            if (trust === null) {
                return { content: [{ type: 'text', text: `Agent not found: ${did}` }], isError: true };
            }
            const text = formatTrust(did, trust);
            return { content: [{ type: 'text', text }] };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
        }
    });
}
