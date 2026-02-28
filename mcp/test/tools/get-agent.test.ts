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
    // Mock data matches actual node API response shape
    vi.spyOn(nodeClient, 'getAgent').mockResolvedValueOnce({
      name: 'CodeReviewer',
      description: 'Reviews code for quality and security',
      url: 'https://agent.example.com',
      capabilities: [
        { id: 'code-review', name: 'Code Review', description: 'Review code for bugs' },
        { id: 'security-audit', name: 'Security Audit', description: 'Find security issues' },
      ],
      'x-agoramesh': {
        did: 'did:agoramesh:base:abc123',
        trust_score: 0.85,
        stake: 5000_000_000,
        pricing: { base_price: 500_000, currency: 'USDC', model: 'per_request' },
        payment_methods: ['x402', 'escrow'],
      },
    });

    const result = await client.callTool({ name: 'get_agent', arguments: { did: 'did:agoramesh:base:abc123' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('# CodeReviewer');
    expect(text).toContain('did:agoramesh:base:abc123');
    expect(text).toContain('Reviews code for quality and security');
    expect(text).toContain('https://agent.example.com');
    expect(text).toContain('0.85');
    expect(text).toContain('Code Review');
    expect(text).toContain('Security Audit');
    expect(text).toContain('5000.00 USDC');
    expect(text).toContain('$0.50 USDC/request');
    expect(text).toContain('x402, escrow');
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
