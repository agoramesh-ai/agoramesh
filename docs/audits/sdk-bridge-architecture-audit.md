# SDK/Bridge Architecture, API Security & Cross-Component Coherence Audit

**Date:** 2026-04-05
**Auditor:** Polecat scavenger (automated security audit)
**Scope:** `sdk/src/`, `bridge/src/`, `mcp/src/`, Dockerfiles, docker-compose files, `.env.example` files, `package.json` dependencies
**Bead:** ag-rf1

---

## Executive Summary

The AgoraMesh TypeScript codebase demonstrates **strong security fundamentals** across the SDK, Bridge, and MCP components. The code shows intentional defense-in-depth: command injection prevention via `shell: false` with metacharacter blocking, comprehensive SSRF protection covering hex/octal/decimal IP bypass vectors, Ed25519 DID authentication with replay protection, and x402 payment validation with nonce-based anti-replay. Docker configurations follow best practices with non-root users, read-only filesystems, and `no-new-privileges`.

The primary areas of concern are **cross-component type coherence** (three independent error class hierarchies, duplicated type definitions, field naming mismatches between SDK and Node API), one **dependency version concern** (Express v4 in Bridge while SDK devDeps has v5), and several **medium-severity architectural issues** that could become security-relevant under adversarial conditions.

**Finding Summary:**

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 8 |
| LOW | 7 |
| INFO | 8 |

---

## 1. API Security

### 1.1 Input Validation

**Rating: STRONG**

The Bridge module implements thorough input validation using Zod schemas:

- `TaskInputSchema` (`bridge/src/types.ts:40-76`) validates all task inputs with:
  - `MAX_PROMPT_LENGTH = 100000` (100KB) to prevent DoS
  - `MAX_TASK_ID_LENGTH = 128` with regex `^[a-zA-Z0-9_-]+$` to prevent injection
  - `MAX_FILES_COUNT = 100` to prevent memory exhaustion
  - Timeout bounds: 1-3600 seconds
  - DID format validation regex
  - Numeric-only `escrowId` validation

- `SandboxInputSchema` (`bridge/src/types.ts:127-132`) has strict 500-char prompt limit

- Discovery proxy (`bridge/src/discovery-proxy.ts:14-21`) validates search inputs:
  - Query max 500 chars
  - Limit 1-100, offset >= 0
  - DID format validation via regex before passing to node

**[MEDIUM] M-1: MCP tools lack independent input validation beyond Zod schema basics**
- File: `mcp/src/tools/hire-agent.ts:13-18`
- MCP tool inputs use Zod for type validation but don't validate DID format or sanitize the `prompt` field before passing to `NodeClient.submitTask()`. The Bridge validates on receipt, but defense-in-depth suggests validating at the MCP layer too.
- Impact: Malformed DIDs or oversized prompts would be caught by the Bridge, but produce confusing error messages for MCP users.

**[LOW] L-1: No request Content-Type enforcement**
- File: `bridge/src/server.ts:281`
- The Express `json()` middleware will reject non-JSON bodies, but there's no explicit `Content-Type: application/json` requirement header check. Clients sending form-encoded data get a generic parse error.

### 1.2 Authentication & Authorization

**Rating: STRONG**

The Bridge implements a layered authentication model (`bridge/src/server.ts:338-387`):

1. **Static API token** — Bearer or x-api-key with `timingSafeEqual` comparison
2. **x402 payment** — ECDSA signature verification with nonce replay protection
3. **DID:key** — Ed25519 signature with 5-minute replay window
4. **FreeTier** — Simple identifier with rate limiting

**[MEDIUM] M-2: `safeCompare` reveals length information as a side channel**
- File: `bridge/src/server.ts:37-45`
- When buffer lengths differ, the function compares `bufA` with itself (`timingSafeEqual(bufA, bufA)`) to maintain constant time, then returns `false`. However, the length comparison itself (`bufA.length !== bufB.length`) is not constant-time, potentially leaking whether the submitted token has the correct length.
- Impact: An attacker could binary-search for the correct token length. Practical exploitation is unlikely given rate limiting, but the mitigation is simple: pad the shorter buffer to match the longer one before comparing.

