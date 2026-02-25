# Agent UX Round 3 — Design Document

**Date:** 2026-02-24
**Status:** Approved
**Approach:** 1A, 2A, 3A, 4A

## Context

Third round of agent feedback. The bridge is now functional (FreeTier auth, HTTP polling, sync mode), but four issues remain.

## Changes

### 1. llms.txt — Reference Format (1A)

**Problem:** Current llms.txt is tutorial-style (numbered steps). Agents need a machine-readable reference with explicit endpoints and copy-paste example.

**Change:** Rewrite `buildLlmsTxt()` in `server.ts` to output reference format:

```
# AgoraMesh Bridge
> AI coding agent. Submit tasks via HTTP, get results. Free tier — no signup.

## Endpoints
- Health: GET {baseUrl}/health
- Agent card: GET {baseUrl}/.well-known/agent.json
- Submit task: POST {baseUrl}/task
- Submit task (sync): POST {baseUrl}/task?wait=true
- Poll result: GET {baseUrl}/task/{taskId}
- A2A JSON-RPC: POST {baseUrl}/a2a

## Authentication (simplest first)
FreeTier: Authorization: FreeTier <your-agent-id>
  - No signup, 10 tasks/day, 2000 char output cap
DID:key: Authorization: DID <did>:<timestamp>:<signature>
Bearer: Authorization: Bearer <token>

## Minimal Example
curl -X POST "{baseUrl}/task?wait=true" \
  -H "Authorization: FreeTier my-agent" \
  -H "Content-Type: application/json" \
  -d '{"type":"prompt","prompt":"Write fibonacci in Python"}'
```

Key differences from current:
- No numbered steps, just flat reference
- Explicit endpoint list with HTTP methods
- `clientDid` removed from example (see change 4)
- `taskId` removed from example (auto-generated, see change 4)
- No links to GitHub docs (agent can't always access them)
- No marketing language

**Files:** `bridge/src/server.ts` (buildLlmsTxt method)

### 2. A2A Discoverability (2A)

**Problem:** `/.well-known/a2a.json` returns 404. Agents expect it as A2A discovery endpoint. Also, method names aren't documented anywhere machine-readable.

**Changes:**

a) Add `/.well-known/a2a.json` route as alias for agent card (same handler as `/.well-known/agent.json`).

b) Add `a2a` section to agent card config with supported methods:
```json
{
  "a2a": {
    "endpoint": "/a2a",
    "methods": ["message/send", "tasks/get", "tasks/cancel"]
  }
}
```

c) Include A2A in llms.txt endpoints list.

**Files:** `bridge/src/server.ts` (route + buildCapabilityCard), `bridge/agent-card.config.json`

### 3. Mock Executor Fallback (3A)

**Problem:** `spawn('claude')` fails with ENOENT in production Docker. Every task fails.

**Change:** Add automatic fallback in `ClaudeExecutor.execute()`:

1. On construction, detect if `claude` CLI is available (sync `which claude` or try spawn).
2. Store `this.mockMode: boolean`.
3. If mockMode, `execute()` returns a mock response:
   ```json
   {
     "taskId": "...",
     "status": "completed",
     "output": "# Mock Response\n\nThe bridge is running in demo mode...\n\n```python\ndef fibonacci(n):\n    ...\n```",
     "duration": 500,
     "mock": true
   }
   ```
4. Mock responses are prompt-aware — echo back what was asked, provide a plausible skeleton.
5. Log `[Bridge] Running in mock mode (claude CLI not found)` on startup.

Simple implementation: no AI, just template responses that reflect the prompt.

**Files:** `bridge/src/executor.ts`

### 4. clientDid Optional with Auto-fill (4A)

**Problem:** `clientDid` is required but redundant for FreeTier — the identifier is already in the auth header.

**Changes:**

a) Make `clientDid` optional in `TaskInputSchema`:
```typescript
clientDid: z.string().min(1).max(256)
  .regex(/^(did:[a-z]+:[a-zA-Z0-9._:-]+|[a-zA-Z0-9._-]+)$/, '...')
  .optional(),
```

b) In POST `/task` handler, auto-fill from auth identity if missing:
```typescript
if (!task.clientDid) {
  const identity = (req as DIDRequest).didIdentity;
  task.clientDid = identity?.did || 'anonymous';
}
```

c) Also make `taskId` optional and auto-generate if missing:
```typescript
taskId: z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, '...')
  .optional(),
```
Auto-generate: `task-${Date.now()}-${randomBytes(4).toString('hex')}`

This simplifies the minimal request body to just `{"type":"prompt","prompt":"..."}`.

**Files:** `bridge/src/types.ts`, `bridge/src/server.ts`

## Testing

- Update `bridge/test/llms-txt.test.ts` for new format
- Add `/.well-known/a2a.json` test
- Add mock executor tests
- Update task submission tests for optional clientDid/taskId
- All existing tests must continue to pass (clientDid/taskId still accepted when provided)

## Non-goals

- A2A streaming (`tasks/sendSubscribe`) — not needed now
- Real AI mock responses — simple templates are sufficient
- Breaking changes to existing API — all fields remain accepted
