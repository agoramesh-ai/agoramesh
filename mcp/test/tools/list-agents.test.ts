import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient } from '../../src/node-client.js';
import { registerListAgents } from '../../src/tools/list-agents.js';

describe('list_agents tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());

    nodeClient = new NodeClient('http://localhost:9999');
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerListAgents(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all agents when called', async () => {
    vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([
      {
        did: 'did:agoramesh:base:abc123',
        name: 'CodeReviewer',
        description: 'Reviews code for quality and security',
        capabilities: ['Code Review'],
        trust: { score: 0.85, tier: 'verified' },
      },
      {
        did: 'did:agoramesh:base:def456',
        name: 'Translator',
        description: 'Translates text between languages',
        capabilities: ['Translation'],
        trust: { score: 0.72, tier: 'basic' },
      },
    ]);

    const result = await client.callTool({
      name: 'list_agents',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(text).toContain('CodeReviewer');
    expect(text).toContain('Translator');
    expect(text).toContain('did:agoramesh:base:abc123');
    expect(text).toContain('did:agoramesh:base:def456');
  });

  it('supports limit parameter', async () => {
    const spy = vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([]);

    await client.callTool({
      name: 'list_agents',
      arguments: { limit: 5 },
    });

    expect(spy).toHaveBeenCalledWith(undefined, { limit: 5 });
  });

  it('handles empty network', async () => {
    vi.spyOn(nodeClient, 'searchAgents').mockResolvedValueOnce([]);

    const result = await client.callTool({
      name: 'list_agents',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('No agents found');
  });
});
