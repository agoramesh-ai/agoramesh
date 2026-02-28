/**
 * AgoraMesh MCP Server — HTTP request handler factory.
 * Extracts the request handler logic from http.ts for testability.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.js';

export interface McpHttpHandlerOptions {
  nodeUrl: string;
  bridgeUrl?: string;
  publicUrl?: string;
  /** API token for authentication. If set, /mcp requires Bearer token. From AGORAMESH_MCP_AUTH_TOKEN env. */
  authToken?: string;
  /** Allowed CORS origin. Defaults to https://www.agoramesh.ai. Use '*' for development. */
  corsOrigin?: string;
  /** Maximum body size in bytes. Defaults to 1MB (1048576). */
  maxBodySize?: number;
}

/** Default maximum body size: 1MB */
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024;

/** Maximum number of concurrent MCP sessions (C-3, M-2) */
export const MAX_SESSIONS = 100;

/** Session idle timeout in milliseconds: 30 minutes (M-2) */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Session cleanup interval in milliseconds: 5 minutes (M-2) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create an HTTP request handler for the MCP server.
 * Returns a standard Node.js HTTP request listener.
 */
export function createMcpRequestHandler(options: McpHttpHandlerOptions) {
  const { nodeUrl, bridgeUrl, publicUrl = 'https://api.agoramesh.ai', authToken, corsOrigin, maxBodySize } = options;
  const MAX_BODY_SIZE = maxBodySize ?? DEFAULT_MAX_BODY_SIZE;

  /** Constant-time token comparison */
  function isTokenValid(provided: string): boolean {
    if (!authToken) return true;
    if (provided.length !== authToken.length) {
      // Compare against self for constant time, then return false
      const buf = Buffer.from(authToken, 'utf-8');
      timingSafeEqual(buf, buf);
      return false;
    }
    return timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(authToken, 'utf-8'));
  }

  /** Resolve CORS origin: configured, or environment-based default */
  const resolvedCorsOrigin = corsOrigin
    ?? (process.env.NODE_ENV === 'development' ? '*' : 'https://www.agoramesh.ai');

  // Track active sessions with last activity timestamp (M-2)
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActivity = new Map<string, number>();

  // M-2: Periodic cleanup of idle sessions
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActivity] of sessionLastActivity.entries()) {
      if (now - lastActivity > SESSION_TIMEOUT_MS) {
        const transport = sessions.get(id);
        if (transport) {
          try { transport.close?.(); } catch { /* ignore */ }
        }
        sessions.delete(id);
        sessionLastActivity.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // Don't prevent process from exiting

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
    res.setHeader('Access-Control-Allow-Origin', resolvedCorsOrigin);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Authorization',
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
      // Authentication check: if authToken is configured, require Bearer token
      if (authToken) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token || !isTokenValid(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Unauthorized: valid Bearer token required' },
          }));
          return;
        }
      }

      // Read request body with size limit (H-6)
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let sizeLimitExceeded = false;
      for await (const chunk of req) {
        totalSize += (chunk as Buffer).length;
        if (totalSize > MAX_BODY_SIZE) {
          sizeLimitExceeded = true;
          break;
        }
        chunks.push(chunk as Buffer);
      }
      if (sizeLimitExceeded) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `Request body too large (max ${MAX_BODY_SIZE} bytes)` },
        }));
        return;
      }
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

        // Update session activity timestamp
        if (sessionId && transport) {
          sessionLastActivity.set(sessionId, Date.now());
        }

        if (!transport) {
          // M-2/C-3: Enforce MAX_SESSIONS limit
          if (sessions.size >= MAX_SESSIONS) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: 'Too many active sessions. Try again later.' },
            }));
            return;
          }

          // New session: create server + transport
          const mcpServer = createServer({ nodeUrl, bridgeUrl });
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, transport!);
              sessionLastActivity.set(id, Date.now());
            },
          });
          transport.onclose = () => {
            if (transport!.sessionId) {
              sessions.delete(transport!.sessionId);
              sessionLastActivity.delete(transport!.sessionId);
            }
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
