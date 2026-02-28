#!/usr/bin/env node
/**
 * AgoraMesh MCP Server — Streamable HTTP entrypoint.
 * Usage: AGORAMESH_NODE_URL=https://api.agoramesh.ai node dist/http.js
 */
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.js';
const port = parseInt(process.env.AGORAMESH_MCP_PORT || '3401');
const nodeUrl = process.env.AGORAMESH_NODE_URL || 'http://localhost:8080';
const bridgeUrl = process.env.AGORAMESH_BRIDGE_URL || undefined;
const publicUrl = process.env.AGORAMESH_PUBLIC_URL || 'https://api.agoramesh.ai';
// Track active sessions
const sessions = new Map();
const wellKnown = JSON.stringify({
    mcpServers: {
        agoramesh: {
            url: `${publicUrl}/mcp`,
            capabilities: { tools: {} },
        },
    },
});
const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
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
        try {
            // Parse body
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            const body = Buffer.concat(chunks).toString();
            const parsed = body ? JSON.parse(body) : undefined;
            // Look up existing session
            const sessionId = req.headers['mcp-session-id'];
            let transport = sessionId ? sessions.get(sessionId) : undefined;
            if (!transport) {
                // New session: create server + transport
                const mcpServer = createServer({ nodeUrl, bridgeUrl });
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => { sessions.set(id, transport); },
                });
                transport.onclose = () => {
                    if (transport.sessionId)
                        sessions.delete(transport.sessionId);
                };
                await mcpServer.connect(transport);
            }
            await transport.handleRequest(req, res, parsed);
        }
        catch (err) {
            console.error('MCP request error:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
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
});
httpServer.listen(port, () => {
    console.error(`AgoraMesh MCP HTTP server running on port ${port} (node: ${nodeUrl}${bridgeUrl ? `, bridge: ${bridgeUrl}` : ''})`);
});
