import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server, get as httpGet } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/index.js';

/** Helper: GET with native http module */
function httpGetJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('MCP Streamable HTTP server', () => {
  let httpServer: Server;
  let port: number;

  // Track active transports by session ID
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  beforeAll(async () => {
    httpServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      // .well-known/mcp.json
      if (url.pathname === '/.well-known/mcp.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          mcpServers: {
            agoramesh: {
              url: 'https://api.agoramesh.ai/mcp',
              capabilities: { tools: {} },
            },
          },
        }));
        return;
      }

      // MCP endpoint
      if (url.pathname === '/mcp') {
        // Parse body
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();
        const parsed = body ? JSON.parse(body) : undefined;

        // Check for existing session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? sessions.get(sessionId) : undefined;

        if (!transport) {
          // New session: create server + transport
          const mcpServer = createServer({
            nodeUrl: 'https://api.agoramesh.ai',
            bridgeUrl: 'https://bridge.agoramesh.ai',
          });
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
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(async () => {
    sessions.clear();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('handles MCP initialize + tools/list over HTTP', async () => {
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`)
    );
    const client = new Client({ name: 'http-test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'check_task', 'check_trust', 'get_agent', 'hire_agent', 'list_agents', 'search_agents',
    ]);

    await client.close();
  });

  it('serves .well-known/mcp.json', async () => {
    const { status, body } = await httpGetJson(`http://localhost:${port}/.well-known/mcp.json`);

    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.mcpServers.agoramesh.url).toBe('https://api.agoramesh.ai/mcp');
    expect(json.mcpServers.agoramesh.capabilities.tools).toBeDefined();
  });

  it('returns 404 for unknown paths', async () => {
    const { status } = await httpGetJson(`http://localhost:${port}/unknown`);
    expect(status).toBe(404);
  });
});
