//! P2P Network Load Testing Benchmarks
//!
//! Benchmarks for measuring AgoraMesh P2P network performance:
//! - Message serialization/deserialization throughput
//! - Discovery service operations
//! - Trust cache operations
//! - Arbitration dispute processing
//!
//! Based on libp2p performance benchmarking best practices.
//!
//! ## Running Benchmarks
//!
//! ```bash
//! cargo bench
//! cargo bench -- message_serialization
//! cargo bench -- discovery
//! ```

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use std::collections::HashMap;

use agoramesh_node::{
    discovery::{AgoraMeshExtension, Capability, CapabilityCard},
    network::message_handler::{DiscoveryMessage, TrustMessage},
    trust::TrustInfo,
    AIArbitrationConfig, AIArbitrator, Evidence, EvidenceType, Juror, JurorPool, JurorPoolConfig,
    TrustCache, TrustCacheConfig,
};

// ============================================================================
// Message Serialization Benchmarks
// ============================================================================

fn bench_message_serialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("message_serialization");

    // Create sample capability card
    let card = create_sample_card("did:agoramesh:base:benchmark-agent");

    // Benchmark DiscoveryMessage serialization
    let discovery_msg = DiscoveryMessage::CardAnnouncement {
        card: Box::new(card.clone()),
    };

    group.throughput(Throughput::Elements(1));

    group.bench_function("discovery_message_serialize", |b| {
        b.iter(|| {
            let bytes = serde_json::to_vec(black_box(&discovery_msg)).unwrap();
            black_box(bytes);
        });
    });

    // Benchmark DiscoveryMessage deserialization
    let serialized = serde_json::to_vec(&discovery_msg).unwrap();
    group.bench_function("discovery_message_deserialize", |b| {
        b.iter(|| {
            let msg: DiscoveryMessage = serde_json::from_slice(black_box(&serialized)).unwrap();
            black_box(msg);
        });
    });

    // Benchmark TrustMessage serialization
    let trust_msg = TrustMessage::TrustUpdate {
        did: "did:agoramesh:base:test".to_string(),
        trust_score: 0.85,
        timestamp: 1704067200,
    };

    group.bench_function("trust_message_serialize", |b| {
        b.iter(|| {
            let bytes = serde_json::to_vec(black_box(&trust_msg)).unwrap();
            black_box(bytes);
        });
    });

    group.finish();
}

fn bench_message_batch_serialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("message_batch_serialization");

    // Test batch sizes
    for batch_size in [10, 100, 1000].iter() {
        let messages: Vec<_> = (0..*batch_size)
            .map(|i| TrustMessage::ReputationEvent {
                did: format!("did:agoramesh:base:agent-{}", i),
                success: i % 2 == 0,
                amount: (i * 1000) as u64,
                timestamp: 1704067200 + i as u64,
            })
            .collect();

        group.throughput(Throughput::Elements(*batch_size as u64));

        group.bench_with_input(
            BenchmarkId::new("serialize_batch", batch_size),
            &messages,
            |b, msgs| {
                b.iter(|| {
                    let bytes: Vec<_> = msgs
                        .iter()
                        .map(|m| serde_json::to_vec(m).unwrap())
                        .collect();
                    black_box(bytes);
                });
            },
        );
    }

    group.finish();
}

// ============================================================================
// Discovery Service Benchmarks
// ============================================================================

