//! Network message handler for GossipSub messages.
//!
//! This module handles:
//! - Parsing incoming GossipSub messages by topic
//! - Routing messages to appropriate handlers
//! - Processing discovery, capability, and trust messages

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::arbitration::{AIArbitrator, Evidence, EvidenceType};
use crate::discovery::{CapabilityCard, DiscoveryService};
use crate::error::{Error, Result};
use crate::trust::TrustService;

use super::behaviour::topics;
use super::NetworkEvent;

/// Maximum allowed length for evidence title (256 characters).
pub const MAX_EVIDENCE_TITLE_LEN: usize = 256;

/// Maximum allowed length for evidence description (10KB).
pub const MAX_EVIDENCE_DESC_LEN: usize = 10 * 1024;

/// Message types for the discovery topic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DiscoveryMessage {
    /// A capability card announcement.
    #[serde(rename = "card_announcement")]
    CardAnnouncement {
        /// The capability card being announced (boxed to reduce enum size).
        card: Box<CapabilityCard>,
    },
    /// A request for other nodes to announce their agents.
    #[serde(rename = "discovery_request")]
    DiscoveryRequest {
        /// Request timestamp (Unix seconds).
        timestamp: u64,
    },
}

/// Message types for the trust topic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TrustMessage {
    /// A trust score update.
    #[serde(rename = "trust_update")]
    TrustUpdate {
        /// The agent's DID.
        did: String,
        /// Updated trust score.
        trust_score: f64,
        /// Timestamp of the update.
        timestamp: u64,
    },
    /// A reputation event (success/failure).
    #[serde(rename = "reputation_event")]
    ReputationEvent {
        /// The agent's DID.
        did: String,
        /// Whether the transaction was successful.
        success: bool,
        /// Transaction amount in USDC (6 decimals).
        amount: u64,
        /// Timestamp of the event.
        timestamp: u64,
    },
}

/// Message types for the disputes topic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DisputeMessage {
    /// Request to create a new dispute.
    #[serde(rename = "create_dispute")]
    CreateDispute {
        /// Escrow ID this dispute is for.
        escrow_id: String,
        /// Client DID (buyer).
        client_did: String,
        /// Provider DID (seller).
        provider_did: String,
        /// Dispute amount in USDC (6 decimals).
        amount_usdc: u64,
        /// Timestamp of the request.
        timestamp: u64,
    },
    /// Submit evidence for an existing dispute.
    #[serde(rename = "submit_evidence")]
    SubmitEvidence {
        /// The dispute ID.
        dispute_id: String,
        /// Who is submitting (client or provider DID).
        submitter_did: String,
        /// Evidence title.
        title: String,
        /// Evidence description/content.
        description: String,
        /// Timestamp of submission.
        timestamp: u64,
    },
    /// Request dispute status.
    #[serde(rename = "dispute_status")]
    DisputeStatus {
        /// The dispute ID to query.
        dispute_id: String,
        /// Timestamp of the request.
        timestamp: u64,
    },
}

/// Statistics for message handling.
#[derive(Debug, Default)]
pub struct MessageHandlerStats {
    /// Total messages received.
    pub messages_received: u64,
    /// Messages successfully processed.
    pub messages_processed: u64,
    /// Messages that failed to parse.
    pub parse_errors: u64,
    /// Discovery messages received.
    pub discovery_messages: u64,
    /// Trust messages received.
    pub trust_messages: u64,
    /// Dispute messages received.
    pub dispute_messages: u64,
    /// Unknown topic messages received.
    pub unknown_topic_messages: u64,
}

impl MessageHandlerStats {
    /// Record a message received.
    pub fn record_received(&mut self) {
        self.messages_received += 1;
    }

    /// Record a message processed.
    pub fn record_processed(&mut self) {
        self.messages_processed += 1;
    }

    /// Record a parse error.
    pub fn record_parse_error(&mut self) {
        self.parse_errors += 1;
    }

    /// Record a discovery message.
    pub fn record_discovery(&mut self) {
        self.discovery_messages += 1;
    }

    /// Record a dispute message.
    pub fn record_dispute(&mut self) {
        self.dispute_messages += 1;
    }

    /// Record a trust message.
    pub fn record_trust(&mut self) {
        self.trust_messages += 1;
    }

    /// Record an unknown topic.
    pub fn record_unknown_topic(&mut self) {
        self.unknown_topic_messages += 1;
    }
}

/// Handler for incoming network messages.
///
/// Routes messages by topic and dispatches to appropriate handlers.
pub struct MessageHandler {
    /// Discovery service for caching capability cards.
    discovery_service: Arc<DiscoveryService>,

    /// Optional trust service for recording reputation events.
    trust_service: Option<Arc<TrustService>>,

    /// Optional arbitrator for handling disputes.
    arbitrator: Option<Arc<AIArbitrator>>,

    /// Handler statistics.
    stats: RwLock<MessageHandlerStats>,
}

impl MessageHandler {
    /// Create a new message handler without TrustService or Arbitrator.
    pub fn new(discovery_service: Arc<DiscoveryService>) -> Self {
        Self {
            discovery_service,
            trust_service: None,
            arbitrator: None,
            stats: RwLock::new(MessageHandlerStats::default()),
        }
    }

    /// Create a new message handler with optional TrustService.
    pub fn with_trust_service(
        discovery_service: Arc<DiscoveryService>,
        trust_service: Option<Arc<TrustService>>,
    ) -> Self {
        Self {
            discovery_service,
            trust_service,
            arbitrator: None,
            stats: RwLock::new(MessageHandlerStats::default()),
        }
    }

