/**
 * Health Endpoint Info Disclosure Tests (L-3)
 *
 * Tests that unauthenticated health requests don't leak agent details.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-health-agent',
  description: 'Test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('Health endpoint info disclosure (L-3)', () => {
  describe('unauthenticated health response', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        rateLimit: { enabled: false },
      });
      app = (server as any).app;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('returns only status ok for unauthenticated requests', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('does not expose agent name for unauthenticated requests', async () => {
      const res = await request(app).get('/health');

      expect(res.body.agent).toBeUndefined();
    });

    it('does not expose mode for unauthenticated requests', async () => {
      const res = await request(app).get('/health');

      expect(res.body.mode).toBeUndefined();
    });
  });

  describe('authenticated health response', () => {
    let server: BridgeServer;
    let app: any;

    beforeAll(async () => {
      server = new BridgeServer({
        ...testConfig,
        rateLimit: { enabled: false },
        apiToken: 'health-test-token',
        requireAuth: true,
      });
      app = (server as any).app;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('exposes agent details for authenticated requests', async () => {
      const res = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer health-test-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.agent).toBe('test-health-agent');
      expect(res.body.mode).toBeDefined();
    });
  });
});
