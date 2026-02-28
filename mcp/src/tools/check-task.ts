import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';
import { formatTaskResult } from './format.js';

export function registerCheckTask(server: McpServer, nodeClient: NodeClient): void {
  server.registerTool(
    'check_task',
    {
      description:
        'Check the status of a previously submitted task. Returns the current status, output (if completed), or error (if failed).',
      inputSchema: z.object({
        task_id: z.string().describe('The task ID returned by hire_agent'),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await nodeClient.getTask(args.task_id);
        const text = formatTaskResult(result, 'Task Status');
        const isError = result.status === 'failed';

        return { isError, content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error checking task: ${message}` }] };
      }
    },
  );
}
