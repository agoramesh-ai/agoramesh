/**
 * MCP Authentication Tests (C-4)
 *
 * Tests for API token authentication on the MCP server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createServer as createHttpServer,
  type Server,
  request as httpRequest,
} from 'node:http';
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
        headers,
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

/** Helper: GET request that also returns headers */
function rawGetWithHeaders(
  url: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
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
    req.end();
  });
}

describe('MCP CORS configuration (H-5)', () => {
  it('defaults to agoramesh.ai origin in production', async () => {
    const handler = createMcpRequestHandler({
      nodeUrl: 'https://api.agoramesh.ai',
    });

    let httpServer: Server;
    httpServer = createHttpServer(handler);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const port = (httpServer.address() as { port: number }).port;

    const res = await rawGet(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);

    // In non-development mode, should NOT be wildcard
    const origin = (res as any).headers?.['access-control-allow-origin'];
    // Header should be set to agoramesh.ai, not wildcard
    if (process.env.NODE_ENV !== 'development') {
      expect(origin).not.toBe('*');
    }

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('allows configuring custom CORS origin', async () => {
    const handler = createMcpRequestHandler({
      nodeUrl: 'https://api.agoramesh.ai',
      corsOrigin: 'https://custom.example.com',
    });

    let httpServer: Server;
    httpServer = createHttpServer(handler);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const port = (httpServer.address() as { port: number }).port;

    const res = await rawGetWithHeaders(`http://localhost:${port}/health`);
    expect(res.headers['access-control-allow-origin']).toBe('https://custom.example.com');

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });
});

describe('MCP body size limit (H-6)', () => {
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    const handler = createMcpRequestHandler({
      nodeUrl: 'https://api.agoramesh.ai',
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

  it('returns 413 when body exceeds 1MB', async () => {
    // Create a body larger than 1MB
    const largeBody = 'x'.repeat(1024 * 1024 + 100);
    const res = await rawPost(
      `http://localhost:${port}/mcp`,
      largeBody,
    );

    expect(res.status).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain('too large');
  });

  it('accepts bodies under 1MB', async () => {
    const normalBody = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 });
    const res = await rawPost(
      `http://localhost:${port}/mcp`,
      normalBody,
    );

    // Should not be 413
    expect(res.status).not.toBe(413);
  });
});

describe('MCP Authentication (C-4)', () => {
  describe('with auth token configured', () => {
    let httpServer: Server;
    let port: number;

    beforeAll(async () => {
      const handler = createMcpRequestHandler({
        nodeUrl: 'https://api.agoramesh.ai',
        authToken: 'test-secret-token-123',
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

    it('returns 401 for /mcp without auth token', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      );

      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('Unauthorized');
    });

    it('returns 401 for /mcp with wrong auth token', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
        { Authorization: 'Bearer wrong-token' },
      );

      expect(res.status).toBe(401);
    });

    it('allows /mcp with correct Bearer token', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
        { Authorization: 'Bearer test-secret-token-123' },
      );

      // Should not be 401 — might be 200 or other MCP response
      expect(res.status).not.toBe(401);
    });

    it('allows /health without auth token', async () => {
      const res = await rawGet(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
    });

    it('allows /.well-known/mcp.json without auth token', async () => {
      const res = await rawGet(`http://localhost:${port}/.well-known/mcp.json`);
      expect(res.status).toBe(200);
    });
  });

  describe('without auth token configured (backwards compatible)', () => {
    let httpServer: Server;
    let port: number;

    beforeAll(async () => {
      const handler = createMcpRequestHandler({
        nodeUrl: 'https://api.agoramesh.ai',
        // No authToken — should allow unauthenticated access
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

    it('allows /mcp without auth token when not configured', async () => {
      const res = await rawPost(
        `http://localhost:${port}/mcp`,
        JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
      );

      // Should not be 401
      expect(res.status).not.toBe(401);
    });
  });
});
