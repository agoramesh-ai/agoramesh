//! HTTP API for the AgentMesh node.
//!
//! This module provides:
//! - Health check endpoint
//! - Agent discovery endpoints
//! - Trust query endpoints
//! - A2A protocol endpoints

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::config::ApiConfig;
use crate::discovery::{CapabilityCard, DiscoveryService};
use crate::error::Result;
use crate::metrics::{MetricsConfig, MetricsService};
use crate::rate_limit::{RateLimitConfig, RateLimitLayer, RateLimitService};
use crate::search::HybridSearch;
use crate::trust::{TrustInfo, TrustService};

/// Health check response.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    /// Node status.
    pub status: String,

    /// Node version.
    pub version: String,

    /// Number of connected peers.
    pub peers: u64,

    /// Node uptime in seconds.
    pub uptime: u64,
}

/// Node identity and configuration info.
#[derive(Debug, Clone)]
pub struct NodeInfo {
    /// Node name.
    pub name: String,
    /// Node description.
    pub description: String,
    /// Node's public URL.
    pub url: String,
    /// Node's DID.
    pub did: String,
}

/// Shared application state for API handlers.
#[derive(Clone)]
pub struct AppState {
    /// Discovery service for agent lookup.
    pub discovery: Arc<DiscoveryService>,
    /// Trust service for trust verification.
    pub trust: Arc<TrustService>,
    /// Node start time for uptime calculation.
    pub start_time: Instant,
    /// Number of connected peers (shared with NetworkManager).
    pub peer_count: Arc<AtomicU64>,
    /// Optional node info for capability card.
    pub node_info: Option<NodeInfo>,
    /// Rate limiting service.
    pub rate_limiter: Arc<RateLimitService>,
    /// Metrics service for observability.
    pub metrics: Arc<MetricsService>,
    /// Optional semantic search service.
    pub hybrid_search: Option<Arc<RwLock<HybridSearch>>>,
    /// Optional admin token for agent registration.
    pub api_token: Option<String>,
}

/// Semantic search result with scores.
#[derive(Debug, Serialize, Deserialize)]
pub struct SemanticSearchResult {
    /// Agent DID.
    pub did: String,
    /// Combined hybrid score (0.0 - 1.0).
    pub score: f32,
    /// Vector similarity score.
    pub vector_score: f32,
    /// Keyword match score.
    pub keyword_score: f32,
    /// The capability card.
    pub card: CapabilityCard,
}

/// API server.
pub struct ApiServer {
    /// API configuration.
    config: ApiConfig,
    /// Shared application state.
    state: AppState,
}

/// Query parameters for agent search.
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    /// Search query string.
    pub q: Option<String>,
}

/// API error response.
#[derive(Debug, Serialize, Deserialize)]
pub struct ApiError {
    /// Error message.
    pub error: String,
}

impl ApiServer {
    /// Create a new API server.
    pub fn new(config: ApiConfig) -> Self {
        let api_token = normalize_api_token(config.admin_token.clone());
        let state = AppState {
            discovery: Arc::new(DiscoveryService::new()),
            trust: Arc::new(TrustService::new(
                "https://sepolia.base.org".to_string(),
                None,
            )),
            start_time: Instant::now(),
            peer_count: Arc::new(AtomicU64::new(0)),
            node_info: None,
            rate_limiter: Arc::new(RateLimitService::new(RateLimitConfig::default())),
            metrics: Arc::new(MetricsService::new(MetricsConfig::default())),
            hybrid_search: None,
            api_token,
        };
        Self { config, state }
    }

    /// Create a new API server with custom state.
    pub fn with_state(config: ApiConfig, state: AppState) -> Self {
        let mut state = state;
        if state.api_token.is_none() {
            state.api_token = normalize_api_token(config.admin_token.clone());
        }
        Self { config, state }
    }

