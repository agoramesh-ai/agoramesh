.PHONY: all build test lint clean
.PHONY: build-node test-node lint-node clean-node
.PHONY: build-contracts test-contracts lint-contracts clean-contracts
.PHONY: build-sdk test-sdk lint-sdk clean-sdk
.PHONY: build-bridge test-bridge lint-bridge clean-bridge
.PHONY: build-mcp test-mcp lint-mcp clean-mcp
.PHONY: docker-build docker-push k8s-deploy k8s-delete
.PHONY: deploy-sepolia deploy-local e2e-demo local-up local-down local-e2e
.PHONY: deploy-testnet-full verify-deployment

# Default target
all: build

# =============================================================================
# Top-level targets
# =============================================================================

build: build-node build-contracts build-sdk build-bridge build-mcp

test: test-node test-contracts test-sdk test-bridge test-mcp

lint: lint-node lint-contracts lint-sdk lint-bridge lint-mcp

clean: clean-node clean-contracts clean-sdk clean-bridge clean-mcp

# =============================================================================
# Node (Rust)
# =============================================================================

build-node:
	cd node && cargo build --release

test-node:
	cd node && cargo test

lint-node:
	cd node && cargo fmt --check && cargo clippy -- -D warnings

clean-node:
	cd node && cargo clean

# =============================================================================
# Contracts (Solidity/Foundry)
# =============================================================================

build-contracts:
	cd contracts && forge build

test-contracts:
	cd contracts && forge test

lint-contracts:
	cd contracts && forge fmt --check

clean-contracts:
	cd contracts && forge clean

# =============================================================================
# SDK (TypeScript)
# =============================================================================

build-sdk:
	cd sdk && npm run build

test-sdk:
	cd sdk && npm test

lint-sdk:
	cd sdk && npm run lint

clean-sdk:
	cd sdk && rm -rf dist node_modules

# =============================================================================
# Bridge (TypeScript - Claude Code worker)
# =============================================================================

build-bridge:
	cd bridge && npm run build

test-bridge:
	cd bridge && npm test

lint-bridge:
	cd bridge && npm run lint

clean-bridge:
	cd bridge && rm -rf dist node_modules

run-bridge:
	cd bridge && npm run dev

# =============================================================================
# MCP Server (TypeScript - MCP tools for agent discovery)
# =============================================================================

build-mcp:
	cd mcp && npm run build

test-mcp:
	cd mcp && npm test

lint-mcp:
	cd mcp && npm run lint

clean-mcp:
	cd mcp && rm -rf dist node_modules

# =============================================================================
# Development helpers
# =============================================================================

install-deps:
	cd sdk && npm install
	cd bridge && npm install
	cd mcp && npm install

fmt:
	cd node && cargo fmt
	cd contracts && forge fmt
	cd sdk && npm run lint:fix

# =============================================================================
# Deployment - Contracts
# =============================================================================

deploy-testnet:
	cd contracts && forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast

deploy-mainnet:
	@echo "WARNING: Deploying to BASE MAINNET with real funds!"
	@echo "Make sure you have:"
	@echo "  1. Completed security audit"
	@echo "  2. Set up multisig admin"
	@echo "  3. Set DEPLOYER_PRIVATE_KEY and BASESCAN_API_KEY"
	@read -p "Type 'deploy-mainnet' to confirm: " confirm && [ "$$confirm" = "deploy-mainnet" ] || (echo "Aborted." && exit 1)
	cd contracts && forge script script/SaveDeployment.s.sol:SaveDeployment --rpc-url base_mainnet --broadcast --verify

# Deploy to Base Sepolia and save addresses to deployments/sepolia.json
deploy-sepolia:
	mkdir -p deployments
	cd contracts && forge script script/SaveDeployment.s.sol --rpc-url base_sepolia --broadcast --verify

# Deploy to local Anvil and save addresses to deployments/local.json
deploy-local:
	mkdir -p deployments
	cd contracts && forge script script/DeployLocal.s.sol --rpc-url localhost --broadcast

# Full testnet deployment: deploy all contracts, configure permissions, whitelist tokens, verify
deploy-testnet-full:
	mkdir -p deployments
	cd contracts && forge script script/DeployAll.s.sol --rpc-url base_sepolia --broadcast --verify
	@echo ""
	@echo "Deployment complete. Running verification..."
	cd contracts && forge script script/VerifyDeployment.s.sol --rpc-url base_sepolia
	@echo ""
	@echo "All contracts deployed and verified on Base Sepolia."

# Verify that all deployed contracts are properly configured (reads from deployments/<network>.json)
verify-deployment:
	cd contracts && forge script script/VerifyDeployment.s.sol --rpc-url base_sepolia

# =============================================================================
# Deployment - Node (Fly.io)
# =============================================================================

fly-launch:
	cd node && fly launch --no-deploy

fly-deploy:
	cd node && fly deploy

fly-logs:
	cd node && fly logs

fly-status:
	cd node && fly status

fly-ssh:
	cd node && fly ssh console

# =============================================================================
# E2E Demo
# =============================================================================

# Run E2E demo against Base Sepolia (requires PRIVATE_KEY env var)
e2e-demo:
	cd sdk && npx tsx scripts/e2e-demo.ts --network sepolia

# Run E2E demo against local Anvil
local-e2e:
	cd sdk && npx tsx scripts/e2e-demo.ts --network local

# =============================================================================
# Local Development Stack (Docker Compose)
# =============================================================================

# Start full local stack: Anvil + deploy contracts + node + bridge
local-up:
	docker compose up -d

# Stop local stack
local-down:
	docker compose down

# Legacy aliases
dev-up: local-up

dev-down: local-down

dev-logs:
	docker compose logs -f

dev-restart:
	docker compose restart

# =============================================================================
# Docker
# =============================================================================

DOCKER_REGISTRY ?= ghcr.io/agoramesh
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

docker-build:
	docker build -t $(DOCKER_REGISTRY)/node:$(VERSION) -t $(DOCKER_REGISTRY)/node:latest ./node
	docker build -t $(DOCKER_REGISTRY)/bridge:$(VERSION) -t $(DOCKER_REGISTRY)/bridge:latest ./bridge

docker-push:
	docker push $(DOCKER_REGISTRY)/node:$(VERSION)
	docker push $(DOCKER_REGISTRY)/node:latest
	docker push $(DOCKER_REGISTRY)/bridge:$(VERSION)
	docker push $(DOCKER_REGISTRY)/bridge:latest

docker-run-node:
	cd node && docker-compose up -d

docker-run-node-monitoring:
	cd node && docker-compose --profile monitoring up -d

docker-stop-node:
	cd node && docker-compose down

docker-logs-node:
	cd node && docker-compose logs -f

# =============================================================================
# Kubernetes
# =============================================================================

KUBECTL ?= kubectl
KUSTOMIZE ?= kustomize

k8s-deploy:
	$(KUBECTL) apply -k deploy/k8s/

k8s-delete:
	$(KUBECTL) delete -k deploy/k8s/

k8s-status:
	$(KUBECTL) -n agoramesh get pods,svc,ingress

k8s-logs:
	$(KUBECTL) -n agoramesh logs -l app.kubernetes.io/name=agoramesh-node --tail=100 -f

k8s-restart:
	$(KUBECTL) -n agoramesh rollout restart deployment/agoramesh-node

k8s-scale:
	$(KUBECTL) -n agoramesh scale deployment/agoramesh-node --replicas=$(REPLICAS)

# =============================================================================
# CI/CD helpers
# =============================================================================

ci: lint test build

release: docker-build docker-push
