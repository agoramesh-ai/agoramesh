# Agent Feedback Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address AI agent feedback: add discovery proxy, trust query endpoint, seed demo agents, and live/roadmap labels on the website.

**Architecture:** Bridge server gets 2 new Express routers (discovery-proxy, trust-endpoint) that proxy requests to the P2P node via `AGORAMESH_NODE_URL`. A seed script populates the network with 5 demo agents. Website content.ts gets status fields rendered as subtle labels.

**Tech Stack:** TypeScript, Express, Vitest, supertest, Astro, Tailwind CSS

---

### Task 1: Discovery Proxy — Tests

**Files:**
- Create: `bridge/test/discovery-proxy.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-agent',
  description: 'Test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

// Mock global fetch for P2P node proxy tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Discovery Proxy', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({ ...testConfig, nodeUrl: 'https://api.agoramesh.ai' });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('GET /discovery/agents', () => {
    it('proxies semantic search to P2P node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ did: 'did:test:1', name: 'Agent 1', score: 0.9 }],
      });

      const res = await request(app).get('/discovery/agents?q=translate&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].did).toBe('did:test:1');
      expect(res.body.source).toBe('network');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/semantic?q=translate&limit=5'),
        expect.any(Object),
      );
    });

    it('passes minTrust and maxPrice to node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await request(app).get('/discovery/agents?q=code&minTrust=0.8&maxPrice=0.05');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('minTrust=0.8'),
        expect.any(Object),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('maxPrice=0.05'),
        expect.any(Object),
      );
    });

    it('returns 503 when P2P node is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns 502 when P2P node returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('BAD_GATEWAY');
    });

    it('does not require authentication', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      });

      const res = await request(app).get('/discovery/agents?q=test');

      expect(res.status).toBe(200);
    });
  });

  describe('GET /discovery/agents/:did', () => {
    it('proxies agent lookup to P2P node', async () => {
      const card = { did: 'did:test:1', name: 'Agent 1', skills: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => card,
      });

      const res = await request(app).get('/discovery/agents/did:test:1');

      expect(res.status).toBe(200);
      expect(res.body.did).toBe('did:test:1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/did:test:1'),
        expect.any(Object),
      );
    });

    it('returns 404 when agent not found on node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const res = await request(app).get('/discovery/agents/did:test:unknown');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /discovery/search', () => {
    it('maps JSON body to semantic search', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ did: 'did:test:1', score: 0.95 }],
      });

      const res = await request(app)
        .post('/discovery/search')
        .send({ query: 'translate legal docs', minTrust: 0.8, maxPrice: '0.05', limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/agents/semantic?q=translate+legal+docs'),
        expect.any(Object),
      );
    });

    it('returns 400 when query is missing', async () => {
      const res = await request(app)
        .post('/discovery/search')
        .send({ minTrust: 0.8 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('Discovery Proxy — no nodeUrl configured', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer(testConfig); // no nodeUrl
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns 503 when nodeUrl is not configured', async () => {
    const res = await request(app).get('/discovery/agents?q=test');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.help.message).toContain('not configured');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/discovery-proxy.test.ts`
Expected: FAIL — `nodeUrl` not in BridgeServerConfig, no `/discovery/*` routes

---

### Task 2: Discovery Proxy — Implementation

**Files:**
- Create: `bridge/src/discovery-proxy.ts`
- Modify: `bridge/src/server.ts:162-185` (add `nodeUrl` to `BridgeServerConfig`)
- Modify: `bridge/src/server.ts:573-595` (register discovery routes in `setupRoutes`)

**Step 1: Add `nodeUrl` to BridgeServerConfig**

In `bridge/src/server.ts`, add to `BridgeServerConfig` interface (after line 184):

```typescript
  /** AgoraMesh P2P node URL for discovery and trust proxy (e.g. https://api.agoramesh.ai) */
  nodeUrl?: string;
```

**Step 2: Create `bridge/src/discovery-proxy.ts`**

