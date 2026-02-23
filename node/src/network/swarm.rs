//! libp2p swarm management.
//!
//! Handles swarm creation, event processing, and network operations.

use futures::StreamExt;
use libp2p::{
    gossipsub::{self, MessageId},
    identify, kad, mdns,
    swarm::{dial_opts::DialOpts, SwarmEvent},
    Multiaddr, PeerId, Swarm,
};
use std::collections::{HashMap, HashSet};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use super::behaviour::{topics, AgoraMeshBehaviour, AgoraMeshEvent};
use super::transport::build_transport;
use crate::config::NetworkConfig;
use crate::error::{Error, Result};

/// Commands that can be sent to the swarm manager.
#[derive(Debug)]
pub enum SwarmCommand {
    /// Dial a peer at the given address.
    Dial(Multiaddr),
    /// Publish a message to a topic.
    Publish { topic: String, data: Vec<u8> },
    /// Get the list of connected peers.
    GetPeers(tokio::sync::oneshot::Sender<Vec<PeerId>>),
    /// Bootstrap the DHT.
    Bootstrap,
    /// Store a record in the DHT.
    PutRecord {
        /// The record key.
        key: Vec<u8>,
        /// The record value.
        value: Vec<u8>,
    },
    /// Get a record from the DHT.
    GetRecord {
        /// The record key.
        key: Vec<u8>,
        /// Channel to send the result.
        response_tx: tokio::sync::oneshot::Sender<Option<Vec<u8>>>,
    },
    /// Shutdown the swarm.
    Shutdown,
}

/// Events emitted by the swarm manager to the application.
#[derive(Debug, Clone)]
pub enum NetworkEvent {
    /// A new peer connected.
    PeerConnected(PeerId),
    /// A peer disconnected.
    PeerDisconnected(PeerId),
    /// Received a GossipSub message.
    Message {
        /// The topic the message was published to.
        topic: String,
        /// The peer that sent the message.
        source: Option<PeerId>,
        /// The message data.
        data: Vec<u8>,
        /// The message ID.
        message_id: MessageId,
    },
    /// A peer was discovered via mDNS.
    PeerDiscovered(PeerId),
    /// Kademlia bootstrap completed.
    BootstrapComplete,
    /// DHT record retrieved.
    RecordFound {
        /// The record key.
        key: Vec<u8>,
        /// The record value (None if not found).
        value: Option<Vec<u8>>,
    },
    /// DHT record stored.
    RecordStored {
        /// The record key.
        key: Vec<u8>,
    },
}

/// Manager for the libp2p swarm.
///
/// Handles all P2P networking operations including:
/// - Peer connections and management
/// - GossipSub message publishing and subscription
/// - Kademlia DHT operations
/// - mDNS local discovery
pub struct SwarmManager {
    /// The libp2p swarm.
    swarm: Swarm<AgoraMeshBehaviour>,

    /// Local peer ID.
    local_peer_id: PeerId,

    /// Channel for receiving commands.
    command_rx: mpsc::Receiver<SwarmCommand>,

    /// Channel for sending events to the application.
    event_tx: mpsc::Sender<NetworkEvent>,

    /// Set of currently connected peers.
    connected_peers: HashSet<PeerId>,

    /// Bootstrap peers to connect to.
    bootstrap_peers: Vec<Multiaddr>,

    /// Pending GetRecord queries (query_id -> response_tx).
    pending_get_queries: HashMap<kad::QueryId, oneshot::Sender<Option<Vec<u8>>>>,
}

impl SwarmManager {
    /// Create a new swarm manager.
    ///
    /// # Arguments
    ///
    /// * `config` - Network configuration
    ///
    /// # Returns
    ///
    /// A tuple of (SwarmManager, command_sender, event_receiver).
    pub fn new(
        config: &NetworkConfig,
    ) -> Result<(
        Self,
        mpsc::Sender<SwarmCommand>,
        mpsc::Receiver<NetworkEvent>,
    )> {
        let keypair = libp2p::identity::Keypair::generate_ed25519();
        Self::with_keypair(config, keypair)
    }

