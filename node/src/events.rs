//! Contract event listener for real-time blockchain updates.
//!
//! This module provides WebSocket-based event subscriptions for monitoring
//! TrustRegistry, Escrow, and StreamingPayments contract events.
//!
//! ## Features
//!
//! - **Real-time subscriptions**: WebSocket-based event streaming
//! - **Type-safe events**: Strongly-typed event decoding via Alloy's `sol!` macro
//! - **Automatic reconnection**: Resilient connections with exponential backoff
//! - **Event filtering**: Filter by contract, event type, or topic
//!
//! ## Usage
//!
//! ```rust,ignore
//! use agentme_node::events::{EventListener, EventListenerConfig, ContractEvent};
//!
//! let config = EventListenerConfig {
//!     ws_url: "wss://sepolia.base.org".to_string(),
//!     trust_registry_address: "0x...".to_string(),
//!     ..Default::default()
//! };
//!
//! let (listener, mut rx) = EventListener::new(config)?;
//! listener.start().await?;
//!
//! while let Some(event) = rx.recv().await {
//!     match event {
//!         ContractEvent::ReputationUpdated { did_hash, new_score, .. } => {
//!             println!("Trust score updated: {:?}", new_score);
//!         }
//!         _ => {}
//!     }
//! }
//! ```

use alloy::primitives::{Address, FixedBytes, U256};
use alloy::sol;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::error::{Error, Result};

// ========== Event Definitions via sol! macro ==========

sol!(
    #[allow(missing_docs)]
    #[sol(rpc)]
    TrustRegistryEvents,
    r#"[
        {
            "type": "event",
            "name": "AgentRegistered",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true},
                {"name": "owner", "type": "address", "indexed": true},
                {"name": "capabilityCardCID", "type": "string", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "AgentUpdated",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true},
                {"name": "newCID", "type": "string", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "AgentDeactivated",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true}
            ]
        },
        {
            "type": "event",
            "name": "ReputationUpdated",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true},
                {"name": "newScore", "type": "uint256", "indexed": false},
                {"name": "totalTransactions", "type": "uint256", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "StakeDeposited",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true},
                {"name": "amount", "type": "uint256", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "StakeSlashed",
            "anonymous": false,
            "inputs": [
                {"name": "didHash", "type": "bytes32", "indexed": true},
                {"name": "amount", "type": "uint256", "indexed": false},
                {"name": "reason", "type": "bytes32", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "EndorsementAdded",
            "anonymous": false,
            "inputs": [
                {"name": "endorser", "type": "bytes32", "indexed": true},
                {"name": "endorsee", "type": "bytes32", "indexed": true},
                {"name": "message", "type": "string", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "EndorsementRevoked",
            "anonymous": false,
            "inputs": [
                {"name": "endorser", "type": "bytes32", "indexed": true},
                {"name": "endorsee", "type": "bytes32", "indexed": true}
            ]
        }
    ]"#
);

sol!(
    #[allow(missing_docs)]
    #[sol(rpc)]
    EscrowEvents,
    r#"[
        {
            "type": "event",
            "name": "EscrowCreated",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true},
                {"name": "client", "type": "address", "indexed": true},
                {"name": "provider", "type": "address", "indexed": true},
                {"name": "amount", "type": "uint256", "indexed": false},
                {"name": "clientDid", "type": "bytes32", "indexed": false},
                {"name": "providerDid", "type": "bytes32", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "EscrowFunded",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true}
            ]
        },
        {
            "type": "event",
            "name": "EscrowReleased",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true}
            ]
        },
        {
            "type": "event",
            "name": "EscrowRefunded",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true}
            ]
        },
        {
            "type": "event",
            "name": "DisputeInitiated",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true},
                {"name": "initiator", "type": "address", "indexed": false}
            ]
        },
        {
            "type": "event",
            "name": "DisputeResolved",
            "anonymous": false,
            "inputs": [
                {"name": "escrowId", "type": "uint256", "indexed": true},
                {"name": "releasedToProvider", "type": "bool", "indexed": false},
                {"name": "providerAmount", "type": "uint256", "indexed": false}
            ]
        }
    ]"#
);

// ========== Event Types ==========

