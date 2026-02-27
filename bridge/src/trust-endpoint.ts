/**
 * Trust Endpoint — exposes local trust store + network trust data.
 * No authentication required (trust scores are public).
 */

import { Router, Request, Response } from 'express';
import { TrustStore, TrustProfile } from './trust-store.js';

const NETWORK_TIMEOUT = 3000;

interface TrustEndpointConfig {
  trustStore: TrustStore;
  nodeUrl?: string;
}

export function createTrustEndpoint(config: TrustEndpointConfig): Router {
  const router = Router();

  router.get('/trust/:did(*)', async (req: Request, res: Response) => {
    const did = req.params.did;

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
