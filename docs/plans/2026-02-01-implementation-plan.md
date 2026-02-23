# AgoraMesh Implementation Plan

**Goal:** Build a working AgoraMesh MVP with Rust P2P node, Solidity smart contracts on Base L2, and TypeScript SDK.

**Architecture:**
- Rust node handles P2P networking (libp2p), agent discovery (Kademlia DHT), and message propagation (GossipSub)
- Solidity contracts on Base L2 manage trust scores, stakes, escrow, and disputes
- TypeScript SDK provides developer-friendly API for agent registration, discovery, and payments

**Tech Stack:**
- Node: Rust 1.75+, libp2p, tokio, alloy
- Contracts: Solidity 0.8.20+, Foundry, OpenZeppelin
- SDK: TypeScript, viem, @x402/axios
- Chain: Base L2 (mainnet: 8453, testnet: 84532)

---

## Phase 0: Project Setup (Week 1)

### Task 0.1: Create Monorepo Structure

**Files:**
- Create: `Makefile`
- Create: `node/Cargo.toml`
- Create: `node/src/lib.rs`
- Create: `contracts/foundry.toml`
- Create: `contracts/src/.gitkeep`
- Create: `sdk/package.json`
- Create: `sdk/tsconfig.json`
- Create: `sdk/src/index.ts`
- Create: `.github/workflows/ci.yml`

**Step 1: Create directory structure**

```bash
mkdir -p node/src contracts/src contracts/test contracts/script sdk/src sdk/test .github/workflows
```

**Step 2: Create root Makefile**

```makefile
# Makefile
.PHONY: all build test lint clean

all: build

# === Node (Rust) ===
build-node:
	cd node && cargo build --release

test-node:
	cd node && cargo test

lint-node:
	cd node && cargo fmt --check && cargo clippy -- -D warnings

# === Contracts (Solidity) ===
build-contracts:
	cd contracts && forge build

test-contracts:
	cd contracts && forge test -vvv

lint-contracts:
	cd contracts && forge fmt --check

deploy-testnet:
	cd contracts && forge script script/Deploy.s.sol --rpc-url base-sepolia --broadcast

deploy-mainnet:
	cd contracts && forge script script/Deploy.s.sol --rpc-url base --broadcast

# === SDK (TypeScript) ===
build-sdk:
	cd sdk && npm run build

test-sdk:
	cd sdk && npm test

lint-sdk:
	cd sdk && npm run lint

# === All ===
build: build-node build-contracts build-sdk

test: test-node test-contracts test-sdk

lint: lint-node lint-contracts lint-sdk

clean:
	cd node && cargo clean
	cd contracts && forge clean
	cd sdk && rm -rf dist node_modules
```

**Step 3: Create Rust node Cargo.toml**

```toml
# node/Cargo.toml
[package]
name = "agoramesh-node"
version = "0.1.0"
edition = "2021"
authors = ["AgoraMesh Team"]
description = "Decentralized P2P node for AgoraMesh protocol"
license = "MIT"
repository = "https://github.com/agoramesh-ai/agoramesh"

[dependencies]
# Async runtime
tokio = { version = "1.35", features = ["full"] }

# libp2p networking
libp2p = { version = "0.54", features = [
    "tokio",
    "dns",
    "tcp",
    "quic",
    "noise",
    "yamux",
    "identify",
    "kad",
    "gossipsub",
    "mdns",
    "request-response",
    "macros"
]}

# Ethereum/Base L2
alloy = { version = "0.8", features = ["full"] }

# Serialization
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# CLI
clap = { version = "4.4", features = ["derive"] }

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# Async utilities
futures = "0.3"
async-trait = "0.1"

# Error handling
thiserror = "1.0"
anyhow = "1.0"

# Config
config = "0.14"

# HTTP server for REST API
axum = "0.7"
tower-http = { version = "0.5", features = ["cors", "trace"] }

[dev-dependencies]
tempfile = "3.10"
tokio-test = "0.4"

[[bin]]
name = "agoramesh"
path = "src/main.rs"
```

**Step 4: Create initial Rust lib.rs**

```rust
// node/src/lib.rs
//! AgoraMesh Node - Decentralized P2P networking for AI agents

pub mod config;
pub mod network;
pub mod discovery;
pub mod trust;
pub mod api;
pub mod error;

pub use error::{Error, Result};
```

**Step 5: Create Rust main.rs**

```rust
// node/src/main.rs
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "agoramesh")]
#[command(about = "AgoraMesh P2P Node", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new node
    Init {
        /// Blockchain to connect to
        #[arg(long, default_value = "base")]
        chain: String,

        /// Data directory
        #[arg(long, default_value = "~/.agoramesh")]
        data_dir: String,
    },
    /// Start the node
    Start {
        /// Port to listen on
        #[arg(long, default_value = "9000")]
        port: u16,

        /// Config file path
        #[arg(long, default_value = "~/.agoramesh/config.yaml")]
        config: String,
    },
    /// Show node health status
    Health,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Init { chain, data_dir } => {
            println!("Initializing AgoraMesh node...");
            println!("Chain: {}", chain);
            println!("Data directory: {}", data_dir);
            // TODO: Implement init logic
        }
        Commands::Start { port, config } => {
            println!("Starting AgoraMesh node on port {}...", port);
            println!("Config: {}", config);
            // TODO: Implement start logic
        }
        Commands::Health => {
            println!("Node Status: Not implemented yet");
        }
    }

    Ok(())
}
```

**Step 6: Create Rust error module**

```rust
// node/src/error.rs
use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Network error: {0}")]
    Network(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Chain error: {0}")]
    Chain(String),

    #[error("Discovery error: {0}")]
    Discovery(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
```

**Step 7: Create placeholder modules**

```rust
// node/src/config.rs
//! Node configuration management

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    pub name: String,
    pub listen_addresses: Vec<String>,
    pub external_addr: Option<String>,
    pub chain: ChainConfig,
    pub discovery: DiscoveryConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub chain_id: u64,
    pub rpc_url: String,
    pub trust_registry: String,
    pub escrow_contract: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryConfig {
    pub bootstrap_peers: Vec<String>,
    pub semantic_search: bool,
    pub dht_replication: u32,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            name: "agoramesh-node".to_string(),
            listen_addresses: vec![
                "/ip4/0.0.0.0/tcp/9000".to_string(),
                "/ip4/0.0.0.0/udp/9000/quic-v1".to_string(),
            ],
            external_addr: None,
            chain: ChainConfig {
                chain_id: 84532, // Base Sepolia
                rpc_url: "https://sepolia.base.org".to_string(),
                trust_registry: String::new(),
                escrow_contract: String::new(),
            },
            discovery: DiscoveryConfig {
                bootstrap_peers: vec![],
                semantic_search: false,
                dht_replication: 20,
            },
        }
    }
}
```

```rust
// node/src/network.rs
//! libp2p networking layer

pub mod swarm;
pub mod transport;
pub mod behaviour;
```

```rust
// node/src/discovery.rs
//! Agent discovery via DHT and semantic search
```

```rust
// node/src/trust.rs
//! Trust layer integration with on-chain registry
```

```rust
// node/src/api.rs
//! REST/WebSocket API for external clients
```

**Step 8: Create Foundry config for contracts**

