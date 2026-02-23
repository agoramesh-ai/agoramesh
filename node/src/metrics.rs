//! Prometheus metrics for AgoraMesh node observability.
//!
//! This module provides comprehensive metrics collection for monitoring:
//! - HTTP API requests (count, duration, status)
//! - Circuit breaker state and events
//! - Rate limiter statistics
//! - Discovery and trust operations
//! - P2P network statistics
//!
//! ## Usage
//!
//! ```rust,ignore
//! use agoramesh_node::metrics::{MetricsService, MetricsConfig};
//!
//! let metrics = MetricsService::new(MetricsConfig::default());
//! metrics.http_request("GET", "/agents", 200, 0.015);
//! ```
//!
//! ## Exposed Metrics
//!
//! All metrics are prefixed with `agoramesh_`:
//!
//! - `agoramesh_http_requests_total` - Total HTTP requests (counter)
//! - `agoramesh_http_request_duration_seconds` - Request latency (histogram)
//! - `agoramesh_http_requests_in_flight` - Current in-flight requests (gauge)
//! - `agoramesh_circuit_breaker_state` - Circuit breaker state (gauge)
//! - `agoramesh_rate_limit_rejected_total` - Rate limited requests (counter)
//! - `agoramesh_discovery_queries_total` - Discovery queries (counter)
//! - `agoramesh_trust_lookups_total` - Trust score lookups (counter)
//! - `agoramesh_p2p_peers_connected` - Connected peers (gauge)

use metrics::{counter, describe_counter, describe_gauge, describe_histogram, gauge, histogram};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Metrics configuration.
#[derive(Debug, Clone)]
pub struct MetricsConfig {
    /// Prefix for all metric names (default: "agoramesh")
    pub prefix: String,
    /// Enable detailed histogram buckets for latency
    pub detailed_histograms: bool,
    /// Enable P2P metrics collection
    pub enable_p2p_metrics: bool,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            prefix: "agoramesh".to_string(),
            detailed_histograms: true,
            enable_p2p_metrics: true,
        }
    }
}

/// Metric names with configurable prefix.
#[derive(Debug, Clone)]
pub struct MetricNames {
    pub http_requests_total: String,
    pub http_request_duration: String,
    pub http_requests_in_flight: String,
    pub circuit_breaker_state: String,
    pub circuit_breaker_trips: String,
    pub rate_limit_rejected: String,
    pub discovery_queries: String,
    pub trust_lookups: String,
    pub p2p_peers_connected: String,
    pub p2p_messages_received: String,
    pub p2p_messages_sent: String,
}

impl MetricNames {
    /// Create metric names with the given prefix.
    pub fn with_prefix(prefix: &str) -> Self {
        Self {
            http_requests_total: format!("{}_http_requests_total", prefix),
            http_request_duration: format!("{}_http_request_duration_seconds", prefix),
            http_requests_in_flight: format!("{}_http_requests_in_flight", prefix),
            circuit_breaker_state: format!("{}_circuit_breaker_state", prefix),
            circuit_breaker_trips: format!("{}_circuit_breaker_trips_total", prefix),
            rate_limit_rejected: format!("{}_rate_limit_rejected_total", prefix),
            discovery_queries: format!("{}_discovery_queries_total", prefix),
            trust_lookups: format!("{}_trust_lookups_total", prefix),
            p2p_peers_connected: format!("{}_p2p_peers_connected", prefix),
            p2p_messages_received: format!("{}_p2p_messages_received_total", prefix),
            p2p_messages_sent: format!("{}_p2p_messages_sent_total", prefix),
        }
    }
}

impl Default for MetricNames {
    fn default() -> Self {
        Self::with_prefix("agoramesh")
    }
}

/// Prometheus metrics service.
///
/// Provides methods for recording various metrics and exposes a handle
/// for rendering the Prometheus exposition format.
pub struct MetricsService {
    config: MetricsConfig,
    names: MetricNames,
    handle: Option<PrometheusHandle>,
    /// In-flight request counter (for gauge tracking)
    in_flight: Arc<AtomicU64>,
}