fn bench_discovery_operations(c: &mut Criterion) {
    let mut group = c.benchmark_group("discovery_operations");

    // Create sample capability card
    let card = create_sample_card("did:agoramesh:base:test");

    // Benchmark capability card validation
    group.bench_function("card_validation", |b| {
        b.iter(|| {
            // Validate DID format from extension
            let valid = black_box(&card)
                .agoramesh
                .as_ref()
                .map(|ext| ext.did.starts_with("did:"))
                .unwrap_or(false);
            black_box(valid);
        });
    });

    // Benchmark card matching (simple keyword search simulation)
    let cards: Vec<_> = (0..1000)
        .map(|i| create_sample_card(&format!("did:agoramesh:base:agent-{}", i)))
        .collect();

    group.bench_function("keyword_search_1000_cards", |b| {
        b.iter(|| {
            let query = "code review";
            let matches: Vec<_> = cards
                .iter()
                .filter(|c| c.description.to_lowercase().contains(query))
                .collect();
            black_box(matches);
        });
    });

    // Benchmark card insertion into HashMap (simulating cache)
    group.bench_function("cache_insert_1000_cards", |b| {
        b.iter(|| {
            let mut cache: HashMap<String, CapabilityCard> = HashMap::new();
            for card in &cards {
                let did = card
                    .agoramesh
                    .as_ref()
                    .map(|ext| ext.did.clone())
                    .unwrap_or_default();
                cache.insert(did, card.clone());
            }
            black_box(cache);
        });
    });

    group.finish();
}

// ============================================================================
// Trust Cache Benchmarks
// ============================================================================

