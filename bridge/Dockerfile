# AgentMesh Bridge Dockerfile
# Multi-stage build for security and smaller image size

# ==============================================================================
# Build Stage
# ==============================================================================
FROM node:22-alpine3.21 AS builder

# Set working directory
WORKDIR /app

# Copy SDK first (bridge depends on it)
COPY sdk/package*.json /sdk/
RUN cd /sdk && npm ci
COPY sdk/src/ /sdk/src/
COPY sdk/tsconfig.json /sdk/
RUN cd /sdk && npm run build

# Install bridge dependencies
COPY bridge/package*.json ./
RUN npm ci

# Copy source and build
COPY bridge/tsconfig.json ./
COPY bridge/src/ ./src/

RUN npm run build

# ==============================================================================
# Production Stage
# ==============================================================================
FROM node:22-alpine3.21 AS production

# Security: Create non-root user
RUN addgroup -g 1001 -S agentmesh && \
    adduser -u 1001 -S agentmesh -G agentmesh

# Install Claude CLI (optional - can be mounted from host)
# RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Copy agent card config for rich A2A v1.0 capability card
COPY bridge/agent-card.config.json ./

# Remove dev dependencies for production
RUN npm prune --omit=dev

# Create workspace directory with correct permissions
RUN mkdir -p /workspace && chown -R agentmesh:agentmesh /workspace

# Security: Switch to non-root user
USER agentmesh

# Environment defaults
ENV NODE_ENV=production \
    BRIDGE_PORT=3402 \
    WORKSPACE_DIR=/workspace \
    TASK_TIMEOUT=300

# Expose bridge port
EXPOSE 3402

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3402/health || exit 1

# Start the bridge
CMD ["node", "dist/cli.js"]