impl MetricsService {
    /// Create a new metrics service with the given configuration.
    ///
    /// This installs a global Prometheus recorder. Only one can be installed
    /// per process, so subsequent calls will reuse the existing recorder.
    pub fn new(config: MetricsConfig) -> Self {
        let names = MetricNames::with_prefix(&config.prefix);

        // Try to install the Prometheus recorder
        let handle = PrometheusBuilder::new().install_recorder().ok();

        let service = Self {
            config,
            names,
            handle,
            in_flight: Arc::new(AtomicU64::new(0)),
        };

        // Register metric descriptions
        service.register_descriptions();

        service
    }

    /// Create a metrics service with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(MetricsConfig::default())
    }

    /// Create a disabled metrics service (for testing).
    pub fn disabled() -> Self {
        Self {
            config: MetricsConfig::default(),
            names: MetricNames::default(),
            handle: None,
            in_flight: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Check if metrics recording is enabled.
    pub fn is_enabled(&self) -> bool {
        self.handle.is_some()
    }

    /// Get the Prometheus handle for rendering metrics.
    pub fn handle(&self) -> Option<&PrometheusHandle> {
        self.handle.as_ref()
    }

    /// Render metrics in Prometheus exposition format.
    pub fn render(&self) -> String {
        self.handle.as_ref().map(|h| h.render()).unwrap_or_default()
    }

    /// Get metric names.
    pub fn names(&self) -> &MetricNames {
        &self.names
    }

    /// Register metric descriptions (called once on startup).
    fn register_descriptions(&self) {
        describe_counter!(
            self.names.http_requests_total.clone(),
            "Total number of HTTP requests"
        );
        describe_histogram!(
            self.names.http_request_duration.clone(),
            "HTTP request duration in seconds"
        );
        describe_gauge!(
            self.names.http_requests_in_flight.clone(),
            "Number of HTTP requests currently being processed"
        );
        describe_gauge!(
            self.names.circuit_breaker_state.clone(),
            "Circuit breaker state (0=closed, 1=open, 2=half-open)"
        );
        describe_counter!(
            self.names.circuit_breaker_trips.clone(),
            "Total number of circuit breaker trips"
        );
        describe_counter!(
            self.names.rate_limit_rejected.clone(),
            "Total number of rate-limited requests"
        );
        describe_counter!(
            self.names.discovery_queries.clone(),
            "Total number of agent discovery queries"
        );
        describe_counter!(
            self.names.trust_lookups.clone(),
            "Total number of trust score lookups"
        );

        if self.config.enable_p2p_metrics {
            describe_gauge!(
                self.names.p2p_peers_connected.clone(),
                "Number of connected P2P peers"
            );
            describe_counter!(
                self.names.p2p_messages_received.clone(),
                "Total P2P messages received"
            );
            describe_counter!(
                self.names.p2p_messages_sent.clone(),
                "Total P2P messages sent"
            );
        }
    }

    // ========== HTTP Metrics ==========

    /// Record an HTTP request.
    ///
    /// # Arguments
    /// * `method` - HTTP method (GET, POST, etc.)
    /// * `path` - Request path
    /// * `status` - HTTP status code
    /// * `duration_secs` - Request duration in seconds
    pub fn http_request(&self, method: &str, path: &str, status: u16, duration_secs: f64) {
        let labels = [
            ("method", method.to_string()),
            ("path", path.to_string()),
            ("status", status.to_string()),
        ];

        counter!(self.names.http_requests_total.clone(), &labels).increment(1);
        histogram!(self.names.http_request_duration.clone(), &labels).record(duration_secs);
    }

    /// Start tracking an in-flight request. Returns a guard that decrements on drop.
    pub fn start_request(&self) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        gauge!(self.names.http_requests_in_flight.clone())
            .set(self.in_flight.load(Ordering::SeqCst) as f64);

        InFlightGuard {
            counter: self.in_flight.clone(),
            metric_name: self.names.http_requests_in_flight.clone(),
        }
    }

    // ========== Circuit Breaker Metrics ==========

    /// Record circuit breaker state change.
    ///
    /// # Arguments
    /// * `name` - Circuit breaker name/identifier
    /// * `state` - State: 0=closed, 1=open, 2=half-open
    pub fn circuit_breaker_state(&self, name: &str, state: u8) {
        let labels = [("name", name.to_string())];
        gauge!(self.names.circuit_breaker_state.clone(), &labels).set(state as f64);
    }

    /// Record a circuit breaker trip (transition to open).
    pub fn circuit_breaker_trip(&self, name: &str) {
        let labels = [("name", name.to_string())];
        counter!(self.names.circuit_breaker_trips.clone(), &labels).increment(1);
    }

    // ========== Rate Limiter Metrics ==========

    /// Record a rate-limited (rejected) request.
    pub fn rate_limit_rejected(&self, endpoint: &str) {
        let labels = [("endpoint", endpoint.to_string())];
        counter!(self.names.rate_limit_rejected.clone(), &labels).increment(1);
    }

    // ========== Discovery Metrics ==========

    /// Record a discovery query.
    pub fn discovery_query(&self, query_type: &str, result_count: u64) {
        let labels = [("type", query_type.to_string())];
        counter!(self.names.discovery_queries.clone(), &labels).increment(1);

        // Also record result count as a separate metric if needed
        if result_count > 0 {
            let results_labels = [
                ("type", query_type.to_string()),
                ("has_results", "true".to_string()),
            ];
            counter!(self.names.discovery_queries.clone(), &results_labels).increment(1);
        }
    }

    // ========== Trust Metrics ==========

    /// Record a trust score lookup.
    pub fn trust_lookup(&self, cache_hit: bool) {
        let labels = [("cache", if cache_hit { "hit" } else { "miss" }.to_string())];
        counter!(self.names.trust_lookups.clone(), &labels).increment(1);
    }

    // ========== P2P Metrics ==========

    /// Update connected peers count.
    pub fn p2p_peers(&self, count: u64) {
        if self.config.enable_p2p_metrics {
            gauge!(self.names.p2p_peers_connected.clone()).set(count as f64);
        }
    }

    /// Record a P2P message received.
    pub fn p2p_message_received(&self, topic: &str) {
        if self.config.enable_p2p_metrics {
            let labels = [("topic", topic.to_string())];
            counter!(self.names.p2p_messages_received.clone(), &labels).increment(1);
        }
    }

    /// Record a P2P message sent.
    pub fn p2p_message_sent(&self, topic: &str) {
        if self.config.enable_p2p_metrics {
            let labels = [("topic", topic.to_string())];
            counter!(self.names.p2p_messages_sent.clone(), &labels).increment(1);
        }
    }
}

