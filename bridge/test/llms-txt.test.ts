/**
 * llms.txt endpoint tests
 *
 * Tests the GET /llms.txt route which serves machine-readable documentation
 * following the llmstxt.org specification for AI agent discovery.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { RichAgentConfig } from '../src/types.js';

const testConfig: RichAgentConfig = {
  name: 'llms-txt-test-agent',
  description: 'Test agent for llms.txt endpoint',
  skills: ['coding'],
  pricePerTask: 5,
  privateKey: '0xdeadbeef',
  workspaceDir: '/tmp/llms-txt-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 120,
  url: 'https://agent.example.com',
  authentication: {
    schemes: ['freeTier', 'did:key', 'bearer'],
    didMethods: ['did:agoramesh', 'did:key'],
    instructions: {
      freeTier: {
        headerFormat: 'Authorization: FreeTier <your-agent-id>',
        identifierRules: '1-128 chars, alphanumeric, dash, underscore, dot',
        limits: '10 requests/day (grows with reputation), 2000 char output cap',
        example: 'Authorization: FreeTier my-coding-agent-v1',
      },
      'did:key': {
        headerFormat: 'Authorization: DID <did>:<unix-timestamp>:<base64url-ed25519-signature>',
        signaturePayload: '<unix-timestamp>:<HTTP-METHOD>:<path>',
        keyType: 'Ed25519',
      },
      bearer: {
        headerFormat: 'Authorization: Bearer <token>',
        note: 'Static API token configured by bridge operator',
      },
    },
  },
  freeTier: {
    enabled: true,
    authentication: 'did:key',
    limits: { requestsPerDay: 10, outputMaxChars: 2000 },
    upgradeInstructions: 'Pay via x402 for unlimited access.',
  },
};

describe('GET /llms.txt', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer(testConfig);
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns 200 with text/plain content type', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('starts with "# AgoraMesh Bridge" heading', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toMatch(/^# AgoraMesh Bridge/);
  });

  it('contains a blockquote summary after the title', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toContain('> ');
  });

  it('contains FreeTier curl example', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toContain('FreeTier');
    expect(res.text).toContain('curl');
  });

  it('contains ?wait=true in quick start example', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toContain('?wait=true');
  });

  it('does not require authentication', async () => {
    // No Authorization header — should still succeed
    const res = await request(app).get('/llms.txt');

    expect(res.status).toBe(200);
  });

  it('contains the configured base URL (not raw placeholder)', async () => {
    const res = await request(app).get('/llms.txt');

    // Should not contain literal {baseUrl} placeholder
    expect(res.text).not.toContain('{baseUrl}');
    // Should contain the actual configured URL or host-derived URL
    expect(res.text).toMatch(/https?:\/\//);
  });

  it('contains H2 sections per llmstxt.org spec', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toContain('## Quick Start');
    expect(res.text).toContain('## Authentication Methods');
    expect(res.text).toContain('## Documentation');
  });

  it('contains agent card link', async () => {
    const res = await request(app).get('/llms.txt');

    expect(res.text).toContain('/.well-known/agent.json');
  });
});