    /// Create a swarm manager with an existing keypair.
    ///
    /// # Arguments
    ///
    /// * `config` - Network configuration
    /// * `keypair` - The node's identity keypair
    pub fn with_keypair(
        config: &NetworkConfig,
        keypair: libp2p::identity::Keypair,
    ) -> Result<(
        Self,
        mpsc::Sender<SwarmCommand>,
        mpsc::Receiver<NetworkEvent>,
    )> {
        let local_peer_id = PeerId::from(keypair.public());
        info!("Local peer ID: {}", local_peer_id);

        let transport = build_transport(&keypair)?;

        let behaviour = AgoraMeshBehaviour::new(local_peer_id, &keypair)
            .map_err(|e| Error::Network(format!("Failed to create behaviour: {}", e)))?;

        let swarm = Swarm::new(
            transport,
            behaviour,
            local_peer_id,
            libp2p::swarm::Config::with_tokio_executor()
                .with_idle_connection_timeout(std::time::Duration::from_secs(60)),
        );

        let bootstrap_peers: Vec<Multiaddr> = config
            .bootstrap_peers
            .iter()
            .filter_map(|addr| {
                addr.parse()
                    .map_err(|e| {
                        warn!("Invalid bootstrap peer address '{}': {}", addr, e);
                        e
                    })
                    .ok()
            })
            .collect();

        let (command_tx, command_rx) = mpsc::channel(256);
        let (event_tx, event_rx) = mpsc::channel(256);

        let manager = Self {
            swarm,
            local_peer_id,
            command_rx,
            event_tx,
            connected_peers: HashSet::new(),
            bootstrap_peers,
            pending_get_queries: HashMap::new(),
        };

        Ok((manager, command_tx, event_rx))
    }

    /// Get the local peer ID.
    pub fn local_peer_id(&self) -> PeerId {
        self.local_peer_id
    }

    /// Start listening and run the event loop.
    ///
    /// # Arguments
    ///
    /// * `listen_addresses` - Addresses to listen on
    pub async fn run(mut self, listen_addresses: &[String]) -> Result<()> {
        // Start listening on configured addresses
        for addr_str in listen_addresses {
            let addr: Multiaddr = addr_str.parse().map_err(|e| {
                Error::Network(format!("Invalid listen address '{}': {}", addr_str, e))
            })?;

            self.swarm
                .listen_on(addr.clone())
                .map_err(|e| Error::Network(format!("Failed to listen on {}: {}", addr, e)))?;

            info!("Listening on {}", addr);
        }

        // Subscribe to GossipSub topics
        self.swarm
            .behaviour_mut()
            .subscribe_to_topics()
            .map_err(|e| Error::Network(format!("Failed to subscribe to topics: {}", e)))?;
        info!("Subscribed to topics: {:?}", topics::all());

        // Add bootstrap peers to Kademlia and dial them
        for addr in self.bootstrap_peers.clone() {
            if let Some(peer_id) = extract_peer_id(&addr) {
                self.swarm
                    .behaviour_mut()
                    .add_address(&peer_id, addr.clone());
                debug!("Added bootstrap peer {} to Kademlia", peer_id);

                // Dial the bootstrap peer
                if let Err(e) = self.swarm.dial(addr.clone()) {
                    warn!("Failed to dial bootstrap peer {}: {}", addr, e);
                }
            }
        }

        // Bootstrap Kademlia if we have peers
        if !self.bootstrap_peers.is_empty() {
            match self.swarm.behaviour_mut().bootstrap() {
                Ok(_) => info!("Started Kademlia bootstrap"),
                Err(e) => warn!("Failed to bootstrap Kademlia: {:?}", e),
            }
        }

        // Run the event loop
        self.run_event_loop().await
    }