```typescript
/**
 * Discovery Proxy — proxies discovery requests to the AgoraMesh P2P node.
 * No authentication required (discovery is public).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const PROXY_TIMEOUT = 5000; // 5s timeout for P2P node requests

const SearchBodySchema = z.object({
  query: z.string().min(1, 'query is required').max(500),
  minTrust: z.number().min(0).max(1).optional(),
  maxPrice: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export function createDiscoveryProxy(nodeUrl?: string): Router {
  const router = Router();

  /**
   * Build query string from params, filtering out undefined values.
   */
  function buildQueryString(params: Record<string, string | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return new URLSearchParams(entries).toString();
  }

  /**
   * Proxy a GET request to the P2P node.
   */
  async function proxyGet(url: string): Promise<{ status: number; data: unknown }> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(PROXY_TIMEOUT),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { status: 404, data: null };
      }
      const text = await response.text();
      throw new ProxyError(response.status, text);
    }

    return { status: 200, data: await response.json() };
  }

  // GET /discovery/agents?q=...&limit=...&minTrust=...&maxPrice=...
  router.get('/discovery/agents', async (req: Request, res: Response) => {
    if (!nodeUrl) {
      return res.status(503).json({
        error: 'Discovery service not configured',
        code: 'SERVICE_UNAVAILABLE',
        help: {
          message: 'P2P node URL is not configured. Set AGORAMESH_NODE_URL environment variable.',
        },
      });
    }

    try {
      const qs = buildQueryString({
        q: req.query.q as string | undefined,
        limit: req.query.limit as string | undefined,
        offset: req.query.offset as string | undefined,
        minTrust: req.query.minTrust as string | undefined,
        maxPrice: req.query.maxPrice as string | undefined,
        tags: req.query.tags as string | undefined,
        currency: req.query.currency as string | undefined,
      });

      const result = await proxyGet(`${nodeUrl}/agents/semantic?${qs}`);
      const agents = Array.isArray(result.data) ? result.data : [];

      res.json({
        agents,
        total: agents.length,
        source: 'network',
      });
    } catch (error) {
      handleProxyError(res, error);
    }
  });

  // GET /discovery/agents/:did
  router.get('/discovery/agents/:did(*)', async (req: Request, res: Response) => {
    if (!nodeUrl) {
      return res.status(503).json({
        error: 'Discovery service not configured',
        code: 'SERVICE_UNAVAILABLE',
        help: {
          message: 'P2P node URL is not configured. Set AGORAMESH_NODE_URL environment variable.',
        },
      });
    }

    try {
      const result = await proxyGet(`${nodeUrl}/agents/${req.params.did}`);

      if (result.status === 404) {
        return res.status(404).json({
          error: 'Agent not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(result.data);
    } catch (error) {
      handleProxyError(res, error);
    }
  });

  // POST /discovery/search
  router.post('/discovery/search', async (req: Request, res: Response) => {
    if (!nodeUrl) {
      return res.status(503).json({
        error: 'Discovery service not configured',
        code: 'SERVICE_UNAVAILABLE',
        help: {
          message: 'P2P node URL is not configured. Set AGORAMESH_NODE_URL environment variable.',
        },
      });
    }

    const parsed = SearchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid search request',
        code: 'VALIDATION_ERROR',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    try {
      const { query, minTrust, maxPrice, tags, limit, offset } = parsed.data;
      const qs = buildQueryString({
        q: query.replace(/ /g, '+'),
        limit: limit?.toString(),
        offset: offset?.toString(),
        minTrust: minTrust?.toString(),
        maxPrice: maxPrice,
        tags: tags?.join(','),
      });

      const result = await proxyGet(`${nodeUrl}/agents/semantic?${qs}`);
      const agents = Array.isArray(result.data) ? result.data : [];

      res.json({
        agents,
        total: agents.length,
        source: 'network',
      });
    } catch (error) {
      handleProxyError(res, error);
    }
  });

  return router;
}

class ProxyError extends Error {
  constructor(public statusCode: number, public body: string) {
    super(`P2P node returned ${statusCode}: ${body}`);
  }
}

function handleProxyError(res: Response, error: unknown): void {
  if (error instanceof ProxyError) {
    res.status(502).json({
      error: 'P2P node returned an error',
      code: 'BAD_GATEWAY',
      help: { message: `Upstream error: ${error.statusCode}` },
    });
  } else {
    res.status(503).json({
      error: 'Discovery service unavailable',
      code: 'SERVICE_UNAVAILABLE',
      help: { message: 'P2P node is not reachable. Try again later.' },
    });
  }
}
```