**[LOW] L-2: MCP server uses hardcoded FreeTier auth to Bridge**
- File: `mcp/src/node-client.ts:48`
- `this.bridgeAuth = options?.bridgeAuth ?? 'FreeTier mcp-server'` — the MCP server authenticates to the Bridge using a hardcoded FreeTier identifier. This means MCP-proxied task submissions are subject to free-tier rate limits and cannot access paid-tier features.
- Impact: Functional limitation rather than security issue, but unexpected for operators who configure the MCP server expecting full access.

### 1.3 DID Authentication

**Rating: STRONG**

`bridge/src/did-auth.ts` implements Ed25519 DID:key verification correctly:

- Validates multicodec prefix (0xed01) and key length (34 bytes)
- Replay protection: 5-minute past window, 30-second future tolerance
- Signed message includes timestamp, HTTP method, and path
- Signature verification uses `@noble/curves/ed25519` (audited library)
- Parser handles colons in DIDs by parsing from the end

No issues found in the DID authentication implementation.

### 1.4 Command Injection Prevention

**Rating: STRONG**

`bridge/src/executor.ts` uses defense-in-depth:

- Primary defense: `shell: false` in `spawn()` call (line 174)
- Secondary defense: `DANGEROUS_SHELL_CHARS` regex blocks `;|&\`<>` (line 22)
- `stdin: 'ignore'` prevents interactive input attacks (line 176)
- Path traversal prevention via `resolve()` + workspace containment check (lines 64-88)
- URL-encoded path traversal handled via `decodeURIComponent()` (line 66)
- Output size limited to 10MB per stream (line 187)

**[MEDIUM] M-3: Shell metachar regex does not block newline characters**
- File: `bridge/src/executor.ts:22`
- The `DANGEROUS_SHELL_CHARS` regex `/[;|&\`<>]/` does not include `\n` or `\r`. While `shell: false` is the primary defense (making this moot for command injection), newlines in the prompt could potentially affect the behavior of the spawned `claude` process itself.
- Impact: Low — `shell: false` neutralizes the injection vector. This is a defense-in-depth gap.

### 1.5 SSRF Protection

**Rating: STRONG**

`sdk/src/discovery.ts:34-90` implements comprehensive SSRF protection:

- Blocks localhost, `.local`, `.localhost` domains
- Handles IPv6 loopback, private ranges (fc00::/7, fe80::/10), IPv4-mapped IPv6
- **Critically**: Handles numeric IP bypass vectors:
  - Hex IPs (`0x7f000001`)
  - Octal IPs (`0177.0.0.1`)
  - Decimal integer IPs (`2130706433`)
  - `0.0.0.0`
- Applied to: `setNodeUrl()`, `setIPFSGateway()`, `fetchFromWellKnown()`, `fetchFromIPFS()`, `isAgentAvailable()`
- CID validation prevents path traversal: `^[a-zA-Z0-9]+$` (line 552)

Bridge discovery proxy (`bridge/src/discovery-proxy.ts:39-47`) uses `new URL()` for path construction, preventing SSRF via path injection.

---

## 2. Cross-Component Coherence

### 2.1 Error Class Hierarchy

**[MEDIUM] M-4: Three incompatible error class hierarchies across components**

| Component | Class | Code Type | Error Codes |
|-----------|-------|-----------|-------------|
| SDK (`sdk/src/errors.ts`) | `AgoraMeshError` | `AgoraMeshErrorCode` enum | `AGORA_CLIENT_NOT_CONNECTED`, etc. |
| Bridge (`bridge/src/errors.ts`) | `AgoraMeshError` | Plain `string` | `ESCROW_NOT_FOUND`, etc. |
| Bridge server (`bridge/src/server.ts`) | `ErrorCode` enum | Enum | `VALIDATION_ERROR`, etc. |
| MCP (`mcp/src/node-client.ts`) | `NodeClientError` | HTTP status code `number` | N/A |

- The SDK's `AgoraMeshError` uses an enum (`AgoraMeshErrorCode`) with `AGORA_` prefixed codes and an optional `context` object.
- The Bridge's `AgoraMeshError` uses plain string codes (e.g., `'ESCROW_NOT_FOUND'`) and supports `cause` chaining.
- The Bridge server defines a separate `ErrorCode` enum for HTTP responses.
- The MCP uses `NodeClientError` with HTTP status codes.

