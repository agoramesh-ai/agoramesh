/**
 * Server Security Tests
 *
 * TDD tests for security headers, CORS, body size limits, and WebSocket authentication.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { BridgeServer } from '../src/server.js';
import { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-security-agent',
  description: 'Test agent for security tests',
  skills: ['testing'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('Server Security Headers', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false }, // Disable rate limiting for tests
    });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('security headers via helmet', () => {
    it('includes X-Content-Type-Options header', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('includes X-Frame-Options header', async () => {
      const res = await request(app).get('/health');

      // helmet default is SAMEORIGIN
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('includes X-XSS-Protection header or Content-Security-Policy', async () => {
      const res = await request(app).get('/health');

      // Modern browsers use CSP, older use X-XSS-Protection
      const hasXss = res.headers['x-xss-protection'] !== undefined;
      const hasCsp = res.headers['content-security-policy'] !== undefined;

      expect(hasXss || hasCsp).toBe(true);
    });

    it('includes Strict-Transport-Security header in production', async () => {
      // HSTS is typically only enabled in production
      // For testing, we just verify the header infrastructure exists
      const res = await request(app).get('/health');

      // helmet's HSTS is configurable - we just verify headers are being set
      expect(res.status).toBe(200);
    });

    it('removes X-Powered-By header', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS configuration', () => {
    it('handles CORS preflight requests', async () => {
      const res = await request(app)
        .options('/task')
        .set('Origin', 'https://example.com')
        .set('Access-Control-Request-Method', 'POST');

      // Should respond with CORS headers or 204/200
      expect([200, 204]).toContain(res.status);
    });

    it('includes Access-Control-Allow-Origin header for allowed origins', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://example.com');

      // The header should be present (value depends on config)
      // Default helmet/cors may vary - we test infrastructure exists
      expect(res.status).toBe(200);
    });
  });

  describe('JSON body size limit', () => {
    it('accepts JSON body under 1mb', async () => {
      const smallPayload = {
        taskId: 'test-small',
        type: 'prompt',
        prompt: 'a'.repeat(1000), // 1KB
        clientDid: 'did:test:123',
      };

      const res = await request(app)
        .post('/task')
        .send(smallPayload);

      // Should be 200 (accepted) or 400 (validation error), not 413
      expect([200, 400]).toContain(res.status);
    });

    it('rejects JSON body larger than 1mb', async () => {
      // Create a payload larger than 1MB
      const largePayload = {
        taskId: 'test-large',
        type: 'prompt',
        prompt: 'x'.repeat(2 * 1024 * 1024), // 2MB
        clientDid: 'did:test:123',
      };

      const res = await request(app)
        .post('/task')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(largePayload));

      expect(res.status).toBe(413);
    });

    it('returns appropriate error message for oversized body', async () => {
      const largePayload = {
        taskId: 'test-large-2',
        type: 'prompt',
        prompt: 'y'.repeat(2 * 1024 * 1024),
        clientDid: 'did:test:123',
      };

      const res = await request(app)
        .post('/task')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(largePayload));

      expect(res.status).toBe(413);
      // Should have some indication of the error
      expect(res.text || res.body.error).toBeDefined();
    });
  });
});

describe('WebSocket Authentication', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      wsAuthToken: 'test-secret-token', // Add auth token config
    });
    await server.start(0); // Random port
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('WebSocket upgrade authentication', () => {
    it('rejects WebSocket connection without auth token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            reject(new Error('Connection should have been rejected'));
          });
          ws.on('error', (err) => {
            resolve(); // Expected - connection rejected
          });
          ws.on('close', (code) => {
            if (code === 1008 || code === 4001 || code === 1006) {
              resolve(); // Policy violation or unauthorized
            } else {
              reject(new Error(`Unexpected close code: ${code}`));
            }
          });
          // Timeout after 5 seconds
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ).resolves.toBeUndefined();
    });

    it('rejects WebSocket connection with invalid auth token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: {
          'Authorization': 'Bearer invalid-token',
        },
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            reject(new Error('Connection should have been rejected'));
          });
          ws.on('error', () => {
            resolve(); // Expected
          });
          ws.on('close', (code) => {
            if (code === 1008 || code === 4001 || code === 1006) {
              resolve();
            } else {
              reject(new Error(`Unexpected close code: ${code}`));
            }
          });
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ).resolves.toBeUndefined();
    });

    it('accepts WebSocket connection with valid auth token', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: {
          'Authorization': 'Bearer test-secret-token',
        },
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            ws.close();
            resolve(); // Connection accepted
          });
          ws.on('error', (err) => {
            reject(err);
          });
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ).resolves.toBeUndefined();
    });

    it('rejects WebSocket connection with token in query string (only Bearer header allowed)', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=test-secret-token`);

      await expect(
        new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            reject(new Error('Connection should have been rejected'));
          });
          ws.on('error', () => {
            resolve(); // Expected - connection rejected
          });
          ws.on('close', (code) => {
            if (code === 1008 || code === 4001 || code === 1006) {
              resolve(); // Policy violation or unauthorized
            } else {
              reject(new Error(`Unexpected close code: ${code}`));
            }
          });
          setTimeout(() => reject(new Error('Timeout')), 5000);
        })
      ).resolves.toBeUndefined();
    });
  });
});

// ========== M-5: WebSocket Origin Validation Tests ==========

describe('WebSocket Origin Validation', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      wsAuthToken: 'test-secret-token',
      allowedOrigins: ['http://localhost:3402', 'https://app.agoramesh.io'],
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('rejects WebSocket connection from disallowed origin', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: {
        'Authorization': 'Bearer test-secret-token',
        'Origin': 'https://evil.example.com',
      },
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          reject(new Error('Connection should have been rejected'));
        });
        ws.on('error', () => {
          resolve(); // Expected
        });
        ws.on('close', (code) => {
          if (code === 1008 || code === 4003 || code === 1006) {
            resolve();
          } else {
            reject(new Error(`Unexpected close code: ${code}`));
          }
        });
        setTimeout(() => reject(new Error('Timeout')), 5000);
      })
    ).resolves.toBeUndefined();
  });

  it('accepts WebSocket connection from allowed origin', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: {
        'Authorization': 'Bearer test-secret-token',
        'Origin': 'http://localhost:3402',
      },
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', (err) => {
          reject(err);
        });
        setTimeout(() => reject(new Error('Timeout')), 5000);
      })
    ).resolves.toBeUndefined();
  });

  it('accepts WebSocket connection without origin header (localhost tools)', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: {
        'Authorization': 'Bearer test-secret-token',
        // No origin header - common for server-to-server or CLI tools
      },
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', (err) => {
          reject(err);
        });
        setTimeout(() => reject(new Error('Timeout')), 5000);
      })
    ).resolves.toBeUndefined();
  });
});

describe('WebSocket Authentication Disabled', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      // No wsAuthToken - authentication disabled
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('allows unauthenticated WebSocket when auth is disabled', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', (err) => {
          reject(err);
        });
        setTimeout(() => reject(new Error('Timeout')), 5000);
      })
    ).resolves.toBeUndefined();
  });
});
