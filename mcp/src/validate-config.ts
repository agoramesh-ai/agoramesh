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
export function validateMcpConfig(env: Record<string, string | undefined>): ValidationError[] {
  const errors: ValidationError[] = [];

  // AGORAMESH_NODE_URL: optional (has default), but if set must be a valid URL
  const nodeUrl = env.AGORAMESH_NODE_URL;
  if (nodeUrl && !isValidUrl(nodeUrl)) {
    errors.push({
      variable: 'AGORAMESH_NODE_URL',
      message: `Invalid URL: "${nodeUrl}". Must be a valid HTTP(S) URL.`,
    });
  }

  // AGORAMESH_BRIDGE_URL: optional, but if set must be a valid URL
  const bridgeUrl = env.AGORAMESH_BRIDGE_URL;
  if (bridgeUrl && !isValidUrl(bridgeUrl)) {
    errors.push({
      variable: 'AGORAMESH_BRIDGE_URL',
      message: `Invalid URL: "${bridgeUrl}". Must be a valid HTTP(S) URL.`,
    });
  }

  // AGORAMESH_MCP_PORT: optional, but if set must be a valid port number
  const portStr = env.AGORAMESH_MCP_PORT;
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push({
        variable: 'AGORAMESH_MCP_PORT',
        message: `Invalid port: "${portStr}". Must be a number between 1 and 65535.`,
      });
    }
  }

  // AGORAMESH_PUBLIC_URL: optional, but if set must be a valid URL
  const publicUrl = env.AGORAMESH_PUBLIC_URL;
  if (publicUrl && !isValidUrl(publicUrl)) {
    errors.push({
      variable: 'AGORAMESH_PUBLIC_URL',
      message: `Invalid URL: "${publicUrl}". Must be a valid HTTP(S) URL.`,
    });
  }

  return errors;
}

/** Check whether a string is a valid HTTP or HTTPS URL */
function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
