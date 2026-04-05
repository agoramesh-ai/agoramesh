# AgoraMesh MCP Server Dockerfile
# Multi-stage build for security and smaller image size

# ==============================================================================
# Build Stage
# ==============================================================================
FROM node:22-alpine3.21 AS builder

WORKDIR /app

# Copy SDK first (MCP depends on it via file:../sdk)
COPY sdk/package*.json /sdk/
RUN cd /sdk && npm ci
COPY sdk/src/ /sdk/src/
COPY sdk/tsconfig.json /sdk/
RUN cd /sdk && npm run build

# Install MCP dependencies
COPY mcp/package*.json ./
RUN npm ci

# Copy source and build
COPY mcp/tsconfig.json ./
COPY mcp/src/ ./src/
RUN npm run build

# ==============================================================================
# Production Stage
# ==============================================================================
FROM node:22-alpine3.21 AS production

# Install tini for proper PID 1 signal handling
RUN apk add --no-cache tini

# Security: Create non-root user
RUN addgroup -g 1001 -S agoramesh && \
    adduser -u 1001 -S agoramesh -G agoramesh

WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Remove dev dependencies for production
RUN npm prune --omit=dev

# Security: Switch to non-root user
USER agoramesh

# Environment defaults
ENV NODE_ENV=production \
    AGORAMESH_MCP_PORT=3403 \
    AGORAMESH_NODE_URL=http://node:8080 \
    AGORAMESH_BRIDGE_URL=http://bridge:3402

EXPOSE 3403

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3403/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/http.js"]
