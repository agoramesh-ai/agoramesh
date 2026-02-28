/**
 * Shared formatting for agent data returned by MCP tools.
 * Handles both node API shape (x-agoramesh metadata) and semantic search results.
 */
export declare function formatAgent(agent: unknown): string;
export declare function formatAgentList(agents: unknown[], heading: string): string;
