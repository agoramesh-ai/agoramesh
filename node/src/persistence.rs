//! Persistence Layer for AgentMe Node
//!
//! Provides durable storage for:
//! - Capability cards (agent metadata)
//! - Trust data (reputation, stake, endorsements)
//! - DHT records (optional)
//!
//! Uses RocksDB as the underlying key-value store for high performance
//! and reliability.

use crate::discovery::CapabilityCard;
use crate::error::{Error, Result};
use rocksdb::{Options, DB};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tracing::{debug, info, warn};

// =============================================================================
// Types
// =============================================================================

/// Configuration for the persistence layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceConfig {
    /// Whether persistence is enabled.
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Base directory for all data files.
    #[serde(default = "default_data_dir")]
    pub data_dir: String,

    /// Whether to persist capability cards.
    #[serde(default = "default_true")]
    pub capability_cards: bool,

    /// Whether to persist trust data.
    #[serde(default = "default_true")]
    pub trust_data: bool,

    /// Whether to persist DHT records.
    #[serde(default = "default_false")]
    pub dht_records: bool,
}

fn default_enabled() -> bool {
    true
}

fn default_data_dir() -> String {
    "./data".to_string()
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

impl Default for PersistenceConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            data_dir: "./data".to_string(),
            capability_cards: true,
            trust_data: true,
            dht_records: false,
        }
    }
}

/// Trust data stored for each agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrustData {
    /// Amount staked in USDC (6 decimals).
    pub stake_amount: u64,
    /// Number of successful transactions.
    pub successful_transactions: u64,
    /// Number of failed/disputed transactions.
    pub failed_transactions: u64,
    /// Number of endorsements received.
    pub endorsement_count: u64,
    /// Total volume in USDC (6 decimals).
    pub total_volume: u64,
    /// Last activity timestamp (Unix seconds).
    pub last_activity: u64,
}

// =============================================================================
// Store Trait
// =============================================================================

/// Trait for key-value stores with string keys.
pub trait Store: Send + Sync {
    /// Get a value by key.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;

    /// Set a value by key.
    fn put(&self, key: &str, value: &[u8]) -> Result<()>;

    /// Delete a value by key.
    fn delete(&self, key: &str) -> Result<()>;

    /// Check if a key exists.
    fn contains(&self, key: &str) -> Result<bool>;

    /// Iterate over all keys with a given prefix.
    fn iter_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>>;

    /// Get all keys.
    fn keys(&self) -> Result<Vec<String>>;
}

// =============================================================================
// RocksDB Store Implementation
// =============================================================================

/// RocksDB-backed key-value store.
pub struct RocksStore {
    db: DB,
    name: String,
}

impl RocksStore {
    /// Open or create a RocksDB store at the given path.
    pub fn open<P: AsRef<Path>>(path: P, name: &str) -> Result<Self> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.set_max_open_files(256);
        opts.set_keep_log_file_num(3);
        opts.set_max_log_file_size(1024 * 1024); // 1MB

        let db = DB::open(&opts, path.as_ref())
            .map_err(|e| Error::Persistence(format!("Failed to open RocksDB {}: {}", name, e)))?;

        info!("Opened RocksDB store: {} at {:?}", name, path.as_ref());