```toml
# contracts/foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
via_ir = true

[profile.default.fmt]
line_length = 120
tab_width = 4
bracket_spacing = true

[rpc_endpoints]
base = "${BASE_RPC_URL}"
base-sepolia = "https://sepolia.base.org"

[etherscan]
base = { key = "${BASESCAN_API_KEY}", url = "https://api.basescan.org/api" }
base-sepolia = { key = "${BASESCAN_API_KEY}", url = "https://api-sepolia.basescan.org/api" }
```

**Step 9: Create TypeScript SDK package.json**

```json
{
  "name": "@agoramesh/sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for AgoraMesh protocol",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "lint": "eslint src --ext .ts",
    "format": "prettier --write src"
  },
  "dependencies": {
    "viem": "^2.21.0",
    "@x402/axios": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "eslint": "^8.57.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "prettier": "^3.2.0"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/agoramesh-ai/agoramesh"
  }
}
```

**Step 10: Create TypeScript config**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 11: Create SDK entry point**

```typescript
// sdk/src/index.ts
export { AgoraMeshClient, type AgoraMeshClientConfig } from './client';
export { DiscoveryClient, type DiscoverOptions, type Agent } from './discovery';
export { TrustClient, type TrustScore } from './trust';
export { PaymentClient, type PaymentOptions } from './payment';
export { type CapabilityCard, type Skill, type Pricing } from './types';
```

**Step 12: Create GitHub Actions CI**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [master, main]
  pull_request:
    branches: [master, main]

env:
  CARGO_TERM_COLOR: always

jobs:
  rust:
    name: Rust Node
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-action@stable
        with:
          components: rustfmt, clippy

      - name: Cache cargo
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            node/target
          key: ${{ runner.os }}-cargo-${{ hashFiles('node/Cargo.lock') }}

      - name: Check formatting
        run: cd node && cargo fmt --check

      - name: Clippy
        run: cd node && cargo clippy -- -D warnings

      - name: Test
        run: cd node && cargo test

  contracts:
    name: Solidity Contracts
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@v1

      - name: Check formatting
        run: cd contracts && forge fmt --check

      - name: Build
        run: cd contracts && forge build

      - name: Test
        run: cd contracts && forge test -vvv

  sdk:
    name: TypeScript SDK
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: sdk/package-lock.json

      - name: Install dependencies
        run: cd sdk && npm ci

      - name: Lint
        run: cd sdk && npm run lint

      - name: Build
        run: cd sdk && npm run build

      - name: Test
        run: cd sdk && npm test
```

**Step 13: Commit project structure**

```bash
git add -A
git commit -m "chore: initialize monorepo structure

- Add Rust node skeleton (Cargo.toml, main.rs, lib.rs)
- Add Foundry config for Solidity contracts
- Add TypeScript SDK package.json and tsconfig
- Add root Makefile with build/test/lint targets
- Add GitHub Actions CI workflow

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 1: Smart Contracts (Week 2-3)

### Task 1.1: Install Foundry Dependencies

**Step 1: Initialize Foundry and install OpenZeppelin**

```bash
cd contracts
forge init --force
forge install OpenZeppelin/openzeppelin-contracts --no-commit
```

**Step 2: Create remappings.txt**

```
# contracts/remappings.txt
@openzeppelin/=lib/openzeppelin-contracts/
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore(contracts): install OpenZeppelin dependencies"
```

---

### Task 1.2: TrustRegistry Contract

**Files:**
- Create: `contracts/src/TrustRegistry.sol`
- Create: `contracts/src/interfaces/ITrustRegistry.sol`
- Create: `contracts/test/TrustRegistry.t.sol`

**Step 1: Create ITrustRegistry interface**

```solidity
// contracts/src/interfaces/ITrustRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITrustRegistry {
    // === Structs ===

    struct AgentInfo {
        bytes32 didHash;
        address owner;
        string capabilityCardCID;
        uint256 registeredAt;
        bool isActive;
    }

    struct TrustData {
        uint256 reputationScore;     // 0-10000 (basis points)
        uint256 totalTransactions;
        uint256 successfulTransactions;
        uint256 totalVolumeUsd;      // In cents
        uint256 lastActivityTimestamp;
        uint256 stakedAmount;        // USDC (6 decimals)
        uint256 stakeUnlockTime;
    }

    struct Endorsement {
        bytes32 endorserDid;
        bytes32 endorseeDid;
        uint256 timestamp;
        string message;
        bool isActive;
    }

    // === Events ===

    event AgentRegistered(bytes32 indexed didHash, address indexed owner, string capabilityCardCID);
    event AgentUpdated(bytes32 indexed didHash, string newCID);
    event AgentDeactivated(bytes32 indexed didHash);

    event ReputationUpdated(bytes32 indexed didHash, uint256 newScore, uint256 totalTransactions);

    event StakeDeposited(bytes32 indexed didHash, uint256 amount);
    event StakeWithdrawRequested(bytes32 indexed didHash, uint256 amount, uint256 unlockTime);
    event StakeWithdrawn(bytes32 indexed didHash, uint256 amount);
    event StakeSlashed(bytes32 indexed didHash, uint256 amount, bytes32 reason);

    event EndorsementAdded(bytes32 indexed endorser, bytes32 indexed endorsee, string message);
    event EndorsementRevoked(bytes32 indexed endorser, bytes32 indexed endorsee);

    // === Registration ===

    function registerAgent(bytes32 didHash, string calldata capabilityCardCID) external;
    function updateCapabilityCard(bytes32 didHash, string calldata newCID) external;
    function deactivateAgent(bytes32 didHash) external;

    // === Reputation ===

    function recordTransaction(bytes32 agentDid, uint256 volumeUsd, bool successful) external;
    function getReputation(bytes32 didHash) external view returns (uint256 score, uint256 transactions, uint256 successRate);

    // === Staking ===

    function depositStake(bytes32 didHash, uint256 amount) external;
    function requestWithdraw(bytes32 didHash, uint256 amount) external returns (uint256 unlockTime);
    function executeWithdraw(bytes32 didHash) external returns (uint256 withdrawnAmount);
    function slash(bytes32 didHash, uint256 amount, bytes32 disputeId) external;

    // === Endorsements ===

    function endorse(bytes32 endorseeDid, string calldata message) external;
    function revokeEndorsement(bytes32 endorseeDid) external;
    function getEndorsements(bytes32 didHash) external view returns (Endorsement[] memory);

    // === Trust Score ===

    function getTrustScore(bytes32 didHash) external view returns (uint256 compositeScore);
    function getTrustDetails(bytes32 didHash) external view returns (
        uint256 reputationScore,
        uint256 stakeScore,
        uint256 endorsementScore,
        uint256 compositeScore
    );

    // === Views ===

    function getAgent(bytes32 didHash) external view returns (AgentInfo memory);
    function getTrustData(bytes32 didHash) external view returns (TrustData memory);
    function isAgentActive(bytes32 didHash) external view returns (bool);
}
```

**Step 2: Write failing test for agent registration**

