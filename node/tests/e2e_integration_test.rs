//! End-to-End Integration Tests for AgoraMesh Node.
//!
//! These tests verify complete system flows spanning multiple components:
//! - Full arbitration lifecycle (dispute → evidence → ruling)
//! - Trust score calculations with real data
//! - Discovery + Trust integration
//! - Multi-agent interaction scenarios
//!
//! ## Running Tests
//!
//! ```bash
//! cargo test --test e2e_integration_test -- --test-threads=1
//! ```

use std::sync::Arc;

use agoramesh_node::{
    discovery::{AgoraMeshExtension, Capability, CapabilityCard},
    trust::TrustInfo,
    AIArbitrationConfig, AIArbitrator, CircuitBreaker, CircuitBreakerConfig, CircuitState,
    DiscoveryService, Evidence, EvidenceType, JurorPool, JurorPoolConfig, TrustCache,
    TrustCacheConfig, TrustService,
};

// ============================================================================
// Arbitration Lifecycle Tests
// ============================================================================

#[tokio::test]
async fn test_tier1_disputes_rejected_by_ai_arbitrator() {
    // Tier 1 disputes (<$10) should be handled by automatic resolution,
    // not the AI arbitrator. The AIArbitrator should reject them.
    let config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(config).unwrap();

    // Attempt to create a Tier 1 dispute ($5)
    let result = arbitrator.create_dispute(
        "escrow-tier1-test",
        "did:agoramesh:base:client",
        "did:agoramesh:base:provider",
        5_000_000, // $5 USDC - below Tier 2 minimum
    );

    // Should be rejected - Tier 1 uses automatic resolution
    assert!(
        result.is_err(),
        "Tier 1 disputes should be rejected by AIArbitrator"
    );
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("below Tier 2 minimum"),
        "Error should mention Tier 2 minimum, got: {}",
        err
    );
}

#[tokio::test]
async fn test_tier2_dispute_minimum_boundary() {
    // Test at the exact Tier 2 boundary ($10)
    let config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(config).unwrap();

    // Create a dispute at exactly $10 (Tier 2 minimum)
    let dispute_id = arbitrator
        .create_dispute(
            "escrow-tier2-boundary",
            "did:agoramesh:base:client",
            "did:agoramesh:base:provider",
            10_000_000, // $10 USDC - exactly Tier 2 minimum
        )
        .unwrap();

    // Verify dispute was created
    let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.amount_usdc, 10_000_000, "Amount should match");
    assert_eq!(dispute.client_did, "did:agoramesh:base:client");
    assert_eq!(dispute.provider_did, "did:agoramesh:base:provider");
}

#[tokio::test]
async fn test_full_dispute_lifecycle_tier2_with_evidence() {
    // Tier 2 disputes ($10-$1000) use AI analysis
    let config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(config).unwrap();

    // Create a medium dispute ($100)
    let dispute_id = arbitrator
        .create_dispute(
            "escrow-tier2-evidence",
            "did:agoramesh:base:client-2",
            "did:agoramesh:base:provider-2",
            100_000_000, // $100 USDC
        )
        .unwrap();

    // Submit evidence from client
    let client_evidence = Evidence::new(
        "did:agoramesh:base:client-2",
        EvidenceType::Text,
        "Service Not Delivered",
        "The provider failed to deliver the agreed service within the deadline.",
    );
    arbitrator
        .submit_evidence(&dispute_id, client_evidence)
        .unwrap();

    // Submit evidence from provider
    let provider_evidence = Evidence::new(
        "did:agoramesh:base:provider-2",
        EvidenceType::Text,
        "Service Delivered on Time",
        "Service was delivered as agreed. Here is the proof of completion.",
    );
    arbitrator
        .submit_evidence(&dispute_id, provider_evidence)
        .unwrap();

    // Verify evidence was recorded
    let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
    assert_eq!(
        dispute.total_evidence_count(),
        2,
        "Should have 2 evidence items"
    );
}