        Ok(Self {
            db,
            name: name.to_string(),
        })
    }

    /// Get the store name.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Store for RocksStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.db
            .get(key.as_bytes())
            .map_err(|e| Error::Persistence(format!("RocksDB get error: {}", e)))
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        self.db
            .put(key.as_bytes(), value)
            .map_err(|e| Error::Persistence(format!("RocksDB put error: {}", e)))?;
        debug!("Persisted key: {} ({} bytes)", key, value.len());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.db
            .delete(key.as_bytes())
            .map_err(|e| Error::Persistence(format!("RocksDB delete error: {}", e)))?;
        debug!("Deleted key: {}", key);
        Ok(())
    }

    fn contains(&self, key: &str) -> Result<bool> {
        self.db
            .get_pinned(key.as_bytes())
            .map(|opt| opt.is_some())
            .map_err(|e| Error::Persistence(format!("RocksDB contains error: {}", e)))
    }

    fn iter_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
        let iter = self.db.prefix_iterator(prefix.as_bytes());
        let mut results = Vec::new();

        for item in iter {
            match item {
                Ok((key, value)) => {
                    if let Ok(key_str) = String::from_utf8(key.to_vec()) {
                        if key_str.starts_with(prefix) {
                            results.push((key_str, value.to_vec()));
                        } else {
                            break; // Past the prefix range
                        }
                    }
                }
                Err(e) => {
                    warn!("RocksDB iteration error: {}", e);
                    break;
                }
            }
        }

        Ok(results)
    }

    fn keys(&self) -> Result<Vec<String>> {
        let iter = self.db.iterator(rocksdb::IteratorMode::Start);
        let mut keys = Vec::new();

        for item in iter {
            match item {
                Ok((key, _)) => {
                    if let Ok(key_str) = String::from_utf8(key.to_vec()) {
                        keys.push(key_str);
                    }
                }
                Err(e) => {
                    warn!("RocksDB iteration error: {}", e);
                    break;
                }
            }
        }

        Ok(keys)
    }
}

// =============================================================================
// In-Memory Store (for testing)
// =============================================================================

/// In-memory store for testing purposes.
#[derive(Default)]
pub struct MemoryStore {
    data: std::sync::RwLock<std::collections::HashMap<String, Vec<u8>>>,
}

impl MemoryStore {
    /// Create a new in-memory store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl Store for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let guard = self
            .data
            .read()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (read)".to_string()))?;
        Ok(guard.get(key).cloned())
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        let mut guard = self
            .data
            .write()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (write)".to_string()))?;
        guard.insert(key.to_string(), value.to_vec());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        let mut guard = self
            .data
            .write()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (write)".to_string()))?;
        guard.remove(key);
        Ok(())
    }

    fn contains(&self, key: &str) -> Result<bool> {
        let guard = self
            .data
            .read()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (read)".to_string()))?;
        Ok(guard.contains_key(key))
    }

    fn iter_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
        let guard = self
            .data
            .read()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (read)".to_string()))?;
        Ok(guard
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect())
    }

    fn keys(&self) -> Result<Vec<String>> {
        let guard = self
            .data
            .read()
            .map_err(|_| Error::Persistence("Memory store lock poisoned (read)".to_string()))?;
        Ok(guard.keys().cloned().collect())
    }
}

// =============================================================================
// Typed Stores
// =============================================================================

/// Store for capability cards with JSON serialization.
pub struct CapabilityCardStore {
    store: Arc<dyn Store>,
}

impl CapabilityCardStore {
    /// Create a new capability card store.
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }

    /// Get a capability card by DID.
    pub fn get(&self, did: &str) -> Result<Option<CapabilityCard>> {
        match self.store.get(did)? {
            Some(data) => {
                let card: CapabilityCard = serde_json::from_slice(&data).map_err(|e| {
                    Error::Persistence(format!("Failed to deserialize card: {}", e))
                })?;
                Ok(Some(card))
            }
            None => Ok(None),
        }
    }

    /// Store a capability card.
    pub fn put(&self, did: &str, card: &CapabilityCard) -> Result<()> {
        let data = serde_json::to_vec(card)
            .map_err(|e| Error::Persistence(format!("Failed to serialize card: {}", e)))?;
        self.store.put(did, &data)
    }

    /// Delete a capability card.
    pub fn delete(&self, did: &str) -> Result<()> {
        self.store.delete(did)
    }

    /// Check if a capability card exists.
    pub fn contains(&self, did: &str) -> Result<bool> {
        self.store.contains(did)
    }

    /// Get all capability cards.
    pub fn all(&self) -> Result<Vec<(String, CapabilityCard)>> {
        let keys = self.store.keys()?;
        let mut cards = Vec::new();

        for key in keys {
            if let Some(card) = self.get(&key)? {
                cards.push((key, card));
            }
        }

        Ok(cards)
    }

    /// Get the number of stored cards.
    pub fn len(&self) -> Result<usize> {
        Ok(self.store.keys()?.len())
    }

    /// Check if the store is empty.
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}

/// Store for trust data with bincode serialization.
pub struct TrustDataStore {
    store: Arc<dyn Store>,
}

