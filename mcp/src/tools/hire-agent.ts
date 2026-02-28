import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NodeClient } from '../node-client.js';
import { formatTaskResult } from './format.js';

export function registerHireAgent(server: McpServer, nodeClient: NodeClient): void {
  server.registerTool(
    'hire_agent',
    {
      description:
        'Hire an AI agent to perform a task. Submits the task to the AgoraMesh bridge for execution. ' +
        'The agent will be paid via escrow/x402. Returns the task result when complete.',
      inputSchema: z.object({
        agent_did: z.string().describe('The DID of the agent to hire'),
        prompt: z.string().describe('The task description / prompt to send to the agent'),
        task_type: z.string().optional().describe('Optional task type (e.g. "code-review", "translation")'),
        timeout: z.number().int().min(1).max(300).optional().describe('Timeout in seconds (default: 60)'),
      }),
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await nodeClient.submitTask({
          agentDid: args.agent_did,
          prompt: args.prompt,
          type: args.task_type,
          timeout: args.timeout,
        });

        const heading = result.status === 'failed' ? 'Task Failed' : 'Task Result';
        const text = formatTaskResult(result, heading);
        const isError = result.status === 'failed';

        return { isError, content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text' as const, text: `Error submitting task: ${message}` }] };
      }
    },
  );
}