    /// Build the router with all routes.
    pub fn router(&self) -> Router {
        // Create rate limit layer
        let rate_limit_layer = RateLimitLayer::new(self.state.rate_limiter.clone())
            .with_trust_proxy(self.config.trust_proxy);

        // Routes that are rate limited (API endpoints)
        // Note: /agents/semantic must come BEFORE /agents/{did} to avoid being captured
        let rate_limited_routes = Router::new()
            .route(
                "/agents",
                get(search_agents_handler).post(register_agent_handler),
            )
            .route("/agents/semantic", get(semantic_search_handler))
            .route("/agents/{did}", get(get_agent_handler))
            .route("/trust/{did}", get(get_trust_handler))
            .layer(rate_limit_layer);

        // Routes that are NOT rate limited (health checks, metadata, metrics)
        let unrestricted_routes = Router::new()
            .route("/health", get(health_handler))
            .route("/metrics", get(metrics_handler))
            .route("/.well-known/agent.json", get(agent_card_handler));

        // Combine all routes
        let mut router = Router::new()
            .merge(unrestricted_routes)
            .merge(rate_limited_routes)
            .with_state(self.state.clone());

        if let Some(cors_layer) = build_cors_layer(&self.config) {
            router = router.layer(cors_layer);
        }

        router
    }

    /// Start the API server.
    pub async fn run(&self, listen_addr: &str) -> Result<()> {
        let router = self.router();

        let listener = tokio::net::TcpListener::bind(listen_addr)
            .await
            .map_err(|e| crate::error::Error::Api(e.to_string()))?;

        tracing::info!("API server listening on {}", listen_addr);

        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .map_err(|e| crate::error::Error::Api(e.to_string()))?;

        Ok(())
    }
}

fn normalize_api_token(token: Option<String>) -> Option<String> {
    token.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn build_cors_layer(config: &ApiConfig) -> Option<CorsLayer> {
    if !config.cors_enabled {
        return None;
    }

    let mut cors = CorsLayer::new();
    if config.cors_origins.iter().any(|origin| origin == "*") {
        cors = cors.allow_origin(Any);
    } else if !config.cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = config
            .cors_origins
            .iter()
            .filter_map(|origin| origin.parse::<HeaderValue>().ok())
            .collect();
        if !origins.is_empty() {
            cors = cors.allow_origin(AllowOrigin::list(origins));
        }
    }

    cors = cors.allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS]);

    cors = cors.allow_headers([
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        HeaderName::from_static("x-api-key"),
    ]);

    Some(cors)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    if a.len() != b.len() {
        // Length mismatch leaks length info, but this is unavoidable and
        // standard practice (same as crypto::timingSafeEqual in Node.js).
        return false;
    }
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn is_admin_request(headers: &HeaderMap, token: &str) -> bool {
    if let Some(auth_header) = headers.get(header::AUTHORIZATION) {
        if let Ok(auth_header) = auth_header.to_str() {
            let bearer_token = auth_header
                .strip_prefix("Bearer ")
                .or_else(|| auth_header.strip_prefix("bearer "));
            if let Some(candidate) = bearer_token {
                if constant_time_eq(candidate, token) {
                    return true;
                }
            }
        }
    }

    if let Some(api_key) = headers.get("x-api-key") {
        if let Ok(api_key) = api_key.to_str() {
            if constant_time_eq(api_key, token) {
                return true;
            }
        }
    }

    false
}

/// Health check handler.
async fn health_handler(State(state): State<AppState>) -> Json<HealthResponse> {
    let uptime = state.start_time.elapsed().as_secs();
    let peers = state.peer_count.load(Ordering::Relaxed);

    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        peers,
        uptime,
    })
}