    /// Create a fully configured message handler with all optional services.
    pub fn with_services(
        discovery_service: Arc<DiscoveryService>,
        trust_service: Option<Arc<TrustService>>,
        arbitrator: Option<Arc<AIArbitrator>>,
    ) -> Self {
        Self {
            discovery_service,
            trust_service,
            arbitrator,
            stats: RwLock::new(MessageHandlerStats::default()),
        }
    }

    /// Handle an incoming network event.
    ///
    /// Routes the message to the appropriate handler based on topic.
    pub async fn handle_event(&self, event: &NetworkEvent) -> Result<()> {
        match event {
            NetworkEvent::Message {
                topic,
                source,
                data,
                ..
            } => {
                self.stats.write().await.record_received();

                debug!(
                    "Handling message on topic {} from {:?} ({} bytes)",
                    topic,
                    source,
                    data.len()
                );

                self.route_message(topic, data, source.as_ref()).await
            }
            _ => {
                // Not a message event, ignore
                Ok(())
            }
        }
    }

    /// Route a message to the appropriate handler based on topic.
    async fn route_message(
        &self,
        topic: &str,
        data: &[u8],
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        match topic {
            topics::DISCOVERY => self.handle_discovery_message(data, source).await,
            topics::CAPABILITY => self.handle_capability_message(data, source).await,
            topics::TRUST => self.handle_trust_message(data, source).await,
            topics::DISPUTES => self.handle_dispute_message(data, source).await,
            _ => {
                self.stats.write().await.record_unknown_topic();
                warn!("Received message on unknown topic: {}", topic);
                Ok(())
            }
        }
    }

    /// Handle a message on the discovery topic.
    async fn handle_discovery_message(
        &self,
        data: &[u8],
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        self.stats.write().await.record_discovery();

        // Try to parse as DiscoveryMessage first
        match serde_json::from_slice::<DiscoveryMessage>(data) {
            Ok(message) => {
                self.process_discovery_message(message, source).await?;
                self.stats.write().await.record_processed();
                Ok(())
            }
            Err(_) => {
                // Try parsing as raw CapabilityCard (backward compatibility)
                match serde_json::from_slice::<CapabilityCard>(data) {
                    Ok(card) => {
                        self.process_card_announcement(card, source).await?;
                        self.stats.write().await.record_processed();
                        Ok(())
                    }
                    Err(e) => {
                        self.stats.write().await.record_parse_error();
                        warn!("Failed to parse discovery message: {}", e);
                        Err(Error::Network(format!(
                            "Failed to parse discovery message: {}",
                            e
                        )))
                    }
                }
            }
        }
    }

    /// Process a parsed discovery message.
    async fn process_discovery_message(
        &self,
        message: DiscoveryMessage,
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        match message {
            DiscoveryMessage::CardAnnouncement { card } => {
                self.process_card_announcement(*card, source).await
            }
            DiscoveryMessage::DiscoveryRequest { timestamp } => {
                self.process_discovery_request(timestamp, source).await
            }
        }
    }

    /// Process a capability card announcement.
    async fn process_card_announcement(
        &self,
        card: CapabilityCard,
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        let did = card
            .agentme
            .as_ref()
            .map(|ext| ext.did.as_str())
            .unwrap_or("unknown");

        info!("Received card announcement for {} from {:?}", did, source);

        // Register the card in our local discovery service
        // Note: This will also index in HybridSearch if available
        self.discovery_service.register(&card).await?;

        debug!("Cached card for {}", did);
        Ok(())
    }

    /// Process a discovery request (request for registry broadcast).
    async fn process_discovery_request(
        &self,
        timestamp: u64,
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        info!(
            "Received discovery request (timestamp: {}) from {:?}",
            timestamp, source
        );

        // The response is handled at a higher level - we just log the request here
        // The NetworkManager or main loop should decide whether to re-announce agents
        debug!("Discovery request processed (response handled by caller)");
        Ok(())
    }

    /// Handle a message on the capability topic.
    async fn handle_capability_message(
        &self,
        data: &[u8],
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        // Capability messages are similar to discovery card announcements
        // but specifically for capability updates
        match serde_json::from_slice::<CapabilityCard>(data) {
            Ok(card) => {
                info!("Received capability update from {:?}", source);
                self.discovery_service.register(&card).await?;
                self.stats.write().await.record_processed();
                Ok(())
            }
            Err(e) => {
                self.stats.write().await.record_parse_error();
                warn!("Failed to parse capability message: {}", e);
                Err(Error::Network(format!(
                    "Failed to parse capability message: {}",
                    e
                )))
            }
        }
    }

    /// Handle a message on the trust topic.
    async fn handle_trust_message(
        &self,
        data: &[u8],
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        self.stats.write().await.record_trust();

        match serde_json::from_slice::<TrustMessage>(data) {
            Ok(message) => {
                self.process_trust_message(message, source).await?;
                self.stats.write().await.record_processed();
                Ok(())
            }
            Err(e) => {
                self.stats.write().await.record_parse_error();
                warn!("Failed to parse trust message: {}", e);
                Err(Error::Network(format!(
                    "Failed to parse trust message: {}",
                    e
                )))
            }
        }
    }