**Impact:** Code that catches `AgoraMeshError` cannot reliably inspect error codes across component boundaries. The same class name with different interfaces creates confusion.

**Recommendation:** Unify error codes. The SDK's `AgoraMeshErrorCode` enum should be the single source of truth. Bridge should import and extend it rather than redefining.

### 2.2 Type Definitions

**[MEDIUM] M-5: MCP `node-client.ts` re-defines types locally instead of importing from SDK**
- File: `mcp/src/node-client.ts:16-39`
- `SearchOptions`, `TaskInput`, and `TaskResult` are defined locally with different field sets:
  - MCP `TaskInput.agentDid` (string) — not present in Bridge's `TaskInput`
  - MCP `TaskResult.duration` is optional — Bridge's is required
  - MCP `SearchOptions` has only `limit` and `minTrust` — SDK's has 6 fields
- Impact: Type drift will accumulate. If the Bridge adds a required field, the MCP won't enforce it at compile time.

**[MEDIUM] M-6: SDK `CapabilityCard.skills` vs Node API `capabilities` field naming**
- File: `sdk/src/types.ts:205` defines `skills: Skill[]`
- Node API returns `capabilities: Array<{id, name, description}>` (seen in `sdk/src/discovery.ts:279`, `bridge/src/discovery-proxy.ts` responses)
- The SDK discovery client translates between these (line 313: `item.card.capabilities ?? []`), but the naming mismatch means:
  - SDK types say `skills`
  - Node API says `capabilities`
  - A2A spec uses `skills`
- Impact: Confusion for developers working across components. The translation layer works but isn't documented.

### 2.3 Bridge imports from SDK

**Rating: GOOD**

`bridge/src/types.ts:3-9` correctly imports core types from `@agoramesh/sdk`:
```typescript
import type { Skill, CapabilityCard, PaymentConfig, Authentication, Provider } from '@agoramesh/sdk';
```

The Bridge extends these with Zod validation schemas and additional bridge-specific types. This is the correct pattern — the SDK is the type authority, and the Bridge adds runtime validation.

### 2.4 SDK ↔ Node API Consistency

The SDK's `DiscoveryClient.search()` (`sdk/src/discovery.ts:213-326`) correctly translates between the Node API response format and the SDK's `DiscoveryResult` type. The `TrustClient.getTrustFromNode()` (`sdk/src/trust.ts:224-254`) maps the Node's snake_case fields (`stake_score`, `endorsement_score`) to SDK's camelCase.

**[LOW] L-3: SDK discovery uses `fetch` without timeout**
- File: `sdk/src/discovery.ts:250-258`
- The `search()` method uses bare `fetch()` without `AbortSignal.timeout()`. If the node is unresponsive, the request will hang indefinitely.
- MCP's `NodeClient` correctly uses `AbortSignal.timeout(5000)` (line 144).
- Impact: SDK users may experience hanging requests. Not a security issue but an availability concern.

### 2.5 Bridge ↔ MCP Consistency

The MCP server communicates with both the Node (for discovery/trust) and the Bridge (for task submission). `mcp/src/node-client.ts` correctly:
- Routes search queries to `/agents/semantic` on the Node
- Routes task submissions to `/task?wait=true` on the Bridge
- Handles the response envelope unwrapping (`{ agents: [...] }` or direct array)

**[LOW] L-4: MCP `submitTask` doesn't map all Bridge task fields**
- File: `mcp/src/node-client.ts:90-116`
- The `submitTask` method only sends `agentDid`, `prompt`, `type`, and `timeout`. It doesn't support `context`, `escrowId`, or `clientDid` fields that the Bridge accepts.
- Impact: MCP users cannot use escrow-backed tasks or provide file context.

---

## 3. Dependency Security

### 3.1 SDK Dependencies (`sdk/package.json`)

| Package | Version | Assessment |
|---------|---------|------------|
| `viem` | `^2.21.0` | Actively maintained. No known CVEs for v2.x. |
| `@coinbase/x402` | `^2.1.0` | Relatively new package from Coinbase. No known CVEs. |

