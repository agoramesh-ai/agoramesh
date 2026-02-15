//! Hybrid search combining keyword (BM25) and vector similarity.
//!
//! Uses Reciprocal Rank Fusion (RRF) to combine results from:
//! - BM25 keyword matching (exact term matches)
//! - Vector cosine similarity (semantic meaning)

use crate::discovery::CapabilityCard;
use crate::error::{Error, Result};
use std::collections::HashMap;

use super::embedding::{Embedding, EmbeddingService};

/// Configuration for hybrid search.
#[derive(Debug, Clone)]
pub struct HybridSearchConfig {
    /// Weight for vector similarity (0.0 - 1.0)
    pub vector_weight: f32,

    /// Weight for BM25 keyword matching (0.0 - 1.0)
    pub keyword_weight: f32,

    /// RRF constant k (default: 60)
    pub rrf_k: f32,

    /// Maximum number of results to return
    pub max_results: usize,

    /// Minimum score threshold (0.0 - 1.0)
    pub min_score: f32,
}

impl Default for HybridSearchConfig {
    fn default() -> Self {
        Self {
            vector_weight: 0.7,
            keyword_weight: 0.3,
            rrf_k: 60.0,
            max_results: 20,
            min_score: 0.1,
        }
    }
}

/// Search result with combined score.
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// Agent DID
    pub did: String,

    /// Combined hybrid score (0.0 - 1.0)
    pub score: f32,

    /// Vector similarity score
    pub vector_score: f32,

    /// Keyword match score
    pub keyword_score: f32,

    /// The capability card
    pub card: CapabilityCard,
}

/// Hybrid search combining BM25 keyword matching and vector similarity.
pub struct HybridSearch {
    /// Embedding service for vector generation
    embedding_service: EmbeddingService,

    /// In-memory index of agent embeddings (DID -> embedding)
    index: HashMap<String, (CapabilityCard, Embedding)>,

    /// Configuration
    config: HybridSearchConfig,
}

impl HybridSearch {
    /// Create a new hybrid search instance.
    pub fn new(embedding_service: EmbeddingService) -> Self {
        Self::with_config(embedding_service, HybridSearchConfig::default())
    }

    /// Create with custom configuration.
    pub fn with_config(embedding_service: EmbeddingService, config: HybridSearchConfig) -> Self {
        Self {
            embedding_service,
            index: HashMap::new(),
            config,
        }
    }

    /// Index a capability card for search.
    ///
    /// Generates and stores embedding for the card.
    pub async fn index_card(&mut self, card: &CapabilityCard) -> Result<()> {
        let did = card
            .agentme
            .as_ref()
            .map(|ext| ext.did.clone())
            .ok_or_else(|| Error::Search("Card missing DID".to_string()))?;

        // Create text for embedding
        let capabilities: Vec<String> = card.capabilities.iter().map(|c| c.name.clone()).collect();

        let text = EmbeddingService::card_to_text(&card.name, &card.description, &capabilities);

        // Generate embedding
        let embedding = self.embedding_service.embed(&text).await?;

        // Store in index
        self.index.insert(did, (card.clone(), embedding));

        Ok(())
    }

    /// Remove a card from the index.
    pub fn remove_card(&mut self, did: &str) -> bool {
        self.index.remove(did).is_some()
    }

    /// Search for agents matching the query.
    ///
    /// Combines vector similarity and keyword matching using RRF.
    pub async fn search(&self, query: &str) -> Result<Vec<SearchResult>> {
        if self.index.is_empty() {
            return Ok(vec![]);
        }

        // Generate query embedding
        let query_embedding = self.embedding_service.embed(query).await?;
        let query_lower = query.to_lowercase();
        let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

        // Score all indexed cards
        let mut results: Vec<SearchResult> = vec![];

        for (did, (card, embedding)) in &self.index {
            // Vector similarity score
            let vector_score = EmbeddingService::cosine_similarity(&query_embedding, embedding);
            // Normalize to 0-1 range (cosine can be -1 to 1)
            let vector_score = (vector_score + 1.0) / 2.0;

            // Keyword match score (simple BM25-like)
            let keyword_score = self.compute_keyword_score(card, &query_terms);

            // Skip if both scores are too low
            if vector_score < 0.3 && keyword_score < 0.1 {
                continue;
            }

            // Combine scores using weighted sum (simplified from RRF for in-memory use)
            let combined_score = self.config.vector_weight * vector_score
                + self.config.keyword_weight * keyword_score;

            if combined_score >= self.config.min_score {
                results.push(SearchResult {
                    did: did.clone(),
                    score: combined_score,
                    vector_score,
                    keyword_score,
                    card: card.clone(),
                });
            }
        }

        // Sort by score descending
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Limit results
        results.truncate(self.config.max_results);

        Ok(results)
    }

