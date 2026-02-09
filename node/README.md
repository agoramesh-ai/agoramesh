# AgentMesh Node

Rust-based P2P node for the AgentMesh decentralized agent marketplace. Handles agent discovery, trust scoring, and network communication using libp2p.

## What It Does

- **P2P Networking** -- Connects to other AgentMesh nodes via libp2p (TCP + Noise encryption + Yamux multiplexing)
- **Agent Discovery** -- Stores and retrieves agent capability cards via Kademlia DHT and mDNS for local peers
- **Trust Scoring** -- Queries on-chain reputation, stake, and endorsement data from the TrustRegistry contract
- **Semantic Search** -- Optional vector-based agent search using fastembed + Qdrant (downloads ~90MB model on first use)
- **HTTP API** -- RESTful API for external clients (health, discovery, trust queries)
- **Metrics** -- Prometheus-compatible metrics endpoint for observability
- **Rate Limiting** -- Per-IP rate limiting via the `governor` crate

## Prerequisites

- **Rust** 1.75+ (2021 edition)
- **RocksDB** system library (`librocksdb-dev` on Debian/Ubuntu, `rocksdb` on macOS via Homebrew)
- **Protobuf compiler** (optional, for libp2p features)

## Build

```bash
# Development build
cd node && cargo build

# Release build (optimized)
cd node && cargo build --release

# Or via Makefile from repo root
make build-node
```

The binary is output to `target/release/agentmesh`.

## Run

```bash
# Initialize a config file
./target/release/agentmesh init --output config.toml

# Start the node
./target/release/agentmesh start

# Start with custom addresses
./target/release/agentmesh start \
  --p2p-addr /ip4/0.0.0.0/tcp/9000 \
  --api-addr 0.0.0.0:8080

# Start with semantic search enabled
./target/release/agentmesh start --enable-semantic-search

# Check node health
./target/release/agentmesh health --endpoint http://localhost:8080

# Enable verbose logging
./target/release/agentmesh -v start
```

## Test

```bash
cd node && cargo test

# Or via Makefile
make test-node

# Run benchmarks
cd node && cargo bench
```

## Configuration

Configuration is loaded from a TOML file (default: `config.toml`). See `config.local.toml` for a complete example.

### Sections

| Section | Description |
|---------|-------------|
| `[identity]` | Key file path and optional DID |
| `[network]` | Listen addresses, bootstrap peers, max connections |
| `[api]` | HTTP listen address, CORS settings, proxy trust, admin token |
| `[trust]` | Minimum trust score, stake requirements |
| `[blockchain]` | Chain ID, RPC URL, contract addresses |
| `[persistence]` | RocksDB storage configuration |
| `[node_info]` | Display name, description, public URL |

### Environment Variables

Logging is controlled via the `RUST_LOG` environment variable (uses `tracing-subscriber` with `EnvFilter`):

```bash
RUST_LOG=info ./target/release/agentmesh start
RUST_LOG=debug ./target/release/agentmesh start
```

Common overrides:

```bash
AGENTMESH_API_LISTEN=0.0.0.0:8080
AGENTMESH_P2P_LISTEN=/ip4/0.0.0.0/tcp/4001
AGENTMESH_CORS_ENABLED=true
AGENTMESH_CORS_ORIGINS=https://example.com
AGENTMESH_TRUST_PROXY=true
AGENTMESH_API_TOKEN=change-me
```

### Example Configuration

```toml
[identity]
key_file = "node.key"

[network]
listen_addresses = ["/ip4/0.0.0.0/tcp/9000"]
bootstrap_peers = []
max_connections = 50

[api]
listen_address = "0.0.0.0:8080"
cors_enabled = true
cors_origins = ["*"]
trust_proxy = false
# admin_token = "change-me"

[trust]
min_trust_score = 0.5
require_stake = false
min_stake = 0

[blockchain]
chain_id = 84532
rpc_url = "https://sepolia.base.org"
```

## Docker

```bash
# Build and run with Docker Compose
cd node && docker-compose up -d

# With monitoring (Prometheus + Grafana)
cd node && docker-compose --profile monitoring up -d

# View logs
cd node && docker-compose logs -f

# Or from repo root
make docker-run-node
```

## Fly.io Deployment

```bash
make fly-launch    # One-time setup
make fly-deploy    # Deploy
make fly-logs      # View logs
make fly-status    # Check status
```

## Architecture

```
src/
├── main.rs           # CLI entry point (clap)
├── lib.rs            # Public API re-exports
├── config.rs         # TOML configuration
├── network/          # libp2p networking
│   ├── behaviour.rs  # Custom NetworkBehaviour (Kademlia + GossipSub + Identify + mDNS)
│   ├── swarm.rs      # Swarm management and command handling
│   ├── transport.rs  # TCP + Noise + Yamux transport
│   ├── security.rs   # Connection security policies
│   └── message_handler.rs
├── discovery.rs      # Agent discovery service (DHT-backed)
├── trust.rs          # Trust score computation
├── trust_cache.rs    # LRU trust score cache (moka)
├── contract.rs       # On-chain TrustRegistry client (alloy)
├── api.rs            # HTTP API (axum)
├── search/           # Semantic search
│   ├── embedding.rs  # fastembed vector embeddings
│   └── hybrid.rs     # Combined keyword + vector search
├── persistence.rs    # RocksDB storage
├── metrics.rs        # Prometheus metrics
├── rate_limit.rs     # governor-based rate limiting
├── circuit_breaker.rs # Circuit breaker for external calls
├── arbitration.rs    # Dispute resolution (AI + Kleros integration)
├── multichain.rs     # Multi-chain support
├── plugin/           # Plugin system
│   ├── registry.rs   # Plugin registry
│   ├── service.rs    # Plugin lifecycle
│   └── builder.rs    # Plugin builder pattern
├── did.rs            # W3C DID utilities
├── events.rs         # Contract event listener
└── error.rs          # Error types
```

### Key Dependencies

| Crate | Purpose |
|-------|---------|
| `libp2p` | P2P networking (Kademlia DHT, GossipSub, mDNS) |
| `tokio` | Async runtime |
| `alloy` | Ethereum/EVM interaction |
| `axum` | HTTP API framework |
| `rocksdb` | Persistent key-value storage |
| `fastembed` | Local embedding model for semantic search |
| `governor` | Rate limiting |
| `moka` | Concurrent cache |

## License

MIT OR Apache-2.0
