import express, { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server, IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { timingSafeEqual, randomBytes, createHmac } from 'crypto';
import { ZodError } from 'zod';
import { ClaudeExecutor } from './executor.js';
import { ResolvedTaskInput, TaskInputSchema, TaskResult, RichAgentConfig, SandboxInputSchema, MAX_SANDBOX_OUTPUT_LENGTH, SANDBOX_REQUESTS_PER_HOUR, DIDIdentity, FREETIER_ID_PATTERN, TASK_RESULT_TTL, TASK_SYNC_TIMEOUT } from './types.js';
import { EscrowClient } from './escrow.js';
import { createX402Middleware, type X402Config } from './middleware/x402.js';
import { handleA2ARequest, isStreamingMethod, parseA2ARequestEnvelope, handleA2AStreamingRequest, taskResultToA2ATask, validatePart, buildPromptFromParts, partsToAttachments, toWireState, type A2ABridge, type StreamResponseEvent, type JsonRpcResponse, type A2APart, type A2ATask, type TextPart } from './a2a.js';
import { isDIDAuthHeader, parseDIDAuthHeader, verifyDIDSignature } from './did-auth.js';
import { FreeTierLimiter } from './free-tier-limiter.js';
import { TrustStore } from './trust-store.js';
import { createDiscoveryProxy } from './discovery-proxy.js';
import { createTrustEndpoint } from './trust-endpoint.js';
import { GracefulShutdown, type ShutdownMetrics } from './graceful-shutdown.js';
import { retryWithBackoff } from './retry.js';

/** Maximum pending tasks in memory before rejecting new ones */
export const MAX_PENDING_TASKS = 500;

/** Maximum completed task results in memory before evicting oldest */
export const MAX_COMPLETED_TASKS = 1000;

/** Express request with optional DID identity attached by auth middleware */
interface DIDRequest extends Request {
  didIdentity?: DIDIdentity;
}

/**
 * Constant-time token comparison to prevent timing attacks.
 * HMAC both tokens before comparing to eliminate length side-channel.
 */
const HMAC_KEY = randomBytes(32);
function safeCompare(a: string, b: string): boolean {
  const hmacA = createHmac('sha256', HMAC_KEY).update(a).digest();
  const hmacB = createHmac('sha256', HMAC_KEY).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}

// =============================================================================
// Error handling utilities
// =============================================================================

/**
 * Error codes for programmatic error handling.
 * Clients can use these codes to handle errors appropriately.
 */
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  NOT_FOUND = 'NOT_FOUND',
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  RATE_LIMITED = 'RATE_LIMITED',
}

/**
 * Sanitized error response structure.
 * Only contains safe information to expose to clients.
 */
interface SafeErrorResponse {
  error: string;
  code: ErrorCode;
  details?: string[];
}

/**
 * Rich error response with actionable guidance for programmatic agents.
 */
export interface RichError {
  error: string;
  code: ErrorCode;
  details?: string[];
  help?: {
    message: string;
    agentCard?: string;
    documentation?: string;
    authMethods?: string[];
  };
}

/**
 * Build a rich error response with machine-readable code and actionable guidance.
 */
export function buildRichError(
  error: string,
  code: ErrorCode,
  help?: RichError['help'],
  details?: string[]
): RichError {
  const response: RichError = { error, code };
  if (details && details.length > 0) {
    response.details = details;
  }
  if (help) {
    response.help = help;
  }
  return response;
}

/**
 * Sanitize a Zod validation error into a safe client response.
 * Extracts only the field paths and messages, not internal details.
 */
function sanitizeZodError(error: ZodError): SafeErrorResponse {
  const details = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });

  return {
    error: 'Validation failed',
    code: ErrorCode.VALIDATION_ERROR,
    details: details.slice(0, 5), // Limit to 5 errors to prevent info dump
  };
}

/**
 * Create a generic error response without exposing internal details.
 * Logs the full error server-side but returns sanitized response.
 */
function createSafeErrorResponse(
  error: unknown,
  context: string
): SafeErrorResponse {
  const errorSummary =
    error instanceof Error
      ? error.stack || `${error.name}: ${error.message}`
      : String(error);
  console.error(`[Bridge] Error in ${context}: ${errorSummary}`);

  if (error instanceof ZodError) {
    return sanitizeZodError(error);
  }

  // For all other errors, return generic message
  // Never expose raw error messages, stack traces, or internal paths
  return {
    error: 'Invalid request',
    code: ErrorCode.INVALID_INPUT,
  };
}

/**
 * Rate limiting configuration.
 */
export interface RateLimitConfig {
  /** Maximum requests per window (default: 100) */
  maxRequests?: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
  /** Whether rate limiting is enabled (default: true) */
  enabled?: boolean;
}

/**
 * CORS configuration
 */
export interface CorsConfig {
  /** Allowed origins (default: '*') */
  origins?: string | string[];
  /** Whether CORS is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Extended configuration for BridgeServer with optional escrow support
 */
export interface BridgeServerConfig extends RichAgentConfig {
  /** Optional escrow client for payment validation */
  escrowClient?: EscrowClient;
  /** Provider DID (hashed) for escrow validation */
  providerDid?: string;
  /** Rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** CORS configuration */
  cors?: CorsConfig;
  /** WebSocket authentication token (if set, connections require this token) */
  wsAuthToken?: string;
  /** Require auth/payment for task execution (defaults to true in production) */
  requireAuth?: boolean;
  /** Static API token for task authentication (Bearer or x-api-key) */
  apiToken?: string;
  /** Optional x402 payment configuration for task authentication */
  x402?: X402Config;
  /** JSON body size limit (default: '1mb') */
  bodyLimit?: string;
  /** Host to bind to (default: '127.0.0.1') */
  host?: string;
  /** Allowed WebSocket origins (if set, rejects connections from other origins) */
  allowedOrigins?: string[];
  /** P2P node URL for discovery proxy (e.g. https://api.agoramesh.ai) */
  nodeUrl?: string;
  /** Graceful shutdown timeout in milliseconds (default: 30000) */
  shutdownTimeoutMs?: number;
  /** Trust proxy setting for Express (default: 1 in production, false otherwise).
   *  Set via TRUST_PROXY env var. Accepts number, boolean string, or comma-separated IPs. */
  trustProxy?: string | number | boolean;
}

/**
 * HTTP + WebSocket server pro příjem tasků z AgoraMesh
 */
export class BridgeServer {
  private app: Express;
  private server: Server;
  private wss: WebSocketServer;
  private executor: ClaudeExecutor;
  private config: BridgeServerConfig;
  private pendingTasks: Map<string, ResolvedTaskInput> = new Map();
  private completedTasks: Map<string, { result: TaskResult; expiresAt: number }> = new Map();
  private taskOwners: Map<string, string> = new Map();
  private taskResultListeners: Map<string, Array<(result: TaskResult) => void>> = new Map();
  private _syncTimeout: number = TASK_SYNC_TIMEOUT;
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private taskWebSockets: Map<string, WebSocket> = new Map();
  private wsIdentities: WeakMap<WebSocket, string> = new WeakMap();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private escrowClient?: EscrowClient;
  private providerDid?: `0x${string}`;
  private requireAuth: boolean;
  private apiToken?: string;
  private x402Config?: X402Config;
  private freeTierLimiter: FreeTierLimiter = new FreeTierLimiter();
  private trustStore: TrustStore;
  private gracefulShutdown: GracefulShutdown;
  private readonly startedAt: number = Date.now();

