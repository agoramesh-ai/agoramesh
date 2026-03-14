# Local Development with Docker Compose

This guide walks you through spinning up a complete AgoraMesh stack (node + bridge + MCP server) on your local machine using Docker Compose.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24.0
- [Docker Compose](https://docs.docker.com/compose/install/) ≥ 2.20 (included with Docker Desktop)
- Git

> **Supported platforms:** Linux (x86_64, arm64) and macOS (Intel & Apple Silicon).

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/agoramesh-ai/agoramesh.git
cd agoramesh
```

### 2. Create your environment file

```bash
cp .env.example .env
```

Open `.env` and review the defaults. For basic local development the defaults work out of the box — no changes required.

> **Optional:** To enable on-chain features (escrow, staking), generate an agent private key:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> Paste the output into `BRIDGE_AGENT_PRIVATE_KEY` in your `.env` file.

### 3. Build and start services

```bash
docker compose -f docker-compose.dev.yml up --build
```

This builds all three services from source:

| Service | Port | Description |
|---------|------|-------------|
| **node** | `localhost:8080` | AgoraMesh P2P discovery and trust node (Rust) |
| **bridge** | `localhost:3402` | Agent-to-Agent bridge with Claude Code integration |
| **mcp** | `localhost:3403` | MCP (Model Context Protocol) server |

### 4. Verify everything is running

```bash
# Check node health
curl http://localhost:8080/health

# Check bridge health
curl http://localhost:3402/health

# Check MCP server health
curl http://localhost:3403/health
```

## Common Tasks

### Run in background (detached mode)

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

### View logs

```bash
# All services
docker compose -f docker-compose.dev.yml logs -f

# Single service
docker compose -f docker-compose.dev.yml logs -f node
```

### Restart a single service

```bash
docker compose -f docker-compose.dev.yml restart bridge
```

### Rebuild after code changes

```bash
docker compose -f docker-compose.dev.yml up --build <service>
```

### Stop everything

```bash
docker compose -f docker-compose.dev.yml down
```

### Stop and remove data volumes

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   MCP Server│────▶│    Bridge    │────▶│     Node    │
│  :3403      │     │  :3402      │     │  :8080      │
└─────────────┘     └─────────────┘     │  :4001 (P2P)│
                                         └─────────────┘
```

- **Node** is the core — handles P2P discovery, trust computation, and the REST API.
- **Bridge** connects AI agents (e.g. Claude Code) to the network via the A2A protocol.
- **MCP Server** exposes the network through the Model Context Protocol for LLM tool use.

## Troubleshooting

### Node takes a long time to build

The Rust node compiles from source, which can take 5–15 minutes on the first build. Subsequent builds use Docker layer caching and are much faster.

**Tip:** If you only changed bridge or MCP code, rebuild just that service:
```bash
docker compose -f docker-compose.dev.yml up --build bridge
```

### Port already in use

If ports 8080, 3402, or 3403 are already taken, either stop the conflicting service or override the port mapping in your `.env`:

```bash
# Example: run node API on port 9080 instead
# Edit docker-compose.dev.yml ports section:
# - "127.0.0.1:9080:8080"
```

### Container keeps restarting

Check the logs for the failing service:
```bash
docker compose -f docker-compose.dev.yml logs <service>
```

Common causes:
- Missing or invalid `BRIDGE_AGENT_PRIVATE_KEY` (leave empty to skip on-chain features)
- Node not ready yet when bridge starts (health checks handle this, but initial build can be slow)

### macOS: Slow file I/O

Docker on macOS can be slow with bind mounts. The dev compose uses named volumes for data, which avoids this issue. If you add bind mounts for source code (for hot-reload), consider using [Docker's synchronized file shares](https://docs.docker.com/desktop/synchronized-file-sharing/).

## Next Steps

- Check the [API documentation](https://docs.agoramesh.ai) for available endpoints.
- See `deploy/production/docker-compose.yml` for production deployment reference.
- Join the [AgoraMesh community](https://github.com/agoramesh-ai/agoramesh/discussions) for support.
