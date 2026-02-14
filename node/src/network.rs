//! P2P network layer using libp2p.
//!
//! This module handles:
//! - Peer connections and management
//! - GossipSub for pub/sub messaging
//! - Kademlia DHT for distributed storage
//! - mDNS for local network discovery
//! - Message routing and handling
//! - Security (Sybil/Eclipse attack protection)

pub mod behaviour;
pub mod message_handler;
pub mod security;
pub mod swarm;
pub mod transport;

// Re-export main types for convenience
pub use behaviour::{topics, AgentMeBehaviour, AgentMeEvent, PROTOCOL_VERSION};
pub use message_handler::{DiscoveryMessage, MessageHandler, MessageHandlerStats, TrustMessage};
pub use security::{
    validate_bootstrap_peers, validate_network_config, ConnectionRateLimiter, ConnectionTracker,
    GlobalConnectionRateLimiter, SecurityConfig, Subnet16Tracker, SubnetTracker,
    DEFAULT_MAX_CONNECTIONS_PER_MINUTE, MAX_PEERS_PER_SUBNET_16, MAX_PEERS_PER_SUBNET_24,
    MIN_BOOTSTRAP_PEERS,
};
pub use swarm::{NetworkEvent, SwarmCommand, SwarmManager};
pub use transport::{build_transport, BoxedTransport};

use libp2p::{Multiaddr, PeerId};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info};

use crate::config::NetworkConfig;
use crate::error::{Error, Result};

/// P2P network manager.
///
/// Provides a high-level interface for network operations.
/// Internally manages a SwarmManager running in a background task.
pub struct NetworkManager {
    /// Local peer ID.
    local_peer_id: PeerId,

    /// Network configuration.
    config: NetworkConfig,

    /// Command sender to the swarm manager.
    command_tx: mpsc::Sender<SwarmCommand>,

    /// Event receiver from the swarm manager.
    event_rx: Option<mpsc::Receiver<NetworkEvent>>,
}

impl NetworkManager {
    /// Create a new network manager.
    ///
    /// # Arguments
    ///
    /// * `config` - Network configuration
    ///
    /// # Returns
    ///
    /// A new `NetworkManager` instance ready to be started.
    pub fn new(config: NetworkConfig) -> Result<Self> {
        let (manager, command_tx, event_rx) = SwarmManager::new(&config)?;
        let local_peer_id = manager.local_peer_id();

        info!("Created NetworkManager with peer ID: {}", local_peer_id);

        // Spawn the swarm manager
        let listen_addresses = config.listen_addresses.clone();
        tokio::spawn(async move {
            if let Err(e) = manager.run(&listen_addresses).await {
                tracing::error!("Swarm manager error: {}", e);
            }
        });

        Ok(Self {
            local_peer_id,
            config,
            command_tx,
            event_rx: Some(event_rx),
        })
    }

    /// Create a network manager with an existing keypair.
    ///
    /// # Arguments
    ///
    /// * `config` - Network configuration
    /// * `keypair` - The node's identity keypair
    pub fn with_keypair(config: NetworkConfig, keypair: libp2p::identity::Keypair) -> Result<Self> {
        let (manager, command_tx, event_rx) = SwarmManager::with_keypair(&config, keypair)?;
        let local_peer_id = manager.local_peer_id();

        info!("Created NetworkManager with peer ID: {}", local_peer_id);

        let listen_addresses = config.listen_addresses.clone();
        tokio::spawn(async move {
            if let Err(e) = manager.run(&listen_addresses).await {
                tracing::error!("Swarm manager error: {}", e);
            }
        });

        Ok(Self {
            local_peer_id,
            config,
            command_tx,
            event_rx: Some(event_rx),
        })
    }

    /// Get the local peer ID.
    pub fn local_peer_id(&self) -> PeerId {
        self.local_peer_id
    }

    /// Get the network configuration.
    pub fn config(&self) -> &NetworkConfig {
        &self.config
    }

    /// Get a clone of the command channel sender.
    ///
    /// This can be used to integrate with other services like DiscoveryService
    /// for DHT operations.
    pub fn command_channel(&self) -> mpsc::Sender<SwarmCommand> {
        self.command_tx.clone()
    }

    /// Take the event receiver.
    ///
    /// This can only be called once; subsequent calls return None.
    /// Use this to receive network events in your application.
    pub fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<NetworkEvent>> {
        self.event_rx.take()
    }

    /// Connect to a peer.
    ///
    /// # Arguments
    ///
    /// * `peer_addr` - The peer's multiaddress (e.g., "/ip4/127.0.0.1/tcp/9000/p2p/<peer_id>")
    pub async fn connect(&self, peer_addr: &str) -> Result<()> {
        let addr: Multiaddr = peer_addr
            .parse()
            .map_err(|e| Error::Network(format!("Invalid peer address '{}': {}", peer_addr, e)))?;

        debug!("Connecting to {}", addr);

        self.command_tx
            .send(SwarmCommand::Dial(addr))
            .await
            .map_err(|e| Error::Network(format!("Failed to send dial command: {}", e)))?;

        Ok(())
    }