  constructor(config: BridgeServerConfig) {
    this.config = config;
    this.apiToken = config.apiToken?.trim() || undefined;
    this.x402Config = config.x402;

    // Initialize trust store for progressive trust (persists to ~/.agoramesh/)
    const homedir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    this.trustStore = new TrustStore(`${homedir}/.agoramesh/trust-store.json`);
    this.requireAuth = config.requireAuth ?? process.env.NODE_ENV === 'production';
    this.gracefulShutdown = new GracefulShutdown({
      timeoutMs: config.shutdownTimeoutMs ?? 30_000,
      onCancel: (taskId) => {
        this.executor.cancelTask(taskId);
        this.pendingTasks.delete(taskId);
      },
    });

    if (this.requireAuth && !this.apiToken && !this.x402Config) {
      throw new Error('Bridge auth required: set BRIDGE_API_TOKEN or x402 config');
    }

    if (this.requireAuth && !this.config.wsAuthToken && this.apiToken) {
      this.config.wsAuthToken = this.apiToken;
    }

    if (this.requireAuth && !this.config.wsAuthToken && !this.x402Config) {
      throw new Error('WebSocket auth token required when task auth is enabled');
    }
    this.app = express();

    // Trust proxy for correct client IP in rate limiting and logs.
    // Configurable via TRUST_PROXY env var (default: 1 in production, false otherwise).
    const trustProxy = config.trustProxy ?? (process.env.NODE_ENV === 'production' ? 1 : false);
    this.app.set('trust proxy', trustProxy);

    // Setup security headers with helmet
    this.setupSecurityHeaders();

    // Setup CORS
    this.setupCors();

    // Setup JSON body parser with size limit (default 1mb)
    const bodyLimit = config.bodyLimit || '1mb';
    this.app.use(express.json({ limit: bodyLimit }));

    // Setup rate limiting
    this.setupRateLimiting();

    this.server = createServer(this.app);

    // Setup WebSocket server with authentication and origin validation
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: 1048576, // 1 MiB
      verifyClient: (config.wsAuthToken || config.allowedOrigins)
        ? (info, callback) => this.verifyWebSocketClient(info, callback)
        : undefined,
    });

    this.executor = new ClaudeExecutor({
      workspaceDir: config.workspaceDir,
      allowedCommands: config.allowedCommands,
      timeout: config.taskTimeout,
    });

    // Escrow integration
    this.escrowClient = config.escrowClient;
    if (config.providerDid) {
      this.providerDid = config.providerDid as `0x${string}`;
    }

    this.setupRoutes();
    this.setupWebSocket();

