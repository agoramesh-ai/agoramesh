//! AgentMesh Node Library
//!
//! This crate provides the core functionality for running an AgentMesh node,
//! including P2P networking, agent discovery, trust management, and HTTP API.

pub mod api;
pub mod arbitration;
pub mod circuit_breaker;
pub mod config;
pub mod contract;
pub mod did;
pub mod discovery;
pub mod error;
pub mod events;
pub mod metrics;
pub mod multichain;
pub mod network;
pub mod persistence;
pub mod plugin;
pub mod rate_limit;
pub mod search;
pub mod trust;
pub mod trust_cache;

pub use api::{ApiServer, AppState, NodeInfo};
pub use arbitration::{
    determine_tier, AIArbitrationConfig, AIArbitrationStats, AIArbitrator, AIDispute,
    AIDisputeState, AIRuling, AppealPeriod, DisputeStatus, DisputeTier, Evidence, EvidenceType,
    Juror, JurorPool, JurorPoolConfig, JurorPoolStats, JurorStatus, JurorVote, KlerosClient,
    KlerosConfig, KlerosDispute, KlerosStats, Ruling, VotingSession, VotingState, TIER_1_MAX_USDC,
    TIER_2_MAX_USDC, TIER_3_MIN_USDC,
};
pub use circuit_breaker::{
    CircuitBreaker, CircuitBreakerConfig, CircuitError, CircuitMetrics, CircuitOpenError,
    CircuitResult, CircuitState, DegradationStrategy, DegradedResult, ResilientCircuitBreaker,
};
pub use config::{ApiConfig, NetworkConfig, NodeConfig};
pub use contract::TrustRegistryClient;
pub use discovery::DiscoveryService;
pub use error::{Error, Result};
pub use events::{
    ContractEvent, EventListener, EventListenerConfig, EventListenerStats, ReconnectConfig,
};
pub use metrics::{
    metrics_middleware, InFlightGuard, MetricNames, MetricsConfig, MetricsService, Timer,
};
pub use multichain::{ChainConfig, ChainInfo, MultiChainClient, MultiChainConfig};
pub use network::{validate_network_config, NetworkEvent, NetworkManager, SwarmCommand};
pub use persistence::{PersistenceConfig, PersistenceManager};
pub use rate_limit::{
    headers as rate_limit_headers, RateLimitConfig, RateLimitLayer, RateLimitResult,
    RateLimitService,
};
pub use search::{
    EmbeddingService, EmbeddingServiceConfig, HybridSearch, HybridSearchConfig, SearchResult,
};
pub use trust::TrustService;
pub use trust_cache::{CachedTrustInfo, TrustCache, TrustCacheConfig, TrustCacheStats};
