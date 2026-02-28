import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient, NodeClientError } from '../../src/node-client.js';
import { registerCheckTask } from '../../src/tools/check-task.js';

describe('check_task tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());

    nodeClient = new NodeClient('http://localhost:9999', {
      bridgeUrl: 'https://bridge.agoramesh.ai',
    });
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCheckTask(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns running status', async () => {
    vi.spyOn(nodeClient, 'getTask').mockResolvedValueOnce({
      taskId: 'task-123',
      status: 'running',
    });

    const result = await client.callTool({
      name: 'check_task',
      arguments: { task_id: 'task-123' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('running');
    expect(text).toContain('task-123');
  });

  it('returns completed result with output', async () => {
    vi.spyOn(nodeClient, 'getTask').mockResolvedValueOnce({
      taskId: 'task-123',
      status: 'completed',
      output: 'All tests pass!',
      duration: 12.5,
    });

    const result = await client.callTool({
      name: 'check_task',
      arguments: { task_id: 'task-123' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('completed');
    expect(text).toContain('All tests pass!');
    expect(text).toContain('12.5');
  });

  it('returns failed result with error', async () => {
    vi.spyOn(nodeClient, 'getTask').mockResolvedValueOnce({
      taskId: 'task-123',
      status: 'failed',
      error: 'Agent crashed',
    });

    const result = await client.callTool({
      name: 'check_task',
      arguments: { task_id: 'task-123' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('failed');
    expect(text).toContain('Agent crashed');
  });

  it('handles task not found', async () => {
    vi.spyOn(nodeClient, 'getTask').mockRejectedValueOnce(
      new NodeClientError(404, 'Not Found')
    );

    const result = await client.callTool({
      name: 'check_task',
      arguments: { task_id: 'task-nonexistent' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('404');
  });

  it('has readOnlyHint annotation', async () => {
    const { tools } = await client.listTools();
    const checkTool = tools.find((t) => t.name === 'check_task');
    expect(checkTool?.annotations?.readOnlyHint).toBe(true);
    expect(checkTool?.annotations?.openWorldHint).toBe(true);
    expect(checkTool?.annotations?.destructiveHint).toBeUndefined();
  });
});