#[tokio::test]
async fn test_full_dispute_lifecycle_tier3_juror_selection() {
    // Tier 3 disputes (>$1000) require community arbitration
    let config = JurorPoolConfig::default().with_juror_count(3);
    let pool = JurorPool::new(config);

    // Register a pool of jurors
    for i in 0..20 {
        pool.register_juror(
            format!("did:agoramesh:base:juror-e2e-{}", i),
            200_000_000 + (i as u64) * 50_000_000, // $200-$1150 stakes
            vec![0],                               // tier 0 qualified
        )
        .unwrap();
    }

    // Verify pool is ready
    assert_eq!(pool.selectable_count().unwrap(), 20);

    // Select jurors for a dispute
    let selected = pool.select_jurors(0, 3, 12345).unwrap();
    assert_eq!(selected.len(), 3, "Should select 3 jurors");

    // Verify all selected jurors are unique
    let unique: std::collections::HashSet<_> = selected.iter().collect();
    assert_eq!(unique.len(), 3, "All jurors should be unique");
}

#[tokio::test]
async fn test_juror_voting_session_creation() {
    let config = JurorPoolConfig::default().with_juror_count(3);
    let pool = JurorPool::new(config);

    // Register jurors
    for i in 0..10 {
        pool.register_juror(
            format!("did:agoramesh:base:voter-{}", i),
            500_000_000, // $500 stake
            vec![0],
        )
        .unwrap();
    }

    // Create a voting session
    let session_id = pool.create_session("dispute-voting-test", 0).unwrap();

    // Session ID should be returned
    assert!(!session_id.is_empty(), "Session ID should be non-empty");
}

// ============================================================================
// Trust Calculation Integration Tests
// ============================================================================

#[tokio::test]
async fn test_trust_score_for_new_agent() {
    // New agents should start with zero trust
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);
    let did = "did:agoramesh:base:new-trust-test";

    let trust = service.get_trust(did).await.unwrap();

    // New agents start with zero trust (no on-chain activity)
    assert_eq!(trust.score, 0.0, "New agent should have zero trust");
    assert_eq!(trust.reputation, 0.0);
    assert_eq!(trust.stake_score, 0.0);
    assert_eq!(trust.endorsement_score, 0.0);
}

#[tokio::test]
async fn test_trust_verification() {
    // Test the verify function
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);
    let did = "did:agoramesh:base:verify-test";

    // New agent with zero trust shouldn't pass any threshold
    let passes_low = service.verify(did, 0.1).await.unwrap();
    assert!(!passes_low, "New agent should not pass 0.1 threshold");

    // But should pass zero threshold
    let passes_zero = service.verify(did, 0.0).await.unwrap();
    assert!(passes_zero, "Any agent should pass 0.0 threshold");
}

#[tokio::test]
async fn test_trust_cache_operations() {
    // Test that trust cache maintains consistency
    let config = TrustCacheConfig::default();
    let cache = TrustCache::new(config);

    let did = "did:agoramesh:base:cache-test";
    let info = TrustInfo {
        did: did.to_string(),
        score: 0.85,
        reputation: 0.9,
        stake_score: 0.8,
        endorsement_score: 0.7,
        stake_amount: 1_000_000_000,
        successful_transactions: 100,
        failed_transactions: 5,
        endorsement_count: 10,
    };

    // Insert into cache
    cache.insert(did, info.clone()).await;

    // Retrieve and verify
    let cached = cache.get(did).await.unwrap();
    assert_eq!(cached.info.score, 0.85);
    assert_eq!(cached.info.reputation, 0.9);
    assert_eq!(cached.info.stake_amount, 1_000_000_000);

    // Update with new data
    let updated_info = TrustInfo {
        did: did.to_string(),
        score: 0.90,
        reputation: 0.95,
        stake_score: 0.85,
        endorsement_score: 0.75,
        stake_amount: 1_500_000_000,
        successful_transactions: 150,
        failed_transactions: 5,
        endorsement_count: 15,
    };
    cache.insert(did, updated_info).await;

    // Verify update was applied
    let cached_updated = cache.get(did).await.unwrap();
    assert_eq!(cached_updated.info.score, 0.90);
    assert_eq!(cached_updated.info.stake_amount, 1_500_000_000);
}