**Step 3: Register discovery routes in server.ts**

In `bridge/src/server.ts`:

Add import at the top (after line 17):
```typescript
import { createDiscoveryProxy } from './discovery-proxy.js';
```

In `setupRoutes()` method, after the health check (around line 581), add:
```typescript
    // Discovery proxy — no auth, proxies to P2P node
    this.app.use(createDiscoveryProxy(this.config.nodeUrl));
```

**Step 4: Add `nodeUrl` to cli.ts env loading**

In `bridge/src/cli.ts`, add to serverConfig (after line 76):
```typescript
    nodeUrl: process.env.AGORAMESH_NODE_URL,
```

**Step 5: Run tests**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/discovery-proxy.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/discovery-proxy.ts bridge/src/server.ts bridge/src/cli.ts bridge/test/discovery-proxy.test.ts
git commit -m "feat(bridge): add discovery proxy endpoints

Proxy /discovery/agents and /discovery/search to P2P node.
No auth required. Returns 503 when node is unavailable."
```

---

### Task 3: Trust Endpoint — Tests

**Files:**
- Create: `bridge/test/trust-endpoint.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'test-agent',
  description: 'Test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Trust Endpoint', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({ ...testConfig, nodeUrl: 'https://api.agoramesh.ai' });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('GET /trust/:did', () => {
    it('returns local trust data for known DID', async () => {
      // getProfile auto-creates NEW profile for unknown DIDs
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')); // network unavailable

      const res = await request(app).get('/trust/did:key:z6MkTest');

      expect(res.status).toBe(200);
      expect(res.body.did).toBe('did:key:z6MkTest');
      expect(res.body.local).toBeDefined();
      expect(res.body.local.tier).toBe('new');
      expect(res.body.local.completions).toBe(0);
      expect(res.body.local.dailyLimit).toBe(10);
    });

    it('returns both local and network trust when P2P node is available', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          did: 'did:key:z6MkTest2',
          score: 0.72,
          reputation: 0.8,
          stake_score: 0.6,
          endorsement_score: 0.5,
        }),
      });

      const res = await request(app).get('/trust/did:key:z6MkTest2');

      expect(res.status).toBe(200);
      expect(res.body.local).toBeDefined();
      expect(res.body.network).toBeDefined();
      expect(res.body.network.overall).toBe(0.72);
      expect(res.body.network.reputation).toBe(0.8);
      expect(res.body.network.stake).toBe(0.6);
      expect(res.body.network.endorsement).toBe(0.5);
    });

    it('returns network: null when P2P node is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await request(app).get('/trust/did:key:z6MkTest3');

      expect(res.status).toBe(200);
      expect(res.body.local).toBeDefined();
      expect(res.body.network).toBeNull();
    });

    it('does not require authentication', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      const res = await request(app).get('/trust/did:key:z6MkAnon');

      expect(res.status).toBe(200);
    });
  });
});

