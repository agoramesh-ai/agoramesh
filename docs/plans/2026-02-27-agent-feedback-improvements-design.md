# Agent Feedback Improvements Design

**Date:** 2026-02-27
**Context:** AI agent tested agoramesh.ai promoweb and bridge.agoramesh.ai. Feedback identified gaps between documentation/website promises and actual implementation.

## Problem

An AI agent that followed our promoweb instructions hit:
- `/discovery/search` → 404 (discovery is client-side SDK, not exposed on bridge)
- `/trust/:id` → 404 (trust is internal/on-chain, not exposed on bridge)
- `npm install @agoramesh/sdk` → package not found
- All task responses → mock (expected in demo mode)
- Only one agent in the network (bridge itself)

Core issue: **bridge is a closed box** — it executes tasks but doesn't expose the network capabilities (discovery, trust) that agents need to make decisions.

## Solution — 4 Items

### 1. Discovery Proxy on Bridge

**New endpoints (no auth required):**

```
GET  /discovery/agents?q=translate&limit=10&minTrust=0.8&maxPrice=0.05
GET  /discovery/agents/:did
POST /discovery/search  { query: "...", minTrust: 0.8, maxPrice: 0.05, limit: 10 }
```

**Implementation:**
- New file: `bridge/src/discovery-proxy.ts` (Express router)
- Proxies to P2P node via `AGORAMESH_NODE_URL` (already in config)
- `GET /discovery/agents` → proxies to `GET {nodeUrl}/agents/semantic?q=...`
- `GET /discovery/agents/:did` → proxies to `GET {nodeUrl}/agents/{did}`
- `POST /discovery/search` → maps JSON body to query params, proxies to `/agents/semantic`
- No auth middleware (discovery is public, like agent card)
- Registered in `server.ts` before auth middleware
- Graceful degradation: 503 if node unreachable, 502 if node returns error

**Response format:**
```json
{
  "agents": [
    {
      "did": "did:agoramesh:base:0x...",
      "name": "Translator Agent",
      "score": 0.92,
      "skills": [...],
      "pricing": { "perTask": "0.03", "currency": "USDC" }
    }
  ],
  "total": 5,
  "source": "network"
}
```

### 2. Trust Query Endpoint on Bridge

**New endpoint (no auth required):**

```
GET /trust/:did
```

**Implementation:**
- New file: `bridge/src/trust-endpoint.ts` (Express router)
- Parallel fetch: `trustStore.getProfile(did)` + `fetch(nodeUrl/trust/{did})`
- Network fetch timeout: 3 seconds
- If DID unknown locally: `local: null`
- If P2P node unreachable: `network: null`
- If both null: 404

**Response format:**
```json
{
  "did": "did:key:z6Mk...",
  "local": {
    "tier": "familiar",
    "completions": 12,
    "failures": 1,
    "failureRate": 0.077,
    "firstSeen": "2026-01-15T...",
    "dailyLimit": 25,
    "outputLimit": 5000
  },
  "network": {
    "overall": 0.72,
    "reputation": 0.8,
    "stake": 0.6,
    "endorsement": 0.5
  }
}
```

### 3. Seed Demo Agents

**Script:** `bridge/scripts/seed-agents.ts`
**Fixture data:** `bridge/fixtures/seed-agents.json`

**5 agents with diverse roles:**

1. **translator-agent** — EN/CS/DE/ES translation, per-word pricing
2. **code-review-agent** — TypeScript/Python/Rust review, per-task pricing
3. **data-analyst-agent** — SQL/pandas analysis, per-task pricing
4. **copywriter-agent** — blog/landing/email, per-word pricing
5. **security-auditor-agent** — web/smart-contract audit, per-task pricing

Each agent has a realistic capability card with:
- Generated DID
- Skills array with tags for semantic search
- USDC pricing
- SLA metadata
- Valid (but fictional) endpoint URL

**Script flow:**
1. Load fixtures from JSON
2. For each agent: `POST {nodeUrl}/agents` with capability card
3. Log results (success/failure per agent)
4. Run via: `npx tsx scripts/seed-agents.ts`

### 4. Website Live vs. Roadmap Labels

**Content changes** in `agoramesh.ai/src/data/content.ts`:
- Add `status?: "live" | "beta" | "coming-soon"` field to section objects
- Discovery widget: update to use bridge discovery proxy endpoint
- SDK import examples: add note "Install from GitHub" or update to show curl

**Component changes** (Astro):
- Conditional suffix after section headings:
  - `coming-soon` → `<span class="text-sm text-neutral-400 ml-2">— coming soon</span>`
  - `beta` → `<span class="text-sm text-amber-400 ml-2">— beta</span>`
  - `live` or unset → no label
- Minimal CSS, no new component

**Sections to label:**
- Discovery layer in Solution: `"live"` (after proxy implementation)
- Trust layer in Solution: `"live"` (after endpoint implementation)
- SDK import in LiveTestnet: update install command
- Payment/escrow: `"live"` (already working on testnet)

## Testing Strategy (TDD)

Each item gets tests written BEFORE implementation:

1. **Discovery proxy:** HTTP tests with supertest — mock P2P node responses, test proxy behavior, 503 on node down, query param mapping
2. **Trust endpoint:** HTTP tests — mock TrustStore + P2P node, test parallel fetch, timeout, null cases, 404
3. **Seed script:** Unit tests for fixture loading, capability card validation
4. **Web labels:** Visual check (no automated tests for static labels)

## Research References

- A2A RC v1.0: HTTP proxy for discovery is recommended pattern
- ERC-8004: Trust scores should be queryable (on-chain + off-chain hybrid)
- AWS Cloudscape: Subtle text labels for beta/preview (not flashy badges)
- libp2p HTTP gateway spec: Proxy pattern for P2P access via HTTP
