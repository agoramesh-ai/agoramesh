import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient } from '../../src/node-client.js';
import { registerSearchAgents } from '../../src/tools/search-agents.js';

describe('search_agents tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeEach(async () => {
    // Stub global fetch so NodeClient constructor doesn't need a real server
    vi.stubGlobal('fetch', vi.fn());

    nodeClient = new NodeClient('http://localhost:9999');
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerSearchAgents(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns formatted agent list when agents found', async () => {
    vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([
      {
        did: 'did:agoramesh:base:abc123',
        name: 'CodeReviewer',
        description: 'Reviews code for quality and security',
        capabilities: ['Code Review', 'Security Audit'],
        pricing: { model: 'per_request', amount: '0.01', currency: 'USDC' },
        trust: { score: 0.85, tier: 'verified' },
      },
      {
        did: 'did:agoramesh:base:def456',
        name: 'Translator',
        description: 'Translates text between languages',
        capabilities: ['Translation'],
        pricing: { model: 'per_token', amount: '0.001', currency: 'USDC' },
        trust: { score: 0.72, tier: 'basic' },
      },
    ]);

    const result = await client.callTool({
      name: 'search_agents',
      arguments: { query: 'code review' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    // Should contain both agent names
    expect(text).toContain('CodeReviewer');
    expect(text).toContain('Translator');

    // Should contain DIDs
    expect(text).toContain('did:agoramesh:base:abc123');
    expect(text).toContain('did:agoramesh:base:def456');

    // Should contain trust scores
    expect(text).toContain('0.85');
    expect(text).toContain('0.72');

    // Should contain descriptions
    expect(text).toContain('Reviews code for quality and security');
    expect(text).toContain('Translates text between languages');
  });

  it('handles empty results gracefully', async () => {
    vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: 'search_agents',
      arguments: { query: 'nonexistent agent type' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('No agents found');
  });

  it('passes query, min_trust, and limit to node client', async () => {
    const spy = vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([]);

    await client.callTool({
      name: 'search_agents',
      arguments: { query: 'security', min_trust: 0.8, limit: 3 },
    });

    expect(spy).toHaveBeenCalledWith('security', { minTrust: 0.8, limit: 3 });
  });

  it('handles node client errors gracefully', async () => {
    vi.spyOn(nodeClient, 'searchAgents').mockRejectedValueOnce(
      new Error('Connection refused')
    );

    const result = await client.callTool({
      name: 'search_agents',
      arguments: { query: 'test' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Connection refused');
  });
});