SDK has minimal dependencies — good attack surface.

### 3.2 Bridge Dependencies (`bridge/package.json`)

**[HIGH] H-1: Express v4 in production while v5 is available**
- File: `bridge/package.json:24`
- `"express": "^4.18.0"` — Express 4.x has had multiple prototype pollution and path traversal advisories. Express 5.x (stable since late 2025) addresses these.
- The SDK's devDependencies already reference `"express": "^5.2.1"`.
- Impact: Known vulnerability surface. Recommend upgrading to Express 5.x.

| Package | Version | Assessment |
|---------|---------|------------|
| `express` | `^4.18.0` | **Upgrade recommended** — v5.x available |
| `helmet` | `^8.1.0` | Current, good security headers |
| `ws` | `^8.16.0` | Stable, no known issues |
| `viem` | `^2.45.1` | Current |
| `zod` | `^3.23.0` | Current |
| `cors` | `^2.8.6` | Current |
| `express-rate-limit` | `^8.2.1` | Current |
| `multiformats` | `^13.4.2` | Current |
| `@anthropic-ai/sdk` | `^0.72.1` | Current |
| `dotenv` | `^16.4.0` | Current |

**[LOW] L-5: Bridge `@noble/curves` (used in `did-auth.ts`) is a transitive dependency**
- The Bridge imports `@noble/curves/ed25519` for DID authentication but doesn't pin it as a direct dependency. Version is controlled by whatever brings it in transitively.
- Recommend adding as a direct dependency to ensure version control.

### 3.3 MCP Dependencies (`mcp/package.json`)

**[HIGH] H-2: `@vitest/coverage-v8` listed as production dependency**
- File: `mcp/package.json:25`
- `"@vitest/coverage-v8": "^4.0.18"` is in `dependencies` instead of `devDependencies`. This packages test instrumentation code into the production Docker image.
- Impact: Increases attack surface and image size. Move to `devDependencies`.

| Package | Version | Assessment |
|---------|---------|------------|
| `@modelcontextprotocol/sdk` | `^1.27.1` | Current |
| `zod` | `^3.23.0` | Current |
| `@vitest/coverage-v8` | `^4.0.18` | **Move to devDependencies** |

---

## 4. Docker Security

### 4.1 Dockerfiles

**Rating: EXCELLENT**

All three Dockerfiles follow security best practices:

| Practice | Bridge | MCP | Node |
|----------|--------|-----|------|
| Multi-stage build | Yes | Yes | Yes |
| Non-root user | Yes (1001) | Yes (1001) | Yes (1001) |
| Alpine/slim base | Alpine 3.21 | Alpine 3.21 | Debian slim |
| Health check | Yes | Yes | Yes |
| `npm prune --omit=dev` | Yes | Yes | N/A (Rust) |
| Init system (tini) | No | No | Yes |

**[LOW] L-6: Bridge and MCP Dockerfiles don't use an init system**
- Files: `bridge/Dockerfile`, `mcp/Dockerfile`
- The Node Dockerfile correctly uses `tini` as PID 1 for proper signal handling. Bridge and MCP use `CMD ["node", ...]` directly, which means Node.js is PID 1 and may not properly forward signals to child processes.
- Impact: The Bridge spawns `claude` child processes — without tini, orphaned processes may not be cleaned up properly on container shutdown.

**[INFO] I-1: Node Dockerfile uses `rust:latest` for build stage**
- File: `node/Dockerfile:10`
- Using `latest` tag means builds aren't reproducible. Consider pinning to a specific Rust version.

### 4.2 Production Docker Compose

**Rating: EXCELLENT**

`deploy/production/docker-compose.yml` demonstrates strong security hardening:

- `security_opt: [no-new-privileges:true]` — prevents privilege escalation
- `read_only: true` — immutable filesystem
- `tmpfs: [/tmp:noexec,nosuid,size=100m]` — writable tmp with restrictions
- `user: "1000:1000"` — non-root
- `mem_limit` set for all services (2g, 1g, 256m)
- Ports bound to `127.0.0.1` only — not exposed to public network
- Secrets passed via environment variable references (`${BRIDGE_API_TOKEN}`)