    /// Compute keyword match score (simplified BM25-like).
    fn compute_keyword_score(&self, card: &CapabilityCard, query_terms: &[&str]) -> f32 {
        if query_terms.is_empty() {
            return 0.0;
        }

        let card_text = format!(
            "{} {} {}",
            card.name,
            card.description,
            card.capabilities
                .iter()
                .map(|c| format!("{} {}", c.name, c.description.as_deref().unwrap_or("")))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .to_lowercase();

        let mut matches = 0;
        for term in query_terms {
            if card_text.contains(term) {
                matches += 1;
            }
        }

        // Return ratio of matching terms
        matches as f32 / query_terms.len() as f32
    }

    /// Get the number of indexed cards.
    pub fn index_size(&self) -> usize {
        self.index.len()
    }

    /// Check if a DID is indexed.
    pub fn is_indexed(&self, did: &str) -> bool {
        self.index.contains_key(did)
    }

    /// Clear the entire index.
    pub fn clear(&mut self) {
        self.index.clear();
    }

    /// Get configuration.
    pub fn config(&self) -> &HybridSearchConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{AgentMeExtension, Capability, PricingInfo, PricingModel, ProviderInfo};

    fn sample_card(
        did: &str,
        name: &str,
        description: &str,
        capabilities: Vec<&str>,
    ) -> CapabilityCard {
        CapabilityCard {
            name: name.to_string(),
            description: description.to_string(),
            url: format!(
                "https://{}.example.com",
                name.to_lowercase().replace(' ', "-")
            ),
            provider: Some(ProviderInfo {
                organization: "Test Org".to_string(),
                url: None,
            }),
            capabilities: capabilities
                .into_iter()
                .map(|c| Capability {
                    id: c.to_lowercase().replace(' ', "-"),
                    name: c.to_string(),
                    description: Some(format!("{} capability", c)),
                    input_schema: None,
                    output_schema: None,
                })
                .collect(),
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

    /// Helper to get a HybridSearch instance if embedding model is available.
    fn try_get_search() -> Option<HybridSearch> {
        let service = EmbeddingService::new().ok()?;
        Some(HybridSearch::new(service))
    }

    fn try_get_search_with_config(config: HybridSearchConfig) -> Option<HybridSearch> {
        let service = EmbeddingService::new().ok()?;
        Some(HybridSearch::with_config(service, config))
    }

    // ========== TDD Tests: HybridSearch creation ==========

    #[tokio::test]
    async fn test_hybrid_search_creates_successfully() {
        let Some(search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        assert_eq!(search.index_size(), 0);
    }

    #[tokio::test]
    async fn test_hybrid_search_with_custom_config() {
        let config = HybridSearchConfig {
            vector_weight: 0.5,
            keyword_weight: 0.5,
            max_results: 10,
            ..Default::default()
        };
        let Some(search) = try_get_search_with_config(config) else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        assert_eq!(search.config().vector_weight, 0.5);
        assert_eq!(search.config().max_results, 10);
    }

    // ========== TDD Tests: index_card() ==========

    #[tokio::test]
    async fn test_index_card_adds_to_index() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_card(
            "did:agentme:base:agent1",
            "Code Reviewer",
            "AI code review agent",
            vec!["Review", "Analyze"],
        );

        let result = search.index_card(&card).await;

        assert!(
            result.is_ok(),
            "Indexing should succeed: {:?}",
            result.err()
        );
        assert_eq!(search.index_size(), 1);
        assert!(search.is_indexed("did:agentme:base:agent1"));
    }

    #[tokio::test]
    async fn test_index_card_rejects_card_without_did() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let mut card = sample_card(
            "did:agentme:base:agent1",
            "Agent",
            "Description",
            vec!["Skill"],
        );
        card.agentme = None; // Remove DID

        let result = search.index_card(&card).await;

        assert!(result.is_err(), "Should reject card without DID");
    }

    #[tokio::test]
    async fn test_index_multiple_cards() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let cards = vec![
            sample_card(
                "did:agentme:base:agent1",
                "Agent 1",
                "Desc 1",
                vec!["Skill1"],
            ),
            sample_card(
                "did:agentme:base:agent2",
                "Agent 2",
                "Desc 2",
                vec!["Skill2"],
            ),
            sample_card(
                "did:agentme:base:agent3",
                "Agent 3",
                "Desc 3",
                vec!["Skill3"],
            ),
        ];

        for card in &cards {
            search.index_card(card).await.expect("Should index");
        }

        assert_eq!(search.index_size(), 3);
    }

    // ========== TDD Tests: remove_card() ==========

    #[tokio::test]
    async fn test_remove_card_removes_from_index() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_card(
            "did:agentme:base:agent1",
            "Agent",
            "Description",
            vec!["Skill"],
        );
        search.index_card(&card).await.expect("Should index");

        let removed = search.remove_card("did:agentme:base:agent1");

        assert!(removed, "Should return true when card existed");
        assert_eq!(search.index_size(), 0);
        assert!(!search.is_indexed("did:agentme:base:agent1"));
    }

