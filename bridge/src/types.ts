import { z } from 'zod';

import type {
  Skill,
  CapabilityCard,
  PaymentConfig,
  Authentication,
  Provider,
} from '@agoramesh/sdk';

// === Validation constants ===

/** Maximum prompt length (100KB) to prevent DoS attacks */
const MAX_PROMPT_LENGTH = 100000;

/** Maximum taskId length to prevent buffer overflow */
const MAX_TASK_ID_LENGTH = 128;

/** Maximum files in context to prevent memory exhaustion */
const MAX_FILES_COUNT = 100;

/** Minimum task timeout in seconds */
const MIN_TIMEOUT = 1;

/** Maximum task timeout in seconds (1 hour) */
const MAX_TIMEOUT = 3600;

/** Default task timeout in seconds */
const DEFAULT_TIMEOUT = 300;

/**
 * TaskId format validation regex.
 * Only allows alphanumeric characters, dashes, and underscores.
 * Prevents injection attacks and path traversal.
 */
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// === Task schemas ===

export const TaskInputSchema = z.object({
  taskId: z
    .string()
    .min(1, 'taskId is required')
    .max(MAX_TASK_ID_LENGTH, `taskId must be at most ${MAX_TASK_ID_LENGTH} characters`)
    .regex(
      TASK_ID_PATTERN,
      'taskId must contain only alphanumeric characters, dashes, and underscores'
    ),
  type: z.enum(['prompt', 'code-review', 'refactor', 'debug', 'custom']),
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .max(MAX_PROMPT_LENGTH, `prompt must be at most ${MAX_PROMPT_LENGTH} characters (100KB)`),
  context: z
    .object({
      repo: z.string().max(1000).optional(),
      branch: z.string().max(500).optional(),
      files: z
        .array(z.string().max(1000))
        .max(MAX_FILES_COUNT, `files array must have at most ${MAX_FILES_COUNT} items`)
        .optional(),
      workingDir: z.string().max(1000).optional(),
    })
    .optional(),
  timeout: z
    .number()
    .min(MIN_TIMEOUT, `timeout must be at least ${MIN_TIMEOUT} second`)
    .max(MAX_TIMEOUT, `timeout must be at most ${MAX_TIMEOUT} seconds (1 hour)`)
    .default(DEFAULT_TIMEOUT),
  clientDid: z.string().min(1).max(256).regex(/^did:[a-z]+:[a-zA-Z0-9._:-]+$/, 'Invalid DID format'),
  escrowId: z.string().regex(/^\d+$/, 'escrowId must be numeric').optional(),
});

export type TaskInput = z.infer<typeof TaskInputSchema>;

// === Free tier constants ===

/** Maximum free tier requests per DID per day */
export const FREE_TIER_DAILY_LIMIT = 10;

/** Maximum free tier requests per IP per day (Sybil resistance) */
export const FREE_TIER_IP_DAILY_LIMIT = 20;

/** Maximum output length for free tier responses (chars) */
export const FREE_TIER_OUTPUT_LIMIT = 2000;

// === DID identity ===

/** Identity attached to a request after DID:key authentication */
export interface DIDIdentity {
  did: string;
  tier: 'free' | 'paid';
}

// === Sandbox schema ===

/** Maximum prompt length for sandbox (500 chars) */
const MAX_SANDBOX_PROMPT_LENGTH = 500;

/** Maximum output length for sandbox (500 chars) */
export const MAX_SANDBOX_OUTPUT_LENGTH = 500;

/** Sandbox requests per hour per IP */
export const SANDBOX_REQUESTS_PER_HOUR = 3;

export const SandboxInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .max(MAX_SANDBOX_PROMPT_LENGTH, `Sandbox prompt limited to ${MAX_SANDBOX_PROMPT_LENGTH} characters`),
});

export const TaskResultSchema = z.object({
  taskId: z.string(),
  status: z.enum(['completed', 'failed', 'timeout']),
  output: z.string().optional(),
  error: z.string().optional(),
  duration: z.number(),
  filesChanged: z.array(z.string()).optional(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

// === Agent config ===

export interface AgentConfig {
  name: string;
  description: string;
  skills: string[];
  pricePerTask: number; // USDC
  privateKey: string;
  workspaceDir: string;
  allowedCommands: string[];
  taskTimeout: number;
}

/**
 * Extended agent configuration with full A2A v1.0 capability card fields.
 *
 * All new fields are optional so that existing env-var-based configuration
 * continues to work unchanged. A JSON config file can supply these richer
 * fields to generate a complete A2A Capability Card.
 */
export interface RichAgentConfig extends AgentConfig {
  /** Agent DID (Decentralized Identifier) */
  agentId?: string;
  /** Semantic version of the agent implementation */
  agentVersion?: string;
  /** Primary A2A endpoint URL */
  url?: string;
  /** A2A protocol version (e.g. "1.0") */
  protocolVersion?: string;
  /** Provider / organization information */
  provider?: Provider;
  /** Agent capabilities (streaming, push notifications, etc.) */
  capabilities?: CapabilityCard['capabilities'] & {
    a2aProtocol?: boolean;
    sandbox?: boolean;
    freeTier?: boolean;
  };
  /** Authentication configuration */
  authentication?: Authentication;
  /** Rich skill definitions with full A2A metadata (alongside basic string[] skills) */
  richSkills?: Skill[];
  /** Payment configuration (extends SDK PaymentConfig with wallet provisioning) */
  payment?: PaymentConfig & {
    walletProvisioning?: {
      description: string;
      providers: Array<{
        name: string;
        type: 'programmatic' | 'faucet' | 'exchange';
        url: string;
        sdkPackage?: string;
        chains: string[];
        currencies: string[];
      }>;
    };
  };
  /** Free tier configuration for DID:key auth */
  freeTier?: {
    enabled: boolean;
    authentication: string;
    limits: { requestsPerDay: number; outputMaxChars: number };
    upgradeInstructions: string;
  };
  /** Trust metadata (score, tier, endorsements, verifications) */
  trust?: CapabilityCard['trust'];
  /** Default accepted input content types */
  defaultInputModes?: string[];
  /** Default output content types */
  defaultOutputModes?: string[];
  /** URL to agent documentation */
  documentationUrl?: string;
  /** URL to terms of service */
  termsOfServiceUrl?: string;
  /** URL to privacy policy */
  privacyPolicyUrl?: string;
}

// === Bridge events ===

export interface BridgeEvents {
  'task:received': (task: TaskInput) => void;
  'task:started': (taskId: string) => void;
  'task:completed': (result: TaskResult) => void;
  'task:failed': (taskId: string, error: Error) => void;
  'agent:registered': (did: string) => void;
  'agent:connected': () => void;
  'agent:disconnected': () => void;
}