describe('Trust Endpoint — no nodeUrl', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer(testConfig); // no nodeUrl
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns only local trust data when nodeUrl not configured', async () => {
    const res = await request(app).get('/trust/did:key:z6MkLocal');

    expect(res.status).toBe(200);
    expect(res.body.local).toBeDefined();
    expect(res.body.network).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/trust-endpoint.test.ts`
Expected: FAIL — no `/trust/:did` route

---

### Task 4: Trust Endpoint — Implementation

**Files:**
- Create: `bridge/src/trust-endpoint.ts`
- Modify: `bridge/src/server.ts:573-595` (register trust route in `setupRoutes`)

**Step 1: Create `bridge/src/trust-endpoint.ts`**

```typescript
/**
 * Trust Endpoint — exposes local trust store + network trust data.
 * No authentication required (trust scores are public).
 */

import { Router, Request, Response } from 'express';
import { TrustStore, TrustProfile } from './trust-store.js';

const NETWORK_TIMEOUT = 3000; // 3s timeout for P2P node trust query

interface TrustEndpointConfig {
  trustStore: TrustStore;
  nodeUrl?: string;
}

export function createTrustEndpoint(config: TrustEndpointConfig): Router {
  const router = Router();

  router.get('/trust/:did(*)', async (req: Request, res: Response) => {
    const did = req.params.did;

    // Fetch local and network trust in parallel
    const [local, network] = await Promise.all([
      getLocalTrust(config.trustStore, did),
      getNetworkTrust(config.nodeUrl, did),
    ]);

    res.json({ did, local, network });
  });

  return router;
}

function getLocalTrust(
  trustStore: TrustStore,
  did: string,
): {
  tier: string;
  completions: number;
  failures: number;
  failureRate: number;
  firstSeen: string;
  dailyLimit: number;
  outputLimit: number;
} {
  const profile: TrustProfile = trustStore.getProfile(did);
  const limits = trustStore.getLimitsForDID(did);
  const total = profile.completedTasks + profile.failedTasks;

  return {
    tier: profile.tier,
    completions: profile.completedTasks,
    failures: profile.failedTasks,
    failureRate: total > 0 ? profile.failedTasks / total : 0,
    firstSeen: new Date(profile.firstSeen).toISOString(),
    dailyLimit: limits.dailyLimit,
    outputLimit: limits.outputLimit,
  };
}

async function getNetworkTrust(
  nodeUrl: string | undefined,
  did: string,
): Promise<{
  overall: number;
  reputation: number;
  stake: number;
  endorsement: number;
} | null> {
  if (!nodeUrl) return null;

  try {
    const response = await fetch(`${nodeUrl}/trust/${did}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      overall: data.score ?? data.overall ?? 0,
      reputation: data.reputation ?? 0,
      stake: data.stake_score ?? data.stake ?? 0,
      endorsement: data.endorsement_score ?? data.endorsement ?? 0,
    };
  } catch {
    return null;
  }
}
```

**Step 2: Register trust route in server.ts**

In `bridge/src/server.ts`, add import (near the discovery-proxy import):
```typescript
import { createTrustEndpoint } from './trust-endpoint.js';
```

In `setupRoutes()`, right after the discovery proxy registration:
```typescript
    // Trust endpoint — no auth, returns local + network trust data
    this.app.use(createTrustEndpoint({
      trustStore: this.trustStore,
      nodeUrl: this.config.nodeUrl,
    }));
```

**Step 3: Run tests**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/trust-endpoint.test.ts`
Expected: All PASS

**Step 4: Run all bridge tests to ensure no regressions**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/trust-endpoint.ts bridge/src/server.ts bridge/test/trust-endpoint.test.ts
git commit -m "feat(bridge): add trust query endpoint

GET /trust/:did returns local trust store data + network trust
from P2P node in parallel. No auth required."
```

---

### Task 5: Seed Demo Agents — Fixtures + Script

**Files:**
- Create: `bridge/fixtures/seed-agents.json`
- Create: `bridge/scripts/seed-agents.ts`

**Step 1: Create fixture data**

Create `bridge/fixtures/seed-agents.json`:

```json
[
  {
    "name": "Translator Agent",
    "description": "Professional translation agent supporting EN, CS, DE, ES. Specializes in legal, technical, and marketing content.",
    "url": "https://translator.demo.agoramesh.ai",
    "version": "1.0.0",
    "skills": [
      {
        "id": "translation",
        "name": "Document Translation",
        "description": "Translate documents between EN, CS, DE, ES with domain expertise",
        "tags": ["translation", "localization", "legal", "technical", "marketing"]
      },
      {
        "id": "localization",
        "name": "Content Localization",
        "description": "Adapt content for target culture and market",
        "tags": ["localization", "cultural-adaptation", "i18n"]
      }
    ],
    "payment": {
      "methods": ["x402", "escrow"],
      "currencies": ["USDC"],
      "chains": ["base"],
      "defaultPricing": { "model": "per_unit", "unit": "word", "amount": "0.003", "currency": "USDC" }
    }
  },
  {
    "name": "Code Review Agent",
    "description": "Automated code review for TypeScript, Python, and Rust. Checks security, performance, and best practices.",
    "url": "https://code-review.demo.agoramesh.ai",
    "version": "1.0.0",
    "skills": [
      {
        "id": "code-review",
        "name": "Code Review",
        "description": "Review code for bugs, security issues, and best practices",
        "tags": ["code-review", "security", "best-practices", "typescript", "python", "rust"]
      },
      {
        "id": "refactoring",
        "name": "Code Refactoring",
        "description": "Suggest and apply refactoring improvements",
        "tags": ["refactoring", "clean-code", "optimization"]
      }
    ],
    "payment": {
      "methods": ["x402", "escrow"],
      "currencies": ["USDC"],
      "chains": ["base"],
      "defaultPricing": { "model": "per_request", "amount": "2.00", "currency": "USDC" }
    }
  },
  {
    "name": "Data Analyst Agent",
    "description": "Data analysis, SQL queries, and visualization. Works with CSV, JSON, and SQL databases.",
    "url": "https://data-analyst.demo.agoramesh.ai",
    "version": "1.0.0",
    "skills": [
      {
        "id": "data-analysis",
        "name": "Data Analysis",
        "description": "Analyze datasets, find patterns, generate insights",
        "tags": ["data-analysis", "statistics", "insights", "sql", "pandas"]
      },
      {
        "id": "visualization",
        "name": "Data Visualization",
        "description": "Create charts and dashboards from data",
        "tags": ["visualization", "charts", "dashboards", "reporting"]
      }
    ],
    "payment": {
      "methods": ["x402", "escrow"],
      "currencies": ["USDC"],
      "chains": ["base"],
      "defaultPricing": { "model": "per_request", "amount": "1.50", "currency": "USDC" }
    }
  },
  {
    "name": "Copywriter Agent",
    "description": "SEO-optimized copywriting for blogs, landing pages, emails, and social media.",
    "url": "https://copywriter.demo.agoramesh.ai",
    "version": "1.0.0",
    "skills": [
      {
        "id": "copywriting",
        "name": "Copywriting",
        "description": "Write compelling copy for web, email, and social media",
        "tags": ["copywriting", "content", "seo", "marketing", "blog", "email"]
      },
      {
        "id": "seo",
        "name": "SEO Optimization",
        "description": "Optimize content for search engines",
        "tags": ["seo", "keywords", "meta-tags", "content-optimization"]
      }
    ],
    "payment": {
      "methods": ["x402", "escrow"],
      "currencies": ["USDC"],
      "chains": ["base"],
      "defaultPricing": { "model": "per_unit", "unit": "word", "amount": "0.005", "currency": "USDC" }
    }
  },
  {
    "name": "Security Auditor Agent",
    "description": "Security audits for web applications and smart contracts. OWASP Top 10, Solidity vulnerabilities.",
    "url": "https://security-auditor.demo.agoramesh.ai",
    "version": "1.0.0",
    "skills": [
      {
        "id": "security-audit",
        "name": "Security Audit",
        "description": "Audit web applications for OWASP Top 10 vulnerabilities",
        "tags": ["security", "audit", "owasp", "penetration-testing", "web"]
      },
      {
        "id": "smart-contract-audit",
        "name": "Smart Contract Audit",
        "description": "Audit Solidity smart contracts for vulnerabilities",
        "tags": ["smart-contract", "solidity", "audit", "defi", "security"]
      }
    ],
    "payment": {
      "methods": ["x402", "escrow"],
      "currencies": ["USDC"],
      "chains": ["base"],
      "defaultPricing": { "model": "per_request", "amount": "10.00", "currency": "USDC" }
    }
  }
]
```

**Step 2: Create seed script**

Create `bridge/scripts/seed-agents.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Seed demo agents into the AgoraMesh P2P network.
 * Usage: npx tsx scripts/seed-agents.ts [nodeUrl]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedAgent {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  payment: Record<string, unknown>;
}

async function main() {
  const nodeUrl = process.argv[2] || process.env.AGORAMESH_NODE_URL || 'https://api.agoramesh.ai';
  const adminToken = process.env.AGORAMESH_ADMIN_TOKEN;

  console.log(`Seeding agents to: ${nodeUrl}`);

  const fixturesPath = resolve(__dirname, '../fixtures/seed-agents.json');
  const agents: SeedAgent[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

  let success = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminToken) {
        headers['Authorization'] = `Bearer ${adminToken}`;
      }

      const response = await fetch(`${nodeUrl}/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify(agent),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        console.log(`  ✓ ${agent.name}`);
        success++;
      } else {
        const text = await response.text();
        console.error(`  ✗ ${agent.name}: ${response.status} ${text}`);
        failed++;
      }
    } catch (error) {
      console.error(`  ✗ ${agent.name}: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} registered, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
```

**Step 3: Test the script loads fixtures correctly**

Run: `cd /home/lada/projects/agoramesh/bridge && npx tsx -e "import { readFileSync } from 'fs'; const agents = JSON.parse(readFileSync('fixtures/seed-agents.json', 'utf-8')); console.log(agents.length + ' agents loaded'); agents.forEach(a => console.log('  -', a.name))"`
Expected: `5 agents loaded` with all 5 names listed

**Step 4: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/fixtures/seed-agents.json bridge/scripts/seed-agents.ts
git commit -m "feat(bridge): add seed script for demo agents

5 demo agents (translator, code-review, data-analyst, copywriter,
security-auditor) with realistic capability cards."
```

---

### Task 6: Website Labels — Content Changes

**Files:**
- Modify: `agoramesh.ai/src/data/content.ts:44-73` (add status to solution layers)
- Modify: `agoramesh.ai/src/data/content.cs.ts` (same changes for Czech locale)

**Step 1: Add status field to solution layers in content.ts**

In `agoramesh.ai/src/data/content.ts`, modify the `solution.layers` array to add `status` to each layer:

```typescript
export const solution = {
  headline: 'Four layers. One protocol.',
  description: 'AgoraMesh is an open protocol and trust layer for AI agent commerce. Each layer solves one problem, and they work together.',
  layers: [
    {
      name: 'Discovery',
      description: 'Semantic search + Kademlia DHT.',
      detail: 'A2A-compatible capability cards, vector embeddings, and a decentralized registry via libp2p. O(log n) lookup, no central server.',
      icon: 'search',
      status: 'beta' as const,
    },
    {
      name: 'Trust',
      description: 'On-chain composite trust scores.',
      detail: '50% reputation (tx history) + 30% stake (collateral) + 20% web-of-trust (endorsements). ERC-8004 compatible. Progressive trust tiers grow limits from 10 to 100 tasks/day.',
      icon: 'shield',
      status: 'beta' as const,
    },
    {
      name: 'Payment',
      description: 'x402 micropayments + USDC escrow.',
      detail: 'Direct payments for trusted parties (~$0.001 gas). Escrow for new relationships. Streaming payments for long-running tasks. All in USDC on Base L2.',
      icon: 'payment',
      status: 'live' as const,
    },
    {
      name: 'Disputes',
      description: 'Three-tier resolution system.',
      detail: 'Under $10: automatic smart contract rules. $10-$1K: AI-assisted with 3 arbiters. Over $1K: Kleros-style community voting with up to 47 jurors.',
      icon: 'dispute',
      status: 'coming-soon' as const,
    },
  ],
};
```

**Step 2: Apply same changes to content.cs.ts**

Find the same `solution.layers` array in `agoramesh.ai/src/data/content.cs.ts` and add the same `status` values.

**Step 3: Commit**

```bash
cd /home/lada/projects/agoramesh.ai
git add src/data/content.ts src/data/content.cs.ts
git commit -m "feat(web): add status labels to protocol layers

Discovery/Trust: beta, Payment: live, Disputes: coming-soon"
```

---

### Task 7: Website Labels — Component Rendering

**Files:**
- Modify: `agoramesh.ai/src/components/Solution.astro:43-44`

**Step 1: Add conditional status label to layer heading**

In `agoramesh.ai/src/components/Solution.astro`, change the layer name heading (line 43) to include a status suffix:

Replace:
```astro
<h3 class="mb-1 text-lg font-semibold">{layer.name}</h3>
```

With:
```astro
<h3 class="mb-1 text-lg font-semibold">
  {layer.name}
  {layer.status === 'beta' && <span class="ml-2 text-xs font-normal text-amber-400/80">— beta</span>}
  {layer.status === 'coming-soon' && <span class="ml-2 text-xs font-normal text-neutral-500">— coming soon</span>}
</h3>
```

Note: `"live"` status gets no label (no visual noise for shipped features).

**Step 2: Verify build**

Run: `cd /home/lada/projects/agoramesh.ai && npm run build`
Expected: Build succeeds, bundle under 50KB

**Step 3: Visual check**

Run: `cd /home/lada/projects/agoramesh.ai && npm run dev`
Open http://localhost:4321 → scroll to Protocol section → verify labels appear

**Step 4: Commit**

```bash
cd /home/lada/projects/agoramesh.ai
git add src/components/Solution.astro
git commit -m "feat(web): render beta/coming-soon labels on protocol layers

Subtle text suffix after layer name. Live features get no label."
```

---

### Task 8: Integration Test — Verify All New Endpoints

**Files:**
- Create: `bridge/test/feedback-integration.test.ts`

**Step 1: Write integration test for all new endpoints**

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { BridgeServer } from '../src/server.js';
import type { AgentConfig } from '../src/types.js';

const testConfig: AgentConfig = {
  name: 'integration-test-agent',
  description: 'Integration test agent',
  skills: ['coding'],
  pricePerTask: 0.01,
  privateKey: '0x1234567890abcdef',
  workspaceDir: '/tmp/test-workspace',
  allowedCommands: ['claude'],
  taskTimeout: 60,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Agent Feedback Integration — all new endpoints', () => {
  let server: BridgeServer;
  let app: any;

  beforeAll(async () => {
    server = new BridgeServer({ ...testConfig, nodeUrl: 'https://api.agoramesh.ai' });
    app = (server as any).app;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /discovery/agents returns agents from network', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ did: 'did:test:1', name: 'Agent 1' }],
    });

    const res = await request(app).get('/discovery/agents?q=test');
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
    expect(res.body.source).toBe('network');
  });

  it('POST /discovery/search works with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ did: 'did:test:2' }],
    });

    const res = await request(app)
      .post('/discovery/search')
      .send({ query: 'translate documents' });
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeDefined();
  });

  it('GET /trust/:did returns trust data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ score: 0.85, reputation: 0.9, stake_score: 0.8, endorsement_score: 0.7 }),
    });

    const res = await request(app).get('/trust/did:key:z6MkIntegration');
    expect(res.status).toBe(200);
    expect(res.body.local).toBeDefined();
    expect(res.body.network).toBeDefined();
    expect(res.body.network.overall).toBe(0.85);
  });

  it('existing endpoints still work', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const card = await request(app).get('/.well-known/agent.json');
    expect(card.status).toBe(200);

    const llms = await request(app).get('/llms.txt');
    expect(llms.status).toBe(200);
  });
});
```

**Step 2: Run all tests**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run`
Expected: All tests PASS (existing + new)

**Step 3: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/test/feedback-integration.test.ts
git commit -m "test(bridge): add integration tests for feedback improvements

Covers discovery proxy, trust endpoint, and regression checks."
```

---

### Task 9: Final Verification

**Step 1: Run full bridge test suite**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run`
Expected: All PASS

**Step 2: Build bridge**

Run: `cd /home/lada/projects/agoramesh/bridge && npm run build`
Expected: Build succeeds with no errors

**Step 3: Build website**

Run: `cd /home/lada/projects/agoramesh.ai && npm run build`
Expected: Build succeeds, JS bundle under 50KB

**Step 4: Lint**

Run: `cd /home/lada/projects/agoramesh/bridge && npm run lint`
Expected: No errors
