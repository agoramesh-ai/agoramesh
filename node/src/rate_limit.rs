//! Rate limiting for the AgentMe API.
//!
//! This module provides configurable rate limiting using the GCRA algorithm
//! (Generic Cell Rate Algorithm) via the `governor` crate.
//!
//! Features:
//! - Per-IP rate limiting
//! - Configurable limits (requests per second/minute)
//! - HTTP 429 responses with standard headers
//! - Retry-After header support

use governor::{
    clock::{Clock, DefaultClock, QuantaInstant},
    middleware::NoOpMiddleware,
    state::keyed::DefaultKeyedStateStore,
    Quota, RateLimiter,
};
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::sync::Arc;

/// Type alias for the rate limiter to reduce complexity.
type InMemoryRateLimiter = RateLimiter<
    IpAddr,
    DefaultKeyedStateStore<IpAddr>,
    DefaultClock,
    NoOpMiddleware<QuantaInstant>,
>;

/// Configuration for rate limiting.
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    /// Maximum requests per second (0 = disabled)
    pub requests_per_second: u32,

    /// Maximum burst size (requests allowed in a burst)
    pub burst_size: u32,

    /// Whether rate limiting is enabled
    pub enabled: bool,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 100,
            burst_size: 50,
            enabled: true,
        }
    }
}

/// Rate limit check result.
#[derive(Debug, Clone)]
pub enum RateLimitResult {
    /// Request is allowed
    Allowed {
        /// Remaining requests in current window
        remaining: u32,
        /// Limit per window
        limit: u32,
        /// Seconds until limit resets
        reset_after_secs: u64,
    },
    /// Request is rate limited
    Limited {
        /// Seconds to wait before retrying
        retry_after_secs: u64,
        /// Limit per window
        limit: u32,
    },
}

/// Rate limiter service.
///
/// Uses GCRA (Generic Cell Rate Algorithm) for smooth rate limiting.
/// This is more sophisticated than simple token bucket and provides
/// fair distribution of requests over time.
pub struct RateLimitService {
    config: RateLimitConfig,
    limiter: Option<Arc<InMemoryRateLimiter>>,
}

impl RateLimitService {
    /// Create a new rate limiter with the given configuration.
    pub fn new(config: RateLimitConfig) -> Self {
        let limiter = if config.enabled && config.requests_per_second > 0 {
            // Safety: guarded by > 0 check above; .max(1) ensures burst_size is non-zero
            let rps = NonZeroU32::new(config.requests_per_second)
                .expect("requests_per_second already verified > 0");
            let burst = NonZeroU32::new(config.burst_size.max(1))
                .expect("burst_size.max(1) is always >= 1");
            let quota = Quota::per_second(rps).allow_burst(burst);
            Some(Arc::new(RateLimiter::keyed(quota)))
        } else {
            None
        };

        Self { config, limiter }
    }

    /// Create a disabled rate limiter (for testing or development).
    pub fn disabled() -> Self {
        Self::new(RateLimitConfig {
            enabled: false,
            ..Default::default()
        })
    }

    /// Check if a request is allowed.
    ///
    /// Returns `RateLimitResult::Allowed` if the request can proceed,
    /// or `RateLimitResult::Limited` if the client should wait.
    pub fn check(&self, client_ip: Option<IpAddr>) -> RateLimitResult {
        match &self.limiter {
            None => {
                // Rate limiting disabled
                RateLimitResult::Allowed {
                    remaining: u32::MAX,
                    limit: u32::MAX,
                    reset_after_secs: 0,
                }
            }
            Some(limiter) => {
                let key = client_ip.unwrap_or_else(|| IpAddr::from([127, 0, 0, 1]));
                match limiter.check_key(&key) {
                    Ok(_) => {
                        // Request allowed
                        RateLimitResult::Allowed {
                            remaining: self.config.burst_size.saturating_sub(1),
                            limit: self.config.requests_per_second,
                            reset_after_secs: 1,
                        }
                    }
                    Err(not_until) => {
                        // Rate limited
                        let wait_time = not_until.wait_time_from(DefaultClock::default().now());
                        RateLimitResult::Limited {
                            retry_after_secs: wait_time.as_secs().max(1),
                            limit: self.config.requests_per_second,
                        }
                    }
                }
            }
        }
    }

