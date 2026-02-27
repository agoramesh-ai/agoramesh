import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient } from '../../src/node-client.js';
import { registerGetAgent } from '../../src/tools/get-agent.js';

describe('get_agent tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeAll(async () => {
    nodeClient = new NodeClient('http://localhost:0');
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerGetAgent(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns full formatted agent card for valid DID', async () => {
    vi.spyOn(nodeClient, 'getAgent').mockResolvedValueOnce({
      did: 'did:agoramesh:base:abc123',
      name: 'CodeReviewer',
      description: 'Reviews code for quality and security',
      version: '1.0.0',
      url: 'https://agent.example.com',
      trust: { score: 0.85, tier: 'verified' },
      skills: [
        {
          name: 'Code Review',
          tags: ['code', 'review', 'quality'],
          pricing: { model: 'per_request', amount: '0.01', currency: 'USDC' },
        },
        {
          name: 'Security Audit',
          tags: ['security', 'audit'],
          pricing: { model: 'per_request', amount: '0.05', currency: 'USDC' },
        },
      ],
      capabilities: {
        streaming: true,
        x402Payments: true,
      },
    });

    const result = await client.callTool({ name: 'get_agent', arguments: { did: 'did:agoramesh:base:abc123' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('# CodeReviewer');
    expect(text).toContain('did:agoramesh:base:abc123');
    expect(text).toContain('Reviews code for quality and security');
    expect(text).toContain('1.0.0');
    expect(text).toContain('https://agent.example.com');
    expect(text).toContain('0.85');
    expect(text).toContain('verified');
    expect(text).toContain('Code Review');
    expect(text).toContain('Security Audit');
    expect(text).toContain('code, review, quality');
    expect(text).toContain('$0.01/request');
    expect(text).toContain('$0.05/request');
    expect(text).toContain('Streaming');
    expect(text).toContain('x402 Payments');
  });

  it('returns error message when agent not found', async () => {
    vi.spyOn(nodeClient, 'getAgent').mockResolvedValueOnce(null);

    const result = await client.callTool({ name: 'get_agent', arguments: { did: 'did:agoramesh:base:nonexistent' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Agent not found');
    expect(text).toContain('did:agoramesh:base:nonexistent');
  });

  it('handles node client errors gracefully', async () => {
    vi.spyOn(nodeClient, 'getAgent').mockRejectedValueOnce(new Error('Connection refused'));

    const result = await client.callTool({ name: 'get_agent', arguments: { did: 'did:agoramesh:base:abc123' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Error');
    expect(text).toContain('Connection refused');
  });

  it('handles agent with minimal fields', async () => {
    vi.spyOn(nodeClient, 'getAgent').mockResolvedValueOnce({
      did: 'did:agoramesh:base:minimal',
      name: 'MinimalAgent',
    });

    const result = await client.callTool({ name: 'get_agent', arguments: { did: 'did:agoramesh:base:minimal' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('# MinimalAgent');
    expect(text).toContain('did:agoramesh:base:minimal');
  });
});