    /// Process a parsed trust message.
    async fn process_trust_message(
        &self,
        message: TrustMessage,
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        match message {
            TrustMessage::TrustUpdate {
                did,
                trust_score,
                timestamp,
            } => {
                // Validate trust score range [0.0, 1.0]
                if !(0.0..=1.0).contains(&trust_score) {
                    warn!(
                        "Rejecting trust update: score {} out of range [0.0, 1.0] for {}",
                        trust_score, did
                    );
                    return Err(Error::Validation(format!(
                        "Trust score {} out of valid range [0.0, 1.0]",
                        trust_score
                    )));
                }

                // Validate DID format (must start with "did:")
                if !did.starts_with("did:") {
                    warn!("Rejecting trust update: invalid DID format: {}", did);
                    return Err(Error::Validation(format!("Invalid DID format: {}", did)));
                }

                // Validate timestamp is not in the future (with 5 minute grace period)
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
                    .as_secs();
                let grace_period = 300; // 5 minutes
                if timestamp > now + grace_period {
                    warn!(
                        "Rejecting trust update: timestamp {} is in the future for {}",
                        timestamp, did
                    );
                    return Err(Error::Validation(format!(
                        "Timestamp {} is in the future",
                        timestamp
                    )));
                }

                info!(
                    "Received trust update for {}: score={} from {:?}",
                    did, trust_score, source
                );

                // Validate against existing trust data if TrustService is available
                // This implements Gossipsub v1.1 extended validation pattern
                if let Some(ref trust_service) = self.trust_service {
                    // Get existing trust data for this agent
                    let existing_trust = trust_service.get_trust(&did).await;

                    // If agent has existing trust data, validate deviation
                    if let Ok(existing) = existing_trust {
                        // Only validate if agent has meaningful history (not brand new)
                        if existing.successful_transactions > 0 || existing.failed_transactions > 0
                        {
                            let existing_score = existing.score;
                            let deviation = (trust_score - existing_score).abs();
                            let max_deviation = 0.20; // 20% maximum allowed deviation

                            if deviation > max_deviation {
                                warn!(
                                    "Rejecting trust update: score {} deviates {}% from existing {} for {}",
                                    trust_score,
                                    (deviation * 100.0) as u32,
                                    existing_score,
                                    did
                                );
                                return Err(Error::Validation(format!(
                                    "Trust score {} deviates too much from existing score {} (max {}%)",
                                    trust_score, existing_score, (max_deviation * 100.0) as u32
                                )));
                            }
                            debug!(
                                "Trust update for {} validated: deviation {}% within acceptable range",
                                did,
                                (deviation * 100.0) as u32
                            );
                        }
                    }
                }

                debug!(
                    "Trust update for {} at timestamp {} accepted",
                    did, timestamp
                );
                Ok(())
            }
            TrustMessage::ReputationEvent {
                did,
                success,
                amount,
                timestamp,
            } => {
                // Validate DID format
                if !did.starts_with("did:") {
                    warn!("Rejecting reputation event: invalid DID format: {}", did);
                    return Err(Error::Validation(format!("Invalid DID format: {}", did)));
                }

                // Validate timestamp is not in the future
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
                    .as_secs();
                let grace_period = 300; // 5 minutes
                if timestamp > now + grace_period {
                    warn!(
                        "Rejecting reputation event: timestamp {} is in the future for {}",
                        timestamp, did
                    );
                    return Err(Error::Validation(format!(
                        "Timestamp {} is in the future",
                        timestamp
                    )));
                }

                info!(
                    "Received reputation event for {}: success={}, amount={} from {:?}",
                    did, success, amount, source
                );

                // Record in TrustService if available
                if let Some(ref trust_service) = self.trust_service {
                    if success {
                        trust_service.record_success(&did, amount).await?;
                        debug!("Recorded success for {} (amount={})", did, amount);
                    } else {
                        trust_service
                            .record_failure(&did, "P2P reputation event")
                            .await?;
                        debug!("Recorded failure for {}", did);
                    }
                } else {
                    debug!(
                        "Reputation event for {} at timestamp {} (no TrustService)",
                        did, timestamp
                    );
                }
                Ok(())
            }
        }
    }

    /// Handle a message on the disputes topic.
    async fn handle_dispute_message(
        &self,
        data: &[u8],
        source: Option<&libp2p::PeerId>,
    ) -> Result<()> {
        // Record dispute message
        self.stats.write().await.record_dispute();

        // Parse dispute message
        let message: DisputeMessage = serde_json::from_slice(data).map_err(|e| {
            let _ = self.stats.try_write().map(|mut s| s.record_parse_error());
            Error::Network(format!("Failed to parse dispute message: {}", e))
        })?;

        info!("Received dispute message from {:?}: {:?}", source, message);

        // Validate and process based on message type
        match message {
            DisputeMessage::CreateDispute {
                escrow_id,
                client_did,
                provider_did,
                amount_usdc,
                timestamp,
            } => self.process_create_dispute(
                escrow_id,
                client_did,
                provider_did,
                amount_usdc,
                timestamp,
            ),
            DisputeMessage::SubmitEvidence {
                dispute_id,
                submitter_did,
                title,
                description,
                timestamp,
            } => self.process_submit_evidence(
                dispute_id,
                submitter_did,
                title,
                description,
                timestamp,
            ),
            DisputeMessage::DisputeStatus {
                dispute_id,
                timestamp,
            } => self.process_dispute_status(dispute_id, timestamp),
        }
    }

    /// Process a CreateDispute message.
    fn process_create_dispute(
        &self,
        escrow_id: String,
        client_did: String,
        provider_did: String,
        amount_usdc: u64,
        timestamp: u64,
    ) -> Result<()> {
        // Validate DIDs
        if !client_did.starts_with("did:") {
            warn!(
                "Rejecting dispute: invalid client DID format: {}",
                client_did
            );
            return Err(Error::Validation(format!(
                "Invalid client DID format: {}",
                client_did
            )));
        }
        if !provider_did.starts_with("did:") {
            warn!(
                "Rejecting dispute: invalid provider DID format: {}",
                provider_did
            );
            return Err(Error::Validation(format!(
                "Invalid provider DID format: {}",
                provider_did
            )));
        }

        // Validate timestamp
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
            .as_secs();
        let grace_period = 300; // 5 minutes
        if timestamp > now + grace_period {
            warn!(
                "Rejecting dispute: timestamp {} is in the future",
                timestamp
            );
            return Err(Error::Validation(format!(
                "Timestamp {} is in the future",
                timestamp
            )));
        }

        // Route to arbitrator if available
        let arbitrator = self.arbitrator.as_ref().ok_or_else(|| {
            Error::Network("No arbitrator configured to handle disputes".to_string())
        })?;

        // Create the dispute
        let dispute_id = arbitrator.create_dispute(
            escrow_id.clone(),
            client_did.clone(),
            provider_did.clone(),
            amount_usdc,
        )?;

        info!(
            "Created dispute {}: escrow={}, client={}, provider={}, amount={}",
            dispute_id, escrow_id, client_did, provider_did, amount_usdc
        );
        Ok(())
    }

