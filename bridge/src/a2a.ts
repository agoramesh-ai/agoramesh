/**
 * A2A JSON-RPC 2.0 handler for AgoraMesh Bridge.
 *
 * Implements the A2A protocol standard: POST / with JSON-RPC 2.0 envelope.
 * Methods (A2A v1.0.0): SendMessage, SendStreamingMessage, GetTask, CancelTask, SubscribeToTask
 * Legacy aliases: message/send, tasks/get, tasks/cancel
 */

import { randomUUID } from 'node:crypto';
import type { ResolvedTaskInput, TaskResult, TaskAttachment } from './types.js';

// =============================================================================
// A2A v1.0.0 message part types
// =============================================================================

export interface TextPart {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RawPart {
  type: 'raw';
  raw: string; // base64-encoded
  mediaType: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface UrlPart {
  type: 'url';
  url: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  type: 'data';
  data: unknown; // arbitrary JSON
  metadata?: Record<string, unknown>;
}

export type A2APart = TextPart | RawPart | UrlPart | DataPart;

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
  TASK_NOT_FOUND: { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELLABLE: { code: -32002, message: 'Task not cancellable' },
  INCOMPATIBLE_VERSION: { code: -32003, message: 'Incompatible A2A-Version' },
  INVALID_STATE_TRANSITION: { code: -32004, message: 'Invalid state transition' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { code: -32005, message: 'Push notifications not supported' },
  PUSH_NOTIFICATION_CONFIG_NOT_FOUND: { code: -32006, message: 'Push notification config not found' },
} as const;

// =============================================================================
// A2A-Version header parsing
// =============================================================================

const A2A_VERSION_RE = /^\d+\.\d+$/;
const DEFAULT_A2A_VERSION = '0.3';

/**
 * Parse and validate the A2A-Version header.
 * Returns the version string, or DEFAULT_A2A_VERSION if absent/empty.
 * Returns null if the header is present but malformed.
 */
export function parseA2AVersion(header: string | undefined): string | null {
  if (!header || header.trim() === '') {
    return DEFAULT_A2A_VERSION;
  }
  const trimmed = header.trim();
  if (!A2A_VERSION_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// =============================================================================
// A2A role constants (SCREAMING_SNAKE_CASE per A2A spec)
// =============================================================================

export const A2A_ROLE = {
  ROLE_USER: 'ROLE_USER',
  ROLE_AGENT: 'ROLE_AGENT',
} as const;

export type A2ARole = (typeof A2A_ROLE)[keyof typeof A2A_ROLE];

// =============================================================================
// A2A Task object
// =============================================================================

/** Internal task state (lowercase). Converted to SCREAMING_SNAKE_CASE at wire boundary. */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'input_required'
  | 'auth_required'
  | 'rejected';

/** Wire-format state names per A2A spec. */
export type A2AWireState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_REJECTED';

const STATE_TO_WIRE: Record<A2ATaskState, A2AWireState> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
  auth_required: 'TASK_STATE_AUTH_REQUIRED',
  rejected: 'TASK_STATE_REJECTED',
};

const WIRE_TO_STATE: Record<A2AWireState, A2ATaskState> = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_INPUT_REQUIRED: 'input_required',
  TASK_STATE_AUTH_REQUIRED: 'auth_required',
  TASK_STATE_REJECTED: 'rejected',
};

/** Terminal states — once a task reaches these, it cannot transition further. */
const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

/** Check if a task state is terminal (no further transitions allowed). */
export function isTerminalState(state: A2ATaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Validate a state transition. Returns true if the transition is valid.
 * Terminal states (completed, failed, canceled, rejected) cannot transition to any other state.
 */
export function isValidStateTransition(from: A2ATaskState, _to: A2ATaskState): boolean {
  if (TERMINAL_STATES.has(from)) {
    return false; // Terminal states cannot transition
  }
  return true;
}

/** Convert internal state to wire-format SCREAMING_SNAKE_CASE. */
export function toWireState(state: A2ATaskState): A2AWireState {
  return STATE_TO_WIRE[state];
}

/** Convert wire-format state back to internal lowercase. Returns undefined for unknown values. */
export function fromWireState(wire: string): A2ATaskState | undefined {
  return WIRE_TO_STATE[wire as A2AWireState];
}

export interface A2ATaskStatus {
  state: A2AWireState;
  message?: string;
  timestamp: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
}

export interface A2ATask {
  id: string;
  messageId: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
}

// =============================================================================
// SSE Streaming types (A2A v1.0.0)
// =============================================================================

export interface TaskStatusUpdateEvent {
  type: 'statusUpdate';
  taskId: string;
  status: A2ATaskStatus;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  type: 'artifactUpdate';
  taskId: string;
  artifact: A2AArtifact;
  append: boolean;
  lastChunk: boolean;
}

export type StreamResponseEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

// =============================================================================
// Push Notification types (A2A v1.0.0)
// =============================================================================

export interface TaskPushNotificationConfig {
  id: string;
  taskId: string;
  pushNotificationConfig: {
    url: string;
    /** Optional token included in Authorization header of webhook calls */
    token?: string;
    /** Optional authentication config for webhook */
    authentication?: {
      schemes: string[];
      credentials?: string;
    };
  };
}

// =============================================================================
// Push Notification in-memory store
// =============================================================================

/** In-memory store: taskId -> push notification configs */
const pushNotificationStore: Map<string, TaskPushNotificationConfig[]> = new Map();

export function setPushNotificationConfig(config: TaskPushNotificationConfig): void {
  const existing = pushNotificationStore.get(config.taskId) ?? [];
  const idx = existing.findIndex((c) => c.id === config.id);
  if (idx >= 0) {
    existing[idx] = config;
  } else {
    existing.push(config);
  }
  pushNotificationStore.set(config.taskId, existing);
}

export function getPushNotificationConfig(taskId: string, configId: string): TaskPushNotificationConfig | undefined {
  const configs = pushNotificationStore.get(taskId);
  return configs?.find((c) => c.id === configId);
}

export function listPushNotificationConfigs(taskId: string): TaskPushNotificationConfig[] {
  return pushNotificationStore.get(taskId) ?? [];
}

export function deletePushNotificationConfig(taskId: string, configId: string): boolean {
  const configs = pushNotificationStore.get(taskId);
  if (!configs) return false;
  const idx = configs.findIndex((c) => c.id === configId);
  if (idx < 0) return false;
  configs.splice(idx, 1);
  if (configs.length === 0) {
    pushNotificationStore.delete(taskId);
  }
  return true;
}

/** Get all configs for a task (used by the notification dispatcher) */
export function getConfigsForTask(taskId: string): TaskPushNotificationConfig[] {
  return pushNotificationStore.get(taskId) ?? [];
}

/** Clean up push notification configs for a task (called after notifications are sent) */
export function cleanupPushNotificationConfigs(taskId: string): void {
  pushNotificationStore.delete(taskId);
}

// =============================================================================
// Context ID management for multi-turn conversations
// =============================================================================

/** TTL for context entries: 1 hour */
const CONTEXT_TTL_MS = 60 * 60 * 1000;

interface ContextEntry {
  taskIds: string[];
  expiresAt: number;
}

/** In-memory context store mapping contextId -> conversation history. */
const contextStore: Map<string, ContextEntry> = new Map();

/** Periodic cleanup interval handle (set on first use). */
let contextCleanupInterval: ReturnType<typeof setInterval> | undefined;

function ensureContextCleanup(): void {
  if (!contextCleanupInterval) {
    contextCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of contextStore) {
        if (now >= entry.expiresAt) {
          contextStore.delete(key);
        }
      }
    }, CONTEXT_TTL_MS);
    // Allow process to exit even if the interval is still running
    if (contextCleanupInterval.unref) {
      contextCleanupInterval.unref();
    }
  }
}

/**
 * Resolve or create a contextId for a request.
 * If the caller provides one, reuse it; otherwise generate a new one.
 */
function resolveContextId(params: Record<string, unknown>): string {
  ensureContextCleanup();
  const incoming = typeof params.contextId === 'string' ? params.contextId : undefined;
  if (incoming && contextStore.has(incoming)) {
    // Refresh TTL
    const entry = contextStore.get(incoming)!;
    entry.expiresAt = Date.now() + CONTEXT_TTL_MS;
    return incoming;
  }
  const id = incoming ?? randomUUID();
  contextStore.set(id, { taskIds: [], expiresAt: Date.now() + CONTEXT_TTL_MS });
  return id;
}

/**
 * Record a task under a contextId and return prior task IDs for context injection.
 */
function recordTaskInContext(contextId: string, taskId: string): string[] {
  const entry = contextStore.get(contextId);
  if (!entry) return [];
  const priorTaskIds = [...entry.taskIds];
  entry.taskIds.push(taskId);
  entry.expiresAt = Date.now() + CONTEXT_TTL_MS;
  return priorTaskIds;
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
  /** Subscribe to status changes for an existing task. Called when SSE subscriber connects. */
  onTaskComplete?(taskId: string, callback: (result: TaskResult) => void): () => void;
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

function generateArtifactId(): string {
  return `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function taskResultToA2ATask(taskId: string, result: TaskResult, contextId?: string): A2ATask {
  const state: A2ATaskState = result.status === 'completed' ? 'completed' : 'failed';
  const message = state === 'failed' ? (result.error ?? 'Task failed') : undefined;

  const task: A2ATask = {
    id: taskId,
    messageId: randomUUID(),
    ...(contextId !== undefined && { contextId }),
    status: {
      state: toWireState(state),
      ...(message !== undefined && { message }),
      timestamp: new Date().toISOString(),
    },
  };

  if (result.output) {
    const parts: A2APart[] = [{ type: 'text', text: result.output }];

    // Include file artifacts if the task produced file changes
    if (result.filesChanged && result.filesChanged.length > 0) {
      parts.push({
        type: 'data',
        data: { filesChanged: result.filesChanged },
        metadata: { role: 'supplementary' },
      });
    }

    task.artifacts = [{
      artifactId: generateArtifactId(),
      name: 'response',
      description: 'Task execution result',
      parts,
    }];
  }

  return task;
}

// =============================================================================
// Multi-type message part validation
// =============================================================================

/** Maximum size for a single base64-encoded raw part (5MB decoded) */
const MAX_RAW_PART_SIZE = 5 * 1024 * 1024 * 1.37; // ~6.85MB base64 for 5MB binary

/** Maximum URL length for url parts */
const MAX_URL_LENGTH = 8192;

/** Maximum serialized size for data parts (1MB) */
const MAX_DATA_PART_SIZE = 1_000_000;

/**
 * Validate and classify an incoming message part.
 * Returns an A2APart on success, or a string error message on failure.
 */
export function validatePart(raw: Record<string, unknown>): A2APart | string {
  const metadata = typeof raw.metadata === 'object' && raw.metadata !== null
    ? raw.metadata as Record<string, unknown>
    : undefined;

  switch (raw.type) {
    case 'text': {
      if (typeof raw.text !== 'string') return 'text part missing "text" string field';
      const part: TextPart = { type: 'text', text: raw.text };
      if (metadata) part.metadata = metadata;
      return part;
    }
    case 'raw': {
      if (typeof raw.raw !== 'string') return 'raw part missing "raw" base64 string field';
      if (typeof raw.mediaType !== 'string') return 'raw part missing "mediaType" string field';
      if (raw.raw.length > MAX_RAW_PART_SIZE) return `raw part exceeds maximum size of 5MB`;
      // Validate base64 format (allow standard and URL-safe base64 with padding)
      if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(raw.raw)) return 'raw part contains invalid base64';
      const part: RawPart = { type: 'raw', raw: raw.raw, mediaType: raw.mediaType };
      if (typeof raw.filename === 'string') part.filename = raw.filename;
      if (metadata) part.metadata = metadata;
      return part;
    }
    case 'url': {
      if (typeof raw.url !== 'string') return 'url part missing "url" string field';
      if (raw.url.length > MAX_URL_LENGTH) return `url part exceeds maximum URL length of ${MAX_URL_LENGTH}`;
      // Basic URL validation
      if (!raw.url.startsWith('http://') && !raw.url.startsWith('https://')) {
        return 'url part must use http:// or https:// scheme';
      }
      const part: UrlPart = { type: 'url', url: raw.url };
      if (typeof raw.mediaType === 'string') part.mediaType = raw.mediaType;
      if (metadata) part.metadata = metadata;
      return part;
    }
    case 'data': {
      if (raw.data === undefined || raw.data === null) return 'data part missing "data" field';
      const serialized = JSON.stringify(raw.data);
      if (serialized.length > MAX_DATA_PART_SIZE) return `data part exceeds maximum size of 1MB`;
      const part: DataPart = { type: 'data', data: raw.data };
      if (metadata) part.metadata = metadata;
      return part;
    }
    default:
      return `unknown part type: ${String(raw.type)}`;
  }
}

/**
 * Build the prompt string from text parts, enriched with context from non-text parts.
 */
export function buildPromptFromParts(parts: A2APart[]): string {
  const textSegments: string[] = [];
  const contextSegments: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        textSegments.push(part.text);
        break;
      case 'raw':
        contextSegments.push(
          `[Attached file${part.filename ? `: ${part.filename}` : ''} (${part.mediaType}, base64-encoded)]`
        );
        break;
      case 'url':
        contextSegments.push(
          `[Referenced URL: ${part.url}${part.mediaType ? ` (${part.mediaType})` : ''}]`
        );
        break;
      case 'data':
        contextSegments.push(
          `[Structured data: ${JSON.stringify(part.data)}]`
        );
        break;
    }
  }

  let prompt = textSegments.join('\n\n');
  if (contextSegments.length > 0) {
    prompt += '\n\n--- Additional Context ---\n' + contextSegments.join('\n');
  }
  return prompt;
}

/**
 * Convert validated non-text parts to TaskAttachment objects for the executor.
 */
export function partsToAttachments(parts: A2APart[]): TaskAttachment[] {
  const attachments: TaskAttachment[] = [];
  for (const part of parts) {
    if (part.type === 'raw') {
      attachments.push({
        type: 'raw',
        content: part.raw,
        mediaType: part.mediaType,
        filename: part.filename,
        metadata: part.metadata,
      });
    } else if (part.type === 'url') {
      attachments.push({
        type: 'url',
        url: part.url,
        mediaType: part.mediaType,
        metadata: part.metadata,
      });
    } else if (part.type === 'data') {
      attachments.push({
        type: 'data',
        data: part.data,
        metadata: part.metadata,
      });
    }
  }
  return attachments;
}

// =============================================================================
// Method handlers
// =============================================================================

/**
 * Build a conversation-context prefix from prior task results under the same contextId.
 */
function buildContextPrefix(priorTaskIds: string[], bridge: A2ABridge): string {
  if (priorTaskIds.length === 0) return '';
  const contextParts: string[] = [];
  for (const priorId of priorTaskIds) {
    const priorResult = bridge.getCompletedTask(priorId);
    if (priorResult?.output) {
      contextParts.push(`[Prior task ${priorId}]: ${priorResult.output}`);
    }
  }
  if (contextParts.length === 0) return '';
  return '--- Conversation History ---\n' + contextParts.join('\n\n') + '\n\n--- Current Request ---\n';
}

async function handleMessageSend(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number
): Promise<JsonRpcResponse> {
  if (!params || !params.message) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message');
  }

  const message = params.message as Record<string, unknown>;
  const rawParts = message.parts as Array<Record<string, unknown>> | undefined;
  if (!rawParts || !Array.isArray(rawParts) || rawParts.length === 0) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message.parts');
  }

  // Parse incoming messageId (optional per A2A spec)
  const incomingMessageId = typeof message.messageId === 'string' ? message.messageId : undefined;

  // Validate role — accept both A2A SCREAMING_SNAKE_CASE and legacy lowercase
  const rawRole = typeof message.role === 'string' ? message.role : undefined;
  const role = rawRole === A2A_ROLE.ROLE_USER || rawRole === 'user'
    ? A2A_ROLE.ROLE_USER
    : rawRole === A2A_ROLE.ROLE_AGENT || rawRole === 'agent'
      ? A2A_ROLE.ROLE_AGENT
      : A2A_ROLE.ROLE_USER;

  // Validate and classify all parts
  const validatedParts: A2APart[] = [];
  for (const rawPart of rawParts) {
    const result = validatePart(rawPart);
    if (typeof result === 'string') {
      return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, result);
    }
    validatedParts.push(result);
  }

  // At least one text part is required for the prompt
  const hasText = validatedParts.some((p) => p.type === 'text' && (p as TextPart).text.length > 0);
  if (!hasText) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'No text part found in message');
  }

  // Build the prompt from all parts
  let prompt = buildPromptFromParts(validatedParts);
  if (!prompt || prompt.length === 0) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Empty text in message part');
  }

  // Resolve contextId for multi-turn conversations
  const contextId = resolveContextId(params);
  const taskId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const priorTaskIds = recordTaskInContext(contextId, taskId);

  // Prepend conversation history if this is a continuation
  const contextPrefix = buildContextPrefix(priorTaskIds, bridge);
  if (contextPrefix) {
    prompt = contextPrefix + prompt;
  }

  // H-3: Validate prompt length (same as TaskInputSchema: 100KB)
  const MAX_PROMPT_LENGTH = 100_000;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, `Prompt length ${prompt.length} exceeds maximum of ${MAX_PROMPT_LENGTH} characters. Too long.`);
  }

  // H-3: Validate timeout if provided
  const rawTimeout = typeof params.timeout === 'number' ? params.timeout : 300;
  const timeout = Math.max(1, Math.min(3600, rawTimeout));

  // Collect non-text parts as attachments for the executor
  const attachments = partsToAttachments(validatedParts);

  const task: ResolvedTaskInput = {
    taskId,
    type: 'prompt',
    prompt,
    timeout,
    clientDid: role === A2A_ROLE.ROLE_AGENT ? `did:a2a:agent` : `did:a2a:user`,
    ...(incomingMessageId !== undefined && { a2aMessageId: incomingMessageId }),
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  try {
    const result = await bridge.submitTask(task);
    return jsonRpcSuccess(id, taskResultToA2ATask(taskId, result, contextId));
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
      messageId: randomUUID(),
      status: {
        state: toWireState('working'),
        timestamp: new Date().toISOString(),
      },
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
    messageId: randomUUID(),
    status: {
      state: toWireState('canceled'),
      message: 'Task canceled by client',
      timestamp: new Date().toISOString(),
    },
  } satisfies A2ATask);
}

// =============================================================================
// SSE streaming helpers
// =============================================================================

/** Check if a JSON-RPC method requires SSE streaming response. */
export function isStreamingMethod(method: string): boolean {
  return method === 'SendStreamingMessage' || method === 'SubscribeToTask';
}

function buildStatusEvent(taskId: string, state: A2ATaskState, isFinal: boolean, message?: string): TaskStatusUpdateEvent {
  return {
    type: 'statusUpdate',
    taskId,
    status: {
      state: toWireState(state),
      ...(message !== undefined && { message }),
      timestamp: new Date().toISOString(),
    },
    final: isFinal,
  };
}

function buildArtifactEvent(taskId: string, artifact: A2AArtifact, lastChunk: boolean): TaskArtifactUpdateEvent {
  return {
    type: 'artifactUpdate',
    taskId,
    artifact,
    append: false,
    lastChunk,
  };
}

// =============================================================================
// Streaming method handlers
// =============================================================================

async function handleSendStreamingMessage(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number,
  writeEvent: (event: StreamResponseEvent | JsonRpcResponse) => void,
): Promise<void> {
  if (!params || !params.message) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message'));
    return;
  }

  const message = params.message as Record<string, unknown>;
  const rawParts = message.parts as Array<Record<string, unknown>> | undefined;
  if (!rawParts || !Array.isArray(rawParts) || rawParts.length === 0) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.message.parts'));
    return;
  }

  const incomingMessageId = typeof message.messageId === 'string' ? message.messageId : undefined;

  const rawRole = typeof message.role === 'string' ? message.role : undefined;
  const role = rawRole === A2A_ROLE.ROLE_USER || rawRole === 'user'
    ? A2A_ROLE.ROLE_USER
    : rawRole === A2A_ROLE.ROLE_AGENT || rawRole === 'agent'
      ? A2A_ROLE.ROLE_AGENT
      : A2A_ROLE.ROLE_USER;

  const validatedParts: A2APart[] = [];
  for (const rawPart of rawParts) {
    const result = validatePart(rawPart);
    if (typeof result === 'string') {
      writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, result));
      return;
    }
    validatedParts.push(result);
  }

  const hasText = validatedParts.some((p) => p.type === 'text' && (p as TextPart).text.length > 0);
  if (!hasText) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'No text part found in message'));
    return;
  }

  let prompt = buildPromptFromParts(validatedParts);
  if (!prompt || prompt.length === 0) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Empty text in message part'));
    return;
  }

  // Resolve contextId for multi-turn conversations
  const contextId = resolveContextId(params);
  const taskId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const priorTaskIds = recordTaskInContext(contextId, taskId);

  // Prepend conversation history if this is a continuation
  const contextPrefix = buildContextPrefix(priorTaskIds, bridge);
  if (contextPrefix) {
    prompt = contextPrefix + prompt;
  }

  const MAX_PROMPT_LENGTH = 100_000;
  if (prompt.length > MAX_PROMPT_LENGTH) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS,
      `Prompt length ${prompt.length} exceeds maximum of ${MAX_PROMPT_LENGTH} characters. Too long.`));
    return;
  }

  const rawTimeout = typeof params.timeout === 'number' ? params.timeout : 300;
  const timeout = Math.max(1, Math.min(3600, rawTimeout));

  const attachments = partsToAttachments(validatedParts);

  const task: ResolvedTaskInput = {
    taskId,
    type: 'prompt',
    prompt,
    timeout,
    clientDid: role === A2A_ROLE.ROLE_AGENT ? `did:a2a:agent` : `did:a2a:user`,
    ...(incomingMessageId !== undefined && { a2aMessageId: incomingMessageId }),
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  // Emit submitted status
  writeEvent(buildStatusEvent(taskId, 'submitted', false));

  // Emit working status
  writeEvent(buildStatusEvent(taskId, 'working', false));

  try {
    const result = await bridge.submitTask(task);
    const state: A2ATaskState = result.status === 'completed' ? 'completed' : 'failed';
    const failMessage = state === 'failed' ? (result.error ?? 'Task failed') : undefined;

    // Emit artifact if there's output
    if (result.output) {
      const parts: A2APart[] = [{ type: 'text', text: result.output }];
      if (result.filesChanged && result.filesChanged.length > 0) {
        parts.push({
          type: 'data',
          data: { filesChanged: result.filesChanged },
          metadata: { role: 'supplementary' },
        });
      }
      const artifact: A2AArtifact = {
        artifactId: generateArtifactId(),
        name: 'response',
        description: 'Task execution result',
        parts,
      };
      writeEvent(buildArtifactEvent(taskId, artifact, true));
    }

    // Emit final status
    writeEvent(buildStatusEvent(taskId, state, true, failMessage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Task execution failed';
    writeEvent(buildStatusEvent(taskId, 'failed', true, msg));
  }
}

async function handleSubscribeToTask(
  params: Record<string, unknown> | undefined,
  bridge: A2ABridge,
  id: string | number,
  writeEvent: (event: StreamResponseEvent | JsonRpcResponse) => void,
): Promise<void> {
  if (!params || typeof params.id !== 'string') {
    writeEvent(jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id'));
    return;
  }

  const taskId = params.id;

  // Check if already completed
  const completedResult = bridge.getCompletedTask(taskId);
  if (completedResult) {
    const state: A2ATaskState = completedResult.status === 'completed' ? 'completed' : 'failed';

    if (completedResult.output) {
      const artifact: A2AArtifact = {
        artifactId: generateArtifactId(),
        name: 'response',
        description: 'Task execution result',
        parts: [{ type: 'text', text: completedResult.output }],
      };
      writeEvent(buildArtifactEvent(taskId, artifact, true));
    }

    writeEvent(buildStatusEvent(taskId, state, true,
      state === 'failed' ? (completedResult.error ?? 'Task failed') : undefined));
    return;
  }

  // Check if pending
  const pendingTask = bridge.getPendingTask(taskId);
  if (!pendingTask) {
    writeEvent(jsonRpcError(id, A2A_ERRORS.TASK_NOT_FOUND, `Task ${taskId} not found`));
    return;
  }

  // Emit current status
  writeEvent(buildStatusEvent(taskId, 'working', false));

  // Wait for completion via bridge callback
  if (bridge.onTaskComplete) {
    await new Promise<void>((resolve) => {
      const unsubscribe = bridge.onTaskComplete!(taskId, (result) => {
        unsubscribe();
        const state: A2ATaskState = result.status === 'completed' ? 'completed' : 'failed';

        if (result.output) {
          const artifact: A2AArtifact = {
            artifactId: generateArtifactId(),
            name: 'response',
            description: 'Task execution result',
            parts: [{ type: 'text', text: result.output }],
          };
          writeEvent(buildArtifactEvent(taskId, artifact, true));
        }

        writeEvent(buildStatusEvent(taskId, state, true,
          state === 'failed' ? (result.error ?? 'Task failed') : undefined));
        resolve();
      });
    });
  } else {
    // Fallback: poll until done
    writeEvent(buildStatusEvent(taskId, 'working', false));
  }
}

// =============================================================================
// Push Notification CRUD handlers (JSON-RPC)
// =============================================================================

function handleCreatePushNotificationConfig(
  params: Record<string, unknown> | undefined,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id (taskId)');
  }
  if (!params.pushNotificationConfig || typeof params.pushNotificationConfig !== 'object') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.pushNotificationConfig');
  }
  const pnConfig = params.pushNotificationConfig as Record<string, unknown>;
  if (typeof pnConfig.url !== 'string' || !pnConfig.url.startsWith('http')) {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'pushNotificationConfig.url must be a valid HTTP(S) URL');
  }

  const configId = `pnc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pn: TaskPushNotificationConfig['pushNotificationConfig'] = {
    url: pnConfig.url,
  };
  if (typeof pnConfig.token === 'string') {
    pn.token = pnConfig.token;
  }
  if (pnConfig.authentication && typeof pnConfig.authentication === 'object') {
    pn.authentication = pnConfig.authentication as TaskPushNotificationConfig['pushNotificationConfig']['authentication'];
  }

  const config: TaskPushNotificationConfig = {
    id: configId,
    taskId: params.id,
    pushNotificationConfig: pn,
  };

  setPushNotificationConfig(config);
  return jsonRpcSuccess(id, config);
}

function handleGetPushNotificationConfig(
  params: Record<string, unknown> | undefined,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id (taskId)');
  }
  if (typeof params.configId !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.configId');
  }

  const config = getPushNotificationConfig(params.id, params.configId);
  if (!config) {
    return jsonRpcError(id, A2A_ERRORS.PUSH_NOTIFICATION_CONFIG_NOT_FOUND);
  }
  return jsonRpcSuccess(id, config);
}

function handleListPushNotificationConfigs(
  params: Record<string, unknown> | undefined,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id (taskId)');
  }

