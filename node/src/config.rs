//! Node configuration management.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::{Error, Result};
use crate::persistence::PersistenceConfig;

/// Main configuration for an AgentMesh node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    /// Node identity configuration.
    pub identity: IdentityConfig,

    /// P2P network configuration.
    pub network: NetworkConfig,

    /// HTTP API configuration.
    pub api: ApiConfig,

    /// Trust layer configuration.
    pub trust: TrustConfig,

    /// Blockchain configuration.
    pub blockchain: BlockchainConfig,

    /// Persistence/storage configuration.
    #[serde(default)]
    pub persistence: PersistenceConfig,

    /// Node info for capability card (optional).
    #[serde(default)]
    pub node_info: NodeInfoConfig,
}

/// Identity configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityConfig {
    /// Path to private key file (will be generated if not exists).
    pub key_file: String,

    /// Optional DID for this node.
    pub did: Option<String>,
}

/// P2P network configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// Listen addresses for P2P connections.
    pub listen_addresses: Vec<String>,

    /// Bootstrap peers to connect to on startup.
    pub bootstrap_peers: Vec<String>,

    /// Maximum number of connections.
    pub max_connections: u32,
}

/// HTTP API configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    /// Listen address for HTTP API.
    pub listen_address: String,

    /// Enable CORS.
    pub cors_enabled: bool,

    /// Allowed CORS origins.
    pub cors_origins: Vec<String>,

    /// Trust proxy headers (X-Forwarded-For, X-Real-IP) for client IPs.
    #[serde(default)]
    pub trust_proxy: bool,

    /// Optional admin token required for agent registration.
    #[serde(default)]
    pub admin_token: Option<String>,
}

/// Trust layer configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustConfig {
    /// Minimum trust score to accept requests.
    pub min_trust_score: f64,

    /// Enable stake verification.
    pub require_stake: bool,

    /// Minimum stake amount in USDC (6 decimals).
    pub min_stake: u64,
}

/// Node info configuration for capability card.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeInfoConfig {
    /// Node display name.
    pub name: Option<String>,

    /// Node description.
    pub description: Option<String>,

    /// Node's public URL.
    pub url: Option<String>,
}

/// Blockchain configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockchainConfig {
    /// Chain ID (8453 for Base Mainnet, 84532 for Base Sepolia).
    pub chain_id: u64,

    /// RPC endpoint URL.
    pub rpc_url: String,

    /// Trust Registry contract address.
    pub trust_registry_address: Option<String>,

    /// Escrow contract address.
    pub escrow_address: Option<String>,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            identity: IdentityConfig {
                key_file: "node.key".to_string(),
                did: None,
            },
            network: NetworkConfig {
                listen_addresses: vec!["/ip4/0.0.0.0/tcp/9000".to_string()],
                bootstrap_peers: vec![],
                max_connections: 50,
            },
            api: ApiConfig {
                listen_address: "0.0.0.0:8080".to_string(),
                cors_enabled: true,
                cors_origins: vec!["*".to_string()],
                trust_proxy: false,
                admin_token: None,
            },
            trust: TrustConfig {
                min_trust_score: 0.5,
                require_stake: false,
                min_stake: 0,
            },
            blockchain: BlockchainConfig {
                chain_id: 84532, // Base Sepolia
                rpc_url: "https://sepolia.base.org".to_string(),
                trust_registry_address: None,
                escrow_address: None,
            },
            persistence: PersistenceConfig::default(),
            node_info: NodeInfoConfig::default(),
        }
    }
}

impl NodeInfoConfig {
    /// Convert to NodeInfo if all required fields are present.
    pub fn to_node_info(&self, did: &str) -> Option<crate::api::NodeInfo> {
        Some(crate::api::NodeInfo {
            name: self.name.clone()?,
            description: self.description.clone().unwrap_or_default(),
            url: self.url.clone().unwrap_or_default(),
            did: did.to_string(),
        })
    }
}

/// Type alias for blockchain configuration.
pub type ChainConfig = BlockchainConfig;

/// Type alias for discovery/network configuration.
pub type DiscoveryConfig = NetworkConfig;

