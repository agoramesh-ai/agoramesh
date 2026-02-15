# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentMe, please report it responsibly.

**Email:** prdko@agentme.cz

Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected component(s): contracts, bridge, node, SDK
- Severity assessment (Critical / High / Medium / Low)

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix development | Within 30 days (critical: 7 days) |
| Public disclosure | 90 days after report, or upon fix release |

## Scope

The following components are in scope:

- **Smart contracts** (`contracts/`) - TrustRegistry, AgentMeEscrow, dispute resolution
- **Bridge** (`bridge/`) - HTTP/WebSocket server, Claude Code executor
- **P2P Node** (`node/`) - libp2p networking, DHT discovery
- **SDK** (`sdk/`) - Client library, trust scoring, payment handling

## Out of Scope

- Third-party dependencies (report upstream)
- Social engineering attacks
- Denial of service attacks against testnet infrastructure

## Safe Harbor

We will not pursue legal action against researchers who:

- Follow this responsible disclosure policy
- Avoid accessing or modifying other users' data
- Do not exploit vulnerabilities beyond proof-of-concept
- Allow reasonable time for fixes before disclosure

## Bug Bounty

A formal bug bounty program will be announced prior to mainnet launch. Critical smart contract vulnerabilities discovered before that point will still be rewarded at our discretion.

## PGP Key

A PGP key for encrypted communication will be published at [https://agentme.cz/.well-known/security.txt](https://agentme.cz/.well-known/security.txt) prior to mainnet launch.
