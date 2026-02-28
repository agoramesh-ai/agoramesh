import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NodeClient } from '../../src/node-client.js';
import { registerCheckTrust } from '../../src/tools/check-trust.js';

describe('check_trust tool', () => {
  let server: McpServer;
  let client: Client;
  let nodeClient: NodeClient;

  beforeAll(async () => {
    nodeClient = new NodeClient('http://localhost:0');
    server = new McpServer({ name: 'test', version: '1.0.0' });
    registerCheckTrust(server, nodeClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns trust breakdown for valid DID', async () => {
    vi.spyOn(nodeClient, 'getTrust').mockResolvedValueOnce({
      score: 0.85,
      tier: 'verified',
      reputation: 0.9531,
      stake_score: 0.7071,
      endorsement_score: 0.45,
      stake_amount: 5000_000_000,
      successful_transactions: 40,
      failed_transactions: 2,
      endorsement_count: 2,
      endorsements: [
        { endorser: 'did:agoramesh:base:xyz', endorserTrust: 0.90 },
        { endorser: 'did:agoramesh:base:def', endorserTrust: 0.75 },
      ],
    });

    const result = await client.callTool({ name: 'check_trust', arguments: { did: 'did:agoramesh:base:abc123' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('did:agoramesh:base:abc123');
    expect(text).toContain('0.85');
    expect(text).toContain('verified');
  });

  it('shows all score components', async () => {
    vi.spyOn(nodeClient, 'getTrust').mockResolvedValueOnce({
      score: 0.85,
      tier: 'verified',
      reputation: 0.9531,
      stake_score: 0.7071,
      endorsement_score: 0.45,
      stake_amount: 5000_000_000,
      successful_transactions: 40,
      failed_transactions: 2,
      endorsement_count: 2,
      endorsements: [
        { endorser: 'did:agoramesh:base:xyz', endorserTrust: 0.90 },
        { endorser: 'did:agoramesh:base:def', endorserTrust: 0.75 },
      ],
    });

    const result = await client.callTool({ name: 'check_trust', arguments: { did: 'did:agoramesh:base:abc123' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    // Overall
    expect(text).toContain('0.85');
    expect(text).toContain('verified');

    // Reputation
    expect(text).toContain('Reputation Score');
    expect(text).toContain('0.9531');
    expect(text).toContain('95.2%');
    expect(text).toContain('40 successful');

    // Stake
    expect(text).toContain('Stake Score');
    expect(text).toContain('0.7071');
    expect(text).toContain('5000.00 USDC');

    // Endorsements
    expect(text).toContain('Endorsement Score');
    expect(text).toContain('Endorsers: 2');
    expect(text).toContain('did:agoramesh:base:xyz');
    expect(text).toContain('0.90');
    expect(text).toContain('did:agoramesh:base:def');
    expect(text).toContain('0.75');
  });

  it('returns error message for unknown agent', async () => {
    vi.spyOn(nodeClient, 'getTrust').mockResolvedValueOnce(null);

    const result = await client.callTool({ name: 'check_trust', arguments: { did: 'did:agoramesh:base:unknown' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Agent not found');
    expect(text).toContain('did:agoramesh:base:unknown');
  });

  it('handles node client errors gracefully', async () => {
    vi.spyOn(nodeClient, 'getTrust').mockRejectedValueOnce(new Error('Network timeout'));

    const result = await client.callTool({ name: 'check_trust', arguments: { did: 'did:agoramesh:base:abc123' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Error');
    expect(text).toContain('Network timeout');
  });

  it('handles trust data with no endorsements', async () => {
    vi.spyOn(nodeClient, 'getTrust').mockResolvedValueOnce({
      score: 0.40,
      tier: 'newcomer',
      reputation: 0.8000,
      stake_score: 0.01,
      endorsement_score: 0.0,
      stake_amount: 100_000_000,
      successful_transactions: 4,
      failed_transactions: 1,
      endorsement_count: 0,
    });

    const result = await client.callTool({ name: 'check_trust', arguments: { did: 'did:agoramesh:base:new' } });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('0.40');
    expect(text).toContain('newcomer');
    expect(text).toContain('Endorsers: 0');
  });
});
