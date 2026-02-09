//! Common test utilities for AgentMesh Node integration tests.
//!
//! This module provides shared fixtures, helpers, and mock implementations
//! for integration testing across the Node crate.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agentmesh_node::{
    ApiConfig, ApiServer, AppState, DiscoveryService, MetricsConfig, MetricsService,
    RateLimitConfig, RateLimitService,
};
use tokio::sync::mpsc;

// ========== Test Configuration ==========

/// Default test timeout duration.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Get a unique port for testing (to avoid conflicts).
static PORT_COUNTER: AtomicU64 = AtomicU64::new(18080);

pub fn get_test_port() -> u16 {
    PORT_COUNTER.fetch_add(1, Ordering::SeqCst) as u16
}

/// Get a test socket address.
pub fn get_test_addr() -> String {
    format!("127.0.0.1:{}", get_test_port())
}

// ========== Test Fixtures ==========

/// Test fixture for API server with default configuration.
pub struct TestServer {
    pub addr: String,
    pub state: AppState,
    shutdown_tx: Option<mpsc::Sender<()>>,
}

impl TestServer {
    /// Create a new test server (not started).
    pub fn new() -> Self {
        let addr = get_test_addr();
        let state = create_test_state();

        Self {
            addr,
            state,
            shutdown_tx: None,
        }
    }

    /// Create a test server with custom rate limit config.
    pub fn with_rate_limit(rate_limit_config: RateLimitConfig) -> Self {
        let addr = get_test_addr();
        let state = create_test_state_with_rate_limit(rate_limit_config);

        Self {
            addr,
            state,
            shutdown_tx: None,
        }
    }

    /// Get the full URL for an endpoint.
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    /// Start the server in a background task.
    pub async fn start(&mut self) {
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        self.shutdown_tx = Some(shutdown_tx);

        let api_config = ApiConfig {
            listen_address: self.addr.clone(),
            cors_enabled: true,
            cors_origins: vec!["*".to_string()],
            trust_proxy: false,
            admin_token: None,
        };

        let server = ApiServer::with_state(api_config, self.state.clone());
        let addr = self.addr.clone();

        tokio::spawn(async move {
            tokio::select! {
                result = server.run(&addr) => {
                    if let Err(e) = result {
                        eprintln!("Test server error: {}", e);
                    }
                }
                _ = shutdown_rx.recv() => {
                    // Graceful shutdown
                }
            }
        });

        // Wait for server to be ready
        wait_for_server(&self.addr).await;
    }

    /// Stop the server.
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(()).await;
        }
    }
}

impl Default for TestServer {
    fn default() -> Self {
        Self::new()
    }
}

// ========== State Factory Functions ==========

/// Create a test AppState with default configuration.
pub fn create_test_state() -> AppState {
    AppState {
        discovery: Arc::new(DiscoveryService::new()),
        trust: Arc::new(agentmesh_node::TrustService::new(
            "https://sepolia.base.org".to_string(),
            None,
        )),
        start_time: Instant::now(),
        peer_count: Arc::new(AtomicU64::new(0)),
        node_info: None, // No node info for tests (optional field)
        rate_limiter: Arc::new(RateLimitService::new(RateLimitConfig::default())),
        metrics: Arc::new(MetricsService::new(MetricsConfig::default())),
        hybrid_search: None,
        api_token: None,
    }
}

/// Create a test AppState with custom rate limiting.
pub fn create_test_state_with_rate_limit(config: RateLimitConfig) -> AppState {
    AppState {
        discovery: Arc::new(DiscoveryService::new()),
        trust: Arc::new(agentmesh_node::TrustService::new(
            "https://sepolia.base.org".to_string(),
            None,
        )),
        start_time: Instant::now(),
        peer_count: Arc::new(AtomicU64::new(0)),
        node_info: None, // No node info for tests (optional field)
        rate_limiter: Arc::new(RateLimitService::new(config)),
        metrics: Arc::new(MetricsService::new(MetricsConfig::default())),
        hybrid_search: None,
        api_token: None,
    }
}

// ========== HTTP Client Helpers ==========

/// Simple HTTP GET request.
pub async fn http_get(url: &str) -> Result<(u16, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let url = url.trim_start_matches("http://");
    let (host_port, path) = url
        .split_once('/')
        .map(|(h, p)| (h, format!("/{}", p)))
        .unwrap_or((url, "/".to_string()));

    let mut stream = TcpStream::connect(host_port)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_port
    );

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("Write failed: {}", e))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;

    let response_str = String::from_utf8_lossy(&response);

    // Parse status code
    let status_line = response_str
        .lines()
        .next()
        .ok_or_else(|| "Empty response".to_string())?;

    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Invalid status code".to_string())?;

    // Parse body
    let body = response_str
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or("")
        .to_string();

    Ok((status_code, body))
}

/// Simple HTTP POST request with JSON body.
pub async fn http_post(url: &str, body: &str) -> Result<(u16, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let url = url.trim_start_matches("http://");
    let (host_port, path) = url
        .split_once('/')
        .map(|(h, p)| (h, format!("/{}", p)))
        .unwrap_or((url, "/".to_string()));

    let mut stream = TcpStream::connect(host_port)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, host_port, body.len(), body
    );

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("Write failed: {}", e))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;

    let response_str = String::from_utf8_lossy(&response);

    // Parse status code
    let status_line = response_str
        .lines()
        .next()
        .ok_or_else(|| "Empty response".to_string())?;

    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Invalid status code".to_string())?;

    // Parse body
    let body = response_str
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or("")
        .to_string();

    Ok((status_code, body))
}

// ========== Wait Helpers ==========

/// Wait for a server to be ready (up to 5 seconds).
pub async fn wait_for_server(addr: &str) {
    use tokio::net::TcpStream;

    for _ in 0..50 {
        if TcpStream::connect(addr).await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    panic!("Server at {} failed to start within 5 seconds", addr);
}

/// Wait with timeout helper.
pub async fn with_timeout<F, T>(future: F) -> T
where
    F: std::future::Future<Output = T>,
{
    tokio::time::timeout(TEST_TIMEOUT, future)
        .await
        .expect("Test timed out")
}

// ========== Assertion Helpers ==========

/// Assert that a JSON response contains expected fields.
pub fn assert_json_contains(json: &str, field: &str) {
    assert!(
        json.contains(field),
        "JSON response should contain '{}', got: {}",
        field,
        json
    );
}

/// Assert HTTP status code.
pub fn assert_status(expected: u16, actual: u16) {
    assert_eq!(
        expected, actual,
        "Expected HTTP status {}, got {}",
        expected, actual
    );
}

// ========== Test Data Generators ==========

/// Generate a test DID.
pub fn test_did(suffix: &str) -> String {
    format!("did:agentmesh:base:test-{}", suffix)
}

/// Generate a test capability card JSON.
/// Note: `did` is used in the x-agentmesh extension, `name` is the agent name.
pub fn test_capability_card(did: &str, name: &str) -> String {
    format!(
        r#"{{
            "name": "{}",
            "description": "Test agent for integration testing",
            "url": "https://test.example.com/agents/{}",
            "capabilities": [
                {{
                    "id": "test-skill",
                    "name": "Test Skill",
                    "description": "A test skill"
                }}
            ],
            "provider": {{
                "organization": "Test Provider",
                "url": "https://test.example.com"
            }},
            "x-agentmesh": {{
                "did": "{}",
                "payment_methods": ["x402"]
            }}
        }}"#,
        name, did, did
    )
}
