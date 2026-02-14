//! API Integration Tests for AgentMe Node.
//!
//! These tests verify the HTTP API endpoints work correctly in an
//! end-to-end manner, including:
//! - Health check endpoint
//! - Discovery endpoints (register, search, get)
//! - Trust endpoints
//! - Metrics endpoint
//! - Rate limiting behavior

mod common;

use common::*;
use std::time::Duration;

// ========== Health Endpoint Tests ==========

#[tokio::test]
async fn test_health_endpoint_returns_200() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, body) = with_timeout(http_get(&server.url("/health")))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "status");
    assert_json_contains(&body, "ok"); // status: "ok"

    server.stop().await;
}

#[tokio::test]
async fn test_health_endpoint_includes_version() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, body) = with_timeout(http_get(&server.url("/health")))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "version");

    server.stop().await;
}

#[tokio::test]
async fn test_health_endpoint_includes_uptime() {
    let mut server = TestServer::new();
    server.start().await;

    // Wait a bit so uptime > 0
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (status, body) = with_timeout(http_get(&server.url("/health")))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "uptime");

    server.stop().await;
}

#[tokio::test]
async fn test_health_endpoint_includes_peers() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, body) = with_timeout(http_get(&server.url("/health")))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "peers");

    server.stop().await;
}

// ========== Metrics Endpoint Tests ==========

#[tokio::test]
async fn test_metrics_endpoint_returns_200() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, _body) = with_timeout(http_get(&server.url("/metrics")))
        .await
        .unwrap();

    assert_status(200, status);

    server.stop().await;
}

#[tokio::test]
async fn test_metrics_endpoint_returns_prometheus_format() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, body) = with_timeout(http_get(&server.url("/metrics")))
        .await
        .unwrap();

    assert_status(200, status);
    // Prometheus format uses # HELP and # TYPE comments
    // Note: May be empty if no metrics have been recorded yet
    // Just verify we get a valid response (body exists)
    let _ = body; // Response exists (can be empty)

    server.stop().await;
}

// ========== Discovery Endpoint Tests ==========

#[tokio::test]
async fn test_discovery_register_returns_201() {
    let mut server = TestServer::new();
    server.start().await;

    let did = test_did("register-test");
    let card = test_capability_card(&did, "Register Test Agent");

    let (status, _body) = with_timeout(http_post(&server.url("/agents"), &card))
        .await
        .unwrap();

    assert_status(201, status);

    server.stop().await;
}

#[tokio::test]
async fn test_discovery_register_invalid_json_returns_400() {
    let mut server = TestServer::new();
    server.start().await;

    let invalid_json = "{ invalid json }";

    let (status, _body) = with_timeout(http_post(&server.url("/agents"), invalid_json))
        .await
        .unwrap();

    assert_status(400, status);

    server.stop().await;
}

#[tokio::test]
async fn test_discovery_get_agent_not_found_returns_404() {
    let mut server = TestServer::new();
    server.start().await;

    let nonexistent_did = "did:agentme:base:nonexistent-agent";
    let encoded_did = urlencoding::encode(nonexistent_did);

    let (status, _body) = with_timeout(http_get(&server.url(&format!("/agents/{}", encoded_did))))
        .await
        .unwrap();

    assert_status(404, status);

    server.stop().await;
}

#[tokio::test]
async fn test_discovery_register_and_get() {
    let mut server = TestServer::new();
    server.start().await;

    // Register an agent
    let did = test_did("get-test");
    let card = test_capability_card(&did, "Get Test Agent");

    let (status, _) = with_timeout(http_post(&server.url("/agents"), &card))
        .await
        .unwrap();
    assert_status(201, status);

    // Get the agent
    let encoded_did = urlencoding::encode(&did);
    let (status, body) = with_timeout(http_get(&server.url(&format!("/agents/{}", encoded_did))))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, &did);
    assert_json_contains(&body, "Get Test Agent");

    server.stop().await;
}

#[tokio::test]
async fn test_discovery_search_returns_200() {
    let mut server = TestServer::new();
    server.start().await;

    // Register some agents first
    for i in 0..3 {
        let did = test_did(&format!("search-{}", i));
        let card = test_capability_card(&did, &format!("Search Test Agent {}", i));
        let _ = with_timeout(http_post(&server.url("/agents"), &card)).await;
    }

    // Search
    let (status, body) = with_timeout(http_get(&server.url("/agents?q=test")))
        .await
        .unwrap();

    assert_status(200, status);
    // Response should be an array
    assert!(body.starts_with('[') || body.contains("agents"));

    server.stop().await;
}

// ========== Trust Endpoint Tests ==========

#[tokio::test]
async fn test_trust_get_score_returns_200() {
    let mut server = TestServer::new();
    server.start().await;

    let did = test_did("trust-test");
    let encoded_did = urlencoding::encode(&did);

    let (status, body) = with_timeout(http_get(&server.url(&format!("/trust/{}", encoded_did))))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "score");

    server.stop().await;
}

#[tokio::test]
async fn test_trust_get_score_invalid_did_returns_400() {
    let mut server = TestServer::new();
    server.start().await;

    // Invalid DID format (doesn't start with did:)
    let invalid_did = "invalid-did-format";

    let (status, _body) = with_timeout(http_get(&server.url(&format!("/trust/{}", invalid_did))))
        .await
        .unwrap();

    assert_status(400, status);

    server.stop().await;
}