```solidity
// contracts/test/TrustRegistry.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TrustRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mock USDC for testing
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 10**6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TrustRegistryTest is Test {
    TrustRegistry public registry;
    MockUSDC public usdc;

    address public alice = address(0x1);
    address public bob = address(0x2);
    address public oracle = address(0x3);
    address public arbiter = address(0x4);

    bytes32 public aliceDid = keccak256("did:agoramesh:base:alice");
    bytes32 public bobDid = keccak256("did:agoramesh:base:bob");
    string public aliceCID = "ipfs://QmAliceCapabilityCard";

    function setUp() public {
        usdc = new MockUSDC();
        registry = new TrustRegistry(address(usdc));

        // Grant roles
        registry.grantRole(registry.ORACLE_ROLE(), oracle);
        registry.grantRole(registry.ARBITER_ROLE(), arbiter);

        // Fund accounts
        usdc.mint(alice, 100_000 * 10**6);
        usdc.mint(bob, 100_000 * 10**6);

        vm.label(alice, "Alice");
        vm.label(bob, "Bob");
    }

    // === Registration Tests ===

    function test_RegisterAgent() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        ITrustRegistry.AgentInfo memory info = registry.getAgent(aliceDid);

        assertEq(info.didHash, aliceDid);
        assertEq(info.owner, alice);
        assertEq(info.capabilityCardCID, aliceCID);
        assertTrue(info.isActive);
    }

    function test_RegisterAgent_EmitEvent() public {
        vm.expectEmit(true, true, false, true);
        emit ITrustRegistry.AgentRegistered(aliceDid, alice, aliceCID);

        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
    }

    function test_RegisterAgent_RevertIfAlreadyRegistered() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.expectRevert("Agent already registered");
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
    }

    function test_UpdateCapabilityCard() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        string memory newCID = "ipfs://QmUpdatedCard";

        vm.prank(alice);
        registry.updateCapabilityCard(aliceDid, newCID);

        ITrustRegistry.AgentInfo memory info = registry.getAgent(aliceDid);
        assertEq(info.capabilityCardCID, newCID);
    }

    function test_UpdateCapabilityCard_RevertIfNotOwner() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.expectRevert("Not agent owner");
        vm.prank(bob);
        registry.updateCapabilityCard(aliceDid, "ipfs://QmHacker");
    }

    // === Staking Tests ===

    function test_DepositStake() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 10**6; // 1000 USDC

        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);
        vm.stopPrank();

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, stakeAmount);
    }

    function test_RequestWithdraw() public {
        // Setup: register and stake
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 10**6;
        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);

        // Request withdraw
        uint256 unlockTime = registry.requestWithdraw(aliceDid, stakeAmount);
        vm.stopPrank();

        // Should be 7 days from now
        assertEq(unlockTime, block.timestamp + 7 days);
    }

    function test_ExecuteWithdraw_AfterCooldown() public {
        // Setup
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 10**6;
        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);
        registry.requestWithdraw(aliceDid, stakeAmount);
        vm.stopPrank();

        // Fast forward past cooldown
        vm.warp(block.timestamp + 7 days + 1);

        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        registry.executeWithdraw(aliceDid);

        uint256 balanceAfter = usdc.balanceOf(alice);
        assertEq(balanceAfter - balanceBefore, stakeAmount);
    }

    function test_ExecuteWithdraw_RevertBeforeCooldown() public {
        // Setup
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 10**6;
        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);
        registry.requestWithdraw(aliceDid, stakeAmount);

        vm.expectRevert("Cooldown not complete");
        registry.executeWithdraw(aliceDid);
        vm.stopPrank();
    }

    // === Trust Score Tests ===

    function test_TrustScore_NewAgent() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 score = registry.getTrustScore(aliceDid);
        assertEq(score, 0); // New agent has 0 trust
    }

    function test_TrustScore_WithStake() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        // Stake 10000 USDC (reference amount)
        uint256 stakeAmount = 10000 * 10**6;
        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);
        vm.stopPrank();

        (,uint256 stakeScore,,) = registry.getTrustDetails(aliceDid);
        assertEq(stakeScore, 10000); // Max stake score
    }

    function test_TrustScore_WithTransactions() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        // Record 10 successful transactions
        for (uint i = 0; i < 10; i++) {
            vm.prank(oracle);
            registry.recordTransaction(aliceDid, 100 * 100, true); // $100 each
        }

        (uint256 repScore,,,) = registry.getTrustDetails(aliceDid);
        assertGt(repScore, 0);
    }

    // === Endorsement Tests ===

    function test_Endorse() public {
        // Register both agents
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);
        vm.prank(bob);
        registry.registerAgent(bobDid, "ipfs://QmBob");

        // Bob endorses Alice
        vm.prank(bob);
        registry.endorse(aliceDid, "Reliable translator");

        ITrustRegistry.Endorsement[] memory endorsements = registry.getEndorsements(aliceDid);
        assertEq(endorsements.length, 1);
        assertEq(endorsements[0].endorserDid, bobDid);
    }

    // === Slashing Tests ===

    function test_Slash() public {
        // Setup
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        uint256 stakeAmount = 1000 * 10**6;
        vm.startPrank(alice);
        usdc.approve(address(registry), stakeAmount);
        registry.depositStake(aliceDid, stakeAmount);
        vm.stopPrank();

        // Slash 10%
        bytes32 disputeId = keccak256("dispute-123");
        uint256 slashAmount = 100 * 10**6;

        vm.prank(arbiter);
        registry.slash(aliceDid, slashAmount, disputeId);

        ITrustRegistry.TrustData memory data = registry.getTrustData(aliceDid);
        assertEq(data.stakedAmount, stakeAmount - slashAmount);
    }

    function test_Slash_RevertIfNotArbiter() public {
        vm.prank(alice);
        registry.registerAgent(aliceDid, aliceCID);

        vm.expectRevert();
        vm.prank(bob);
        registry.slash(aliceDid, 100, keccak256("fake"));
    }
}
```

**Step 3: Run test to verify it fails**

```bash
cd contracts && forge test --match-contract TrustRegistryTest -vvv
```

