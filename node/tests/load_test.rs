//! Load Testing for AgentMe P2P Network
//!
//! Integration tests that verify system behavior under load:
//! - Concurrent discovery operations
//! - High-volume trust cache operations
//! - Parallel dispute processing
//! - Stress testing juror selection
//!
//! ## Running Load Tests
//!
//! ```bash
//! cargo test --test load_test -- --test-threads=1
//! cargo test --test load_test concurrent -- --nocapture
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agentme_node::{
    discovery::{AgentMeExtension, Capability, CapabilityCard},
    trust::TrustInfo,
    AIArbitrationConfig, AIArbitrator, Evidence, EvidenceType, JurorPool, JurorPoolConfig,
    TrustCache, TrustCacheConfig,
};

// ============================================================================
// Test Configuration
// ============================================================================

const CONCURRENT_OPERATIONS: usize = 100;
const HIGH_LOAD_OPERATIONS: usize = 1000;
const STRESS_TEST_DURATION_SECS: u64 = 5;

// ============================================================================
// Discovery Load Tests
// ============================================================================

#[tokio::test]
async fn test_concurrent_discovery_registration() {
    // Test registering many capability cards concurrently
    let cards: Vec<_> = (0..CONCURRENT_OPERATIONS)
        .map(|i| create_test_card(&format!("did:agentme:base:concurrent-{}", i)))
        .collect();

    let start = Instant::now();

    // Simulate concurrent registration (using HashMap as cache, keyed by DID from extension)
    let cache = Arc::new(tokio::sync::RwLock::new(
        HashMap::<String, CapabilityCard>::new(),
    ));

    let mut handles = vec![];
    for card in cards {
        let cache = Arc::clone(&cache);
        let handle = tokio::spawn(async move {
            let did = card
                .agentme
                .as_ref()
                .map(|ext| ext.did.clone())
                .unwrap_or_default();
            let mut guard = cache.write().await;
            guard.insert(did, card);
        });
        handles.push(handle);
    }

    // Wait for all operations to complete
    for handle in handles {
        handle.await.unwrap();
    }

    let duration = start.elapsed();
    let cache = cache.read().await;

    assert_eq!(cache.len(), CONCURRENT_OPERATIONS);
    println!(
        "Concurrent registration of {} cards took {:?} ({:.2} ops/sec)",
        CONCURRENT_OPERATIONS,
        duration,
        CONCURRENT_OPERATIONS as f64 / duration.as_secs_f64()
    );
}

#[tokio::test]
async fn test_high_volume_discovery_search() {
    // Pre-populate with many cards
    let cards: HashMap<String, CapabilityCard> = (0..HIGH_LOAD_OPERATIONS)
        .map(|i| {
            let card = create_test_card(&format!("did:agentme:base:search-{}", i));
            let did = card
                .agentme
                .as_ref()
                .map(|ext| ext.did.clone())
                .unwrap_or_default();
            (did, card)
        })
        .collect();

    let queries = vec![
        "code review",
        "analysis",
        "testing",
        "benchmark",
        "security",
    ];

    let start = Instant::now();
    let mut total_results = 0;

    // Run many searches
    for _ in 0..100 {
        for query in &queries {
            let results: Vec<_> = cards
                .values()
                .filter(|c| c.description.to_lowercase().contains(query))
                .collect();
            total_results += results.len();
        }
    }

    let duration = start.elapsed();
    println!(
        "500 searches across {} cards took {:?} ({:.2} searches/sec)",
        HIGH_LOAD_OPERATIONS,
        duration,
        500.0 / duration.as_secs_f64()
    );
    assert!(total_results > 0, "Should find some results");
}

// ============================================================================
// Trust Cache Load Tests
// ============================================================================

