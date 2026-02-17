//! Embedding generation service using FastEmbed.
//!
//! Converts text (agent names, descriptions, capabilities) into dense vectors
//! for semantic similarity search.

use crate::error::{Error, Result};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::Arc;
use tokio::sync::RwLock;

/// A dense vector embedding (384 dimensions for all-MiniLM-L6-v2)
pub type Embedding = Vec<f32>;

/// Configuration for the embedding service.
#[derive(Debug, Clone)]
pub struct EmbeddingServiceConfig {
    /// Model name (default: all-MiniLM-L6-v2)
    pub model: String,

    /// Cache embeddings in memory to avoid recomputation
    pub enable_cache: bool,

    /// Maximum cache size (number of embeddings)
    pub max_cache_size: usize,
}

impl Default for EmbeddingServiceConfig {
    fn default() -> Self {
        Self {
            model: "all-MiniLM-L6-v2".to_string(),
            enable_cache: true,
            max_cache_size: 10000,
        }
    }
}

/// Service for generating text embeddings using FastEmbed.
///
/// Uses ONNX runtime for fast CPU inference. Models are downloaded
/// automatically on first use.
pub struct EmbeddingService {
    model: TextEmbedding,
    cache: Arc<RwLock<lru::LruCache<String, Embedding>>>,
    config: EmbeddingServiceConfig,
}

impl EmbeddingService {
    /// Create a new embedding service with default configuration.
    ///
    /// Downloads the model on first use (~90MB for all-MiniLM-L6-v2).
    pub fn new() -> Result<Self> {
        Self::with_config(EmbeddingServiceConfig::default())
    }

    /// Create an embedding service with custom configuration.
    pub fn with_config(config: EmbeddingServiceConfig) -> Result<Self> {
        let model_type = match config.model.as_str() {
            "all-MiniLM-L6-v2" => EmbeddingModel::AllMiniLML6V2,
            "BGESmallENV15" => EmbeddingModel::BGESmallENV15,
            "BGEBaseENV15" => EmbeddingModel::BGEBaseENV15,
            _ => {
                return Err(Error::Search(format!(
                    "Unknown embedding model: {}",
                    config.model
                )))
            }
        };

        let init_options = InitOptions::new(model_type).with_show_download_progress(true);

        let model = TextEmbedding::try_new(init_options)
            .map_err(|e| Error::Search(format!("Failed to initialize embedding model: {}", e)))?;

        let cache_size = std::num::NonZeroUsize::new(config.max_cache_size)
            .ok_or_else(|| Error::Config("max_cache_size must be greater than 0".to_string()))?;
        let cache = Arc::new(RwLock::new(lru::LruCache::new(cache_size)));

        Ok(Self {
            model,
            cache,
            config,
        })
    }

    /// Generate embedding for a single text.
    ///
    /// Returns a 384-dimensional vector for all-MiniLM-L6-v2.
    pub async fn embed(&self, text: &str) -> Result<Embedding> {
        // Check cache first
        if self.config.enable_cache {
            let cache = self.cache.read().await;
            if let Some(embedding) = cache.peek(text) {
                return Ok(embedding.clone());
            }
        }

        // Generate embedding
        let texts = vec![text.to_string()];
        let embeddings = self
            .model
            .embed(texts, None)
            .map_err(|e| Error::Search(format!("Embedding generation failed: {}", e)))?;

        let embedding = embeddings.into_iter().next().ok_or_else(|| {
            Error::Search("Embedding generation returned empty result".to_string())
        })?;

        // Store in cache
        if self.config.enable_cache {
            let mut cache = self.cache.write().await;
            cache.put(text.to_string(), embedding.clone());
        }

        Ok(embedding)
    }

    /// Generate embeddings for multiple texts in batch.
    ///
    /// More efficient than calling `embed()` multiple times.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Embedding>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        // Check which texts need embedding (not in cache)
        let mut results = vec![None; texts.len()];
        let mut texts_to_embed: Vec<(usize, String)> = vec![];

        if self.config.enable_cache {
            let cache = self.cache.read().await;
            for (i, text) in texts.iter().enumerate() {
                if let Some(embedding) = cache.peek(text) {
                    results[i] = Some(embedding.clone());
                } else {
                    texts_to_embed.push((i, text.clone()));
                }
            }
        } else {
            texts_to_embed = texts.iter().cloned().enumerate().collect();
        }