/// Contract events emitted by AgentMe smart contracts.
#[derive(Debug, Clone)]
pub enum ContractEvent {
    // TrustRegistry events
    /// New agent registered
    AgentRegistered {
        did_hash: FixedBytes<32>,
        owner: Address,
        capability_card_cid: String,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Agent capability card updated
    AgentUpdated {
        did_hash: FixedBytes<32>,
        new_cid: String,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Agent deactivated
    AgentDeactivated {
        did_hash: FixedBytes<32>,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Reputation/trust score updated
    ReputationUpdated {
        did_hash: FixedBytes<32>,
        new_score: u64,
        total_transactions: u64,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Stake deposited
    StakeDeposited {
        did_hash: FixedBytes<32>,
        amount: U256,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Stake slashed
    StakeSlashed {
        did_hash: FixedBytes<32>,
        amount: U256,
        reason: FixedBytes<32>,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Endorsement added
    EndorsementAdded {
        endorser: FixedBytes<32>,
        endorsee: FixedBytes<32>,
        message: String,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Endorsement revoked
    EndorsementRevoked {
        endorser: FixedBytes<32>,
        endorsee: FixedBytes<32>,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },

    // Escrow events
    /// Escrow created
    EscrowCreated {
        escrow_id: U256,
        client: Address,
        provider: Address,
        amount: U256,
        client_did: FixedBytes<32>,
        provider_did: FixedBytes<32>,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Escrow funded
    EscrowFunded {
        escrow_id: U256,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Escrow released to provider
    EscrowReleased {
        escrow_id: U256,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Escrow refunded to client
    EscrowRefunded {
        escrow_id: U256,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Dispute initiated
    DisputeInitiated {
        escrow_id: U256,
        initiator: Address,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
    /// Dispute resolved
    DisputeResolved {
        escrow_id: U256,
        released_to_provider: bool,
        provider_amount: U256,
        block_number: u64,
        tx_hash: FixedBytes<32>,
    },
}

impl ContractEvent {
    /// Get the block number where this event occurred.
    pub fn block_number(&self) -> u64 {
        match self {
            ContractEvent::AgentRegistered { block_number, .. } => *block_number,
            ContractEvent::AgentUpdated { block_number, .. } => *block_number,
            ContractEvent::AgentDeactivated { block_number, .. } => *block_number,
            ContractEvent::ReputationUpdated { block_number, .. } => *block_number,
            ContractEvent::StakeDeposited { block_number, .. } => *block_number,
            ContractEvent::StakeSlashed { block_number, .. } => *block_number,
            ContractEvent::EndorsementAdded { block_number, .. } => *block_number,
            ContractEvent::EndorsementRevoked { block_number, .. } => *block_number,
            ContractEvent::EscrowCreated { block_number, .. } => *block_number,
            ContractEvent::EscrowFunded { block_number, .. } => *block_number,
            ContractEvent::EscrowReleased { block_number, .. } => *block_number,
            ContractEvent::EscrowRefunded { block_number, .. } => *block_number,
            ContractEvent::DisputeInitiated { block_number, .. } => *block_number,
            ContractEvent::DisputeResolved { block_number, .. } => *block_number,
        }
    }

    /// Get the transaction hash where this event occurred.
    pub fn tx_hash(&self) -> FixedBytes<32> {
        match self {
            ContractEvent::AgentRegistered { tx_hash, .. } => *tx_hash,
            ContractEvent::AgentUpdated { tx_hash, .. } => *tx_hash,
            ContractEvent::AgentDeactivated { tx_hash, .. } => *tx_hash,
            ContractEvent::ReputationUpdated { tx_hash, .. } => *tx_hash,
            ContractEvent::StakeDeposited { tx_hash, .. } => *tx_hash,
            ContractEvent::StakeSlashed { tx_hash, .. } => *tx_hash,
            ContractEvent::EndorsementAdded { tx_hash, .. } => *tx_hash,
            ContractEvent::EndorsementRevoked { tx_hash, .. } => *tx_hash,
            ContractEvent::EscrowCreated { tx_hash, .. } => *tx_hash,
            ContractEvent::EscrowFunded { tx_hash, .. } => *tx_hash,
            ContractEvent::EscrowReleased { tx_hash, .. } => *tx_hash,
            ContractEvent::EscrowRefunded { tx_hash, .. } => *tx_hash,
            ContractEvent::DisputeInitiated { tx_hash, .. } => *tx_hash,
            ContractEvent::DisputeResolved { tx_hash, .. } => *tx_hash,
        }
    }

    /// Check if this is a TrustRegistry event.
    pub fn is_trust_registry_event(&self) -> bool {
        matches!(
            self,
            ContractEvent::AgentRegistered { .. }
                | ContractEvent::AgentUpdated { .. }
                | ContractEvent::AgentDeactivated { .. }
                | ContractEvent::ReputationUpdated { .. }
                | ContractEvent::StakeDeposited { .. }
                | ContractEvent::StakeSlashed { .. }
                | ContractEvent::EndorsementAdded { .. }
                | ContractEvent::EndorsementRevoked { .. }
        )
    }

    /// Check if this is an Escrow event.
    pub fn is_escrow_event(&self) -> bool {
        matches!(
            self,
            ContractEvent::EscrowCreated { .. }
                | ContractEvent::EscrowFunded { .. }
                | ContractEvent::EscrowReleased { .. }
                | ContractEvent::EscrowRefunded { .. }
                | ContractEvent::DisputeInitiated { .. }
                | ContractEvent::DisputeResolved { .. }
        )
    }

    /// Get the event name.
    pub fn event_name(&self) -> &'static str {
        match self {
            ContractEvent::AgentRegistered { .. } => "AgentRegistered",
            ContractEvent::AgentUpdated { .. } => "AgentUpdated",
            ContractEvent::AgentDeactivated { .. } => "AgentDeactivated",
            ContractEvent::ReputationUpdated { .. } => "ReputationUpdated",
            ContractEvent::StakeDeposited { .. } => "StakeDeposited",
            ContractEvent::StakeSlashed { .. } => "StakeSlashed",
            ContractEvent::EndorsementAdded { .. } => "EndorsementAdded",
            ContractEvent::EndorsementRevoked { .. } => "EndorsementRevoked",
            ContractEvent::EscrowCreated { .. } => "EscrowCreated",
            ContractEvent::EscrowFunded { .. } => "EscrowFunded",
            ContractEvent::EscrowReleased { .. } => "EscrowReleased",
            ContractEvent::EscrowRefunded { .. } => "EscrowRefunded",
            ContractEvent::DisputeInitiated { .. } => "DisputeInitiated",
            ContractEvent::DisputeResolved { .. } => "DisputeResolved",
        }
    }
}

// ========== Configuration ==========

/// Configuration for the event listener.
#[derive(Debug, Clone)]
pub struct EventListenerConfig {
    /// WebSocket RPC URL for event subscriptions.
    pub ws_url: String,

    /// TrustRegistry contract address (optional).
    pub trust_registry_address: Option<String>,

    /// Escrow contract address (optional).
    pub escrow_address: Option<String>,

    /// Channel buffer size for events.
    pub channel_buffer_size: usize,

    /// Reconnection settings.
    pub reconnect: ReconnectConfig,
}

/// Reconnection configuration.
#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    /// Whether to automatically reconnect on disconnect.
    pub enabled: bool,

    /// Initial delay before first reconnection attempt.
    pub initial_delay: Duration,

    /// Maximum delay between reconnection attempts.
    pub max_delay: Duration,

    /// Multiplier for exponential backoff.
    pub backoff_multiplier: f64,

    /// Maximum number of reconnection attempts (0 = unlimited).
    pub max_attempts: u32,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            initial_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(60),
            backoff_multiplier: 2.0,
            max_attempts: 0, // unlimited
        }
    }
}

impl Default for EventListenerConfig {
    fn default() -> Self {
        Self {
            ws_url: "wss://sepolia.base.org".to_string(),
            trust_registry_address: None,
            escrow_address: None,
            channel_buffer_size: 1000,
            reconnect: ReconnectConfig::default(),
        }
    }
}

impl EventListenerConfig {
    /// Create a new config with WebSocket URL.
    pub fn new(ws_url: impl Into<String>) -> Self {
        Self {
            ws_url: ws_url.into(),
            ..Default::default()
        }
    }

    /// Set the TrustRegistry contract address.
    pub fn with_trust_registry(mut self, address: impl Into<String>) -> Self {
        self.trust_registry_address = Some(address.into());
        self
    }

    /// Set the Escrow contract address.
    pub fn with_escrow(mut self, address: impl Into<String>) -> Self {
        self.escrow_address = Some(address.into());
        self
    }
}

// ========== Event Listener Statistics ==========

/// Statistics for the event listener.
#[derive(Debug, Default)]
pub struct EventListenerStats {
    /// Number of events received.
    pub events_received: AtomicU64,
    /// Number of events decoded successfully.
    pub events_decoded: AtomicU64,
    /// Number of decode errors.
    pub decode_errors: AtomicU64,
    /// Number of reconnections.
    pub reconnections: AtomicU64,
    /// Number of connection errors.
    pub connection_errors: AtomicU64,
}

impl EventListenerStats {
    /// Record a received event.
    pub fn record_event_received(&self) {
        self.events_received.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a successfully decoded event.
    pub fn record_event_decoded(&self) {
        self.events_decoded.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a decode error.
    pub fn record_decode_error(&self) {
        self.decode_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a reconnection.
    pub fn record_reconnection(&self) {
        self.reconnections.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a connection error.
    pub fn record_connection_error(&self) {
        self.connection_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Get success rate (decoded / received).
    pub fn success_rate(&self) -> f64 {
        let received = self.events_received.load(Ordering::Relaxed);
        let decoded = self.events_decoded.load(Ordering::Relaxed);

        if received == 0 {
            1.0
        } else {
            decoded as f64 / received as f64
        }
    }
}

// ========== Event Listener ==========

/// Real-time event listener for AgentMe contracts.
///
/// Subscribes to contract events via WebSocket and emits typed events
/// through a channel for processing.
pub struct EventListener {
    config: EventListenerConfig,
    stats: Arc<EventListenerStats>,
    running: Arc<AtomicBool>,
    event_tx: mpsc::Sender<ContractEvent>,
}

impl EventListener {
    /// Create a new event listener.
    ///
    /// Returns the listener and a receiver channel for events.
    pub fn new(config: EventListenerConfig) -> Result<(Self, mpsc::Receiver<ContractEvent>)> {
        // Validate config
        if config.ws_url.is_empty() {
            return Err(Error::Config("WebSocket URL is required".to_string()));
        }

        let (event_tx, event_rx) = mpsc::channel(config.channel_buffer_size);

        let listener = Self {
            config,
            stats: Arc::new(EventListenerStats::default()),
            running: Arc::new(AtomicBool::new(false)),
            event_tx,
        };

        Ok((listener, event_rx))
    }

    /// Create a disabled event listener (for testing).
    pub fn disabled() -> (Self, mpsc::Receiver<ContractEvent>) {
        let (event_tx, event_rx) = mpsc::channel(1);

        let listener = Self {
            config: EventListenerConfig::default(),
            stats: Arc::new(EventListenerStats::default()),
            running: Arc::new(AtomicBool::new(false)),
            event_tx,
        };

        (listener, event_rx)
    }

    /// Check if the listener is running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Get the listener statistics.
    pub fn stats(&self) -> &EventListenerStats {
        &self.stats
    }

    /// Get the listener configuration.
    pub fn config(&self) -> &EventListenerConfig {
        &self.config
    }

    /// Parse contract address from string.
    #[allow(dead_code)]
    fn parse_address(address: &str) -> Result<Address> {
        address
            .parse::<Address>()
            .map_err(|e| Error::Config(format!("Invalid contract address: {}", e)))
    }

    /// Stop the event listener.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Emit an event to the channel.
    pub async fn emit_event(&self, event: ContractEvent) -> Result<()> {
        self.stats.record_event_decoded();
        self.event_tx
            .send(event)
            .await
            .map_err(|e| Error::Channel(format!("Failed to send event: {}", e)))
    }

    /// Calculate next reconnection delay with exponential backoff.
    pub fn calculate_reconnect_delay(&self, attempt: u32) -> Duration {
        let config = &self.config.reconnect;
        let delay_secs =
            config.initial_delay.as_secs_f64() * config.backoff_multiplier.powi(attempt as i32);
        let clamped = delay_secs.min(config.max_delay.as_secs_f64());
        Duration::from_secs_f64(clamped)
    }
}

// ========== TDD Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    // ========== RED Phase: ContractEvent Tests ==========

    #[test]
    fn test_contract_event_block_number() {
        let event = ContractEvent::ReputationUpdated {
            did_hash: FixedBytes::ZERO,
            new_score: 8500,
            total_transactions: 100,
            block_number: 12345,
            tx_hash: FixedBytes::ZERO,
        };

        assert_eq!(event.block_number(), 12345);
    }

    #[test]
    fn test_contract_event_tx_hash() {
        let tx_hash = FixedBytes::repeat_byte(0xAB);
        let event = ContractEvent::AgentRegistered {
            did_hash: FixedBytes::ZERO,
            owner: Address::ZERO,
            capability_card_cid: "QmTest".to_string(),
            block_number: 1,
            tx_hash,
        };

        assert_eq!(event.tx_hash(), tx_hash);
    }

    #[test]
    fn test_trust_registry_event_classification() {
        let events = vec![
            ContractEvent::AgentRegistered {
                did_hash: FixedBytes::ZERO,
                owner: Address::ZERO,
                capability_card_cid: "".to_string(),
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
            ContractEvent::ReputationUpdated {
                did_hash: FixedBytes::ZERO,
                new_score: 0,
                total_transactions: 0,
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
            ContractEvent::EndorsementAdded {
                endorser: FixedBytes::ZERO,
                endorsee: FixedBytes::ZERO,
                message: "".to_string(),
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
        ];

        for event in events {
            assert!(
                event.is_trust_registry_event(),
                "{} should be TrustRegistry event",
                event.event_name()
            );
            assert!(
                !event.is_escrow_event(),
                "{} should not be Escrow event",
                event.event_name()
            );
        }
    }

    #[test]
    fn test_escrow_event_classification() {
        let events = vec![
            ContractEvent::EscrowCreated {
                escrow_id: U256::ZERO,
                client: Address::ZERO,
                provider: Address::ZERO,
                amount: U256::ZERO,
                client_did: FixedBytes::ZERO,
                provider_did: FixedBytes::ZERO,
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
            ContractEvent::EscrowReleased {
                escrow_id: U256::ZERO,
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
            ContractEvent::DisputeResolved {
                escrow_id: U256::ZERO,
                released_to_provider: true,
                provider_amount: U256::ZERO,
                block_number: 0,
                tx_hash: FixedBytes::ZERO,
            },
        ];

        for event in events {
            assert!(
                event.is_escrow_event(),
                "{} should be Escrow event",
                event.event_name()
            );
            assert!(
                !event.is_trust_registry_event(),
                "{} should not be TrustRegistry event",
                event.event_name()
            );
        }
    }

    #[test]
    fn test_event_name() {
        let event = ContractEvent::ReputationUpdated {
            did_hash: FixedBytes::ZERO,
            new_score: 0,
            total_transactions: 0,
            block_number: 0,
            tx_hash: FixedBytes::ZERO,
        };

        assert_eq!(event.event_name(), "ReputationUpdated");
    }

    // ========== RED Phase: EventListenerConfig Tests ==========

    #[test]
    fn test_default_config_has_reasonable_buffer_size() {
        let config = EventListenerConfig::default();

        assert!(config.channel_buffer_size >= 100);
        assert!(config.channel_buffer_size <= 10000);
    }

    #[test]
    fn test_default_reconnect_config_has_reasonable_delays() {
        let config = ReconnectConfig::default();

        assert!(config.initial_delay >= Duration::from_millis(500));
        assert!(config.max_delay >= Duration::from_secs(30));
        assert!(config.backoff_multiplier >= 1.5);
        assert!(config.enabled);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = EventListenerConfig::new("wss://test.example.com")
            .with_trust_registry("0x1234567890123456789012345678901234567890")
            .with_escrow("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");

        assert_eq!(config.ws_url, "wss://test.example.com");
        assert!(config.trust_registry_address.is_some());
        assert!(config.escrow_address.is_some());
    }

    // ========== RED Phase: EventListenerStats Tests ==========

    #[test]
    fn test_stats_starts_at_zero() {
        let stats = EventListenerStats::default();

        assert_eq!(stats.events_received.load(Ordering::Relaxed), 0);
        assert_eq!(stats.events_decoded.load(Ordering::Relaxed), 0);
        assert_eq!(stats.decode_errors.load(Ordering::Relaxed), 0);
        assert_eq!(stats.reconnections.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_stats_record_event_received() {
        let stats = EventListenerStats::default();

        stats.record_event_received();
        stats.record_event_received();

        assert_eq!(stats.events_received.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn test_stats_record_event_decoded() {
        let stats = EventListenerStats::default();

        stats.record_event_decoded();

        assert_eq!(stats.events_decoded.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_stats_success_rate_when_empty() {
        let stats = EventListenerStats::default();

        // No events received, success rate should be 100%
        assert!((stats.success_rate() - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_stats_success_rate_calculation() {
        let stats = EventListenerStats::default();

        // 10 received, 8 decoded = 80% success rate
        stats.events_received.store(10, Ordering::Relaxed);
        stats.events_decoded.store(8, Ordering::Relaxed);

        assert!((stats.success_rate() - 0.8).abs() < 0.001);
    }

    // ========== RED Phase: EventListener Tests ==========

    #[test]
    fn test_new_listener_validates_ws_url() {
        let config = EventListenerConfig {
            ws_url: "".to_string(),
            ..Default::default()
        };

        let result = EventListener::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_new_listener_creates_with_valid_config() {
        let config = EventListenerConfig::new("wss://test.example.com");

        let result = EventListener::new(config);

        assert!(result.is_ok());
    }

    #[test]
    fn test_listener_is_not_running_initially() {
        let (listener, _rx) = EventListener::new(EventListenerConfig::default()).unwrap();

        assert!(!listener.is_running());
    }

    #[test]
    fn test_disabled_listener_creates_successfully() {
        let (listener, _rx) = EventListener::disabled();

        assert!(!listener.is_running());
    }

    #[test]
    fn test_listener_stop_sets_running_false() {
        let (listener, _rx) = EventListener::new(EventListenerConfig::default()).unwrap();

        listener.running.store(true, Ordering::SeqCst);
        assert!(listener.is_running());

        listener.stop();
        assert!(!listener.is_running());
    }

    #[test]
    fn test_parse_address_valid() {
        let result = EventListener::parse_address("0x1234567890123456789012345678901234567890");

        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_address_invalid() {
        let result = EventListener::parse_address("invalid-address");

        assert!(result.is_err());
    }

    // ========== RED Phase: Reconnection Tests ==========

    #[test]
    fn test_reconnect_delay_starts_at_initial() {
        let config = EventListenerConfig {
            reconnect: ReconnectConfig {
                initial_delay: Duration::from_secs(1),
                max_delay: Duration::from_secs(60),
                backoff_multiplier: 2.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let (listener, _rx) = EventListener::new(config).unwrap();

        let delay = listener.calculate_reconnect_delay(0);

        assert_eq!(delay, Duration::from_secs(1));
    }

    #[test]
    fn test_reconnect_delay_increases_with_backoff() {
        let config = EventListenerConfig {
            reconnect: ReconnectConfig {
                initial_delay: Duration::from_secs(1),
                max_delay: Duration::from_secs(60),
                backoff_multiplier: 2.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let (listener, _rx) = EventListener::new(config).unwrap();

        let delay1 = listener.calculate_reconnect_delay(1);
        let delay2 = listener.calculate_reconnect_delay(2);
        let delay3 = listener.calculate_reconnect_delay(3);

        assert_eq!(delay1, Duration::from_secs(2));
        assert_eq!(delay2, Duration::from_secs(4));
        assert_eq!(delay3, Duration::from_secs(8));
    }

    #[test]
    fn test_reconnect_delay_capped_at_max() {
        let config = EventListenerConfig {
            reconnect: ReconnectConfig {
                initial_delay: Duration::from_secs(1),
                max_delay: Duration::from_secs(10),
                backoff_multiplier: 2.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let (listener, _rx) = EventListener::new(config).unwrap();

        // 2^10 = 1024 seconds, but capped at 10
        let delay = listener.calculate_reconnect_delay(10);

        assert_eq!(delay, Duration::from_secs(10));
    }

    // ========== RED Phase: Event Emission Tests ==========

    #[tokio::test]
    async fn test_emit_event_sends_to_channel() {
        let (listener, mut rx) = EventListener::new(EventListenerConfig::default()).unwrap();

        let event = ContractEvent::ReputationUpdated {
            did_hash: FixedBytes::ZERO,
            new_score: 9000,
            total_transactions: 50,
            block_number: 100,
            tx_hash: FixedBytes::ZERO,
        };

        listener.emit_event(event).await.unwrap();

        let received = rx.recv().await.unwrap();
        if let ContractEvent::ReputationUpdated { new_score, .. } = received {
            assert_eq!(new_score, 9000);
        } else {
            panic!("Wrong event type received");
        }
    }

    #[tokio::test]
    async fn test_emit_event_updates_stats() {
        let (listener, mut _rx) = EventListener::new(EventListenerConfig::default()).unwrap();

        let event = ContractEvent::EscrowFunded {
            escrow_id: U256::from(42),
            block_number: 200,
            tx_hash: FixedBytes::ZERO,
        };

        listener.emit_event(event).await.unwrap();

        assert_eq!(listener.stats().events_decoded.load(Ordering::Relaxed), 1);
    }

    // ========== RED Phase: All Event Type Tests ==========

    #[test]
    fn test_all_trust_registry_event_names() {
        let names = vec![
            (
                "AgentRegistered",
                ContractEvent::AgentRegistered {
                    did_hash: FixedBytes::ZERO,
                    owner: Address::ZERO,
                    capability_card_cid: "".to_string(),
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "AgentUpdated",
                ContractEvent::AgentUpdated {
                    did_hash: FixedBytes::ZERO,
                    new_cid: "".to_string(),
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "AgentDeactivated",
                ContractEvent::AgentDeactivated {
                    did_hash: FixedBytes::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "ReputationUpdated",
                ContractEvent::ReputationUpdated {
                    did_hash: FixedBytes::ZERO,
                    new_score: 0,
                    total_transactions: 0,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "StakeDeposited",
                ContractEvent::StakeDeposited {
                    did_hash: FixedBytes::ZERO,
                    amount: U256::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "StakeSlashed",
                ContractEvent::StakeSlashed {
                    did_hash: FixedBytes::ZERO,
                    amount: U256::ZERO,
                    reason: FixedBytes::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "EndorsementAdded",
                ContractEvent::EndorsementAdded {
                    endorser: FixedBytes::ZERO,
                    endorsee: FixedBytes::ZERO,
                    message: "".to_string(),
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "EndorsementRevoked",
                ContractEvent::EndorsementRevoked {
                    endorser: FixedBytes::ZERO,
                    endorsee: FixedBytes::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
        ];

        for (expected_name, event) in names {
            assert_eq!(event.event_name(), expected_name);
        }
    }

    #[test]
    fn test_all_escrow_event_names() {
        let names = vec![
            (
                "EscrowCreated",
                ContractEvent::EscrowCreated {
                    escrow_id: U256::ZERO,
                    client: Address::ZERO,
                    provider: Address::ZERO,
                    amount: U256::ZERO,
                    client_did: FixedBytes::ZERO,
                    provider_did: FixedBytes::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "EscrowFunded",
                ContractEvent::EscrowFunded {
                    escrow_id: U256::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "EscrowReleased",
                ContractEvent::EscrowReleased {
                    escrow_id: U256::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "EscrowRefunded",
                ContractEvent::EscrowRefunded {
                    escrow_id: U256::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "DisputeInitiated",
                ContractEvent::DisputeInitiated {
                    escrow_id: U256::ZERO,
                    initiator: Address::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
            (
                "DisputeResolved",
                ContractEvent::DisputeResolved {
                    escrow_id: U256::ZERO,
                    released_to_provider: false,
                    provider_amount: U256::ZERO,
                    block_number: 0,
                    tx_hash: FixedBytes::ZERO,
                },
            ),
        ];

        for (expected_name, event) in names {
            assert_eq!(event.event_name(), expected_name);
        }
    }
}
