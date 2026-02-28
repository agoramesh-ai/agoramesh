import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';

// Mock fetch globally so NodeClient doesn't make real HTTP calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('AgoraMesh MCP Server (integration)', () => {
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    server = createServer({
      nodeUrl: 'https://api.agoramesh.ai',
      bridgeUrl: 'https://bridge.agoramesh.ai',
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  });

  it('lists all 6 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'check_task', 'check_trust', 'get_agent', 'hire_agent', 'list_agents', 'search_agents',
    ]);
  });

  it('read-only tools have readOnlyHint annotation', async () => {
    const { tools } = await client.listTools();
    const readOnlyTools = ['search_agents', 'get_agent', 'check_trust', 'list_agents', 'check_task'];
    for (const name of readOnlyTools) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} should have readOnlyHint`).toBe(true);
    }
  });

  it('hire_agent has destructiveHint annotation', async () => {
    const { tools } = await client.listTools();
    const hireTool = tools.find((t) => t.name === 'hire_agent');
    expect(hireTool?.annotations?.destructiveHint).toBe(true);
    expect(hireTool?.annotations?.readOnlyHint).toBeUndefined();
  });

  it('all tools have openWorldHint annotation', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, `${tool.name} should have openWorldHint`).toBe(true);
    }
  });

  it('search_agents returns formatted results', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          did: 'did:agoramesh:base:abc',
          name: 'TestAgent',
          description: 'A test agent',
          trust: { score: 0.9, tier: 'verified' },
        },
      ],
    });

    const result = await client.callTool({
      name: 'search_agents',
      arguments: { query: 'test' },
    });

    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('TestAgent');
    expect(text).toContain('did:agoramesh:base:abc');
  });

  it('get_agent returns agent card', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        did: 'did:agoramesh:base:abc',
        name: 'TestAgent',
        description: 'A test agent',
        skills: [{ id: 'test', name: 'Testing' }],
        trust: { score: 0.9, tier: 'verified' },
      }),
    });

    const result = await client.callTool({
      name: 'get_agent',
      arguments: { did: 'did:agoramesh:base:abc' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('TestAgent');
    expect(text).toContain('did:agoramesh:base:abc');
  });

  it('get_agent handles not found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    const result = await client.callTool({
      name: 'get_agent',
      arguments: { did: 'did:agoramesh:base:nonexistent' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('not found');
    expect(result.isError).toBe(true);
  });

  it('check_trust returns trust breakdown', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        score: 0.85,
        tier: 'verified',
        reputation: 0.9531,
        stake_score: 0.7071,
        endorsement_score: 0.45,
        stake_amount: 5000_000_000,
        successful_transactions: 40,
        failed_transactions: 2,
        endorsement_count: 2,
      }),
    });

    const result = await client.callTool({
      name: 'check_trust',
      arguments: { did: 'did:agoramesh:base:abc' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('0.85');
    expect(text).toContain('verified');
  });

  it('list_agents returns all agents', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { did: 'did:agoramesh:base:a', name: 'Agent1', trust: { score: 0.8 } },
        { did: 'did:agoramesh:base:b', name: 'Agent2', trust: { score: 0.7 } },
      ],
    });

    const result = await client.callTool({
      name: 'list_agents',
      arguments: {},
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('Agent1');
    expect(text).toContain('Agent2');
  });

  it('hire_agent submits task to bridge', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        taskId: 'task-int-001',
        status: 'completed',
        output: 'Task done!',
        duration: 3.0,
      }),
    });

    const result = await client.callTool({
      name: 'hire_agent',
      arguments: { agent_did: 'did:agoramesh:base:abc', prompt: 'Do something' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('completed');
    expect(text).toContain('Task done!');
  });

  it('check_task returns task status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        taskId: 'task-int-002',
        status: 'running',
      }),
    });

    const result = await client.callTool({
      name: 'check_task',
      arguments: { task_id: 'task-int-002' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toContain('running');
    expect(text).toContain('task-int-002');
  });
});
