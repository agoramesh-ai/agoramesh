/**
 * Agent Card JSON config loader.
 *
 * Loads an optional `agent-card.config.json` file that provides rich A2A v1.0
 * fields for the bridge agent. When the file is absent the bridge falls back
 * to the existing env-var-based configuration (see cli.ts).
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import type { RichAgentConfig } from './types.js';

// =============================================================================
// Zod sub-schemas (mirror SDK types for JSON validation)
// =============================================================================

const SkillExampleSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
});

const ServiceLevelAgreementSchema = z.object({
  avgResponseTime: z.string().optional(),
  maxResponseTime: z.string().optional(),
  availability: z.number().min(0).max(1).optional(),
});

const PricingSchema = z.object({
  model: z.enum(['per_request', 'per_unit', 'per_second', 'quoted']),
  unit: z
    .enum(['word', 'character', 'token', 'image', 'minute', 'second'])
    .optional(),
  amount: z.string(),
  currency: z.string(),
  minimum: z.string().optional(),
  escrowRequired: z.boolean().optional(),
});

const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  pricing: PricingSchema.optional(),
  sla: ServiceLevelAgreementSchema.optional(),
  examples: z.array(SkillExampleSchema).optional(),
});

const ProviderSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  contact: z.string().optional(),
});

const AuthenticationSchema = z.object({
  schemes: z.array(z.string()),
  didMethods: z.array(z.string()).optional(),
  instructions: z.string().optional(),
});

const PaymentConfigSchema = z.object({
  methods: z.array(z.enum(['x402', 'escrow', 'streaming'])),
  currencies: z.array(z.string()),
  chains: z.array(z.string()),
  addresses: z.record(z.string()),
  escrowContract: z.string().optional(),
});

const CapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  stateTransitionHistory: z.boolean().optional(),
  x402Payments: z.boolean().optional(),
  escrow: z.boolean().optional(),
});

const TrustEndorsementSchema = z.object({
  endorser: z.string(),
  endorserName: z.string().optional(),
  endorserTrust: z.number().optional(),
  endorsedAt: z.string(),
  message: z.string().optional(),
});

const TrustVerificationSchema = z.object({
  type: z.string(),
  issuer: z.string(),
  issuedAt: z.string(),
  credential: z.string().optional(),
});

const TrustInfoSchema = z.object({
  score: z.number().min(0).max(1),
  tier: z.enum(['new', 'active', 'verified', 'trusted']),
  stake: z
    .object({
      amount: z.string(),
      currency: z.string(),
      lockedUntil: z.string().optional(),
    })
    .optional(),
  endorsements: z.array(TrustEndorsementSchema).optional(),
  verifications: z.array(TrustVerificationSchema).optional(),
});

// =============================================================================
// Top-level agent card config schema
// =============================================================================

/**
 * Zod schema for the agent-card.config.json file.
 *
 * Validates the JSON structure and coerces values to the correct types.
 * All fields are optional so the file can contain only the subset of fields
 * the operator wants to override.
 */
export const AgentCardConfigSchema = z.object({
  // --- base AgentConfig fields (overridable from JSON) ---
  name: z.string().optional(),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
  pricePerTask: z.number().optional(),
  // Security-critical fields intentionally excluded — use env vars only:
  //   privateKey      — secret credential
  //   workspaceDir    — controls filesystem access boundary
  //   allowedCommands — controls which binaries the executor can spawn
  //   apiToken        — task authentication token
  //   requireAuth     — whether to enforce auth/payment
  taskTimeout: z.number().optional(),

  // --- RichAgentConfig extensions ---
  agentId: z.string().optional(),
  agentVersion: z.string().optional(),
  url: z.string().optional(),
  protocolVersion: z.string().optional(),
  provider: ProviderSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  authentication: AuthenticationSchema.optional(),
  richSkills: z.array(SkillSchema).optional(),
  payment: PaymentConfigSchema.optional(),
  trust: TrustInfoSchema.optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  documentationUrl: z.string().url().optional(),
  termsOfServiceUrl: z.string().url().optional(),
  privacyPolicyUrl: z.string().url().optional(),
});

/** Inferred type from the config Zod schema */
export type AgentCardConfigInput = z.infer<typeof AgentCardConfigSchema>;

// =============================================================================
// Default config path
// =============================================================================

/** Default filename for the agent card config */
const DEFAULT_CONFIG_FILENAME = 'agent-card.config.json';

/** Maximum allowed config file size (1 MB) */
const MAX_CONFIG_FILE_SIZE = 1024 * 1024;

// =============================================================================
// Loader
// =============================================================================

/**
 * Load and validate an agent card JSON configuration file.
 *
 * @param configPath - Absolute or relative (to `process.cwd()`) path to the
 *   JSON config file. Defaults to `agent-card.config.json` in `process.cwd()`.
 * @returns Parsed and validated partial config. Returns an empty object when
 *   the config file does not exist so that the caller can fall back to env vars.
 */
export function loadAgentCardConfig(
  configPath?: string,
): Partial<RichAgentConfig> {
  const resolvedPath = resolve(
    process.cwd(),
    configPath ?? DEFAULT_CONFIG_FILENAME,
  );

  let raw: string;
  try {
    const buf = readFileSync(resolvedPath);
    if (buf.length > MAX_CONFIG_FILE_SIZE) {
      throw new Error(
        `Agent card config at ${resolvedPath} is too large (${buf.length} bytes, max ${MAX_CONFIG_FILE_SIZE})`,
      );
    }
    raw = buf.toString('utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse agent card config at ${resolvedPath}: invalid JSON`,
    );
  }

  const result = AgentCardConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid agent card config at ${resolvedPath}:\n${issues}`,
    );
  }

  // Strip undefined values so the result merges cleanly with env-var config
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (value !== undefined) {
      config[key] = value;
    }
  }

  return config as Partial<RichAgentConfig>;
}