    /// Process a SubmitEvidence message.
    fn process_submit_evidence(
        &self,
        dispute_id: String,
        submitter_did: String,
        title: String,
        description: String,
        timestamp: u64,
    ) -> Result<()> {
        // Validate DID
        if !submitter_did.starts_with("did:") {
            warn!(
                "Rejecting evidence: invalid submitter DID: {}",
                submitter_did
            );
            return Err(Error::Validation(format!(
                "Invalid submitter DID format: {}",
                submitter_did
            )));
        }

        // Validate timestamp
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
            .as_secs();
        let grace_period = 300;
        if timestamp > now + grace_period {
            warn!(
                "Rejecting evidence: timestamp {} is in the future",
                timestamp
            );
            return Err(Error::Validation(format!(
                "Timestamp {} is in the future",
                timestamp
            )));
        }

        // Validate title
        if title.is_empty() {
            warn!("Rejecting evidence: title is empty");
            return Err(Error::Validation(
                "Evidence title cannot be empty".to_string(),
            ));
        }
        if title.len() > MAX_EVIDENCE_TITLE_LEN {
            warn!(
                "Rejecting evidence: title length {} exceeds maximum {}",
                title.len(),
                MAX_EVIDENCE_TITLE_LEN
            );
            return Err(Error::Validation(format!(
                "Evidence title exceeds {} characters",
                MAX_EVIDENCE_TITLE_LEN
            )));
        }

        // Validate description
        if description.is_empty() {
            warn!("Rejecting evidence: description is empty");
            return Err(Error::Validation(
                "Evidence description cannot be empty".to_string(),
            ));
        }
        if description.len() > MAX_EVIDENCE_DESC_LEN {
            warn!(
                "Rejecting evidence: description length {} exceeds maximum {}",
                description.len(),
                MAX_EVIDENCE_DESC_LEN
            );
            return Err(Error::Validation(format!(
                "Evidence description exceeds {} bytes",
                MAX_EVIDENCE_DESC_LEN
            )));
        }

        // Route to arbitrator
        let arbitrator = self.arbitrator.as_ref().ok_or_else(|| {
            Error::Network("No arbitrator configured to handle evidence".to_string())
        })?;

        // Create evidence and submit
        let evidence = Evidence::new(&submitter_did, EvidenceType::Text, &title, &description);
        arbitrator.submit_evidence(&dispute_id, evidence)?;

        info!(
            "Submitted evidence for dispute {}: title='{}' from {}",
            dispute_id, title, submitter_did
        );
        Ok(())
    }

    /// Process a DisputeStatus query.
    fn process_dispute_status(&self, dispute_id: String, timestamp: u64) -> Result<()> {
        // Validate timestamp
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
            .as_secs();
        let grace_period = 300;
        if timestamp > now + grace_period {
            warn!(
                "Rejecting status query: timestamp {} is in the future",
                timestamp
            );
            return Err(Error::Validation(format!(
                "Timestamp {} is in the future",
                timestamp
            )));
        }

        // Route to arbitrator
        let arbitrator = self.arbitrator.as_ref().ok_or_else(|| {
            Error::Network("No arbitrator configured to query disputes".to_string())
        })?;

        // Get dispute status (just log for now, full response would need networking)
        let dispute = arbitrator.get_dispute(&dispute_id)?;
        info!(
            "Dispute {} state: {:?}, amount={}, evidence={}",
            dispute_id,
            dispute.state,
            dispute.amount_usdc,
            dispute.total_evidence_count()
        );
        Ok(())
    }

    /// Get the handler statistics.
    pub async fn stats(&self) -> MessageHandlerStats {
        // Clone the stats to return
        let stats = self.stats.read().await;
        MessageHandlerStats {
            messages_received: stats.messages_received,
            messages_processed: stats.messages_processed,
            parse_errors: stats.parse_errors,
            discovery_messages: stats.discovery_messages,
            trust_messages: stats.trust_messages,
            dispute_messages: stats.dispute_messages,
            unknown_topic_messages: stats.unknown_topic_messages,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{AgentMeExtension, Capability, PricingInfo, PricingModel, ProviderInfo};
    use libp2p::gossipsub::MessageId;
    use libp2p::PeerId;

    fn sample_card(did: &str) -> CapabilityCard {
        CapabilityCard {
            name: "Test Agent".to_string(),
            description: "A test agent".to_string(),
            url: "https://test.example.com".to_string(),
            provider: Some(ProviderInfo {
                organization: "Test Org".to_string(),
                url: None,
            }),
            capabilities: vec![Capability {
                id: "test".to_string(),
                name: "Test Capability".to_string(),
                description: Some("A test capability".to_string()),
                input_schema: None,
                output_schema: None,
            }],
            authentication: None,
            agentme: Some(AgentMeExtension {
                did: did.to_string(),
                trust_score: Some(0.8),
                stake: Some(1_000_000_000),
                pricing: Some(PricingInfo {
                    base_price: 100_000,
                    currency: "USDC".to_string(),
                    model: PricingModel::PerRequest,
                }),
                payment_methods: vec!["x402".to_string()],
            }),
        }
    }

    fn discovery_service() -> Arc<DiscoveryService> {
        Arc::new(DiscoveryService::new())
    }

    // ========== TDD Tests: MessageHandler creation ==========

    #[test]
    fn test_message_handler_creates_successfully() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);
        // Should not panic
        assert!(handler.discovery_service.cache_size() == 0);
    }

