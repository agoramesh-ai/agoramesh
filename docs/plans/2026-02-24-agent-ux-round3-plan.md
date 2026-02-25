# Agent UX Round 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 4 remaining agent UX issues: reference-format llms.txt, A2A discoverability, mock executor fallback, and optional clientDid/taskId.

**Architecture:** All changes are in the bridge module. Tasks 1 and 4 are independent and can run in parallel. Task 2 depends on Task 1 (llms.txt includes A2A endpoint). Task 3 is independent.

**Tech Stack:** TypeScript, Vitest, Express, Zod

---

### Task 1: Make clientDid and taskId Optional with Auto-fill

**Files:**
- Modify: `bridge/src/types.ts:40-72`
- Modify: `bridge/src/server.ts:669-695`
- Test: `bridge/test/server.test.ts`
- Test: `bridge/test/task-polling.test.ts`

**Step 1: Write failing tests for optional fields**

Add to `bridge/test/task-polling.test.ts` (inside the existing describe block, after existing tests):

```typescript
describe('optional taskId and clientDid', () => {
  it('accepts task without taskId and auto-generates one', async () => {
    const res = await request(app)
      .post('/task')
      .send({
        type: 'prompt',
        prompt: 'Write hello world',
      });

    expect(res.status).toBe(202);
    expect(res.body.taskId).toBeDefined();
    expect(res.body.taskId).toMatch(/^task-\d+-[a-f0-9]+$/);
  });

  it('accepts task without clientDid and uses auth identity', async () => {
    const res = await request(app)
      .post('/task')
      .send({
        type: 'prompt',
        prompt: 'Write hello world',
        taskId: 'no-client-did-test',
      });

    expect(res.status).toBe(202);
  });

  it('still accepts task with explicit taskId and clientDid', async () => {
    const res = await request(app)
      .post('/task')
      .send({
        taskId: 'explicit-id',
        type: 'prompt',
        prompt: 'Write hello world',
        clientDid: 'did:test:explicit',
      });

    expect(res.status).toBe(202);
    expect(res.body.taskId).toBe('explicit-id');
  });

  it('auto-generates unique taskIds for concurrent tasks', async () => {
    const [res1, res2] = await Promise.all([
      request(app).post('/task').send({ type: 'prompt', prompt: 'Task 1' }),
      request(app).post('/task').send({ type: 'prompt', prompt: 'Task 2' }),
    ]);

    expect(res1.body.taskId).not.toBe(res2.body.taskId);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/task-polling.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — Zod validation requires taskId and clientDid

**Step 3: Make fields optional in schema**

In `bridge/src/types.ts`, change lines 41-48 and 70:

```typescript
// taskId: make optional, will be auto-generated if not provided
taskId: z
  .string()
  .min(1, 'taskId must not be empty')
  .max(MAX_TASK_ID_LENGTH, `taskId must be at most ${MAX_TASK_ID_LENGTH} characters`)
  .regex(
    TASK_ID_PATTERN,
    'taskId must contain only alphanumeric characters, dashes, and underscores'
  )
  .optional(),

// ... (type, prompt, context, timeout stay the same) ...

// clientDid: make optional, will be auto-filled from auth identity
clientDid: z.string().min(1).max(256).regex(
  /^(did:[a-z]+:[a-zA-Z0-9._:-]+|[a-zA-Z0-9._-]+)$/,
  'Invalid client identifier format (DID or FreeTier identifier)'
).optional(),
```

**Step 4: Auto-fill in server POST /task handler**

In `bridge/src/server.ts`, after `const task = TaskInputSchema.parse(req.body);` (line 671), add auto-fill logic:

```typescript
const task = TaskInputSchema.parse(req.body);

