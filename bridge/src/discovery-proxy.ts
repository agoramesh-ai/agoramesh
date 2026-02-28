/**
 * Discovery Proxy — proxies discovery requests to the AgoraMesh P2P node.
 * No authentication required (discovery is public).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const PROXY_TIMEOUT = 5000;

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

  function requireNodeUrl(res: Response): boolean {
    if (nodeUrl) return true;
    res.status(503).json({
      error: 'Discovery service not configured',
      code: 'SERVICE_UNAVAILABLE',
      help: {
        message: 'P2P node URL is not configured. Set AGORAMESH_NODE_URL environment variable.',
      },
    });
    return false;
  }

  function buildQueryString(params: Record<string, string | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return new URLSearchParams(entries).toString();
  }

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

  function sendAgentList(res: Response, data: unknown): void {
    const agents = Array.isArray(data) ? data : [];
    res.json({ agents, total: agents.length, source: 'network' });
  }

  router.get('/discovery/agents', async (req: Request, res: Response) => {
    if (!requireNodeUrl(res)) return;

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
      sendAgentList(res, result.data);
    } catch (error) {
      handleProxyError(res, error);
    }
  });

  router.get('/discovery/agents/:did(*)', async (req: Request, res: Response) => {
    if (!requireNodeUrl(res)) return;

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

  router.post('/discovery/search', async (req: Request, res: Response) => {
    if (!requireNodeUrl(res)) return;

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
        q: query,
        limit: limit?.toString(),
        offset: offset?.toString(),
        minTrust: minTrust?.toString(),
        maxPrice: maxPrice,
        tags: tags?.join(','),
      });

      const result = await proxyGet(`${nodeUrl}/agents/semantic?${qs}`);
      sendAgentList(res, result.data);
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
