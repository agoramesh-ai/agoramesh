//! Circuit breaker for protecting external service calls.
//!
//! This module provides a circuit breaker implementation for the AgentMe node,
//! preventing cascading failures when external services (blockchain RPC, APIs) fail.
//!
//! ## States
//!
//! - **Closed**: Normal operation, requests pass through
//! - **Open**: Threshold exceeded, requests fail fast without calling service
//! - **HalfOpen**: Testing recovery, limited requests allowed
//!
//! ## Usage
//!
//! ```rust,ignore
//! let cb = CircuitBreaker::new(CircuitBreakerConfig::default());
//!
//! let result = cb.call(|| async {
//!     // Call external service
//!     external_api_call().await
//! }).await;
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Circuit breaker state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CircuitState {
    /// Normal operation - requests pass through
    #[default]
    Closed,
    /// Failure threshold exceeded - requests fail fast
    Open,
    /// Testing recovery - limited requests allowed
    HalfOpen,
}

/// Configuration for the circuit breaker.
#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    /// Failure rate threshold (0.0 - 1.0) to trip the circuit
    /// e.g., 0.5 = 50% failure rate trips the circuit
    pub failure_rate_threshold: f64,

    /// Minimum number of calls before calculating failure rate
    pub minimum_calls: u32,

    /// Duration the circuit stays open before testing recovery
    pub open_duration: Duration,

    /// Number of test calls allowed in half-open state
    pub half_open_calls: u32,

    /// Sliding window size for tracking calls
    pub window_size: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_rate_threshold: 0.5, // 50% failure rate
            minimum_calls: 10,
            open_duration: Duration::from_secs(30),
            half_open_calls: 3,
            window_size: 100,
        }
    }
}

/// Error returned when circuit is open.
#[derive(Debug, Clone)]
pub struct CircuitOpenError {
    /// When the circuit will attempt recovery
    pub retry_after: Duration,
    /// Current failure rate when circuit was opened
    pub failure_rate: f64,
}

impl std::fmt::Display for CircuitOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Circuit breaker is open (failure rate: {:.1}%), retry after {:?}",
            self.failure_rate * 100.0,
            self.retry_after
        )
    }
}

impl std::error::Error for CircuitOpenError {}

/// Result of a circuit breaker call.
pub type CircuitResult<T, E> = Result<T, CircuitError<E>>;

/// Error that can occur during a circuit breaker call.
#[derive(Debug)]
pub enum CircuitError<E> {
    /// The circuit is open, request rejected
    Open(CircuitOpenError),
    /// The underlying service returned an error
    Service(E),
}

impl<E: std::fmt::Display> std::fmt::Display for CircuitError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(e) => write!(f, "{}", e),
            Self::Service(e) => write!(f, "Service error: {}", e),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for CircuitError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Open(e) => Some(e),
            Self::Service(e) => Some(e),
        }
    }
}

/// Metrics tracked by the circuit breaker.
#[derive(Debug, Default)]
pub struct CircuitMetrics {
    /// Total successful calls
    pub success_count: AtomicU64,
    /// Total failed calls
    pub failure_count: AtomicU64,
    /// Total rejected calls (circuit open)
    pub rejected_count: AtomicU64,
    /// Number of times circuit opened
    pub open_count: AtomicU64,
    /// Number of state transitions
    pub transition_count: AtomicU64,
}

impl CircuitMetrics {
    /// Get current failure rate (0.0 - 1.0).
    pub fn failure_rate(&self) -> f64 {
        let success = self.success_count.load(Ordering::Relaxed);
        let failure = self.failure_count.load(Ordering::Relaxed);
        let total = success + failure;

        if total == 0 {
            0.0
        } else {
            failure as f64 / total as f64
        }
    }

    /// Get total number of calls.
    pub fn total_calls(&self) -> u64 {
        self.success_count.load(Ordering::Relaxed) + self.failure_count.load(Ordering::Relaxed)
    }

    /// Reset metrics.
    pub fn reset(&self) {
        self.success_count.store(0, Ordering::Relaxed);
        self.failure_count.store(0, Ordering::Relaxed);
    }
}

/// Internal state for circuit breaker.
struct InternalState {
    state: CircuitState,
    /// When the circuit was opened (for timing recovery)
    opened_at: Option<Instant>,
    /// Calls allowed in half-open state
    half_open_remaining: u32,
    /// Last recorded failure rate when circuit opened
    last_failure_rate: f64,
}