Expected: Compilation error (TrustRegistry.sol doesn't exist)

**Step 4: Implement TrustRegistry contract**

```solidity
// contracts/src/TrustRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ITrustRegistry.sol";

/// @title AgoraMesh Trust Registry
/// @notice Manages agent registration, reputation, staking, and endorsements
/// @dev ERC-8004 compatible trust layer implementation
contract TrustRegistry is ITrustRegistry, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // === Roles ===
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    // === Constants ===
    uint256 public constant STAKE_COOLDOWN = 7 days;
    uint256 public constant REFERENCE_STAKE = 10_000 * 1e6; // 10,000 USDC
    uint256 public constant REPUTATION_DECAY_PERIOD = 14 days;
    uint256 public constant REPUTATION_DECAY_RATE = 500; // 5% in basis points
    uint256 public constant MAX_ENDORSEMENTS = 10;

    // Weights for trust score calculation (in basis points, total = 10000)
    uint256 public constant REPUTATION_WEIGHT = 5000; // 50%
    uint256 public constant STAKE_WEIGHT = 3000;      // 30%
    uint256 public constant ENDORSEMENT_WEIGHT = 2000; // 20%

    // === State ===
    IERC20 public immutable usdc;

    mapping(bytes32 => AgentInfo) private _agents;
    mapping(bytes32 => TrustData) private _trustData;
    mapping(address => bytes32) private _ownerToDid;

    // endorserDid => endorseeDid => Endorsement
    mapping(bytes32 => mapping(bytes32 => Endorsement)) private _endorsements;
    // endorseeDid => list of endorser DIDs
    mapping(bytes32 => bytes32[]) private _endorserList;

    // === Constructor ===

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // === Registration ===

    function registerAgent(bytes32 didHash, string calldata capabilityCardCID) external override {
        require(_agents[didHash].owner == address(0), "Agent already registered");
        require(bytes(capabilityCardCID).length > 0, "CID required");

        _agents[didHash] = AgentInfo({
            didHash: didHash,
            owner: msg.sender,
            capabilityCardCID: capabilityCardCID,
            registeredAt: block.timestamp,
            isActive: true
        });

        _ownerToDid[msg.sender] = didHash;

        emit AgentRegistered(didHash, msg.sender, capabilityCardCID);
    }

    function updateCapabilityCard(bytes32 didHash, string calldata newCID) external override {
        require(_agents[didHash].owner == msg.sender, "Not agent owner");
        require(_agents[didHash].isActive, "Agent not active");

        _agents[didHash].capabilityCardCID = newCID;

        emit AgentUpdated(didHash, newCID);
    }

    function deactivateAgent(bytes32 didHash) external override {
        require(_agents[didHash].owner == msg.sender, "Not agent owner");

        _agents[didHash].isActive = false;

        emit AgentDeactivated(didHash);
    }

    // === Reputation ===

    function recordTransaction(
        bytes32 agentDid,
        uint256 volumeUsd,
        bool successful
    ) external override onlyRole(ORACLE_ROLE) {
        require(_agents[agentDid].isActive, "Agent not active");

        TrustData storage data = _trustData[agentDid];
        data.totalTransactions += 1;
        if (successful) {
            data.successfulTransactions += 1;
        }
        data.totalVolumeUsd += volumeUsd;
        data.lastActivityTimestamp = block.timestamp;

        // Recalculate reputation score
        data.reputationScore = _calculateReputation(data);

        emit ReputationUpdated(agentDid, data.reputationScore, data.totalTransactions);
    }

    function getReputation(bytes32 didHash) external view override returns (
        uint256 score,
        uint256 transactions,
        uint256 successRate
    ) {
        TrustData storage data = _trustData[didHash];
        score = data.reputationScore;
        transactions = data.totalTransactions;
        successRate = data.totalTransactions > 0
            ? (data.successfulTransactions * 10000) / data.totalTransactions
            : 0;
    }

    // === Staking ===

    function depositStake(bytes32 didHash, uint256 amount) external override nonReentrant {
        require(_agents[didHash].owner == msg.sender, "Not agent owner");
        require(amount > 0, "Amount must be positive");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        _trustData[didHash].stakedAmount += amount;
        _trustData[didHash].stakeUnlockTime = 0; // Reset unlock timer

        emit StakeDeposited(didHash, amount);
    }

    function requestWithdraw(bytes32 didHash, uint256 amount) external override returns (uint256 unlockTime) {
        require(_agents[didHash].owner == msg.sender, "Not agent owner");
        require(_trustData[didHash].stakedAmount >= amount, "Insufficient stake");

        unlockTime = block.timestamp + STAKE_COOLDOWN;
        _trustData[didHash].stakeUnlockTime = unlockTime;

        emit StakeWithdrawRequested(didHash, amount, unlockTime);
    }

    function executeWithdraw(bytes32 didHash) external override nonReentrant returns (uint256 withdrawnAmount) {
        require(_agents[didHash].owner == msg.sender, "Not agent owner");
        require(_trustData[didHash].stakeUnlockTime > 0, "No withdrawal requested");
        require(block.timestamp >= _trustData[didHash].stakeUnlockTime, "Cooldown not complete");

        withdrawnAmount = _trustData[didHash].stakedAmount;
        _trustData[didHash].stakedAmount = 0;
        _trustData[didHash].stakeUnlockTime = 0;

        usdc.safeTransfer(msg.sender, withdrawnAmount);

        emit StakeWithdrawn(didHash, withdrawnAmount);
    }

    function slash(
        bytes32 didHash,
        uint256 amount,
        bytes32 disputeId
    ) external override onlyRole(ARBITER_ROLE) nonReentrant {
        require(_trustData[didHash].stakedAmount >= amount, "Insufficient stake");

        _trustData[didHash].stakedAmount -= amount;

        // Transfer slashed amount to caller (arbiter/dispute contract)
        usdc.safeTransfer(msg.sender, amount);

        emit StakeSlashed(didHash, amount, disputeId);
    }

    // === Endorsements ===

    function endorse(bytes32 endorseeDid, string calldata message) external override {
        bytes32 endorserDid = _ownerToDid[msg.sender];
        require(endorserDid != bytes32(0), "Endorser not registered");
        require(_agents[endorseeDid].isActive, "Endorsee not active");
        require(endorserDid != endorseeDid, "Cannot self-endorse");
        require(!_endorsements[endorserDid][endorseeDid].isActive, "Already endorsed");

        _endorsements[endorserDid][endorseeDid] = Endorsement({
            endorserDid: endorserDid,
            endorseeDid: endorseeDid,
            timestamp: block.timestamp,
            message: message,
            isActive: true
        });

        _endorserList[endorseeDid].push(endorserDid);

        emit EndorsementAdded(endorserDid, endorseeDid, message);
    }

    function revokeEndorsement(bytes32 endorseeDid) external override {
        bytes32 endorserDid = _ownerToDid[msg.sender];
        require(_endorsements[endorserDid][endorseeDid].isActive, "No active endorsement");

        _endorsements[endorserDid][endorseeDid].isActive = false;

        emit EndorsementRevoked(endorserDid, endorseeDid);
    }

    function getEndorsements(bytes32 didHash) external view override returns (Endorsement[] memory) {
        bytes32[] storage endorsers = _endorserList[didHash];
        uint256 activeCount = 0;

        // Count active endorsements
        for (uint256 i = 0; i < endorsers.length && i < MAX_ENDORSEMENTS; i++) {
            if (_endorsements[endorsers[i]][didHash].isActive) {
                activeCount++;
            }
        }

        // Build result array
        Endorsement[] memory result = new Endorsement[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < endorsers.length && idx < activeCount; i++) {
            if (_endorsements[endorsers[i]][didHash].isActive) {
                result[idx] = _endorsements[endorsers[i]][didHash];
                idx++;
            }
        }

        return result;
    }

    // === Trust Score ===

    function getTrustScore(bytes32 didHash) external view override returns (uint256) {
        (,,,uint256 composite) = _getTrustDetails(didHash);
        return composite;
    }

    function getTrustDetails(bytes32 didHash) external view override returns (
        uint256 reputationScore,
        uint256 stakeScore,
        uint256 endorsementScore,
        uint256 compositeScore
    ) {
        return _getTrustDetails(didHash);
    }

    function _getTrustDetails(bytes32 didHash) internal view returns (
        uint256 reputationScore,
        uint256 stakeScore,
        uint256 endorsementScore,
        uint256 compositeScore
    ) {
        TrustData storage data = _trustData[didHash];

        // Reputation: 0-10000
        reputationScore = _calculateReputation(data);

        // Stake: 0-10000 (linear up to REFERENCE_STAKE)
        stakeScore = data.stakedAmount >= REFERENCE_STAKE
            ? 10000
            : (data.stakedAmount * 10000) / REFERENCE_STAKE;

        // Endorsement: 0-10000
        endorsementScore = _calculateEndorsementScore(didHash);

        // Weighted composite
        compositeScore = (
            reputationScore * REPUTATION_WEIGHT +
            stakeScore * STAKE_WEIGHT +
            endorsementScore * ENDORSEMENT_WEIGHT
        ) / 10000;
    }

    function _calculateReputation(TrustData storage data) internal view returns (uint256) {
        if (data.totalTransactions == 0) return 0;

        // Base success rate (0-10000)
        uint256 successRate = (data.successfulTransactions * 10000) / data.totalTransactions;

        // Apply decay if inactive
        if (data.lastActivityTimestamp > 0) {
            uint256 daysSinceActivity = (block.timestamp - data.lastActivityTimestamp) / 1 days;
            uint256 decayPeriods = daysSinceActivity / 14;

            for (uint256 i = 0; i < decayPeriods && successRate > 0; i++) {
                successRate = (successRate * (10000 - REPUTATION_DECAY_RATE)) / 10000;
            }
        }

        return successRate;
    }

    function _calculateEndorsementScore(bytes32 didHash) internal view returns (uint256) {
        bytes32[] storage endorsers = _endorserList[didHash];
        if (endorsers.length == 0) return 0;

        uint256 totalScore = 0;
        uint256 count = 0;

        for (uint256 i = 0; i < endorsers.length && i < MAX_ENDORSEMENTS; i++) {
            Endorsement storage e = _endorsements[endorsers[i]][didHash];
            if (!e.isActive) continue;

            // Get endorser's reputation (simplified - no recursion)
            TrustData storage endorserData = _trustData[e.endorserDid];
            uint256 endorserRep = _calculateReputation(endorserData);

            totalScore += endorserRep / 10; // 10% weight per endorser
            count++;
        }

        return totalScore > 10000 ? 10000 : totalScore;
    }

    // === Views ===

    function getAgent(bytes32 didHash) external view override returns (AgentInfo memory) {
        return _agents[didHash];
    }

    function getTrustData(bytes32 didHash) external view override returns (TrustData memory) {
        return _trustData[didHash];
    }

    function isAgentActive(bytes32 didHash) external view override returns (bool) {
        return _agents[didHash].isActive;
    }
}
```

**Step 5: Run tests to verify they pass**

```bash
cd contracts && forge test --match-contract TrustRegistryTest -vvv
```

Expected: All tests PASS

**Step 6: Commit**

```bash
git add contracts/
git commit -m "feat(contracts): implement TrustRegistry with staking and endorsements

- Agent registration with capability card CID
- Stake deposit/withdraw with 7-day cooldown
- Reputation tracking with decay mechanism
- Endorsement system (max 10 per agent)
- Composite trust score calculation
- Role-based access (Oracle, Arbiter)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 1.3: AgoraMeshEscrow Contract

**Files:**
- Create: `contracts/src/AgoraMeshEscrow.sol`
- Create: `contracts/src/interfaces/IAgoraMeshEscrow.sol`
- Create: `contracts/test/AgoraMeshEscrow.t.sol`

**Step 1: Create IAgoraMeshEscrow interface**

```solidity
// contracts/src/interfaces/IAgoraMeshEscrow.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgoraMeshEscrow {
    enum State {
        AWAITING_DEPOSIT,
        FUNDED,
        DELIVERED,
        DISPUTED,
        RELEASED,
        REFUNDED
    }

    struct Escrow {
        uint256 id;
        bytes32 clientDid;
        bytes32 providerDid;
        address clientAddress;
        address providerAddress;
        uint256 amount;
        address token;
        bytes32 taskHash;
        bytes32 outputHash;
        uint256 deadline;
        State state;
        uint256 createdAt;
        uint256 deliveredAt;
    }

    event EscrowCreated(
        uint256 indexed escrowId,
        bytes32 indexed clientDid,
        bytes32 indexed providerDid,
        uint256 amount,
        uint256 deadline
    );
    event EscrowFunded(uint256 indexed escrowId);
    event TaskDelivered(uint256 indexed escrowId, bytes32 outputHash);
    event EscrowReleased(uint256 indexed escrowId);
    event EscrowRefunded(uint256 indexed escrowId);
    event DisputeInitiated(uint256 indexed escrowId, address initiator);
    event DisputeResolved(uint256 indexed escrowId, bool releasedToProvider, uint256 providerAmount);

    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline
    ) external returns (uint256 escrowId);

    function fundEscrow(uint256 escrowId) external;
    function confirmDelivery(uint256 escrowId, bytes32 outputHash) external;
    function releaseEscrow(uint256 escrowId) external;
    function initiateDispute(uint256 escrowId, bytes calldata evidence) external;
    function resolveDispute(uint256 escrowId, bool releaseToProvider, uint256 providerShare) external;
    function claimTimeout(uint256 escrowId) external;

    function getEscrow(uint256 escrowId) external view returns (Escrow memory);
}
```

**Step 2: Write failing tests**

```solidity
// contracts/test/AgoraMeshEscrow.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AgoraMeshEscrow.sol";
import "../src/TrustRegistry.sol";

