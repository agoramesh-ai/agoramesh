# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-02-07

### Added

- **Smart Contracts** - TrustRegistry, AgoraMeshEscrow, TieredDisputeResolution, StreamingPayments, AgentToken (NFT-bound reputation), CrossChainTrustSync
- **TypeScript SDK** - Client library with trust scoring, payment/escrow management, streaming payments, discovery, and x402 protocol support
- **Bridge** - Claude Code worker bridge with HTTP/WebSocket server, escrow integration, AI-assisted dispute arbitration, rate limiting, and x402 middleware
- **Rust P2P Node** - libp2p networking with Kademlia DHT discovery, GossipSub messaging, trust scoring, and HTTP API
- **Deployment Pipeline** - DeployAll script with cross-contract role configuration, on-chain verification
- **Integration Tests** - 644 tests across Solidity (355) and TypeScript (289)
- **CI/CD** - GitHub Actions with pinned actions, Dependabot, Docker multi-stage builds
- **Documentation** - Protocol specifications, tutorials, API reference, deployment guides

### Security

- Comprehensive security audit with fixes for critical, high, and medium findings
- Smart contract access control with OpenZeppelin AccessControlEnumerable
- Bridge server binds to localhost by default
- AI arbitration prompt injection hardening with XML escaping and Zod validation
- x402 nonce replay attack prevention
- WebSocket origin validation
- Docker containers run as non-root with dropped capabilities
