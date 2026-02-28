/**
 * AgoraMesh MCP Server — HTTP request handler factory.
 * Extracts the request handler logic from http.ts for testability.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.js';

export interface McpHttpHandlerOptions {
  nodeUrl: string;
  bridgeUrl?: string;
  publicUrl?: string;
}

/**
 * Create an HTTP request handler for the MCP server.
 * Returns a standard Node.js HTTP request listener.
 */
export function createMcpRequestHandler(options: McpHttpHandlerOptions) {
  const { nodeUrl, bridgeUrl, publicUrl = 'https://api.agoramesh.ai' } = options;

  // Track active sessions
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const wellKnown = JSON.stringify({
    mcpServers: {
      agoramesh: {
        url: `${publicUrl}/mcp`,
        capabilities: { tools: {} },
      },
    },
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost`);

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // .well-known/mcp.json — auto-discovery
    if (url.pathname === '/.well-known/mcp.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(wellKnown);
      return;
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();

      // Parse JSON body with proper error handling
      let parsed: unknown;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }));
          return;
        }
      }

      try {
        // Look up existing session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? sessions.get(sessionId) : undefined;

        if (!transport) {
          // New session: create server + transport
          const mcpServer = createServer({ nodeUrl, bridgeUrl });
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { sessions.set(id, transport!); },
          });
          transport.onclose = () => {
            if (transport!.sessionId) sessions.delete(transport!.sessionId);
          };
          await mcpServer.connect(transport);
        }

        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        console.error('MCP request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error' },
          }));
        }
      }
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  };
}
