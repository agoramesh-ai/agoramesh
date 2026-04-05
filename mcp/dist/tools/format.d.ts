/**
 * Shared formatting for agent data returned by MCP tools.
 * Handles both node API shape (x-agoramesh metadata) and semantic search results.
 */
export declare function formatAgent(agent: unknown): string;
export declare function formatAgentList(agents: unknown[], heading: string): string;
/** Shared task result formatting for hire_agent and check_task tools. */
export interface TaskResultData {
    taskId: string;
    status: string;
    output?: string;
    error?: string;
    duration?: number;
}
export declare function formatTaskResult(result: TaskResultData, heading: string): string;