impl TrustDataStore {
    /// Create a new trust data store.
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }

    /// Get trust data by DID.
    pub fn get(&self, did: &str) -> Result<Option<TrustData>> {
        match self.store.get(did)? {
            Some(data) => {
                let trust: TrustData = bincode::deserialize(&data).map_err(|e| {
                    Error::Persistence(format!("Failed to deserialize trust data: {}", e))
                })?;
                Ok(Some(trust))
            }
            None => Ok(None),
        }
    }

    /// Store trust data.
    pub fn put(&self, did: &str, trust: &TrustData) -> Result<()> {
        let data = bincode::serialize(trust)
            .map_err(|e| Error::Persistence(format!("Failed to serialize trust data: {}", e)))?;
        self.store.put(did, &data)
    }

    /// Delete trust data.
    pub fn delete(&self, did: &str) -> Result<()> {
        self.store.delete(did)
    }

    /// Get or create trust data for a DID.
    pub fn get_or_default(&self, did: &str) -> Result<TrustData> {
        Ok(self.get(did)?.unwrap_or_default())
    }

    /// Update trust data with a function.
    pub fn update<F>(&self, did: &str, f: F) -> Result<TrustData>
    where
        F: FnOnce(&mut TrustData),
    {
        let mut trust = self.get_or_default(did)?;
        f(&mut trust);
        self.put(did, &trust)?;
        Ok(trust)
    }

    /// Get the number of stored entries.
    pub fn len(&self) -> Result<usize> {
        Ok(self.store.keys()?.len())
    }

    /// Check if the store is empty.
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}

// =============================================================================
// Persistence Manager
// =============================================================================

/// Main persistence manager that owns all stores.
pub struct PersistenceManager {
    config: PersistenceConfig,
    capability_store: Option<CapabilityCardStore>,
    trust_store: Option<TrustDataStore>,
}

impl PersistenceManager {
    /// Create a new persistence manager with the given configuration.
    pub fn new(config: PersistenceConfig) -> Result<Self> {
        if !config.enabled {
            info!("Persistence is disabled");
            return Ok(Self {
                config,
                capability_store: None,
                trust_store: None,
            });
        }

        // Create data directory if it doesn't exist
        std::fs::create_dir_all(&config.data_dir).map_err(|e| {
            Error::Persistence(format!(
                "Failed to create data directory {}: {}",
                config.data_dir, e
            ))
        })?;

        // Open capability card store
        let capability_store = if config.capability_cards {
            let path = Path::new(&config.data_dir).join("capability_cards");
            let store = Arc::new(RocksStore::open(&path, "capability_cards")?);
            Some(CapabilityCardStore::new(store))
        } else {
            None
        };

        // Open trust data store
        let trust_store = if config.trust_data {
            let path = Path::new(&config.data_dir).join("trust_data");
            let store = Arc::new(RocksStore::open(&path, "trust_data")?);
            Some(TrustDataStore::new(store))
        } else {
            None
        };

        info!(
            "Persistence manager initialized: capability_cards={}, trust_data={}",
            capability_store.is_some(),
            trust_store.is_some()
        );

        Ok(Self {
            config,
            capability_store,
            trust_store,
        })
    }

    /// Create a persistence manager with in-memory stores (for testing).
    pub fn in_memory() -> Self {
        let capability_store = CapabilityCardStore::new(Arc::new(MemoryStore::new()));
        let trust_store = TrustDataStore::new(Arc::new(MemoryStore::new()));

        Self {
            config: PersistenceConfig::default(),
            capability_store: Some(capability_store),
            trust_store: Some(trust_store),
        }
    }

    /// Get the configuration.
    pub fn config(&self) -> &PersistenceConfig {
        &self.config
    }

    /// Get the capability card store.
    pub fn capability_cards(&self) -> Option<&CapabilityCardStore> {
        self.capability_store.as_ref()
    }

    /// Get the trust data store.
    pub fn trust_data(&self) -> Option<&TrustDataStore> {
        self.trust_store.as_ref()
    }

