#!/usr/bin/env node
/**
 * AgoraMesh MCP Server — Streamable HTTP entrypoint.
 * Usage: AGORAMESH_NODE_URL=https://api.agoramesh.ai node dist/http.js
 */

import { createServer as createHttpServer } from 'node:http';
import { createMcpRequestHandler } from './http-handler.js';

const port = parseInt(process.env.AGORAMESH_MCP_PORT || '3401');
const nodeUrl = process.env.AGORAMESH_NODE_URL || 'http://localhost:8080';
const bridgeUrl = process.env.AGORAMESH_BRIDGE_URL || undefined;
const publicUrl = process.env.AGORAMESH_PUBLIC_URL || 'https://api.agoramesh.ai';

const handler = createMcpRequestHandler({ nodeUrl, bridgeUrl, publicUrl });
const httpServer = createHttpServer(handler);

httpServer.listen(port, () => {
  console.error(`AgoraMesh MCP HTTP server running on port ${port} (node: ${nodeUrl}${bridgeUrl ? `, bridge: ${bridgeUrl}` : ''})`);
});

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 30_000;
let shutdownInProgress = false;

function shutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.error(`[MCP] ${signal} received, graceful shutdown initiated...`);

  // Force exit after timeout
  const forceTimer = setTimeout(() => {
    console.error('[MCP] Force exit after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS + 5_000);
  forceTimer.unref();

  // Stop accepting new connections and close existing ones
  httpServer.close(() => {
    console.error('[MCP] HTTP server closed');
    process.exit(0);
  });

  // Close keep-alive connections that would delay shutdown
  httpServer.closeAllConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