/// Thread-safe circuit breaker.
///
/// Protects external service calls from cascading failures using the
/// circuit breaker pattern.
pub struct CircuitBreaker {
    config: CircuitBreakerConfig,
    state: RwLock<InternalState>,
    metrics: CircuitMetrics,
}

impl CircuitBreaker {
    /// Create a new circuit breaker with the given configuration.
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            state: RwLock::new(InternalState {
                state: CircuitState::Closed,
                opened_at: None,
                half_open_remaining: config.half_open_calls,
                last_failure_rate: 0.0,
            }),
            config,
            metrics: CircuitMetrics::default(),
        }
    }

    /// Create a circuit breaker with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(CircuitBreakerConfig::default())
    }

    /// Get current circuit state.
    pub fn state(&self) -> CircuitState {
        let guard = self.state.read().unwrap_or_else(|e| e.into_inner());
        guard.state
    }

    /// Get circuit breaker metrics.
    pub fn metrics(&self) -> &CircuitMetrics {
        &self.metrics
    }

    /// Check if a call is allowed (without actually making it).
    ///
    /// Returns Ok(()) if allowed, Err with retry info if circuit is open.
    pub fn check(&self) -> Result<(), CircuitOpenError> {
        self.try_acquire()
    }

    /// Execute a fallible operation through the circuit breaker.
    ///
    /// If the circuit is open, returns `CircuitError::Open` immediately.
    /// If the operation fails, records the failure and may trip the circuit.
    pub async fn call<F, Fut, T, E>(&self, f: F) -> CircuitResult<T, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        // Check if we can proceed
        self.try_acquire().map_err(CircuitError::Open)?;

        // Execute the operation
        let result = f().await;

        // Record the outcome
        match &result {
            Ok(_) => self.record_success(),
            Err(_) => self.record_failure(),
        }

        result.map_err(CircuitError::Service)
    }

    /// Execute a synchronous fallible operation through the circuit breaker.
    pub fn call_sync<F, T, E>(&self, f: F) -> CircuitResult<T, E>
    where
        F: FnOnce() -> Result<T, E>,
    {
        // Check if we can proceed
        self.try_acquire().map_err(CircuitError::Open)?;

        // Execute the operation
        let result = f();

        // Record the outcome
        match &result {
            Ok(_) => self.record_success(),
            Err(_) => self.record_failure(),
        }

        result.map_err(CircuitError::Service)
    }

    /// Record a successful call (for manual tracking).
    pub fn record_success(&self) {
        self.metrics.success_count.fetch_add(1, Ordering::Relaxed);
        self.maybe_close_circuit();
    }

    /// Record a failed call (for manual tracking).
    pub fn record_failure(&self) {
        self.metrics.failure_count.fetch_add(1, Ordering::Relaxed);
        self.maybe_open_circuit();
    }

    /// Force the circuit to open (for testing or manual intervention).
    pub fn force_open(&self) {
        let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());
        if guard.state != CircuitState::Open {
            guard.state = CircuitState::Open;
            guard.opened_at = Some(Instant::now());
            guard.last_failure_rate = self.metrics.failure_rate();
            self.metrics.open_count.fetch_add(1, Ordering::Relaxed);
            self.metrics
                .transition_count
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Force the circuit to close (for testing or manual intervention).
    pub fn force_close(&self) {
        let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());
        if guard.state != CircuitState::Closed {
            guard.state = CircuitState::Closed;
            guard.opened_at = None;
            guard.half_open_remaining = self.config.half_open_calls;
            self.metrics.reset();
            self.metrics
                .transition_count
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Reset the circuit breaker to initial state.
    pub fn reset(&self) {
        let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());
        guard.state = CircuitState::Closed;
        guard.opened_at = None;
        guard.half_open_remaining = self.config.half_open_calls;
        guard.last_failure_rate = 0.0;
        self.metrics.reset();
    }

    // ========== Internal Methods ==========

    fn try_acquire(&self) -> Result<(), CircuitOpenError> {
        // First, check and potentially transition state
        self.check_state_transition();

        let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());

        match guard.state {
            CircuitState::Closed => Ok(()),
            CircuitState::Open => {
                self.metrics.rejected_count.fetch_add(1, Ordering::Relaxed);
                let retry_after = guard
                    .opened_at
                    .map(|t| self.config.open_duration.saturating_sub(t.elapsed()))
                    .unwrap_or(self.config.open_duration);

                Err(CircuitOpenError {
                    retry_after,
                    failure_rate: guard.last_failure_rate,
                })
            }
            CircuitState::HalfOpen => {
                if guard.half_open_remaining > 0 {
                    guard.half_open_remaining -= 1;
                    Ok(())
                } else {
                    self.metrics.rejected_count.fetch_add(1, Ordering::Relaxed);
                    Err(CircuitOpenError {
                        retry_after: Duration::from_secs(1),
                        failure_rate: guard.last_failure_rate,
                    })
                }
            }
        }
    }

    fn check_state_transition(&self) {
        let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());

        // Open -> HalfOpen after timeout
        if guard.state == CircuitState::Open {
            if let Some(opened_at) = guard.opened_at {
                if opened_at.elapsed() >= self.config.open_duration {
                    guard.state = CircuitState::HalfOpen;
                    guard.half_open_remaining = self.config.half_open_calls;
                    self.metrics
                        .transition_count
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    fn maybe_open_circuit(&self) {
        let total = self.metrics.total_calls();
        if total < self.config.minimum_calls as u64 {
            return;
        }

        let failure_rate = self.metrics.failure_rate();
        if failure_rate >= self.config.failure_rate_threshold {
            let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());
            if guard.state == CircuitState::Closed || guard.state == CircuitState::HalfOpen {
                guard.state = CircuitState::Open;
                guard.opened_at = Some(Instant::now());
                guard.last_failure_rate = failure_rate;
                self.metrics.open_count.fetch_add(1, Ordering::Relaxed);
                self.metrics
                    .transition_count
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn maybe_close_circuit(&self) {
        let guard = self.state.read().unwrap_or_else(|e| e.into_inner());
        if guard.state == CircuitState::HalfOpen {
            drop(guard); // Release read lock before write

            // In half-open, a success indicates recovery
            // Reset metrics and close circuit
            let mut guard = self.state.write().unwrap_or_else(|e| e.into_inner());
            if guard.state == CircuitState::HalfOpen {
                guard.state = CircuitState::Closed;
                guard.opened_at = None;
                guard.half_open_remaining = self.config.half_open_calls;
                self.metrics.reset();
                self.metrics
                    .transition_count
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

// ========== Graceful Degradation ==========

/// Graceful degradation strategy when circuit is open.
#[derive(Debug, Clone)]
pub enum DegradationStrategy<T> {
    /// Return a static fallback value
    StaticFallback(T),
    /// Return last known good value (requires caching)
    LastKnownGood,
    /// Return a default value (T: Default)
    Default,
    /// Fail fast with error (no degradation)
    FailFast,
}

/// Result with degradation information.
#[derive(Debug)]
pub struct DegradedResult<T> {
    /// The result value
    pub value: T,
    /// Whether this is a degraded (fallback) result
    pub degraded: bool,
    /// Reason for degradation (if degraded)
    pub reason: Option<String>,
}

impl<T> DegradedResult<T> {
    /// Create a normal (non-degraded) result.
    pub fn ok(value: T) -> Self {
        Self {
            value,
            degraded: false,
            reason: None,
        }
    }

    /// Create a degraded result with a reason.
    pub fn degraded(value: T, reason: impl Into<String>) -> Self {
        Self {
            value,
            degraded: true,
            reason: Some(reason.into()),
        }
    }
}

/// Circuit breaker with graceful degradation support.
pub struct ResilientCircuitBreaker<T: Clone> {
    breaker: CircuitBreaker,
    strategy: DegradationStrategy<T>,
    last_good: RwLock<Option<T>>,
}

impl<T: Clone> ResilientCircuitBreaker<T> {
    /// Create a resilient circuit breaker with fallback strategy.
    pub fn new(config: CircuitBreakerConfig, strategy: DegradationStrategy<T>) -> Self {
        Self {
            breaker: CircuitBreaker::new(config),
            strategy,
            last_good: RwLock::new(None),
        }
    }

    /// Create with static fallback value.
    pub fn with_fallback(config: CircuitBreakerConfig, fallback: T) -> Self {
        Self::new(config, DegradationStrategy::StaticFallback(fallback))
    }

    /// Create with last-known-good strategy.
    pub fn with_last_known_good(config: CircuitBreakerConfig) -> Self {
        Self::new(config, DegradationStrategy::LastKnownGood)
    }

    /// Get the underlying circuit breaker.
    pub fn breaker(&self) -> &CircuitBreaker {
        &self.breaker
    }

    /// Get current circuit state.
    pub fn state(&self) -> CircuitState {
        self.breaker.state()
    }

    /// Execute with graceful degradation.
    ///
    /// If the circuit is open or the operation fails, returns a degraded result
    /// based on the configured strategy.
    pub async fn call_with_fallback<F, Fut, E>(
        &self,
        f: F,
    ) -> Result<DegradedResult<T>, CircuitError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        match self.breaker.call(f).await {
            Ok(value) => {
                // Store as last known good
                if let Ok(mut guard) = self.last_good.write() {
                    *guard = Some(value.clone());
                }
                Ok(DegradedResult::ok(value))
            }
            Err(CircuitError::Open(open_err)) => {
                // Circuit is open - apply degradation strategy
                self.apply_degradation(&format!("Circuit open: {}", open_err))
            }
            Err(CircuitError::Service(e)) => {
                // Service error - could also apply degradation
                Err(CircuitError::Service(e))
            }
        }
    }

    /// Apply the degradation strategy.
    fn apply_degradation<E>(&self, reason: &str) -> Result<DegradedResult<T>, CircuitError<E>> {
        match &self.strategy {
            DegradationStrategy::StaticFallback(value) => {
                Ok(DegradedResult::degraded(value.clone(), reason))
            }
            DegradationStrategy::LastKnownGood => {
                if let Ok(guard) = self.last_good.read() {
                    if let Some(value) = guard.as_ref() {
                        return Ok(DegradedResult::degraded(value.clone(), reason));
                    }
                }
                // No last known good - cannot degrade
                Err(CircuitError::Open(CircuitOpenError {
                    retry_after: Duration::from_secs(30),
                    failure_rate: 0.0,
                }))
            }
            DegradationStrategy::Default => {
                // Requires T: Default, but we can't express that here
                // For now, fail
                Err(CircuitError::Open(CircuitOpenError {
                    retry_after: Duration::from_secs(30),
                    failure_rate: 0.0,
                }))
            }
            DegradationStrategy::FailFast => Err(CircuitError::Open(CircuitOpenError {
                retry_after: Duration::from_secs(30),
                failure_rate: 0.0,
            })),
        }
    }

    /// Manually set the last known good value.
    pub fn set_last_known_good(&self, value: T) {
        if let Ok(mut guard) = self.last_good.write() {
            *guard = Some(value);
        }
    }

    /// Get the last known good value (if any).
    pub fn get_last_known_good(&self) -> Option<T> {
        self.last_good.read().ok().and_then(|g| g.clone())
    }
}

// ========== TDD Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    // ========== RED Phase: CircuitBreakerConfig Tests ==========

    #[test]
    fn test_default_config_has_reasonable_values() {
        let config = CircuitBreakerConfig::default();

        assert!(
            config.failure_rate_threshold > 0.0 && config.failure_rate_threshold <= 1.0,
            "Threshold should be between 0 and 1"
        );
        assert!(config.minimum_calls > 0, "Should require minimum calls");
        assert!(
            config.open_duration >= Duration::from_secs(1),
            "Open duration should be at least 1 second"
        );
        assert!(config.half_open_calls > 0, "Should allow test calls");
        assert!(config.window_size > 0, "Window size should be positive");
    }

    #[test]
    fn test_config_50_percent_threshold_by_default() {
        let config = CircuitBreakerConfig::default();
        assert_eq!(config.failure_rate_threshold, 0.5);
    }

    // ========== RED Phase: CircuitState Tests ==========

    #[test]
    fn test_circuit_state_default_is_closed() {
        let state = CircuitState::default();
        assert_eq!(state, CircuitState::Closed);
    }

    // ========== RED Phase: CircuitBreaker Creation Tests ==========

    #[test]
    fn test_new_circuit_breaker_starts_closed() {
        let cb = CircuitBreaker::new(CircuitBreakerConfig::default());
        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn test_with_defaults_creates_usable_breaker() {
        let cb = CircuitBreaker::with_defaults();
        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.metrics().total_calls(), 0);
    }

    // ========== RED Phase: Metrics Tests ==========

    #[test]
    fn test_metrics_starts_at_zero() {
        let cb = CircuitBreaker::with_defaults();
        let metrics = cb.metrics();

        assert_eq!(metrics.success_count.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.failure_count.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.rejected_count.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.failure_rate(), 0.0);
    }

    #[test]
    fn test_failure_rate_calculation() {
        let metrics = CircuitMetrics::default();

        // No calls = 0% failure rate
        assert_eq!(metrics.failure_rate(), 0.0);

        // 2 success, 2 failure = 50%
        metrics.success_count.store(2, Ordering::Relaxed);
        metrics.failure_count.store(2, Ordering::Relaxed);
        assert!((metrics.failure_rate() - 0.5).abs() < 0.001);

        // 1 success, 9 failures = 90%
        metrics.success_count.store(1, Ordering::Relaxed);
        metrics.failure_count.store(9, Ordering::Relaxed);
        assert!((metrics.failure_rate() - 0.9).abs() < 0.001);
    }

    // ========== RED Phase: Check (without calling) Tests ==========

    #[test]
    fn test_check_allows_when_closed() {
        let cb = CircuitBreaker::with_defaults();
        assert!(cb.check().is_ok());
    }

    #[test]
    fn test_check_rejects_when_open() {
        let cb = CircuitBreaker::with_defaults();
        cb.force_open();

        let result = cb.check();
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert!(err.retry_after > Duration::ZERO);
    }

    // ========== RED Phase: Recording Success/Failure Tests ==========

    #[test]
    fn test_record_success_increments_counter() {
        let cb = CircuitBreaker::with_defaults();

        cb.record_success();
        cb.record_success();

        assert_eq!(cb.metrics().success_count.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn test_record_failure_increments_counter() {
        let cb = CircuitBreaker::with_defaults();

        cb.record_failure();
        cb.record_failure();
        cb.record_failure();

        assert_eq!(cb.metrics().failure_count.load(Ordering::Relaxed), 3);
    }

    // ========== RED Phase: Circuit Opening Tests ==========

    #[test]
    fn test_circuit_opens_when_failure_threshold_exceeded() {
        let config = CircuitBreakerConfig {
            failure_rate_threshold: 0.5,
            minimum_calls: 4,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // 1 success, 3 failures = 75% failure rate (above 50%)
        cb.record_success();
        cb.record_failure();
        cb.record_failure();
        cb.record_failure();

        assert_eq!(cb.state(), CircuitState::Open);
    }

    #[test]
    fn test_circuit_stays_closed_below_minimum_calls() {
        let config = CircuitBreakerConfig {
            failure_rate_threshold: 0.5,
            minimum_calls: 10,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // All failures but below minimum calls
        for _ in 0..5 {
            cb.record_failure();
        }

        assert_eq!(
            cb.state(),
            CircuitState::Closed,
            "Should stay closed until minimum calls reached"
        );
    }

    #[test]
    fn test_circuit_stays_closed_below_threshold() {
        let config = CircuitBreakerConfig {
            failure_rate_threshold: 0.5,
            minimum_calls: 4,
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);

        // 3 success, 1 failure = 25% failure rate (below 50%)
        cb.record_success();
        cb.record_success();
        cb.record_success();
        cb.record_failure();

        assert_eq!(
            cb.state(),
            CircuitState::Closed,
            "Should stay closed below threshold"
        );
    }

    // ========== RED Phase: Force Open/Close Tests ==========

    #[test]
    fn test_force_open_trips_circuit() {
        let cb = CircuitBreaker::with_defaults();

        cb.force_open();

        assert_eq!(cb.state(), CircuitState::Open);
        assert_eq!(cb.metrics().open_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_force_close_resets_circuit() {
        let cb = CircuitBreaker::with_defaults();
        cb.force_open();

        cb.force_close();

        assert_eq!(cb.state(), CircuitState::Closed);
    }

    #[test]
    fn test_reset_clears_all_state() {
        let cb = CircuitBreaker::with_defaults();

        cb.record_success();
        cb.record_failure();
        cb.force_open();

        cb.reset();

        assert_eq!(cb.state(), CircuitState::Closed);
        assert_eq!(cb.metrics().total_calls(), 0);
    }

    // ========== RED Phase: Half-Open State Tests ==========

    #[test]
    fn test_half_open_allows_limited_calls() {
        let config = CircuitBreakerConfig {
            half_open_calls: 2,
            open_duration: Duration::from_millis(1),
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);
        cb.force_open();

        // Wait for transition to half-open
        std::thread::sleep(Duration::from_millis(5));

        // First check triggers transition
        assert!(cb.check().is_ok());
        assert_eq!(cb.state(), CircuitState::HalfOpen);

        // Should allow half_open_calls - 1 more (one was used above)
        assert!(cb.check().is_ok());

        // Third should be rejected
        assert!(cb.check().is_err());
    }

    // ========== RED Phase: Sync Call Tests ==========

    #[test]
    fn test_call_sync_success_passes_through() {
        let cb = CircuitBreaker::with_defaults();

        let result: CircuitResult<i32, &str> = cb.call_sync(|| Ok(42));

        assert_eq!(result.unwrap(), 42);
        assert_eq!(cb.metrics().success_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_call_sync_failure_records_failure() {
        let cb = CircuitBreaker::with_defaults();

        let result: CircuitResult<i32, &str> = cb.call_sync(|| Err("error"));

        assert!(matches!(result, Err(CircuitError::Service("error"))));
        assert_eq!(cb.metrics().failure_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_call_sync_rejects_when_open() {
        let cb = CircuitBreaker::with_defaults();
        cb.force_open();

        let result: CircuitResult<i32, &str> = cb.call_sync(|| Ok(42));

        assert!(matches!(result, Err(CircuitError::Open(_))));
        assert_eq!(cb.metrics().rejected_count.load(Ordering::Relaxed), 1);
    }

    // ========== RED Phase: Async Call Tests ==========

    #[tokio::test]
    async fn test_call_async_success_passes_through() {
        let cb = CircuitBreaker::with_defaults();

        let result: CircuitResult<i32, &str> = cb.call(|| async { Ok(42) }).await;

        assert_eq!(result.unwrap(), 42);
        assert_eq!(cb.metrics().success_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_call_async_failure_records_failure() {
        let cb = CircuitBreaker::with_defaults();

        let result: CircuitResult<i32, &str> = cb.call(|| async { Err("async error") }).await;

        assert!(matches!(result, Err(CircuitError::Service("async error"))));
        assert_eq!(cb.metrics().failure_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn test_call_async_rejects_when_open() {
        let cb = CircuitBreaker::with_defaults();
        cb.force_open();

        let result: CircuitResult<i32, &str> = cb.call(|| async { Ok(42) }).await;

        assert!(matches!(result, Err(CircuitError::Open(_))));
        assert_eq!(cb.metrics().rejected_count.load(Ordering::Relaxed), 1);
    }

    // ========== RED Phase: Error Display Tests ==========

    #[test]
    fn test_circuit_open_error_display() {
        let err = CircuitOpenError {
            retry_after: Duration::from_secs(30),
            failure_rate: 0.75,
        };

        let msg = format!("{}", err);
        assert!(msg.contains("open"));
        assert!(msg.contains("75"));
    }

    #[test]
    fn test_circuit_error_display() {
        let open_err: CircuitError<&str> = CircuitError::Open(CircuitOpenError {
            retry_after: Duration::from_secs(10),
            failure_rate: 0.5,
        });
        assert!(format!("{}", open_err).contains("open"));

        let service_err: CircuitError<&str> = CircuitError::Service("connection failed");
        assert!(format!("{}", service_err).contains("connection failed"));
    }

    // ========== RED Phase: Recovery Tests ==========

    #[test]
    fn test_success_in_half_open_closes_circuit() {
        let config = CircuitBreakerConfig {
            half_open_calls: 3,
            open_duration: Duration::from_millis(1),
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);
        cb.force_open();

        // Wait for half-open
        std::thread::sleep(Duration::from_millis(5));

        // Trigger half-open and record success
        let _ = cb.check();
        cb.record_success();

        assert_eq!(
            cb.state(),
            CircuitState::Closed,
            "Success in half-open should close circuit"
        );
    }

    #[test]
    fn test_failure_in_half_open_reopens_circuit() {
        let config = CircuitBreakerConfig {
            failure_rate_threshold: 0.5,
            minimum_calls: 1,
            half_open_calls: 3,
            open_duration: Duration::from_millis(1),
            ..Default::default()
        };
        let cb = CircuitBreaker::new(config);
        cb.force_open();

        // Wait for half-open
        std::thread::sleep(Duration::from_millis(5));

        // Trigger half-open and record failure
        let _ = cb.check();
        cb.record_failure();

        assert_eq!(
            cb.state(),
            CircuitState::Open,
            "Failure in half-open should reopen circuit"
        );
    }

    // ========== RED Phase: Graceful Degradation Tests ==========

    #[test]
    fn test_degraded_result_ok_is_not_degraded() {
        let result: DegradedResult<i32> = DegradedResult::ok(42);

        assert_eq!(result.value, 42);
        assert!(!result.degraded);
        assert!(result.reason.is_none());
    }

    #[test]
    fn test_degraded_result_degraded_has_reason() {
        let result: DegradedResult<i32> = DegradedResult::degraded(0, "circuit open");

        assert_eq!(result.value, 0);
        assert!(result.degraded);
        assert_eq!(result.reason.as_deref(), Some("circuit open"));
    }

    #[test]
    fn test_resilient_breaker_starts_closed() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_fallback(CircuitBreakerConfig::default(), 0);

        assert_eq!(rb.state(), CircuitState::Closed);
    }

    #[tokio::test]
    async fn test_resilient_breaker_returns_ok_on_success() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_fallback(CircuitBreakerConfig::default(), -1);

        let result = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        assert!(result.is_ok());
        let degraded = result.unwrap();
        assert_eq!(degraded.value, 42);
        assert!(!degraded.degraded);
    }

    #[tokio::test]
    async fn test_resilient_breaker_returns_fallback_when_open() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_fallback(CircuitBreakerConfig::default(), -1);

        // Force open
        rb.breaker().force_open();

        let result = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        assert!(result.is_ok());
        let degraded = result.unwrap();
        assert_eq!(degraded.value, -1, "Should return fallback value");
        assert!(degraded.degraded, "Should be marked as degraded");
        assert!(degraded.reason.is_some());
    }

    #[tokio::test]
    async fn test_resilient_breaker_stores_last_known_good() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_last_known_good(CircuitBreakerConfig::default());

        // Successful call stores value
        let _ = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        assert_eq!(rb.get_last_known_good(), Some(42));
    }

    #[tokio::test]
    async fn test_resilient_breaker_returns_last_known_good_when_open() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_last_known_good(CircuitBreakerConfig::default());

        // Store a good value
        rb.set_last_known_good(100);

        // Force open
        rb.breaker().force_open();

        let result = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        assert!(result.is_ok());
        let degraded = result.unwrap();
        assert_eq!(degraded.value, 100, "Should return last known good");
        assert!(degraded.degraded);
    }

    #[tokio::test]
    async fn test_resilient_breaker_fails_when_open_no_fallback() {
        let rb: ResilientCircuitBreaker<i32> = ResilientCircuitBreaker::new(
            CircuitBreakerConfig::default(),
            DegradationStrategy::FailFast,
        );

        // Force open
        rb.breaker().force_open();

        let result = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        assert!(matches!(result, Err(CircuitError::Open(_))));
    }

    #[tokio::test]
    async fn test_resilient_breaker_fails_last_known_good_when_none() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_last_known_good(CircuitBreakerConfig::default());

        // Don't set any last known good

        // Force open
        rb.breaker().force_open();

        let result = rb.call_with_fallback(|| async { Ok::<_, &str>(42) }).await;

        // Should fail because no last known good exists
        assert!(matches!(result, Err(CircuitError::Open(_))));
    }

    #[test]
    fn test_set_and_get_last_known_good() {
        let rb: ResilientCircuitBreaker<String> =
            ResilientCircuitBreaker::with_last_known_good(CircuitBreakerConfig::default());

        assert!(rb.get_last_known_good().is_none());

        rb.set_last_known_good("cached".to_string());

        assert_eq!(rb.get_last_known_good(), Some("cached".to_string()));
    }

    #[test]
    fn test_breaker_accessor() {
        let rb: ResilientCircuitBreaker<i32> =
            ResilientCircuitBreaker::with_fallback(CircuitBreakerConfig::default(), 0);

        // Access underlying breaker
        let breaker = rb.breaker();
        assert_eq!(breaker.state(), CircuitState::Closed);
    }
}
