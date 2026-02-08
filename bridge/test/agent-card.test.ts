import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import { AgentConfig, RichAgentConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Minimal config (basic AgentConfig only)
// ---------------------------------------------------------------------------

const minimalConfig: AgentConfig = {
  name: 'minimal-agent',
  description: 'Minimal test agent',
  skills: ['coding', 'testing'],
  pricePerTask: 0.05,
  privateKey: '0xdeadbeef',
  workspaceDir: '/tmp/minimal-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 120,
};

// ---------------------------------------------------------------------------
// Rich config (full RichAgentConfig)
// ---------------------------------------------------------------------------

const richConfig: RichAgentConfig = {
  name: 'rich-agent',
  description: 'Fully configured A2A agent',
  skills: ['coding', 'debugging'],
  pricePerTask: 10,
  privateKey: '0xdeadbeef',
  workspaceDir: '/tmp/rich-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 300,
  agentId: 'did:agentmesh:rich-agent-001',
  agentVersion: '2.5.0',
  url: 'https://agent.example.com',
  protocolVersion: '1.1',
  provider: {
    name: 'TestCorp',
    url: 'https://testcorp.example.com',
  },
  capabilities: {
    streaming: true,
    pushNotifications: false,
    x402Payments: true,
    escrow: true,
  },
  authentication: {
    schemes: ['did', 'bearer'],
    didMethods: ['did:key', 'did:agentmesh'],
  },
  richSkills: [
    {
      id: 'code.typescript',
      name: 'TypeScript Development',
      description: 'Full-stack TypeScript',
      tags: ['typescript', 'nodejs'],
      inputModes: ['text'],
      outputModes: ['text', 'application/json'],
      pricing: {
        model: 'per_request',
        amount: '5',
        currency: 'USDC',
      },
      sla: {
        avgResponseTime: 'PT5M',
        maxResponseTime: 'PT15M',
        availability: 0.99,
      },
    },
    {
      id: 'code.python',
      name: 'Python Development',
      description: 'Python scripting and data processing',
      tags: ['python'],
      inputModes: ['text'],
      outputModes: ['text'],
      pricing: {
        model: 'per_request',
        amount: '3',
        currency: 'USDC',
      },
    },
  ],
  payment: {
    methods: ['x402', 'escrow'],
    currencies: ['USDC'],
    chains: ['base'],
    addresses: { base: '0x1234567890abcdef1234567890abcdef12345678' },
    escrowContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  },
  trust: {
    score: 0.85,
    tier: 'verified',
    stake: {
      amount: '5000',
      currency: 'USDC',
    },
    endorsements: [
      {
        endorser: 'did:agentmesh:endorser-1',
        endorserName: 'Trusted Endorser',
        endorserTrust: 0.95,
        endorsedAt: '2026-01-15T00:00:00Z',
        message: 'Reliable agent',
      },
    ],
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'application/json'],
  documentationUrl: 'https://docs.example.com',
  termsOfServiceUrl: 'https://tos.example.com',
  privacyPolicyUrl: 'https://privacy.example.com',
};

// ===========================================================================
// Tests with minimal config
// ===========================================================================

describe('Agent Card endpoint (minimal config)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer(minimalConfig);
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns 200 with agent name and description', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('minimal-agent');
    expect(res.body.description).toBe('Minimal test agent');
  });

  it('maps string[] skills to {id, name} objects', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.skills).toEqual([
      { id: 'coding', name: 'coding' },
      { id: 'testing', name: 'testing' },
    ]);
  });

  it('falls back to defaultPricing from pricePerTask when no payment config', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.payment).toEqual({
      defaultPricing: {
        model: 'per_request',
        amount: '0.05',
        currency: 'USDC',
      },
    });
  });

  it('defaults protocolVersion to "1.0"', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.protocolVersion).toBe('1.0');
  });

  it('defaults version to "1.0.0"', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.version).toBe('1.0.0');
  });

  it('includes metadata with updatedAt timestamp', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.metadata).toBeDefined();
    expect(res.body.metadata.updatedAt).toBeDefined();
    // Verify it is a valid ISO date
    expect(new Date(res.body.metadata.updatedAt).toISOString()).toBe(
      res.body.metadata.updatedAt,
    );
  });

  it('does not include optional rich fields when absent', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.id).toBeUndefined();
    expect(res.body.url).toBeUndefined();
    expect(res.body.provider).toBeUndefined();
    expect(res.body.capabilities).toBeUndefined();
    expect(res.body.authentication).toBeUndefined();
    expect(res.body.trust).toBeUndefined();
    expect(res.body.defaultInputModes).toBeUndefined();
    expect(res.body.defaultOutputModes).toBeUndefined();
    expect(res.body.documentationUrl).toBeUndefined();
    expect(res.body.termsOfServiceUrl).toBeUndefined();
    expect(res.body.privacyPolicyUrl).toBeUndefined();
  });
});

