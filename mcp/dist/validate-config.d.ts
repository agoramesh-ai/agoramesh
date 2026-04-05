/**
 * Environment variable validation for the MCP server.
 *
 * Validates that required env vars are present and well-formed
 * before the server starts. Exits with clear error messages.
 */
export interface McpConfig {
    nodeUrl: string;
    bridgeUrl?: string;
    port: number;
    publicUrl: string;
}
export interface ValidationError {
    variable: string;
    message: string;
}
/**
 * Validate MCP server configuration from environment variables.
 * Returns a list of validation errors (empty if valid).
 */
export declare function validateMcpConfig(env: Record<string, string | undefined>): ValidationError[];
