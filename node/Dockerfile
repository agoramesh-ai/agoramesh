# AgentMe Node Dockerfile
# Multi-stage build for security and minimal image size
#
# Build: docker build -t agentme-node .
# Run:   docker run -p 8080:8080 -p 4001:4001 agentme-node

# ==============================================================================
# Build Stage - Rust compilation
# ==============================================================================
FROM rust:latest AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    cmake \
    make \
    perl \
    clang \
    llvm \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create build directory
WORKDIR /build

# Copy manifests first for layer caching
COPY Cargo.toml Cargo.lock ./

# Create dummy source tree matching real module structure so cargo can
# resolve all crate-level pub use re-exports during dependency compilation.
# Each module is an empty file; main.rs is a no-op binary.
RUN mkdir -p src benches && \
    for mod in api arbitration circuit_breaker config contract did discovery \
               error events metrics multichain network persistence plugin \
               rate_limit search trust trust_cache; do \
        echo "" > src/${mod}.rs; \
    done && \
    echo "fn main() {}" > src/main.rs && \
    echo "fn main() {}" > benches/p2p_benchmarks.rs

# Generate a minimal lib.rs that declares all modules (empty) but skips
# pub-use re-exports, so cargo compiles all dependencies without needing
# real source code.
RUN printf '%s\n' \
    'pub mod api;' \
    'pub mod arbitration;' \
    'pub mod circuit_breaker;' \
    'pub mod config;' \
    'pub mod contract;' \
    'pub mod did;' \
    'pub mod discovery;' \
    'pub mod error;' \
    'pub mod events;' \
    'pub mod metrics;' \
    'pub mod multichain;' \
    'pub mod network;' \
    'pub mod persistence;' \
    'pub mod plugin;' \
    'pub mod rate_limit;' \
    'pub mod search;' \
    'pub mod trust;' \
    'pub mod trust_cache;' \
    > src/lib.rs

# Build dependencies only (cached layer)
RUN cargo build --release 2>/dev/null || true && \
    rm -rf src benches target/release/.fingerprint/agentme* \
    target/release/agentme* target/release/deps/agentme* \
    target/release/deps/libagentme*

# Copy actual source and benchmarks
COPY src/ ./src/
COPY benches/ ./benches/

# Build the application
RUN cargo build --release

# Verify the binary exists
RUN ls -la target/release/agentme

# ==============================================================================
# Production Stage - Minimal runtime
# ==============================================================================
FROM debian:trixie-slim AS production

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    tini \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Security: Create non-root user and group
RUN groupadd -g 1001 agentme && \
    useradd -u 1001 -g agentme -s /bin/false agentme

# Create directories
RUN mkdir -p /app/data /app/config && \
    chown -R agentme:agentme /app

# Set working directory
WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/target/release/agentme ./

# Set ownership
RUN chown agentme:agentme ./agentme && \
    chmod +x ./agentme

# Switch to non-root user
USER agentme

# Environment variables with defaults
ENV RUST_LOG=info \
    AGENTME_API_LISTEN=0.0.0.0:8080 \
    AGENTME_P2P_LISTEN=/ip4/0.0.0.0/tcp/4001 \
    AGENTME_DATA_DIR=/app/data \
    AGENTME_NETWORK=mainnet \
    AGENTME_CHAIN_RPC=https://mainnet.base.org

# Expose ports
# 8080 - HTTP API
# 4001 - P2P libp2p
EXPOSE 8080 4001

# Persistent data volume
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1

# Use tini as init system for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the node
CMD ["./agentme", "start"]
