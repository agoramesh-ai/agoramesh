import { z } from 'zod';
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
            if (result.status === 'failed') {
                const lines = [
                    `# Task Status`,
                    '',
                    `- **Task ID**: ${result.taskId}`,
                    `- **Status**: ${result.status}`,
                    `- **Error**: ${result.error ?? 'Unknown error'}`,
                ];
                return { isError: true, content: [{ type: 'text', text: lines.join('\n') }] };
            }
            const lines = [
                `# Task Status`,
                '',
                `- **Task ID**: ${result.taskId}`,
                `- **Status**: ${result.status}`,
            ];
            if (result.duration !== undefined)
                lines.push(`- **Duration**: ${result.duration}s`);
            if (result.output) {
                lines.push('', '## Output', '', result.output);
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { isError: true, content: [{ type: 'text', text: `Error checking task: ${message}` }] };
        }
    });
}
