# Contracts Setup

This directory contains the AgentMe smart contracts built with [Foundry](https://book.getfoundry.sh/).

## Prerequisites

### Install Foundry

Foundry is required to build, test, and deploy the contracts.

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash

# Restart your terminal or run:
source ~/.bashrc  # or ~/.zshrc

# Install the Foundry toolchain
foundryup
```

Verify installation:
```bash
forge --version
```

### Install Dependencies

After Foundry is installed, run the following from this directory:

```bash
# Initialize Foundry (if not already done)
forge init --force

# Install OpenZeppelin contracts
forge install OpenZeppelin/openzeppelin-contracts --no-commit
```

## Project Structure

```
contracts/
├── src/           # Contract source files
├── test/          # Foundry tests
├── script/        # Deployment scripts
├── lib/           # Dependencies (OpenZeppelin, etc.)
├── foundry.toml   # Foundry configuration
└── remappings.txt # Import path mappings
```

## Commands

```bash
# Build contracts
forge build

# Run tests
forge test

# Run tests with verbosity
forge test -vvv

# Gas report
forge test --gas-report

# Format code
forge fmt

# Deploy to testnet (Base Sepolia)
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```

## Remappings

Import paths are configured in `remappings.txt`:
- `@openzeppelin/` -> `lib/openzeppelin-contracts/`

Example usage in contracts:
```solidity
import "@openzeppelin/contracts/access/Ownable.sol";
```