fn bench_trust_cache(c: &mut Criterion) {
    let mut group = c.benchmark_group("trust_cache");

    let runtime = tokio::runtime::Runtime::new().unwrap();

    // Create cache with default config
    let config = TrustCacheConfig::default();
    let cache = TrustCache::new(config);

    // Benchmark cache insert
    group.bench_function("cache_insert", |b| {
        let mut counter = 0u64;
        b.iter(|| {
            counter += 1;
            let did = format!("did:agoramesh:base:agent-{}", counter);
            let info = TrustInfo {
                did: did.clone(),
                score: 0.85,
                reputation: 0.8,
                stake_score: 0.7,
                endorsement_score: 0.6,
                stake_amount: 1_000_000_000,
                successful_transactions: 100,
                failed_transactions: 5,
                endorsement_count: 3,
            };
            runtime.block_on(async {
                cache.insert(&did, info).await;
            });
        });
    });

    // Pre-populate cache for lookup tests
    runtime.block_on(async {
        for i in 0..1000 {
            let did = format!("did:agoramesh:base:lookup-{}", i);
            let info = TrustInfo {
                did: did.clone(),
                score: 0.5 + (i as f64 * 0.0004),
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
    });

    // Benchmark cache lookup (hit)
    group.bench_function("cache_lookup_hit", |b| {
        b.iter(|| {
            runtime.block_on(async {
                let result = cache.get("did:agoramesh:base:lookup-500").await;
                black_box(result);
            });
        });
    });

    // Benchmark cache lookup (miss)
    group.bench_function("cache_lookup_miss", |b| {
        b.iter(|| {
            runtime.block_on(async {
                let result = cache.get("did:agoramesh:base:nonexistent").await;
                black_box(result);
            });
        });
    });

    group.finish();
}

// ============================================================================
// Arbitration Benchmarks
// ============================================================================

fn bench_arbitration(c: &mut Criterion) {
    let mut group = c.benchmark_group("arbitration");

    // Benchmark AI dispute creation
    let config = AIArbitrationConfig::default();
    let arbitrator = AIArbitrator::new(config).unwrap();

    group.bench_function("create_dispute", |b| {
        let mut counter = 0u64;
        b.iter(|| {
            counter += 1;
            let result = arbitrator.create_dispute(
                format!("escrow-{}", counter),
                format!("did:client-{}", counter),
                format!("did:provider-{}", counter),
                100_000_000, // $100 USDC
            );
            let _ = black_box(result);
        });
    });

    // Benchmark evidence creation
    group.bench_function("create_evidence", |b| {
        b.iter(|| {
            let evidence = Evidence::new(
                "did:agoramesh:base:submitter",
                EvidenceType::Text,
                "Evidence Title",
                "This is a detailed description of the evidence that supports the claim.",
            );
            black_box(evidence);
        });
    });

    group.finish();
}

// ============================================================================
// Juror Pool Benchmarks
// ============================================================================

fn bench_juror_pool(c: &mut Criterion) {
    let mut group = c.benchmark_group("juror_pool");

    // Create a large juror pool
    let config = JurorPoolConfig::default();
    let pool = JurorPool::new(config);

    // Register many jurors for selection tests
    // Explicit u64 types to avoid any overflow issues
    for i in 0u64..1000 {
        let stake = 100_000_000u64 + i * 10_000_000u64; // $100-$10,000 stakes
        pool.register_juror(format!("did:agoramesh:base:juror-{}", i), stake, vec![0])
            .unwrap();
    }

    // Benchmark juror registration
    group.bench_function("register_juror", |b| {
        let fresh_pool = JurorPool::new(JurorPoolConfig::default());
        let mut counter = 0u64;
        b.iter(|| {
            counter += 1;
            let _ = fresh_pool.register_juror(
                format!("did:agoramesh:base:fresh-juror-{}", counter),
                500_000_000,
                vec![0],
            );
        });
    });

    // Benchmark stake-weighted selection from large pool
    group.bench_function("select_3_jurors_from_1000", |b| {
        let mut seed = 12345u64;
        b.iter(|| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let selected = pool.select_jurors(0, 3, seed).unwrap();
            black_box(selected);
        });
    });

    // Benchmark juror lookup
    group.bench_function("get_juror", |b| {
        b.iter(|| {
            let juror = pool.get_juror("did:agoramesh:base:juror-500");
            let _ = black_box(juror);
        });
    });

    // Benchmark Juror effective stake calculation
    let juror = Juror::new("did:test", 1_000_000_000, vec![0]);
    group.bench_function("calculate_effective_stake", |b| {
        b.iter(|| {
            let stake = black_box(&juror).effective_stake();
            black_box(stake);
        });
    });

    group.finish();
}

// ============================================================================
// Throughput Stress Tests
// ============================================================================

fn bench_high_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("high_throughput");
    group.sample_size(50); // Reduce sample size for expensive tests

    // Simulate high message throughput
    let messages: Vec<_> = (0..10000)
        .map(|i| TrustMessage::TrustUpdate {
            did: format!("did:agoramesh:base:agent-{}", i),
            trust_score: 0.5 + (i as f64 * 0.00005),
            timestamp: 1704067200 + i as u64,
        })
        .collect();

    group.throughput(Throughput::Elements(10000));

    group.bench_function("process_10000_messages", |b| {
        b.iter(|| {
            let mut processed = 0;
            for msg in &messages {
                // Simulate message processing
                if let TrustMessage::TrustUpdate { trust_score, .. } = msg {
                    if *trust_score > 0.5 {
                        processed += 1;
                    }
                }
            }
            black_box(processed);
        });
    });

    // Simulate concurrent discovery cache updates
    let cards: Vec<_> = (0..1000)
        .map(|i| create_sample_card(&format!("did:agoramesh:base:agent-{}", i)))
        .collect();

    group.throughput(Throughput::Elements(1000));

    group.bench_function("cache_1000_cards", |b| {
        b.iter(|| {
            let cache: HashMap<String, CapabilityCard> = cards
                .iter()
                .map(|c| {
                    let did = c
                        .agoramesh
                        .as_ref()
                        .map(|ext| ext.did.clone())
                        .unwrap_or_default();
                    (did, c.clone())
                })
                .collect();
            black_box(cache);
        });
    });

    group.finish();
}

// ============================================================================
// Helper Functions
// ============================================================================

fn create_sample_card(did: &str) -> CapabilityCard {
    CapabilityCard {
        name: "Benchmark Agent".to_string(),
        description:
            "A test agent for benchmarking that provides code review and analysis services."
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
        agoramesh: Some(AgoraMeshExtension {
            did: did.to_string(),
            trust_score: Some(0.85),
            stake: Some(1_000_000_000),
            pricing: None,
            payment_methods: vec!["x402".to_string()],
        }),
    }
}

// ============================================================================
// Criterion Configuration
// ============================================================================

criterion_group!(
    benches,
    bench_message_serialization,
    bench_message_batch_serialization,
    bench_discovery_operations,
    bench_trust_cache,
    bench_arbitration,
    bench_juror_pool,
    bench_high_throughput,
);

criterion_main!(benches);
