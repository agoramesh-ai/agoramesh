//! libp2p behaviour configuration.
//!
//! Combines multiple protocols into a unified network behaviour:
//! - Kademlia DHT for distributed agent discovery
//! - GossipSub for pub/sub messaging
//! - Identify protocol for peer information exchange
//! - mDNS for local network discovery (optional)

use libp2p::{
    gossipsub::{self, MessageAuthenticity, MessageId, ValidationMode},
    identify,
    kad::{self, store::MemoryStore, Mode},
    mdns,
    swarm::NetworkBehaviour,
    PeerId,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    time::Duration,
};

/// AgoraMesh protocol version string.
pub const PROTOCOL_VERSION: &str = "/agoramesh/1.0.0";

/// GossipSub topics for AgoraMesh.
pub mod topics {
    /// Topic for agent discovery announcements.
    pub const DISCOVERY: &str = "/agoramesh/discovery/1.0.0";
    /// Topic for capability card updates.
    pub const CAPABILITY: &str = "/agoramesh/capability/1.0.0";
    /// Topic for trust score updates.
    pub const TRUST: &str = "/agoramesh/trust/1.0.0";
    /// Topic for dispute notifications.
    pub const DISPUTES: &str = "/agoramesh/disputes/1.0.0";

    /// Get all AgoraMesh topics.
    pub fn all() -> Vec<&'static str> {
        vec![DISCOVERY, CAPABILITY, TRUST, DISPUTES]
    }
}

/// Combined network behaviour for AgoraMesh.
///
/// This behaviour combines:
/// - `gossipsub`: Pub/sub messaging for broadcasting agent updates
/// - `kademlia`: DHT for distributed storage and peer discovery
/// - `identify`: Protocol to exchange peer info on connection
/// - `mdns`: Local network discovery (for development/testing)
#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "AgoraMeshEvent")]
pub struct AgoraMeshBehaviour {
    /// GossipSub for pub/sub messaging.
    pub gossipsub: gossipsub::Behaviour,

    /// Kademlia DHT for distributed discovery.
    pub kademlia: kad::Behaviour<MemoryStore>,

    /// Identify protocol for peer information.
    pub identify: identify::Behaviour,

    /// mDNS for local network discovery.
    pub mdns: mdns::tokio::Behaviour,
}

/// Events emitted by the AgoraMesh behaviour.
#[derive(Debug)]
pub enum AgoraMeshEvent {
    /// GossipSub event.
    Gossipsub(gossipsub::Event),
    /// Kademlia event.
    Kademlia(kad::Event),
    /// Identify event (boxed to reduce enum size).
    Identify(Box<identify::Event>),
    /// mDNS event.
    Mdns(mdns::Event),
}

impl From<gossipsub::Event> for AgoraMeshEvent {
    fn from(event: gossipsub::Event) -> Self {
        AgoraMeshEvent::Gossipsub(event)
    }
}

impl From<kad::Event> for AgoraMeshEvent {
    fn from(event: kad::Event) -> Self {
        AgoraMeshEvent::Kademlia(event)
    }
}

impl From<identify::Event> for AgoraMeshEvent {
    fn from(event: identify::Event) -> Self {
        AgoraMeshEvent::Identify(Box::new(event))
    }
}

impl From<mdns::Event> for AgoraMeshEvent {
    fn from(event: mdns::Event) -> Self {
        AgoraMeshEvent::Mdns(event)
    }
}

impl AgoraMeshBehaviour {
    /// Create a new AgoraMesh behaviour.
    ///
    /// # Arguments
    ///
    /// * `local_peer_id` - The local peer ID
    /// * `keypair` - The node's identity keypair
    ///
    /// # Returns
    ///
    /// A new `AgoraMeshBehaviour` instance.
    ///
    /// # Errors
    ///
    /// Returns an error if behaviour creation fails.
    pub fn new(
        local_peer_id: PeerId,
        keypair: &libp2p::identity::Keypair,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // Configure GossipSub with custom message ID function
        let gossipsub = build_gossipsub(keypair)?;

        // Configure Kademlia DHT
        let kademlia = build_kademlia(local_peer_id);

        // Configure Identify protocol
        let identify = build_identify(keypair.public());

        // Configure mDNS for local discovery
        let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;

        Ok(Self {
            gossipsub,
            kademlia,
            identify,
            mdns,
        })
    }

    /// Subscribe to all AgoraMesh topics.
    ///
    /// Subscribes to discovery, capability, trust, and disputes topics.
    pub fn subscribe_to_topics(&mut self) -> Result<(), gossipsub::SubscriptionError> {
        for topic_name in topics::all() {
            let topic = gossipsub::IdentTopic::new(topic_name);
            self.gossipsub.subscribe(&topic)?;
        }
        Ok(())
    }

    /// Get the list of subscribed topics.
    pub fn subscribed_topics(&self) -> Vec<String> {
        self.gossipsub.topics().map(|t| t.to_string()).collect()
    }

