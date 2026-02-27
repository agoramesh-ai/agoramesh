/**
 * AgoraMesh MCP Server — factory function.
 * Creates an MCP server with all discovery and trust tools registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NodeClient } from './node-client.js';
import { registerSearchAgents } from './tools/search-agents.js';
import { registerGetAgent } from './tools/get-agent.js';
import { registerCheckTrust } from './tools/check-trust.js';
import { registerListAgents } from './tools/list-agents.js';

export function createServer(nodeUrl: string): McpServer {
  const client = new NodeClient(nodeUrl);

  const server = new McpServer({
    name: 'agoramesh',
    version: '0.1.0',
  });

  registerSearchAgents(server, client);
  registerGetAgent(server, client);
  registerCheckTrust(server, client);
  registerListAgents(server, client);

  return server;
}

export { NodeClient } from './node-client.js';
