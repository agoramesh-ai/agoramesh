import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';

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

        if (result.status === 'failed') {
          const lines = [
            `# Task Status`,
            '',
            `- **Task ID**: ${result.taskId}`,
            `- **Status**: ${result.status}`,
            `- **Error**: ${result.error ?? 'Unknown error'}`,
          ];
          return { isError: true, content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const lines = [
          `# Task Status`,
          '',
          `- **Task ID**: ${result.taskId}`,
          `- **Status**: ${result.status}`,
        ];
        if (result.duration !== undefined) lines.push(`- **Duration**: ${result.duration}s`);
        if (result.output) {
          lines.push('', '## Output', '', result.output);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error checking task: ${message}` }] };
      }
    },
  );
}