#[tokio::test]
async fn test_trust_endorsement_recording() {
    // Test adding endorsements
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);

    let endorser = "did:agoramesh:base:endorser";
    let target = "did:agoramesh:base:endorsed";

    // Add endorsement
    service
        .add_endorsement_with_hop(endorser, target, 1)
        .await
        .unwrap();

    // Get target's trust info
    let trust = service.get_trust(target).await.unwrap();

    // Endorsement count should increase
    assert_eq!(
        trust.endorsement_count, 1,
        "Should have 1 endorsement recorded"
    );
}

// ============================================================================
// Discovery + Trust Integration Tests
// ============================================================================

#[tokio::test]
async fn test_discovered_agents_have_trust_data() {
    // When an agent is discovered, we should be able to query their trust
    let discovery = DiscoveryService::new();
    let trust = TrustService::new("https://sepolia.base.org".to_string(), None);

    let did = "did:agoramesh:base:discovered-agent";

    // Register an agent
    let card = CapabilityCard {
        name: "Discovered Agent".to_string(),
        description: "An agent discovered through the network".to_string(),
        url: "https://agent.example.com/a2a".to_string(),
        provider: None,
        capabilities: vec![Capability {
            id: "analysis".to_string(),
            name: "Analysis".to_string(),
            description: Some("Provides analysis services".to_string()),
            input_schema: None,
            output_schema: None,
        }],
        authentication: None,
        agoramesh: Some(AgoraMeshExtension {
            did: did.to_string(),
            trust_score: Some(0.75),
            stake: Some(500_000_000),
            pricing: None,
            payment_methods: vec!["x402".to_string()],
        }),
    };

    discovery.register(&card).await.unwrap();

    // Verify agent is discoverable
    let found = discovery.get(did).await.unwrap();
    assert!(found.is_some(), "Agent should be found");

    // Query trust for the discovered agent
    let trust_info = trust.get_trust(did).await.unwrap();
    assert_eq!(trust_info.did, did);

    // New agents start with zero trust (until they have on-chain activity)
    assert_eq!(trust_info.score, 0.0);
}

#[tokio::test]
async fn test_search_returns_registered_agents() {
    // Search results should find registered agents
    let discovery = DiscoveryService::new();

    // Register multiple agents
    for i in 0..5 {
        let did = format!("did:agoramesh:base:searchable-{}", i);

        let card = CapabilityCard {
            name: format!("Searchable Agent {}", i),
            description: "Agent for search test".to_string(),
            url: format!("https://agent{}.example.com/a2a", i),
            provider: None,
            capabilities: vec![Capability {
                id: "service".to_string(),
                name: "Service".to_string(),
                description: Some("Generic service".to_string()),
                input_schema: None,
                output_schema: None,
            }],
            authentication: None,
            agoramesh: Some(AgoraMeshExtension {
                did,
                trust_score: Some(0.5 + (i as f64 * 0.1)),
                stake: Some(500_000_000),
                pricing: None,
                payment_methods: vec!["x402".to_string()],
            }),
        };

        discovery.register(&card).await.unwrap();
    }

    // Search for agents
    let results = discovery.search("agent").await.unwrap();

    // Should return agents
    assert!(!results.is_empty(), "Should find agents");
}

// ============================================================================
// Circuit Breaker Integration Tests
// ============================================================================

#[tokio::test]
async fn test_circuit_breaker_starts_closed() {
    // Circuit breaker should start in closed state
    let config = CircuitBreakerConfig::default();
    let breaker = CircuitBreaker::new(config);

    assert_eq!(
        breaker.state(),
        CircuitState::Closed,
        "Circuit should start closed"
    );
}

#[tokio::test]
async fn test_circuit_breaker_allows_calls_when_closed() {
    // Closed circuit should allow calls
    let config = CircuitBreakerConfig::default();
    let breaker = CircuitBreaker::new(config);

    // Should allow check when closed
    let result = breaker.check();
    assert!(result.is_ok(), "Closed circuit should allow calls");
}

#[tokio::test]
async fn test_circuit_breaker_has_metrics() {
    // Circuit breaker should track metrics
    let config = CircuitBreakerConfig::default();
    let breaker = CircuitBreaker::new(config);

    let metrics = breaker.metrics();

    // Metrics should exist (even if all zeros initially)
    assert_eq!(metrics.total_calls(), 0);
}

