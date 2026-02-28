/**
 * AgoraMesh MCP Server — factory function.
 * Creates an MCP server with all discovery, trust, and task tools registered.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NodeClient } from './node-client.js';
import { registerSearchAgents } from './tools/search-agents.js';
import { registerGetAgent } from './tools/get-agent.js';
import { registerCheckTrust } from './tools/check-trust.js';
import { registerListAgents } from './tools/list-agents.js';
import { registerHireAgent } from './tools/hire-agent.js';
import { registerCheckTask } from './tools/check-task.js';
export function createServer(options) {
    const client = new NodeClient(options.nodeUrl, { bridgeUrl: options.bridgeUrl });
    const server = new McpServer({
        name: 'agoramesh',
        version: '0.1.0',
    });
    registerSearchAgents(server, client);
    registerGetAgent(server, client);
    registerCheckTrust(server, client);
    registerListAgents(server, client);
    registerHireAgent(server, client);
    registerCheckTask(server, client);
    return server;
}
export { NodeClient } from './node-client.js';
