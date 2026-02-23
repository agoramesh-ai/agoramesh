//! Agent discovery service.
//!
//! This module handles:
//! - Capability Card registration and lookup
//! - Semantic search for agent discovery
//! - DHT-based decentralized registry

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::network::SwarmCommand;
use crate::search::HybridSearch;

/// A2A-compatible Capability Card for agent discovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityCard {
    /// Agent name.
    pub name: String,

    /// Agent description.
    pub description: String,

    /// Agent URL (A2A endpoint).
    pub url: String,

    /// Provider information.
    pub provider: Option<ProviderInfo>,

    /// Agent capabilities/skills.
    pub capabilities: Vec<Capability>,

    /// Supported authentication methods.
    pub authentication: Option<AuthenticationInfo>,

    /// AgoraMesh-specific extensions.
    #[serde(rename = "x-agoramesh")]
    pub agoramesh: Option<AgoraMeshExtension>,
}

/// Provider information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    /// Provider organization name.
    pub organization: String,

    /// Provider URL.
    pub url: Option<String>,
}

/// Agent capability/skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    /// Capability ID.
    pub id: String,

    /// Capability name.
    pub name: String,

    /// Capability description.
    pub description: Option<String>,

    /// Input schema (JSON Schema).
    #[serde(rename = "inputSchema")]
    pub input_schema: Option<serde_json::Value>,

    /// Output schema (JSON Schema).
    #[serde(rename = "outputSchema")]
    pub output_schema: Option<serde_json::Value>,
}

/// Authentication information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticationInfo {
    /// Supported authentication schemes.
    pub schemes: Vec<String>,
}

/// AgoraMesh-specific extensions to the Capability Card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgoraMeshExtension {
    /// Agent's DID.
    pub did: String,

    /// Trust score (0.0 - 1.0).
    pub trust_score: Option<f64>,

    /// Stake amount in USDC.
    pub stake: Option<u64>,

    /// Pricing information.
    pub pricing: Option<PricingInfo>,

    /// Supported payment methods.
    pub payment_methods: Vec<String>,
}

/// Pricing information for agent services.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricingInfo {
    /// Base price per request in USDC (6 decimals).
    pub base_price: u64,

    /// Price currency (always "USDC").
    pub currency: String,

    /// Pricing model.
    pub model: PricingModel,
}

/// Pricing model types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingModel {
    /// Fixed price per request.
    PerRequest,

    /// Price per token/unit.
    PerToken,

    /// Price per second.
    PerSecond,

    /// Custom pricing.
    Custom,
}

/// Discovery service for finding agents.
///
/// Provides agent registration, search, and lookup functionality.
/// Uses local cache for fast lookups and DHT for distributed storage.
/// Optionally uses HybridSearch for semantic search capabilities.
pub struct DiscoveryService {
    /// Local cache of capability cards indexed by DID.
    cache: RwLock<HashMap<String, CapabilityCard>>,

    /// Optional network command sender for DHT operations.
    network_tx: Option<mpsc::Sender<SwarmCommand>>,

    /// Optional hybrid search for semantic search capabilities.
    /// Falls back to simple keyword matching if not available.
    /// Wrapped in Arc so it can be shared with the API layer for semantic search queries.
    hybrid_search: Option<Arc<tokio::sync::RwLock<HybridSearch>>>,
}

