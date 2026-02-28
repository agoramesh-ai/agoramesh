/**
 * A2A JSON-RPC 2.0 handler for AgoraMesh Bridge.
 *
 * Implements the A2A protocol standard: POST / with JSON-RPC 2.0 envelope.
 * Methods: message/send, tasks/get, tasks/cancel
 */

import type { ResolvedTaskInput, TaskResult } from './types.js';

// =============================================================================
// JSON-RPC types
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// =============================================================================
// A2A error codes (per JSON-RPC spec + server-defined)
// =============================================================================

export const A2A_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  TASK_NOT_FOUND: { code: -32000, message: 'Task not found' },
  TASK_NOT_CANCELLABLE: { code: -32001, message: 'Task not cancellable' },
} as const;

// =============================================================================
// A2A Task object
// =============================================================================

export type A2ATaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

export interface A2ATask {
  id: string;
  status: { state: A2ATaskState };
  artifacts?: Array<{
    name?: string;
    parts: Array<{ type: 'text'; text: string }>;
  }>;
}

// =============================================================================
// Bridge interface (methods exposed by BridgeServer for A2A handler)
// =============================================================================

export interface A2ABridge {
  getPendingTask(taskId: string): ResolvedTaskInput | undefined;
  getCompletedTask(taskId: string): TaskResult | undefined;
  submitTask(task: ResolvedTaskInput): Promise<TaskResult>;
  cancelTask(taskId: string): boolean;
  /** Return the agent's capability card (for agent/describe) */
  getCapabilityCard(): Record<string, unknown>;
  /** Return agent status info (for agent/status) */
  getStatus(): AgentStatus;
}

export interface AgentStatus {
  state: 'operational' | 'degraded' | 'offline';
  uptimeSeconds: number;
  activeTasks: number;
  protocols: string[];
}

// =============================================================================
// Helpers
// =============================================================================

function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(
  id: string | number | null,
  error: { code: number; message: string },
  data?: unknown
): JsonRpcResponse {
  const err: JsonRpcError = { code: error.code, message: error.message };
  if (data !== undefined) {
    err.data = data;
  }
  return { jsonrpc: '2.0', id, error: err };
}

function taskResultToA2ATask(taskId: string, result: TaskResult): A2ATask {
  const state: A2ATaskState = result.status === 'completed' ? 'completed' : 'failed';

  const task: A2ATask = {
    id: taskId,
    status: { state },
  };

  if (result.output) {
    task.artifacts = [{
      parts: [{ type: 'text', text: result.output }],
    }];
  }

  return task;
}

// =============================================================================
// Method handlers
// =============================================================================

async function handleMessageSend(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number
): Promise<JsonRpcResponse> {
  if (!params || !params.message) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message');
  }

  const message = params.message as Record<string, unknown>;
  const parts = message.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message.parts');
  }

  // Extract text from first text part
  const textPart = parts.find((p) => p.type === 'text' && typeof p.text === 'string');
  if (!textPart) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'No text part found in message');
  }

  const prompt = textPart.text as string;
  if (!prompt || prompt.length === 0) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Empty text in message part');
  }

  const taskId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const task: ResolvedTaskInput = {
    taskId,
    type: 'prompt',
    prompt,
    timeout: 300,
    clientDid: typeof message.role === 'string' ? `did:a2a:${message.role}` : 'did:a2a:user',
  };

  try {
    const result = await bridge.submitTask(task);
    return jsonRpcSuccess(id, taskResultToA2ATask(taskId, result));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Task execution failed';
    return jsonRpcError(id, A2A_ERRORS.INTERNAL_ERROR, msg);
  }
}

function handleTasksGet(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id');
  }

  const taskId = params.id;

  // Check if task is still pending/running
  const task = bridge.getPendingTask(taskId);
  if (task) {
    return jsonRpcSuccess(id, {
      id: taskId,
      status: { state: 'working' as A2ATaskState },
    } satisfies A2ATask);
  }

  // Check if task has completed
  const completedResult = bridge.getCompletedTask(taskId);
  if (completedResult) {
    return jsonRpcSuccess(id, taskResultToA2ATask(taskId, completedResult));
  }

  return jsonRpcError(id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`);
}

function handleTasksCancel(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id');
  }

  const taskId = params.id;
  const cancelled = bridge.cancelTask(taskId);
  if (!cancelled) {
    return jsonRpcError(id, A2A_ERRORS.TASK_NOT_CANCELLABLE, `Task ${taskId} not found or already completed`);
  }

  return jsonRpcSuccess(id, {
    id: taskId,
    status: { state: 'canceled' as A2ATaskState },
  } satisfies A2ATask);
}

// =============================================================================
// Main handler
// =============================================================================

/**
 * Handle an A2A JSON-RPC 2.0 request.
 * Returns a JsonRpcResponse (always HTTP 200 for JSON-RPC, errors in the body).
 */
export async function handleA2ARequest(
  body: unknown,
  bridge: A2ABridge
): Promise<JsonRpcResponse> {
  // Validate JSON-RPC envelope
  if (!body || typeof body !== 'object') {
    return jsonRpcError(null, A2A_ERRORS.PARSE_ERROR);
  }

  const req = body as Record<string, unknown>;

  if (req.jsonrpc !== '2.0') {
    return jsonRpcError(null, A2A_ERRORS.INVALID_REQUEST, 'Missing or invalid jsonrpc field (must be "2.0")');
  }

  if (req.id === undefined || req.id === null) {
    return jsonRpcError(null, A2A_ERRORS.INVALID_REQUEST, 'Missing id field');
  }

  const id = req.id as string | number;

  if (typeof req.method !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_REQUEST, 'Missing or invalid method field');
  }

  const params = req.params as Record<string, unknown> | undefined;

  // Dispatch to method handlers
  switch (req.method) {
    case 'message/send':
      return handleMessageSend(params, bridge, id);

    case 'tasks/get':
      return handleTasksGet(params, bridge, id);

    case 'tasks/cancel':
      return handleTasksCancel(params, bridge, id);

    case 'agent/describe':
      return jsonRpcSuccess(id, bridge.getCapabilityCard());

    case 'agent/status':
      return jsonRpcSuccess(id, bridge.getStatus());

    default:
      return jsonRpcError(id, A2A_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}
