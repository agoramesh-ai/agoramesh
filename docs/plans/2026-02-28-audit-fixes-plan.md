# AgoraMesh Audit Fixes Plan
**Date:** 2026-02-28
**Status:** In Progress

## Overview
Fix 30+ issues found during comprehensive audit. Organized into parallel workstreams.

## Workstream 1: Security & Infrastructure
**Priority:** CRITICAL | **Repo:** agoramesh (deploy/)

- [ ] Fix nginx security headers (HSTS, X-Frame-Options, CSP, X-Content-Type-Options)
- [ ] Add HTTPS redirect (80→443)
- [ ] Fix MCP server JSON.parse error handling (try-catch + proper JSON-RPC error response)
- [ ] Add environment variable validation on startup (bridge + MCP)
- [ ] Remove hardcoded Supabase JWT from Waitlist.astro (use env var or server-side proxy)

## Workstream 2: Smart Contracts
**Priority:** HIGH | **Repo:** agoramesh (contracts/)

- [ ] Add metadata size limits to VerifiedNamespaces.sol (max 1KB per value)
- [ ] Add endorsement cooldown to TrustRegistry.sol (1 per 24h per pair)
- [ ] Add StateChanged events to AgoraMeshEscrow.sol
- [ ] Increase TieredDisputeResolution test coverage from 51% to 85%+
- [ ] Fix ERC8004Bridge submitFeedback/submitValidation stubs
- [ ] Add arbiter selection randomness improvement (pseudo-random until VRF available)

## Workstream 3: Bridge & Node (TypeScript)
**Priority:** HIGH | **Repo:** agoramesh (bridge/, mcp/)

- [ ] Add escrow retry logic with exponential backoff (max 5 attempts)
- [ ] Make rate limiting persistent (file-based store instead of in-memory Map)
- [ ] Add A2A protocol methods: agent/describe, agent/status
- [ ] Implement graceful shutdown with task draining (30s timeout)
- [ ] Fix MCP HTTP handler error handling

## Workstream 4: Website
**Priority:** MEDIUM | **Repo:** agoramesh.ai

- [ ] Fix accessibility labels on form inputs (Waitlist, TryItWidget)
- [ ] Update pricing model documentation (per_unit → per_token, add custom)
- [ ] Fix Czech localization completeness
- [ ] Remove hardcoded Supabase JWT from frontend

## Workstream 5: SDK
**Priority:** MEDIUM | **Repo:** agoramesh (sdk/)

- [ ] Add tests for payment module
- [ ] Add tests for streaming module
- [ ] Add tests for x402 module
- [ ] Fix package.json repository field (add directory: "sdk")
- [ ] Update README installation instructions

## Workstream 6: Documentation
**Priority:** MEDIUM | **Repo:** agoramesh (docs/)

- [ ] Fix capability-card.md pricing models (per_unit → per_token)
- [ ] Fix payment-layer.md typo (AP2 → A2A)
- [ ] Update quickstart-agents.md (remove "Coming soon" for working API)
- [ ] Add warning about LayerZero cross-chain being non-functional
- [ ] Document all environment variables with examples

## Out of Scope (requires human/external action)
- Publish SDK to npm (needs npm credentials)
- Fix DNS for *.demo.agoramesh.ai (needs DNS provider)
- Rotate production credentials (needs human decision)
- LayerZero full implementation (needs external dependency + audit)
- Chainlink VRF integration (needs oracle subscription)
- Rust unwrap() refactoring (546 instances, needs dedicated sprint)
- Mainnet deployment (needs real funds + audit)

## Approach
- TDD: Write tests first, then implementation
- Research 2025-2026 best practices before implementing
- Parallel agent teams per workstream
- Self-test after each fix