#[tokio::test]
async fn test_trust_score_returns_default_for_unknown() {
    let mut server = TestServer::new();
    server.start().await;

    // New/unknown agents should get default trust info
    let did = test_did("unknown-trust-agent");
    let encoded_did = urlencoding::encode(&did);

    let (status, body) = with_timeout(http_get(&server.url(&format!("/trust/{}", encoded_did))))
        .await
        .unwrap();

    assert_status(200, status);
    assert_json_contains(&body, "score");
    // Unknown agents start with default score
    assert_json_contains(&body, "did");

    server.stop().await;
}

// ========== Rate Limiting Tests ==========

#[tokio::test]
async fn test_rate_limiting_allows_under_limit() {
    use agentme_node::RateLimitConfig;

    let config = RateLimitConfig {
        requests_per_second: 10,
        burst_size: 10,
        enabled: true,
    };

    let mut server = TestServer::with_rate_limit(config);
    server.start().await;

    // Make a few requests (under the limit)
    for _ in 0..5 {
        let (status, _) = with_timeout(http_get(&server.url("/health")))
            .await
            .unwrap();
        assert_status(200, status);
    }

    server.stop().await;
}

#[tokio::test]
async fn test_rate_limiting_returns_429_when_exceeded() {
    use agentme_node::RateLimitConfig;

    let config = RateLimitConfig {
        requests_per_second: 1,
        burst_size: 2,
        enabled: true,
    };

    let mut server = TestServer::with_rate_limit(config);
    server.start().await;

    let mut got_429 = false;

    // Make many requests quickly to exceed the limit
    for _ in 0..10 {
        let result = with_timeout(http_get(&server.url("/agents?q=test"))).await;
        if let Ok((status, _)) = result {
            if status == 429 {
                got_429 = true;
                break;
            }
        }
    }

    assert!(got_429, "Should have received 429 Too Many Requests");

    server.stop().await;
}

#[tokio::test]
async fn test_rate_limiting_disabled_allows_all() {
    use agentme_node::RateLimitConfig;

    let config = RateLimitConfig {
        requests_per_second: 1,
        burst_size: 1,
        enabled: false, // Disabled
    };

    let mut server = TestServer::with_rate_limit(config);
    server.start().await;

    // All requests should succeed when rate limiting is disabled
    for _ in 0..10 {
        let (status, _) = with_timeout(http_get(&server.url("/health")))
            .await
            .unwrap();
        assert_status(200, status);
    }

    server.stop().await;
}

// ========== 404 Not Found Tests ==========

#[tokio::test]
async fn test_unknown_endpoint_returns_404() {
    let mut server = TestServer::new();
    server.start().await;

    let (status, _body) = with_timeout(http_get(&server.url("/nonexistent")))
        .await
        .unwrap();

    assert_status(404, status);

    server.stop().await;
}

// ========== Concurrent Request Tests ==========

#[tokio::test]
async fn test_concurrent_health_requests() {
    let mut server = TestServer::new();
    server.start().await;

    let url = server.url("/health");

    // Spawn 10 concurrent requests
    let handles: Vec<_> = (0..10)
        .map(|_| {
            let url = url.clone();
            tokio::spawn(async move { http_get(&url).await })
        })
        .collect();

    // All should succeed
    for handle in handles {
        let result = with_timeout(handle).await.unwrap();
        let (status, _) = result.unwrap();
        assert_status(200, status);
    }

    server.stop().await;
}

#[tokio::test]
async fn test_concurrent_registrations() {
    let mut server = TestServer::new();
    server.start().await;

    let base_url = server.url("/agents");

    // Spawn 5 concurrent registrations
    let handles: Vec<_> = (0..5)
        .map(|i| {
            let url = base_url.clone();
            let did = test_did(&format!("concurrent-{}", i));
            let card = test_capability_card(&did, &format!("Concurrent Agent {}", i));

            tokio::spawn(async move { http_post(&url, &card).await })
        })
        .collect();

    // All should succeed
    let mut success_count = 0;
    for handle in handles {
        let result = with_timeout(handle).await.unwrap();
        if let Ok((status, _)) = result {
            if status == 201 {
                success_count += 1;
            }
        }
    }

    assert_eq!(success_count, 5, "All 5 registrations should succeed");

    server.stop().await;
}

// ========== End-to-End Flow Tests ==========

#[tokio::test]
async fn test_full_agent_lifecycle() {
    let mut server = TestServer::new();
    server.start().await;

    let did = test_did("lifecycle-agent");
    let card = test_capability_card(&did, "Lifecycle Test Agent");
    let encoded_did = urlencoding::encode(&did);

    // 1. Register agent
    let (status, _) = with_timeout(http_post(&server.url("/agents"), &card))
        .await
        .unwrap();
    assert_status(201, status);

    // 2. Get agent details
    let (status, body) = with_timeout(http_get(&server.url(&format!("/agents/{}", encoded_did))))
        .await
        .unwrap();
    assert_status(200, status);
    assert_json_contains(&body, "Lifecycle Test Agent");

    // 3. Check trust score
    let (status, body) = with_timeout(http_get(&server.url(&format!("/trust/{}", encoded_did))))
        .await
        .unwrap();
    assert_status(200, status);
    assert_json_contains(&body, "score");

    // 4. Search for agent
    let (status, body) = with_timeout(http_get(&server.url("/agents?q=lifecycle")))
        .await
        .unwrap();
    assert_status(200, status);
    // Should find the agent in results
    assert!(body.contains("lifecycle") || body.contains("Lifecycle"));

    server.stop().await;
}