// ============================================================================
// Multi-Agent Scenario Tests
// ============================================================================

#[tokio::test]
async fn test_multi_agent_collaboration_setup() {
    // Test setting up multiple agents that could collaborate
    let discovery = DiscoveryService::new();
    let cache = TrustCache::new(TrustCacheConfig::default());

    // Create a network of collaborating agents
    let agents = vec![
        (
            "did:agoramesh:base:coordinator",
            "Coordinator Agent",
            vec!["orchestration"],
        ),
        (
            "did:agoramesh:base:analyzer",
            "Analyzer Agent",
            vec!["analysis", "data-processing"],
        ),
        (
            "did:agoramesh:base:executor",
            "Executor Agent",
            vec!["task-execution"],
        ),
    ];

    for (did, name, capabilities) in &agents {
        let card = CapabilityCard {
            name: name.to_string(),
            description: format!("{} for multi-agent collaboration", name),
            url: format!(
                "https://{}.example.com/a2a",
                did.split(':').next_back().unwrap()
            ),
            provider: None,
            capabilities: capabilities
                .iter()
                .map(|c| Capability {
                    id: c.to_string(),
                    name: c.to_string(),
                    description: None,
                    input_schema: None,
                    output_schema: None,
                })
                .collect(),
            authentication: None,
            agoramesh: Some(AgoraMeshExtension {
                did: did.to_string(),
                trust_score: Some(0.9),
                stake: Some(1_000_000_000),
                pricing: None,
                payment_methods: vec!["x402".to_string()],
            }),
        };

        discovery.register(&card).await.unwrap();

        // Pre-populate trust cache
        let trust_info = TrustInfo {
            did: did.to_string(),
            score: 0.9,
            reputation: 0.95,
            stake_score: 0.85,
            endorsement_score: 0.8,
            stake_amount: 1_000_000_000,
            successful_transactions: 50,
            failed_transactions: 2,
            endorsement_count: 5,
        };
        cache.insert(did, trust_info).await;
    }

    // Verify all agents are discoverable
    for (did, _, _) in &agents {
        let found = discovery.get(did).await.unwrap();
        assert!(found.is_some(), "Agent {} should be found", did);

        let trust = cache.get(did).await;
        assert!(trust.is_some(), "Agent {} should have trust data", did);
    }
}

#[tokio::test]
async fn test_escrow_dispute_resolution_flow() {
    // Simulate a complete escrow dispute flow (without actual blockchain)
    let arbitration_config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(arbitration_config).unwrap();

    let client_did = "did:agoramesh:base:escrow-client";
    let provider_did = "did:agoramesh:base:escrow-provider";

    // 1. Create dispute for escrow
    let dispute_id = arbitrator
        .create_dispute("escrow-flow-test", client_did, provider_did, 50_000_000)
        .unwrap();

    // 2. Client submits evidence
    let client_evidence = Evidence::new(
        client_did,
        EvidenceType::Text,
        "Incomplete Delivery",
        "Provider only completed 60% of the agreed work.",
    );
    arbitrator
        .submit_evidence(&dispute_id, client_evidence)
        .unwrap();

    // 3. Provider submits counter-evidence
    let provider_evidence = Evidence::new(
        provider_did,
        EvidenceType::Text,
        "Full Delivery with Proof",
        "All deliverables completed. Attached logs show 100% completion.",
    );
    arbitrator
        .submit_evidence(&dispute_id, provider_evidence)
        .unwrap();

    // 4. Verify dispute state
    let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.total_evidence_count(), 2);
    assert_eq!(dispute.client_did, client_did);
    assert_eq!(dispute.provider_did, provider_did);
}

// ============================================================================
// Stress and Consistency Tests
// ============================================================================