**[MEDIUM] M-7: Inter-service communication uses plain HTTP**
- File: `deploy/production/docker-compose.yml:59,84`
- Services communicate via `http://node:8080` and `http://bridge:3402` within the Docker network. While Docker networks provide isolation, the lack of TLS means:
  - No encryption of API tokens in transit between containers
  - No mutual authentication between services
  - A compromised container could sniff traffic
- Impact: Medium in a shared-host environment. Consider adding TLS or a service mesh for production deployments with sensitive data.

**[HIGH] H-3: Bridge AGENT_PRIVATE_KEY passed as environment variable**
- File: `deploy/production/docker-compose.yml:61`
- `AGENT_PRIVATE_KEY=${BRIDGE_AGENT_PRIVATE_KEY}` — Ethereum private keys in environment variables are visible via `docker inspect`, `/proc/*/environ`, and orchestrator APIs.
- Impact: Private key exposure could lead to fund theft. Recommend using Docker secrets, a vault service, or mounted key files.

---

## 5. Secret Management

### 5.1 `.env.example` Files

**Rating: GOOD with caveats**

| File | Assessment |
|------|------------|
| `.env.example` (root) | Placeholder values like `dev-token-change-me`. Good. |
| `bridge/.env.example` | `AGENT_PRIVATE_KEY=0x...` placeholder. Good. |
| `contracts/.env.example` | `DEPLOYER_PRIVATE_KEY=0x...` placeholder. Good. |
| `deploy/production/.env.example` | `0x_REPLACE_WITH_REAL_PRIVATE_KEY` placeholder. Good. |
| `mcp/.env.example` | No secrets. Clean. |

**[MEDIUM] M-8: Root `.env.example` contains weak default tokens**
- File: `.env.example:8,22`
- `AGORAMESH_API_TOKEN=dev-token-change-me` and `BRIDGE_API_TOKEN=dev-bridge-token` are weak but clearly marked as development values. However, operators who copy `.env.example` to `.env` without changes will have guessable tokens.
- Impact: Low in development, medium if accidentally deployed to production.

### 5.2 `.gitignore` Coverage

**Rating: GOOD**

`.gitignore` correctly excludes:
- `**/.env`
- `**/.env.local`
- `**/.env.test`
- `**/.env.*.local`

And includes `!.env.example` — correct pattern.

### 5.3 In-Code Secret Handling

**[LOW] L-7: Bridge trust store falls back to `/tmp` if HOME is unset**
- File: `bridge/src/server.ts:245`
- `const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';`
- If both `HOME` and `USERPROFILE` are unset (possible in minimal container environments), the trust store writes to `/tmp/.agoramesh/trust-store.json`, which is world-readable.
- Impact: Trust data could be read or modified by other processes. The production Docker setup uses `read_only: true` which mitigates this, but the code should not default to `/tmp`.

---

## 6. Payment Security

### 6.1 x402 Payment Middleware

**Rating: STRONG**

`bridge/src/middleware/x402.ts` implements the x402 protocol correctly:

- **Signature verification**: Uses `recoverMessageAddress` from viem for ECDSA recovery (line 206)
- **Replay protection**: Nonce-based with in-memory store, nonce recorded before async validation (line 369) to prevent race conditions
- **Amount validation**: Uses `BigInt` comparison (line 243) — correct for financial amounts
- **Expiration**: Configurable validity period with timestamp check (line 255)
- **Nonce store bounded**: Max 100,000 entries with periodic cleanup (lines 354, 29-36)

**[INFO] I-2: Nonce store is in-memory — doesn't survive restarts**
- File: `bridge/src/middleware/x402.ts:17`
- The `usedNonces` Map is in-memory. After a Bridge restart, all previous nonces are lost, allowing replay of payments made before the restart (within the validity window).
- Impact: Low — the validity window is 5 minutes, so the window for replay after restart is small.

### 6.2 Escrow Integration

The SDK's `PaymentClient` (`sdk/src/payment.ts`) and Bridge's `EscrowClient` (`bridge/src/escrow.ts`) both correctly:
- Use `BigInt` for all amount calculations (no floating-point precision issues)
- Validate escrow state before operations
- Parse USDC amounts with proper decimal handling (`parseUSDC`/`formatUSDC`)

