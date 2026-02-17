//! Multi-chain support for AgentMe Node.
//!
//! This module provides infrastructure for interacting with multiple EVM-compatible
//! chains simultaneously. It supports:
//! - Chain configuration management
//! - Trust score aggregation across chains
//! - Contract interactions on any supported chain
//!
//! Supported chains:
//! - Base Mainnet (8453) / Base Sepolia (84532)
//! - Polygon Mainnet (137) / Polygon Amoy (80002)
//! - Arbitrum One (42161) / Arbitrum Sepolia (421614)
//! - Optimism Mainnet (10) / Optimism Sepolia (11155420)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::contract::TrustRegistryClient;
use crate::error::{Error, Result};

// =============================================================================
// Chain Information (Static)
// =============================================================================

/// Well-known chain information.
#[derive(Debug, Clone)]
pub struct ChainInfo {
    /// Chain ID.
    pub chain_id: u64,
    /// Human-readable chain name.
    pub name: &'static str,
    /// Native currency symbol.
    pub currency: &'static str,
    /// Default RPC URL.
    pub default_rpc: &'static str,
    /// USDC contract address (if available).
    pub usdc_address: Option<&'static str>,
    /// Block explorer URL.
    pub explorer_url: &'static str,
    /// Whether this is a testnet.
    pub is_testnet: bool,
}

/// Get chain info for a given chain ID.
pub fn get_chain_info(chain_id: u64) -> Option<&'static ChainInfo> {
    SUPPORTED_CHAINS.iter().find(|c| c.chain_id == chain_id)
}

