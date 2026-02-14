import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgentCardConfig } from '../src/config.js';

describe('loadAgentCardConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentme-config-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads a valid config file and returns all fields', () => {
    const config = {
      name: 'My Agent',
      description: 'A test agent',
      skills: ['coding', 'debugging'],
      pricePerTask: 5,
      agentId: 'did:agentme:test-agent',
      agentVersion: '2.0.0',
      url: 'https://agent.example.com',
      protocolVersion: '1.0',
      provider: {
        name: 'TestCo',
        url: 'https://testco.example.com',
      },
      capabilities: {
        streaming: true,
        pushNotifications: false,
        x402Payments: true,
        escrow: true,
      },
      authentication: {
        schemes: ['did', 'bearer'],
        didMethods: ['did:key'],
      },
      richSkills: [
        {
          id: 'code.ts',
          name: 'TypeScript',
          description: 'TS development',
          tags: ['typescript'],
          pricing: {
            model: 'per_request' as const,
            amount: '5',
            currency: 'USDC',
          },
          sla: {
            avgResponseTime: 'PT5M',
            maxResponseTime: 'PT15M',
            availability: 0.99,
          },
        },
      ],
      payment: {
        methods: ['x402' as const, 'escrow' as const],
        currencies: ['USDC'],
        chains: ['base'],
        addresses: { base: '0x0000000000000000000000000000000000000000' },
      },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text', 'application/json'],
      documentationUrl: 'https://docs.example.com',
      termsOfServiceUrl: 'https://tos.example.com',
      privacyPolicyUrl: 'https://privacy.example.com',
    };

    const filePath = join(tempDir, 'agent-card.config.json');
    writeFileSync(filePath, JSON.stringify(config));

    const result = loadAgentCardConfig(filePath);

    expect(result.name).toBe('My Agent');
    expect(result.description).toBe('A test agent');
    expect(result.skills).toEqual(['coding', 'debugging']);
    expect(result.pricePerTask).toBe(5);
    expect(result.agentId).toBe('did:agentme:test-agent');
    expect(result.agentVersion).toBe('2.0.0');
    expect(result.url).toBe('https://agent.example.com');
    expect(result.protocolVersion).toBe('1.0');
    expect(result.provider).toEqual({ name: 'TestCo', url: 'https://testco.example.com' });
    expect(result.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      x402Payments: true,
      escrow: true,
    });
    expect(result.authentication).toEqual({
      schemes: ['did', 'bearer'],
      didMethods: ['did:key'],
    });
    expect(result.richSkills).toHaveLength(1);
    expect(result.richSkills![0].id).toBe('code.ts');
    expect(result.richSkills![0].pricing).toEqual({
      model: 'per_request',
      amount: '5',
      currency: 'USDC',
    });
    expect(result.payment).toEqual(config.payment);
    expect(result.defaultInputModes).toEqual(['text']);
    expect(result.defaultOutputModes).toEqual(['text', 'application/json']);
    expect(result.documentationUrl).toBe('https://docs.example.com');
    expect(result.termsOfServiceUrl).toBe('https://tos.example.com');
    expect(result.privacyPolicyUrl).toBe('https://privacy.example.com');
  });

  it('returns empty object when file does not exist', () => {
    const result = loadAgentCardConfig(join(tempDir, 'nonexistent.json'));

    expect(result).toEqual({});
  });

  it('throws descriptive error for malformed JSON', () => {
    const filePath = join(tempDir, 'bad.json');
    writeFileSync(filePath, '{ this is not valid json }');

    expect(() => loadAgentCardConfig(filePath)).toThrowError(/invalid JSON/);
  });

  it('throws descriptive error for schema validation failures', () => {
    const filePath = join(tempDir, 'invalid-schema.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        name: 12345, // should be string
        pricePerTask: 'not-a-number', // should be number
      }),
    );

    expect(() => loadAgentCardConfig(filePath)).toThrowError(/Invalid agent card config/);
  });

  it('returns empty object for empty JSON object', () => {
    const filePath = join(tempDir, 'empty.json');
    writeFileSync(filePath, '{}');

    const result = loadAgentCardConfig(filePath);

    expect(result).toEqual({});
  });

  it('works with partial config (only some fields set)', () => {
    const filePath = join(tempDir, 'partial.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        name: 'Partial Agent',
        description: 'Only name and description',
      }),
    );

    const result = loadAgentCardConfig(filePath);

    expect(result.name).toBe('Partial Agent');
    expect(result.description).toBe('Only name and description');
    // Other fields should not be present at all
    expect(result.skills).toBeUndefined();
    expect(result.agentId).toBeUndefined();
    expect(result.richSkills).toBeUndefined();
  });

  it('strips undefined values from returned config', () => {
    const filePath = join(tempDir, 'partial-strip.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        name: 'Strip Test',
      }),
    );

    const result = loadAgentCardConfig(filePath);
    const keys = Object.keys(result);

    // Only the explicitly set key should be present
    expect(keys).toEqual(['name']);
    // Verify no undefined values exist in the object
    for (const key of keys) {
      expect((result as Record<string, unknown>)[key]).not.toBeUndefined();
    }
  });

  it('excludes security-critical fields from parsed config', () => {
    const filePath = join(tempDir, 'security.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        name: 'Security Test',
        privateKey: '0xdeadbeef',
        workspaceDir: '/tmp/evil',
        allowedCommands: ['rm', 'curl', 'wget'],
      }),
    );

    const result = loadAgentCardConfig(filePath);

    // Only non-security fields should survive
    expect(result.name).toBe('Security Test');
    // Security-critical fields must NOT be present
    expect((result as Record<string, unknown>).privateKey).toBeUndefined();
    expect((result as Record<string, unknown>).workspaceDir).toBeUndefined();
    expect((result as Record<string, unknown>).allowedCommands).toBeUndefined();
  });

  it('rejects config file exceeding size limit', () => {
    const filePath = join(tempDir, 'huge.json');
    // Write a file larger than 1 MB
    const huge = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1) });
    writeFileSync(filePath, huge);

    expect(() => loadAgentCardConfig(filePath)).toThrowError(/too large/);
  });

  it('loads config from a custom file path', () => {
    const customPath = join(tempDir, 'custom', 'my-agent.json');
    // Create subdirectory
    const { mkdirSync } = require('node:fs');
    mkdirSync(join(tempDir, 'custom'), { recursive: true });

    writeFileSync(
      customPath,
      JSON.stringify({
        name: 'Custom Path Agent',
        agentVersion: '3.0.0',
      }),
    );

    const result = loadAgentCardConfig(customPath);

    expect(result.name).toBe('Custom Path Agent');
    expect(result.agentVersion).toBe('3.0.0');
  });
});
