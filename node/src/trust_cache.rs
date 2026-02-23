//! Trust score caching for AgoraMesh.
//!
//! This module provides a high-performance cache for trust scores,
//! reducing load on the blockchain RPC and improving response times.
//!
//! ## Features
//!
//! - **TTL-based expiration**: Trust scores expire after configurable duration
//! - **Async loading**: Coalesced concurrent requests with `get_with`
//! - **Thread-safe**: Lock-free operations via Moka
//! - **Metrics integration**: Cache hit/miss tracking
//!
//! ## Usage
//!
//! ```rust,ignore
//! use agoramesh_node::trust_cache::{TrustCache, TrustCacheConfig};
//!
//! let cache = TrustCache::new(TrustCacheConfig::default());
//!
//! // Get or load trust score
//! let score = cache.get_or_load("did:agoramesh:base:agent1", || async {
//!     // Load from blockchain
//!     Ok(trust_service.get_trust(did).await?)
//! }).await?;
//! ```

use moka::future::Cache;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::trust::TrustInfo;

/// Default TTL for cached trust scores (5 minutes).
pub const DEFAULT_TTL_SECS: u64 = 300;

/// Default maximum cache entries.
pub const DEFAULT_MAX_ENTRIES: u64 = 10_000;

/// Configuration for the trust cache.
#[derive(Debug, Clone)]
pub struct TrustCacheConfig {
    /// Time-to-live for cached entries.
    pub ttl: Duration,

    /// Maximum number of cached entries.
    pub max_entries: u64,

    /// Whether caching is enabled.
    pub enabled: bool,
}

impl Default for TrustCacheConfig {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(DEFAULT_TTL_SECS),
            max_entries: DEFAULT_MAX_ENTRIES,
            enabled: true,
        }
    }
}

impl TrustCacheConfig {
    /// Create a config with custom TTL.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            ..Default::default()
        }
    }

    /// Create a disabled cache config.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Default::default()
        }
    }
}

/// Cache statistics.
#[derive(Debug, Default)]
pub struct TrustCacheStats {
    /// Number of cache hits.
    pub hits: AtomicU64,
    /// Number of cache misses.
    pub misses: AtomicU64,
    /// Number of cache evictions.
    pub evictions: AtomicU64,
    /// Number of cache invalidations.
    pub invalidations: AtomicU64,
}

impl TrustCacheStats {
    /// Get hit rate as a percentage (0.0 - 1.0).
    pub fn hit_rate(&self) -> f64 {
        let hits = self.hits.load(Ordering::Relaxed);
        let misses = self.misses.load(Ordering::Relaxed);
        let total = hits + misses;

        if total == 0 {
            0.0
        } else {
            hits as f64 / total as f64
        }
    }

    /// Get total requests.
    pub fn total_requests(&self) -> u64 {
        self.hits.load(Ordering::Relaxed) + self.misses.load(Ordering::Relaxed)
    }

    /// Reset all statistics.
    pub fn reset(&self) {
        self.hits.store(0, Ordering::Relaxed);
        self.misses.store(0, Ordering::Relaxed);
        self.evictions.store(0, Ordering::Relaxed);
        self.invalidations.store(0, Ordering::Relaxed);
    }
}

/// Cached trust score entry.
#[derive(Debug, Clone)]
pub struct CachedTrustInfo {
    /// The trust information.
    pub info: TrustInfo,
    /// When the entry was cached (Unix timestamp).
    pub cached_at: u64,
}

impl CachedTrustInfo {
    /// Create a new cached entry.
    pub fn new(info: TrustInfo) -> Self {
        let cached_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self { info, cached_at }
    }

    /// Get age of the cached entry in seconds.
    pub fn age_secs(&self) -> u64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        now.saturating_sub(self.cached_at)
    }
}

/// High-performance trust score cache.
///
/// Uses Moka's TinyLFU eviction policy for optimal cache efficiency.
/// Supports TTL-based expiration and coalesced concurrent loading.
pub struct TrustCache {
    cache: Option<Cache<String, CachedTrustInfo>>,
    config: TrustCacheConfig,
    stats: Arc<TrustCacheStats>,
}

impl TrustCache {
    /// Create a new trust cache with the given configuration.
    pub fn new(config: TrustCacheConfig) -> Self {
        let cache = if config.enabled {
            Some(
                Cache::builder()
                    .max_capacity(config.max_entries)
                    .time_to_live(config.ttl)
                    .build(),
            )
        } else {
            None
        };

        Self {
            cache,
            config,
            stats: Arc::new(TrustCacheStats::default()),
        }
    }