    /// Main event loop for processing swarm events and commands.
    async fn run_event_loop(mut self) -> Result<()> {
        info!("Starting swarm event loop");

        loop {
            tokio::select! {
                // Handle swarm events
                event = self.swarm.select_next_some() => {
                    self.handle_swarm_event(event).await;
                }

                // Handle commands
                Some(command) = self.command_rx.recv() => {
                    match command {
                        SwarmCommand::Shutdown => {
                            info!("Received shutdown command");
                            break;
                        }
                        _ => self.handle_command(command).await,
                    }
                }
            }
        }

        info!("Swarm event loop terminated");
        Ok(())
    }

    /// Handle a swarm event.
    async fn handle_swarm_event(&mut self, event: SwarmEvent<AgoraMeshEvent>) {
        match event {
            SwarmEvent::Behaviour(behaviour_event) => {
                self.handle_behaviour_event(behaviour_event).await;
            }
            SwarmEvent::ConnectionEstablished {
                peer_id,
                endpoint,
                num_established,
                ..
            } => {
                debug!(
                    "Connection established with {} ({} connections) via {:?}",
                    peer_id, num_established, endpoint
                );
                self.connected_peers.insert(peer_id);
                let _ = self
                    .event_tx
                    .send(NetworkEvent::PeerConnected(peer_id))
                    .await;
            }
            SwarmEvent::ConnectionClosed {
                peer_id,
                num_established,
                ..
            } => {
                debug!(
                    "Connection closed with {} ({} remaining)",
                    peer_id, num_established
                );
                if num_established == 0 {
                    self.connected_peers.remove(&peer_id);
                    let _ = self
                        .event_tx
                        .send(NetworkEvent::PeerDisconnected(peer_id))
                        .await;
                }
            }
            SwarmEvent::NewListenAddr { address, .. } => {
                info!("Listening on {}/p2p/{}", address, self.local_peer_id);
            }
            SwarmEvent::ListenerClosed {
                addresses, reason, ..
            } => {
                warn!("Listener closed for {:?}: {:?}", addresses, reason);
            }
            SwarmEvent::ListenerError { error, .. } => {
                error!("Listener error: {}", error);
            }
            SwarmEvent::IncomingConnection {
                local_addr,
                send_back_addr,
                ..
            } => {
                debug!(
                    "Incoming connection from {} on {}",
                    send_back_addr, local_addr
                );
            }
            SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                warn!("Outgoing connection error to {:?}: {}", peer_id, error);
            }
            SwarmEvent::IncomingConnectionError {
                local_addr,
                send_back_addr,
                error,
                ..
            } => {
                warn!(
                    "Incoming connection error from {} on {}: {}",
                    send_back_addr, local_addr, error
                );
            }
            SwarmEvent::Dialing { peer_id, .. } => {
                debug!("Dialing {:?}", peer_id);
            }
            _ => {
                debug!("Unhandled swarm event");
            }
        }
    }

    /// Handle behaviour-specific events.
    async fn handle_behaviour_event(&mut self, event: AgoraMeshEvent) {
        match event {
            AgoraMeshEvent::Gossipsub(gossipsub::Event::Message {
                propagation_source,
                message_id,
                message,
            }) => {
                let topic = message.topic.to_string();
                debug!(
                    "Received message on topic '{}' from {:?}: {} bytes",
                    topic,
                    propagation_source,
                    message.data.len()
                );

                let _ = self
                    .event_tx
                    .send(NetworkEvent::Message {
                        topic,
                        source: message.source,
                        data: message.data,
                        message_id,
                    })
                    .await;
            }
            AgoraMeshEvent::Gossipsub(gossipsub::Event::Subscribed { peer_id, topic }) => {
                debug!("Peer {} subscribed to topic {}", peer_id, topic);
            }
            AgoraMeshEvent::Gossipsub(gossipsub::Event::Unsubscribed { peer_id, topic }) => {
                debug!("Peer {} unsubscribed from topic {}", peer_id, topic);
            }
            AgoraMeshEvent::Gossipsub(_) => {
                // Other GossipSub events (GraftReceived, PruneReceived, etc.)
            }

            AgoraMeshEvent::Kademlia(kad::Event::OutboundQueryProgressed { id, result, .. }) => {
                match result {
                    kad::QueryResult::Bootstrap(Ok(_)) => {
                        info!("Kademlia bootstrap completed");
                        let _ = self.event_tx.send(NetworkEvent::BootstrapComplete).await;
                    }
                    kad::QueryResult::Bootstrap(Err(e)) => {
                        warn!("Kademlia bootstrap failed: {:?}", e);
                    }
                    kad::QueryResult::GetClosestPeers(Ok(result)) => {
                        debug!("Found {} closest peers to key", result.peers.len());
                    }
                    kad::QueryResult::GetClosestPeers(Err(e)) => {
                        warn!("GetClosestPeers failed: {:?}", e);
                    }
                    kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FoundRecord(peer_record))) => {
                        debug!("Got record from DHT");
                        let key = peer_record.record.key.to_vec();
                        let value = peer_record.record.value.clone();

                        // Send to pending query if any
                        if let Some(tx) = self.pending_get_queries.remove(&id) {
                            let _ = tx.send(Some(value.clone()));
                        }

                        // Also emit event for general processing
                        let _ = self
                            .event_tx
                            .send(NetworkEvent::RecordFound {
                                key,
                                value: Some(value),
                            })
                            .await;
                    }
                    kad::QueryResult::GetRecord(Ok(
                        kad::GetRecordOk::FinishedWithNoAdditionalRecord { .. },
                    )) => {
                        debug!("GetRecord finished with no additional records");
                    }
                    kad::QueryResult::GetRecord(Err(e)) => {
                        debug!("GetRecord failed: {:?}", e);
                        // Send None to pending query
                        if let Some(tx) = self.pending_get_queries.remove(&id) {
                            let _ = tx.send(None);
                        }
                    }
                    kad::QueryResult::PutRecord(Ok(kad::PutRecordOk { key })) => {
                        debug!("Successfully put record for key {:?}", key);
                        let _ = self
                            .event_tx
                            .send(NetworkEvent::RecordStored { key: key.to_vec() })
                            .await;
                    }
                    kad::QueryResult::PutRecord(Err(e)) => {
                        warn!("PutRecord failed: {:?}", e);
                    }
                    _ => {}
                }
            }
            AgoraMeshEvent::Kademlia(kad::Event::RoutingUpdated {
                peer, addresses, ..
            }) => {
                debug!(
                    "Kademlia routing updated for peer {}: {:?}",
                    peer, addresses
                );
            }
            AgoraMeshEvent::Kademlia(_) => {
                // Other Kademlia events
            }

            AgoraMeshEvent::Identify(event) => match *event {
                identify::Event::Received { peer_id, info, .. } => {
                    debug!(
                        "Identified peer {}: {} ({} addrs)",
                        peer_id,
                        info.protocol_version,
                        info.listen_addrs.len()
                    );

                    // Add discovered addresses to Kademlia
                    for addr in info.listen_addrs {
                        self.swarm.behaviour_mut().add_address(&peer_id, addr);
                    }
                }
                identify::Event::Sent { peer_id, .. } => {
                    debug!("Sent identify info to {}", peer_id);
                }
                identify::Event::Pushed { peer_id, .. } => {
                    debug!("Pushed identify info to {}", peer_id);
                }
                identify::Event::Error { peer_id, error, .. } => {
                    warn!("Identify error with {}: {}", peer_id, error);
                }
            },

            AgoraMeshEvent::Mdns(mdns::Event::Discovered(peers)) => {
                for (peer_id, addr) in peers {
                    debug!("mDNS discovered peer {} at {}", peer_id, addr);
                    self.swarm
                        .behaviour_mut()
                        .add_address(&peer_id, addr.clone());

                    // Dial discovered peers
                    if !self.connected_peers.contains(&peer_id) {
                        let opts = DialOpts::peer_id(peer_id).addresses(vec![addr]).build();
                        if let Err(e) = self.swarm.dial(opts) {
                            debug!("Failed to dial mDNS peer {}: {}", peer_id, e);
                        }
                    }

                    let _ = self
                        .event_tx
                        .send(NetworkEvent::PeerDiscovered(peer_id))
                        .await;
                }
            }
            AgoraMeshEvent::Mdns(mdns::Event::Expired(peers)) => {
                for (peer_id, addr) in peers {
                    debug!("mDNS peer {} at {} expired", peer_id, addr);
                }
            }
        }
    }

    /// Handle a command from the application.
    async fn handle_command(&mut self, command: SwarmCommand) {
        match command {
            SwarmCommand::Dial(addr) => {
                debug!("Dialing {}", addr);
                if let Err(e) = self.swarm.dial(addr.clone()) {
                    error!("Failed to dial {}: {}", addr, e);
                }
            }
            SwarmCommand::Publish { topic, data } => {
                match self.swarm.behaviour_mut().publish(&topic, data) {
                    Ok(msg_id) => {
                        debug!("Published message {} to topic {}", msg_id, topic);
                    }
                    Err(e) => {
                        error!("Failed to publish to {}: {:?}", topic, e);
                    }
                }
            }
            SwarmCommand::GetPeers(response_tx) => {
                let peers: Vec<PeerId> = self.connected_peers.iter().copied().collect();
                let _ = response_tx.send(peers);
            }
            SwarmCommand::Bootstrap => match self.swarm.behaviour_mut().bootstrap() {
                Ok(_) => info!("Started Kademlia bootstrap"),
                Err(e) => warn!("Failed to bootstrap: {:?}", e),
            },
            SwarmCommand::PutRecord { key, value } => {
                let record = kad::Record {
                    key: kad::RecordKey::new(&key),
                    value,
                    publisher: None,
                    expires: None,
                };
                match self
                    .swarm
                    .behaviour_mut()
                    .kademlia
                    .put_record(record, kad::Quorum::One)
                {
                    Ok(_) => {
                        debug!("Started PutRecord for key {:?}", key);
                    }
                    Err(e) => {
                        error!("Failed to put DHT record: {:?}", e);
                    }
                }
            }
            SwarmCommand::GetRecord { key, response_tx } => {
                let kad_key = kad::RecordKey::new(&key);
                let query_id = self.swarm.behaviour_mut().kademlia.get_record(kad_key);
                self.pending_get_queries.insert(query_id, response_tx);
                debug!("Started GetRecord for key {:?}", key);
            }
            SwarmCommand::Shutdown => {
                // Handled in run_event_loop
            }
        }
    }
}

