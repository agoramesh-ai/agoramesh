# Design: Agent UX Improvements — HTTP Polling, Simple Auth, Documentation

**Date:** 2026-02-23
**Status:** Approved
**Context:** Feedback from real AI agent testing revealed 5 problems preventing autonomous agent access.

---

## Problem Summary

An AI agent tested the bridge end-to-end and found:

1. **P0:** Task results only available via WebSocket — HTTP-only agents can't get results
2. **P1:** DID:key auth requires ~30 lines of Ed25519 crypto — too complex for most agents
3. **P1:** Documentation contradicts itself (website, llms.txt, error responses show different auth methods)
4. **P2:** No llms.txt file exists
5. **P2:** Agent card is declarative ("what's supported") but not instructive ("how to use it")

## Solutions

### 1. Task Result Store + HTTP Polling (P0)

**New:** `completedTasks: Map<string, TaskResult>` with 1-hour TTL.

**POST /task** changes:
- Returns `202 Accepted` (was 200)
- Adds `Location: /task/{id}` header
- Adds `Retry-After: 5` header
- New query param `?wait=true` — blocks until result (60s timeout), returns result directly

**GET /task/:id** changes:
- While running: `200 {"status":"running","taskId":"..."}`
- Completed: `200 {"status":"completed","taskId":"...","output":"...","duration":1234}`
- Failed: `200 {"status":"failed","taskId":"...","error":"...","duration":1234}`
- Expired/unknown: `404`
- Auth: same middleware as POST (FreeTier/DID/Bearer all work)
- Owner check: `clientDid` from auth identity matches task creator

### 2. FreeTier Simple Auth (P1)

**New auth scheme:** `Authorization: FreeTier <agent-identifier>`

- Zero crypto. Agent picks any opaque string as identifier.
- Rate limited: per-identifier 10/day + per-IP 20/day (same as DID:key NEW tier)
- Output capped at 2000 chars
- Progressive trust works on identifier (same TrustStore)
- DID:key remains for agents wanting stronger identity

**Auth middleware chain:** Bearer → x402 → DID:key → FreeTier → 401

### 3. Agent Card Auth Instructions (P2)

Add `authentication.instructions` with per-scheme machine-readable details:
- `freeTier`: header format, limits, example
- `did:key`: header format, signature payload, key type
- `bearer`: header format, note

### 4. llms.txt (P2)

Serve `GET /llms.txt` with the complete "4 curl commands" quick start.
Follow llmstxt.org spec: H1, blockquote summary, sections with links.

### 5. Documentation Consistency (P1)

All docs show same priority: FreeTier → DID:key → Bearer → x402.
All docs include the same "4 curl commands" quick start.

---

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `bridge/src/server.ts` | MODIFY | Task result store, polling endpoint, sync mode, FreeTier auth, llms.txt route |
| `bridge/src/types.ts` | MODIFY | Add FreeTierIdentity type, task result TTL constant |
| `bridge/src/free-tier-limiter.ts` | MODIFY | Support FreeTier identifiers alongside DIDs |
| `bridge/agent-card.config.json` | MODIFY | Add authentication.instructions, freeTier scheme |
| `bridge/src/config.ts` | MODIFY | Add AuthInstructionsSchema |
| `docs/specs/bridge-protocol.md` | MODIFY | Add polling section, FreeTier auth, llms.txt |
| `docs/tutorials/getting-started.md` | MODIFY | FreeTier quick start, polling example |
| `docs/tutorials/running-local-agent.md` | MODIFY | FreeTier auth option |
| `bridge/README.md` | MODIFY | FreeTier section, polling |
| `docs/reference/faq.md` | MODIFY | FreeTier FAQ entries |
| Website content.ts + content.cs.ts | MODIFY | FreeTier messaging |

## New Test Files

| File | Tests |
|------|-------|
| `bridge/test/task-polling.test.ts` | ~15 tests: result store, GET polling, sync mode, TTL cleanup, auth check |
| `bridge/test/freetier-auth.test.ts` | ~12 tests: FreeTier header parsing, rate limiting, progressive trust, auth chain |
