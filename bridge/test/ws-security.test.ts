/**
 * WebSocket Security Tests (H-1, H-2, L-5)
 *
 * Tests for WebSocket task owner tracking, identity extraction, and heartbeat.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-ws-agent',
  description: 'Test agent for WS security',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

describe('WebSocket task owner tracking (H-1)', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      wsAuthToken: 'test-ws-token',
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('sets taskOwners for WebSocket-submitted tasks', async () => {
    const result = await new Promise<{ taskId: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        headers: { Authorization: 'Bearer test-ws-token' },
      });

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'task',
          payload: {
            type: 'prompt',
            prompt: 'test task',
            clientDid: 'did:test:ws-owner',
          },
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'result') {
          ws.close();
          resolve({ taskId: msg.payload.taskId });
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    const taskOwners = (server as any).taskOwners as Map<string, string>;
    expect(taskOwners.has(result.taskId)).toBe(true);
    expect(taskOwners.get(result.taskId)).toBe('did:test:ws-owner');
  });
});

describe('WebSocket anonymous identity (H-2)', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
      wsAuthToken: 'test-ws-token-h2',
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('does not use hardcoded anonymous when wsAuthToken is set', async () => {
    const result = await new Promise<{ taskId: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        headers: { Authorization: 'Bearer test-ws-token-h2' },
      });

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'task',
          payload: {
            type: 'prompt',
            prompt: 'test identity',
            // No clientDid — should NOT remain 'anonymous'
          },
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'result') {
          ws.close();
          resolve({ taskId: msg.payload.taskId });
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    const taskOwners = (server as any).taskOwners as Map<string, string>;
    const owner = taskOwners.get(result.taskId);
    expect(owner).not.toBe('anonymous');
  });
});

describe('WebSocket heartbeat (L-5)', () => {
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    server = new BridgeServer({
      ...testConfig,
      rateLimit: { enabled: false },
    });
    await server.start(0);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('responds to ping with pong', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);

      ws.on('open', () => {
        ws.ping();
      });

      ws.on('pong', () => {
        ws.close();
        resolve();
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
  });

  it('server has heartbeat interval configured', () => {
    const heartbeatInterval = (server as any).heartbeatInterval;
    expect(heartbeatInterval).toBeDefined();
  });
});