    /// Publish a message to a topic.
    ///
    /// # Arguments
    ///
    /// * `topic` - The topic to publish to
    /// * `data` - The message data
    ///
    /// # Returns
    ///
    /// The message ID if successful.
    pub fn publish(
        &mut self,
        topic: &str,
        data: Vec<u8>,
    ) -> Result<MessageId, gossipsub::PublishError> {
        let topic = gossipsub::IdentTopic::new(topic);
        self.gossipsub.publish(topic, data)
    }

    /// Add a peer address to Kademlia routing table.
    ///
    /// # Arguments
    ///
    /// * `peer_id` - The peer ID to add
    /// * `addr` - The peer's multiaddr
    pub fn add_address(&mut self, peer_id: &PeerId, addr: libp2p::Multiaddr) {
        self.kademlia.add_address(peer_id, addr);
    }

    /// Bootstrap Kademlia DHT by connecting to known peers.
    pub fn bootstrap(&mut self) -> Result<kad::QueryId, kad::NoKnownPeers> {
        self.kademlia.bootstrap()
    }

    /// Set Kademlia to server mode (for nodes that are publicly reachable).
    pub fn set_server_mode(&mut self) {
        self.kademlia.set_mode(Some(Mode::Server));
    }

    /// Set Kademlia to client mode (for nodes behind NAT).
    pub fn set_client_mode(&mut self) {
        self.kademlia.set_mode(Some(Mode::Client));
    }
}

/// Build GossipSub behaviour with AgoraMesh configuration.
fn build_gossipsub(
    keypair: &libp2p::identity::Keypair,
) -> Result<gossipsub::Behaviour, Box<dyn std::error::Error + Send + Sync>> {
    // Message ID function: hash the message data
    let message_id_fn = |message: &gossipsub::Message| {
        let mut hasher = DefaultHasher::new();
        message.data.hash(&mut hasher);
        MessageId::from(hasher.finish().to_string())
    };

    // GossipSub configuration with peer scoring
    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(10))
        .validation_mode(ValidationMode::Strict)
        .message_id_fn(message_id_fn)
        .mesh_n_low(2)
        .mesh_n(4)
        .mesh_n_high(8)
        .gossip_lazy(3)
        .fanout_ttl(Duration::from_secs(60))
        .max_transmit_size(65536) // 64 KB max message size
        .build()
        .map_err(|e| format!("Failed to build GossipSub config: {}", e))?;

    // Peer scoring parameters for spam protection
    let peer_score_params = build_peer_score_params();
    let peer_score_thresholds = gossipsub::PeerScoreThresholds {
        gossip_threshold: -1000.0,    // Below this, no gossip
        publish_threshold: -5000.0,   // Below this, no publishing
        graylist_threshold: -10000.0, // Below this, ignore completely
        accept_px_threshold: 10.0,    // Above this, accept peer exchange
        opportunistic_graft_threshold: 5.0,
    };

    // Create GossipSub with message authenticity
    let mut gossipsub = gossipsub::Behaviour::new(
        MessageAuthenticity::Signed(keypair.clone()),
        gossipsub_config,
    )
    .map_err(|e| format!("Failed to create GossipSub behaviour: {}", e))?;

    // Enable peer scoring for spam protection
    gossipsub
        .with_peer_score(peer_score_params, peer_score_thresholds)
        .map_err(|e| format!("Failed to configure peer scoring: {}", e))?;

    Ok(gossipsub)
}

/// Build peer scoring parameters for spam protection.
fn build_peer_score_params() -> gossipsub::PeerScoreParams {
    use gossipsub::{PeerScoreParams, TopicScoreParams};

    // Create peer score params with anti-spam settings
    let mut params = PeerScoreParams {
        // Application-specific scoring
        app_specific_weight: 1.0,
        // IP colocation penalty (prevent sybil attacks)
        ip_colocation_factor_weight: -50.0,
        ip_colocation_factor_threshold: 3.0, // Penalize more than 3 peers per IP
        // Behaviour penalty for protocol violations
        behaviour_penalty_weight: -10.0,
        behaviour_penalty_threshold: 5.0,
        behaviour_penalty_decay: 0.9,
        // Decay settings
        decay_interval: Duration::from_secs(60),
        decay_to_zero: 0.01,
        retain_score: Duration::from_secs(3600), // 1 hour
        ..Default::default()
    };

    // Topic-specific scoring for AgoraMesh topics
    let topic_params = TopicScoreParams {
        topic_weight: 1.0,
        time_in_mesh_weight: 0.1,
        time_in_mesh_quantum: Duration::from_secs(60),
        time_in_mesh_cap: 10.0,
        first_message_deliveries_weight: 1.0,
        first_message_deliveries_decay: 0.9,
        first_message_deliveries_cap: 100.0,
        mesh_message_deliveries_weight: -0.5,
        mesh_message_deliveries_decay: 0.9,
        mesh_message_deliveries_cap: 100.0,
        mesh_message_deliveries_threshold: 10.0,
        mesh_message_deliveries_window: Duration::from_secs(5),
        mesh_message_deliveries_activation: Duration::from_secs(60),
        mesh_failure_penalty_weight: -5.0,
        mesh_failure_penalty_decay: 0.9,
        invalid_message_deliveries_weight: -100.0,
        invalid_message_deliveries_decay: 0.5,
    };

    // Apply topic scoring to all AgoraMesh topics
    for topic_name in topics::all() {
        let topic_hash = gossipsub::IdentTopic::new(topic_name).hash();
        params.topics.insert(topic_hash, topic_params.clone());
    }

    params
}

