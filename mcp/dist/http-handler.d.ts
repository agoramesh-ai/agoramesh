/**
 * AgoraMesh MCP Server — HTTP request handler factory.
 * Extracts the request handler logic from http.ts for testability.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
export interface McpHttpHandlerOptions {
    nodeUrl: string;
    bridgeUrl?: string;
    publicUrl?: string;
    /** API token for authentication. If set, /mcp requires Bearer token. From AGORAMESH_MCP_AUTH_TOKEN env. */
    authToken?: string;
    /** Allowed CORS origin. Defaults to https://www.agoramesh.ai. Use '*' for development. */
    corsOrigin?: string;
    /** Maximum body size in bytes. Defaults to 1MB (1048576). */
    maxBodySize?: number;
}
/** Maximum number of concurrent MCP sessions (C-3, M-2) */
export declare const MAX_SESSIONS = 100;
/** Session idle timeout in milliseconds: 30 minutes (M-2) */
export declare const SESSION_TIMEOUT_MS: number;
/**
 * Create an HTTP request handler for the MCP server.
 * Returns a standard Node.js HTTP request listener.
 */
export declare function createMcpRequestHandler(options: McpHttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