**[INFO] I-3: SDK `TrustClient.calculateEscrowRequirement` uses step-function thresholds**
- File: `sdk/src/trust.ts:738-759`
- Trust score thresholds for escrow requirements use hard boundaries (>0.9, >0.7, >0.5) which could be gamed by an agent with a trust score of 0.901 vs 0.899 getting 0% vs 20% escrow.
- Impact: Design decision, not a bug. Consider smooth interpolation for production.

---

## 7. Additional Findings

### 7.1 Graceful Shutdown

**[INFO] I-4: Bridge implements graceful shutdown correctly**
- File: `bridge/src/graceful-shutdown.ts`
- Tracks active tasks, cancels on shutdown with configurable timeout. Properly integrated in `server.ts` constructor and task lifecycle.

### 7.2 Rate Limiting

**[INFO] I-5: Multi-layer rate limiting**
- Global rate limiting via `express-rate-limit` (configurable, default 100 req/min)
- Per-DID rate limiting via `FreeTierLimiter` (10 requests/day per DID, 20 per IP)
- Sandbox rate limiting (3 requests/hour per IP)
- Trust-based dynamic limits via `TrustStore`

### 7.3 WebSocket Security

**[INFO] I-6: WebSocket connections properly secured**
- Origin validation (configurable `allowedOrigins`)
- Auth token verification with `timingSafeEqual`
- Max payload size: 1 MiB
- Heartbeat ping/pong every 30 seconds to detect stale connections
- Max 100 concurrent connections

### 7.4 SDK Utility Security

**[INFO] I-7: SDK `utils.ts` uses proper USDC decimal handling**
- `parseUSDC()` and `formatUSDC()` correctly handle 6-decimal USDC amounts using `BigInt` arithmetic, avoiding floating-point precision issues.

### 7.5 A2A Protocol

**[INFO] I-8: A2A JSON-RPC 2.0 implementation**
- `bridge/src/a2a.ts` implements the A2A protocol correctly with proper JSON-RPC error codes, method routing, and capability card generation. Both `/` and `/a2a` endpoints are supported for backward compatibility.

---

## Recommendations (Priority Order)

### Immediate (before mainnet)

1. **[H-1]** Upgrade Bridge Express from v4 to v5 (`bridge/package.json`)
2. **[H-2]** Move `@vitest/coverage-v8` to devDependencies (`mcp/package.json`)
3. **[H-3]** Use Docker secrets or vault for private keys instead of environment variables

### Short-term

4. **[M-4]** Unify error class hierarchy — SDK `AgoraMeshErrorCode` should be the single source of truth
5. **[M-5]** MCP should import types from SDK or share a common types package
6. **[M-7]** Add TLS for inter-service communication in production
7. **[M-8]** Add validation/warning when default tokens are detected in production mode
8. **[M-2]** Fix `safeCompare` to pad shorter buffer instead of revealing length mismatch

### Medium-term

9. **[M-6]** Resolve `skills` vs `capabilities` naming across SDK and Node API
10. **[M-1]** Add DID format validation to MCP tool inputs
11. **[M-3]** Add newline blocking to executor metachar regex (defense-in-depth)
12. **[L-6]** Add `tini` to Bridge and MCP Dockerfiles for proper signal handling
13. **[L-3]** Add fetch timeouts to SDK discovery client
14. **[L-7]** Don't fall back to `/tmp` for trust store — fail explicitly if HOME is unset

---

## Methodology

This audit was conducted by reading all TypeScript source files in `sdk/src/`, `bridge/src/`, and `mcp/src/`, reviewing all `package.json` files for dependency versions, examining Dockerfiles and docker-compose configurations, and checking `.env.example` files for secret management practices. Cross-component coherence was verified by comparing type definitions, error handling patterns, and API interfaces across all three components. Dependency security was checked against known CVE databases.

Files reviewed: 57 TypeScript source files, 3 `package.json` files, 3 Dockerfiles, 5 docker-compose files, 5 `.env.example` files, 1 `.gitignore`.