        // Generate embeddings for non-cached texts
        if !texts_to_embed.is_empty() {
            let batch_texts: Vec<String> = texts_to_embed.iter().map(|(_, t)| t.clone()).collect();
            let embeddings = self
                .model
                .embed(batch_texts, None)
                .map_err(|e| Error::Search(format!("Batch embedding failed: {}", e)))?;

            // Store in cache and fill results
            if self.config.enable_cache {
                let mut cache = self.cache.write().await;
                for ((idx, text), embedding) in texts_to_embed.into_iter().zip(embeddings) {
                    cache.put(text, embedding.clone());
                    results[idx] = Some(embedding);
                }
            } else {
                for ((idx, _), embedding) in texts_to_embed.into_iter().zip(embeddings) {
                    results[idx] = Some(embedding);
                }
            }
        }

        // All results should now be Some
        results
            .into_iter()
            .map(|opt| opt.ok_or_else(|| Error::Search("Missing embedding in result".to_string())))
            .collect()
    }

    /// Get the embedding dimension (384 for all-MiniLM-L6-v2).
    pub fn dimension(&self) -> usize {
        match self.config.model.as_str() {
            "all-MiniLM-L6-v2" => 384,
            "BGESmallENV15" => 384,
            "BGEBaseENV15" => 768,
            _ => 384, // Default
        }
    }

    /// Calculate cosine similarity between two embeddings.
    pub fn cosine_similarity(a: &Embedding, b: &Embedding) -> f32 {
        if a.len() != b.len() {
            return 0.0;
        }

        let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }

        dot_product / (norm_a * norm_b)
    }

    /// Create text for embedding from a capability card.
    ///
    /// Combines name, description, and capabilities into a single text
    /// suitable for semantic embedding.
    pub fn card_to_text(name: &str, description: &str, capabilities: &[String]) -> String {
        let caps = capabilities.join(", ");
        format!("{}: {}. Capabilities: {}", name, description, caps)
    }

    /// Get cache statistics.
    pub async fn cache_stats(&self) -> (usize, usize) {
        let cache = self.cache.read().await;
        (cache.len(), cache.cap().get())
    }

    /// Clear the embedding cache.
    pub async fn clear_cache(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to get an embedding service if available.
    /// Returns None if the model can't be loaded (e.g., in CI without model).
    fn try_get_service() -> Option<EmbeddingService> {
        EmbeddingService::new().ok()
    }

    // ========== TDD Tests: EmbeddingService creation ==========

    #[tokio::test]
    async fn test_embedding_service_creates_with_default_config() {
        // This test may take time on first run (model download)
        // Skip if model not available (CI environment)
        let service = EmbeddingService::new();
        if service.is_err() {
            eprintln!("Skipping: model not available in this environment");
            return;
        }
        assert!(service.is_ok());
    }

    #[tokio::test]
    async fn test_embedding_service_dimension_is_384_for_default_model() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };
        assert_eq!(service.dimension(), 384);
    }

    // ========== TDD Tests: embed() ==========

    #[tokio::test]
    async fn test_embed_returns_vector_of_correct_dimension() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let embedding = service.embed("Hello world").await;

        assert!(
            embedding.is_ok(),
            "Embedding should succeed: {:?}",
            embedding.err()
        );
        assert_eq!(embedding.unwrap().len(), 384);
    }

    #[tokio::test]
    async fn test_embed_returns_deterministic_results() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let text = "AI agent for code review";
        let emb1 = service.embed(text).await.expect("First embedding");
        let emb2 = service.embed(text).await.expect("Second embedding");

        // Embeddings should be identical (deterministic)
        assert_eq!(emb1, emb2, "Same text should produce same embedding");
    }

    #[tokio::test]
    async fn test_embed_produces_different_vectors_for_different_texts() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let emb1 = service
            .embed("Code review agent")
            .await
            .expect("First embedding");
        let emb2 = service
            .embed("Translation service")
            .await
            .expect("Second embedding");

        // Embeddings should be different
        assert_ne!(
            emb1, emb2,
            "Different texts should produce different embeddings"
        );
    }

    #[tokio::test]
    async fn test_embed_handles_empty_string() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let embedding = service.embed("").await;

        assert!(
            embedding.is_ok(),
            "Empty string should still produce embedding"
        );
        assert_eq!(embedding.unwrap().len(), 384);
    }

    #[tokio::test]
    async fn test_embed_handles_unicode() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let embedding = service.embed("AI代理人 🤖 для перевода").await;

        assert!(
            embedding.is_ok(),
            "Unicode text should work: {:?}",
            embedding.err()
        );
        assert_eq!(embedding.unwrap().len(), 384);
    }

    // ========== TDD Tests: embed_batch() ==========

    #[tokio::test]
    async fn test_embed_batch_returns_correct_number_of_embeddings() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };
        let texts = vec![
            "Agent one".to_string(),
            "Agent two".to_string(),
            "Agent three".to_string(),
        ];

        let embeddings = service.embed_batch(&texts).await;

        assert!(
            embeddings.is_ok(),
            "Batch should succeed: {:?}",
            embeddings.err()
        );
        assert_eq!(embeddings.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn test_embed_batch_handles_empty_input() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };
        let texts: Vec<String> = vec![];

        let embeddings = service.embed_batch(&texts).await;

        assert!(embeddings.is_ok());
        assert!(embeddings.unwrap().is_empty());
    }

    // ========== TDD Tests: cosine_similarity() ==========

    #[tokio::test]
    async fn test_cosine_similarity_identical_vectors_returns_one() {
        let vec1 = vec![1.0, 2.0, 3.0];
        let vec2 = vec![1.0, 2.0, 3.0];

        let similarity = EmbeddingService::cosine_similarity(&vec1, &vec2);

        assert!(
            (similarity - 1.0).abs() < 0.0001,
            "Identical vectors should have similarity 1.0"
        );
    }

    #[tokio::test]
    async fn test_cosine_similarity_orthogonal_vectors_returns_zero() {
        let vec1 = vec![1.0, 0.0, 0.0];
        let vec2 = vec![0.0, 1.0, 0.0];

        let similarity = EmbeddingService::cosine_similarity(&vec1, &vec2);

        assert!(
            similarity.abs() < 0.0001,
            "Orthogonal vectors should have similarity 0.0"
        );
    }

    #[tokio::test]
    async fn test_cosine_similarity_opposite_vectors_returns_negative_one() {
        let vec1 = vec![1.0, 2.0, 3.0];
        let vec2 = vec![-1.0, -2.0, -3.0];

        let similarity = EmbeddingService::cosine_similarity(&vec1, &vec2);

        assert!(
            (similarity + 1.0).abs() < 0.0001,
            "Opposite vectors should have similarity -1.0"
        );
    }

    #[tokio::test]
    async fn test_cosine_similarity_similar_texts_have_high_score() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        let emb1 = service
            .embed("AI code review agent")
            .await
            .expect("First embedding");
        let emb2 = service
            .embed("Code analysis AI assistant")
            .await
            .expect("Second embedding");
        let emb3 = service
            .embed("Weather forecast service")
            .await
            .expect("Third embedding");

        let sim_similar = EmbeddingService::cosine_similarity(&emb1, &emb2);
        let sim_different = EmbeddingService::cosine_similarity(&emb1, &emb3);

        assert!(
            sim_similar > sim_different,
            "Similar texts should have higher similarity ({} vs {})",
            sim_similar,
            sim_different
        );
    }

    // ========== TDD Tests: card_to_text() ==========

    #[test]
    fn test_card_to_text_combines_fields() {
        let text = EmbeddingService::card_to_text(
            "CodeReviewer",
            "AI-powered code review",
            &["review".to_string(), "analyze".to_string()],
        );

        assert!(text.contains("CodeReviewer"));
        assert!(text.contains("AI-powered code review"));
        assert!(text.contains("review"));
        assert!(text.contains("analyze"));
    }

    #[test]
    fn test_card_to_text_handles_empty_capabilities() {
        let text = EmbeddingService::card_to_text("Agent", "Description", &[]);

        assert!(text.contains("Agent"));
        assert!(text.contains("Description"));
    }

    // ========== TDD Tests: caching ==========

    #[tokio::test]
    async fn test_cache_stores_embeddings() {
        let config = EmbeddingServiceConfig {
            enable_cache: true,
            max_cache_size: 100,
            ..Default::default()
        };
        let Ok(service) = EmbeddingService::with_config(config) else {
            eprintln!("Skipping: model not available");
            return;
        };

        // Embed text - should be cached
        let _ = service.embed("test text").await;

        let (size, _) = service.cache_stats().await;
        assert!(size > 0, "Cache should have entries");
    }

    #[tokio::test]
    async fn test_cache_clear_removes_entries() {
        let Some(service) = try_get_service() else {
            eprintln!("Skipping: model not available");
            return;
        };

        // Embed some texts
        let _ = service.embed("text1").await;
        let _ = service.embed("text2").await;

        // Clear cache
        service.clear_cache().await;

        let (size, _) = service.cache_stats().await;
        assert_eq!(size, 0, "Cache should be empty after clear");
    }

    #[tokio::test]
    async fn test_disabled_cache_does_not_store() {
        let config = EmbeddingServiceConfig {
            enable_cache: false,
            ..Default::default()
        };
        let Ok(service) = EmbeddingService::with_config(config) else {
            eprintln!("Skipping: model not available");
            return;
        };

        let _ = service.embed("test text").await;

        let (size, _) = service.cache_stats().await;
        assert_eq!(size, 0, "Cache should be empty when disabled");
    }
}
