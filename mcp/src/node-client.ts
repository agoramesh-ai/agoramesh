/**
 * HTTP client for the AgoraMesh P2P node.
 * Replicates the proven pattern from bridge/src/discovery-proxy.ts.
 */

const DEFAULT_TIMEOUT = 5000;

export class NodeClientError extends Error {
  constructor(public statusCode: number, public body: string) {
    super(`P2P node returned ${statusCode}: ${body}`);
    this.name = 'NodeClientError';
  }
}

export interface SearchOptions {
  limit?: number;
  minTrust?: number;
}

export class NodeClient {
  constructor(private nodeUrl: string) {}

  async searchAgents(query?: string, options?: SearchOptions): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.minTrust !== undefined) params.set('minTrust', String(options.minTrust));

    const qs = params.toString();
    const url = `${this.nodeUrl}/agents/semantic${qs ? `?${qs}` : ''}`;
    const result = await this.get(url);

    // Node may return array directly or { agents: [...] }
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && 'agents' in result && Array.isArray((result as Record<string, unknown>).agents)) {
      return (result as Record<string, unknown>).agents as unknown[];
    }
    return [];
  }

  async getAgent(did: string): Promise<unknown | null> {
    const url = `${this.nodeUrl}/agents/${did}`;
    return this.getOrNull(url);
  }

  async getTrust(did: string): Promise<unknown | null> {
    const url = `${this.nodeUrl}/trust/${did}`;
    return this.getOrNull(url);
  }

  private async get(url: string): Promise<unknown> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new NodeClientError(response.status, text);
    }

    return response.json();
  }

  private async getOrNull(url: string): Promise<unknown | null> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      const text = await response.text();
      throw new NodeClientError(response.status, text);
    }

    return response.json();
  }
}
