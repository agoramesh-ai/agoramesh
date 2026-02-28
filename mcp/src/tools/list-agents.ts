import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';
import { formatAgentList } from './format.js';

export function registerListAgents(server: McpServer, nodeClient: NodeClient): void {
  server.registerTool(
    'list_agents',
    {
      description:
        'List all AI agents currently registered on the AgoraMesh network. ' +
        'Returns agents with their trust scores and capabilities.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of agents to return'),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const agents = await nodeClient.searchAgents('*', {
          limit: args.limit,
        });

        if (!agents.length) {
          return { content: [{ type: 'text' as const, text: 'No agents found on the network.' }] };
        }

        return { content: [{ type: 'text' as const, text: formatAgentList(agents, 'Agents on the network') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error listing agents: ${message}` }] };
      }
    },
  );
}