impl NodeConfig {
    /// Load configuration from a TOML file.
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let contents = std::fs::read_to_string(path)?;
        toml::from_str(&contents).map_err(|e| Error::Config(e.to_string()))
    }

    /// Save configuration to a TOML file.
    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let contents = toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))?;
        std::fs::write(path, contents)?;
        Ok(())
    }

    /// Get NodeInfo from config if name is provided.
    pub fn get_node_info(&self) -> Option<crate::api::NodeInfo> {
        let did = self.identity.did.as_ref()?;
        self.node_info.to_node_info(did)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_node_info_config_to_node_info_with_all_fields() {
        // Arrange
        let config = NodeInfoConfig {
            name: Some("TestNode".to_string()),
            description: Some("A test node".to_string()),
            url: Some("https://example.com".to_string()),
        };

        // Act
        let node_info = config.to_node_info("did:agentmesh:base:test");

        // Assert
        assert!(node_info.is_some());
        let info = node_info.unwrap();
        assert_eq!(info.name, "TestNode");
        assert_eq!(info.description, "A test node");
        assert_eq!(info.url, "https://example.com");
        assert_eq!(info.did, "did:agentmesh:base:test");
    }

    #[test]
    fn test_node_info_config_returns_none_without_name() {
        // Arrange
        let config = NodeInfoConfig {
            name: None,
            description: Some("A test node".to_string()),
            url: Some("https://example.com".to_string()),
        };

        // Act
        let node_info = config.to_node_info("did:agentmesh:base:test");

        // Assert
        assert!(node_info.is_none(), "Should return None without name");
    }

    #[test]
    fn test_node_config_get_node_info_returns_some_with_complete_config() {
        // Arrange
        let mut config = NodeConfig::default();
        config.identity.did = Some("did:agentmesh:base:mynode".to_string());
        config.node_info = NodeInfoConfig {
            name: Some("MyNode".to_string()),
            description: Some("My awesome node".to_string()),
            url: Some("https://mynode.example.com".to_string()),
        };

        // Act
        let node_info = config.get_node_info();

        // Assert
        assert!(node_info.is_some());
        let info = node_info.unwrap();
        assert_eq!(info.name, "MyNode");
        assert_eq!(info.did, "did:agentmesh:base:mynode");
    }

    #[test]
    fn test_node_config_get_node_info_returns_none_without_did() {
        // Arrange
        let config = NodeConfig {
            node_info: NodeInfoConfig {
                name: Some("MyNode".to_string()),
                description: None,
                url: None,
            },
            ..Default::default()
        };

        // Act
        let node_info = config.get_node_info();

        // Assert
        assert!(node_info.is_none(), "Should return None without DID");
    }

    #[test]
    fn test_load_config_with_node_info_from_toml() {
        // Arrange
        let toml_content = r#"
[identity]
key_file = "node.key"
did = "did:agentmesh:base:loaded"

[network]
listen_addresses = ["/ip4/0.0.0.0/tcp/9000"]
bootstrap_peers = []
max_connections = 50

[api]
listen_address = "0.0.0.0:8080"
cors_enabled = true
cors_origins = ["*"]

[trust]
min_trust_score = 0.5
require_stake = false
min_stake = 0

[blockchain]
chain_id = 84532
rpc_url = "https://sepolia.base.org"

[node_info]
name = "LoadedNode"
description = "Node loaded from config"
url = "https://loaded.example.com"
"#;

        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(toml_content.as_bytes()).unwrap();

        // Act
        let config = NodeConfig::load(temp_file.path()).unwrap();
        let node_info = config.get_node_info();

        // Assert
        assert!(node_info.is_some());
        let info = node_info.unwrap();
        assert_eq!(info.name, "LoadedNode");
        assert_eq!(info.description, "Node loaded from config");
        assert_eq!(info.url, "https://loaded.example.com");
        assert_eq!(info.did, "did:agentmesh:base:loaded");
    }

    #[test]
    fn test_default_config_has_empty_node_info() {
        // Arrange & Act
        let config = NodeConfig::default();

        // Assert
        assert!(config.node_info.name.is_none());
        assert!(config.node_info.description.is_none());
        assert!(config.node_info.url.is_none());
    }
}
