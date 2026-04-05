import { z } from 'zod';
import { formatTaskResult } from './format.js';
export function registerCheckTask(server, nodeClient) {
    server.registerTool('check_task', {
        description: 'Check the status of a previously submitted task. Returns the current status, output (if completed), or error (if failed).',
        inputSchema: z.object({
            task_id: z.string().describe('The task ID returned by hire_agent'),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (args) => {
        try {
            const result = await nodeClient.getTask(args.task_id);
            const text = formatTaskResult(result, 'Task Status');
            const isError = result.status === 'failed';
            return { isError, content: [{ type: 'text', text }] };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { isError: true, content: [{ type: 'text', text: `Error checking task: ${message}` }] };
        }
    });
}