/// List of all supported chains.
pub static SUPPORTED_CHAINS: &[ChainInfo] = &[
    // Base
    ChainInfo {
        chain_id: 8453,
        name: "Base Mainnet",
        currency: "ETH",
        default_rpc: "https://mainnet.base.org",
        usdc_address: Some("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
        explorer_url: "https://basescan.org",
        is_testnet: false,
    },
    ChainInfo {
        chain_id: 84532,
        name: "Base Sepolia",
        currency: "ETH",
        default_rpc: "https://sepolia.base.org",
        usdc_address: Some("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
        explorer_url: "https://sepolia.basescan.org",
        is_testnet: true,
    },
    // Polygon
    ChainInfo {
        chain_id: 137,
        name: "Polygon Mainnet",
        currency: "POL",
        default_rpc: "https://polygon-rpc.com",
        usdc_address: Some("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
        explorer_url: "https://polygonscan.com",
        is_testnet: false,
    },
    ChainInfo {
        chain_id: 80002,
        name: "Polygon Amoy",
        currency: "POL",
        default_rpc: "https://rpc-amoy.polygon.technology",
        usdc_address: Some("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582"),
        explorer_url: "https://amoy.polygonscan.com",
        is_testnet: true,
    },
    // Arbitrum
    ChainInfo {
        chain_id: 42161,
        name: "Arbitrum One",
        currency: "ETH",
        default_rpc: "https://arb1.arbitrum.io/rpc",
        usdc_address: Some("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        explorer_url: "https://arbiscan.io",
        is_testnet: false,
    },
    ChainInfo {
        chain_id: 421614,
        name: "Arbitrum Sepolia",
        currency: "ETH",
        default_rpc: "https://sepolia-rollup.arbitrum.io/rpc",
        usdc_address: Some("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
        explorer_url: "https://sepolia.arbiscan.io",
        is_testnet: true,
    },
    // Optimism
    ChainInfo {
        chain_id: 10,
        name: "Optimism Mainnet",
        currency: "ETH",
        default_rpc: "https://mainnet.optimism.io",
        usdc_address: Some("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
        explorer_url: "https://optimistic.etherscan.io",
        is_testnet: false,
    },
    ChainInfo {
        chain_id: 11155420,
        name: "Optimism Sepolia",
        currency: "ETH",
        default_rpc: "https://sepolia.optimism.io",
        usdc_address: Some("0x5fd84259d66Cd46123540766Be93DFE6D43130D7"),
        explorer_url: "https://sepolia-optimism.etherscan.io",
        is_testnet: true,
    },
];

// =============================================================================
// Chain Configuration (User-defined)
// =============================================================================

/// Configuration for a single chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    /// Chain ID.
    pub chain_id: u64,

    /// RPC endpoint URL (overrides default).
    #[serde(default)]
    pub rpc_url: Option<String>,

    /// TrustRegistry contract address on this chain.
    #[serde(default)]
    pub trust_registry_address: Option<String>,

    /// Escrow contract address on this chain.
    #[serde(default)]
    pub escrow_address: Option<String>,

    /// Whether this chain is enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Priority for this chain (higher = preferred).
    #[serde(default)]
    pub priority: u32,
}

fn default_true() -> bool {
    true
}

impl ChainConfig {
    /// Create a new chain configuration.
    pub fn new(chain_id: u64) -> Self {
        Self {
            chain_id,
            rpc_url: None,
            trust_registry_address: None,
            escrow_address: None,
            enabled: true,
            priority: 0,
        }
    }

    /// Get the effective RPC URL (custom or default).
    pub fn effective_rpc_url(&self) -> Option<String> {
        self.rpc_url
            .clone()
            .or_else(|| get_chain_info(self.chain_id).map(|c| c.default_rpc.to_string()))
    }

    /// Check if this chain has a TrustRegistry configured.
    pub fn has_trust_registry(&self) -> bool {
        self.trust_registry_address.is_some()
    }
}

// =============================================================================
// Multi-Chain Configuration
// =============================================================================

/// Configuration for multiple chains.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MultiChainConfig {
    /// Primary chain ID (default for operations).
    pub primary_chain_id: Option<u64>,

    /// Chain-specific configurations.
    #[serde(default)]
    pub chains: Vec<ChainConfig>,

    /// Whether to aggregate trust scores across all chains.
    #[serde(default)]
    pub aggregate_trust: bool,
}

impl MultiChainConfig {
    /// Create a new multi-chain configuration.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a chain configuration.
    pub fn add_chain(&mut self, config: ChainConfig) {
        // Remove existing config for this chain if any
        self.chains.retain(|c| c.chain_id != config.chain_id);
        self.chains.push(config);
    }

    /// Get configuration for a specific chain.
    pub fn get_chain(&self, chain_id: u64) -> Option<&ChainConfig> {
        self.chains.iter().find(|c| c.chain_id == chain_id)
    }

    /// Get all enabled chains.
    pub fn enabled_chains(&self) -> Vec<&ChainConfig> {
        self.chains.iter().filter(|c| c.enabled).collect()
    }

    /// Get the primary chain configuration.
    pub fn primary_chain(&self) -> Option<&ChainConfig> {
        self.primary_chain_id
            .and_then(|id| self.get_chain(id))
            .or_else(|| self.chains.first())
    }

    /// Get chains with TrustRegistry configured, sorted by priority.
    pub fn chains_with_trust_registry(&self) -> Vec<&ChainConfig> {
        let mut chains: Vec<_> = self
            .chains
            .iter()
            .filter(|c| c.enabled && c.has_trust_registry())
            .collect();
        chains.sort_by(|a, b| b.priority.cmp(&a.priority));
        chains
    }
}

// =============================================================================
// Multi-Chain Client
// =============================================================================

/// Client for interacting with contracts across multiple chains.
pub struct MultiChainClient {
    config: MultiChainConfig,
    clients: HashMap<u64, TrustRegistryClient>,
}

impl MultiChainClient {
    /// Create a new multi-chain client.
    pub fn new(config: MultiChainConfig) -> Result<Self> {
        let mut clients = HashMap::new();

        for chain_config in config.chains_with_trust_registry() {
            if let (Some(rpc_url), Some(address)) = (
                chain_config.effective_rpc_url(),
                &chain_config.trust_registry_address,
            ) {
                let client = TrustRegistryClient::new(rpc_url, address)?;
                clients.insert(chain_config.chain_id, client);
            }
        }

        Ok(Self { config, clients })
    }

    /// Get the number of connected chains.
    pub fn chain_count(&self) -> usize {
        self.clients.len()
    }

    /// Check if a specific chain is connected.
    pub fn has_chain(&self, chain_id: u64) -> bool {
        self.clients.contains_key(&chain_id)
    }

    /// Get trust score from a specific chain.
    pub async fn get_trust_score(&self, chain_id: u64, did: &str) -> Result<u64> {
        let client = self
            .clients
            .get(&chain_id)
            .ok_or_else(|| Error::Config(format!("Chain {} not configured", chain_id)))?;

        client.get_trust_score(did).await
    }

    /// Get aggregated trust score across all chains.
    ///
    /// Uses weighted average based on chain priority.
    pub async fn get_aggregated_trust_score(&self, did: &str) -> Result<u64> {
        if self.clients.is_empty() {
            return Err(Error::Config("No chains configured".to_string()));
        }

        let chains = self.config.chains_with_trust_registry();
        if chains.is_empty() {
            return Err(Error::Config(
                "No chains with TrustRegistry configured".to_string(),
            ));
        }

        let mut total_score: u64 = 0;
        let mut total_weight: u64 = 0;
        let mut errors = Vec::new();

        for chain_config in chains {
            if let Some(client) = self.clients.get(&chain_config.chain_id) {
                match client.get_trust_score(did).await {
                    Ok(score) => {
                        let weight = (chain_config.priority as u64) + 1; // +1 to avoid zero weight
                        total_score += score * weight;
                        total_weight += weight;
                    }
                    Err(e) => {
                        errors.push((chain_config.chain_id, e));
                    }
                }
            }
        }

        // If we got at least one score, return the weighted average
        if total_weight > 0 {
            Ok(total_score / total_weight)
        } else if !errors.is_empty() {
            // All chains failed, return the first error
            Err(errors
                .into_iter()
                .next()
                .expect("errors verified non-empty")
                .1)
        } else {
            Err(Error::Config("No scores available".to_string()))
        }
    }

    /// Get trust scores from all chains.
    pub async fn get_all_trust_scores(&self, did: &str) -> HashMap<u64, Result<u64>> {
        let mut results = HashMap::new();

        for (chain_id, client) in &self.clients {
            let result = client.get_trust_score(did).await;
            results.insert(*chain_id, result);
        }

        results
    }

    /// Get the primary chain client.
    pub fn primary_client(&self) -> Option<&TrustRegistryClient> {
        self.config
            .primary_chain_id
            .and_then(|id| self.clients.get(&id))
            .or_else(|| self.clients.values().next())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Chain Info Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_chain_info_returns_base_mainnet() {
        let info = get_chain_info(8453);

        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.name, "Base Mainnet");
        assert!(!info.is_testnet);
    }

    #[test]
    fn test_get_chain_info_returns_base_sepolia() {
        let info = get_chain_info(84532);

        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.name, "Base Sepolia");
        assert!(info.is_testnet);
    }

    #[test]
    fn test_get_chain_info_returns_polygon() {
        let info = get_chain_info(137);

        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.name, "Polygon Mainnet");
        assert_eq!(info.currency, "POL");
    }

    #[test]
    fn test_get_chain_info_returns_arbitrum() {
        let info = get_chain_info(42161);

        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.name, "Arbitrum One");
    }

    #[test]
    fn test_get_chain_info_returns_optimism() {
        let info = get_chain_info(10);

        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.name, "Optimism Mainnet");
    }

    #[test]
    fn test_get_chain_info_returns_none_for_unknown_chain() {
        let info = get_chain_info(99999);

        assert!(info.is_none());
    }

    #[test]
    fn test_all_mainnets_have_usdc_address() {
        for chain in SUPPORTED_CHAINS {
            if !chain.is_testnet {
                assert!(
                    chain.usdc_address.is_some(),
                    "Mainnet {} should have USDC address",
                    chain.name
                );
            }
        }
    }

    #[test]
    fn test_all_chains_have_valid_explorer_url() {
        for chain in SUPPORTED_CHAINS {
            assert!(
                chain.explorer_url.starts_with("https://"),
                "Chain {} should have valid explorer URL",
                chain.name
            );
        }
    }

    // -------------------------------------------------------------------------
    // Chain Config Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_chain_config_new_creates_enabled_config() {
        let config = ChainConfig::new(8453);

        assert_eq!(config.chain_id, 8453);
        assert!(config.enabled);
        assert!(config.rpc_url.is_none());
    }

    #[test]
    fn test_chain_config_effective_rpc_url_uses_custom_when_set() {
        let mut config = ChainConfig::new(8453);
        config.rpc_url = Some("https://custom-rpc.example.com".to_string());

        let url = config.effective_rpc_url();

        assert_eq!(url, Some("https://custom-rpc.example.com".to_string()));
    }

    #[test]
    fn test_chain_config_effective_rpc_url_uses_default_when_not_set() {
        let config = ChainConfig::new(8453);

        let url = config.effective_rpc_url();

        assert_eq!(url, Some("https://mainnet.base.org".to_string()));
    }

    #[test]
    fn test_chain_config_has_trust_registry_returns_false_when_not_set() {
        let config = ChainConfig::new(8453);

        assert!(!config.has_trust_registry());
    }

    #[test]
    fn test_chain_config_has_trust_registry_returns_true_when_set() {
        let mut config = ChainConfig::new(8453);
        config.trust_registry_address =
            Some("0x1234567890123456789012345678901234567890".to_string());

        assert!(config.has_trust_registry());
    }

    // -------------------------------------------------------------------------
    // Multi-Chain Config Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_multichain_config_add_chain_replaces_existing() {
        let mut config = MultiChainConfig::new();

        let chain1 = ChainConfig::new(8453);
        config.add_chain(chain1);

        let mut chain2 = ChainConfig::new(8453);
        chain2.priority = 100;
        config.add_chain(chain2);

        assert_eq!(config.chains.len(), 1);
        assert_eq!(config.get_chain(8453).unwrap().priority, 100);
    }

    #[test]
    fn test_multichain_config_get_chain_returns_correct_config() {
        let mut config = MultiChainConfig::new();
        config.add_chain(ChainConfig::new(8453));
        config.add_chain(ChainConfig::new(137));

        let base = config.get_chain(8453);
        let polygon = config.get_chain(137);

        assert!(base.is_some());
        assert!(polygon.is_some());
        assert_eq!(base.unwrap().chain_id, 8453);
        assert_eq!(polygon.unwrap().chain_id, 137);
    }

    #[test]
    fn test_multichain_config_enabled_chains_filters_disabled() {
        let mut config = MultiChainConfig::new();

        let mut chain1 = ChainConfig::new(8453);
        chain1.enabled = true;
        config.add_chain(chain1);

        let mut chain2 = ChainConfig::new(137);
        chain2.enabled = false;
        config.add_chain(chain2);

        let enabled = config.enabled_chains();

        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].chain_id, 8453);
    }

    #[test]
    fn test_multichain_config_primary_chain_returns_specified() {
        let mut config = MultiChainConfig::new();
        config.primary_chain_id = Some(137);
        config.add_chain(ChainConfig::new(8453));
        config.add_chain(ChainConfig::new(137));

        let primary = config.primary_chain();

        assert!(primary.is_some());
        assert_eq!(primary.unwrap().chain_id, 137);
    }

    #[test]
    fn test_multichain_config_primary_chain_falls_back_to_first() {
        let mut config = MultiChainConfig::new();
        config.add_chain(ChainConfig::new(8453));
        config.add_chain(ChainConfig::new(137));

        let primary = config.primary_chain();

        assert!(primary.is_some());
        assert_eq!(primary.unwrap().chain_id, 8453);
    }

    #[test]
    fn test_multichain_config_chains_with_trust_registry_sorted_by_priority() {
        let mut config = MultiChainConfig::new();

        let mut chain1 = ChainConfig::new(8453);
        chain1.trust_registry_address =
            Some("0x1111111111111111111111111111111111111111".to_string());
        chain1.priority = 10;
        config.add_chain(chain1);

        let mut chain2 = ChainConfig::new(137);
        chain2.trust_registry_address =
            Some("0x2222222222222222222222222222222222222222".to_string());
        chain2.priority = 100;
        config.add_chain(chain2);

        let chains = config.chains_with_trust_registry();

        assert_eq!(chains.len(), 2);
        assert_eq!(chains[0].chain_id, 137); // Higher priority first
        assert_eq!(chains[1].chain_id, 8453);
    }

    // -------------------------------------------------------------------------
    // Multi-Chain Client Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_multichain_client_creates_with_empty_config() {
        let config = MultiChainConfig::new();
        let client = MultiChainClient::new(config);

        assert!(client.is_ok());
        assert_eq!(client.unwrap().chain_count(), 0);
    }

    #[test]
    fn test_multichain_client_creates_clients_for_configured_chains() {
        let mut config = MultiChainConfig::new();

        let mut chain = ChainConfig::new(84532); // Base Sepolia
        chain.trust_registry_address =
            Some("0x1234567890123456789012345678901234567890".to_string());
        config.add_chain(chain);

        let client = MultiChainClient::new(config);

        assert!(client.is_ok());
        let client = client.unwrap();
        assert_eq!(client.chain_count(), 1);
        assert!(client.has_chain(84532));
    }

    #[test]
    fn test_multichain_client_has_chain_returns_false_for_unconfigured() {
        let mut config = MultiChainConfig::new();

        let mut chain = ChainConfig::new(84532);
        chain.trust_registry_address =
            Some("0x1234567890123456789012345678901234567890".to_string());
        config.add_chain(chain);

        let client = MultiChainClient::new(config).unwrap();

        assert!(!client.has_chain(137)); // Polygon not configured
    }

    #[test]
    fn test_multichain_client_skips_chains_without_trust_registry() {
        let mut config = MultiChainConfig::new();

        // Chain with trust registry
        let mut chain1 = ChainConfig::new(84532);
        chain1.trust_registry_address =
            Some("0x1234567890123456789012345678901234567890".to_string());
        config.add_chain(chain1);

        // Chain without trust registry
        let chain2 = ChainConfig::new(137);
        config.add_chain(chain2);

        let client = MultiChainClient::new(config).unwrap();

        assert_eq!(client.chain_count(), 1);
        assert!(client.has_chain(84532));
        assert!(!client.has_chain(137));
    }

    #[test]
    fn test_multichain_client_rejects_invalid_contract_address() {
        let mut config = MultiChainConfig::new();

        let mut chain = ChainConfig::new(84532);
        chain.trust_registry_address = Some("invalid-address".to_string());
        config.add_chain(chain);

        let client = MultiChainClient::new(config);

        assert!(client.is_err());
    }

    // Note: Async tests for actual RPC calls would require mocking
    // or integration test setup with a local node.
}
