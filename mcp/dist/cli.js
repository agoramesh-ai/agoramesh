#!/usr/bin/env node
/**
 * AgoraMesh MCP Server — stdio entrypoint.
 * Usage: AGORAMESH_NODE_URL=https://api.agoramesh.ai npx tsx mcp/src/cli.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';
import { validateMcpConfig } from './validate-config.js';
// Validate configuration before starting
const configErrors = validateMcpConfig(process.env);
if (configErrors.length > 0) {
    console.error('Configuration errors:');
    for (const err of configErrors) {
        console.error(`  ${err.variable}: ${err.message}`);
    }
    process.exit(1);
}
const nodeUrl = process.env.AGORAMESH_NODE_URL || 'http://localhost:8080';
const bridgeUrl = process.env.AGORAMESH_BRIDGE_URL || undefined;
const server = createServer({ nodeUrl, bridgeUrl });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`AgoraMesh MCP server running (node: ${nodeUrl}${bridgeUrl ? `, bridge: ${bridgeUrl}` : ''})`);