#[tokio::test]
async fn test_concurrent_trust_cache_operations() {
    let config = TrustCacheConfig::default();
    let cache = Arc::new(TrustCache::new(config));

    let start = Instant::now();
    let mut handles = vec![];

    // Concurrent writes
    for i in 0..CONCURRENT_OPERATIONS {
        let cache = Arc::clone(&cache);
        let handle = tokio::spawn(async move {
            let did = format!("did:agentme:base:trust-write-{}", i);
            let info = TrustInfo {
                did: did.clone(),
                score: 0.5 + (i as f64 * 0.004),
                reputation: 0.8,
                stake_score: 0.7,
                endorsement_score: 0.6,
                stake_amount: 1_000_000_000,
                successful_transactions: 100,
                failed_transactions: 5,
                endorsement_count: 3,
            };
            cache.insert(&did, info).await;
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    let write_duration = start.elapsed();

    // Concurrent reads
    let start = Instant::now();
    let mut handles = vec![];

    for i in 0..CONCURRENT_OPERATIONS {
        let cache = Arc::clone(&cache);
        let handle = tokio::spawn(async move {
            let did = format!("did:agentme:base:trust-write-{}", i);
            cache.get(&did).await
        });
        handles.push(handle);
    }

    let mut hits = 0;
    for handle in handles {
        if handle.await.unwrap().is_some() {
            hits += 1;
        }
    }

    let read_duration = start.elapsed();

    println!(
        "Trust cache: {} writes took {:?}, {} reads ({} hits) took {:?}",
        CONCURRENT_OPERATIONS, write_duration, CONCURRENT_OPERATIONS, hits, read_duration
    );

    assert!(hits > 0, "Should have cache hits");
}

#[tokio::test]
async fn test_trust_cache_stress() {
    let config = TrustCacheConfig::default();
    let cache = Arc::new(TrustCache::new(config));
    let counter = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    let mut handles = vec![];

    // Spawn workers that continuously read/write
    for worker_id in 0..10 {
        let cache = Arc::clone(&cache);
        let counter = Arc::clone(&counter);

        let handle = tokio::spawn(async move {
            let mut local_ops = 0u64;
            let deadline = Instant::now() + Duration::from_secs(STRESS_TEST_DURATION_SECS);

            while Instant::now() < deadline {
                let op_num = local_ops;
                let did = format!("did:agentme:base:stress-{}-{}", worker_id, op_num % 100);

                if op_num.is_multiple_of(3) {
                    // Write
                    let score = 0.5 + (op_num as f64 * 0.001) % 0.5;
                    let info = TrustInfo {
                        did: did.clone(),
                        score,
                        reputation: 0.8,
                        stake_score: 0.7,
                        endorsement_score: 0.6,
                        stake_amount: 1_000_000_000,
                        successful_transactions: 100,
                        failed_transactions: 5,
                        endorsement_count: 3,
                    };
                    cache.insert(&did, info).await;
                } else {
                    // Read
                    let _ = cache.get(&did).await;
                }

                local_ops += 1;
            }

            counter.fetch_add(local_ops, Ordering::Relaxed);
        });

        handles.push(handle);
    }

    for handle in handles {
        handle.await.unwrap();
    }

    let duration = start.elapsed();
    let total_ops = counter.load(Ordering::Relaxed);

    println!(
        "Trust cache stress: {} ops in {:?} ({:.2} ops/sec)",
        total_ops,
        duration,
        total_ops as f64 / duration.as_secs_f64()
    );

    assert!(
        total_ops > 1000,
        "Should complete many operations, got {}",
        total_ops
    );
}

// ============================================================================
// Arbitration Load Tests
// ============================================================================

#[tokio::test]
async fn test_concurrent_dispute_creation() {
    let config = AIArbitrationConfig::default();
    let arbitrator = Arc::new(AIArbitrator::new(config).unwrap());

    let start = Instant::now();
    let mut handles = vec![];

    for i in 0..CONCURRENT_OPERATIONS {
        let arbitrator = Arc::clone(&arbitrator);
        let handle = tokio::spawn(async move {
            arbitrator.create_dispute(
                format!("escrow-load-{}", i),
                format!("did:client-{}", i),
                format!("did:provider-{}", i),
                100_000_000 + (i as u64 * 1_000_000), // $100-$199
            )
        });
        handles.push(handle);
    }

    let mut created = 0;
    for handle in handles {
        if handle.await.unwrap().is_ok() {
            created += 1;
        }
    }

    let duration = start.elapsed();

    println!(
        "Created {} disputes in {:?} ({:.2} disputes/sec)",
        created,
        duration,
        created as f64 / duration.as_secs_f64()
    );

    assert_eq!(created, CONCURRENT_OPERATIONS);
}

#[tokio::test]
async fn test_evidence_submission_throughput() {
    let config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(config).unwrap();

    // Create a dispute
    let dispute_id = arbitrator
        .create_dispute(
            "escrow-evidence-test",
            "did:client",
            "did:provider",
            100_000_000,
        )
        .unwrap();

    let start = Instant::now();
    let mut submitted = 0;

    // Submit max evidence
    for i in 0..10 {
        let evidence = Evidence::new(
            "did:client",
            EvidenceType::Text,
            format!("Evidence {}", i),
            format!(
                "This is evidence item number {} with detailed description.",
                i
            ),
        );

        if arbitrator.submit_evidence(&dispute_id, evidence).is_ok() {
            submitted += 1;
        }
    }

    let duration = start.elapsed();

    println!(
        "Submitted {} evidence items in {:?} ({:.2} items/sec)",
        submitted,
        duration,
        submitted as f64 / duration.as_secs_f64()
    );

    assert_eq!(submitted, 10);
}

// ============================================================================
// Juror Pool Load Tests
// ============================================================================

#[test]
fn test_juror_registration_throughput() {
    let config = JurorPoolConfig::default();
    let pool = JurorPool::new(config);

    let start = Instant::now();

    for i in 0..HIGH_LOAD_OPERATIONS {
        pool.register_juror(
            format!("did:agentme:base:juror-throughput-{}", i),
            100_000_000 + (i as u64 * 100_000), // Varying stakes
            vec![0],
        )
        .unwrap();
    }

    let duration = start.elapsed();

    println!(
        "Registered {} jurors in {:?} ({:.2} jurors/sec)",
        HIGH_LOAD_OPERATIONS,
        duration,
        HIGH_LOAD_OPERATIONS as f64 / duration.as_secs_f64()
    );

    assert_eq!(pool.selectable_count().unwrap(), HIGH_LOAD_OPERATIONS);
}

#[test]
fn test_juror_selection_fairness_under_load() {
    let config = JurorPoolConfig::default();
    let pool = JurorPool::new(config);

    // Register jurors with varying stakes
    let whale_stake = 5_000_000_000u64; // $5000 (50x normal)
    let normal_stake = 100_000_000u64; // $100

    pool.register_juror("did:whale", whale_stake, vec![0])
        .unwrap();
    for i in 0..99 {
        pool.register_juror(format!("did:normal-{}", i), normal_stake, vec![0])
            .unwrap();
    }

    // Run many selections and count whale appearances
    let mut whale_selections = 0;
    let selections = 1000;

    for seed in 0..selections {
        let selected = pool.select_jurors(0, 3, seed as u64).unwrap();
        if selected.contains(&"did:whale".to_string()) {
            whale_selections += 1;
        }
    }

    let whale_percentage = (whale_selections as f64 / selections as f64) * 100.0;

    println!(
        "Whale selected {} times out of {} ({:.1}%)",
        whale_selections, selections, whale_percentage
    );

    // Whale has 50x stake of each normal juror
    // Total stake = 5000 + 99*100 = 5000 + 9900 = 14900
    // Whale percentage = 5000/14900 ≈ 33.6%
    // But since we select 3 jurors, whale should appear in ~68% of selections
    assert!(
        whale_percentage > 50.0,
        "Whale should be selected frequently due to higher stake, got {}%",
        whale_percentage
    );
    assert!(
        whale_percentage < 100.0,
        "Whale shouldn't be selected every time, got {}%",
        whale_percentage
    );
}

#[test]
fn test_session_creation_throughput() {
    let config = JurorPoolConfig::default().with_juror_count(3);
    let pool = JurorPool::new(config);

    // Register enough jurors
    for i in 0..100 {
        pool.register_juror(
            format!("did:agentme:base:session-juror-{}", i),
            500_000_000,
            vec![0],
        )
        .unwrap();
    }

    let start = Instant::now();
    let mut created = 0;

    for i in 0..50 {
        if pool
            .create_session(format!("dispute-session-{}", i), 0)
            .is_ok()
        {
            created += 1;
        }
    }

    let duration = start.elapsed();

    println!(
        "Created {} voting sessions in {:?} ({:.2} sessions/sec)",
        created,
        duration,
        created as f64 / duration.as_secs_f64()
    );

    // Should create many sessions before running out of available jurors
    assert!(
        created > 10,
        "Should create multiple sessions, got {}",
        created
    );
}

// ============================================================================
// Memory and Resource Tests
// ============================================================================

#[test]
fn test_large_card_cache_memory() {
    // Test that we can handle large number of cards in memory
    let mut cache: HashMap<String, CapabilityCard> = HashMap::new();

    let start = Instant::now();

    for i in 0..10000 {
        let card = create_test_card(&format!("did:agentme:base:memory-test-{}", i));
        let did = card
            .agentme
            .as_ref()
            .map(|ext| ext.did.clone())
            .unwrap_or_default();
        cache.insert(did, card);
    }

    let insert_duration = start.elapsed();

    // Verify all cards are accessible
    let start = Instant::now();
    let mut found = 0;
    for i in 0..10000 {
        let did = format!("did:agentme:base:memory-test-{}", i);
        if cache.contains_key(&did) {
            found += 1;
        }
    }
    let lookup_duration = start.elapsed();

    println!(
        "Inserted {} cards in {:?}, looked up {} in {:?}",
        10000, insert_duration, found, lookup_duration
    );

    assert_eq!(found, 10000);
}

// ============================================================================
// Helper Functions
// ============================================================================

fn create_test_card(did: &str) -> CapabilityCard {
    CapabilityCard {
        name: "Load Test Agent".to_string(),
        description:
            "A test agent for load testing that provides code review and analysis services."
                .to_string(),
        url: "https://agent.example.com/a2a".to_string(),
        provider: None,
        capabilities: vec![Capability {
            id: "code-review".to_string(),
            name: "Code Review".to_string(),
            description: Some("Automated code review service".to_string()),
            input_schema: None,
            output_schema: None,
        }],
        authentication: None,
        agentme: Some(AgentMeExtension {
            did: did.to_string(),
            trust_score: Some(0.85),
            stake: Some(1_000_000_000),
            pricing: None,
            payment_methods: vec!["x402".to_string()],
        }),
    }
}