/// Extract peer ID from a multiaddr if present.
fn extract_peer_id(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|protocol| {
        if let libp2p::multiaddr::Protocol::P2p(peer_id) = protocol {
            Some(peer_id)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NetworkConfig;

    fn test_config() -> NetworkConfig {
        NetworkConfig {
            listen_addresses: vec!["/ip4/127.0.0.1/tcp/0".to_string()],
            bootstrap_peers: vec![],
            max_connections: 50,
        }
    }

    #[tokio::test]
    async fn test_create_swarm_manager() {
        let config = test_config();
        let result = SwarmManager::new(&config);
        assert!(result.is_ok());

        let (manager, _cmd_tx, _event_rx) = result.unwrap();
        assert!(!manager.local_peer_id.to_string().is_empty());
    }

    #[test]
    fn test_extract_peer_id() {
        let addr: Multiaddr =
            "/ip4/127.0.0.1/tcp/9000/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN"
                .parse()
                .unwrap();
        let peer_id = extract_peer_id(&addr);
        assert!(peer_id.is_some());

        let addr_no_peer: Multiaddr = "/ip4/127.0.0.1/tcp/9000".parse().unwrap();
        let peer_id = extract_peer_id(&addr_no_peer);
        assert!(peer_id.is_none());
    }
}