    /// Check if persistence is enabled.
    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_card() -> CapabilityCard {
        CapabilityCard {
            name: "Test Agent".to_string(),
            description: "A test agent".to_string(),
            url: "https://test.example.com".to_string(),
            provider: None,
            capabilities: vec![],
            authentication: None,
            agentme: None,
        }
    }

    #[test]
    fn test_memory_store() {
        let store = MemoryStore::new();

        // Test put/get
        store.put("key1", b"value1").unwrap();
        assert_eq!(store.get("key1").unwrap(), Some(b"value1".to_vec()));

        // Test contains
        assert!(store.contains("key1").unwrap());
        assert!(!store.contains("nonexistent").unwrap());

        // Test delete
        store.delete("key1").unwrap();
        assert!(!store.contains("key1").unwrap());
    }

    #[test]
    fn test_rocks_store() {
        let tmp_dir = TempDir::new().unwrap();
        let store = RocksStore::open(tmp_dir.path(), "test").unwrap();

        // Test put/get
        store.put("key1", b"value1").unwrap();
        assert_eq!(store.get("key1").unwrap(), Some(b"value1".to_vec()));

        // Test contains
        assert!(store.contains("key1").unwrap());
        assert!(!store.contains("nonexistent").unwrap());

        // Test delete
        store.delete("key1").unwrap();
        assert!(!store.contains("key1").unwrap());
    }

    #[test]
    fn test_capability_card_store() {
        let store = CapabilityCardStore::new(Arc::new(MemoryStore::new()));
        let card = create_test_card();

        // Test put/get
        store.put("did:test:1", &card).unwrap();
        let retrieved = store.get("did:test:1").unwrap().unwrap();
        assert_eq!(retrieved.name, "Test Agent");

        // Test contains
        assert!(store.contains("did:test:1").unwrap());

        // Test all
        let all = store.all().unwrap();
        assert_eq!(all.len(), 1);

        // Test delete
        store.delete("did:test:1").unwrap();
        assert!(!store.contains("did:test:1").unwrap());
    }

    #[test]
    fn test_trust_data_store() {
        let store = TrustDataStore::new(Arc::new(MemoryStore::new()));

        // Test get_or_default
        let trust = store.get_or_default("did:test:1").unwrap();
        assert_eq!(trust.successful_transactions, 0);

        // Test update
        store
            .update("did:test:1", |t| {
                t.successful_transactions = 10;
                t.total_volume = 1000;
            })
            .unwrap();

        let trust = store.get("did:test:1").unwrap().unwrap();
        assert_eq!(trust.successful_transactions, 10);
        assert_eq!(trust.total_volume, 1000);
    }

    #[test]
    fn test_persistence_manager_in_memory() {
        let manager = PersistenceManager::in_memory();

        assert!(manager.is_enabled());
        assert!(manager.capability_cards().is_some());
        assert!(manager.trust_data().is_some());
    }

    #[test]
    fn test_persistence_manager_disabled() {
        let config = PersistenceConfig {
            enabled: false,
            ..Default::default()
        };
        let manager = PersistenceManager::new(config).unwrap();

        assert!(!manager.is_enabled());
        assert!(manager.capability_cards().is_none());
        assert!(manager.trust_data().is_none());
    }

    #[test]
    fn test_persistence_manager_with_rocksdb() {
        let tmp_dir = TempDir::new().unwrap();
        let config = PersistenceConfig {
            enabled: true,
            data_dir: tmp_dir.path().to_string_lossy().to_string(),
            capability_cards: true,
            trust_data: true,
            dht_records: false,
        };

        let manager = PersistenceManager::new(config).unwrap();

        // Test capability card persistence
        let card = create_test_card();
        manager
            .capability_cards()
            .unwrap()
            .put("did:test:1", &card)
            .unwrap();

        let retrieved = manager
            .capability_cards()
            .unwrap()
            .get("did:test:1")
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.name, "Test Agent");

        // Test trust data persistence
        manager
            .trust_data()
            .unwrap()
            .update("did:test:1", |t| {
                t.successful_transactions = 5;
            })
            .unwrap();

        let trust = manager
            .trust_data()
            .unwrap()
            .get("did:test:1")
            .unwrap()
            .unwrap();
        assert_eq!(trust.successful_transactions, 5);
    }
}
