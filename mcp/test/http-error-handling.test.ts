/**
 * MCP HTTP Server Error Handling Tests
 *
 * Tests for proper JSON-RPC error responses, HTTP status codes,
 * and error handling in the MCP HTTP transport layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createServer as createHttpServer,
  type Server,
  request as httpRequest,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/index.js';
import { createMcpRequestHandler } from '../src/http-handler.js';

/** Helper: send raw HTTP request with body */
function rawPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers as Record<string, string>,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Helper: GET request */
function rawGet(
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('MCP HTTP error handling', () => {
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    const handler = createMcpRequestHandler({
      nodeUrl: 'https://api.agoramesh.ai',
      bridgeUrl: 'https://bridge.agoramesh.ai',
      publicUrl: 'https://api.agoramesh.ai',
    });

    httpServer = createHttpServer(handler);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  // =========================================================================
  // JSON parse errors
  // =========================================================================

  describe('JSON parse errors', () => {
    it('returns 400 with JSON-RPC parse error for malformed JSON', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        '{invalid json!!!',
      );

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toBe('Parse error');
    });

    it('returns 400 for truncated JSON', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        '{"jsonrpc": "2.0", "method": "ini',
      );

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32700);
    });

    it('returns 400 for non-JSON content type with invalid body', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        'this is not json at all',
        { 'Content-Type': 'text/plain' },
      );

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32700);
    });
  });

  // =========================================================================
  // CORS
  // =========================================================================

  describe('CORS headers', () => {
    it('includes CORS headers on error responses', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        '{bad json}',
      );

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  // =========================================================================
  // Health endpoint
  // =========================================================================

  describe('health endpoint', () => {
    it('returns ok status with session count', async () => {
      const res = await rawGet(`http://localhost:${port}/health`);

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(typeof body.sessions).toBe('number');
    });
  });

  // =========================================================================
  // 404 handling
  // =========================================================================

  describe('unknown paths', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await rawGet(`http://localhost:${port}/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Well-known endpoint
  // =========================================================================

  describe('.well-known/mcp.json', () => {
    it('returns discovery document', async () => {
      const res = await rawGet(
        `http://localhost:${port}/.well-known/mcp.json`,
      );

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mcpServers.agoramesh.url).toBe(
        'https://api.agoramesh.ai/mcp',
      );
    });
  });
});
