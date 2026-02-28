/**
 * MCP Session Cleanup Tests (M-2, C-3 MAX_SESSIONS)
 *
 * Tests for session limits, idle timeout, and periodic cleanup.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import {
  createServer as createHttpServer,
  type Server,
  request as httpRequest,
} from 'node:http';
import { createMcpRequestHandler, MAX_SESSIONS, SESSION_TIMEOUT_MS } from '../src/http-handler.js';

/** Helper: send raw HTTP POST request */
function rawPost(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers as Record<string, string>,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('MCP Session limits (M-2)', () => {
  it('exports MAX_SESSIONS constant', () => {
    expect(MAX_SESSIONS).toBe(100);
  });

  it('exports SESSION_TIMEOUT_MS constant', () => {
    expect(SESSION_TIMEOUT_MS).toBe(30 * 60 * 1000); // 30 minutes
  });
});