    #[tokio::test]
    async fn test_remove_nonexistent_card_returns_false() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let removed = search.remove_card("did:agentme:base:nonexistent");

        assert!(!removed, "Should return false for nonexistent card");
    }

    // ========== TDD Tests: search() ==========

    #[tokio::test]
    async fn test_search_empty_index_returns_empty() {
        let Some(search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let results = search.search("code review").await;

        assert!(results.is_ok());
        assert!(results.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_finds_matching_agent_by_keyword() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_card(
            "did:agentme:base:reviewer",
            "Code Reviewer",
            "AI-powered code review service",
            vec!["Code Review", "Bug Detection"],
        );
        search.index_card(&card).await.expect("Should index");

        let results = search
            .search("code review")
            .await
            .expect("Search should work");

        assert!(!results.is_empty(), "Should find matching agent");
        assert_eq!(results[0].did, "did:agentme:base:reviewer");
        assert!(results[0].keyword_score > 0.0, "Should have keyword match");
    }

    #[tokio::test]
    async fn test_search_finds_semantically_similar_agent() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Index a code review agent
        let card = sample_card(
            "did:agentme:base:reviewer",
            "Code Quality Analyzer",
            "Examines source code for potential issues and improvements",
            vec!["Static Analysis", "Bug Detection"],
        );
        search.index_card(&card).await.expect("Should index");

        // Search with semantically similar but different terms
        let results = search
            .search("review my code for bugs")
            .await
            .expect("Search should work");

        assert!(
            !results.is_empty(),
            "Should find semantically similar agent"
        );
        assert!(
            results[0].vector_score > 0.5,
            "Should have high vector similarity: {}",
            results[0].vector_score
        );
    }

    #[tokio::test]
    async fn test_search_ranks_by_combined_score() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Exact match should rank higher
        let exact_match = sample_card(
            "did:agentme:base:exact",
            "Code Review Agent",
            "Code review service",
            vec!["Code Review"],
        );

        // Partial match
        let partial_match = sample_card(
            "did:agentme:base:partial",
            "Weather Forecast",
            "Weather service with code quality tips",
            vec!["Weather", "Forecast"],
        );

        search.index_card(&exact_match).await.expect("Should index");
        search
            .index_card(&partial_match)
            .await
            .expect("Should index");

        let results = search
            .search("code review")
            .await
            .expect("Search should work");

        assert!(!results.is_empty(), "Should find at least one match");
        assert_eq!(
            results[0].did, "did:agentme:base:exact",
            "Exact match should rank first"
        );
    }

    #[tokio::test]
    async fn test_search_respects_max_results() {
        let config = HybridSearchConfig {
            max_results: 2,
            min_score: 0.0, // Allow all results
            ..Default::default()
        };
        let Some(mut search) = try_get_search_with_config(config) else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Index 5 similar agents
        for i in 0..5 {
            let card = sample_card(
                &format!("did:agentme:base:agent{}", i),
                &format!("AI Agent {}", i),
                "AI assistant for various tasks",
                vec!["AI", "Assistant"],
            );
            search.index_card(&card).await.expect("Should index");
        }

        let results = search
            .search("AI assistant")
            .await
            .expect("Search should work");

        assert!(results.len() <= 2, "Should respect max_results limit");
    }

    #[tokio::test]
    async fn test_search_result_contains_scores() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_card(
            "did:agentme:base:agent",
            "Test Agent",
            "A test agent for scoring",
            vec!["Test"],
        );
        search.index_card(&card).await.expect("Should index");

        let results = search
            .search("test agent")
            .await
            .expect("Search should work");

        assert!(!results.is_empty());
        let result = &results[0];
        assert!(result.score > 0.0, "Combined score should be positive");
        assert!(
            result.vector_score >= 0.0,
            "Vector score should be non-negative"
        );
        assert!(
            result.keyword_score >= 0.0,
            "Keyword score should be non-negative"
        );
    }

    // ========== TDD Tests: clear() ==========

    #[tokio::test]
    async fn test_clear_empties_index() {
        let Some(mut search) = try_get_search() else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_card(
            "did:agentme:base:agent",
            "Agent",
            "Description",
            vec!["Skill"],
        );
        search.index_card(&card).await.expect("Should index");
        assert_eq!(search.index_size(), 1);

        search.clear();

        assert_eq!(search.index_size(), 0);
    }
}
