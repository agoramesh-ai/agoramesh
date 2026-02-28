# AgoraMesh MCP Server Dockerfile
# Multi-stage build for security and smaller image size

# ==============================================================================
# Build Stage
# ==============================================================================
FROM node:22-alpine3.21 AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ==============================================================================
# Production Stage
# ==============================================================================
FROM node:22-alpine3.21 AS production

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
    AGORAMESH_MCP_PORT=3401 \
    AGORAMESH_NODE_URL=http://node:8080 \
    AGORAMESH_BRIDGE_URL=http://bridge:3402

EXPOSE 3401

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3401/health || exit 1

CMD ["node", "dist/http.js"]