// Auto-generate taskId if not provided
if (!task.taskId) {
  const { randomBytes } = await import('crypto');
  task.taskId = `task-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

// Auto-fill clientDid from auth identity if not provided
if (!task.clientDid) {
  const identity = (req as DIDRequest).didIdentity;
  task.clientDid = identity?.did || 'anonymous';
}
```

Note: `randomBytes` is already imported at the top as `timingSafeEqual` from `'crypto'`. Add `randomBytes` to that import.

Also update the TaskInput type usage — since taskId and clientDid are now optional in the Zod schema, but we fill them in before use, we need to ensure the rest of the code gets a non-optional version. The simplest approach: define `taskId!` and `clientDid!` after auto-fill, or cast to a type with required fields. Actually, since we mutate `task` before use, the runtime values will be present. TypeScript might complain in places that access `task.taskId` or `task.clientDid`. To handle this cleanly, add a `ResolvedTaskInput` type:

```typescript
// In types.ts, after TaskInput:
export type ResolvedTaskInput = TaskInput & { taskId: string; clientDid: string };
```

Or simpler: use non-null assertion at the auto-fill site and keep the downstream code unchanged.

**Step 5: Run tests to verify they pass**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/task-polling.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 6: Fix any broken existing tests**

Existing tests that send `clientDid` and `taskId` should still pass since these fields are still accepted. Run full test suite:

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run --reporter=verbose 2>&1 | tail -40`

Fix any tests that break due to the type change (e.g., tests that check for validation errors on missing clientDid).

**Step 7: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/types.ts bridge/src/server.ts bridge/test/task-polling.test.ts
git commit -m "feat(bridge): make taskId and clientDid optional with auto-fill"
```

---

### Task 2: Mock Executor Fallback

**Files:**
- Modify: `bridge/src/executor.ts:27-33, 80-140`
- Test: `bridge/test/executor.test.ts`

**Step 1: Write failing tests for mock mode**

Add to `bridge/test/executor.test.ts` (new describe block):

```typescript
describe('mock mode', () => {
  it('detects mock mode when claude is not available', () => {
    // Create executor with a command that definitely doesn't exist
    const mockExecutor = new ClaudeExecutor({
      ...testOptions,
      allowedCommands: ['claude'],
    });
    // Mock execSync to simulate 'which claude' failing
    vi.spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('not found');
    });
    const freshExecutor = new ClaudeExecutor(testOptions);
    expect((freshExecutor as any).mockMode).toBe(true);
  });

  it('returns mock response with prompt echo when in mock mode', async () => {
    const mockExecutor = new ClaudeExecutor(testOptions);
    (mockExecutor as any).mockMode = true;

    const result = await mockExecutor.execute(createTask({ prompt: 'Write fibonacci in Python' }));

    expect(result.status).toBe('completed');
    expect(result.output).toContain('mock');
    expect(result.output).toContain('fibonacci');
    expect((result as any).mock).toBe(true);
  });

  it('mock response includes the task type', async () => {
    const mockExecutor = new ClaudeExecutor(testOptions);
    (mockExecutor as any).mockMode = true;

    const result = await mockExecutor.execute(createTask({ type: 'code-review', prompt: 'Review this code' }));

    expect(result.status).toBe('completed');
    expect(result.output).toContain('code-review');
    expect((result as any).mock).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/executor.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — mockMode property doesn't exist

**Step 3: Implement mock mode in executor**

In `bridge/src/executor.ts`:

Add import at top:
```typescript
import { spawn, ChildProcess, execSync } from 'child_process';
```

Add `mockMode` field and detection in constructor:
```typescript
export class ClaudeExecutor {
  private options: ExecutorOptions;
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private mockMode: boolean = false;

  constructor(options: ExecutorOptions) {
    this.options = options;

    // Detect if claude CLI is available
    try {
      execSync('which claude', { stdio: 'ignore' });
    } catch {
      this.mockMode = true;
      console.log('[Bridge] Running in mock mode (claude CLI not found)');
    }
  }
```

Add mock response method and early return in execute():
```typescript
async execute(task: TaskInput): Promise<TaskResult & { mock?: boolean }> {
  const startTime = Date.now();

  // Mock mode: return template response when claude CLI is not available
  if (this.mockMode) {
    return this.buildMockResponse(task, startTime);
  }

  // ... rest of existing execute() ...
}

private buildMockResponse(task: TaskInput, startTime: number): TaskResult & { mock: true } {
  const promptPreview = task.prompt.slice(0, 100);
  const output = [
    `[Mock Response — bridge is running in demo mode, claude CLI not installed]`,
    ``,
    `Task: ${task.type}`,
    `Prompt: ${promptPreview}${task.prompt.length > 100 ? '...' : ''}`,
    ``,
    `This is a placeholder response. Install Claude CLI in the bridge container to get real results.`,
  ].join('\n');

  return {
    taskId: task.taskId,
    status: 'completed',
    output,
    duration: Date.now() - startTime,
    mock: true,
  };
}
```

Update `TaskResult` type in `types.ts` to allow `mock` field:
```typescript
export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  output?: string;
  error?: string;
  duration: number;
  mock?: boolean;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/executor.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run --reporter=verbose 2>&1 | tail -40`
Expected: All tests PASS

**Step 6: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/executor.ts bridge/src/types.ts bridge/test/executor.test.ts
git commit -m "feat(bridge): add mock executor fallback when claude CLI is unavailable"
```

---

### Task 3: A2A Discoverability

**Files:**
- Modify: `bridge/src/server.ts:580-584` (add route alias)
- Modify: `bridge/src/server.ts:1084-1155` (add a2a field to capability card)
- Modify: `bridge/agent-card.config.json` (add a2a config)
- Test: `bridge/test/a2a.test.ts`

**Step 1: Write failing tests**

Add to `bridge/test/a2a.test.ts` (or create new section):

```typescript
describe('A2A discoverability', () => {
  it('serves /.well-known/a2a.json as alias for agent card', async () => {
    const agentRes = await request(app).get('/.well-known/agent.json');
    const a2aRes = await request(app).get('/.well-known/a2a.json');

    expect(a2aRes.status).toBe(200);
    expect(a2aRes.body.name).toBe(agentRes.body.name);
  });

  it('agent card includes a2a section with methods', async () => {
    const res = await request(app).get('/.well-known/agent.json');

    expect(res.body.a2a).toBeDefined();
    expect(res.body.a2a.endpoint).toBe('/a2a');
    expect(res.body.a2a.methods).toContain('message/send');
    expect(res.body.a2a.methods).toContain('tasks/get');
    expect(res.body.a2a.methods).toContain('tasks/cancel');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/a2a.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — 404 on /.well-known/a2a.json, no a2a field in card

**Step 3: Add /.well-known/a2a.json route**

In `bridge/src/server.ts`, after line 584 (`this.app.get('/.well-known/agent-card.json', agentCardHandler);`), add:

```typescript
this.app.get('/.well-known/a2a.json', agentCardHandler);
```

**Step 4: Add a2a config to agent card**

In `bridge/agent-card.config.json`, add after `"capabilities"`:

```json
"a2a": {
  "endpoint": "/a2a",
  "methods": ["message/send", "tasks/get", "tasks/cancel"]
},
```

In `bridge/src/server.ts` `buildCapabilityCard()`, after the capabilities block (around line 1128), add:

```typescript
if (cfg.a2a) {
  card.a2a = cfg.a2a;
}
```

Add the `a2a` field to the config types in `bridge/src/config.ts` (or wherever RichAgentConfig is defined). Find the type definition and add:

```typescript
a2a?: {
  endpoint: string;
  methods: string[];
};
```

**Step 5: Run tests to verify they pass**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/a2a.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/server.ts bridge/agent-card.config.json bridge/src/config.ts bridge/test/a2a.test.ts
git commit -m "feat(bridge): add A2A discoverability (/.well-known/a2a.json alias, methods list)"
```

---

### Task 4: Rewrite llms.txt to Reference Format

**Files:**
- Modify: `bridge/src/server.ts:1161-1201` (buildLlmsTxt method)
- Test: `bridge/test/llms-txt.test.ts`

**Step 1: Update tests for new format**

Replace the content-specific tests in `bridge/test/llms-txt.test.ts`:

```typescript
it('starts with "# AgoraMesh Bridge" heading', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).toMatch(/^# AgoraMesh Bridge/);
});

it('contains ## Endpoints section with HTTP methods', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).toContain('## Endpoints');
  expect(res.text).toContain('GET');
  expect(res.text).toContain('POST');
  expect(res.text).toContain('/health');
  expect(res.text).toContain('/task');
  expect(res.text).toContain('/.well-known/agent.json');
});

it('contains ## Authentication section with FreeTier format', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).toContain('## Authentication');
  expect(res.text).toContain('FreeTier');
  expect(res.text).toContain('Authorization: FreeTier');
});

it('contains ## Minimal Example with curl', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).toContain('## Minimal Example');
  expect(res.text).toContain('curl');
  expect(res.text).toContain('?wait=true');
});

it('does not contain GitHub links', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).not.toContain('github.com');
});

it('contains A2A endpoint', async () => {
  const res = await request(app).get('/llms.txt');
  expect(res.text).toContain('/a2a');
});

it('does not contain numbered tutorial steps', async () => {
  const res = await request(app).get('/llms.txt');
  // Should not have "1." "2." etc tutorial format
  expect(res.text).not.toMatch(/^\d+\.\s/m);
});
```

Keep these tests unchanged:
- `returns 200 with text/plain content type`
- `does not require authentication`
- `contains the configured base URL (not raw placeholder)`

Remove the old tests that check for `## Quick Start`, `## Documentation`, `## Optional`.

**Step 2: Run tests to verify they fail**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/llms-txt.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — old format doesn't match new assertions

**Step 3: Rewrite buildLlmsTxt()**

Replace the `buildLlmsTxt()` method in `bridge/src/server.ts` (lines 1161-1201):

```typescript
private buildLlmsTxt(baseUrl: string): string {
  return `# AgoraMesh Bridge
> AI coding agent. Submit tasks via HTTP, get results. Free tier — no signup.

## Endpoints
- Health: GET ${baseUrl}/health
- Agent card: GET ${baseUrl}/.well-known/agent.json
- Submit task: POST ${baseUrl}/task
- Submit task (sync): POST ${baseUrl}/task?wait=true
- Poll result: GET ${baseUrl}/task/{taskId}
- A2A JSON-RPC: POST ${baseUrl}/a2a

## Authentication (simplest first)
FreeTier: \`Authorization: FreeTier <your-agent-id>\`
  No signup, 10 tasks/day, 2000 char output cap
DID:key: \`Authorization: DID <did>:<timestamp>:<signature>\`
Bearer: \`Authorization: Bearer <token>\`

## Minimal Example
\`\`\`
curl -X POST "${baseUrl}/task?wait=true" \\
  -H "Authorization: FreeTier my-agent" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"prompt","prompt":"Write fibonacci in Python"}'
\`\`\`
`;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run test/llms-txt.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd /home/lada/projects/agoramesh
git add bridge/src/server.ts bridge/test/llms-txt.test.ts
git commit -m "feat(bridge): rewrite llms.txt to reference format for AI agents"
```

---

### Task 5: Full Verification and Deploy

**Step 1: Run full test suite**

Run: `cd /home/lada/projects/agoramesh/bridge && npx vitest run --reporter=verbose 2>&1 | tail -60`
Expected: All tests PASS

**Step 2: Run linter**

Run: `cd /home/lada/projects/agoramesh && make lint 2>&1 | tail -20`
Expected: No errors

**Step 3: Run TypeScript check**

Run: `cd /home/lada/projects/agoramesh/bridge && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

**Step 4: Build Docker image**

Run: `cd /home/lada/projects/agoramesh && docker build -t ghcr.io/agoramesh-ai/agoramesh-bridge:latest -f bridge/Dockerfile . 2>&1 | tail -20`
Expected: Build succeeds

**Step 5: Push to GitHub**

```bash
cd /home/lada/projects/agoramesh
git push origin main
```

**Step 6: Rebuild and restart production Docker**

```bash
cd /home/lada/projects/agoramesh
docker stop production-bridge-1
docker rm production-bridge-1
# Use the production compose or manual docker run with the new image
docker compose -f deploy/production/docker-compose.yml up -d bridge
```

**Step 7: Deploy website (if content changed)**

```bash
cd /home/lada/projects/agoramesh.ai
npm run build && rsync -av --delete dist/ /var/www/agoramesh/
```

**Step 8: End-to-end smoke test**

```bash
# 1. Health
curl -s http://localhost:3402/health

# 2. llms.txt — reference format
curl -s http://localhost:3402/llms.txt

# 3. A2A discovery
curl -s http://localhost:3402/.well-known/a2a.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('a2a',{}))"

# 4. Minimal task (no taskId, no clientDid)
curl -s -X POST "http://localhost:3402/task?wait=true" \
  -H "Authorization: FreeTier smoke-test" \
  -H "Content-Type: application/json" \
  -d '{"type":"prompt","prompt":"Write hello world in Python"}' | python3 -m json.tool
```

Expected: Task returns mock response with `"mock": true`.