impl DiscoveryService {
    /// Create a new discovery service without network integration.
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            network_tx: None,
            hybrid_search: None,
        }
    }

    /// Create a discovery service with network integration.
    ///
    /// When a network command sender is provided, the service will:
    /// - Store registered cards in the DHT
    /// - Query the DHT for cards not found in local cache
    pub fn with_network(network_tx: mpsc::Sender<SwarmCommand>) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            network_tx: Some(network_tx),
            hybrid_search: None,
        }
    }

    /// Create a discovery service with semantic search capabilities.
    ///
    /// When a HybridSearch is provided, the service will:
    /// - Index registered cards for semantic search
    /// - Use hybrid (vector + keyword) search instead of simple matching
    pub fn with_hybrid_search(hybrid_search: HybridSearch) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            network_tx: None,
            hybrid_search: Some(Arc::new(tokio::sync::RwLock::new(hybrid_search))),
        }
    }

    /// Create a discovery service with both network and semantic search.
    pub fn with_network_and_search(
        network_tx: mpsc::Sender<SwarmCommand>,
        hybrid_search: HybridSearch,
    ) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            network_tx: Some(network_tx),
            hybrid_search: Some(Arc::new(tokio::sync::RwLock::new(hybrid_search))),
        }
    }

    /// Create a discovery service with a shared HybridSearch instance.
    ///
    /// Use this when the same HybridSearch must be accessible from both
    /// the discovery service (for indexing on register) and the API layer
    /// (for semantic search queries).
    pub fn with_network_and_shared_search(
        network_tx: mpsc::Sender<SwarmCommand>,
        hybrid_search: Arc<tokio::sync::RwLock<HybridSearch>>,
    ) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            network_tx: Some(network_tx),
            hybrid_search: Some(hybrid_search),
        }
    }

    /// Return a shared reference to the hybrid search instance, if available.
    ///
    /// This allows the API layer to share the same search index that the
    /// discovery service populates on registration.
    pub fn hybrid_search(&self) -> Option<Arc<tokio::sync::RwLock<HybridSearch>>> {
        self.hybrid_search.clone()
    }

    /// Check if semantic search is available.
    pub fn has_semantic_search(&self) -> bool {
        self.hybrid_search.is_some()
    }

    /// Register a capability card.
    ///
    /// # Arguments
    ///
    /// * `card` - The capability card to register
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The card is missing the AgoraMesh extension with DID
    /// - The DID format is invalid
    pub async fn register(&self, card: &CapabilityCard) -> Result<()> {
        // Validate: card must have agoramesh extension with DID
        let agoramesh = card
            .agoramesh
            .as_ref()
            .ok_or_else(|| Error::Discovery("Missing agoramesh extension with DID".to_string()))?;

        let did = &agoramesh.did;

        // Validate DID format: must start with "did:"
        if !did.starts_with("did:") {
            return Err(Error::Discovery(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                did
            )));
        }

        // Store in local cache
        {
            let mut cache = self.cache.write().map_err(|e| {
                Error::Discovery(format!("Failed to acquire cache write lock: {}", e))
            })?;
            cache.insert(did.clone(), card.clone());
        }

        // Index in hybrid search if available
        if let Some(ref hybrid_search) = self.hybrid_search {
            let mut search = hybrid_search.write().await;
            // Log but don't fail if indexing fails - cache still works
            if let Err(e) = search.index_card(card).await {
                tracing::warn!("Failed to index card in hybrid search: {}", e);
            }
        }

        // Store in DHT and announce via GossipSub if network is available
        if let Some(ref tx) = self.network_tx {
            let serialized = serde_json::to_vec(card)
                .map_err(|e| Error::Discovery(format!("Failed to serialize card: {}", e)))?;

            // Store in DHT for persistent lookup
            tx.send(SwarmCommand::PutRecord {
                key: did.as_bytes().to_vec(),
                value: serialized.clone(),
            })
            .await
            .map_err(|e| Error::Discovery(format!("Failed to send DHT put command: {}", e)))?;

            // Announce via GossipSub for real-time discovery
            tx.send(SwarmCommand::Publish {
                topic: "/agoramesh/discovery/1.0.0".to_string(),
                data: serialized,
            })
            .await
            .map_err(|e| Error::Discovery(format!("Failed to send GossipSub publish: {}", e)))?;
        }

        Ok(())
    }

    /// Search for agents by capability.
    ///
    /// When HybridSearch is available, uses combined vector similarity and keyword
    /// matching for semantic search. Falls back to simple keyword matching otherwise.
    ///
    /// **Design Note:** Search operates on local cache only. The cache is populated from:
    /// - Direct registrations via `register()`
    /// - DHT queries via `get()` for specific DIDs
    /// - GossipSub announcements (when subscribed to discovery topic)
    ///
    /// DHT (Kademlia) is a key-value store that doesn't support full-text search.
    /// For broader discovery, call `request_registry_broadcast()` to request peers
    /// to announce their known agents.
    ///
    /// # Arguments
    ///
    /// * `query` - Search query string
    ///
    /// # Returns
    ///
    /// A list of matching capability cards, ranked by relevance (hybrid score or trust score).
    pub async fn search(&self, query: &str) -> Result<Vec<CapabilityCard>> {
        // Use hybrid search if available
        if let Some(ref hybrid_search) = self.hybrid_search {
            let search = hybrid_search.read().await;
            match search.search(query).await {
                Ok(results) => {
                    // Extract cards from search results (already ranked by hybrid score)
                    return Ok(results.into_iter().map(|r| r.card).collect());
                }
                Err(e) => {
                    // Log and fall back to simple search
                    tracing::warn!("Hybrid search failed, falling back to simple search: {}", e);
                }
            }
        }

        // Fall back to simple keyword matching
        self.search_simple(query).await
    }

    /// Simple keyword search (fallback when hybrid search is unavailable).
    async fn search_simple(&self, query: &str) -> Result<Vec<CapabilityCard>> {
        let cache = self
            .cache
            .read()
            .map_err(|e| Error::Discovery(format!("Failed to acquire cache read lock: {}", e)))?;

        let query_lower = query.to_lowercase();

        let mut matches: Vec<CapabilityCard> = cache
            .values()
            .filter(|card| self.card_matches(card, &query_lower))
            .cloned()
            .collect();

        // Note: DHT doesn't support text search - it's a key-value store.
        // Search works on local cache, which is populated from:
        // 1. Direct registrations
        // 2. GossipSub announcements from peers
        // 3. Explicit DHT queries for known DIDs

        // Rank results by trust score (highest first)
        matches.sort_by(|a, b| {
            let score_a = a
                .agoramesh
                .as_ref()
                .and_then(|e| e.trust_score)
                .unwrap_or(0.0);
            let score_b = b
                .agoramesh
                .as_ref()
                .and_then(|e| e.trust_score)
                .unwrap_or(0.0);
            // Sort descending (higher scores first)
            score_b
                .partial_cmp(&score_a)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(matches)
    }

    /// Request peers to broadcast their known agents.
    ///
    /// Sends a discovery request via GossipSub. Peers that receive this
    /// request should respond by re-announcing their registered agents.
    ///
    /// This is useful for populating the local cache when first joining
    /// the network or after reconnecting.
    ///
    /// # Returns
    ///
    /// `true` if the request was sent, `false` if network is not available.
    pub async fn request_registry_broadcast(&self) -> Result<bool> {
        if let Some(ref tx) = self.network_tx {
            // Send a discovery request message
            let request = serde_json::json!({
                "type": "discovery_request",
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            });

            tx.send(SwarmCommand::Publish {
                topic: "/agoramesh/discovery/1.0.0".to_string(),
                data: serde_json::to_vec(&request)
                    .map_err(|e| Error::Discovery(format!("Failed to serialize request: {}", e)))?,
            })
            .await
            .map_err(|e| Error::Discovery(format!("Failed to send discovery request: {}", e)))?;

            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Get the number of agents in the local cache.
    pub fn cache_size(&self) -> usize {
        self.cache.read().map(|c| c.len()).unwrap_or(0)
    }

    /// Check if a capability card matches the search query.
    fn card_matches(&self, card: &CapabilityCard, query_lower: &str) -> bool {
        // Match against name
        if card.name.to_lowercase().contains(query_lower) {
            return true;
        }

        // Match against description
        if card.description.to_lowercase().contains(query_lower) {
            return true;
        }

        // Match against capability names
        for capability in &card.capabilities {
            if capability.name.to_lowercase().contains(query_lower) {
                return true;
            }
            if let Some(desc) = &capability.description {
                if desc.to_lowercase().contains(query_lower) {
                    return true;
                }
            }
        }

        false
    }

    /// Get a specific agent's capability card by DID.
    ///
    /// # Arguments
    ///
    /// * `did` - The agent's DID
    ///
    /// # Returns
    ///
    /// The capability card if found, None otherwise.
    ///
    /// # DHT Query Behavior
    ///
    /// If the card is not in the local cache and network is available:
    /// - Sends a GetRecord command to the DHT
    /// - Waits up to 10 seconds for a response
    /// - Caches successful responses for future lookups
    pub async fn get(&self, did: &str) -> Result<Option<CapabilityCard>> {
        // Check local cache first
        {
            let cache = self.cache.read().map_err(|e| {
                Error::Discovery(format!("Failed to acquire cache read lock: {}", e))
            })?;

            if let Some(card) = cache.get(did).cloned() {
                return Ok(Some(card));
            }
        }

        // Query DHT if network is available and not in cache
        if let Some(ref tx) = self.network_tx {
            let (response_tx, response_rx) = tokio::sync::oneshot::channel();

            tx.send(SwarmCommand::GetRecord {
                key: did.as_bytes().to_vec(),
                response_tx,
            })
            .await
            .map_err(|e| Error::Discovery(format!("Failed to send DHT get command: {}", e)))?;

            // Wait for DHT response with timeout
            let dht_timeout = std::time::Duration::from_secs(10);
            match tokio::time::timeout(dht_timeout, response_rx).await {
                Ok(Ok(Some(data))) => {
                    // Parse the capability card from DHT data
                    match serde_json::from_slice::<CapabilityCard>(&data) {
                        Ok(card) => {
                            // Cache the result for future lookups
                            if let Ok(mut cache) = self.cache.write() {
                                cache.insert(did.to_string(), card.clone());
                            }
                            return Ok(Some(card));
                        }
                        Err(e) => {
                            tracing::warn!("Failed to parse DHT record for {}: {}", did, e);
                        }
                    }
                }
                Ok(Ok(None)) => {
                    // DHT query completed but record not found
                    tracing::debug!("DHT record not found for {}", did);
                }
                Ok(Err(_)) => {
                    // Channel closed (sender dropped)
                    tracing::debug!("DHT query channel closed for {}", did);
                }
                Err(_) => {
                    // Timeout
                    tracing::debug!("DHT query timeout for {}", did);
                }
            }
        }

        Ok(None)
    }
}

impl Default for DiscoveryService {
    fn default() -> Self {
        Self::new()
    }
}

// Ensure DiscoveryService is Send + Sync for async contexts
static_assertions::assert_impl_all!(DiscoveryService: Send, Sync);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::EmbeddingService;

    fn sample_capability_card(did: &str) -> CapabilityCard {
        CapabilityCard {
            name: "Test Agent".to_string(),
            description: "A test agent for TDD".to_string(),
            url: "https://agent.example.com".to_string(),
            provider: Some(ProviderInfo {
                organization: "Test Org".to_string(),
                url: Some("https://example.com".to_string()),
            }),
            capabilities: vec![Capability {
                id: "translate".to_string(),
                name: "Translation".to_string(),
                description: Some("Translates text".to_string()),
                input_schema: None,
                output_schema: None,
            }],
            authentication: None,
            agoramesh: Some(AgoraMeshExtension {
                did: did.to_string(),
                trust_score: Some(0.85),
                stake: Some(1_000_000_000), // 1000 USDC
                pricing: Some(PricingInfo {
                    base_price: 100_000, // 0.10 USDC
                    currency: "USDC".to_string(),
                    model: PricingModel::PerRequest,
                }),
                payment_methods: vec!["x402".to_string()],
            }),
        }
    }

    // ========== TDD Test: register() ==========

    #[tokio::test]
    async fn test_register_valid_capability_card() {
        // Arrange
        let service = DiscoveryService::new();
        let card = sample_capability_card("did:agoramesh:base:test-agent-123");

        // Act
        let result = service.register(&card).await;

        // Assert
        assert!(result.is_ok(), "Registration should succeed for valid card");
    }

    #[tokio::test]
    async fn test_register_requires_did_in_agoramesh_extension() {
        // Arrange
        let service = DiscoveryService::new();
        let mut card = sample_capability_card("did:agoramesh:base:test");
        card.agoramesh = None; // Remove agoramesh extension

        // Act
        let result = service.register(&card).await;

        // Assert
        assert!(result.is_err(), "Registration should fail without DID");
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("DID") || err.to_string().contains("agoramesh"),
            "Error should mention missing DID or agoramesh extension"
        );
    }

    #[tokio::test]
    async fn test_register_validates_did_format() {
        // Arrange
        let service = DiscoveryService::new();
        let card = sample_capability_card("invalid-did-format");

        // Act
        let result = service.register(&card).await;

        // Assert
        assert!(
            result.is_err(),
            "Registration should fail with invalid DID format"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("DID") || err.to_string().contains("format"),
            "Error should mention invalid DID format"
        );
    }

    #[tokio::test]
    async fn test_register_stores_card_for_later_retrieval() {
        // Arrange
        let service = DiscoveryService::new();
        let did = "did:agoramesh:base:retrievable-agent";
        let card = sample_capability_card(did);

        // Act
        service
            .register(&card)
            .await
            .expect("Registration should succeed");
        let retrieved = service.get(did).await;

        // Assert
        assert!(retrieved.is_ok(), "Get should not error");
        let retrieved_card = retrieved.unwrap();
        assert!(
            retrieved_card.is_some(),
            "Card should be retrievable after registration"
        );
        assert_eq!(retrieved_card.unwrap().name, card.name);
    }

    // ========== TDD Tests: get() ==========

    #[tokio::test]
    async fn test_get_returns_none_for_unknown_did() {
        // Arrange
        let service = DiscoveryService::new();

        // Act
        let result = service.get("did:agoramesh:base:nonexistent").await;

        // Assert
        assert!(result.is_ok(), "Get should not error for unknown DID");
        assert!(
            result.unwrap().is_none(),
            "Should return None for unknown DID"
        );
    }

    #[tokio::test]
    async fn test_get_returns_correct_card_among_multiple() {
        // Arrange
        let service = DiscoveryService::new();
        let did1 = "did:agoramesh:base:agent-1";
        let did2 = "did:agoramesh:base:agent-2";
        let did3 = "did:agoramesh:base:agent-3";

        let mut card1 = sample_capability_card(did1);
        card1.name = "Agent One".to_string();
        let mut card2 = sample_capability_card(did2);
        card2.name = "Agent Two".to_string();
        let mut card3 = sample_capability_card(did3);
        card3.name = "Agent Three".to_string();

        // Act
        service.register(&card1).await.unwrap();
        service.register(&card2).await.unwrap();
        service.register(&card3).await.unwrap();

        let result = service.get(did2).await;

        // Assert
        assert!(result.is_ok());
        let card = result.unwrap().expect("Should find agent-2");
        assert_eq!(card.name, "Agent Two", "Should return correct card");
    }

    // ========== TDD Tests: search() ==========

    #[tokio::test]
    async fn test_search_returns_empty_for_no_matches() {
        // Arrange
        let service = DiscoveryService::new();
        let card = sample_capability_card("did:agoramesh:base:translator");
        service.register(&card).await.unwrap();

        // Act
        let result = service.search("nonexistent-capability").await;

        // Assert
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_empty(),
            "Should return empty for no matches"
        );
    }

    #[tokio::test]
    async fn test_search_finds_agents_by_name() {
        // Arrange
        let service = DiscoveryService::new();
        let mut card1 = sample_capability_card("did:agoramesh:base:translator-1");
        card1.name = "French Translator".to_string();
        let mut card2 = sample_capability_card("did:agoramesh:base:coder-1");
        card2.name = "Code Assistant".to_string();
        let mut card3 = sample_capability_card("did:agoramesh:base:translator-2");
        card3.name = "Spanish Translator".to_string();

        service.register(&card1).await.unwrap();
        service.register(&card2).await.unwrap();
        service.register(&card3).await.unwrap();

        // Act
        let result = service.search("Translator").await;

        // Assert
        assert!(result.is_ok());
        let matches = result.unwrap();
        assert_eq!(matches.len(), 2, "Should find 2 translators");
        assert!(matches.iter().all(|c| c.name.contains("Translator")));
    }

    #[tokio::test]
    async fn test_search_finds_agents_by_capability() {
        // Arrange
        let service = DiscoveryService::new();
        let card = sample_capability_card("did:agoramesh:base:agent");
        service.register(&card).await.unwrap();

        // Act - search for capability name "Translation"
        let result = service.search("Translation").await;

        // Assert
        assert!(result.is_ok());
        let matches = result.unwrap();
        assert_eq!(
            matches.len(),
            1,
            "Should find 1 agent with Translation capability"
        );
    }

    #[tokio::test]
    async fn test_search_is_case_insensitive() {
        // Arrange
        let service = DiscoveryService::new();
        let mut card = sample_capability_card("did:agoramesh:base:agent");
        card.name = "MyAgent".to_string();
        service.register(&card).await.unwrap();

        // Act
        let result = service.search("myagent").await;

        // Assert
        assert!(result.is_ok());
        assert_eq!(
            result.unwrap().len(),
            1,
            "Search should be case-insensitive"
        );
    }

    #[tokio::test]
    async fn test_search_returns_empty_on_empty_cache() {
        // Arrange
        let service = DiscoveryService::new();

        // Act
        let result = service.search("anything").await;

        // Assert
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // ========== TDD Tests: DHT Integration ==========

    #[tokio::test]
    async fn test_register_sends_dht_put_command_when_network_available() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:dht-test-agent";
        let card = sample_capability_card(did);

        // Act
        service
            .register(&card)
            .await
            .expect("Registration should succeed");

        // Assert - should have received a PutRecord command
        let cmd = rx.try_recv().expect("Should have received a command");
        match cmd {
            SwarmCommand::PutRecord { key, value } => {
                // Key should be the DID
                assert_eq!(String::from_utf8_lossy(&key), did);
                // Value should be serialized card
                let stored_card: CapabilityCard =
                    serde_json::from_slice(&value).expect("Should deserialize to CapabilityCard");
                assert_eq!(stored_card.name, card.name);
            }
            _ => panic!("Expected PutRecord command, got {:?}", cmd),
        }
    }

    #[tokio::test]
    async fn test_register_still_works_without_network() {
        // Arrange - no network configured
        let service = DiscoveryService::new();
        let did = "did:agoramesh:base:offline-agent";
        let card = sample_capability_card(did);

        // Act
        let result = service.register(&card).await;

        // Assert - should still succeed (local cache only)
        assert!(
            result.is_ok(),
            "Registration should succeed without network"
        );

        // Verify card is in local cache
        let retrieved = service.get(did).await.unwrap();
        assert!(retrieved.is_some());
    }

    #[tokio::test]
    async fn test_get_queries_dht_when_not_in_cache() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:remote-agent";

        // Act - get agent not in cache
        // Note: This will send a GetRecord command but we won't wait for response in this test
        let _ = service.get(did).await;

        // Assert - should have sent GetRecord command
        let cmd = rx.try_recv().expect("Should have received a command");
        match cmd {
            SwarmCommand::GetRecord { key, .. } => {
                assert_eq!(String::from_utf8_lossy(&key), did);
            }
            _ => panic!("Expected GetRecord command, got {:?}", cmd),
        }
    }

    #[tokio::test]
    async fn test_get_returns_card_from_dht_response() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:dht-stored-agent";
        let card = sample_capability_card(did);
        let serialized_card = serde_json::to_vec(&card).unwrap();

        // Act - spawn get() in background, simulate DHT response
        let service_clone = std::sync::Arc::new(service);
        let service_for_task = service_clone.clone();
        let did_clone = did.to_string();

        let get_task = tokio::spawn(async move { service_for_task.get(&did_clone).await });

        // Simulate DHT swarm returning the record
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        if let Some(cmd) = rx.recv().await {
            match cmd {
                SwarmCommand::GetRecord { response_tx, .. } => {
                    // Simulate DHT returning the serialized card
                    let _ = response_tx.send(Some(serialized_card));
                }
                _ => panic!("Expected GetRecord command"),
            }
        }

        // Assert - get should return the card from DHT
        let result = get_task.await.expect("Task should complete");
        assert!(result.is_ok(), "get() should not error");
        let retrieved_card = result.unwrap();
        assert!(
            retrieved_card.is_some(),
            "get() should return card from DHT response"
        );
        assert_eq!(
            retrieved_card.unwrap().name,
            card.name,
            "Should return correct card data"
        );
    }

    #[tokio::test]
    async fn test_get_returns_none_when_dht_has_no_record() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:nonexistent-dht-agent";

        // Act - spawn get() in background
        let service_clone = std::sync::Arc::new(service);
        let service_for_task = service_clone.clone();
        let did_clone = did.to_string();

        let get_task = tokio::spawn(async move { service_for_task.get(&did_clone).await });

        // Simulate DHT returning None (record not found)
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        if let Some(cmd) = rx.recv().await {
            match cmd {
                SwarmCommand::GetRecord { response_tx, .. } => {
                    let _ = response_tx.send(None);
                }
                _ => panic!("Expected GetRecord command"),
            }
        }

        // Assert - get should return None
        let result = get_task.await.expect("Task should complete");
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_none(),
            "get() should return None when DHT has no record"
        );
    }

    #[tokio::test]
    async fn test_get_caches_card_from_dht_response() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = std::sync::Arc::new(DiscoveryService::with_network(tx));
        let did = "did:agoramesh:base:cache-from-dht-agent";
        let card = sample_capability_card(did);
        let serialized_card = serde_json::to_vec(&card).unwrap();

        // First get - triggers DHT query
        let service_for_task = service.clone();
        let did_clone = did.to_string();
        let get_task = tokio::spawn(async move { service_for_task.get(&did_clone).await });

        // Simulate DHT response
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        if let Some(SwarmCommand::GetRecord { response_tx, .. }) = rx.recv().await {
            let _ = response_tx.send(Some(serialized_card));
        }

        let _ = get_task.await;

        // Second get - should return from cache without DHT query
        let result = service.get(did).await;

        // Assert - should return cached value
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_some(),
            "Second get should return cached value"
        );

        // No additional DHT query should be sent
        assert!(
            rx.try_recv().is_err(),
            "Should not query DHT again for cached card"
        );
    }

    #[tokio::test]
    async fn test_get_returns_cached_value_without_dht_query() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:cached-agent";
        let card = sample_capability_card(did);

        // Pre-populate cache
        service.register(&card).await.unwrap();
        // Drain the PutRecord and Publish commands from registration
        let _ = rx.try_recv(); // PutRecord
        let _ = rx.try_recv(); // Publish

        // Act - get cached agent
        let result = service.get(did).await;

        // Assert - should return cached value without DHT query
        assert!(result.is_ok());
        assert!(result.unwrap().is_some());

        // No additional command should have been sent
        assert!(
            rx.try_recv().is_err(),
            "Should not send GetRecord for cached entry"
        );
    }

    #[tokio::test]
    async fn test_register_sends_gossipsub_announce_when_network_available() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Arrange
        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);
        let did = "did:agoramesh:base:announced-agent";
        let card = sample_capability_card(did);

        // Act
        service
            .register(&card)
            .await
            .expect("Registration should succeed");

        // Assert - should receive PutRecord first, then Publish
        let cmd1 = rx.recv().await.expect("Should receive first command");
        assert!(
            matches!(cmd1, SwarmCommand::PutRecord { .. }),
            "First command should be PutRecord"
        );

        let cmd2 = rx.recv().await.expect("Should receive second command");
        match cmd2 {
            SwarmCommand::Publish { topic, data } => {
                // Should publish to discovery topic
                assert!(
                    topic.contains("discovery"),
                    "Should publish to discovery topic"
                );
                // Data should be serialized announcement
                assert!(!data.is_empty(), "Announcement data should not be empty");
            }
            _ => panic!("Expected Publish command, got {:?}", cmd2),
        }
    }

    #[tokio::test]
    async fn test_search_ranks_results_by_trust_score() {
        // Arrange
        let service = DiscoveryService::new();

        // Create agents with different trust scores
        let mut low_trust = sample_capability_card("did:agoramesh:base:low-trust");
        low_trust.name = "Translation Agent Low".to_string();
        if let Some(ref mut ext) = low_trust.agoramesh {
            ext.trust_score = Some(0.3);
        }

        let mut high_trust = sample_capability_card("did:agoramesh:base:high-trust");
        high_trust.name = "Translation Agent High".to_string();
        if let Some(ref mut ext) = high_trust.agoramesh {
            ext.trust_score = Some(0.9);
        }

        let mut medium_trust = sample_capability_card("did:agoramesh:base:medium-trust");
        medium_trust.name = "Translation Agent Medium".to_string();
        if let Some(ref mut ext) = medium_trust.agoramesh {
            ext.trust_score = Some(0.6);
        }

        // Register in non-sorted order
        service.register(&low_trust).await.unwrap();
        service.register(&high_trust).await.unwrap();
        service.register(&medium_trust).await.unwrap();

        // Act - search for translation agents
        let results = service.search("Translation").await.unwrap();

        // Assert - results should be sorted by trust score (highest first)
        assert_eq!(results.len(), 3);
        let scores: Vec<f64> = results
            .iter()
            .filter_map(|c| c.agoramesh.as_ref().and_then(|e| e.trust_score))
            .collect();

        assert_eq!(
            scores,
            vec![0.9, 0.6, 0.3],
            "Results should be sorted by trust score descending"
        );
    }

    // ========== TDD Tests: cache_size() ==========

    #[tokio::test]
    async fn test_cache_size_returns_zero_for_empty_cache() {
        let service = DiscoveryService::new();
        assert_eq!(service.cache_size(), 0);
    }

    #[tokio::test]
    async fn test_cache_size_reflects_registered_agents() {
        let service = DiscoveryService::new();

        service
            .register(&sample_capability_card("did:agoramesh:base:agent1"))
            .await
            .unwrap();
        assert_eq!(service.cache_size(), 1);

        service
            .register(&sample_capability_card("did:agoramesh:base:agent2"))
            .await
            .unwrap();
        assert_eq!(service.cache_size(), 2);
    }

    // ========== TDD Tests: request_registry_broadcast() ==========

    #[tokio::test]
    async fn test_request_registry_broadcast_returns_false_without_network() {
        let service = DiscoveryService::new();

        let result = service.request_registry_broadcast().await;

        assert!(result.is_ok());
        assert!(!result.unwrap(), "Should return false without network");
    }

    #[tokio::test]
    async fn test_request_registry_broadcast_sends_gossipsub_message() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let service = DiscoveryService::with_network(tx);

        let result = service.request_registry_broadcast().await;

        assert!(result.is_ok());
        assert!(result.unwrap(), "Should return true with network");

        // Should receive Publish command
        let cmd = rx.recv().await.expect("Should receive command");
        match cmd {
            SwarmCommand::Publish { topic, data } => {
                assert!(
                    topic.contains("discovery"),
                    "Should publish to discovery topic"
                );

                // Verify it's a discovery request
                let msg: serde_json::Value = serde_json::from_slice(&data).unwrap();
                assert_eq!(msg["type"], "discovery_request");
            }
            _ => panic!("Expected Publish command, got {:?}", cmd),
        }
    }

    // ========== TDD Tests: HybridSearch Integration ==========

    /// Helper to create DiscoveryService with HybridSearch if embedding model is available.
    fn try_get_service_with_search() -> Option<DiscoveryService> {
        let embedding_service = EmbeddingService::new().ok()?;
        let hybrid_search = HybridSearch::new(embedding_service);
        Some(DiscoveryService::with_hybrid_search(hybrid_search))
    }

    #[test]
    fn test_has_semantic_search_returns_false_without_hybrid_search() {
        let service = DiscoveryService::new();
        assert!(
            !service.has_semantic_search(),
            "Should return false without HybridSearch"
        );
    }

    #[test]
    fn test_has_semantic_search_returns_true_with_hybrid_search() {
        let Some(service) = try_get_service_with_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        assert!(
            service.has_semantic_search(),
            "Should return true with HybridSearch"
        );
    }

    #[tokio::test]
    async fn test_register_indexes_card_in_hybrid_search() {
        let Some(service) = try_get_service_with_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_capability_card("did:agoramesh:base:indexed-agent");

        // Register the card
        service
            .register(&card)
            .await
            .expect("Registration should succeed");

        // Verify card is in local cache
        let cached = service.get("did:agoramesh:base:indexed-agent").await;
        assert!(cached.is_ok());
        assert!(
            cached.unwrap().is_some(),
            "Card should be in local cache after registration"
        );

        // Verify card is indexed in hybrid search
        // We verify this by searching for it
        let results = service.search("Translation").await;
        assert!(results.is_ok());
        let matches = results.unwrap();
        assert!(
            !matches.is_empty(),
            "Should find card via hybrid search after registration"
        );
    }

    #[tokio::test]
    async fn test_search_uses_hybrid_search_when_available() {
        let Some(service) = try_get_service_with_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Register a card with specific capability
        let mut card = sample_capability_card("did:agoramesh:base:code-reviewer");
        card.name = "AI Code Review Agent".to_string();
        card.description = "Reviews code for bugs and improvements".to_string();
        card.capabilities = vec![Capability {
            id: "code-review".to_string(),
            name: "Code Review".to_string(),
            description: Some("Analyzes source code quality".to_string()),
            input_schema: None,
            output_schema: None,
        }];
        service.register(&card).await.unwrap();

        // Search with semantic query (not exact match)
        let results = service.search("analyze my code").await;
        assert!(results.is_ok());
        let matches = results.unwrap();

        // Should find the agent due to semantic similarity
        assert!(
            !matches.is_empty(),
            "Hybrid search should find semantically similar agent"
        );
        assert_eq!(
            matches[0]
                .agoramesh
                .as_ref()
                .map(|e| e.did.as_str())
                .unwrap_or(""),
            "did:agoramesh:base:code-reviewer"
        );
    }

    #[tokio::test]
    async fn test_search_falls_back_to_simple_search_without_hybrid() {
        // Create service without hybrid search
        let service = DiscoveryService::new();

        // Register a card
        let mut card = sample_capability_card("did:agoramesh:base:simple-agent");
        card.name = "Simple Agent".to_string();
        service.register(&card).await.unwrap();

        // Search should still work (using simple matching)
        let results = service.search("Simple").await;
        assert!(results.is_ok());
        let matches = results.unwrap();
        assert_eq!(matches.len(), 1, "Simple search should find matching agent");
    }

    #[tokio::test]
    async fn test_hybrid_search_ranks_by_relevance_not_trust_score() {
        let Some(service) = try_get_service_with_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Create an agent that matches well but has low trust score
        let mut high_relevance = sample_capability_card("did:agoramesh:base:high-relevance");
        high_relevance.name = "Code Review Expert".to_string();
        high_relevance.description =
            "Expert code review service for software developers".to_string();
        if let Some(ref mut ext) = high_relevance.agoramesh {
            ext.trust_score = Some(0.3); // Low trust
        }

        // Create an agent that matches poorly but has high trust score
        let mut low_relevance = sample_capability_card("did:agoramesh:base:low-relevance");
        low_relevance.name = "Weather Forecast".to_string();
        low_relevance.description = "Provides weather predictions for any location".to_string();
        if let Some(ref mut ext) = low_relevance.agoramesh {
            ext.trust_score = Some(0.95); // High trust
        }

        service.register(&high_relevance).await.unwrap();
        service.register(&low_relevance).await.unwrap();

        // Search for code review
        let results = service.search("code review").await.unwrap();

        // With hybrid search, high relevance should come first despite lower trust
        if !results.is_empty() {
            let first_did = results[0]
                .agoramesh
                .as_ref()
                .map(|e| e.did.as_str())
                .unwrap_or("");
            assert_eq!(
                first_did, "did:agoramesh:base:high-relevance",
                "Hybrid search should rank by relevance, not trust score"
            );
        }
    }

    #[tokio::test]
    async fn test_with_network_and_search_has_both_capabilities() {
        use crate::network::SwarmCommand;
        use tokio::sync::mpsc;

        // Skip if embedding model not available
        let embedding_service = match EmbeddingService::new() {
            Ok(s) => s,
            Err(_) => {
                eprintln!("Skipping: embedding model not available");
                return;
            }
        };

        let (tx, mut rx) = mpsc::channel::<SwarmCommand>(10);
        let hybrid_search = HybridSearch::new(embedding_service);
        let service = DiscoveryService::with_network_and_search(tx, hybrid_search);

        // Verify both capabilities are available
        assert!(service.has_semantic_search(), "Should have semantic search");

        // Register a card - should send to DHT and index in hybrid search
        let card = sample_capability_card("did:agoramesh:base:combined-test");
        service.register(&card).await.unwrap();

        // Should have sent DHT commands
        let cmd = rx.try_recv().expect("Should have received DHT command");
        assert!(
            matches!(cmd, SwarmCommand::PutRecord { .. }),
            "Should send PutRecord"
        );
    }
}