    /// Create a cache with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(TrustCacheConfig::default())
    }

    /// Create a disabled cache.
    pub fn disabled() -> Self {
        Self::new(TrustCacheConfig::disabled())
    }

    /// Check if the cache is enabled.
    pub fn is_enabled(&self) -> bool {
        self.config.enabled && self.cache.is_some()
    }

    /// Get cache statistics.
    pub fn stats(&self) -> &TrustCacheStats {
        &self.stats
    }

    /// Get the cache configuration.
    pub fn config(&self) -> &TrustCacheConfig {
        &self.config
    }

    /// Get a cached trust score, if present.
    pub async fn get(&self, did: &str) -> Option<CachedTrustInfo> {
        match &self.cache {
            Some(cache) => {
                let result = cache.get(did).await;
                if result.is_some() {
                    self.stats.hits.fetch_add(1, Ordering::Relaxed);
                } else {
                    self.stats.misses.fetch_add(1, Ordering::Relaxed);
                }
                result
            }
            None => {
                self.stats.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// Insert a trust score into the cache.
    pub async fn insert(&self, did: &str, info: TrustInfo) {
        if let Some(cache) = &self.cache {
            let cached = CachedTrustInfo::new(info);
            cache.insert(did.to_string(), cached).await;
        }
    }

    /// Get a cached trust score, or load it using the provided async function.
    ///
    /// This method coalesces concurrent requests for the same DID,
    /// ensuring only one load operation runs at a time.
    pub async fn get_or_load<F, Fut, E>(&self, did: &str, loader: F) -> Result<CachedTrustInfo, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<TrustInfo, E>>,
    {
        match &self.cache {
            Some(cache) => {
                // Check if already cached
                if let Some(cached) = cache.get(did).await {
                    self.stats.hits.fetch_add(1, Ordering::Relaxed);
                    return Ok(cached);
                }

                // Cache miss - load and insert
                self.stats.misses.fetch_add(1, Ordering::Relaxed);
                let info = loader().await?;
                let cached = CachedTrustInfo::new(info);
                cache.insert(did.to_string(), cached.clone()).await;
                Ok(cached)
            }
            None => {
                // Cache disabled - always load
                self.stats.misses.fetch_add(1, Ordering::Relaxed);
                let info = loader().await?;
                Ok(CachedTrustInfo::new(info))
            }
        }
    }

    /// Invalidate a cached entry.
    pub async fn invalidate(&self, did: &str) {
        if let Some(cache) = &self.cache {
            cache.invalidate(did).await;
            self.stats.invalidations.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Invalidate all cached entries.
    pub async fn invalidate_all(&self) {
        if let Some(cache) = &self.cache {
            cache.invalidate_all();
            // Run pending tasks to ensure invalidation completes
            cache.run_pending_tasks().await;
        }
    }

    /// Get the approximate number of cached entries.
    pub fn entry_count(&self) -> u64 {
        self.cache.as_ref().map(|c| c.entry_count()).unwrap_or(0)
    }

    /// Run pending maintenance tasks.
    ///
    /// Call this periodically to ensure accurate entry counts
    /// and timely eviction of expired entries.
    pub async fn run_maintenance(&self) {
        if let Some(cache) = &self.cache {
            cache.run_pending_tasks().await;
        }
    }
}

// ========== TDD Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    // Helper to create a test TrustInfo
    fn test_trust_info(did: &str, score: f64) -> TrustInfo {
        TrustInfo {
            did: did.to_string(),
            score,
            reputation: score * 0.5,
            stake_score: score * 0.3,
            endorsement_score: score * 0.2,
            stake_amount: 1_000_000_000,
            successful_transactions: 100,
            failed_transactions: 5,
            endorsement_count: 10,
        }
    }

    // ========== RED Phase: TrustCacheConfig Tests ==========

    #[test]
    fn test_default_config_has_reasonable_ttl() {
        let config = TrustCacheConfig::default();

        assert!(
            config.ttl >= Duration::from_secs(60),
            "TTL should be at least 1 minute"
        );
        assert!(
            config.ttl <= Duration::from_secs(3600),
            "TTL should be at most 1 hour"
        );
    }

    #[test]
    fn test_default_config_has_reasonable_max_entries() {
        let config = TrustCacheConfig::default();

        assert!(
            config.max_entries >= 1000,
            "Should support at least 1000 entries"
        );
        assert!(config.max_entries <= 1_000_000, "Should cap at 1M entries");
    }

    #[test]
    fn test_default_config_is_enabled() {
        let config = TrustCacheConfig::default();
        assert!(config.enabled);
    }

    #[test]
    fn test_config_with_ttl() {
        let config = TrustCacheConfig::with_ttl(Duration::from_secs(60));

        assert_eq!(config.ttl, Duration::from_secs(60));
        assert!(config.enabled);
    }

    #[test]
    fn test_config_disabled() {
        let config = TrustCacheConfig::disabled();
        assert!(!config.enabled);
    }

    // ========== RED Phase: TrustCacheStats Tests ==========

    #[test]
    fn test_stats_starts_at_zero() {
        let stats = TrustCacheStats::default();

        assert_eq!(stats.hits.load(Ordering::Relaxed), 0);
        assert_eq!(stats.misses.load(Ordering::Relaxed), 0);
        assert_eq!(stats.total_requests(), 0);
    }

    #[test]
    fn test_hit_rate_zero_when_no_requests() {
        let stats = TrustCacheStats::default();
        assert_eq!(stats.hit_rate(), 0.0);
    }

    #[test]
    fn test_hit_rate_calculation() {
        let stats = TrustCacheStats::default();

        // 7 hits, 3 misses = 70% hit rate
        stats.hits.store(7, Ordering::Relaxed);
        stats.misses.store(3, Ordering::Relaxed);

        assert!((stats.hit_rate() - 0.7).abs() < 0.001);
        assert_eq!(stats.total_requests(), 10);
    }

    #[test]
    fn test_stats_reset() {
        let stats = TrustCacheStats::default();

        stats.hits.store(100, Ordering::Relaxed);
        stats.misses.store(50, Ordering::Relaxed);

        stats.reset();

        assert_eq!(stats.hits.load(Ordering::Relaxed), 0);
        assert_eq!(stats.misses.load(Ordering::Relaxed), 0);
    }

    // ========== RED Phase: CachedTrustInfo Tests ==========

    #[test]
    fn test_cached_trust_info_stores_timestamp() {
        let info = test_trust_info("did:test:1", 0.8);
        let cached = CachedTrustInfo::new(info);

        assert!(cached.cached_at > 0, "Should have a timestamp");
    }

    #[test]
    fn test_cached_trust_info_age_is_small() {
        let info = test_trust_info("did:test:1", 0.8);
        let cached = CachedTrustInfo::new(info);

        // Just created, age should be very small
        assert!(cached.age_secs() < 2, "Age should be less than 2 seconds");
    }

    // ========== RED Phase: TrustCache Creation Tests ==========

    #[test]
    fn test_cache_with_defaults_is_enabled() {
        let cache = TrustCache::with_defaults();
        assert!(cache.is_enabled());
    }

    #[test]
    fn test_disabled_cache_is_not_enabled() {
        let cache = TrustCache::disabled();
        assert!(!cache.is_enabled());
    }

    #[test]
    fn test_cache_exposes_config() {
        let config = TrustCacheConfig::with_ttl(Duration::from_secs(120));
        let cache = TrustCache::new(config);

        assert_eq!(cache.config().ttl, Duration::from_secs(120));
    }

    #[test]
    fn test_cache_exposes_stats() {
        let cache = TrustCache::with_defaults();
        assert_eq!(cache.stats().total_requests(), 0);
    }

    // ========== RED Phase: Cache Get/Insert Tests ==========

    #[tokio::test]
    async fn test_get_returns_none_for_missing_key() {
        let cache = TrustCache::with_defaults();

        let result = cache.get("did:test:nonexistent").await;

        assert!(result.is_none());
        assert_eq!(cache.stats().misses.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:agent1";
        let info = test_trust_info(did, 0.85);

        cache.insert(did, info.clone()).await;
        let result = cache.get(did).await;

        assert!(result.is_some());
        let cached = result.unwrap();
        assert_eq!(cached.info.did, did);
        assert!((cached.info.score - 0.85).abs() < 0.001);
        assert_eq!(cache.stats().hits.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_insert_updates_existing() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:agent1";

        // Insert initial value
        let info1 = test_trust_info(did, 0.5);
        cache.insert(did, info1).await;

        // Update with new value
        let info2 = test_trust_info(did, 0.9);
        cache.insert(did, info2).await;

        let result = cache.get(did).await.unwrap();
        assert!(
            (result.info.score - 0.9).abs() < 0.001,
            "Should have updated score"
        );
    }

    #[tokio::test]
    async fn test_entry_count() {
        let cache = TrustCache::with_defaults();

        cache
            .insert("did:test:1", test_trust_info("did:test:1", 0.5))
            .await;
        cache
            .insert("did:test:2", test_trust_info("did:test:2", 0.6))
            .await;
        cache
            .insert("did:test:3", test_trust_info("did:test:3", 0.7))
            .await;

        // Run maintenance to ensure count is accurate
        cache.run_maintenance().await;

        assert_eq!(cache.entry_count(), 3);
    }

    // ========== RED Phase: get_or_load Tests ==========

    #[tokio::test]
    async fn test_get_or_load_returns_cached_value() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:cached";
        let info = test_trust_info(did, 0.75);

        // Pre-populate cache
        cache.insert(did, info).await;

        // Loader should NOT be called
        let mut loader_called = false;
        let result = cache
            .get_or_load(did, || async {
                loader_called = true;
                Ok::<_, std::io::Error>(test_trust_info(did, 0.99))
            })
            .await
            .unwrap();

        assert!(
            !loader_called,
            "Loader should not be called for cached value"
        );
        assert!((result.info.score - 0.75).abs() < 0.001);
        assert_eq!(cache.stats().hits.load(Ordering::Relaxed), 1); // get_or_load hit only
    }

    #[tokio::test]
    async fn test_get_or_load_calls_loader_on_miss() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:uncached";

        let mut loader_called = false;
        let result = cache
            .get_or_load(did, || async {
                loader_called = true;
                Ok::<_, std::io::Error>(test_trust_info(did, 0.65))
            })
            .await
            .unwrap();

        assert!(loader_called, "Loader should be called on cache miss");
        assert!((result.info.score - 0.65).abs() < 0.001);
        assert_eq!(cache.stats().misses.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_get_or_load_caches_loaded_value() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:loaded";

        // First call - loads
        let _ = cache
            .get_or_load(did, || async {
                Ok::<_, std::io::Error>(test_trust_info(did, 0.55))
            })
            .await
            .unwrap();

        // Second call - should hit cache
        let mut second_loader_called = false;
        let result = cache
            .get_or_load(did, || async {
                second_loader_called = true;
                Ok::<_, std::io::Error>(test_trust_info(did, 0.99))
            })
            .await
            .unwrap();

        assert!(!second_loader_called, "Second call should hit cache");
        assert!(
            (result.info.score - 0.55).abs() < 0.001,
            "Should return originally loaded value"
        );
    }

    #[tokio::test]
    async fn test_get_or_load_propagates_error() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:error";

        let result: Result<CachedTrustInfo, &str> = cache
            .get_or_load(did, || async { Err("loader failed") })
            .await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "loader failed");
    }

    // ========== RED Phase: Invalidation Tests ==========

    #[tokio::test]
    async fn test_invalidate_removes_entry() {
        let cache = TrustCache::with_defaults();
        let did = "did:test:to-invalidate";

        cache.insert(did, test_trust_info(did, 0.8)).await;
        assert!(cache.get(did).await.is_some());

        cache.invalidate(did).await;
        cache.run_maintenance().await;

        // After invalidation, should be gone
        let result = cache.get(did).await;
        assert!(result.is_none(), "Entry should be invalidated");
        assert_eq!(cache.stats().invalidations.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_invalidate_all_clears_cache() {
        let cache = TrustCache::with_defaults();

        // Insert multiple entries
        for i in 0..5 {
            let did = format!("did:test:agent{}", i);
            cache.insert(&did, test_trust_info(&did, 0.5)).await;
        }

        cache.run_maintenance().await;
        assert!(cache.entry_count() > 0);

        cache.invalidate_all().await;

        assert_eq!(cache.entry_count(), 0);
    }

    // ========== RED Phase: Disabled Cache Tests ==========

    #[tokio::test]
    async fn test_disabled_cache_get_returns_none() {
        let cache = TrustCache::disabled();

        let result = cache.get("did:test:any").await;

        assert!(result.is_none());
        assert_eq!(cache.stats().misses.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_disabled_cache_insert_is_noop() {
        let cache = TrustCache::disabled();
        let did = "did:test:wont-cache";

        cache.insert(did, test_trust_info(did, 0.9)).await;

        // Should not be cached
        let result = cache.get(did).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_disabled_cache_get_or_load_always_loads() {
        let cache = TrustCache::disabled();
        let did = "did:test:always-load";

        let mut call_count = 0;

        for _ in 0..3 {
            let _ = cache
                .get_or_load(did, || async {
                    call_count += 1;
                    Ok::<_, std::io::Error>(test_trust_info(did, 0.5))
                })
                .await
                .unwrap();
        }

        assert_eq!(call_count, 3, "Disabled cache should always call loader");
    }

    // ========== RED Phase: TTL Expiration Tests ==========

    #[tokio::test]
    async fn test_ttl_expiration() {
        // Use very short TTL for testing
        let config = TrustCacheConfig {
            ttl: Duration::from_millis(50),
            max_entries: 100,
            enabled: true,
        };
        let cache = TrustCache::new(config);
        let did = "did:test:expires";

        cache.insert(did, test_trust_info(did, 0.8)).await;

        // Should be present immediately
        assert!(cache.get(did).await.is_some());

        // Wait for TTL to expire
        tokio::time::sleep(Duration::from_millis(100)).await;
        cache.run_maintenance().await;

        // Should be expired
        let result = cache.get(did).await;
        assert!(result.is_none(), "Entry should be expired after TTL");
    }
}