#[tokio::test]
async fn test_concurrent_agent_operations() {
    // Test that concurrent operations don't cause data corruption
    let discovery = Arc::new(DiscoveryService::new());

    let mut handles = vec![];

    // Spawn multiple concurrent registrations
    for i in 0..20 {
        let discovery = Arc::clone(&discovery);
        let handle = tokio::spawn(async move {
            let did = format!("did:agoramesh:base:concurrent-e2e-{}", i);
            let card = CapabilityCard {
                name: format!("Concurrent Agent {}", i),
                description: "Agent for concurrency test".to_string(),
                url: format!("https://concurrent{}.example.com/a2a", i),
                provider: None,
                capabilities: vec![],
                authentication: None,
                agoramesh: Some(AgoraMeshExtension {
                    did: did.clone(),
                    trust_score: Some(0.8),
                    stake: Some(500_000_000),
                    pricing: None,
                    payment_methods: vec!["x402".to_string()],
                }),
            };
            discovery.register(&card).await.unwrap();
            did
        });
        handles.push(handle);
    }

    // Wait for all registrations
    let dids: Vec<String> = futures::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    assert_eq!(dids.len(), 20, "All registrations should succeed");

    // Verify all agents are findable
    for did in &dids {
        let found = discovery.get(did).await.unwrap();
        assert!(found.is_some(), "Agent {} should be found", did);
    }
}

#[tokio::test]
async fn test_trust_cache_under_concurrent_access() {
    // Test cache consistency under concurrent reads and writes
    let cache = Arc::new(TrustCache::new(TrustCacheConfig::default()));

    let mut handles = vec![];

    // Writers
    for i in 0..10 {
        let cache = Arc::clone(&cache);
        handles.push(tokio::spawn(async move {
            for j in 0..10 {
                let did = format!("did:agoramesh:base:cache-stress-{}", (i * 10 + j) % 20);
                let info = TrustInfo {
                    did: did.clone(),
                    score: 0.5 + (i as f64 * 0.01),
                    reputation: 0.8,
                    stake_score: 0.7,
                    endorsement_score: 0.6,
                    stake_amount: 1_000_000_000,
                    successful_transactions: 100,
                    failed_transactions: 5,
                    endorsement_count: 3,
                };
                cache.insert(&did, info).await;
            }
        }));
    }

    // Readers
    for i in 0..10 {
        let cache = Arc::clone(&cache);
        handles.push(tokio::spawn(async move {
            for j in 0..10 {
                let did = format!("did:agoramesh:base:cache-stress-{}", (i * 10 + j) % 20);
                let _ = cache.get(&did).await;
            }
        }));
    }

    // Wait for all operations
    futures::future::join_all(handles).await;

    // Verify cache stats are sane
    let stats = cache.stats();
    // Stats should exist without panicking
    let _ = stats.hits;
    let _ = stats.misses;
}

// ============================================================================
// Transaction Recording Tests
// ============================================================================

#[tokio::test]
async fn test_record_success_updates_trust() {
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);
    let did = "did:agoramesh:base:success-recording";

    // Record successful transaction
    service.record_success(did, 1_000_000).await.unwrap();

    // Check trust info
    let trust = service.get_trust(did).await.unwrap();
    assert_eq!(trust.successful_transactions, 1);
    assert_eq!(trust.failed_transactions, 0);
}

#[tokio::test]
async fn test_record_failure_updates_trust() {
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);
    let did = "did:agoramesh:base:failure-recording";

    // Record failed transaction
    service.record_failure(did, "timeout").await.unwrap();

    // Check trust info
    let trust = service.get_trust(did).await.unwrap();
    assert_eq!(trust.successful_transactions, 0);
    assert_eq!(trust.failed_transactions, 1);
}

#[tokio::test]
async fn test_mixed_transactions_affect_reputation() {
    let service = TrustService::new("https://sepolia.base.org".to_string(), None);
    let did = "did:agoramesh:base:mixed-transactions";

    // Record 8 successes and 2 failures (80% success rate)
    for _ in 0..8 {
        service.record_success(did, 100_000).await.unwrap();
    }
    for _ in 0..2 {
        service.record_failure(did, "error").await.unwrap();
    }

    // Check trust info
    let trust = service.get_trust(did).await.unwrap();
    assert_eq!(trust.successful_transactions, 8);
    assert_eq!(trust.failed_transactions, 2);
    assert!(
        trust.reputation > 0.0,
        "Should have positive reputation with 80% success"
    );
}