contract MockUSDC2 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {
        _mint(msg.sender, 1_000_000 * 10**6);
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AgoraMeshEscrowTest is Test {
    AgoraMeshEscrow public escrow;
    TrustRegistry public registry;
    MockUSDC2 public usdc;

    address public client = address(0x1);
    address public provider = address(0x2);
    address public arbiter = address(0x3);

    bytes32 public clientDid = keccak256("did:agoramesh:base:client");
    bytes32 public providerDid = keccak256("did:agoramesh:base:provider");
    bytes32 public taskHash = keccak256("translate document XYZ");

    uint256 constant AMOUNT = 100 * 10**6; // 100 USDC
    uint256 constant DEADLINE = 1 days;

    function setUp() public {
        usdc = new MockUSDC2();
        registry = new TrustRegistry(address(usdc));
        escrow = new AgoraMeshEscrow(address(registry));

        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);

        // Register agents
        vm.prank(client);
        registry.registerAgent(clientDid, "ipfs://client");
        vm.prank(provider);
        registry.registerAgent(providerDid, "ipfs://provider");

        // Fund client
        usdc.mint(client, 10_000 * 10**6);
    }

    function test_CreateEscrow() public {
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid,
            providerDid,
            provider,
            address(usdc),
            AMOUNT,
            taskHash,
            block.timestamp + DEADLINE
        );

        IAgoraMeshEscrow.Escrow memory e = escrow.getEscrow(escrowId);
        assertEq(e.clientDid, clientDid);
        assertEq(e.providerDid, providerDid);
        assertEq(e.amount, AMOUNT);
        assertEq(uint256(e.state), uint256(IAgoraMeshEscrow.State.AWAITING_DEPOSIT));
    }

    function test_FundAndRelease() public {
        // Create escrow
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), AMOUNT, taskHash,
            block.timestamp + DEADLINE
        );

        // Fund
        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fundEscrow(escrowId);
        vm.stopPrank();

        assertEq(uint256(escrow.getEscrow(escrowId).state), uint256(IAgoraMeshEscrow.State.FUNDED));

        // Provider delivers
        vm.prank(provider);
        escrow.confirmDelivery(escrowId, keccak256("output"));

        // Client releases
        uint256 providerBalanceBefore = usdc.balanceOf(provider);

        vm.prank(client);
        escrow.releaseEscrow(escrowId);

        assertEq(usdc.balanceOf(provider), providerBalanceBefore + AMOUNT);
        assertEq(uint256(escrow.getEscrow(escrowId).state), uint256(IAgoraMeshEscrow.State.RELEASED));
    }

    function test_ClaimTimeout() public {
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), AMOUNT, taskHash,
            block.timestamp + DEADLINE
        );

        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fundEscrow(escrowId);
        vm.stopPrank();

        // Warp past deadline
        vm.warp(block.timestamp + DEADLINE + 1);

        uint256 clientBalanceBefore = usdc.balanceOf(client);

        vm.prank(client);
        escrow.claimTimeout(escrowId);

        assertEq(usdc.balanceOf(client), clientBalanceBefore + AMOUNT);
        assertEq(uint256(escrow.getEscrow(escrowId).state), uint256(IAgoraMeshEscrow.State.REFUNDED));
    }

    function test_DisputeResolution() public {
        vm.prank(client);
        uint256 escrowId = escrow.createEscrow(
            clientDid, providerDid, provider, address(usdc), AMOUNT, taskHash,
            block.timestamp + DEADLINE
        );

        vm.startPrank(client);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fundEscrow(escrowId);
        vm.stopPrank();

        // Initiate dispute
        vm.prank(client);
        escrow.initiateDispute(escrowId, "quality issue");

        assertEq(uint256(escrow.getEscrow(escrowId).state), uint256(IAgoraMeshEscrow.State.DISPUTED));

        // Resolve: 70% to provider, 30% to client
        vm.prank(arbiter);
        escrow.resolveDispute(escrowId, true, 7000);

        assertEq(usdc.balanceOf(provider), 70 * 10**6);
        assertEq(usdc.balanceOf(client), 10_000 * 10**6 - AMOUNT + 30 * 10**6);
    }
}
```

**Step 3: Run tests to verify failure**

```bash
cd contracts && forge test --match-contract AgoraMeshEscrowTest -vvv
```

**Step 4: Implement AgoraMeshEscrow**

```solidity
// contracts/src/AgoraMeshEscrow.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAgoraMeshEscrow.sol";
import "./interfaces/ITrustRegistry.sol";