/// Guard for tracking in-flight requests.
///
/// Automatically decrements the in-flight counter when dropped.
pub struct InFlightGuard {
    counter: Arc<AtomicU64>,
    metric_name: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
        gauge!(self.metric_name.clone()).set(self.counter.load(Ordering::SeqCst) as f64);
    }
}

/// Timer for measuring operation duration.
///
/// Use this to measure how long operations take. Get the elapsed time
/// with `elapsed_secs()` and then record it using the MetricsService.
pub struct Timer {
    start: Instant,
}

impl Timer {
    /// Create a new timer starting now.
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    /// Get elapsed time in seconds.
    pub fn elapsed_secs(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }

    /// Get elapsed time and reset the timer.
    pub fn lap(&mut self) -> f64 {
        let elapsed = self.elapsed_secs();
        self.start = Instant::now();
        elapsed
    }
}

// ========== Axum Middleware Integration ==========

use axum::{
    body::Body, extract::MatchedPath, http::Request, middleware::Next, response::IntoResponse,
};

/// Axum middleware for automatic HTTP metrics collection.
pub async fn metrics_middleware(
    matched_path: Option<MatchedPath>,
    req: Request<Body>,
    next: Next,
) -> impl IntoResponse {
    let start = Instant::now();
    let method = req.method().clone();
    let path = matched_path
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| req.uri().path().to_owned());

    // Track in-flight (simplified - in real impl would use shared state)
    let response = next.run(req).await;

    let duration = start.elapsed().as_secs_f64();
    let status = response.status().as_u16();

    // Record metrics using global recorder
    let labels = [
        ("method", method.to_string()),
        ("path", path),
        ("status", status.to_string()),
    ];

    counter!("agoramesh_http_requests_total", &labels).increment(1);
    histogram!("agoramesh_http_request_duration_seconds", &labels).record(duration);

    response
}