    // ========== TDD Tests: Discovery message handling ==========

    #[tokio::test]
    async fn test_handle_card_announcement_caches_card() {
        let service = discovery_service();
        let handler = MessageHandler::new(service.clone());

        let card = sample_card("did:agentme:base:test-agent");
        let message = DiscoveryMessage::CardAnnouncement {
            card: Box::new(card.clone()),
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISCOVERY.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle card announcement");
        assert_eq!(
            service.cache_size(),
            1,
            "Card should be cached in discovery service"
        );

        let cached = service.get("did:agentme:base:test-agent").await.unwrap();
        assert!(cached.is_some(), "Should retrieve cached card");
        assert_eq!(cached.unwrap().name, "Test Agent");
    }

    #[tokio::test]
    async fn test_handle_raw_capability_card_backward_compatible() {
        let service = discovery_service();
        let handler = MessageHandler::new(service.clone());

        // Send raw card without DiscoveryMessage wrapper
        let card = sample_card("did:agentme:base:raw-card");
        let data = serde_json::to_vec(&card).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISCOVERY.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(
            result.is_ok(),
            "Should handle raw card for backward compatibility"
        );
        assert_eq!(service.cache_size(), 1);
    }

    #[tokio::test]
    async fn test_handle_discovery_request() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let message = DiscoveryMessage::DiscoveryRequest {
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISCOVERY.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle discovery request");
    }

    #[tokio::test]
    async fn test_invalid_discovery_message_returns_error() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let data = b"invalid json data";

        let event = NetworkEvent::Message {
            topic: topics::DISCOVERY.to_string(),
            source: Some(PeerId::random()),
            data: data.to_vec(),
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_err(), "Should return error for invalid message");
        let stats = handler.stats().await;
        assert_eq!(stats.parse_errors, 1);
    }

    // ========== TDD Tests: Trust message handling ==========

