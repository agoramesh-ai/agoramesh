import express, { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server, IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { timingSafeEqual } from 'crypto';
import { ZodError } from 'zod';
import { ClaudeExecutor } from './executor.js';
import { TaskInput, TaskInputSchema, TaskResult, RichAgentConfig } from './types.js';
import { EscrowClient } from './escrow.js';
import { createX402Middleware, type X402Config } from './middleware/x402.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
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
}

/**
 * HTTP + WebSocket server pro příjem tasků z AgentMesh
 */
export class BridgeServer {
  private app: Express;
  private server: Server;
  private wss: WebSocketServer;
  private executor: ClaudeExecutor;
  private config: BridgeServerConfig;
  private pendingTasks: Map<string, TaskInput> = new Map();
  private taskWebSockets: Map<string, WebSocket> = new Map();
  private escrowClient?: EscrowClient;
  private providerDid?: `0x${string}`;
  private requireAuth: boolean;
  private apiToken?: string;
  private x402Config?: X402Config;

  constructor(config: BridgeServerConfig) {
    this.config = config;
    this.apiToken = config.apiToken?.trim() || undefined;
    this.x402Config = config.x402;
    this.requireAuth = config.requireAuth ?? process.env.NODE_ENV === 'production';

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

    // Trust first proxy (nginx) for correct client IP in rate limiting and logs
    this.app.set('trust proxy', 1);

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
      if (this.apiToken && this.isApiTokenValid(req)) {
        return next();
      }

      if (x402Middleware) {
        return x402Middleware(req, res, next);
      }

      return res.status(401).json({ error: 'Unauthorized' });
    };
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
      message: {
        error: 'Too Many Requests',
        message: 'You have exceeded the rate limit. Please try again later.',
      },
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
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', agent: this.config.name });
    });

    // Agent info (A2A compatible capability card)
    const agentCardHandler = (_req: Request, res: Response) => {
      res.json(this.buildCapabilityCard());
    };
    this.app.get('/.well-known/agent.json', agentCardHandler);
    this.app.get('/.well-known/agent-card.json', agentCardHandler);

    // Submit task (REST API)
    const taskAuthMiddleware = this.createTaskAuthMiddleware();
    this.app.post('/task', taskAuthMiddleware, async (req: Request, res: Response) => {
      try {
        const task = TaskInputSchema.parse(req.body);

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

        // Execute async, return acknowledgement
        this.executeTask(task).then(async (result) => {
          this.pendingTasks.delete(task.taskId);

          // Confirm delivery on-chain if escrow was used
          if (task.escrowId && this.escrowClient && result.status === 'completed') {
            try {
              const escrowId = BigInt(task.escrowId);
              const output = result.output || '';
              const txHash = await this.escrowClient.confirmDelivery(escrowId, output);
              console.log(`[Bridge] Delivery confirmed on-chain: ${txHash}`);
            } catch (error) {
              console.error(`[Bridge] Failed to confirm delivery on-chain:`, error);
              // Don't fail the task - the work was completed, just the on-chain confirmation failed
            }
          }

          // Broadcast result via WebSocket or webhook
          this.broadcastResult(result);
        }).catch((error) => {
          console.error(`[Bridge] Unhandled error in task ${task.taskId}:`, error);
          this.pendingTasks.delete(task.taskId);
        });

        res.json({
          accepted: true,
          taskId: task.taskId,
          estimatedTime: this.config.taskTimeout,
        });
      } catch (error) {
        // Use safe error response to prevent information leakage
        const safeError = createSafeErrorResponse(error, 'POST /task');
        res.status(400).json(safeError);
      }
    });

    // Get task status
    this.app.get('/task/:taskId', taskAuthMiddleware, (req: Request, res: Response) => {
      const task = this.pendingTasks.get(req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found or completed' });
      }
      const clientDid = req.headers['x-client-did'] as string;
      if (!clientDid || clientDid !== task.clientDid) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // Only return status, not full task data
      res.json({
        status: 'running',
        taskId: task.taskId,
        type: task.type,
      });
    });

    // Cancel task
    this.app.delete('/task/:taskId', taskAuthMiddleware, (req: Request, res: Response) => {
      const task = this.pendingTasks.get(req.params.taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const clientDid = req.headers['x-client-did'] as string;
      if (!clientDid || clientDid !== task.clientDid) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const cancelled = this.executor.cancelTask(req.params.taskId);
      if (cancelled) {
        this.pendingTasks.delete(req.params.taskId);
        res.json({ cancelled: true });
      } else {
        res.status(404).json({ error: 'Task not found' });
      }
    });
  }

  private setupWebSocket() {
    const MAX_WS_CONNECTIONS = 100;
    this.wss.on('connection', (ws: WebSocket) => {
      if (this.wss!.clients.size > MAX_WS_CONNECTIONS) {
        ws.close(1013, 'Too many connections');
        return;
      }
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
            const task = TaskInputSchema.parse(message.payload);
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
            this.taskWebSockets.set(task.taskId, ws);
            const result = await this.executeTask(task);
            this.pendingTasks.delete(task.taskId);

            // Confirm delivery on-chain if escrow was used
            if (task.escrowId && this.escrowClient && result.status === 'completed') {
              try {
                const escrowId = BigInt(task.escrowId);
                const output = result.output || '';
                const txHash = await this.escrowClient.confirmDelivery(escrowId, output);
                console.log(`[Bridge] WS delivery confirmed on-chain: ${txHash}`);
              } catch (error) {
                console.error(`[Bridge] WS failed to confirm delivery on-chain:`, error);
              }
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

  private async executeTask(task: TaskInput): Promise<TaskResult> {
    console.log(`[Bridge] Executing task ${task.taskId}...`);
    const result = await this.executor.execute(task);
    console.log(`[Bridge] Task ${task.taskId} ${result.status} (${result.duration}ms)`);
    return result;
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

    if (cfg.provider) {
      card.provider = cfg.provider;
    }
    if (cfg.capabilities) {
      card.capabilities = cfg.capabilities;
    }
    if (cfg.authentication) {
      card.authentication = cfg.authentication;
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

    return card;
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

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close();
      this.server.close(() => resolve());
    });
  }
}
