/**
 * AgoraMesh MCP Server — factory function.
 * Creates an MCP server with all discovery, trust, and task tools registered.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export interface CreateServerOptions {
    nodeUrl: string;
    bridgeUrl?: string;
}
export declare function createServer(options: CreateServerOptions): McpServer;
export { NodeClient } from './node-client.js';