    #[tokio::test]
    async fn test_handle_trust_update() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:trust-test".to_string(),
            trust_score: 0.85,
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle trust update");
        let stats = handler.stats().await;
        assert_eq!(stats.trust_messages, 1);
        assert_eq!(stats.messages_processed, 1);
    }

    #[tokio::test]
    async fn test_handle_reputation_event() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:rep-test".to_string(),
            success: true,
            amount: 1_000_000, // 1 USDC
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle reputation event");
        let stats = handler.stats().await;
        assert_eq!(stats.trust_messages, 1);
    }

    // ========== TDD Tests: Unknown topic handling ==========

    #[tokio::test]
    async fn test_handle_unknown_topic() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let event = NetworkEvent::Message {
            topic: "/unknown/topic/1.0.0".to_string(),
            source: Some(PeerId::random()),
            data: vec![1, 2, 3],
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        // Should not error for unknown topics, just log and continue
        assert!(result.is_ok(), "Should handle unknown topic gracefully");
        let stats = handler.stats().await;
        assert_eq!(stats.unknown_topic_messages, 1);
    }

    // ========== TDD Tests: Non-message events ==========

    #[tokio::test]
    async fn test_handle_non_message_event_is_noop() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let event = NetworkEvent::PeerConnected(PeerId::random());

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle non-message event");
        let stats = handler.stats().await;
        assert_eq!(stats.messages_received, 0, "Should not count non-messages");
    }

    // ========== TDD Tests: Statistics ==========

    #[tokio::test]
    async fn test_stats_track_message_counts() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Send multiple messages
        for i in 0..3 {
            let card = sample_card(&format!("did:agentme:base:agent-{}", i));
            let message = DiscoveryMessage::CardAnnouncement {
                card: Box::new(card),
            };
            let data = serde_json::to_vec(&message).unwrap();

            let event = NetworkEvent::Message {
                topic: topics::DISCOVERY.to_string(),
                source: Some(PeerId::random()),
                data,
                message_id: MessageId::new(format!("msg-{}", i).as_bytes()),
            };

            handler.handle_event(&event).await.unwrap();
        }

        let stats = handler.stats().await;
        assert_eq!(stats.messages_received, 3);
        assert_eq!(stats.discovery_messages, 3);
        assert_eq!(stats.messages_processed, 3);
        assert_eq!(stats.parse_errors, 0);
    }

    // ========== TDD Tests: Capability topic ==========

    #[tokio::test]
    async fn test_handle_capability_update() {
        let service = discovery_service();
        let handler = MessageHandler::new(service.clone());

        let card = sample_card("did:agentme:base:cap-update");
        let data = serde_json::to_vec(&card).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::CAPABILITY.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"cap-msg"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should handle capability update");
        assert_eq!(service.cache_size(), 1);
    }

    // ========== TDD Tests: Disputes topic ==========

    #[tokio::test]
    async fn test_handle_dispute_message_without_arbitrator() {
        // Without arbitrator, dispute messages should be rejected
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-test".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 50_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"dispute-msg"),
        };

        let result = handler.handle_event(&event).await;

        // Without arbitrator configured, should return error
        assert!(result.is_err(), "Should reject dispute when no arbitrator");
    }

    // ========== TDD Tests: Trust Validation (Task #60) ==========
    // These tests verify that trust updates are validated against on-chain data

    #[tokio::test]
    async fn test_trust_update_validates_score_in_range() {
        // Trust scores must be in range [0.0, 1.0]
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Invalid trust score (> 1.0 should be rejected)
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:invalid-score".to_string(),
            trust_score: 1.5, // Invalid: above 1.0
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        // Should reject invalid trust score
        assert!(result.is_err(), "Should reject trust score > 1.0");
    }

    #[tokio::test]
    async fn test_trust_update_validates_score_negative() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Negative trust score should be rejected
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:negative-score".to_string(),
            trust_score: -0.5, // Invalid: negative
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_err(), "Should reject negative trust score");
    }

    #[tokio::test]
    async fn test_trust_update_validates_did_format() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Invalid DID format
        let message = TrustMessage::TrustUpdate {
            did: "invalid-did-format".to_string(), // Missing did: prefix
            trust_score: 0.85,
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_err(), "Should reject invalid DID format");
    }

    #[tokio::test]
    async fn test_trust_update_validates_timestamp_not_future() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Timestamp far in the future (year 2100) should be rejected
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:future-ts".to_string(),
            trust_score: 0.85,
            timestamp: 4102444800, // Year 2100
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_err(), "Should reject future timestamp");
    }

    #[tokio::test]
    async fn test_trust_update_valid_data_accepted() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        // Valid trust update should be accepted
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:valid-agent".to_string(),
            trust_score: 0.85,
            timestamp: now - 60, // 1 minute ago
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(result.is_ok(), "Should accept valid trust update");
    }

    // ========== TDD Tests: Reputation Recording (Task #61) ==========

    #[tokio::test]
    async fn test_reputation_event_validates_did_format() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let message = TrustMessage::ReputationEvent {
            did: "not-a-valid-did".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: 1704067200,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(
            result.is_err(),
            "Should reject invalid DID in reputation event"
        );
    }

    #[tokio::test]
    async fn test_reputation_event_validates_timestamp() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:test".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: 4102444800, // Year 2100 - future
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(
            result.is_err(),
            "Should reject future timestamp in reputation event"
        );
    }

    #[tokio::test]
    async fn test_reputation_event_valid_success_accepted() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:test-agent".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(
            result.is_ok(),
            "Should accept valid success reputation event"
        );
    }

    #[tokio::test]
    async fn test_reputation_event_valid_failure_accepted() {
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:test-agent".to_string(),
            success: false,
            amount: 500_000,
            timestamp: now - 120,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;

        assert!(
            result.is_ok(),
            "Should accept valid failure reputation event"
        );
    }

    // ========== TDD Tests: Serialization ==========

    #[test]
    fn test_discovery_message_serialization_card_announcement() {
        let card = sample_card("did:agentme:base:test");
        let message = DiscoveryMessage::CardAnnouncement {
            card: Box::new(card),
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("card_announcement"));
        assert!(json.contains("did:agentme:base:test"));

        // Deserialize back
        let parsed: DiscoveryMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            DiscoveryMessage::CardAnnouncement { card } => {
                assert_eq!(card.agentme.unwrap().did, "did:agentme:base:test");
            }
            _ => panic!("Expected CardAnnouncement"),
        }
    }

    #[test]
    fn test_discovery_message_serialization_discovery_request() {
        let message = DiscoveryMessage::DiscoveryRequest {
            timestamp: 1704067200,
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("discovery_request"));
        assert!(json.contains("1704067200"));

        let parsed: DiscoveryMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            DiscoveryMessage::DiscoveryRequest { timestamp } => {
                assert_eq!(timestamp, 1704067200);
            }
            _ => panic!("Expected DiscoveryRequest"),
        }
    }

    #[test]
    fn test_trust_message_serialization_trust_update() {
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:test".to_string(),
            trust_score: 0.85,
            timestamp: 1704067200,
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("trust_update"));
        assert!(json.contains("0.85"));

        let parsed: TrustMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            TrustMessage::TrustUpdate {
                did, trust_score, ..
            } => {
                assert_eq!(did, "did:agentme:base:test");
                assert!((trust_score - 0.85).abs() < 0.001);
            }
            _ => panic!("Expected TrustUpdate"),
        }
    }

    #[test]
    fn test_trust_message_serialization_reputation_event() {
        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:test".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: 1704067200,
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("reputation_event"));
        assert!(json.contains("1000000"));

        let parsed: TrustMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            TrustMessage::ReputationEvent {
                success, amount, ..
            } => {
                assert!(success);
                assert_eq!(amount, 1_000_000);
            }
            _ => panic!("Expected ReputationEvent"),
        }
    }

    // ========== TDD Tests: TrustService Integration (Task #61) ==========
    // These tests verify that reputation events are recorded in TrustService

    fn test_trust_service() -> Arc<crate::trust::TrustService> {
        Arc::new(crate::trust::TrustService::new(
            "https://sepolia.base.org".to_string(),
            Some("0x1234567890abcdef".to_string()),
        ))
    }

    #[tokio::test]
    async fn test_reputation_event_records_success_in_trust_service() {
        let discovery = discovery_service();
        let trust = test_trust_service();
        let handler = MessageHandler::with_trust_service(discovery, Some(trust.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:recording-test".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        handler.handle_event(&event).await.unwrap();

        // Verify the success was recorded in TrustService
        let trust_info = trust
            .get_trust("did:agentme:base:recording-test")
            .await
            .unwrap();
        assert_eq!(
            trust_info.successful_transactions, 1,
            "Should have recorded 1 successful transaction"
        );
    }

    #[tokio::test]
    async fn test_reputation_event_records_failure_in_trust_service() {
        let discovery = discovery_service();
        let trust = test_trust_service();
        let handler = MessageHandler::with_trust_service(discovery, Some(trust.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:failure-test".to_string(),
            success: false,
            amount: 500_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        handler.handle_event(&event).await.unwrap();

        // Verify the failure was recorded in TrustService
        let trust_info = trust
            .get_trust("did:agentme:base:failure-test")
            .await
            .unwrap();
        assert_eq!(
            trust_info.failed_transactions, 1,
            "Should have recorded 1 failed transaction"
        );
    }

    #[tokio::test]
    async fn test_handler_without_trust_service_still_validates() {
        // Handler without TrustService should still validate but not record
        let service = discovery_service();
        let handler = MessageHandler::new(service);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::ReputationEvent {
            did: "did:agentme:base:no-trust".to_string(),
            success: true,
            amount: 1_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        // Should still succeed (just won't record)
        let result = handler.handle_event(&event).await;
        assert!(
            result.is_ok(),
            "Should handle event even without TrustService"
        );
    }

    // ========== TDD Tests: Dispute Routing (Task #62) ==========
    // These tests verify that disputes are routed to the arbitration module

    fn test_arbitrator() -> Arc<AIArbitrator> {
        use crate::AIArbitrationConfig;
        Arc::new(AIArbitrator::new(AIArbitrationConfig::default()).unwrap())
    }

    #[tokio::test]
    async fn test_create_dispute_message_creates_dispute_in_arbitrator() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-123".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 50_000_000, // $50 USDC - Tier 2
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"dispute-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_ok(), "Should handle create dispute message");

        // Verify dispute was created in arbitrator by checking party disputes
        let disputes = arbitrator
            .get_disputes_by_party("did:agentme:base:client")
            .unwrap();
        assert_eq!(disputes.len(), 1, "Should have created 1 dispute");
        assert_eq!(disputes[0].escrow_id, "escrow-123");
    }

    #[tokio::test]
    async fn test_create_dispute_validates_amount_tier() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Tier 1 disputes (< $10) should be rejected by AI arbitrator
        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-tier1".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 5_000_000, // $5 USDC - Tier 1
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"tier1-msg"),
        };

        let result = handler.handle_event(&event).await;
        // Tier 1 disputes are rejected by AIArbitrator
        assert!(result.is_err(), "Should reject Tier 1 disputes");
    }

    #[tokio::test]
    async fn test_submit_evidence_adds_to_dispute() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        // First create a dispute
        let dispute_id = arbitrator
            .create_dispute(
                "escrow-evidence-test",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Submit evidence via message
        let message = DisputeMessage::SubmitEvidence {
            dispute_id: dispute_id.clone(),
            submitter_did: "did:agentme:base:client".to_string(),
            title: "Transaction Log".to_string(),
            description: "The provider failed to deliver the service as agreed.".to_string(),
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"evidence-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_ok(), "Should handle submit evidence message");

        // Verify evidence was added
        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.total_evidence_count(), 1, "Should have 1 evidence");
    }

    #[tokio::test]
    async fn test_dispute_validates_did_format() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Invalid DID format
        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-invalid".to_string(),
            client_did: "invalid-client-did".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 50_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"invalid-did-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_err(), "Should reject invalid DID format");
    }

    #[tokio::test]
    async fn test_dispute_validates_timestamp() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        // Future timestamp
        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-future".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 50_000_000,
            timestamp: 4102444800, // Year 2100
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"future-ts-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_err(), "Should reject future timestamp");
    }

    #[tokio::test]
    async fn test_dispute_message_serialization() {
        // Test CreateDispute serialization
        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-123".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 100_000_000,
            timestamp: 1704067200,
        };

        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("create_dispute"));
        assert!(json.contains("escrow-123"));

        let parsed: DisputeMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            DisputeMessage::CreateDispute {
                escrow_id,
                amount_usdc,
                ..
            } => {
                assert_eq!(escrow_id, "escrow-123");
                assert_eq!(amount_usdc, 100_000_000);
            }
            _ => panic!("Expected CreateDispute"),
        }
    }

    #[tokio::test]
    async fn test_handler_without_arbitrator_rejects_disputes() {
        let discovery = discovery_service();
        // Handler without arbitrator
        let handler = MessageHandler::new(discovery);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::CreateDispute {
            escrow_id: "escrow-no-arb".to_string(),
            client_did: "did:agentme:base:client".to_string(),
            provider_did: "did:agentme:base:provider".to_string(),
            amount_usdc: 50_000_000,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"no-arb-msg"),
        };

        let result = handler.handle_event(&event).await;
        // Without arbitrator, should fail gracefully
        assert!(
            result.is_err(),
            "Should reject dispute when no arbitrator configured"
        );
    }

    // ========== TDD Tests: On-Chain Trust Validation (Task #64) ==========
    // These tests verify trust updates are validated against existing trust data

    #[tokio::test]
    async fn test_trust_update_validates_against_existing_score() {
        // When TrustService is configured, trust updates should be validated
        // against existing calculated scores. Deviation > 20% should be rejected.
        let discovery = discovery_service();
        let trust = test_trust_service();

        // Set trust data: 100 successful, 0 failed → reputation ≈ 0.5-0.7
        // (100% success rate, volume factor based on 100 txs)
        trust.set_trust_data("did:agentme:base:existing-agent", 0, 100, 0, 0);

        // Get the calculated score first
        let existing = trust
            .get_trust("did:agentme:base:existing-agent")
            .await
            .unwrap();
        let existing_score = existing.score;

        let handler = MessageHandler::with_trust_service(discovery, Some(trust.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Trust update within 20% of existing score should be accepted
        let close_score = existing_score + 0.10; // Add 10% (within 20% tolerance)
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:existing-agent".to_string(),
            trust_score: close_score.min(1.0),
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_ok(),
            "Should accept trust score within 20% deviation (existing={}, sent={})",
            existing_score,
            close_score
        );
    }

    #[tokio::test]
    async fn test_trust_update_rejects_large_deviation_from_existing() {
        // Trust updates with >20% deviation from existing score should be rejected
        let discovery = discovery_service();
        let trust = test_trust_service();

        // Set trust data with history
        trust.set_trust_data("did:agentme:base:deviation-test", 0, 100, 0, 0);

        // Get the calculated score
        let existing = trust
            .get_trust("did:agentme:base:deviation-test")
            .await
            .unwrap();
        let existing_score = existing.score;

        let handler = MessageHandler::with_trust_service(discovery, Some(trust.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Trust update with score far from existing (>20% deviation) should be rejected
        // If existing is 0.5, then 0.1 would be 80% deviation
        let far_score = if existing_score > 0.5 { 0.1 } else { 0.9 };
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:deviation-test".to_string(),
            trust_score: far_score,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_err(),
            "Should reject trust score with large deviation (existing={}, sent={})",
            existing_score,
            far_score
        );
    }

    #[tokio::test]
    async fn test_trust_update_accepts_new_agent_without_history() {
        // New agents without transaction history should have their trust updates accepted
        let discovery = discovery_service();
        let trust = test_trust_service();
        let handler = MessageHandler::with_trust_service(discovery, Some(trust.clone()));

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // New agent with no existing trust data
        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:brand-new-agent".to_string(),
            trust_score: 0.50, // Any starting score
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_ok(),
            "Should accept trust update for new agent without history"
        );
    }

    #[tokio::test]
    async fn test_trust_update_without_trust_service_skips_validation() {
        // Without TrustService, on-chain validation is skipped (basic validation only)
        let discovery = discovery_service();
        let handler = MessageHandler::new(discovery);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = TrustMessage::TrustUpdate {
            did: "did:agentme:base:no-trust-service".to_string(),
            trust_score: 0.75,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::TRUST.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"test-id"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_ok(),
            "Should accept trust update without TrustService (basic validation only)"
        );
    }

    // ========== TDD Tests: Evidence Validation (Task #65) ==========
    // These tests verify evidence submissions are validated for size and content
    // Constants MAX_EVIDENCE_TITLE_LEN and MAX_EVIDENCE_DESC_LEN are defined at module level

    #[tokio::test]
    async fn test_evidence_rejects_title_too_long() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        // Create a dispute first
        let dispute_id = arbitrator
            .create_dispute(
                "escrow-title-test",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Title exceeding 256 characters
        let long_title = "A".repeat(MAX_EVIDENCE_TITLE_LEN + 100);
        let message = DisputeMessage::SubmitEvidence {
            dispute_id,
            submitter_did: "did:agentme:base:client".to_string(),
            title: long_title,
            description: "Valid description".to_string(),
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"long-title-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_err(),
            "Should reject evidence with title > {} chars",
            MAX_EVIDENCE_TITLE_LEN
        );
    }

    #[tokio::test]
    async fn test_evidence_rejects_description_too_long() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        // Create a dispute first
        let dispute_id = arbitrator
            .create_dispute(
                "escrow-desc-test",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Description exceeding 10KB
        let long_desc = "B".repeat(MAX_EVIDENCE_DESC_LEN + 1000);
        let message = DisputeMessage::SubmitEvidence {
            dispute_id,
            submitter_did: "did:agentme:base:client".to_string(),
            title: "Valid Title".to_string(),
            description: long_desc,
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"long-desc-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_err(),
            "Should reject evidence with description > {} bytes",
            MAX_EVIDENCE_DESC_LEN
        );
    }

    #[tokio::test]
    async fn test_evidence_rejects_empty_title() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let dispute_id = arbitrator
            .create_dispute(
                "escrow-empty-title",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::SubmitEvidence {
            dispute_id,
            submitter_did: "did:agentme:base:client".to_string(),
            title: "".to_string(), // Empty title
            description: "Some description".to_string(),
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"empty-title-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_err(), "Should reject evidence with empty title");
    }

    #[tokio::test]
    async fn test_evidence_rejects_empty_description() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let dispute_id = arbitrator
            .create_dispute(
                "escrow-empty-desc",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::SubmitEvidence {
            dispute_id,
            submitter_did: "did:agentme:base:client".to_string(),
            title: "Valid Title".to_string(),
            description: "".to_string(), // Empty description
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"empty-desc-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(
            result.is_err(),
            "Should reject evidence with empty description"
        );
    }

    #[tokio::test]
    async fn test_evidence_accepts_valid_submission() {
        let discovery = discovery_service();
        let arbitrator = test_arbitrator();
        let handler = MessageHandler::with_services(discovery, None, Some(arbitrator.clone()));

        let dispute_id = arbitrator
            .create_dispute(
                "escrow-valid-evidence",
                "did:agentme:base:client",
                "did:agentme:base:provider",
                50_000_000,
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let message = DisputeMessage::SubmitEvidence {
            dispute_id: dispute_id.clone(),
            submitter_did: "did:agentme:base:client".to_string(),
            title: "Transaction Receipt".to_string(),
            description: "This is valid evidence describing the transaction.".to_string(),
            timestamp: now - 60,
        };
        let data = serde_json::to_vec(&message).unwrap();

        let event = NetworkEvent::Message {
            topic: topics::DISPUTES.to_string(),
            source: Some(PeerId::random()),
            data,
            message_id: MessageId::new(b"valid-evidence-msg"),
        };

        let result = handler.handle_event(&event).await;
        assert!(result.is_ok(), "Should accept valid evidence submission");

        // Verify evidence was added
        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert!(
            dispute.total_evidence_count() > 0,
            "Evidence should be recorded"
        );
    }
}
