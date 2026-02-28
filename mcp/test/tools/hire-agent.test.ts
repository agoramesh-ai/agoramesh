import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient } from '../../src/node-client.js';
import { registerHireAgent } from '../../src/tools/hire-agent.js';

describe('hire_agent tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());

    nodeClient = new NodeClient('http://localhost:9999', {
      bridgeUrl: 'https://bridge.agoramesh.ai',
    });
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerHireAgent(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits task and returns completed result', async () => {
    vi.spyOn(nodeClient, 'submitTask').mockResolvedValueOnce({
      taskId: 'task-abc',
      status: 'completed',
      output: 'Bug fixed successfully!',
      duration: 5.2,
    });

    const result = await client.callTool({
      name: 'hire_agent',
      arguments: { agent_did: 'did:agoramesh:base:abc', prompt: 'Fix the bug' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('completed');
    expect(text).toContain('Bug fixed successfully!');
    expect(text).toContain('task-abc');
    expect(text).toContain('5.2');
  });

  it('returns error when task fails', async () => {
    vi.spyOn(nodeClient, 'submitTask').mockResolvedValueOnce({
      taskId: 'task-fail',
      status: 'failed',
      error: 'Agent timed out',
    });

    const result = await client.callTool({
      name: 'hire_agent',
      arguments: { agent_did: 'did:agoramesh:base:abc', prompt: 'Do something' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('failed');
    expect(text).toContain('Agent timed out');
  });

  it('handles network error gracefully', async () => {
    vi.spyOn(nodeClient, 'submitTask').mockRejectedValueOnce(
      new Error('Connection refused')
    );

    const result = await client.callTool({
      name: 'hire_agent',
      arguments: { agent_did: 'did:agoramesh:base:abc', prompt: 'test' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Connection refused');
  });

  it('passes task type and timeout options', async () => {
    const spy = vi.spyOn(nodeClient, 'submitTask').mockResolvedValueOnce({
      taskId: 'task-opt',
      status: 'completed',
      output: 'Done',
    });

    await client.callTool({
      name: 'hire_agent',
      arguments: {
        agent_did: 'did:agoramesh:base:abc',
        prompt: 'Review code',
        task_type: 'code-review',
        timeout: 30,
      },
    });

    expect(spy).toHaveBeenCalledWith({
      agentDid: 'did:agoramesh:base:abc',
      prompt: 'Review code',
      type: 'code-review',
      timeout: 30,
    });
  });

  it('has destructiveHint annotation', async () => {
    const { tools } = await client.listTools();
    const hireTool = tools.find((t) => t.name === 'hire_agent');
    expect(hireTool?.annotations?.destructiveHint).toBe(true);
    expect(hireTool?.annotations?.openWorldHint).toBe(true);
    expect(hireTool?.annotations?.readOnlyHint).toBeUndefined();
  });
});
