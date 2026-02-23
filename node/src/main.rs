//! AgoraMesh Node CLI
//!
//! Command-line interface for running an AgoraMesh node.

use clap::{Parser, Subcommand};
use std::env;
use std::path::Path;
use tokio::signal;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use agoramesh_node::{
    validate_network_config, ApiServer, AppState, DiscoveryService, EmbeddingService, HybridSearch,
    MetricsConfig, MetricsService, NetworkConfig, NetworkManager, NodeConfig, RateLimitConfig,
    RateLimitService, Result, TrustService,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

/// Health response from the API.
#[derive(Debug, serde::Deserialize)]
struct HealthResponse {
    status: String,
    version: String,
    peers: u64,
    uptime: u64,
}

/// Seed trust data entry from AGORAMESH_SEED_TRUST env var.
#[derive(Debug, serde::Deserialize)]
struct SeedTrustEntry {
    did: String,
    #[serde(default)]
    stake_amount: u64,
    #[serde(default)]
    successful_txs: u64,
    #[serde(default)]
    failed_txs: u64,
    #[serde(default)]
    endorsement_count: u64,
    /// Optional endorsers to create trust web entries.
    /// Each endorser is auto-created with the given reputation parameters
    /// and a hop-1 endorsement is added to the target agent.
    #[serde(default)]
    endorsers: Vec<SeedEndorser>,
}

/// A seed endorser for bootstrapping trust web data.
#[derive(Debug, serde::Deserialize)]
struct SeedEndorser {
    did: String,
    #[serde(default)]
    successful_txs: u64,
    #[serde(default)]
    failed_txs: u64,
    #[serde(default = "default_hop")]
    hop: u32,
}

fn default_hop() -> u32 {
    1
}

const DEFAULT_API_ADDR: &str = "0.0.0.0:8080";
const DEFAULT_P2P_ADDR: &str = "/ip4/0.0.0.0/tcp/9000";

#[derive(Parser)]
#[command(name = "agoramesh")]
#[command(author, version, about = "AgoraMesh P2P Node", long_about = None)]
struct Cli {
    /// Path to configuration file
    #[arg(short, long, default_value = "config.toml")]
    config: String,

    /// Enable verbose logging
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize a new node configuration
    Init {
        /// Output path for configuration file
        #[arg(short, long, default_value = "config.toml")]
        output: String,
    },

    /// Start the AgoraMesh node
    Start {
        /// P2P listen address
        #[arg(long, default_value = "/ip4/0.0.0.0/tcp/9000")]
        p2p_addr: String,

        /// HTTP API listen address
        #[arg(long, default_value = "0.0.0.0:8080")]
        api_addr: String,

        /// Enable semantic search (downloads ~90MB embedding model on first use)
        #[arg(long, default_value = "false")]
        enable_semantic_search: bool,
    },

    /// Check node health
    Health {
        /// API endpoint to check
        #[arg(long, default_value = "http://localhost:8080")]
        endpoint: String,
    },
}

fn init_logging(verbose: bool) {
    let filter = if verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    };

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(filter)
        .init();
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" => Some(true),
        "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

fn env_bool(name: &str) -> Option<bool> {
    let value = env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    match parse_env_bool(trimmed) {
        Some(parsed) => Some(parsed),
        None => {
            warn!("Invalid value for {}: {}", name, trimmed);
            None
        }
    }
}

fn env_string(name: &str) -> Option<String> {
    let value = env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn env_u64(name: &str) -> Option<u64> {
    let value = env_string(name)?;
    match value.parse::<u64>() {
        Ok(parsed) => Some(parsed),
        Err(_) => {
            warn!("Invalid value for {}: {}", name, value);
            None
        }
    }
}

fn env_csv(name: &str) -> Option<Vec<String>> {
    let value = env_string(name)?;
    let values: Vec<String> = value
        .split(',')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn normalize_token(value: Option<String>) -> Option<String> {
    value.and_then(|token| {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn apply_env_overrides(config: &mut NodeConfig) {
    if let Some(listen_address) = env_string("AGORAMESH_API_LISTEN") {
        config.api.listen_address = listen_address;
    }
    if let Some(cors_enabled) = env_bool("AGORAMESH_CORS_ENABLED") {
        config.api.cors_enabled = cors_enabled;
    }
    if let Some(cors_origins) = env_csv("AGORAMESH_CORS_ORIGINS") {
        config.api.cors_origins = cors_origins;
    }
    if let Some(trust_proxy) = env_bool("AGORAMESH_TRUST_PROXY") {
        config.api.trust_proxy = trust_proxy;
    }
    if let Some(admin_token) = env_string("AGORAMESH_API_TOKEN") {
        config.api.admin_token = normalize_token(Some(admin_token));
    }

    if let Some(listen_addresses) = env_csv("AGORAMESH_P2P_LISTEN") {
        config.network.listen_addresses = listen_addresses;
    }
    if let Some(bootstrap_peers) = env_csv("AGORAMESH_P2P_BOOTSTRAP") {
        config.network.bootstrap_peers = bootstrap_peers;
    }

    if let Some(chain_rpc) = env_string("AGORAMESH_CHAIN_RPC") {
        config.blockchain.rpc_url = chain_rpc;
    }
    if let Some(chain_id) = env_u64("AGORAMESH_CHAIN_ID") {
        config.blockchain.chain_id = chain_id;
    }
    if let Some(trust_registry_address) = env_string("AGORAMESH_TRUST_REGISTRY_ADDRESS") {
        config.blockchain.trust_registry_address = Some(trust_registry_address);
    }
    if let Some(escrow_address) = env_string("AGORAMESH_ESCROW_ADDRESS") {
        config.blockchain.escrow_address = Some(escrow_address);
    }

    if let Some(data_dir) = env_string("AGORAMESH_DATA_DIR") {
        config.persistence.data_dir = data_dir;
    }

    // Node identity overrides
    if let Some(did) = env_string("AGORAMESH_NODE_DID") {
        config.identity.did = Some(did);
    }

    // Node info overrides (for agent card)
    if let Some(name) = env_string("AGORAMESH_NODE_NAME") {
        config.node_info.name = Some(name);
    }
    if let Some(description) = env_string("AGORAMESH_NODE_DESCRIPTION") {
        config.node_info.description = Some(description);
    }
    if let Some(url) = env_string("AGORAMESH_NODE_URL") {
        config.node_info.url = Some(url);
    }

    config.api.admin_token = normalize_token(config.api.admin_token.clone());
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    init_logging(cli.verbose);

    match cli.command {
        Commands::Init { output } => {
            info!("Initializing new node configuration at: {}", output);
            let config = NodeConfig::default();
            config.save(&output)?;
            info!("Configuration saved successfully");
        }

        Commands::Start {
            p2p_addr,
            api_addr,
            enable_semantic_search,
        } => {
            info!("Starting AgoraMesh node...");

            // 1. Load configuration (or use defaults with CLI overrides)
            let mut config = if Path::new(&cli.config).exists() {
                info!("Loading configuration from: {}", cli.config);
                NodeConfig::load(&cli.config)?
            } else {
                info!("Using default configuration");
                NodeConfig::default()
            };
            apply_env_overrides(&mut config);

            let api_addr = if api_addr == DEFAULT_API_ADDR {
                config.api.listen_address.clone()
            } else {
                api_addr.clone()
            };

            let listen_addresses = if p2p_addr == DEFAULT_P2P_ADDR {
                if config.network.listen_addresses.is_empty() {
                    vec![p2p_addr.clone()]
                } else {
                    config.network.listen_addresses.clone()
                }
            } else {
                vec![p2p_addr.clone()]
            };

            // Create network config with CLI overrides
            let network_config = NetworkConfig {
                listen_addresses,
                bootstrap_peers: config.network.bootstrap_peers.clone(),
                max_connections: config.network.max_connections,
            };

            info!(
                "P2P address: {}",
                network_config.listen_addresses.join(", ")
            );
            info!("API address: {}", api_addr);
            validate_network_config(&network_config)?;

            // 2. Initialize P2P network
            info!("Initializing P2P network...");
            let mut network = NetworkManager::new(network_config)?;
            info!("Network started with peer ID: {}", network.local_peer_id());

            // 3. Take event receiver for processing network events
            let mut event_rx = network.take_event_receiver();

            // 4. Initialize semantic search if enabled
            let hybrid_search = if enable_semantic_search {
                info!("Initializing semantic search (downloading ~90MB model if needed)...");
                match EmbeddingService::new() {
                    Ok(embedding_service) => {
                        let hybrid = HybridSearch::new(embedding_service);
                        info!("Semantic search initialized successfully");
                        Some(Arc::new(RwLock::new(hybrid)))
                    }
                    Err(e) => {
                        warn!("Failed to initialize semantic search: {}", e);
                        warn!("Semantic search will be disabled, using keyword search only");
                        None
                    }
                }
            } else {
                None
            };

            // 5. Create shared state for API server with DHT-enabled discovery
            let peer_count = Arc::new(AtomicU64::new(0));
            let discovery = match hybrid_search {
                Some(hs) => {
                    DiscoveryService::with_network_and_shared_search(network.command_channel(), hs)
                }
                None => DiscoveryService::with_network(network.command_channel()),
            };
            // Get the shared hybrid search reference from discovery so both
            // the API semantic-search handler and discovery indexing use the
            // same instance.
            let shared_hybrid_search = discovery.hybrid_search();
            let discovery = Arc::new(discovery);
            let trust = Arc::new(TrustService::new(
                "https://sepolia.base.org".to_string(),
                None,
            ));

            let app_state = AppState {
                discovery: discovery.clone(),
                trust: trust.clone(),
                start_time: Instant::now(),
                peer_count: peer_count.clone(),
                node_info: config.get_node_info(),
                rate_limiter: Arc::new(RateLimitService::new(RateLimitConfig::default())),
                metrics: Arc::new(MetricsService::new(MetricsConfig::default())),
                hybrid_search: shared_hybrid_search,
                api_token: config.api.admin_token.clone(),
            };

            // 6. Start HTTP API server in background with shared state
            let api_config = agoramesh_node::ApiConfig {
                listen_address: api_addr.clone(),
                cors_enabled: config.api.cors_enabled,
                cors_origins: config.api.cors_origins.clone(),
                trust_proxy: config.api.trust_proxy,
                admin_token: config.api.admin_token.clone(),
            };
            let api_server = ApiServer::with_state(api_config, app_state);
            let api_addr_clone = api_addr.clone();

            tokio::spawn(async move {
                if let Err(e) = api_server.run(&api_addr_clone).await {
                    error!("API server error: {}", e);
                }
            });

            // 6b. Seed agents from AGORAMESH_SEED_AGENTS env var
            //
            // Format: JSON array of capability card objects, or a URL to fetch.
            // Example: AGORAMESH_SEED_AGENTS='[{"name":"Bridge","description":"...","url":"https://bridge.agoramesh.ai","x-agoramesh":{"did":"did:agoramesh:base-sepolia:agent-001","payment_methods":["x402"]}}]'
            if let Some(seed_agents_json) = env_string("AGORAMESH_SEED_AGENTS") {
                match serde_json::from_str::<Vec<agoramesh_node::CapabilityCard>>(&seed_agents_json)
                {
                    Ok(cards) => {
                        for card in &cards {
                            match discovery.register(card).await {
                                Ok(()) => {
                                    let did = card
                                        .agoramesh
                                        .as_ref()
                                        .map(|a| a.did.as_str())
                                        .unwrap_or("unknown");
                                    info!("Seed agent registered: {} ({})", card.name, did);
                                }
                                Err(e) => {
                                    warn!("Failed to register seed agent '{}': {}", card.name, e);
                                }
                            }
                        }
                        info!("Seeded {} agent(s)", cards.len());
                    }
                    Err(e) => {
                        warn!("Failed to parse AGORAMESH_SEED_AGENTS: {}", e);
                    }
                }
            }

            // 6c. Seed trust data from AGORAMESH_SEED_TRUST env var
            //
            // Format: JSON array of objects with did, stake_amount, successful_txs, failed_txs, endorsement_count
            // Example: AGORAMESH_SEED_TRUST='[{"did":"did:agoramesh:base-sepolia:agent-001","stake_amount":7225000000,"successful_txs":184,"failed_txs":16,"endorsement_count":5}]'
            if let Some(seed_trust_json) = env_string("AGORAMESH_SEED_TRUST") {
                match serde_json::from_str::<Vec<SeedTrustEntry>>(&seed_trust_json) {
                    Ok(entries) => {
                        for entry in &entries {
                            trust.seed_trust_data(
                                &entry.did,
                                entry.stake_amount,
                                entry.successful_txs,
                                entry.failed_txs,
                                entry.endorsement_count,
                            );

                            // Create endorser trust data and add endorsements
                            for endorser in &entry.endorsers {
                                trust.seed_trust_data(
                                    &endorser.did,
                                    0,
                                    endorser.successful_txs,
                                    endorser.failed_txs,
                                    0,
                                );
                                if let Err(e) = trust
                                    .add_endorsement_with_hop(
                                        &endorser.did,
                                        &entry.did,
                                        endorser.hop,
                                    )
                                    .await
                                {
                                    warn!(
                                        "Failed to add endorsement from {} to {}: {}",
                                        endorser.did, entry.did, e
                                    );
                                }
                            }

                            info!(
                                "Seed trust data set for {} (stake={}, txs={}/{}, endorsers={})",
                                entry.did,
                                entry.stake_amount,
                                entry.successful_txs,
                                entry.failed_txs,
                                entry.endorsers.len()
                            );
                        }
                    }
                    Err(e) => {
                        warn!("Failed to parse AGORAMESH_SEED_TRUST: {}", e);
                    }
                }
            }

            info!("AgoraMesh node started successfully");
            info!("Press Ctrl+C to stop");

            // 7. Run event loop - process network events and handle shutdown
            loop {
                tokio::select! {
                    // Handle network events
                    Some(event) = async {
                        if let Some(ref mut rx) = event_rx {
                            rx.recv().await
                        } else {
                            None
                        }
                    } => {
                        match event {
                            agoramesh_node::NetworkEvent::PeerConnected(peer_id) => {
                                peer_count.fetch_add(1, Ordering::SeqCst);
                                info!("Peer connected: {} (total: {})", peer_id, peer_count.load(Ordering::SeqCst));
                            }
                            agoramesh_node::NetworkEvent::PeerDisconnected(peer_id) => {
                                peer_count.fetch_sub(1, Ordering::SeqCst);
                                info!("Peer disconnected: {} (total: {})", peer_id, peer_count.load(Ordering::SeqCst));
                            }
                            agoramesh_node::NetworkEvent::PeerDiscovered(peer_id) => {
                                info!("Peer discovered via mDNS: {}", peer_id);
                            }
                            agoramesh_node::NetworkEvent::Message { topic, source, data, .. } => {
                                info!(
                                    "Message on {}: {} bytes from {:?}",
                                    topic,
                                    data.len(),
                                    source
                                );
                            }
                            agoramesh_node::NetworkEvent::BootstrapComplete => {
                                info!("DHT bootstrap complete");
                            }
                            agoramesh_node::NetworkEvent::RecordFound { key, value } => {
                                info!(
                                    "DHT record found: key={} bytes, value={:?}",
                                    key.len(),
                                    value.as_ref().map(|v| v.len())
                                );
                            }
                            agoramesh_node::NetworkEvent::RecordStored { key } => {
                                info!("DHT record stored: key={} bytes", key.len());
                            }
                        }
                    }

                    // Handle shutdown signal
                    _ = signal::ctrl_c() => {
                        info!("Received shutdown signal");
                        if let Err(e) = network.shutdown().await {
                            warn!("Error during shutdown: {}", e);
                        }
                        info!("Node stopped");
                        break;
                    }
                }
            }
        }

        Commands::Health { endpoint } => {
            info!("Checking node health at: {}", endpoint);

            // Simple health check using a basic HTTP client
            let health_url = format!("{}/health", endpoint.trim_end_matches('/'));

            // Use tokio's TCP stream for a simple HTTP GET request
            match tokio::time::timeout(std::time::Duration::from_secs(5), check_health(&health_url))
                .await
            {
                Ok(Ok(response)) => {
                    info!("Node status: {}", response.status);
                    info!("Version: {}", response.version);
                    info!("Connected peers: {}", response.peers);
                    info!("Uptime: {} seconds", response.uptime);
                }
                Ok(Err(e)) => {
                    error!("Health check failed: {}", e);
                    std::process::exit(1);
                }
                Err(_) => {
                    error!("Health check timed out");
                    std::process::exit(1);
                }
            }
        }
    }

    Ok(())
}

/// Perform a health check against the API endpoint.
async fn check_health(url: &str) -> Result<HealthResponse> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // Parse URL to extract host and path
    let url = url.trim_start_matches("http://");
    let (host_port, path) = url
        .split_once('/')
        .map(|(h, p)| (h, format!("/{}", p)))
        .unwrap_or((url, "/health".to_string()));

    // Connect to server
    let mut stream = TcpStream::connect(host_port)
        .await
        .map_err(|e| agoramesh_node::Error::Api(format!("Connection failed: {}", e)))?;

    // Send HTTP GET request
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_port
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| agoramesh_node::Error::Api(format!("Write failed: {}", e)))?;

    // Read response
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|e| agoramesh_node::Error::Api(format!("Read failed: {}", e)))?;

    let response_str = String::from_utf8_lossy(&response);

    // Find body (after \r\n\r\n)
    let body = response_str
        .split("\r\n\r\n")
        .nth(1)
        .ok_or_else(|| agoramesh_node::Error::Api("Invalid HTTP response".to_string()))?;

    // Parse JSON
    serde_json::from_str(body)
        .map_err(|e| agoramesh_node::Error::Api(format!("JSON parse error: {}", e)))
}