    /// Publish a message to a topic.
    ///
    /// # Arguments
    ///
    /// * `topic` - The topic name (e.g., "/agentme/discovery/1.0.0")
    /// * `message` - The message data
    pub async fn publish(&self, topic: &str, message: &[u8]) -> Result<()> {
        debug!("Publishing {} bytes to topic {}", message.len(), topic);

        self.command_tx
            .send(SwarmCommand::Publish {
                topic: topic.to_string(),
                data: message.to_vec(),
            })
            .await
            .map_err(|e| Error::Network(format!("Failed to send publish command: {}", e)))?;

        Ok(())
    }

    /// Publish an agent discovery announcement.
    pub async fn announce_agent(&self, announcement: &[u8]) -> Result<()> {
        self.publish(topics::DISCOVERY, announcement).await
    }

    /// Publish a capability card update.
    pub async fn publish_capability(&self, capability: &[u8]) -> Result<()> {
        self.publish(topics::CAPABILITY, capability).await
    }

    /// Publish a trust score update.
    pub async fn publish_trust_update(&self, update: &[u8]) -> Result<()> {
        self.publish(topics::TRUST, update).await
    }

    /// Get connected peers.
    pub async fn connected_peers(&self) -> Result<Vec<PeerId>> {
        let (tx, rx) = oneshot::channel();

        self.command_tx
            .send(SwarmCommand::GetPeers(tx))
            .await
            .map_err(|e| Error::Network(format!("Failed to send get peers command: {}", e)))?;

        rx.await
            .map_err(|e| Error::Network(format!("Failed to receive peers: {}", e)))
    }

    /// Bootstrap the DHT by connecting to known peers.
    pub async fn bootstrap(&self) -> Result<()> {
        self.command_tx
            .send(SwarmCommand::Bootstrap)
            .await
            .map_err(|e| Error::Network(format!("Failed to send bootstrap command: {}", e)))?;

        Ok(())
    }

    /// Shutdown the network manager.
    pub async fn shutdown(&self) -> Result<()> {
        info!("Shutting down network manager");

        self.command_tx
            .send(SwarmCommand::Shutdown)
            .await
            .map_err(|e| Error::Network(format!("Failed to send shutdown command: {}", e)))?;

        Ok(())
    }

    /// Store a record in the DHT.
    ///
    /// # Arguments
    ///
    /// * `key` - The record key (e.g., DID)
    /// * `value` - The record value (e.g., serialized CapabilityCard)
    pub async fn put_dht_record(&self, key: &[u8], value: &[u8]) -> Result<()> {
        debug!("Storing DHT record with key {:?}", key);

        self.command_tx
            .send(SwarmCommand::PutRecord {
                key: key.to_vec(),
                value: value.to_vec(),
            })
            .await
            .map_err(|e| Error::Network(format!("Failed to send put record command: {}", e)))?;

        Ok(())
    }

    /// Get a record from the DHT.
    ///
    /// # Arguments
    ///
    /// * `key` - The record key (e.g., DID)
    ///
    /// # Returns
    ///
    /// The record value if found, None otherwise.
    pub async fn get_dht_record(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        debug!("Getting DHT record with key {:?}", key);

        let (tx, rx) = oneshot::channel();

        self.command_tx
            .send(SwarmCommand::GetRecord {
                key: key.to_vec(),
                response_tx: tx,
            })
            .await
            .map_err(|e| Error::Network(format!("Failed to send get record command: {}", e)))?;

        // Wait for result with timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(Error::Network("DHT query channel closed".to_string())),
            Err(_) => Err(Error::Network("DHT query timed out".to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> NetworkConfig {
        NetworkConfig {
            listen_addresses: vec!["/ip4/127.0.0.1/tcp/0".to_string()],
            bootstrap_peers: vec![],
            max_connections: 50,
        }
    }

    #[tokio::test]
    async fn test_create_network_manager() {
        let config = test_config();
        let result = NetworkManager::new(config);
        assert!(result.is_ok());

        let manager = result.unwrap();
        assert!(!manager.local_peer_id().to_string().is_empty());
    }

    #[test]
    fn test_topic_constants() {
        assert_eq!(topics::DISCOVERY, "/agentme/discovery/1.0.0");
        assert_eq!(topics::CAPABILITY, "/agentme/capability/1.0.0");
        assert_eq!(topics::TRUST, "/agentme/trust/1.0.0");
    }

    #[tokio::test]
    async fn test_command_channel_returns_sender() {
        let config = test_config();
        let manager = NetworkManager::new(config).expect("Should create manager");

        // Should be able to get command channel
        let cmd_tx = manager.command_channel();

        // Should be able to send commands through it
        let result = cmd_tx.send(SwarmCommand::Bootstrap).await;
        assert!(result.is_ok(), "Should be able to send via command channel");
    }
}
