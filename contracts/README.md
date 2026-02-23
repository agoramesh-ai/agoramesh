# AgoraMesh Contracts

Solidity smart contracts for the AgoraMesh trust layer, escrow system, dispute resolution, and supporting infrastructure. Built with [Foundry](https://book.getfoundry.sh/) and [OpenZeppelin](https://www.openzeppelin.com/contracts).

## Contracts

### Core

| Contract | Description |
|----------|-------------|
| **TrustRegistry** | Agent registration, reputation tracking, staking, and endorsements. Central trust layer for the marketplace. |
| **AgoraMeshEscrow** | USDC escrow for agent-to-agent transactions with delivery confirmation and dispute hooks. |
| **TieredDisputeResolution** | Three-tier dispute system: automatic (<$10), AI-assisted ($10-$1000), and community arbitration (>$1000). |

### Payments

| Contract | Description |
|----------|-------------|
| **StreamingPayments** | Time-based USDC payment streams from clients to agents, inspired by Sablier's linear streaming model. |

### Identity & Ownership

| Contract | Description |
|----------|-------------|
| **AgentToken** | ERC-721 NFTs representing AI agent ownership with ERC-2981 royalties and revenue distribution. |
| **NFTBoundReputation** | Reputation scores bound to AgentToken NFTs that transfer with the token. |
| **VerifiedNamespaces** | Organization namespace registry for agent verification (ENS-inspired). |

### Cross-Chain

| Contract | Description |
|----------|-------------|
| **CrossChainTrustSync** | Trust score synchronization across chains (LayerZero V2 OApp-ready). |
| **ChainRegistry** | Multi-chain network configuration registry. |

### Test

| Contract | Description |
|----------|-------------|
| **MockUSDC** | ERC-20 with public mint for local Anvil development. Not for production. |

## Prerequisites

- **[Foundry](https://book.getfoundry.sh/getting-started/installation)** (forge, cast, anvil)
- **Solidity** 0.8.24 (managed by Foundry)

## Build

```bash
cd contracts && forge build

# Or via Makefile
make build-contracts
```

## Test

```bash
cd contracts && forge test

# With verbose output
cd contracts && forge test -vvv

# Run specific test file
cd contracts && forge test --match-path test/TrustRegistry.t.sol

# Gas report
cd contracts && forge test --gas-report

# CI profile (10,000 fuzz runs)
cd contracts && FOUNDRY_PROFILE=ci forge test
```

Test files:

- `TrustRegistry.t.sol` -- Registration, staking, reputation, endorsements
- `AgoraMeshEscrow.t.sol` -- Escrow lifecycle, delivery, disputes
- `DisputeResolution.t.sol` -- Three-tier dispute flows
- `StreamingPayments.t.sol` -- Payment stream creation and withdrawal
- `AgentToken.t.sol` -- NFT minting, transfers, royalties
- `NFTBoundReputation.t.sol` -- Reputation bound to NFTs
- `CrossChainTrustSync.t.sol` -- Cross-chain trust syncing
- `ChainRegistry.t.sol` -- Chain configuration
- `VerifiedNamespaces.t.sol` -- Namespace registration and verification
- `Integration.t.sol` -- End-to-end multi-contract flows
- `Deploy.t.sol` -- Deployment script validation

## Deploy

### Local (Anvil)

```bash
# Start Anvil in another terminal
anvil

# Deploy
make deploy-local
```

Addresses are saved to `../deployments/local.json`.

### Base Sepolia

```bash
# Set environment variables
export DEPLOYER_PRIVATE_KEY=0x...
export BASESCAN_API_KEY=...

# Deploy single set
make deploy-sepolia

# Full deployment with verification
make deploy-testnet-full

# Verify existing deployment
make verify-deployment
```

Addresses are saved to `../deployments/sepolia.json`.

### Base Mainnet

```bash
make deploy-mainnet
```

Requires confirmation prompt, completed security audit, and multisig admin setup.

## Deployed Addresses (Base Sepolia)

| Contract | Address |
|----------|---------|
| TrustRegistry | `0x0eA69D5D2d2B3aB3eF39DE4eF6940940A78ef227` |
| AgoraMeshEscrow | `0xD559cB432F18Dc9Fa8F2BD93d3067Cb8Ad64FdC1` |
| TieredDisputeResolution | `0xe0eCcd65953DfFBa77870e127F356Dd8D97EBeB5` |
| StreamingPayments | `0x2615B0f626736a454922533aF14EaF152ACc20e3` |
| AgentToken | `0xd4e77a44aA5d76fc9d82943778877af119bE13Eb` |
| NFTBoundReputation | `0xC69Ba5f5D9DA38DB8107E9f738a355d1caBA50db` |
| CrossChainTrustSync | `0x8447788B9b316f47A921105279933CAD685cE0Eb` |
| ChainRegistry | `0xd75E14Cb9591D650429e2886d824B242ec5A636f` |
| VerifiedNamespaces | `0xC9883862E0104EA9f43938EeAfE45460E61c4bfE` |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

## Configuration

From `foundry.toml`:

- **Solidity**: 0.8.24 with optimizer (200 runs)
- **Fuzz testing**: 256 runs (default), 10,000 runs (CI)
- **Invariant testing**: 256 runs, depth 15 (default); 1,000 runs, depth 50 (CI)
- **Gas reports**: Enabled for all contracts
- **Formatter**: 120 char line length, 4-space tabs

## Deployment Scripts

| Script | Purpose |
|--------|---------|
| `Deploy.s.sol` | Deploy core contracts (TrustRegistry + Escrow) |
| `DeployAll.s.sol` | Deploy all contracts with permissions and token whitelisting |
| `DeployLocal.s.sol` | Deploy to local Anvil with MockUSDC |
| `SaveDeployment.s.sol` | Deploy and save addresses to JSON |
| `VerifyDeployment.s.sol` | Verify deployed contracts are properly configured |
| `TestnetScenarios.s.sol` | Run test scenarios on testnet |

## Security

All contracts use:

- OpenZeppelin `AccessControlEnumerable` for role-based permissions
- OpenZeppelin `ReentrancyGuard` for reentrancy protection
- OpenZeppelin `SafeERC20` for safe token transfers
- Checks-effects-interactions pattern
- Explicit role separation (ORACLE_ROLE, ARBITER_ROLE, VERIFIER_ROLE)

## License

MIT
