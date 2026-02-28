# AgoraMesh Security Audit Report
**Date:** 2026-02-28
**Scope:** Smart contracts, Bridge, MCP, Infrastructure
**Status:** Findings documented, fixes pending

## Summary

| Severity | Contracts | Bridge/MCP/Infra | Total |
|----------|-----------|-------------------|-------|
| CRITICAL | 0 | 4 | 4 |
| HIGH | 3 | 6 | 9 |
| MEDIUM | 8 | 5 | 13 |
| LOW | 8 | 7 | 15 |
| **Total** | **19** | **22** | **41** |

## Critical Findings (Bridge/MCP/Infra)

### C-1: Hardcoded Anvil Private Key in Production .env
- **File:** `deploy/production/.env`
- **Risk:** Anyone can impersonate bridge agent, steal escrow funds
- **Fix:** Remove .env from repo, use GitHub Secrets, rotate all tokens

### C-2: SSRF via Unvalidated DID in Discovery Proxy
- **File:** `bridge/src/discovery-proxy.ts:70,95,141`
- **Risk:** Internal service access via crafted DID path traversal
- **Fix:** Validate DID format with regex before URL construction

### C-3: Unbounded In-Memory Maps (DoS)
- **Files:** `bridge/src/server.ts:204-210`, `trust-store.ts`, `free-tier-limiter.ts`
- **Risk:** Memory exhaustion → OOM kill → complete bridge DoS
- **Fix:** Add LRU eviction and max size limits to all Maps

### C-4: MCP Server Has No Authentication
- **File:** `mcp/src/http-handler.ts`
- **Risk:** Unauthorized task execution, free tier abuse
- **Fix:** Add API token authentication

## High Findings

### Contracts
- **H-01:** Escrow AWAITING_DEPOSIT has no cancel — records stuck forever
- **H-02:** DELIVERED state griefing (forced 24h delay)
- **H-03:** Double fee deduction on dispute splits (2x MIN_FEE)

### Bridge/MCP
- **H-1:** WebSocket tasks bypass owner authorization
- **H-2:** WebSocket clientDid always 'anonymous'
- **H-3:** A2A handler skips Zod validation (prompt length unchecked)
- **H-4:** Trust store prototype pollution via DID keys
- **H-5:** CORS wildcard `*` in MCP server
- **H-6:** No request body size limit on MCP HTTP

## Medium Findings

### Contracts
- **M-01:** Deterministic arbiter selection (admin collusion vector)
- **M-02:** deactivateAgent doesn't clear owner mapping (re-registration blocked)
- **M-03:** Unbounded CID/message string storage griefing
- **M-04:** Fee pool not distributed to arbiters (rug risk)
- **M-05:** `appeal` and `createDispute` missing nonReentrant
- **M-06:** `this.checkAutoResolution` unnecessary external call
- **M-07:** Volume divisor 10,000x inconsistency (TrustRegistry vs NFTBoundReputation)
- **M-08:** StreamingPayments pause/resume missing nonReentrant

### Bridge/MCP
- **M-1:** Missing CSP and cross-origin headers in nginx
- **M-2:** MCP session map unbounded growth
- **M-3:** Race condition in sync mode task resolution
- **M-4:** Docker containers run as root
- **M-5:** CI dependency audit uses continue-on-error

## Remediation Priority

### Week 1 (Critical)
1. Rotate production credentials (C-1)
2. Add DID validation to discovery proxy (C-2)
3. Add Map size limits with LRU eviction (C-3)
4. Add MCP authentication (C-4)
5. Fix WebSocket owner auth (H-1)
6. Add MCP body size limit (H-6)

### Week 2 (High)
7. Add abandonEscrow function (H-01)
8. Fix double fee deduction (H-03)
9. Fix WebSocket identity (H-2)
10. Add A2A Zod validation (H-3)
11. Fix trust store prototype pollution (H-4)
12. Fix CORS wildcard (H-5)

### Week 3 (Medium)
13. Add nonReentrant to appeal/createDispute (M-05)
14. Fix volume divisor inconsistency (M-07)
15. Add arbiter reward distribution (M-04)
16. Run containers as non-root (M-4)
17. Add CID/message length limits (M-03)

## Positive Observations
- SafeERC20 used consistently across all contracts
- ReentrancyGuard on all primary fund-moving functions
- shell: false in executor (primary command injection defense)
- Zod input validation on REST endpoints
- Timing-safe token comparison
- DID signature verification with replay protection
- Docker ports bound to localhost only
- Gitleaks and CodeQL in CI pipeline