  const configs = listPushNotificationConfigs(params.id);
  return jsonRpcSuccess(id, configs);
}

function handleDeletePushNotificationConfig(
  params: Record<string, unknown> | undefined,
  id: string | number
): JsonRpcResponse {
  if (!params || typeof params.id !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.id (taskId)');
  }
  if (typeof params.configId !== 'string') {
    return jsonRpcError(id, A2A_ERRORS.INVALID_PARAMS, 'Missing params.configId');
  }

  const deleted = deletePushNotificationConfig(params.id, params.configId);
  if (!deleted) {
    return jsonRpcError(id, A2A_ERRORS.PUSH_NOTIFICATION_CONFIG_NOT_FOUND);
  }
  return jsonRpcSuccess(id, { success: true });
}

// =============================================================================
// Main handler
// =============================================================================

export interface A2ARequestOptions {
  /** Value of the A2A-Version HTTP header (undefined if absent). */
  a2aVersionHeader?: string;
}

/**
 * Handle an A2A JSON-RPC 2.0 request.
 * Returns a JsonRpcResponse (always HTTP 200 for JSON-RPC, errors in the body).
 */
export async function handleA2ARequest(
  body: unknown,
  bridge: A2ABridge,
  options?: A2ARequestOptions
): Promise<JsonRpcResponse> {
  // Validate A2A-Version header if present
  const a2aVersion = parseA2AVersion(options?.a2aVersionHeader);
  if (a2aVersion === null) {
    return jsonRpcError(null, A2A_ERRORS.INCOMPATIBLE_VERSION,
      `Malformed A2A-Version header. Expected format: MAJOR.MINOR (e.g. "1.0")`);
  }

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

  // Dispatch to method handlers (A2A v1.0.0 names + legacy aliases)
  switch (req.method) {
    case 'SendMessage':
    case 'message/send':
      return handleMessageSend(params, bridge, id);

    case 'GetTask':
    case 'tasks/get':
      return handleTasksGet(params, bridge, id);

    case 'CancelTask':
    case 'tasks/cancel':
      return handleTasksCancel(params, bridge, id);

    case 'agent/describe':
      return jsonRpcSuccess(id, bridge.getCapabilityCard());

    case 'agent/status':
      return jsonRpcSuccess(id, bridge.getStatus());

    // Push Notification CRUD (A2A v1.0.0)
    case 'CreatePushNotificationConfig':
      return handleCreatePushNotificationConfig(params, id);

    case 'GetPushNotificationConfig':
      return handleGetPushNotificationConfig(params, id);

    case 'ListPushNotificationConfigs':
      return handleListPushNotificationConfigs(params, id);

    case 'DeletePushNotificationConfig':
      return handleDeletePushNotificationConfig(params, id);

    default:
      return jsonRpcError(id, A2A_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

/**
 * Validate a JSON-RPC request envelope and extract method/params/id.
 * Returns the parsed fields or a JsonRpcResponse error.
 */
export function parseA2ARequestEnvelope(
  body: unknown,
  a2aVersionHeader?: string,
): { method: string; params: Record<string, unknown> | undefined; id: string | number } | JsonRpcResponse {
  const a2aVersion = parseA2AVersion(a2aVersionHeader);
  if (a2aVersion === null) {
    return jsonRpcError(null, A2A_ERRORS.INCOMPATIBLE_VERSION,
      `Malformed A2A-Version header. Expected format: MAJOR.MINOR (e.g. "1.0")`);
  }

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

  if (typeof req.method !== 'string') {
    return jsonRpcError(req.id as string | number, A2A_ERRORS.INVALID_REQUEST, 'Missing or invalid method field');
  }

  return {
    method: req.method,
    params: req.params as Record<string, unknown> | undefined,
    id: req.id as string | number,
  };
}

/**
 * Handle an A2A JSON-RPC 2.0 streaming request (SendStreamingMessage, SubscribeToTask).
 * Calls writeEvent for each SSE event. The caller is responsible for setting up the
 * SSE response (Content-Type, headers) and flushing/closing the stream after this returns.
 */
export async function handleA2AStreamingRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  id: string | number,
  bridge: A2ABridge,
  writeEvent: (event: StreamResponseEvent | JsonRpcResponse) => void,
): Promise<void> {
  switch (method) {
    case 'SendStreamingMessage':
      return handleSendStreamingMessage(params, bridge, id, writeEvent);
    case 'SubscribeToTask':
      return handleSubscribeToTask(params, bridge, id, writeEvent);
    default:
      writeEvent(jsonRpcError(id, A2A_ERRORS.METHOD_NOT_FOUND, `Unknown streaming method: ${method}`));
  }
}