    /// Check if rate limiting is enabled.
    pub fn is_enabled(&self) -> bool {
        self.config.enabled && self.limiter.is_some()
    }

    /// Get the configured limit.
    pub fn limit(&self) -> u32 {
        self.config.requests_per_second
    }

    /// Get the configured burst size.
    pub fn burst_size(&self) -> u32 {
        self.config.burst_size
    }
}

/// HTTP headers for rate limit information.
pub mod headers {
    /// Maximum requests allowed per window
    pub const X_RATELIMIT_LIMIT: &str = "X-RateLimit-Limit";
    /// Remaining requests in current window
    pub const X_RATELIMIT_REMAINING: &str = "X-RateLimit-Remaining";
    /// Seconds until limit resets
    pub const X_RATELIMIT_RESET: &str = "X-RateLimit-Reset";
    /// Seconds to wait before retrying (on 429)
    pub const RETRY_AFTER: &str = "Retry-After";
}

// ========== Axum Middleware ==========

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tower::{Layer, Service};

/// Rate limiting layer for Axum routes.
#[derive(Clone)]
pub struct RateLimitLayer {
    service: Arc<RateLimitService>,
    trust_proxy: bool,
}

impl RateLimitLayer {
    /// Create a new rate limit layer.
    pub fn new(service: Arc<RateLimitService>) -> Self {
        Self {
            service,
            trust_proxy: false,
        }
    }

    /// Create a rate limit layer with default configuration.
    pub fn default_config() -> Self {
        Self::new(Arc::new(RateLimitService::new(RateLimitConfig::default())))
    }

    /// Configure whether to trust proxy headers for client IP extraction.
    pub fn with_trust_proxy(mut self, trust_proxy: bool) -> Self {
        self.trust_proxy = trust_proxy;
        self
    }
}

impl<S> Layer<S> for RateLimitLayer {
    type Service = RateLimitMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RateLimitMiddleware {
            inner,
            limiter: self.service.clone(),
            trust_proxy: self.trust_proxy,
        }
    }
}

/// Rate limiting middleware service.
#[derive(Clone)]
pub struct RateLimitMiddleware<S> {
    inner: S,
    limiter: Arc<RateLimitService>,
    trust_proxy: bool,
}

impl<S> Service<Request<Body>> for RateLimitMiddleware<S>
where
    S: Service<Request<Body>, Response = Response<Body>> + Clone + Send + 'static,
    S::Future: Send,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let limiter = self.limiter.clone();
        let mut inner = self.inner.clone();
        let trust_proxy = self.trust_proxy;

        Box::pin(async move {
            let client_ip = extract_client_ip(&request, trust_proxy);
            match limiter.check(client_ip) {
                RateLimitResult::Allowed {
                    remaining,
                    limit,
                    reset_after_secs,
                } => {
                    // Call inner service
                    let mut response = inner.call(request).await?;

                    // Add rate limit headers to response
                    let headers = response.headers_mut();
                    if let Ok(val) = limit.to_string().parse() {
                        headers.insert(headers::X_RATELIMIT_LIMIT, val);
                    }
                    if let Ok(val) = remaining.to_string().parse() {
                        headers.insert(headers::X_RATELIMIT_REMAINING, val);
                    }
                    if let Ok(val) = reset_after_secs.to_string().parse() {
                        headers.insert(headers::X_RATELIMIT_RESET, val);
                    }

                    Ok(response)
                }
                RateLimitResult::Limited {
                    retry_after_secs,
                    limit,
                } => {
                    // Return 429 Too Many Requests
                    let error_body = serde_json::json!({
                        "error": "Too Many Requests",
                        "retry_after": retry_after_secs,
                        "limit": limit
                    });

                    let response = Response::builder()
                        .status(StatusCode::TOO_MANY_REQUESTS)
                        .header(headers::RETRY_AFTER, retry_after_secs.to_string())
                        .header(headers::X_RATELIMIT_LIMIT, limit.to_string())
                        .header(headers::X_RATELIMIT_REMAINING, "0")
                        .header("Content-Type", "application/json")
                        .body(Body::from(error_body.to_string()))
                        .expect("building 429 response with valid headers");

                    Ok(response)
                }
            }
        })
    }
}