    // Periodic cleanup of expired completed tasks (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupCompletedTasks(), 5 * 60 * 1000);
  }

  private isApiTokenValid(req: Request): boolean {
    if (!this.apiToken) {
      return false;
    }

    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [scheme, token] = authHeader.split(' ');
      if (scheme === 'Bearer' && token && safeCompare(token, this.apiToken)) {
        return true;
      }
    }

    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && safeCompare(apiKey, this.apiToken)) {
      return true;
    }

    return false;
  }

  private createTaskAuthMiddleware() {
    if (!this.requireAuth && !this.apiToken && !this.x402Config) {
      return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    const x402Middleware = this.x402Config ? createX402Middleware(this.x402Config) : null;

    return (req: Request, res: Response, next: NextFunction) => {
      // Path 1: Static API token (Bearer or x-api-key)
      if (this.apiToken && this.isApiTokenValid(req)) {
        return next();
      }

      // Path 2: x402 payment
      if (x402Middleware) {
        // Only fall through to DID if no x-payment header
        if (req.headers['x-payment']) {
          return x402Middleware(req, res, next);
        }
      }

      // Path 3: DID:key free tier authentication
      const authHeader = req.headers.authorization;
      if (authHeader && isDIDAuthHeader(authHeader)) {
        return this.handleDIDAuth(req, res, next);
      }

      // Path 4: FreeTier simple auth (zero-crypto)
      if (authHeader && authHeader.startsWith('FreeTier ')) {
        return this.handleFreeTierAuth(req, res, next);
      }

      // Path 5 (fallback for x402): if x402 middleware exists and we didn't have a DID header,
      // let x402 middleware handle (will return 402 with payment requirements)
      if (x402Middleware) {
        return x402Middleware(req, res, next);
      }

      return res.status(401).json(buildRichError(
        'Unauthorized',
        ErrorCode.UNAUTHORIZED,
        {
          message: 'Authenticate using one of these methods (simplest first):',
          agentCard: '/.well-known/agent.json',
          documentation: this.config.documentationUrl,
          authMethods: ['freetier', 'did:key', 'bearer', 'x402'],
        }
      ));
    };
  }

  private handleDIDAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization!;

    let parsed: { did: string; timestamp: string; signature: string };
    try {
      parsed = parseDIDAuthHeader(authHeader);
    } catch {
      return res.status(401).json(buildRichError(
        'Invalid DID auth header',
        ErrorCode.UNAUTHORIZED,
        {
          message: 'DID auth header format: "DID <did>:<unix-timestamp>:<base64url-signature>"',
          agentCard: '/.well-known/agent.json',
          authMethods: ['did:key'],
        }
      ));
    }

    const valid = verifyDIDSignature(
      parsed.did,
      parsed.timestamp,
      req.method,
      req.path,
      parsed.signature,
    );

    if (!valid) {
      return res.status(401).json(buildRichError(
        'DID signature verification failed',
        ErrorCode.UNAUTHORIZED,
        {
          message: 'Ensure the signature covers "<timestamp>:<METHOD>:<path>" and the timestamp is within 5 minutes.',
          agentCard: '/.well-known/agent.json',
          authMethods: ['did:key'],
        }
      ));
    }

    // Check free tier limits (use trust-based limits)
    const trustLimits = this.trustStore.getLimitsForDID(parsed.did);
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';
    const check = this.freeTierLimiter.canProceed(parsed.did, clientIP, trustLimits.dailyLimit);
    if (!check.allowed) {
      return res.status(429).json(buildRichError(
        'Free tier limit exceeded',
        ErrorCode.RATE_LIMITED,
        {
          message: check.reason || 'Daily limit reached. Upgrade to paid tier for unlimited access.',
          agentCard: '/.well-known/agent.json',
          authMethods: ['x402', 'bearer'],
        }
      ));
    }

    // Record usage and attach DID identity
    this.freeTierLimiter.recordUsage(parsed.did, clientIP);
    (req as DIDRequest).didIdentity = { did: parsed.did, tier: 'free' } satisfies DIDIdentity;

    return next();
  }

  private handleFreeTierAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization!;
    const identifier = authHeader.slice('FreeTier '.length);

    // Validate identifier format
    if (!FREETIER_ID_PATTERN.test(identifier)) {
      return res.status(401).json(buildRichError(
        'Invalid FreeTier identifier',
        ErrorCode.UNAUTHORIZED,
        {
          message: 'FreeTier identifier must be 1-128 characters: alphanumeric, dash, underscore, or dot.',
          agentCard: '/.well-known/agent.json',
          authMethods: ['freetier'],
        }
      ));
    }

    // Check free tier limits (use trust-based limits)
    const trustLimits = this.trustStore.getLimitsForDID(identifier);
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';
    const check = this.freeTierLimiter.canProceed(identifier, clientIP, trustLimits.dailyLimit);
    if (!check.allowed) {
      return res.status(429).json(buildRichError(
        'Free tier limit exceeded',
        ErrorCode.RATE_LIMITED,
        {
          message: check.reason || 'Daily limit reached. Upgrade to paid tier for unlimited access.',
          agentCard: '/.well-known/agent.json',
          authMethods: ['x402', 'bearer'],
        }
      ));
    }

    // Record usage and attach identity
    this.freeTierLimiter.recordUsage(identifier, clientIP);
    (req as DIDRequest).didIdentity = { did: identifier, tier: 'free' } satisfies DIDIdentity;

    return next();
  }

  /**
   * Setup security headers using helmet
   */
  private setupSecurityHeaders() {
    // Use helmet for security headers
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
          },
        },
        crossOriginEmbedderPolicy: false, // Disable for API compatibility
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
        },
      })
    );
  }

  /**
   * Setup CORS middleware
   */
  private setupCors() {
    const corsConfig = this.config.cors ?? {};
    const enabled = corsConfig.enabled ?? true;

    if (!enabled) {
      return;
    }

    this.app.use(
      cors({
        origin: corsConfig.origins ?? 'http://localhost:3402',
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'x-api-key',
          'x-payment',
          'x-client-did',
        ],
      })
    );
  }

  /**
   * Verify WebSocket client authentication
   */
  private verifyWebSocketClient(
    info: { origin: string; req: IncomingMessage; secure: boolean },
    callback: (result: boolean, code?: number, message?: string) => void
  ) {
    // Check origin if allowedOrigins is configured
    const allowedOrigins = this.config.allowedOrigins;
    if (allowedOrigins && allowedOrigins.length > 0 && info.origin) {
      if (!allowedOrigins.includes(info.origin)) {
        callback(false, 4003, 'Origin not allowed');
        return;
      }
    }

    const authToken = this.config.wsAuthToken;

    if (!authToken) {
      // No auth required
      callback(true);
      return;
    }

    // Check Authorization header
    const authHeader = info.req.headers.authorization;
    if (authHeader) {
      const [scheme, token] = authHeader.split(' ');
      if (scheme === 'Bearer' && token && safeCompare(token, authToken)) {
        callback(true);
        return;
      }
    }

    // Reject unauthorized connection
    callback(false, 4001, 'Unauthorized');
  }

  private setupRateLimiting() {
    const rateLimitConfig = this.config.rateLimit ?? {};
    const enabled = rateLimitConfig.enabled ?? true;

    if (!enabled) {
      console.log('[Bridge] Rate limiting disabled');
      return;
    }

    const limiter = rateLimit({
      windowMs: rateLimitConfig.windowMs ?? 60 * 1000, // 1 minute default
      max: rateLimitConfig.maxRequests ?? 100, // 100 requests per window default
      standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
      legacyHeaders: true, // Also include `X-RateLimit-*` headers
      message: buildRichError(
        'Too Many Requests',
        ErrorCode.RATE_LIMITED,
        {
          message: 'You have exceeded the rate limit. Please try again later.',
        }
      ),
      skip: (req: Request) => {
        // Don't rate limit health checks
        return req.path === '/health';
      },
    });

    this.app.use(limiter);
    console.log(
      `[Bridge] Rate limiting enabled: ${rateLimitConfig.maxRequests ?? 100} req/${(rateLimitConfig.windowMs ?? 60000) / 1000}s`
    );
  }

  private setupRoutes() {
    // Health check — L-3: minimal info for unauthenticated, detailed for authenticated
    this.app.get('/health', (req: Request, res: Response) => {
      const isAuthenticated = this.apiToken && this.isApiTokenValid(req);

      if (isAuthenticated) {
        res.json({
          status: 'ok',
          agent: this.config.name,
          mode: this.executor.isDemoMode ? 'demo' : 'live',
        });
      } else {
        res.json({ status: 'ok' });
      }
    });

    // Discovery proxy — no auth, proxies to P2P node
    this.app.use(createDiscoveryProxy(this.config.nodeUrl));

    // Trust endpoint — no auth, returns local + network trust data
    this.app.use(createTrustEndpoint({
      trustStore: this.trustStore,
      nodeUrl: this.config.nodeUrl,
    }));

    // Agent info (A2A compatible capability card)
    const agentCardHandler = (_req: Request, res: Response) => {
      res.json(this.buildCapabilityCard());
    };
    this.app.get('/.well-known/agent.json', agentCardHandler);
    this.app.get('/.well-known/agent-card.json', agentCardHandler);
    this.app.get('/.well-known/a2a.json', agentCardHandler);

    // Extended agent card (A2A v1.0) — authenticated, includes payment/escrow details
    this.app.get('/extendedAgentCard', this.createTaskAuthMiddleware(), (req: Request, res: Response) => {
      res.json(this.buildExtendedCard());
    });

    // llms.txt — public machine-readable documentation (no auth required)
    this.app.get('/llms.txt', (req: Request, res: Response) => {
      const baseUrl = this.config.url || `${req.protocol}://${req.get('host')}`;
      res.type('text/plain').send(this.buildLlmsTxt(baseUrl));
    });

    // Sandbox endpoint — no auth, strict rate limit
    const sandboxLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour
      max: SANDBOX_REQUESTS_PER_HOUR,
      standardHeaders: true,
      legacyHeaders: true,
      message: buildRichError(
        'Sandbox rate limit exceeded',
        ErrorCode.RATE_LIMITED,
        {
          message: `Sandbox allows ${SANDBOX_REQUESTS_PER_HOUR} requests per hour. Authenticate for unlimited access.`,
          agentCard: '/.well-known/agent.json',
          authMethods: ['bearer', 'x402'],
        }
      ),
    });

    this.app.post('/sandbox', sandboxLimiter, async (req: Request, res: Response) => {
      try {
        const input = SandboxInputSchema.parse(req.body);
        const taskId = `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startTime = Date.now();

        const sandboxTask: ResolvedTaskInput = {
          taskId,
          type: 'prompt',
          prompt: input.prompt,
          timeout: 60,
          clientDid: 'did:sandbox:anonymous',
        };

        const result = await this.executeTask(sandboxTask);
        const output = result.output
          ? result.output.slice(0, MAX_SANDBOX_OUTPUT_LENGTH)
          : undefined;

        res.json({
          taskId,
          status: result.status,
          output,
          duration: Date.now() - startTime,
          sandbox: true,
          limits: {
            promptMaxChars: 500,
            outputMaxChars: MAX_SANDBOX_OUTPUT_LENGTH,
            requestsPerHour: SANDBOX_REQUESTS_PER_HOUR,
          },
        });
      } catch (error) {
        const safeError = createSafeErrorResponse(error, 'POST /sandbox');
        res.status(400).json(safeError);
      }
    });

    // Submit task (REST API)
    const taskAuthMiddleware = this.createTaskAuthMiddleware();

    // A2A JSON-RPC 2.0 handler (shared by POST / and POST /a2a)
    const a2aHandler = async (req: Request, res: Response) => {
      const didIdentity = (req as DIDRequest).didIdentity as DIDIdentity | undefined;
      const bridge = this.buildA2ABridge(didIdentity);

      // Check if request is for a streaming method (SendStreamingMessage, SubscribeToTask)
      const envelope = parseA2ARequestEnvelope(
        req.body,
        req.headers['a2a-version'] as string | undefined,
      );

      // If parsing failed, envelope is a JsonRpcResponse error (no 'method' field)
      if (!('method' in envelope)) {
        res.json(envelope);
        return;
      }

      if (isStreamingMethod(envelope.method)) {
        // SSE streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        const writeEvent = (event: StreamResponseEvent | JsonRpcResponse) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        };

        await handleA2AStreamingRequest(
          envelope.method,
          envelope.params,
          envelope.id,
          bridge,
          writeEvent,
        );

        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      // Standard JSON-RPC response
      const response = await handleA2ARequest(req.body, bridge, {
        a2aVersionHeader: req.headers['a2a-version'] as string | undefined,
      });
      res.json(response);
    };

    // A2A JSON-RPC 2.0 endpoint (POST /) — kept for backward compatibility
    this.app.post('/', taskAuthMiddleware, a2aHandler);

    // A2A JSON-RPC 2.0 endpoint (POST /a2a) — matches agent card a2a.endpoint
    this.app.post('/a2a', taskAuthMiddleware, a2aHandler);

    this.app.post('/task', taskAuthMiddleware, async (req: Request, res: Response) => {
      if (this.gracefulShutdown.isShuttingDown()) {
        return res.status(503).json({
          error: 'Service Unavailable',
          message: 'Server is shutting down, not accepting new tasks',
        });
      }

      if (this.pendingTasks.size >= MAX_PENDING_TASKS) {
        return res.status(503).json(buildRichError(
          'Server at capacity',
          ErrorCode.INTERNAL_ERROR,
          { message: 'Too many pending tasks. Try again later.' },
        ));
      }

      try {
        const parsed = TaskInputSchema.parse(req.body);

        // Auto-generate taskId if not provided
        if (!parsed.taskId) {
          parsed.taskId = `task-${Date.now()}-${randomBytes(4).toString('hex')}`;
        }

        // Auto-fill clientDid from auth identity if not provided
        if (!parsed.clientDid) {
          const identity = (req as DIDRequest).didIdentity;
          parsed.clientDid = identity?.did || 'anonymous';
        }

        // After auto-fill, taskId and clientDid are always present
        const task = parsed as ResolvedTaskInput;

        console.log(`[Bridge] Received task ${task.taskId}: ${task.type}`);

        // Validate escrow if escrowId provided and escrowClient configured
        if (task.escrowId && this.escrowClient && this.providerDid) {
          const escrowId = BigInt(task.escrowId);
          const validation = await this.escrowClient.validateEscrow(escrowId, this.providerDid);

          if (!validation.valid) {
            console.log(`[Bridge] Escrow validation failed: ${validation.error}`);
            return res.status(402).json({
              error: 'Escrow Validation Failed',
              message: validation.error,
            });
          }
          console.log(`[Bridge] Escrow ${task.escrowId} validated successfully`);
        }

        this.pendingTasks.set(task.taskId, task);
        this.taskOwners.set(task.taskId, task.clientDid);
        this.gracefulShutdown.registerTask(task.taskId);

        // M-3: Set up sync mode listener BEFORE calling executeTask
        // This eliminates the race condition where fast tasks complete before the listener is registered
        const waitMode = req.query.wait === 'true';
        let syncResultPromise: Promise<TaskResult> | undefined;
        let _syncReject: ((reason?: unknown) => void) | undefined;

        if (waitMode) {
          const syncTimeout = this._syncTimeout;
          syncResultPromise = new Promise<TaskResult>((resolve, reject) => {
            _syncReject = reject;
            const timer = setTimeout(() => {
              const list = this.taskResultListeners.get(task.taskId);
              if (list) {
                const idx = list.indexOf(resolve);
                if (idx >= 0) list.splice(idx, 1);
                if (list.length === 0) this.taskResultListeners.delete(task.taskId);
              }
              reject(new Error('sync_timeout'));
            }, syncTimeout);

            const listener = (r: TaskResult) => {
              clearTimeout(timer);
              resolve(r);
            };

            const existing = this.taskResultListeners.get(task.taskId);
            if (existing) {
              existing.push(listener);
            } else {
              this.taskResultListeners.set(task.taskId, [listener]);
            }
          });
        }

        // Execute async, return acknowledgement
        const didIdentity = (req as DIDRequest).didIdentity as DIDIdentity | undefined;
        this.executeTask(task).then(async (result) => {
          this.pendingTasks.delete(task.taskId);
          this.gracefulShutdown.completeTask(task.taskId);

          // Store completed result with TTL for polling (with eviction)
          this.storeCompletedTask(task.taskId, result);

          // Notify sync mode listeners
          const listeners = this.taskResultListeners.get(task.taskId);
          if (listeners) {
            for (const listener of listeners) {
              listener(result);
            }
            this.taskResultListeners.delete(task.taskId);
          }

          // Record trust for DID:key authenticated requests
          if (didIdentity) {
            this.recordTrust(didIdentity.did, result);
          }

          // Confirm delivery on-chain if escrow was used (with retry)
          if (task.escrowId && this.escrowClient && result.status === 'completed') {
            await this.confirmEscrowDelivery(task.escrowId, result.output || '', 'REST');
          }

          // Broadcast result via WebSocket or webhook
          this.broadcastResult(result);
        }).catch((error) => {
          console.error(`[Bridge] Unhandled error in task ${task.taskId}:`, error);
          this.pendingTasks.delete(task.taskId);
          this.gracefulShutdown.completeTask(task.taskId);
        });

        // Sync mode: wait for result if ?wait=true
        if (waitMode && syncResultPromise) {
          try {
            const result = await syncResultPromise;

            // Return full result synchronously
            const syncResponse: Record<string, unknown> = {
              taskId: result.taskId,
              status: result.status,
              output: result.output,
              error: result.error,
              duration: result.duration,
            };

            // Include free tier info when authenticated via DID:key
            const freeTierInfo = this.buildFreeTierInfo((req as DIDRequest).didIdentity);
            if (freeTierInfo) {
              syncResponse.freeTier = freeTierInfo;
            }

            return res.status(200).json(syncResponse);
          } catch {
            // Timeout — fall through to 202
          }
        }

        const response: Record<string, unknown> = {
          accepted: true,
          taskId: task.taskId,
          estimatedTime: this.config.taskTimeout,
        };

        // Include free tier info when authenticated via DID:key
        const freeTierInfo = this.buildFreeTierInfo((req as DIDRequest).didIdentity);
        if (freeTierInfo) {
          response.freeTier = freeTierInfo;
        }

        res.status(202)
          .header('Location', `/task/${task.taskId}`)
          .header('Retry-After', '5')
          .json(response);
      } catch (error) {
        // Use safe error response to prevent information leakage
        const safeError = createSafeErrorResponse(error, 'POST /task');
        res.status(400).json(safeError);
      }
    });

    // Get task status (supports polling: pending -> completed/failed -> 404 after TTL)
    this.app.get('/task/:taskId', taskAuthMiddleware, (req: Request<{ taskId: string }>, res: Response) => {
      const taskId = req.params.taskId;
      // Identity from auth middleware (FreeTier or DID:key) and/or x-client-did header
      const pollIdentity = (req as DIDRequest).didIdentity;
      const pollClientDid = req.headers['x-client-did'] as string;

      // Verify owner across all states — accept match on auth identity OR x-client-did
      const owner = this.taskOwners.get(taskId);
      if (owner) {
        const isOwner = (pollIdentity?.did === owner) || (pollClientDid === owner);
        if (!isOwner) {
          return res.status(403).json(buildRichError(
            'Forbidden',
            ErrorCode.FORBIDDEN,
            {
              message: 'Authenticated identity must match the task creator.',
            }
          ));
        }
      }

      // 1. Check pendingTasks -> running
      const pendingTask = this.pendingTasks.get(taskId);
      if (pendingTask) {
        return res.json({
          status: 'running',
          taskId: pendingTask.taskId,
          type: pendingTask.type,
        });
      }

      // 2. Check completedTasks -> return full result (if not expired)
      const completed = this.completedTasks.get(taskId);
      if (completed) {
        if (Date.now() < completed.expiresAt) {
          return res.json(completed.result);
        }
        // Expired — clean up and fall through to 404
        this.completedTasks.delete(taskId);
        this.taskOwners.delete(taskId);
      }

      // 3. Not found
      return res.status(404).json(buildRichError(
        'Task not found',
        ErrorCode.NOT_FOUND,
      ));
    });

    // Cancel task
    this.app.delete('/task/:taskId', taskAuthMiddleware, (req: Request<{ taskId: string }>, res: Response) => {
      const task = this.pendingTasks.get(req.params.taskId);
      if (!task) {
        return res.status(404).json(buildRichError(
          'Task not found',
          ErrorCode.NOT_FOUND,
        ));
      }
      const didIdentityDel = (req as DIDRequest).didIdentity;
      const clientIdDel = didIdentityDel?.did || req.headers['x-client-did'] as string;
      if (!clientIdDel || clientIdDel !== task.clientDid) {
        return res.status(403).json(buildRichError(
          'Forbidden',
          ErrorCode.FORBIDDEN,
          {
            message: 'Authenticated identity must match the task creator.',
          }
        ));
      }
      const cancelled = this.executor.cancelTask(req.params.taskId);
      if (cancelled) {
        this.pendingTasks.delete(req.params.taskId);
        res.json({ cancelled: true });
      } else {
        res.status(404).json(buildRichError(
          'Task not found',
          ErrorCode.NOT_FOUND,
        ));
      }
    });

    // =========================================================================
    // A2A v1.0.0 REST endpoints (Google API-style colon actions)
    // These provide REST alternatives to the JSON-RPC 2.0 endpoint at POST /a2a
    // =========================================================================

    // POST /message:send — create task from A2A message (colon-action)
    // Uses regex route because Express interprets ':send' as a named parameter
    this.app.post(/^\/message:send\/?$/, taskAuthMiddleware, async (req: Request, res: Response) => {
      try {
        const body = req.body as Record<string, unknown>;
        const message = body.message as Record<string, unknown> | undefined;
        if (!message || !message.parts || !Array.isArray(message.parts) || message.parts.length === 0) {
          return res.status(400).json(buildRichError(
            'Missing message.parts',
            ErrorCode.INVALID_INPUT,
            { message: 'Body must include message.parts array with at least one text part.' },
          ));
        }

        // Validate and classify all parts
        const validatedParts: A2APart[] = [];
        for (const rawPart of message.parts as Array<Record<string, unknown>>) {
          const result = validatePart(rawPart);
          if (typeof result === 'string') {
            return res.status(400).json(buildRichError(result, ErrorCode.INVALID_INPUT));
          }
          validatedParts.push(result);
        }

        const hasText = validatedParts.some((p) => p.type === 'text' && (p as TextPart).text.length > 0);
        if (!hasText) {
          return res.status(400).json(buildRichError(
            'No text part found in message',
            ErrorCode.INVALID_INPUT,
          ));
        }

        const prompt = buildPromptFromParts(validatedParts);
        const MAX_PROMPT_LENGTH = 100_000;
        if (prompt.length > MAX_PROMPT_LENGTH) {
          return res.status(400).json(buildRichError(
            `Prompt length exceeds maximum of ${MAX_PROMPT_LENGTH} characters`,
            ErrorCode.INVALID_INPUT,
          ));
        }

        const rawTimeout = typeof body.timeout === 'number' ? body.timeout : 300;
        const timeout = Math.max(1, Math.min(3600, rawTimeout));
        const taskId = `a2a-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const attachments = partsToAttachments(validatedParts);

        const didIdentity = (req as DIDRequest).didIdentity as DIDIdentity | undefined;
        const task: ResolvedTaskInput = {
          taskId,
          type: 'prompt',
          prompt,
          timeout,
          clientDid: didIdentity?.did || 'anonymous',
          ...(attachments.length > 0 ? { attachments } : {}),
        };

        // Content-Type negotiation: SSE if client accepts text/event-stream
        if (req.accepts('text/event-stream')) {
          return this.handleSSETaskExecution(req, res, task, didIdentity);
        }

        // Synchronous JSON response
        const result = await this.submitTask(task);
        if (didIdentity) {
          this.recordTrust(didIdentity.did, result);
        }
        res.json(taskResultToA2ATask(taskId, result));
      } catch (error) {
        const safeError = createSafeErrorResponse(error, 'POST /message:send');
        res.status(400).json(safeError);
      }
    });

    // POST /message:stream — SSE streaming for task creation
    this.app.post(/^\/message:stream\/?$/, taskAuthMiddleware, async (req: Request, res: Response) => {
      try {
        const body = req.body as Record<string, unknown>;
        const message = body.message as Record<string, unknown> | undefined;
        if (!message || !message.parts || !Array.isArray(message.parts) || message.parts.length === 0) {
          return res.status(400).json(buildRichError(
            'Missing message.parts',
            ErrorCode.INVALID_INPUT,
            { message: 'Body must include message.parts array with at least one text part.' },
          ));
        }

        const validatedParts: A2APart[] = [];
        for (const rawPart of message.parts as Array<Record<string, unknown>>) {
          const result = validatePart(rawPart);
          if (typeof result === 'string') {
            return res.status(400).json(buildRichError(result, ErrorCode.INVALID_INPUT));
          }
          validatedParts.push(result);
        }

        const hasText = validatedParts.some((p) => p.type === 'text' && (p as TextPart).text.length > 0);
        if (!hasText) {
          return res.status(400).json(buildRichError(
            'No text part found in message',
            ErrorCode.INVALID_INPUT,
          ));
        }

        const prompt = buildPromptFromParts(validatedParts);
        const MAX_PROMPT_LENGTH = 100_000;
        if (prompt.length > MAX_PROMPT_LENGTH) {
          return res.status(400).json(buildRichError(
            `Prompt length exceeds maximum of ${MAX_PROMPT_LENGTH} characters`,
            ErrorCode.INVALID_INPUT,
          ));
        }

        const rawTimeout = typeof body.timeout === 'number' ? body.timeout : 300;
        const timeout = Math.max(1, Math.min(3600, rawTimeout));
        const taskId = `a2a-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const attachments = partsToAttachments(validatedParts);

        const didIdentity = (req as DIDRequest).didIdentity as DIDIdentity | undefined;
        const task: ResolvedTaskInput = {
          taskId,
          type: 'prompt',
          prompt,
          timeout,
          clientDid: didIdentity?.did || 'anonymous',
          ...(attachments.length > 0 ? { attachments } : {}),
        };

        this.handleSSETaskExecution(req, res, task, didIdentity);
      } catch (error) {
        const safeError = createSafeErrorResponse(error, 'POST /message:stream');
        res.status(400).json(safeError);
      }
    });

    // GET /tasks — ListTasks endpoint (list all tasks with optional status filter)
    this.app.get('/tasks', taskAuthMiddleware, (req: Request, res: Response) => {
      const statusFilter = req.query.status as string | undefined;
      const didIdentity = (req as DIDRequest).didIdentity as DIDIdentity | undefined;
      const clientDid = didIdentity?.did || req.headers['x-client-did'] as string;

      const tasks: Array<A2ATask | { id: string; status: { state: string; timestamp: string } }> = [];

      // Collect pending/running tasks
      if (!statusFilter || statusFilter === 'running') {
        for (const [taskId, task] of this.pendingTasks) {
          // Filter by owner if authenticated
          if (clientDid && this.taskOwners.get(taskId) !== clientDid) continue;
          tasks.push({
            id: taskId,
            status: { state: toWireState('working'), timestamp: new Date().toISOString() },
          });
        }
      }

      // Collect completed tasks
      const now = Date.now();
      if (!statusFilter || statusFilter === 'completed' || statusFilter === 'failed') {
        for (const [taskId, entry] of this.completedTasks) {
          if (now >= entry.expiresAt) continue;
          // Filter by owner if authenticated
          if (clientDid && this.taskOwners.get(taskId) !== clientDid) continue;
          const state = entry.result.status === 'completed' ? 'completed' : 'failed';
          if (statusFilter && statusFilter !== state) continue;
          tasks.push(taskResultToA2ATask(taskId, entry.result));
        }
      }

      res.json({ tasks });
    });

    // GET /tasks/:taskId — alias for GET /task/:taskId (A2A convention)
    this.app.get('/tasks/:taskId', taskAuthMiddleware, (req: Request<{ taskId: string }>, res: Response) => {
      const taskId = req.params.taskId;
      const pollIdentity = (req as DIDRequest).didIdentity;
      const pollClientDid = req.headers['x-client-did'] as string;

      const owner = this.taskOwners.get(taskId);
      if (owner) {
        const isOwner = (pollIdentity?.did === owner) || (pollClientDid === owner);
        if (!isOwner) {
          return res.status(403).json(buildRichError(
            'Forbidden',
            ErrorCode.FORBIDDEN,
            { message: 'Authenticated identity must match the task creator.' },
          ));
        }
      }

      const pendingTask = this.pendingTasks.get(taskId);
      if (pendingTask) {
        return res.json({
          id: taskId,
          status: { state: toWireState('working'), timestamp: new Date().toISOString() },
        } satisfies Partial<A2ATask>);
      }

      const completed = this.completedTasks.get(taskId);
      if (completed) {
        if (Date.now() < completed.expiresAt) {
          return res.json(taskResultToA2ATask(taskId, completed.result));
        }
        this.completedTasks.delete(taskId);
        this.taskOwners.delete(taskId);
      }

      return res.status(404).json(buildRichError('Task not found', ErrorCode.NOT_FOUND));
    });

    // POST /tasks/:id:cancel — cancel task (A2A uses POST, not DELETE)
    this.app.post(/^\/tasks\/([^/:]+):cancel\/?$/, taskAuthMiddleware, (req: Request, res: Response) => {
      const taskId = req.params[0];
      const task = this.pendingTasks.get(taskId);
      if (!task) {
        return res.status(404).json(buildRichError('Task not found', ErrorCode.NOT_FOUND));
      }
      const didIdentity = (req as DIDRequest).didIdentity;
      const clientId = didIdentity?.did || req.headers['x-client-did'] as string;
      if (!clientId || clientId !== task.clientDid) {
        return res.status(403).json(buildRichError(
          'Forbidden',
          ErrorCode.FORBIDDEN,
          { message: 'Authenticated identity must match the task creator.' },
        ));
      }
      const cancelled = this.executor.cancelTask(taskId);
      if (cancelled) {
        this.pendingTasks.delete(taskId);
        res.json({
          id: taskId,
          status: { state: toWireState('canceled'), message: 'Task canceled by client', timestamp: new Date().toISOString() },
        });
      } else {
        res.status(404).json(buildRichError('Task not found', ErrorCode.NOT_FOUND));
      }
    });

    // POST /tasks/:id:subscribe — SSE subscription for task updates
    this.app.post(/^\/tasks\/([^/:]+):subscribe\/?$/, taskAuthMiddleware, (req: Request, res: Response) => {
      const taskId = req.params[0];
      const didIdentity = (req as DIDRequest).didIdentity;
      const clientDid = didIdentity?.did || req.headers['x-client-did'] as string;

      // Verify ownership
      const owner = this.taskOwners.get(taskId);
      if (owner) {
        const isOwner = (didIdentity?.did === owner) || (clientDid === owner);
        if (!isOwner) {
          return res.status(403).json(buildRichError(
            'Forbidden',
            ErrorCode.FORBIDDEN,
            { message: 'Authenticated identity must match the task creator.' },
          ));
        }
      }

      // If task already completed, return the result as a single SSE event
      const completed = this.completedTasks.get(taskId);
      if (completed && Date.now() < completed.expiresAt) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const a2aTask = taskResultToA2ATask(taskId, completed.result);
        res.write(`event: task\ndata: ${JSON.stringify(a2aTask)}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        return res.end();
      }

      // If task not found at all
      if (!this.pendingTasks.has(taskId)) {
        return res.status(404).json(buildRichError('Task not found', ErrorCode.NOT_FOUND));
      }

      // Setup SSE stream for pending task
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Send initial status
      res.write(`event: status\ndata: ${JSON.stringify({ id: taskId, status: { state: toWireState('working'), timestamp: new Date().toISOString() } })}\n\n`);

      // Listen for completion
      const onResult = (result: TaskResult) => {
        const a2aTask = taskResultToA2ATask(taskId, result);
        res.write(`event: task\ndata: ${JSON.stringify(a2aTask)}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      };

      const existing = this.taskResultListeners.get(taskId);
      if (existing) {
        existing.push(onResult);
      } else {
        this.taskResultListeners.set(taskId, [onResult]);
      }

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        res.write(`:heartbeat\n\n`);
      }, 15_000);

      // Cleanup on client disconnect
      req.on('close', () => {
        clearInterval(heartbeat);
        const listeners = this.taskResultListeners.get(taskId);
        if (listeners) {
          const idx = listeners.indexOf(onResult);
          if (idx >= 0) listeners.splice(idx, 1);
          if (listeners.length === 0) this.taskResultListeners.delete(taskId);
        }
      });
    });
  }

  /**
   * Execute a task and stream progress via SSE.
   * Used by POST /message:send (with Accept: text/event-stream) and POST /message:stream.
   */
  private handleSSETaskExecution(req: Request, res: Response, task: ResolvedTaskInput, didIdentity: DIDIdentity | undefined): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send submitted event
    res.write(`event: status\ndata: ${JSON.stringify({ id: task.taskId, status: { state: toWireState('submitted'), timestamp: new Date().toISOString() } })}\n\n`);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`:heartbeat\n\n`);
    }, 15_000);

    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });

    // Send working event and start execution
    res.write(`event: status\ndata: ${JSON.stringify({ id: task.taskId, status: { state: toWireState('working'), timestamp: new Date().toISOString() } })}\n\n`);

    this.submitTask(task).then((result) => {
      if (didIdentity) {
        this.recordTrust(didIdentity.did, result);
      }
      if (!closed) {
        const a2aTask = taskResultToA2ATask(task.taskId, result);
        res.write(`event: task\ndata: ${JSON.stringify(a2aTask)}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        clearInterval(heartbeat);
        res.end();
      }
    }).catch((error) => {
      if (!closed) {
        const msg = error instanceof Error ? error.message : 'Task execution failed';
        res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        clearInterval(heartbeat);
        res.end();
      }
    });
  }

  private setupWebSocket() {
    const MAX_WS_CONNECTIONS = 100;

    // L-5: Heartbeat ping/pong to detect stale connections (30s interval)
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.wss.clients) {
        const ws = client as WebSocket & { isAlive?: boolean };
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (this.wss!.clients.size > MAX_WS_CONNECTIONS) {
        ws.close(1013, 'Too many connections');
        return;
      }

      // H-2: Extract authenticated identity from WS auth token
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const [scheme, token] = authHeader.split(' ');
        if (scheme === 'FreeTier' && token) {
          this.wsIdentities.set(ws, token);
        } else if (scheme === 'Bearer' && token) {
          // Generate a stable identity from the Bearer token
          this.wsIdentities.set(ws, `ws:bearer:${token.slice(0, 8)}`);
        }
      }

      // L-5: Track liveness for heartbeat
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      ws.on('pong', () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      });

      console.log('[Bridge] WebSocket client connected');

      const messageTimestamps: number[] = [];
      const WS_RATE_LIMIT = 10; // max messages per minute
      const WS_RATE_WINDOW = 60000; // 1 minute

      ws.on('message', async (data) => {
        const now = Date.now();
        // Clean old timestamps
        while (messageTimestamps.length > 0 && messageTimestamps[0] < now - WS_RATE_WINDOW) {
          messageTimestamps.shift();
        }
        if (messageTimestamps.length >= WS_RATE_LIMIT) {
          ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' }));
          return;
        }
        messageTimestamps.push(now);

        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'task') {
            if (this.gracefulShutdown.isShuttingDown()) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'SERVICE_UNAVAILABLE',
                message: 'Server is shutting down, not accepting new tasks',
              }));
              return;
            }

            if (this.pendingTasks.size >= MAX_PENDING_TASKS) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'SERVICE_UNAVAILABLE',
                message: 'Server at capacity: too many pending tasks',
              }));
              return;
            }

            const wsParsed = TaskInputSchema.parse(message.payload);

            // Auto-generate taskId if not provided
            if (!wsParsed.taskId) {
              wsParsed.taskId = `task-${Date.now()}-${randomBytes(4).toString('hex')}`;
            }

            // H-2: Auto-fill clientDid from WS authenticated identity
            if (!wsParsed.clientDid) {
              wsParsed.clientDid = this.wsIdentities.get(ws) || 'ws:unauthenticated';
            }

            // After auto-fill, taskId and clientDid are always present
            const task = wsParsed as ResolvedTaskInput;

            console.log(`[Bridge] WS task ${task.taskId}: ${task.type}`);

            // Validate escrow if escrowId provided and escrowClient configured
            if (task.escrowId && this.escrowClient && this.providerDid) {
              const escrowId = BigInt(task.escrowId);
              const validation = await this.escrowClient.validateEscrow(escrowId, this.providerDid);

              if (!validation.valid) {
                console.log(`[Bridge] WS escrow validation failed: ${validation.error}`);
                ws.send(JSON.stringify({
                  type: 'error',
                  code: ErrorCode.PAYMENT_REQUIRED,
                  message: `Escrow validation failed: ${validation.error}`,
                }));
                return;
              }
              console.log(`[Bridge] WS escrow ${task.escrowId} validated successfully`);
            }

            this.pendingTasks.set(task.taskId, task);
            this.taskOwners.set(task.taskId, task.clientDid);
            this.taskWebSockets.set(task.taskId, ws);
            this.gracefulShutdown.registerTask(task.taskId);
            const result = await this.executeTask(task);
            this.pendingTasks.delete(task.taskId);
            this.gracefulShutdown.completeTask(task.taskId);

            // Confirm delivery on-chain if escrow was used (with retry)
            if (task.escrowId && this.escrowClient && result.status === 'completed') {
              await this.confirmEscrowDelivery(task.escrowId, result.output || '', 'WS');
            }

            ws.send(JSON.stringify({ type: 'result', payload: result }));
          }
        } catch (error) {
          // Use safe error response for WebSocket to prevent information leakage
          const safeError = createSafeErrorResponse(error, 'WebSocket message');
          ws.send(JSON.stringify({
            type: 'error',
            code: safeError.code,
            message: safeError.error,
          }));
        }
      });

      ws.on('close', () => {
        console.log('[Bridge] WebSocket client disconnected');
        // Clean up task-ws mappings for this connection
        for (const [taskId, taskWs] of this.taskWebSockets.entries()) {
          if (taskWs === ws) {
            this.taskWebSockets.delete(taskId);
          }
        }
      });
    });
  }

  private async executeTask(task: ResolvedTaskInput): Promise<TaskResult> {
    console.log(`[Bridge] Executing task ${task.taskId}...`);
    const result = await this.executor.execute(task);
    console.log(`[Bridge] Task ${task.taskId} ${result.status} (${result.duration}ms)`);
    return result;
  }

  // A2ABridge interface methods for JSON-RPC handler
  getPendingTask(taskId: string): ResolvedTaskInput | undefined {
    return this.pendingTasks.get(taskId);
  }

  getCompletedTask(taskId: string): TaskResult | undefined {
    const entry = this.completedTasks.get(taskId);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.result;
    }
    return undefined;
  }

  async submitTask(task: ResolvedTaskInput): Promise<TaskResult> {
    if (this.gracefulShutdown.isShuttingDown()) {
      throw new Error('Server is shutting down, not accepting new tasks');
    }
    if (this.pendingTasks.size >= MAX_PENDING_TASKS) {
      throw new Error('Server at capacity: too many pending tasks');
    }
    this.pendingTasks.set(task.taskId, task);
    this.gracefulShutdown.registerTask(task.taskId);
    try {
      const result = await this.executeTask(task);
      this.pendingTasks.delete(task.taskId);
      this.gracefulShutdown.completeTask(task.taskId);
      return result;
    } catch (error) {
      this.pendingTasks.delete(task.taskId);
      this.gracefulShutdown.completeTask(task.taskId);
      throw error;
    }
  }

  /**
   * Build an A2ABridge object wired to this server's task infrastructure.
   * Supports SSE streaming via onTaskComplete for SubscribeToTask.
   */
  private buildA2ABridge(didIdentity: DIDIdentity | undefined): A2ABridge {
    return {
      getPendingTask: (taskId) => this.getPendingTask(taskId),
      getCompletedTask: (taskId) => this.getCompletedTask(taskId),
      submitTask: async (task) => {
        const result = await this.submitTask(task);
        // Store result for SubscribeToTask and GetTask polling
        this.storeCompletedTask(task.taskId, result);
        if (didIdentity) {
          this.recordTrust(didIdentity.did, result);
        }
        return result;
      },
      cancelTask: (taskId) => this.cancelTaskById(taskId),
      getCapabilityCard: () => this.buildCapabilityCard(),
      getStatus: () => ({
        state: 'operational' as const,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        activeTasks: this.pendingTasks.size,
        protocols: ['a2a', 'rest', 'websocket'],
      }),
      onTaskComplete: (taskId, callback) => {
        const existing = this.taskResultListeners.get(taskId);
        if (existing) {
          existing.push(callback);
        } else {
          this.taskResultListeners.set(taskId, [callback]);
        }
        // Return unsubscribe function
        return () => {
          const list = this.taskResultListeners.get(taskId);
          if (list) {
            const idx = list.indexOf(callback);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) this.taskResultListeners.delete(taskId);
          }
        };
      },
    };
  }

  cancelTaskById(taskId: string): boolean {
    const cancelled = this.executor.cancelTask(taskId);
    if (cancelled) {
      this.pendingTasks.delete(taskId);
    }
    return cancelled;
  }

  /**
   * Confirm escrow delivery on-chain with retry.
   * Logs success/failure but never throws -- task completion is not dependent on this.
   */
  private async confirmEscrowDelivery(escrowId: string, output: string, label: string): Promise<void> {
    if (!this.escrowClient) return;
    try {
      const txHash = await retryWithBackoff(
        () => this.escrowClient!.confirmDelivery(BigInt(escrowId), output),
        {
          maxAttempts: 5,
          baseDelayMs: 1000,
          onRetry: (attempt, err) => {
            console.warn(`[Bridge] ${label} escrow ${escrowId} confirmDelivery retry ${attempt}/4: ${err.message}`);
          },
        },
      );
      console.log(`[Bridge] ${label} delivery confirmed on-chain: ${txHash}`);
    } catch (error) {
      console.error(`[Bridge] ${label} failed to confirm delivery on-chain after 5 attempts:`, error);
    }
  }

  /**
   * Build free tier metadata for inclusion in task responses.
   * Returns undefined if the request is not free-tier authenticated.
   */
  private buildFreeTierInfo(identity: DIDIdentity | undefined): Record<string, unknown> | undefined {
    if (!identity) return undefined;
    const limits = this.trustStore.getLimitsForDID(identity.did);
    const profile = this.trustStore.getProfile(identity.did);
    return {
      tier: profile.tier,
      remaining: this.freeTierLimiter.getRemainingQuota(identity.did, limits.dailyLimit),
      dailyLimit: limits.dailyLimit,
    };
  }

  /**
   * Record task outcome in the trust store for progressive trust.
   */
  private recordTrust(did: string, result: TaskResult): void {
    if (result.status === 'completed') {
      this.trustStore.recordCompletion(did);
    } else {
      this.trustStore.recordFailure(did);
    }
    // Periodically save trust data
    this.trustStore.save();
  }

  /**
   * Store a completed task result with size limit enforcement.
   * Evicts oldest entries when exceeding MAX_COMPLETED_TASKS.
   */
  private storeCompletedTask(taskId: string, result: TaskResult): void {
    // Evict oldest entries if at capacity
    while (this.completedTasks.size >= MAX_COMPLETED_TASKS) {
      const oldestKey = this.completedTasks.keys().next().value;
      if (oldestKey !== undefined) {
        this.completedTasks.delete(oldestKey);
        this.taskOwners.delete(oldestKey);
      } else {
        break;
      }
    }
    this.completedTasks.set(taskId, {
      result,
      expiresAt: Date.now() + TASK_RESULT_TTL,
    });
  }

  private cleanupCompletedTasks(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.completedTasks) {
      if (now >= entry.expiresAt) {
        this.completedTasks.delete(taskId);
        this.taskOwners.delete(taskId);
      }
    }
  }

  private broadcastResult(result: TaskResult) {
    const message = JSON.stringify({ type: 'result', payload: result });
    const ws = this.taskWebSockets.get(result.taskId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
    this.taskWebSockets.delete(result.taskId);
  }

  /**
   * Build a full A2A v1.0 capability card from the bridge configuration.
   *
   * When rich config fields (agentId, richSkills, provider, etc.) are present
   * the card includes all A2A metadata. Otherwise it falls back to a minimal
   * but valid card derived from the basic AgentConfig fields.
   */
  private buildCapabilityCard(): Record<string, unknown> {
    const cfg = this.config;

    // Build skills array: prefer richSkills, fall back to basic string[] skills
    const skills = cfg.richSkills
      ? cfg.richSkills
      : cfg.skills.map((s) => ({ id: s, name: s }));

    // Build payment section
    const payment: Record<string, unknown> = cfg.payment
      ? { ...cfg.payment }
      : {
          defaultPricing: {
            model: 'per_request',
            amount: String(cfg.pricePerTask),
            currency: 'USDC',
          },
        };

    const card: Record<string, unknown> = {
      name: cfg.name,
      description: cfg.description,
      version: cfg.agentVersion ?? '1.0.0',
      skills,
      payment,
      metadata: {
        updatedAt: new Date().toISOString(),
      },
    };

    // Add optional rich fields when present
    if (cfg.agentId) {
      card.id = cfg.agentId;
    }
    if (cfg.url) {
      card.url = cfg.url;
    }
    card.protocolVersion = cfg.protocolVersion ?? '1.0';

    // A2A v1.0: supportedInterfaces — auto-derive from url if not explicitly configured
    if (cfg.supportedInterfaces) {
      card.supportedInterfaces = cfg.supportedInterfaces;
    } else if (cfg.url) {
      card.supportedInterfaces = [
        {
          url: cfg.url,
          protocolBinding: 'JSONRPC',
          protocolVersion: card.protocolVersion as string,
        },
      ];
    }

    if (cfg.provider) {
      card.provider = cfg.provider;
    }

    // A2A v1.0: capabilities with extensions
    const capabilities: Record<string, unknown> = cfg.capabilities
      ? { ...cfg.capabilities }
      : {};

    // SSE streaming support (A2A v1.0.0)
    capabilities.streaming = true;

    // Declare AgoraMesh extensions
    if (!capabilities.extensions) {
      capabilities.extensions = [
        { uri: 'https://agoramesh.ai/extensions/trust/v1', required: false },
        { uri: 'https://agoramesh.ai/extensions/payment/v1', required: false },
      ];
    }
    capabilities.extendedAgentCard = true;

    card.capabilities = capabilities;

    // OpenAPI 3.2-style securitySchemes based on configured auth
    const securitySchemes: Record<string, Record<string, unknown>> = {};
    const securityRequirements: Array<Record<string, string[]>> = [];
    const authSchemes = cfg.authentication?.schemes ?? [];

    for (const scheme of authSchemes) {
      if (scheme === 'bearer' || scheme === 'Bearer') {
        securitySchemes['bearer'] = { type: 'http', scheme: 'bearer' };
        securityRequirements.push({ bearer: [] });
      } else if (scheme === 'x402') {
        securitySchemes['x402'] = { type: 'apiKey', in: 'header', name: 'x-payment' };
        securityRequirements.push({ x402: [] });
      } else if (scheme === 'did:key' || scheme === 'did' || scheme === 'DID') {
        securitySchemes['did-key'] = {
          type: 'http',
          scheme: 'DID',
          description: 'DID:key Ed25519 signature auth',
        };
        securityRequirements.push({ 'did-key': [] });
      }
    }

    if (Object.keys(securitySchemes).length > 0) {
      card.securitySchemes = securitySchemes;
      card.securityRequirements = securityRequirements;
    }

    if (cfg.authentication) {
      card.authentication = cfg.authentication;
    }
    if (cfg.freeTier) {
      card.freeTier = cfg.freeTier;
    }
    if (cfg.trust) {
      card.trust = { ...cfg.trust, selfAsserted: true };
    }
    if (cfg.defaultInputModes) {
      card.defaultInputModes = cfg.defaultInputModes;
    }
    if (cfg.defaultOutputModes) {
      card.defaultOutputModes = cfg.defaultOutputModes;
    }
    if (cfg.documentationUrl) {
      card.documentationUrl = cfg.documentationUrl;
    }
    if (cfg.termsOfServiceUrl) {
      card.termsOfServiceUrl = cfg.termsOfServiceUrl;
    }
    if (cfg.privacyPolicyUrl) {
      card.privacyPolicyUrl = cfg.privacyPolicyUrl;
    }
    if (cfg.a2a) {
      card.a2a = cfg.a2a;
    }

    card.mode = this.executor.isDemoMode ? 'demo' : 'live';

    return card;
  }

  /**
   * Build the extended agent card (A2A v1.0).
   * Includes the full public card plus payment/escrow details
   * that are only exposed to authenticated clients.
   */
  private buildExtendedCard(): Record<string, unknown> {
    const card = this.buildCapabilityCard();

    // Add escrow details if available
    if (this.escrowClient && this.providerDid) {
      (card as Record<string, unknown>).escrow = {
        contractAddress: this.config.payment?.escrowContract,
        providerDid: this.config.providerDid,
        supportedTokens: this.config.payment?.currencies ?? ['USDC'],
        chains: this.config.payment?.chains ?? ['base-sepolia'],
      };
    }

    // Add detailed payment info beyond what the public card exposes
    if (this.config.payment) {
      (card as Record<string, unknown>).paymentDetails = {
        addresses: this.config.payment.addresses,
        methods: this.config.payment.methods,
        escrowContract: this.config.payment.escrowContract,
        walletProvisioning: this.config.payment.walletProvisioning,
      };
    }

    return card;
  }

  /**
   * Build llms.txt content following the llmstxt.org specification.
   * Provides machine-readable documentation for AI agents discovering this bridge.
   */
  private buildLlmsTxt(baseUrl: string): string {
    const mode = this.executor.isDemoMode ? 'demo' : 'live';
    return `# AgoraMesh Bridge
> AI coding agent. Submit tasks via HTTP, get results. Free tier — no signup.${mode === 'demo' ? ' Currently in demo mode (returns mock responses).' : ''}

## Endpoints
- Health: GET ${baseUrl}/health
- Agent card: GET ${baseUrl}/.well-known/agent.json
- Submit task (sync): POST ${baseUrl}/task?wait=true
- Submit task (async): POST ${baseUrl}/task
- Poll result: GET ${baseUrl}/task/{taskId}
- Extended card (auth): GET ${baseUrl}/extendedAgentCard
- A2A JSON-RPC: POST ${baseUrl}/a2a
- A2A SSE Streaming: POST ${baseUrl}/a2a (method: SendStreamingMessage or SubscribeToTask)
- A2A REST: POST ${baseUrl}/message:send, POST ${baseUrl}/message:stream
- List tasks: GET ${baseUrl}/tasks
- Get task (A2A): GET ${baseUrl}/tasks/{taskId}
- Cancel task (A2A): POST ${baseUrl}/tasks/{taskId}:cancel
- Subscribe task (A2A): POST ${baseUrl}/tasks/{taskId}:subscribe
- Sandbox (no auth): POST ${baseUrl}/sandbox

## Authentication (simplest first)
FreeTier: \`Authorization: FreeTier <your-agent-id>\`
  No signup, 10 tasks/day, 2000 char output cap. Pick any string as ID.
DID:key: \`Authorization: DID <did>:<timestamp>:<signature>\`
Bearer: \`Authorization: Bearer <token>\`

## Sync Request (recommended)
\`\`\`
POST ${baseUrl}/task?wait=true
Authorization: FreeTier my-agent
Content-Type: application/json

{"type":"prompt","prompt":"Write fibonacci in Python"}
\`\`\`

Response:
\`\`\`
{"taskId":"task-...","status":"completed","output":"...","duration":1234}
\`\`\`

## Async Request (for long tasks)
\`\`\`
POST ${baseUrl}/task
\`\`\`
Returns 202 with \`{"taskId":"task-..."}\`. Poll with:
\`\`\`
GET ${baseUrl}/task/{taskId}
\`\`\`
Returns \`{"status":"pending"}\` or \`{"status":"completed","output":"..."}\`.

## Request Body
Only \`type\` and \`prompt\` are required:
\`\`\`
{"type":"prompt","prompt":"your task here"}
\`\`\`
Optional: \`taskId\` (auto-generated), \`clientDid\` (auto-filled from auth), \`timeout\` (seconds).

## Error Responses
- 400: Invalid request body (JSON with \`error\`, \`code\`, \`details\`)
- 401: Missing or invalid auth header
- 429: Rate limit exceeded (check X-RateLimit-Remaining header)
- 503: Bridge overloaded
`;
  }

  start(port: number): Promise<void> {
    const host = this.config.host || '127.0.0.1';
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        const actualPort = this.getPort();
        console.log(`[Bridge] Server running on http://${host}:${actualPort}`);
        console.log(`[Bridge] Agent: ${this.config.name}`);
        console.log(`[Bridge] Skills: ${this.config.skills.join(', ')}`);
        console.log(`[Bridge] Price: ${this.config.pricePerTask} USDC per task`);
        resolve();
      });
    });
  }

  /**
   * Get the port the server is listening on.
   * Useful when starting with port 0 (random port).
   */
  getPort(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  async stop(): Promise<ShutdownMetrics> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    console.log(`[Bridge] Graceful shutdown initiated (${this.gracefulShutdown.activeTaskCount()} active tasks)`);
    this.gracefulShutdown.initiateShutdown();

    // Stop accepting new HTTP connections
    this.server.close();

    // Drain active tasks (waits up to 30s)
    const metrics = await this.gracefulShutdown.drain();

    // Log shutdown metrics
    console.log(`[Bridge] Shutdown metrics: ${metrics.tasksCompleted} completed, ${metrics.tasksCancelled} cancelled, ${metrics.shutdownDurationMs}ms elapsed${metrics.timedOut ? ' (timed out)' : ''}`);

    // Close WebSocket connections with proper close frames
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    }
    this.wss.close();

    return metrics;
  }
}