/// @title AgoraMesh Escrow
/// @notice Manages escrow for agent-to-agent transactions
contract AgoraMeshEscrow is IAgoraMeshEscrow, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");

    uint256 public constant AUTO_RELEASE_DELAY = 24 hours;

    ITrustRegistry public immutable trustRegistry;

    mapping(uint256 => Escrow) private _escrows;
    uint256 public nextEscrowId;

    constructor(address _trustRegistry) {
        trustRegistry = ITrustRegistry(_trustRegistry);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function createEscrow(
        bytes32 clientDid,
        bytes32 providerDid,
        address providerAddress,
        address token,
        uint256 amount,
        bytes32 taskHash,
        uint256 deadline
    ) external override returns (uint256 escrowId) {
        require(amount > 0, "Amount must be positive");
        require(deadline > block.timestamp, "Deadline must be future");
        require(trustRegistry.isAgentActive(clientDid), "Client not active");
        require(trustRegistry.isAgentActive(providerDid), "Provider not active");

        escrowId = nextEscrowId++;

        _escrows[escrowId] = Escrow({
            id: escrowId,
            clientDid: clientDid,
            providerDid: providerDid,
            clientAddress: msg.sender,
            providerAddress: providerAddress,
            amount: amount,
            token: token,
            taskHash: taskHash,
            outputHash: bytes32(0),
            deadline: deadline,
            state: State.AWAITING_DEPOSIT,
            createdAt: block.timestamp,
            deliveredAt: 0
        });

        emit EscrowCreated(escrowId, clientDid, providerDid, amount, deadline);
    }

    function fundEscrow(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.state == State.AWAITING_DEPOSIT, "Invalid state");
        require(msg.sender == e.clientAddress, "Not client");

        IERC20(e.token).safeTransferFrom(msg.sender, address(this), e.amount);
        e.state = State.FUNDED;

        emit EscrowFunded(escrowId);
    }

    function confirmDelivery(uint256 escrowId, bytes32 outputHash) external override {
        Escrow storage e = _escrows[escrowId];
        require(e.state == State.FUNDED, "Invalid state");
        require(msg.sender == e.providerAddress, "Not provider");

        e.outputHash = outputHash;
        e.state = State.DELIVERED;
        e.deliveredAt = block.timestamp;

        emit TaskDelivered(escrowId, outputHash);
    }

    function releaseEscrow(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(
            e.state == State.FUNDED || e.state == State.DELIVERED,
            "Invalid state"
        );
        require(msg.sender == e.clientAddress, "Not client");

        e.state = State.RELEASED;
        IERC20(e.token).safeTransfer(e.providerAddress, e.amount);

        // Record successful transaction
        trustRegistry.recordTransaction(e.providerDid, e.amount / 100, true);

        emit EscrowReleased(escrowId);
    }

    function initiateDispute(uint256 escrowId, bytes calldata /* evidence */) external override {
        Escrow storage e = _escrows[escrowId];
        require(
            e.state == State.FUNDED || e.state == State.DELIVERED,
            "Invalid state"
        );
        require(
            msg.sender == e.clientAddress || msg.sender == e.providerAddress,
            "Not party to escrow"
        );

        e.state = State.DISPUTED;

        emit DisputeInitiated(escrowId, msg.sender);
    }

    function resolveDispute(
        uint256 escrowId,
        bool releaseToProvider,
        uint256 providerShare // Basis points (0-10000)
    ) external override onlyRole(ARBITER_ROLE) nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.state == State.DISPUTED, "Not disputed");
        require(providerShare <= 10000, "Invalid share");

        uint256 providerAmount = (e.amount * providerShare) / 10000;
        uint256 clientAmount = e.amount - providerAmount;

        e.state = releaseToProvider ? State.RELEASED : State.REFUNDED;

        if (providerAmount > 0) {
            IERC20(e.token).safeTransfer(e.providerAddress, providerAmount);
        }
        if (clientAmount > 0) {
            IERC20(e.token).safeTransfer(e.clientAddress, clientAmount);
        }

        // Record transaction result
        bool success = providerShare >= 5000; // >50% = considered successful
        trustRegistry.recordTransaction(e.providerDid, e.amount / 100, success);

        emit DisputeResolved(escrowId, releaseToProvider, providerAmount);
    }

    function claimTimeout(uint256 escrowId) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.state == State.FUNDED, "Invalid state");
        require(block.timestamp > e.deadline, "Deadline not passed");
        require(msg.sender == e.clientAddress, "Not client");

        e.state = State.REFUNDED;
        IERC20(e.token).safeTransfer(e.clientAddress, e.amount);

        // Record failed transaction for provider
        trustRegistry.recordTransaction(e.providerDid, e.amount / 100, false);

        emit EscrowRefunded(escrowId);
    }

    function getEscrow(uint256 escrowId) external view override returns (Escrow memory) {
        return _escrows[escrowId];
    }
}
```

**Step 5: Run tests**

```bash
cd contracts && forge test --match-contract AgoraMeshEscrowTest -vvv
```

**Step 6: Commit**

```bash
git add contracts/
git commit -m "feat(contracts): implement AgoraMeshEscrow