fn extract_client_ip(request: &Request<Body>, trust_proxy: bool) -> Option<IpAddr> {
    if trust_proxy {
        if let Some(ip) = extract_header_ip(request.headers().get("x-forwarded-for"), true) {
            return Some(ip);
        }
        if let Some(ip) = extract_header_ip(request.headers().get("x-real-ip"), false) {
            return Some(ip);
        }
    }

    request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
}

fn extract_header_ip(
    value: Option<&axum::http::HeaderValue>,
    allow_multiple: bool,
) -> Option<IpAddr> {
    let value = value?.to_str().ok()?;
    let candidate = if allow_multiple {
        value.split(',').next().unwrap_or_default()
    } else {
        value
    };
    parse_ip_candidate(candidate)
}

fn parse_ip_candidate(value: &str) -> Option<IpAddr> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("unknown") {
        return None;
    }

    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return Some(ip);
    }

    if let Ok(sock) = trimmed.parse::<SocketAddr>() {
        return Some(sock.ip());
    }

    if let Some(stripped) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return stripped.parse::<IpAddr>().ok();
    }

    None
}

/// Create a rate limited 429 response (for use in handlers).
pub fn rate_limited_response(retry_after_secs: u64, limit: u32) -> impl IntoResponse {
    let error_body = serde_json::json!({
        "error": "Too Many Requests",
        "retry_after": retry_after_secs,
        "limit": limit
    });

    (
        StatusCode::TOO_MANY_REQUESTS,
        [
            (headers::RETRY_AFTER, retry_after_secs.to_string()),
            (headers::X_RATELIMIT_LIMIT, limit.to_string()),
            (headers::X_RATELIMIT_REMAINING, "0".to_string()),
        ],
        Json(error_body),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== TDD Tests: RateLimitConfig ==========

    #[test]
    fn test_default_config_has_reasonable_limits() {
        let config = RateLimitConfig::default();

        assert!(config.enabled, "Rate limiting should be enabled by default");
        assert!(
            config.requests_per_second >= 10,
            "Default should allow at least 10 req/s"
        );
        assert!(
            config.burst_size >= 10,
            "Default should allow at least 10 burst"
        );
    }

    // ========== TDD Tests: RateLimitService Creation ==========

    #[test]
    fn test_new_service_with_config() {
        let config = RateLimitConfig {
            requests_per_second: 50,
            burst_size: 25,
            enabled: true,
        };

        let service = RateLimitService::new(config);

        assert!(service.is_enabled());
        assert_eq!(service.limit(), 50);
        assert_eq!(service.burst_size(), 25);
    }

    #[test]
    fn test_disabled_service() {
        let service = RateLimitService::disabled();

        assert!(!service.is_enabled());
    }

    #[test]
    fn test_service_with_zero_limit_is_effectively_disabled() {
        let config = RateLimitConfig {
            requests_per_second: 0,
            burst_size: 0,
            enabled: true, // Even enabled, 0 limit means disabled
        };

        let service = RateLimitService::new(config);

        assert!(!service.is_enabled());
    }

    // ========== TDD Tests: Rate Limit Checking ==========

    #[test]
    fn test_check_allows_first_request() {
        let service = RateLimitService::new(RateLimitConfig {
            requests_per_second: 10,
            burst_size: 5,
            enabled: true,
        });

        let result = service.check(Some(IpAddr::from([127, 0, 0, 1])));

        match result {
            RateLimitResult::Allowed { limit, .. } => {
                assert_eq!(limit, 10);
            }
            RateLimitResult::Limited { .. } => {
                panic!("First request should be allowed");
            }
        }
    }

    #[test]
    fn test_check_allows_burst_requests() {
        let service = RateLimitService::new(RateLimitConfig {
            requests_per_second: 10,
            burst_size: 5,
            enabled: true,
        });
        let ip = IpAddr::from([127, 0, 0, 1]);

        // Should allow burst_size requests quickly
        for i in 0..5 {
            let result = service.check(Some(ip));
            assert!(
                matches!(result, RateLimitResult::Allowed { .. }),
                "Request {} should be allowed within burst",
                i
            );
        }
    }

    #[test]
    fn test_check_limits_after_burst_exhausted() {
        let service = RateLimitService::new(RateLimitConfig {
            requests_per_second: 10,
            burst_size: 3,
            enabled: true,
        });
        let ip = IpAddr::from([127, 0, 0, 1]);

        // Exhaust the burst
        for _ in 0..3 {
            let _ = service.check(Some(ip));
        }

        // Next request should be limited
        let result = service.check(Some(ip));
        match result {
            RateLimitResult::Limited {
                retry_after_secs,
                limit,
            } => {
                assert!(
                    retry_after_secs >= 1,
                    "Should suggest waiting at least 1 second"
                );
                assert_eq!(limit, 10);
            }
            RateLimitResult::Allowed { .. } => {
                panic!("Request after burst exhausted should be limited");
            }
        }
    }

    #[test]
    fn test_check_always_allows_when_disabled() {
        let service = RateLimitService::disabled();
        let ip = IpAddr::from([127, 0, 0, 1]);

        // Even many requests should be allowed
        for _ in 0..1000 {
            let result = service.check(Some(ip));
            assert!(
                matches!(result, RateLimitResult::Allowed { .. }),
                "Disabled limiter should always allow"
            );
        }
    }

    #[test]
    fn test_limited_result_has_retry_after() {
        let service = RateLimitService::new(RateLimitConfig {
            requests_per_second: 1,
            burst_size: 1,
            enabled: true,
        });
        let ip = IpAddr::from([127, 0, 0, 1]);

        // First request allowed
        let _ = service.check(Some(ip));

        // Second request should be limited with retry_after
        let result = service.check(Some(ip));
        match result {
            RateLimitResult::Limited {
                retry_after_secs, ..
            } => {
                assert!(
                    retry_after_secs >= 1,
                    "Should have retry_after_secs >= 1, got {}",
                    retry_after_secs
                );
            }
            _ => panic!("Expected Limited result"),
        }
    }

    // ========== TDD Tests: Header Constants ==========

    #[test]
    fn test_header_constants_are_standard() {
        assert_eq!(headers::X_RATELIMIT_LIMIT, "X-RateLimit-Limit");
        assert_eq!(headers::X_RATELIMIT_REMAINING, "X-RateLimit-Remaining");
        assert_eq!(headers::X_RATELIMIT_RESET, "X-RateLimit-Reset");
        assert_eq!(headers::RETRY_AFTER, "Retry-After");
    }

    // ========== TDD Tests: RateLimitLayer ==========

    #[test]
    fn test_rate_limit_layer_can_be_created() {
        let service = Arc::new(RateLimitService::new(RateLimitConfig::default()));
        let layer = RateLimitLayer::new(service);

        // Just verify it compiles and doesn't panic
        assert!(layer.service.is_enabled());
    }

    #[test]
    fn test_rate_limit_layer_default_config() {
        let layer = RateLimitLayer::default_config();
        assert!(layer.service.is_enabled());
    }
}
