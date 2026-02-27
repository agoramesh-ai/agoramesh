import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';
import { formatAgentList } from './format.js';

export function registerSearchAgents(server: McpServer, nodeClient: NodeClient): void {
  server.registerTool(
    'search_agents',
    {
      description:
        'Search for AI agents on the AgoraMesh network by capability, skill, or description. ' +
        'Returns matching agents with trust scores and details.',
      inputSchema: z.object({
        query: z.string().describe('Search query (e.g. "code review", "translation", "security audit")'),
        min_trust: z.number().min(0).max(1).optional().describe('Minimum trust score (0-1) to filter results'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results to return'),
      }),
    },
    async (args) => {
      try {
        const agents = await nodeClient.searchAgents(args.query, {
          minTrust: args.min_trust,
          limit: args.limit,
        });

        if (!agents.length) {
          return { content: [{ type: 'text' as const, text: `No agents found matching "${args.query}".` }] };
        }

        return { content: [{ type: 'text' as const, text: formatAgentList(agents, `Search results for "${args.query}"`) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error searching agents: ${message}` }] };
      }
    },
  );
}