- Escrow lifecycle: create → fund → deliver → release
- Timeout-based automatic refund
- Dispute initiation and resolution
- Integration with TrustRegistry for transaction recording

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 1.4: Deploy Script

**Files:**
- Create: `contracts/script/Deploy.s.sol`
- Create: `contracts/.env.example`

**Step 1: Create deployment script**

```solidity
// contracts/script/Deploy.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/TrustRegistry.sol";
import "../src/AgoraMeshEscrow.sol";

contract Deploy is Script {
    // Base Sepolia USDC
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    // Base Mainnet USDC
    address constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = block.chainid == 8453 ? USDC_MAINNET : USDC_SEPOLIA;

        vm.startBroadcast(deployerPrivateKey);

        // Deploy TrustRegistry
        TrustRegistry registry = new TrustRegistry(usdc);
        console.log("TrustRegistry deployed at:", address(registry));

        // Deploy Escrow
        AgoraMeshEscrow escrow = new AgoraMeshEscrow(address(registry));
        console.log("AgoraMeshEscrow deployed at:", address(escrow));

        // Grant escrow the ORACLE_ROLE to record transactions
        registry.grantRole(registry.ORACLE_ROLE(), address(escrow));
        console.log("Granted ORACLE_ROLE to Escrow");

        vm.stopBroadcast();

        // Output for documentation
        console.log("\n=== Deployment Summary ===");
        console.log("Chain ID:", block.chainid);
        console.log("USDC:", usdc);
        console.log("TrustRegistry:", address(registry));
        console.log("AgoraMeshEscrow:", address(escrow));
    }
}
```

**Step 2: Create .env.example**

```bash
# contracts/.env.example
DEPLOYER_PRIVATE_KEY=0x...
BASE_RPC_URL=https://mainnet.base.org
BASESCAN_API_KEY=...
```

**Step 3: Test deployment locally**

```bash
cd contracts && forge script script/Deploy.s.sol --fork-url https://sepolia.base.org -vvv
```

**Step 4: Commit**

```bash
git add contracts/
git commit -m "feat(contracts): add deployment script for Base L2

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 2: Rust Node Core (Week 4-6)

### Task 2.1: libp2p Swarm Setup

**Files:**
- Create: `node/src/network/swarm.rs`
- Create: `node/src/network/transport.rs`
- Create: `node/src/network/behaviour.rs`
- Modify: `node/src/network/mod.rs`

**Step 1: Create transport configuration**

```rust
// node/src/network/transport.rs
use libp2p::{
    core::upgrade,
    dns, noise, quic, tcp, yamux,
    PeerId, Transport,
};
use std::time::Duration;

pub type BoxedTransport = libp2p::core::transport::Boxed<(PeerId, libp2p::core::muxing::StreamMuxerBox)>;

/// Build the libp2p transport stack
pub fn build_transport(keypair: &libp2p::identity::Keypair) -> std::io::Result<BoxedTransport> {
    // TCP with Noise encryption and Yamux multiplexing
    let tcp_transport = tcp::tokio::Transport::new(tcp::Config::default().nodelay(true))
        .upgrade(upgrade::Version::V1Lazy)
        .authenticate(noise::Config::new(keypair).expect("noise config"))
        .multiplex(yamux::Config::default())
        .timeout(Duration::from_secs(20));

    // QUIC transport
    let quic_transport = quic::tokio::Transport::new(quic::Config::new(keypair));

    // DNS resolution layer
    let transport = dns::tokio::Transport::system(
        libp2p::core::transport::OrTransport::new(quic_transport, tcp_transport),
    )?
    .map(|either, _| match either {
        futures::future::Either::Left((peer_id, muxer)) => (peer_id, libp2p::core::muxing::StreamMuxerBox::new(muxer)),
        futures::future::Either::Right((peer_id, muxer)) => (peer_id, libp2p::core::muxing::StreamMuxerBox::new(muxer)),
    })
    .boxed();

    Ok(transport)
}
```

**Step 2: Create network behaviour**

```rust
// node/src/network/behaviour.rs
use libp2p::{
    gossipsub, identify, kad, mdns,
    swarm::NetworkBehaviour,
    PeerId,
};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

#[derive(NetworkBehaviour)]
pub struct AgoraMeshBehaviour {
    /// Kademlia DHT for agent discovery
    pub kademlia: kad::Behaviour<kad::store::MemoryStore>,
    /// GossipSub for pub/sub messaging
    pub gossipsub: gossipsub::Behaviour,
    /// Identify protocol for peer info exchange
    pub identify: identify::Behaviour,
    /// mDNS for local peer discovery (dev mode)
    pub mdns: mdns::tokio::Behaviour,
}

impl AgoraMeshBehaviour {
    pub fn new(local_peer_id: PeerId, keypair: &libp2p::identity::Keypair) -> Self {
        // Kademlia config
        let store = kad::store::MemoryStore::new(local_peer_id);
        let mut kad_config = kad::Config::default();
        kad_config.set_query_timeout(Duration::from_secs(60));
        let kademlia = kad::Behaviour::with_config(local_peer_id, store, kad_config);

        // GossipSub config
        let message_id_fn = |message: &gossipsub::Message| {
            let mut hasher = DefaultHasher::new();
            message.data.hash(&mut hasher);
            gossipsub::MessageId::from(hasher.finish().to_string())
        };

        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .heartbeat_interval(Duration::from_secs(1))
            .validation_mode(gossipsub::ValidationMode::Strict)
            .message_id_fn(message_id_fn)
            .build()
            .expect("gossipsub config");

        let gossipsub = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(keypair.clone()),
            gossipsub_config,
        )
        .expect("gossipsub behaviour");

        // Identify config
        let identify = identify::Behaviour::new(identify::Config::new(
            "/agoramesh/1.0.0".to_string(),
            keypair.public(),
        ));

        // mDNS
        let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)
            .expect("mdns behaviour");

        Self {
            kademlia,
            gossipsub,
            identify,
            mdns,
        }
    }
}
```

**Step 3: Create swarm manager**

```rust
// node/src/network/swarm.rs
use crate::config::NodeConfig;
use crate::error::{Error, Result};
use crate::network::behaviour::{AgoraMeshBehaviour, AgoraMeshBehaviourEvent};
use crate::network::transport::build_transport;

use libp2p::{
    core::Multiaddr,
    gossipsub::TopicHash,
    identity::Keypair,
    kad::{self, QueryId},
    swarm::{SwarmBuilder, SwarmEvent},
    PeerId, Swarm,
};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// GossipSub topics
pub mod topics {
    pub const DISCOVERY: &str = "/agoramesh/discovery/1.0.0";
    pub const CAPABILITY: &str = "/agoramesh/capability/1.0.0";
    pub const TRUST: &str = "/agoramesh/trust/1.0.0";
}