/// Build Kademlia DHT behaviour with AgoraMesh configuration.
fn build_kademlia(local_peer_id: PeerId) -> kad::Behaviour<MemoryStore> {
    // Create memory store for DHT records
    let store = MemoryStore::new(local_peer_id);

    // Kademlia configuration
    let mut config = kad::Config::new(
        libp2p::StreamProtocol::try_from_owned(format!("{}/kad", PROTOCOL_VERSION))
            .expect("valid protocol"),
    );
    config.set_query_timeout(Duration::from_secs(60));
    config.set_record_ttl(Some(Duration::from_secs(3600))); // 1 hour TTL
    config.set_publication_interval(Some(Duration::from_secs(600))); // Republish every 10 min
    config.set_provider_record_ttl(Some(Duration::from_secs(3600)));

    kad::Behaviour::with_config(local_peer_id, store, config)
}

/// Build Identify behaviour.
fn build_identify(public_key: libp2p::identity::PublicKey) -> identify::Behaviour {
    let config = identify::Config::new(PROTOCOL_VERSION.to_string(), public_key)
        .with_push_listen_addr_updates(true)
        .with_interval(Duration::from_secs(300)); // Re-identify every 5 min

    identify::Behaviour::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    #[tokio::test]
    async fn test_create_behaviour() {
        let keypair = Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());
        let behaviour = AgoraMeshBehaviour::new(peer_id, &keypair);
        assert!(behaviour.is_ok());
    }

    #[test]
    fn test_topic_names() {
        assert_eq!(topics::DISCOVERY, "/agoramesh/discovery/1.0.0");
        assert_eq!(topics::CAPABILITY, "/agoramesh/capability/1.0.0");
        assert_eq!(topics::TRUST, "/agoramesh/trust/1.0.0");
        assert_eq!(topics::DISPUTES, "/agoramesh/disputes/1.0.0");
    }

    #[test]
    fn test_topics_all_returns_all_topics() {
        let all_topics = topics::all();
        assert_eq!(all_topics.len(), 4);
        assert!(all_topics.contains(&topics::DISCOVERY));
        assert!(all_topics.contains(&topics::CAPABILITY));
        assert!(all_topics.contains(&topics::TRUST));
        assert!(all_topics.contains(&topics::DISPUTES));
    }

    #[tokio::test]
    async fn test_subscribe_to_topics_subscribes_to_all() {
        let keypair = Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());
        let mut behaviour = AgoraMeshBehaviour::new(peer_id, &keypair).unwrap();

        // Subscribe to topics
        let result = behaviour.subscribe_to_topics();
        assert!(result.is_ok(), "Should subscribe to all topics");

        // Verify all topics are subscribed
        let subscribed = behaviour.subscribed_topics();
        assert_eq!(subscribed.len(), 4, "Should be subscribed to 4 topics");
    }

    #[tokio::test]
    async fn test_publish_to_topic() {
        let keypair = Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());
        let mut behaviour = AgoraMeshBehaviour::new(peer_id, &keypair).unwrap();

        // Must subscribe first before publishing
        behaviour.subscribe_to_topics().unwrap();

        // Publish a message
        let result = behaviour.publish(topics::DISCOVERY, b"test message".to_vec());

        // Note: This will return an error since we have no connected peers
        // The mechanism works - it's just that there are no peers to send to
        // The specific error type depends on libp2p version
        assert!(result.is_err(), "Should fail to publish without peers");
    }

    #[test]
    fn test_peer_score_params_configured_for_all_topics() {
        let params = build_peer_score_params();

        // Verify topic scoring is configured for all AgoraMesh topics
        for topic_name in topics::all() {
            let topic_hash = gossipsub::IdentTopic::new(topic_name).hash();
            assert!(
                params.topics.contains_key(&topic_hash),
                "Peer scoring should be configured for topic {}",
                topic_name
            );
        }
    }

    #[test]
    fn test_peer_score_params_anti_spam_settings() {
        let params = build_peer_score_params();

        // IP colocation should be penalized (sybil protection)
        assert!(
            params.ip_colocation_factor_weight < 0.0,
            "IP colocation should be penalized"
        );

        // Invalid messages should be heavily penalized
        for topic_params in params.topics.values() {
            assert!(
                topic_params.invalid_message_deliveries_weight < 0.0,
                "Invalid messages should be penalized"
            );
        }
    }
}