// ===========================================================================
// Dual endpoint tests
// ===========================================================================

describe('Agent Card dual endpoints', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer(minimalConfig);
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('/.well-known/agent.json and /.well-known/agent-card.json return the same card structure', async () => {
    const res1 = await request(app).get('/.well-known/agent.json');
    const res2 = await request(app).get('/.well-known/agent-card.json');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Compare all fields except metadata.updatedAt which may differ by milliseconds
    const card1 = { ...res1.body };
    const card2 = { ...res2.body };
    delete card1.metadata;
    delete card2.metadata;

    expect(card1).toEqual(card2);
  });
});

// ===========================================================================
// Tests with rich config
// ===========================================================================

describe('Agent Card endpoint (rich config)', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(() => {
    server = new BridgeServer(richConfig);
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns full A2A card with all rich fields', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('rich-agent');
    expect(res.body.description).toBe('Fully configured A2A agent');
    expect(res.body.id).toBe('did:agentmesh:rich-agent-001');
    expect(res.body.url).toBe('https://agent.example.com');
    expect(res.body.protocolVersion).toBe('1.1');
    expect(res.body.version).toBe('2.5.0');
  });

  it('includes provider information', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.provider).toEqual({
      name: 'TestCorp',
      url: 'https://testcorp.example.com',
    });
  });

  it('includes capabilities', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      x402Payments: true,
      escrow: true,
    });
  });

  it('includes authentication config', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.authentication).toEqual({
      schemes: ['did', 'bearer'],
      didMethods: ['did:key', 'did:agentmesh'],
    });
  });

  it('passes through richSkills with pricing and SLA unchanged', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.skills).toHaveLength(2);

    const tsSkill = res.body.skills[0];
    expect(tsSkill.id).toBe('code.typescript');
    expect(tsSkill.name).toBe('TypeScript Development');
    expect(tsSkill.description).toBe('Full-stack TypeScript');
    expect(tsSkill.tags).toEqual(['typescript', 'nodejs']);
    expect(tsSkill.inputModes).toEqual(['text']);
    expect(tsSkill.outputModes).toEqual(['text', 'application/json']);
    expect(tsSkill.pricing).toEqual({
      model: 'per_request',
      amount: '5',
      currency: 'USDC',
    });
    expect(tsSkill.sla).toEqual({
      avgResponseTime: 'PT5M',
      maxResponseTime: 'PT15M',
      availability: 0.99,
    });

    const pySkill = res.body.skills[1];
    expect(pySkill.id).toBe('code.python');
    expect(pySkill.name).toBe('Python Development');
    expect(pySkill.pricing).toEqual({
      model: 'per_request',
      amount: '3',
      currency: 'USDC',
    });
    // SLA not set on python skill
    expect(pySkill.sla).toBeUndefined();
  });

  it('uses explicit payment config instead of defaultPricing fallback', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.payment.methods).toEqual(['x402', 'escrow']);
    expect(res.body.payment.currencies).toEqual(['USDC']);
    expect(res.body.payment.chains).toEqual(['base']);
    expect(res.body.payment.addresses).toEqual({
      base: '0x1234567890abcdef1234567890abcdef12345678',
    });
    expect(res.body.payment.escrowContract).toBe(
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    );
    // Should NOT have defaultPricing when explicit payment config is set
    expect(res.body.payment.defaultPricing).toBeUndefined();
  });

  it('includes trust metadata', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.trust.score).toBe(0.85);
    expect(res.body.trust.tier).toBe('verified');
    expect(res.body.trust.stake).toEqual({
      amount: '5000',
      currency: 'USDC',
    });
    expect(res.body.trust.endorsements).toHaveLength(1);
    expect(res.body.trust.endorsements[0].endorser).toBe(
      'did:agentmesh:endorser-1',
    );
  });

  it('includes defaultInputModes and defaultOutputModes', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.defaultInputModes).toEqual(['text']);
    expect(res.body.defaultOutputModes).toEqual(['text', 'application/json']);
  });

  it('includes documentation and policy URLs', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.documentationUrl).toBe('https://docs.example.com');
    expect(res.body.termsOfServiceUrl).toBe('https://tos.example.com');
    expect(res.body.privacyPolicyUrl).toBe('https://privacy.example.com');
  });
});