pub struct SwarmManager {
    swarm: Swarm<AgoraMeshBehaviour>,
    pending_kad_queries: HashMap<QueryId, mpsc::Sender<kad::QueryResult>>,
}

impl SwarmManager {
    pub async fn new(config: &NodeConfig) -> Result<Self> {
        let keypair = Keypair::generate_ed25519();
        let local_peer_id = PeerId::from(keypair.public());

        info!("Local peer ID: {}", local_peer_id);

        let transport = build_transport(&keypair)
            .map_err(|e| Error::Network(e.to_string()))?;

        let behaviour = AgoraMeshBehaviour::new(local_peer_id, &keypair);

        let swarm = SwarmBuilder::with_tokio_executor(transport, behaviour, local_peer_id)
            .build();

        Ok(Self {
            swarm,
            pending_kad_queries: HashMap::new(),
        })
    }

    pub async fn start(&mut self, listen_addresses: &[String]) -> Result<()> {
        // Listen on configured addresses
        for addr_str in listen_addresses {
            let addr: Multiaddr = addr_str
                .parse()
                .map_err(|e| Error::Config(format!("Invalid listen address: {}", e)))?;

            self.swarm
                .listen_on(addr.clone())
                .map_err(|e| Error::Network(e.to_string()))?;

            info!("Listening on {}", addr);
        }

        // Subscribe to topics
        let discovery_topic = libp2p::gossipsub::IdentTopic::new(topics::DISCOVERY);
        self.swarm
            .behaviour_mut()
            .gossipsub
            .subscribe(&discovery_topic)
            .map_err(|e| Error::Network(e.to_string()))?;

        info!("Subscribed to {}", topics::DISCOVERY);

        Ok(())
    }

    pub async fn add_bootstrap_peer(&mut self, addr: &str) -> Result<()> {
        let addr: Multiaddr = addr
            .parse()
            .map_err(|e| Error::Config(format!("Invalid peer address: {}", e)))?;

        // Extract peer ID from multiaddr
        if let Some(peer_id) = addr.iter().find_map(|p| {
            if let libp2p::multiaddr::Protocol::P2p(hash) = p {
                PeerId::from_multihash(hash.into()).ok()
            } else {
                None
            }
        }) {
            self.swarm
                .behaviour_mut()
                .kademlia
                .add_address(&peer_id, addr.clone());

            info!("Added bootstrap peer: {} at {}", peer_id, addr);
        }

        Ok(())
    }

    pub fn local_peer_id(&self) -> &PeerId {
        self.swarm.local_peer_id()
    }

    pub async fn run_event_loop(&mut self) {
        loop {
            match self.swarm.select_next_some().await {
                SwarmEvent::NewListenAddr { address, .. } => {
                    info!("Listening on {:?}", address);
                }
                SwarmEvent::Behaviour(AgoraMeshBehaviourEvent::Mdns(event)) => {
                    self.handle_mdns_event(event);
                }
                SwarmEvent::Behaviour(AgoraMeshBehaviourEvent::Kademlia(event)) => {
                    self.handle_kad_event(event);
                }
                SwarmEvent::Behaviour(AgoraMeshBehaviourEvent::Gossipsub(event)) => {
                    self.handle_gossipsub_event(event);
                }
                SwarmEvent::Behaviour(AgoraMeshBehaviourEvent::Identify(event)) => {
                    self.handle_identify_event(event);
                }
                SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                    debug!("Connected to {}", peer_id);
                }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    debug!("Disconnected from {}", peer_id);
                }
                _ => {}
            }
        }
    }

    fn handle_mdns_event(&mut self, event: libp2p::mdns::Event) {
        use libp2p::mdns::Event;
        match event {
            Event::Discovered(peers) => {
                for (peer_id, addr) in peers {
                    debug!("mDNS discovered: {} at {}", peer_id, addr);
                    self.swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                }
            }
            Event::Expired(peers) => {
                for (peer_id, _) in peers {
                    debug!("mDNS expired: {}", peer_id);
                }
            }
        }
    }

    fn handle_kad_event(&mut self, event: kad::Event) {
        use kad::Event;
        match event {
            Event::OutboundQueryProgressed { id, result, .. } => {
                if let Some(tx) = self.pending_kad_queries.remove(&id) {
                    let _ = tx.try_send(result);
                }
            }
            Event::RoutingUpdated { peer, .. } => {
                debug!("Kademlia routing updated: {}", peer);
            }
            _ => {}
        }
    }

    fn handle_gossipsub_event(&mut self, event: libp2p::gossipsub::Event) {
        use libp2p::gossipsub::Event;
        match event {
            Event::Message { message, .. } => {
                info!(
                    "Received message on {:?}: {} bytes",
                    message.topic,
                    message.data.len()
                );
            }
            Event::Subscribed { peer_id, topic } => {
                debug!("Peer {} subscribed to {}", peer_id, topic);
            }
            _ => {}
        }
    }

    fn handle_identify_event(&mut self, event: libp2p::identify::Event) {
        use libp2p::identify::Event;
        if let Event::Received { peer_id, info } => {
            debug!(
                "Identified peer {}: {:?}",
                peer_id, info.protocols
            );
            // Add peer's addresses to Kademlia
            for addr in info.listen_addrs {
                self.swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
            }
        }
    }
}
```

**Step 4: Update mod.rs**

```rust
// node/src/network/mod.rs
pub mod behaviour;
pub mod swarm;
pub mod transport;

pub use swarm::SwarmManager;
```

**Step 5: Write basic test**

```rust
// node/src/network/swarm.rs (add at bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NodeConfig;

    #[tokio::test]
    async fn test_swarm_creation() {
        let config = NodeConfig::default();
        let manager = SwarmManager::new(&config).await;
        assert!(manager.is_ok());
    }
}
```

**Step 6: Verify compilation**

```bash
cd node && cargo build
```

**Step 7: Commit**

```bash
git add node/
git commit -m "feat(node): implement libp2p swarm with Kademlia and GossipSub

- Transport: TCP + QUIC with Noise encryption
- Kademlia DHT for peer discovery
- GossipSub for pub/sub messaging
- mDNS for local development
- Identify protocol for peer info

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 3: TypeScript SDK (Week 7-8)

### Task 3.1: SDK Client Implementation

**Files:**
- Create: `sdk/src/client.ts`
- Create: `sdk/src/types.ts`
- Create: `sdk/src/discovery.ts`
- Create: `sdk/src/trust.ts`
- Create: `sdk/src/payment.ts`

*[Detailed implementation steps continue...]*

---

## Phase 4: Integration (Week 9-10)

### Task 4.1: E2E Test Suite

*[Integration test implementation...]*

---

## Checkpoints

| Week | Deliverable | Verification |
|------|------------|--------------|
| 1 | Project structure | `make build` passes |
| 2-3 | Contracts | `forge test` passes, deployed to Sepolia |
| 4-6 | Rust node | `cargo test`, node starts and connects to peers |
| 7-8 | TypeScript SDK | `npm test`, can discover agents |
| 9-10 | Integration | E2E tests pass, demo working |

---

## Notes

- Run `make lint` before every commit
- Tag releases: `v0.1.0-alpha`, `v0.1.0-beta`, `v0.1.0`
- Keep CLAUDE.md updated with new learnings
- Document all contract addresses in README after deployment