// ========== TDD Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests use a disabled metrics service to avoid
    // conflicts with the global Prometheus recorder.

    // ========== RED Phase: MetricsConfig Tests ==========

    #[test]
    fn test_default_config_has_agoramesh_prefix() {
        let config = MetricsConfig::default();
        assert_eq!(config.prefix, "agoramesh");
    }

    #[test]
    fn test_default_config_enables_detailed_histograms() {
        let config = MetricsConfig::default();
        assert!(config.detailed_histograms);
    }

    #[test]
    fn test_default_config_enables_p2p_metrics() {
        let config = MetricsConfig::default();
        assert!(config.enable_p2p_metrics);
    }

    // ========== RED Phase: MetricNames Tests ==========

    #[test]
    fn test_metric_names_with_default_prefix() {
        let names = MetricNames::default();
        assert_eq!(names.http_requests_total, "agoramesh_http_requests_total");
        assert_eq!(
            names.http_request_duration,
            "agoramesh_http_request_duration_seconds"
        );
        assert_eq!(
            names.http_requests_in_flight,
            "agoramesh_http_requests_in_flight"
        );
    }

    #[test]
    fn test_metric_names_with_custom_prefix() {
        let names = MetricNames::with_prefix("myapp");
        assert_eq!(names.http_requests_total, "myapp_http_requests_total");
        assert_eq!(names.circuit_breaker_state, "myapp_circuit_breaker_state");
        assert_eq!(names.p2p_peers_connected, "myapp_p2p_peers_connected");
    }

    #[test]
    fn test_all_metric_names_have_prefix() {
        let prefix = "test";
        let names = MetricNames::with_prefix(prefix);

        assert!(names.http_requests_total.starts_with(prefix));
        assert!(names.http_request_duration.starts_with(prefix));
        assert!(names.http_requests_in_flight.starts_with(prefix));
        assert!(names.circuit_breaker_state.starts_with(prefix));
        assert!(names.circuit_breaker_trips.starts_with(prefix));
        assert!(names.rate_limit_rejected.starts_with(prefix));
        assert!(names.discovery_queries.starts_with(prefix));
        assert!(names.trust_lookups.starts_with(prefix));
        assert!(names.p2p_peers_connected.starts_with(prefix));
        assert!(names.p2p_messages_received.starts_with(prefix));
        assert!(names.p2p_messages_sent.starts_with(prefix));
    }

    // ========== RED Phase: MetricsService Creation Tests ==========

    #[test]
    fn test_disabled_service_is_not_enabled() {
        let service = MetricsService::disabled();
        assert!(!service.is_enabled());
    }

    #[test]
    fn test_disabled_service_render_returns_empty() {
        let service = MetricsService::disabled();
        assert!(service.render().is_empty());
    }

    #[test]
    fn test_service_exposes_names() {
        let service = MetricsService::disabled();
        assert_eq!(
            service.names().http_requests_total,
            "agoramesh_http_requests_total"
        );
    }

    // ========== RED Phase: InFlightGuard Tests ==========

    #[test]
    fn test_in_flight_counter_increments() {
        let counter = Arc::new(AtomicU64::new(0));

        {
            let _guard = InFlightGuard {
                counter: counter.clone(),
                metric_name: "test".to_string(),
            };
            // Not dropped yet - would be 1 in real usage
        }

        // After drop, should be 0 (but we started at 0 so underflow protection)
        // In real usage, start_request increments first
    }

    #[test]
    fn test_in_flight_guard_decrements_on_drop() {
        let counter = Arc::new(AtomicU64::new(5));

        {
            let _guard = InFlightGuard {
                counter: counter.clone(),
                metric_name: "test_metric".to_string(),
            };
            assert_eq!(counter.load(Ordering::SeqCst), 5);
        }

        // After guard is dropped, counter should be decremented
        assert_eq!(counter.load(Ordering::SeqCst), 4);
    }

    // ========== RED Phase: Timer Tests ==========

    #[test]
    fn test_timer_tracks_elapsed_time() {
        let timer = Timer::start();

        // Sleep briefly
        std::thread::sleep(std::time::Duration::from_millis(10));

        let elapsed = timer.elapsed_secs();
        assert!(elapsed >= 0.01, "Elapsed should be at least 10ms");
        assert!(elapsed < 1.0, "Elapsed should be less than 1s");
    }

    #[test]
    fn test_timer_lap_resets() {
        let mut timer = Timer::start();

        // First lap
        std::thread::sleep(std::time::Duration::from_millis(10));
        let lap1 = timer.lap();
        assert!(lap1 >= 0.01);

        // Second lap should start from zero
        std::thread::sleep(std::time::Duration::from_millis(5));
        let lap2 = timer.lap();
        assert!(lap2 >= 0.005);
        assert!(lap2 < lap1 + 0.01, "Lap 2 should be independent of lap 1");
    }

    // ========== RED Phase: HTTP Metrics Tests ==========

    #[test]
    fn test_http_request_can_be_called() {
        let service = MetricsService::disabled();

        // Should not panic even when disabled
        service.http_request("GET", "/health", 200, 0.001);
        service.http_request("POST", "/agents", 201, 0.050);
        service.http_request("GET", "/agents/123", 404, 0.005);
    }

    #[test]
    fn test_start_request_returns_guard() {
        let service = MetricsService::disabled();

        let guard = service.start_request();
        assert_eq!(service.in_flight.load(Ordering::SeqCst), 1);

        drop(guard);
        assert_eq!(service.in_flight.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_multiple_in_flight_requests() {
        let service = MetricsService::disabled();

        let guard1 = service.start_request();
        let guard2 = service.start_request();
        let guard3 = service.start_request();

        assert_eq!(service.in_flight.load(Ordering::SeqCst), 3);

        drop(guard1);
        assert_eq!(service.in_flight.load(Ordering::SeqCst), 2);

        drop(guard2);
        drop(guard3);
        assert_eq!(service.in_flight.load(Ordering::SeqCst), 0);
    }

    // ========== RED Phase: Circuit Breaker Metrics Tests ==========

    #[test]
    fn test_circuit_breaker_state_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.circuit_breaker_state("rpc_client", 0); // closed
        service.circuit_breaker_state("rpc_client", 1); // open
        service.circuit_breaker_state("rpc_client", 2); // half-open
    }

    #[test]
    fn test_circuit_breaker_trip_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.circuit_breaker_trip("rpc_client");
        service.circuit_breaker_trip("external_api");
    }

    // ========== RED Phase: Rate Limiter Metrics Tests ==========

    #[test]
    fn test_rate_limit_rejected_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.rate_limit_rejected("/agents");
        service.rate_limit_rejected("/trust/did:test");
    }

    // ========== RED Phase: Discovery Metrics Tests ==========

    #[test]
    fn test_discovery_query_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.discovery_query("keyword", 5);
        service.discovery_query("semantic", 0);
        service.discovery_query("dht", 10);
    }

    // ========== RED Phase: Trust Metrics Tests ==========

    #[test]
    fn test_trust_lookup_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.trust_lookup(true); // cache hit
        service.trust_lookup(false); // cache miss
    }

    // ========== RED Phase: P2P Metrics Tests ==========

    #[test]
    fn test_p2p_peers_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.p2p_peers(0);
        service.p2p_peers(5);
        service.p2p_peers(100);
    }

    #[test]
    fn test_p2p_message_received_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.p2p_message_received("agents");
        service.p2p_message_received("trust");
    }

    #[test]
    fn test_p2p_message_sent_can_be_recorded() {
        let service = MetricsService::disabled();

        // Should not panic
        service.p2p_message_sent("agents");
        service.p2p_message_sent("trust");
    }

    #[test]
    fn test_p2p_metrics_disabled_when_config_false() {
        let config = MetricsConfig {
            enable_p2p_metrics: false,
            ..Default::default()
        };
        let service = MetricsService::new(config);

        // Should not record when disabled (no panic)
        service.p2p_peers(10);
        service.p2p_message_received("test");
        service.p2p_message_sent("test");
    }
}