/// Prometheus metrics handler.
///
/// Returns metrics in Prometheus exposition format for scraping.
async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    use axum::http::header::CONTENT_TYPE;

    // Update P2P peer count in metrics
    let peers = state.peer_count.load(Ordering::Relaxed);
    state.metrics.p2p_peers(peers);

    // Render metrics in Prometheus format
    let body = state.metrics.render();

    (
        [(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

/// A2A Agent Card handler.
async fn agent_card_handler(State(state): State<AppState>) -> Json<CapabilityCard> {
    use crate::discovery::AgentMeshExtension;

    // Use node_info if available, otherwise defaults
    let (name, description, url, did) = match &state.node_info {
        Some(info) => (
            info.name.clone(),
            info.description.clone(),
            info.url.clone(),
            info.did.clone(),
        ),
        None => (
            "AgentMesh Node".to_string(),
            "AgentMesh P2P node".to_string(),
            "http://localhost:8080".to_string(),
            "did:agentmesh:base:unknown".to_string(),
        ),
    };

    Json(CapabilityCard {
        name,
        description,
        url,
        provider: None,
        capabilities: vec![],
        authentication: None,
        agentmesh: Some(AgentMeshExtension {
            did,
            trust_score: None,
            stake: None,
            pricing: None,
            payment_methods: vec!["x402".to_string()],
        }),
    })
}

/// Search agents handler.
async fn search_agents_handler(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> std::result::Result<Json<Vec<CapabilityCard>>, (StatusCode, Json<ApiError>)> {
    let query = params.q.unwrap_or_default();

    match state.discovery.search(&query).await {
        Ok(agents) => Ok(Json(agents)),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

/// Semantic search handler using HybridSearch (vector + keyword).
async fn semantic_search_handler(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> std::result::Result<Json<Vec<SemanticSearchResult>>, (StatusCode, Json<ApiError>)> {
    // Check if HybridSearch is configured
    let hybrid = match &state.hybrid_search {
        Some(h) => h,
        None => {
            return Err((
                StatusCode::NOT_IMPLEMENTED,
                Json(ApiError {
                    error: "Semantic search not available (HybridSearch not configured)"
                        .to_string(),
                }),
            ));
        }
    };

    let query = params.q.unwrap_or_default();
    if query.is_empty() {
        return Ok(Json(vec![]));
    }

    // Perform semantic search
    let hybrid_guard = hybrid.read().await;
    match hybrid_guard.search(&query).await {
        Ok(results) => {
            let response: Vec<SemanticSearchResult> = results
                .into_iter()
                .map(|r| SemanticSearchResult {
                    did: r.did,
                    score: r.score,
                    vector_score: r.vector_score,
                    keyword_score: r.keyword_score,
                    card: r.card,
                })
                .collect();
            Ok(Json(response))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

/// Get agent by DID handler.
async fn get_agent_handler(
    State(state): State<AppState>,
    Path(did): Path<String>,
) -> std::result::Result<Json<CapabilityCard>, (StatusCode, Json<ApiError>)> {
    // URL decode the DID (colons are encoded)
    let did = urlencoding::decode(&did)
        .map(|s| s.into_owned())
        .unwrap_or(did);

    match state.discovery.get(&did).await {
        Ok(Some(card)) => Ok(Json(card)),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Agent not found: {}", did),
            }),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

/// Register agent handler.
async fn register_agent_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(card): Json<CapabilityCard>,
) -> std::result::Result<(StatusCode, Json<serde_json::Value>), (StatusCode, Json<ApiError>)> {
    if let Some(token) = state.api_token.as_deref() {
        if !is_admin_request(&headers, token) {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(ApiError {
                    error: "Unauthorized".to_string(),
                }),
            ));
        }
    }

    match state.discovery.register(&card).await {
        Ok(()) => {
            let did = card
                .agentmesh
                .as_ref()
                .map(|a| a.did.clone())
                .unwrap_or_default();
            Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "message": "Agent registered successfully",
                    "did": did
                })),
            ))
        }
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

/// Get trust info handler.
async fn get_trust_handler(
    State(state): State<AppState>,
    Path(did): Path<String>,
) -> std::result::Result<Json<TrustInfo>, (StatusCode, Json<ApiError>)> {
    // URL decode the DID (colons are encoded)
    let did = urlencoding::decode(&did)
        .map(|s| s.into_owned())
        .unwrap_or(did);

    match state.trust.get_trust(&did).await {
        Ok(trust_info) => Ok(Json(trust_info)),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: e.to_string(),
            }),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{
        AgentMeshExtension, Capability, PricingInfo, PricingModel, ProviderInfo,
    };
    use axum_test::TestServer;

    fn test_state() -> AppState {
        AppState {
            discovery: Arc::new(DiscoveryService::new()),
            trust: Arc::new(TrustService::new(
                "https://sepolia.base.org".to_string(),
                None,
            )),
            start_time: Instant::now(),
            peer_count: Arc::new(AtomicU64::new(0)),
            node_info: None,
            // Use disabled rate limiter for tests by default
            rate_limiter: Arc::new(RateLimitService::disabled()),
            // Use disabled metrics for tests
            metrics: Arc::new(MetricsService::disabled()),
            // No hybrid search by default
            hybrid_search: None,
            api_token: None,
        }
    }

    fn test_server(state: AppState) -> TestServer {
        let config = ApiConfig {
            listen_address: "127.0.0.1:0".to_string(),
            cors_enabled: false,
            cors_origins: vec![],
            trust_proxy: false,
            admin_token: None,
        };
        let server = ApiServer::with_state(config, state);
        TestServer::new(server.router()).unwrap()
    }

    fn sample_capability_card(did: &str) -> CapabilityCard {
        CapabilityCard {
            name: "Test Agent".to_string(),
            description: "A test agent".to_string(),
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
            agentmesh: Some(AgentMeshExtension {
                did: did.to_string(),
                trust_score: Some(0.85),
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

    // ========== TDD Tests: GET /health ==========

    #[tokio::test]
    async fn test_health_endpoint_returns_ok() {
        let server = test_server(test_state());

        let response = server.get("/health").await;

        response.assert_status_ok();
        let health: HealthResponse = response.json();
        assert_eq!(health.status, "ok");
        assert!(!health.version.is_empty());
    }

    #[tokio::test]
    async fn test_health_endpoint_returns_uptime() {
        let state = test_state();
        let server = test_server(state);

        // Wait a bit to have non-zero uptime
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        let response = server.get("/health").await;

        response.assert_status_ok();
        let health: HealthResponse = response.json();
        // Uptime is returned as u64, so it's always non-negative
        // Just verify it's a reasonable value (not some garbage)
        assert!(
            health.uptime < 3600,
            "Uptime should be less than 1 hour in test"
        );
    }

    // ========== TDD Tests: GET /metrics ==========

    #[tokio::test]
    async fn test_metrics_endpoint_returns_ok() {
        let server = test_server(test_state());

        let response = server.get("/metrics").await;

        response.assert_status_ok();
    }

    #[tokio::test]
    async fn test_metrics_endpoint_has_correct_content_type() {
        let server = test_server(test_state());

        let response = server.get("/metrics").await;

        // Should have text/plain content type
        response.assert_header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    }

    #[tokio::test]
    async fn test_metrics_endpoint_is_not_rate_limited() {
        // Use a very restrictive rate limiter
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // Multiple requests should all succeed (metrics not rate limited)
        for _ in 0..5 {
            let response = server.get("/metrics").await;
            response.assert_status_ok();
        }
    }

    #[tokio::test]
    async fn test_health_endpoint_returns_peer_count() {
        let state = test_state();
        // Simulate 5 connected peers
        state
            .peer_count
            .store(5, std::sync::atomic::Ordering::SeqCst);

        let server = test_server(state);
        let response = server.get("/health").await;

        response.assert_status_ok();
        let health: HealthResponse = response.json();
        assert_eq!(health.peers, 5, "Should return peer count from state");
    }

    // ========== TDD Tests: GET /.well-known/agent.json ==========

    #[tokio::test]
    async fn test_agent_card_returns_valid_capability_card() {
        let mut state = test_state();
        state.node_info = Some(NodeInfo {
            name: "Test Node".to_string(),
            description: "A test AgentMesh node".to_string(),
            url: "http://localhost:8080".to_string(),
            did: "did:agentmesh:base:test-node".to_string(),
        });

        let server = test_server(state);
        let response = server.get("/.well-known/agent.json").await;

        response.assert_status_ok();
        let card: CapabilityCard = response.json();
        assert_eq!(card.name, "Test Node");
        assert_eq!(card.url, "http://localhost:8080");
        assert!(card.agentmesh.is_some());
        assert_eq!(card.agentmesh.unwrap().did, "did:agentmesh:base:test-node");
    }

    #[tokio::test]
    async fn test_agent_card_returns_default_when_no_config() {
        let state = test_state();
        let server = test_server(state);

        let response = server.get("/.well-known/agent.json").await;

        response.assert_status_ok();
        let card: CapabilityCard = response.json();
        assert_eq!(card.name, "AgentMesh Node");
    }

    // ========== TDD Tests: GET /agents ==========

    #[tokio::test]
    async fn test_search_agents_returns_empty_list_when_no_agents() {
        let server = test_server(test_state());

        let response = server.get("/agents").await;

        response.assert_status_ok();
        let agents: Vec<CapabilityCard> = response.json();
        assert!(agents.is_empty());
    }

    #[tokio::test]
    async fn test_search_agents_finds_registered_agents() {
        let state = test_state();
        let card = sample_capability_card("did:agentmesh:base:test-agent");
        state.discovery.register(&card).await.unwrap();

        let server = test_server(state);

        let response = server.get("/agents?q=Test").await;

        response.assert_status_ok();
        let agents: Vec<CapabilityCard> = response.json();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "Test Agent");
    }

    #[tokio::test]
    async fn test_search_agents_with_no_query_returns_all() {
        let state = test_state();
        let card1 = sample_capability_card("did:agentmesh:base:agent-1");
        let mut card2 = sample_capability_card("did:agentmesh:base:agent-2");
        card2.name = "Another Agent".to_string();

        state.discovery.register(&card1).await.unwrap();
        state.discovery.register(&card2).await.unwrap();

        let server = test_server(state);

        // Empty query should match everything
        let response = server.get("/agents?q=").await;

        response.assert_status_ok();
        let agents: Vec<CapabilityCard> = response.json();
        assert_eq!(agents.len(), 2);
    }

    // ========== TDD Tests: GET /agents/:did ==========

    #[tokio::test]
    async fn test_get_agent_returns_404_for_unknown_did() {
        let server = test_server(test_state());

        let response = server.get("/agents/did%3Aagentmesh%3Abase%3Aunknown").await;

        response.assert_status_not_found();
        let error: ApiError = response.json();
        assert!(error.error.contains("not found"));
    }

    #[tokio::test]
    async fn test_get_agent_returns_registered_agent() {
        let state = test_state();
        let did = "did:agentmesh:base:my-agent";
        let card = sample_capability_card(did);
        state.discovery.register(&card).await.unwrap();

        let server = test_server(state);

        // URL encode the DID
        let encoded_did = urlencoding::encode(did);
        let response = server.get(&format!("/agents/{}", encoded_did)).await;

        response.assert_status_ok();
        let returned_card: CapabilityCard = response.json();
        assert_eq!(returned_card.name, "Test Agent");
    }

    // ========== TDD Tests: POST /agents ==========

    #[tokio::test]
    async fn test_register_agent_succeeds_with_valid_card() {
        let server = test_server(test_state());
        let card = sample_capability_card("did:agentmesh:base:new-agent");

        let response = server.post("/agents").json(&card).await;

        response.assert_status(StatusCode::CREATED);
        let body: serde_json::Value = response.json();
        assert_eq!(body["did"], "did:agentmesh:base:new-agent");
    }

    #[tokio::test]
    async fn test_register_agent_fails_with_invalid_did() {
        let server = test_server(test_state());
        let card = sample_capability_card("invalid-did");

        let response = server.post("/agents").json(&card).await;

        response.assert_status_bad_request();
        let error: ApiError = response.json();
        assert!(error.error.contains("DID"));
    }

    #[tokio::test]
    async fn test_register_agent_fails_without_agentmesh_extension() {
        let server = test_server(test_state());
        let mut card = sample_capability_card("did:agentmesh:base:test");
        card.agentmesh = None;

        let response = server.post("/agents").json(&card).await;

        response.assert_status_bad_request();
        let error: ApiError = response.json();
        assert!(error.error.contains("agentmesh") || error.error.contains("DID"));
    }

    // ========== TDD Tests: GET /trust/:did ==========

    #[tokio::test]
    async fn test_get_trust_returns_zero_for_new_agent() {
        let server = test_server(test_state());

        let encoded_did = urlencoding::encode("did:agentmesh:base:unknown");
        let response = server.get(&format!("/trust/{}", encoded_did)).await;

        response.assert_status_ok();
        let trust_info: TrustInfo = response.json();
        assert_eq!(trust_info.score, 0.0);
        assert_eq!(trust_info.reputation, 0.0);
    }

    #[tokio::test]
    async fn test_get_trust_fails_with_invalid_did() {
        let server = test_server(test_state());

        let response = server.get("/trust/invalid-did").await;

        response.assert_status_bad_request();
        let error: ApiError = response.json();
        assert!(error.error.contains("DID"));
    }

    // ========== TDD Tests: Rate Limiting ==========

    fn test_state_with_rate_limit(requests_per_second: u32, burst_size: u32) -> AppState {
        AppState {
            discovery: Arc::new(DiscoveryService::new()),
            trust: Arc::new(TrustService::new(
                "https://sepolia.base.org".to_string(),
                None,
            )),
            start_time: Instant::now(),
            peer_count: Arc::new(AtomicU64::new(0)),
            node_info: None,
            rate_limiter: Arc::new(RateLimitService::new(RateLimitConfig {
                requests_per_second,
                burst_size,
                enabled: true,
            })),
            metrics: Arc::new(MetricsService::disabled()),
            hybrid_search: None,
            api_token: None,
        }
    }

    #[tokio::test]
    async fn test_rate_limited_endpoints_return_429_when_exhausted() {
        // Very strict limit: 1 req/s, burst of 1
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // First request should succeed
        let response1 = server.get("/agents").await;
        response1.assert_status_ok();

        // Second request should be rate limited (429)
        let response2 = server.get("/agents").await;
        assert_eq!(
            response2.status_code(),
            StatusCode::TOO_MANY_REQUESTS,
            "Second request should be rate limited"
        );
    }

    #[tokio::test]
    async fn test_rate_limited_response_has_retry_after_header() {
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // Exhaust the limit
        let _ = server.get("/agents").await;

        // Rate limited response should have Retry-After header
        let response = server.get("/agents").await;
        assert_eq!(response.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // Check header exists - axum_test returns &HeaderValue directly
        let retry_after = response.header("Retry-After");
        assert!(
            !retry_after.is_empty(),
            "Rate limited response should have Retry-After header"
        );
    }

    #[tokio::test]
    async fn test_rate_limited_response_has_ratelimit_headers() {
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // Exhaust the limit
        let _ = server.get("/agents").await;

        // Rate limited response should have X-RateLimit headers
        let response = server.get("/agents").await;
        assert_eq!(response.status_code(), StatusCode::TOO_MANY_REQUESTS);

        // Check X-RateLimit-Limit header exists and has expected value
        response.assert_header("X-RateLimit-Limit", "1");
    }

    #[tokio::test]
    async fn test_health_endpoint_is_not_rate_limited() {
        // Even with strict limit
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // Health endpoint should not be rate limited
        for _ in 0..10 {
            let response = server.get("/health").await;
            response.assert_status_ok();
        }
    }

    #[tokio::test]
    async fn test_agent_card_endpoint_is_not_rate_limited() {
        // Even with strict limit
        let state = test_state_with_rate_limit(1, 1);
        let server = test_server(state);

        // Agent card endpoint should not be rate limited
        for _ in 0..10 {
            let response = server.get("/.well-known/agent.json").await;
            response.assert_status_ok();
        }
    }

    #[tokio::test]
    async fn test_successful_response_has_ratelimit_headers() {
        let state = test_state_with_rate_limit(100, 50);
        let server = test_server(state);

        // Successful request should have rate limit headers
        let response = server.get("/agents").await;
        response.assert_status_ok();

        // Check headers exist
        response.assert_header("X-RateLimit-Limit", "100");

        let remaining = response.header("X-RateLimit-Remaining");
        assert!(
            !remaining.is_empty(),
            "Response should have X-RateLimit-Remaining header"
        );
    }

    // ========== TDD Tests: Semantic Search (Task #66) ==========
    // These tests verify semantic search integration with HybridSearch

    #[tokio::test]
    async fn test_semantic_search_returns_501_when_no_hybrid_search() {
        // Without HybridSearch configured, should return 501 Not Implemented
        let server = test_server(test_state());

        let response = server.get("/agents/semantic?q=code+review").await;

        assert_eq!(
            response.status_code(),
            StatusCode::NOT_IMPLEMENTED,
            "Should return 501 when HybridSearch not available"
        );
    }

    #[tokio::test]
    async fn test_semantic_search_returns_empty_when_no_results() {
        // With HybridSearch configured but no indexed cards
        let state = test_state_with_hybrid_search();
        let Some(state) = state else {
            eprintln!("Skipping: embedding model not available");
            return;
        };
        let server = test_server(state);

        let response = server.get("/agents/semantic?q=code+review").await;

        response.assert_status_ok();
        let results: Vec<SemanticSearchResult> = response.json();
        assert!(results.is_empty(), "Should return empty results");
    }

    #[tokio::test]
    async fn test_semantic_search_finds_matching_agent() {
        let state = test_state_with_hybrid_search();
        let Some(state) = state else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        // Register a card - should auto-index in HybridSearch
        let card = sample_capability_card("did:agentmesh:base:code-reviewer");
        state.discovery.register(&card).await.unwrap();

        // Index the card in HybridSearch
        if let Some(ref hybrid) = state.hybrid_search {
            hybrid.write().await.index_card(&card).await.unwrap();
        }

        let server = test_server(state);

        let response = server.get("/agents/semantic?q=Test+Agent").await;

        response.assert_status_ok();
        let results: Vec<SemanticSearchResult> = response.json();
        assert!(!results.is_empty(), "Should find matching agent");
        assert!(results[0].score > 0.0, "Should have positive score");
    }

    #[tokio::test]
    async fn test_semantic_search_returns_scores() {
        let state = test_state_with_hybrid_search();
        let Some(state) = state else {
            eprintln!("Skipping: embedding model not available");
            return;
        };

        let card = sample_capability_card("did:agentmesh:base:scorer");
        if let Some(ref hybrid) = state.hybrid_search {
            hybrid.write().await.index_card(&card).await.unwrap();
        }

        let server = test_server(state);

        let response = server.get("/agents/semantic?q=test").await;

        response.assert_status_ok();
        let results: Vec<SemanticSearchResult> = response.json();
        if !results.is_empty() {
            assert!(results[0].score > 0.0, "Should have combined score");
            assert!(results[0].vector_score >= 0.0, "Should have vector score");
            assert!(results[0].keyword_score >= 0.0, "Should have keyword score");
        }
    }

    /// Helper to create test state with HybridSearch if model is available
    fn test_state_with_hybrid_search() -> Option<AppState> {
        use crate::search::{EmbeddingService, HybridSearch};
        use tokio::sync::RwLock;

        let embedding = EmbeddingService::new().ok()?;
        let hybrid = HybridSearch::new(embedding);

        Some(AppState {
            discovery: Arc::new(DiscoveryService::new()),
            trust: Arc::new(TrustService::new(
                "https://sepolia.base.org".to_string(),
                None,
            )),
            start_time: Instant::now(),
            peer_count: Arc::new(AtomicU64::new(0)),
            node_info: None,
            rate_limiter: Arc::new(RateLimitService::disabled()),
            metrics: Arc::new(MetricsService::disabled()),
            hybrid_search: Some(Arc::new(RwLock::new(hybrid))),
            api_token: None,
        })
    }
}
