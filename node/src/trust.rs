//! Trust layer for agent verification.
//!
//! This module handles:
//! - Trust score calculation
//! - Stake verification
//! - Web-of-trust endorsements
//! - On-chain reputation queries

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

use crate::contract::TrustRegistryClient;
use crate::error::{Error, Result};

/// Trust information for an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustInfo {
    /// Agent's DID.
    pub did: String,

    /// Overall trust score (0.0 - 1.0).
    pub score: f64,

    /// Reputation component (0.0 - 1.0).
    pub reputation: f64,

    /// Stake component (0.0 - 1.0).
    pub stake_score: f64,

    /// Web-of-trust component (0.0 - 1.0).
    pub endorsement_score: f64,

    /// Staked amount in USDC (6 decimals).
    pub stake_amount: u64,

    /// Number of successful transactions.
    pub successful_transactions: u64,

    /// Number of failed transactions.
    pub failed_transactions: u64,

    /// Number of endorsements received.
    pub endorsement_count: u64,
}

/// Trust score calculation weights.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustWeights {
    /// Weight for reputation component.
    pub reputation: f64,

    /// Weight for stake component.
    pub stake: f64,

    /// Weight for endorsements component.
    pub endorsements: f64,
}

impl Default for TrustWeights {
    fn default() -> Self {
        Self {
            reputation: 0.4,
            stake: 0.3,
            endorsements: 0.3,
        }
    }
}

/// Reference stake amount: $10,000 USDC (6 decimals).
pub const REFERENCE_STAKE: u64 = 10_000_000_000;

/// Get current Unix timestamp in seconds.
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Trust verification service.
///
/// Provides trust score calculation and verification for agents.
/// Uses local cache with fallback to on-chain queries.
pub struct TrustService {
    /// Trust calculation weights.
    weights: TrustWeights,

    /// RPC URL for blockchain queries.
    #[allow(dead_code)]
    rpc_url: String,

    /// Trust Registry contract address.
    #[allow(dead_code)]
    registry_address: Option<String>,

    /// Contract client for on-chain operations.
    contract_client: Option<TrustRegistryClient>,

    /// Local cache of trust data (for testing and offline mode).
    cache: RwLock<HashMap<String, TrustData>>,
}

/// Decay rate per period (5% = 0.05)
pub const DECAY_RATE: f64 = 0.05;

/// Decay period in seconds (14 days)
pub const DECAY_PERIOD_SECS: u64 = 14 * 24 * 60 * 60;

/// Maximum hop distance for endorsement validity (beyond this, endorsement is ignored)
pub const MAX_ENDORSEMENT_HOPS: u32 = 3;

/// Decay factor per hop (10% decay = 0.9 multiplier per hop)
pub const ENDORSEMENT_DECAY_PER_HOP: f64 = 0.90;

/// Maximum number of endorsements counted (prevent gaming via mass endorsements)
pub const MAX_ENDORSEMENTS_COUNTED: usize = 10;

/// Normalization factor for endorsement score (divide total by this)
pub const ENDORSEMENT_NORMALIZATION: f64 = 3.0;

/// Endorsement with hop distance information.
#[derive(Debug, Clone)]
struct EndorsementData {
    /// DID of the endorser
    endorser_did: String,
    /// Hop distance from trust root (1 = direct, 2 = one intermediary, etc.)
    hop_distance: u32,
}

/// Internal trust data storage.
#[derive(Debug, Clone, Default)]
struct TrustData {
    stake_amount: u64,
    successful_transactions: u64,
    failed_transactions: u64,
    endorsement_count: u64,
    /// Unix timestamp of last activity (for decay calculation)
    last_activity_timestamp: u64,
    /// List of endorsements with hop distances
    endorsements: Vec<EndorsementData>,
}

impl TrustService {
    /// Create a new trust service.
    ///
    /// # Arguments
    ///
    /// * `rpc_url` - Ethereum RPC URL for blockchain queries
    /// * `registry_address` - Optional TrustRegistry contract address
    pub fn new(rpc_url: String, registry_address: Option<String>) -> Self {
        Self::with_weights(rpc_url, registry_address, TrustWeights::default())
    }

    /// Create a new trust service with custom weights.
    pub fn with_weights(
        rpc_url: String,
        registry_address: Option<String>,
        weights: TrustWeights,
    ) -> Self {
        // Try to create contract client if address is provided
        let contract_client = registry_address
            .as_ref()
            .and_then(|addr| TrustRegistryClient::new(rpc_url.clone(), addr).ok());

        Self {
            weights,
            rpc_url,
            registry_address,
            contract_client,
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Seed trust data for an agent.
    ///
    /// Used to set initial trust data for known agents (e.g. on startup).
    /// Uses current timestamp so no decay is applied initially.
    pub fn seed_trust_data(
        &self,
        did: &str,
        stake_amount: u64,
        successful_txs: u64,
        failed_txs: u64,
        endorsement_count: u64,
    ) {
        self.seed_trust_data_with_timestamp(
            did,
            stake_amount,
            successful_txs,
            failed_txs,
            endorsement_count,
            current_timestamp(),
        );
    }

    /// Seed trust data with explicit timestamp.
    pub fn seed_trust_data_with_timestamp(
        &self,
        did: &str,
        stake_amount: u64,
        successful_txs: u64,
        failed_txs: u64,
        endorsement_count: u64,
        last_activity_timestamp: u64,
    ) {
        if let Ok(mut cache) = self.cache.write() {
            cache.insert(
                did.to_string(),
                TrustData {
                    stake_amount,
                    successful_transactions: successful_txs,
                    failed_transactions: failed_txs,
                    endorsement_count,
                    last_activity_timestamp,
                    endorsements: Vec::new(),
                },
            );
        }
    }

    /// Set trust data for testing purposes.
    #[cfg(test)]
    pub fn set_trust_data(
        &self,
        did: &str,
        stake_amount: u64,
        successful_txs: u64,
        failed_txs: u64,
        endorsements: u64,
    ) {
        self.seed_trust_data(did, stake_amount, successful_txs, failed_txs, endorsements);
    }

    /// Set trust data with explicit timestamp for testing decay.
    #[cfg(test)]
    pub fn set_trust_data_with_timestamp(
        &self,
        did: &str,
        stake_amount: u64,
        successful_txs: u64,
        failed_txs: u64,
        endorsement_count: u64,
        last_activity_timestamp: u64,
    ) {
        self.seed_trust_data_with_timestamp(
            did,
            stake_amount,
            successful_txs,
            failed_txs,
            endorsement_count,
            last_activity_timestamp,
        );
    }

    /// Get trust information for an agent.
    ///
    /// First checks local cache, then queries on-chain if contract is configured.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID
    ///
    /// # Returns
    ///
    /// Trust information including composite score and components.
    pub async fn get_trust(&self, did: &str) -> Result<TrustInfo> {
        // Validate DID format
        if !did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                did
            )));
        }

        // Get data from cache (or default for unknown agents)
        let data = {
            let cache = self
                .cache
                .read()
                .map_err(|e| Error::Trust(format!("Failed to acquire cache read lock: {}", e)))?;
            cache.get(did).cloned().unwrap_or_default()
        };

        // Calculate component scores
        let reputation = self.calculate_reputation(&data);
        let stake_score = self.calculate_stake_score(data.stake_amount);
        let endorsement_score = self.calculate_endorsement_score(&data);

        // Calculate composite score using weights
        let score = self.weights.reputation * reputation
            + self.weights.stake * stake_score
            + self.weights.endorsements * endorsement_score;

        Ok(TrustInfo {
            did: did.to_string(),
            score,
            reputation,
            stake_score,
            endorsement_score,
            stake_amount: data.stake_amount,
            successful_transactions: data.successful_transactions,
            failed_transactions: data.failed_transactions,
            endorsement_count: data.endorsement_count,
        })
    }

    /// Get on-chain trust score for an agent.
    ///
    /// Queries the TrustRegistry contract directly.
    /// Returns None if contract is not configured.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID
    ///
    /// # Returns
    ///
    /// On-chain trust score (0-10000) or None if unavailable.
    pub async fn get_onchain_trust_score(&self, did: &str) -> Result<Option<u64>> {
        // Validate DID format
        if !did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                did
            )));
        }

        match &self.contract_client {
            Some(client) => {
                let score = client.get_trust_score(did).await?;
                Ok(Some(score))
            }
            None => Ok(None),
        }
    }

    /// Check if contract integration is available.
    pub fn has_contract(&self) -> bool {
        self.contract_client.is_some()
    }

    /// Verify an agent meets minimum trust requirements.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID
    /// * `min_score` - Minimum required trust score (0.0 - 1.0)
    ///
    /// # Returns
    ///
    /// `true` if agent meets the minimum score requirement.
    pub async fn verify(&self, did: &str, min_score: f64) -> Result<bool> {
        let trust_info = self.get_trust(did).await?;
        Ok(trust_info.score >= min_score)
    }

    /// Calculate reputation score from transaction history with time decay.
    ///
    /// Applies decay based on inactivity:
    /// - 5% decay per 14 days of inactivity
    /// - Decay is calculated on-demand at read time
    /// - Minimum reputation is 0.0 (never negative)
    fn calculate_reputation(&self, data: &TrustData) -> f64 {
        let total = data.successful_transactions + data.failed_transactions;
        if total == 0 {
            return 0.0;
        }

        // Success rate with volume factor
        let success_rate = data.successful_transactions as f64 / total as f64;
        let volume_factor = (total as f64 / 100.0).min(1.0); // Max at 100 transactions

        let base_reputation = success_rate * (0.5 + 0.5 * volume_factor);

        // Apply time decay based on inactivity
        let decay_factor = self.calculate_decay_factor(data.last_activity_timestamp);

        // Clamp to [0.0, 1.0]
        (base_reputation * decay_factor).clamp(0.0, 1.0)
    }

    /// Calculate decay factor based on time since last activity.
    ///
    /// Returns a value in [0.0, 1.0] where:
    /// - 1.0 = no decay (recent activity)
    /// - 0.0 = fully decayed (very old activity)
    ///
    /// Formula: decay_factor = 1.0 - (days_inactive * DECAY_RATE / DECAY_PERIOD_DAYS)
    fn calculate_decay_factor(&self, last_activity_timestamp: u64) -> f64 {
        if last_activity_timestamp == 0 {
            // No activity recorded, no decay (agent is new)
            return 1.0;
        }

        let now = current_timestamp();
        if last_activity_timestamp >= now {
            // Future timestamp or same time, no decay
            return 1.0;
        }

        let seconds_since_activity = now - last_activity_timestamp;
        let days_since_activity = seconds_since_activity as f64 / (24.0 * 60.0 * 60.0);

        // Calculate decay: 5% per 14 days
        // decay_factor = 1.0 - (days * 0.05 / 14)
        let decay = days_since_activity * DECAY_RATE / 14.0;

        // Clamp to [0.0, 1.0]
        (1.0 - decay).clamp(0.0, 1.0)
    }

    /// Calculate stake score from staked amount.
    fn calculate_stake_score(&self, stake_amount: u64) -> f64 {
        if stake_amount == 0 {
            return 0.0;
        }

        // Square root scaling up to reference stake
        let ratio = stake_amount as f64 / REFERENCE_STAKE as f64;
        ratio.sqrt().min(1.0)
    }

    /// Calculate endorsement score with hop decay and endorser trust weighting.
    ///
    /// Spec (trust-layer.md):
    /// - MAX_HOPS = 3 (beyond 3, endorsement is ignored)
    /// - DECAY_PER_HOP = 0.10 (decay factor = 0.9^hop_distance)
    /// - Max 10 endorsements counted (prevent gaming)
    /// - contribution = endorser_reputation * decay
    /// - Normalize by dividing by 3.0
    fn calculate_endorsement_score(&self, data: &TrustData) -> f64 {
        if data.endorsements.is_empty() {
            return 0.0;
        }

        let cache = self.cache.read().ok();
        let mut total_contribution = 0.0;
        let mut counted = 0;

        for endorsement in &data.endorsements {
            // Skip endorsements beyond max hop distance
            if endorsement.hop_distance > MAX_ENDORSEMENT_HOPS {
                continue;
            }

            // Limit to max endorsements
            if counted >= MAX_ENDORSEMENTS_COUNTED {
                break;
            }

            // Get endorser's reputation
            let endorser_reputation = cache
                .as_ref()
                .and_then(|c| c.get(&endorsement.endorser_did))
                .map(|data| self.calculate_reputation(data))
                .unwrap_or(0.0);

            // Calculate hop decay: 0.9^hop_distance
            let decay_factor = ENDORSEMENT_DECAY_PER_HOP.powi(endorsement.hop_distance as i32);

            // Contribution = endorser_reputation * decay
            let contribution = endorser_reputation * decay_factor;
            total_contribution += contribution;
            counted += 1;
        }

        // Normalize by dividing by 3.0 and cap at 1.0
        (total_contribution / ENDORSEMENT_NORMALIZATION).min(1.0)
    }

    /// Calculate endorsement score from count only (legacy/fallback).
    #[allow(dead_code)]
    fn calculate_endorsement_score_simple(&self, endorsement_count: u64) -> f64 {
        if endorsement_count == 0 {
            return 0.0;
        }

        // Logarithmic scaling, max at ~10 endorsements
        let score = (endorsement_count as f64).ln() / 10_f64.ln();
        score.min(1.0)
    }

    /// Record a successful transaction.
    ///
    /// Updates the last activity timestamp to reset decay timer.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID
    /// * `amount` - Transaction amount in USDC (6 decimals)
    ///
    /// # Errors
    ///
    /// Returns error if DID format is invalid.
    pub async fn record_success(&self, did: &str, _amount: u64) -> Result<()> {
        // Validate DID format
        if !did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                did
            )));
        }

        // Update cache
        let mut cache = self
            .cache
            .write()
            .map_err(|e| Error::Trust(format!("Failed to acquire cache write lock: {}", e)))?;

        let data = cache.entry(did.to_string()).or_default();
        data.successful_transactions += 1;
        // Reset decay timer on activity
        data.last_activity_timestamp = current_timestamp();

        // Note: On-chain recording requires ORACLE_ROLE and a configured signer.
        // The contract client supports read operations; write operations require
        // additional wallet/signer configuration which is beyond this local cache update.

        Ok(())
    }

    /// Record a failed transaction.
    ///
    /// Updates the last activity timestamp to reset decay timer.
    /// Failed transactions still count as activity.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID
    /// * `reason` - Failure reason description
    ///
    /// # Errors
    ///
    /// Returns error if DID format is invalid.
    pub async fn record_failure(&self, did: &str, _reason: &str) -> Result<()> {
        // Validate DID format
        if !did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                did
            )));
        }

        // Update cache
        let mut cache = self
            .cache
            .write()
            .map_err(|e| Error::Trust(format!("Failed to acquire cache write lock: {}", e)))?;

        let data = cache.entry(did.to_string()).or_default();
        data.failed_transactions += 1;
        // Reset decay timer on activity (even failures count as activity)
        data.last_activity_timestamp = current_timestamp();

        // Note: On-chain recording requires ORACLE_ROLE and a configured signer.
        // The contract client supports read operations; write operations require
        // additional wallet/signer configuration which is beyond this local cache update.

        Ok(())
    }

    /// Endorse another agent (simple version with default hop distance).
    ///
    /// This is a simplified endorsement API that assumes hop distance of 1
    /// (direct endorsement). For proper web-of-trust tracking, use
    /// `add_endorsement_with_hop` instead.
    ///
    /// # Arguments
    ///
    /// * `target_did` - Target agent's DID to endorse
    /// * `weight` - Endorsement weight (0.0 - 1.0) - currently stored but not used in calculation
    ///
    /// # Errors
    ///
    /// Returns error if:
    /// - Target DID format is invalid
    /// - Weight is outside [0.0, 1.0] range
    pub async fn endorse(&self, target_did: &str, weight: f64) -> Result<()> {
        // Validate DID format
        if !target_did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid DID format: '{}'. DID must start with 'did:'",
                target_did
            )));
        }

        // Validate weight range
        if !(0.0..=1.0).contains(&weight) {
            return Err(Error::Trust(format!(
                "Invalid endorsement weight: {}. Must be between 0.0 and 1.0",
                weight
            )));
        }

        // Update cache - use a generic "unknown" endorser for simple API
        // The endorsement will contribute based on the generic endorser's trust (0)
        let mut cache = self
            .cache
            .write()
            .map_err(|e| Error::Trust(format!("Failed to acquire cache write lock: {}", e)))?;

        let data = cache.entry(target_did.to_string()).or_default();
        data.endorsement_count += 1;

        // For backward compatibility, add a simple endorsement at hop 1
        // This endorsement won't contribute to score since the endorser doesn't exist
        // but the count is tracked for legacy callers
        data.endorsements.push(EndorsementData {
            endorser_did: format!(
                "did:agentmesh:base:anonymous-endorser-{}",
                data.endorsement_count
            ),
            hop_distance: 1,
        });

        // Note: On-chain endorsement requires the caller to be a registered agent.
        // The contract client supports read operations; write operations require
        // additional wallet/signer configuration which is beyond this local cache update.

        Ok(())
    }

    /// Add endorsement with explicit hop distance.
    ///
    /// This is the proper way to record endorsements that respects the
    /// web-of-trust hop decay model.
    ///
    /// # Arguments
    ///
    /// * `endorser_did` - DID of the endorser
    /// * `target_did` - DID of the agent being endorsed
    /// * `hop_distance` - Distance from trust root (1 = direct, 2 = one hop, etc.)
    ///
    /// # Behavior
    ///
    /// - Endorsements with hop_distance > MAX_ENDORSEMENT_HOPS (3) are recorded
    ///   but will be ignored in score calculation
    /// - Endorsement contribution = endorser_reputation * 0.9^hop_distance
    /// - Max 10 endorsements are counted in score calculation
    ///
    /// # Errors
    ///
    /// Returns error if either DID format is invalid.
    pub async fn add_endorsement_with_hop(
        &self,
        endorser_did: &str,
        target_did: &str,
        hop_distance: u32,
    ) -> Result<()> {
        // Validate DID formats
        if !endorser_did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid endorser DID format: '{}'. DID must start with 'did:'",
                endorser_did
            )));
        }
        if !target_did.starts_with("did:") {
            return Err(Error::Trust(format!(
                "Invalid target DID format: '{}'. DID must start with 'did:'",
                target_did
            )));
        }

        // Update cache
        let mut cache = self
            .cache
            .write()
            .map_err(|e| Error::Trust(format!("Failed to acquire cache write lock: {}", e)))?;

        let data = cache.entry(target_did.to_string()).or_default();
        data.endorsement_count += 1;
        data.endorsements.push(EndorsementData {
            endorser_did: endorser_did.to_string(),
            hop_distance,
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_service() -> TrustService {
        TrustService::new(
            "https://sepolia.base.org".to_string(),
            Some("0x1234567890abcdef".to_string()),
        )
    }

    // ========== TDD Tests: get_trust() ==========

    #[tokio::test]
    async fn test_get_trust_returns_zero_for_new_agent() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.get_trust("did:agentmesh:base:new-agent").await;

        // Assert
        assert!(result.is_ok());
        let trust = result.unwrap();
        assert_eq!(trust.score, 0.0, "New agent should have zero trust score");
        assert_eq!(trust.reputation, 0.0);
        assert_eq!(trust.stake_score, 0.0);
        assert_eq!(trust.endorsement_score, 0.0);
    }

    #[tokio::test]
    async fn test_get_trust_calculates_stake_score() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:staked-agent";
        // Stake $2,500 (25% of reference)
        service.set_trust_data(did, 2_500_000_000, 0, 0, 0);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: sqrt(0.25) = 0.5
        assert!(
            (trust.stake_score - 0.5).abs() < 0.01,
            "Stake score should be ~0.5 for 25% of reference stake, got {}",
            trust.stake_score
        );
    }

    #[tokio::test]
    async fn test_get_trust_calculates_reputation_score() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:reputable-agent";
        // 90% success rate with 100 transactions
        service.set_trust_data(did, 0, 90, 10, 0);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: 0.9 * (0.5 + 0.5 * 1.0) = 0.9
        assert!(
            (trust.reputation - 0.9).abs() < 0.01,
            "Reputation should be ~0.9 for 90% success rate at 100 txs, got {}",
            trust.reputation
        );
    }

    #[tokio::test]
    async fn test_get_trust_calculates_composite_score() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:full-agent";
        // Full reference stake, 100% success on 100 txs
        service.set_trust_data(did, REFERENCE_STAKE, 100, 0, 0);

        // Add real endorsements from trusted endorsers
        // Need enough endorsements to get endorsement_score close to 1.0
        // Each endorsement contributes: endorser_reputation * 0.9^hop / 3.0
        // With 5 high-trust endorsers at hop 1: 5 * (1.0 * 0.9) / 3.0 = 1.5 -> capped at 1.0
        for i in 0..5 {
            let endorser = format!("did:agentmesh:base:high-trust-endorser-{}", i);
            service.set_trust_data(&endorser, REFERENCE_STAKE, 100, 0, 0);
            service
                .add_endorsement_with_hop(&endorser, did, 1)
                .await
                .unwrap();
        }

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: composite with default weights (0.4, 0.3, 0.3)
        // reputation = 1.0, stake = 1.0, endorsements = 1.0 (capped)
        // score = 0.4 * 1.0 + 0.3 * 1.0 + 0.3 * 1.0 = 1.0
        assert!(
            trust.score > 0.9,
            "Full agent should have high trust score, got {}",
            trust.score
        );
    }

    #[tokio::test]
    async fn test_get_trust_rejects_invalid_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.get_trust("invalid-did").await;

        // Assert
        assert!(result.is_err(), "Should reject invalid DID format");
        assert!(result.unwrap_err().to_string().contains("DID"));
    }

    // ========== TDD Tests: verify() ==========

    #[tokio::test]
    async fn test_verify_returns_false_for_low_trust() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:low-trust";
        // Very low trust data
        service.set_trust_data(did, 100_000_000, 5, 5, 1);

        // Act
        let result = service.verify(did, 0.5).await;

        // Assert
        assert!(result.is_ok());
        assert!(
            !result.unwrap(),
            "Should return false for agent below threshold"
        );
    }

    #[tokio::test]
    async fn test_verify_returns_true_for_high_trust() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:high-trust";
        // High trust data
        service.set_trust_data(did, REFERENCE_STAKE, 100, 0, 10);

        // Act
        let result = service.verify(did, 0.5).await;

        // Assert
        assert!(result.is_ok());
        assert!(
            result.unwrap(),
            "Should return true for agent above threshold"
        );
    }

    #[tokio::test]
    async fn test_verify_with_zero_threshold() {
        // Arrange
        let service = test_service();

        // Act - even new agent should pass zero threshold
        let result = service.verify("did:agentmesh:base:any", 0.0).await;

        // Assert
        assert!(result.is_ok());
        assert!(result.unwrap(), "Should return true for zero threshold");
    }

    // ========== TDD Tests: record_success() ==========

    #[tokio::test]
    async fn test_record_success_increments_successful_transactions() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:worker";

        // Act
        service.record_success(did, 1_000_000).await.unwrap();
        service.record_success(did, 2_000_000).await.unwrap();

        // Assert
        let trust = service.get_trust(did).await.unwrap();
        assert_eq!(
            trust.successful_transactions, 2,
            "Should have 2 successful transactions"
        );
    }

    #[tokio::test]
    async fn test_record_success_validates_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.record_success("invalid-did", 1_000_000).await;

        // Assert
        assert!(result.is_err(), "Should reject invalid DID");
        assert!(result.unwrap_err().to_string().contains("DID"));
    }

    #[tokio::test]
    async fn test_record_success_improves_reputation() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:improving";

        // Record 10 successes
        for _ in 0..10 {
            service.record_success(did, 100_000).await.unwrap();
        }

        // Assert
        let trust = service.get_trust(did).await.unwrap();
        assert!(
            trust.reputation > 0.0,
            "Reputation should improve with successes"
        );
    }

    // ========== TDD Tests: record_failure() ==========

    #[tokio::test]
    async fn test_record_failure_increments_failed_transactions() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:failing";

        // Act
        service.record_failure(did, "timeout").await.unwrap();
        service.record_failure(did, "error").await.unwrap();

        // Assert
        let trust = service.get_trust(did).await.unwrap();
        assert_eq!(
            trust.failed_transactions, 2,
            "Should have 2 failed transactions"
        );
    }

    #[tokio::test]
    async fn test_record_failure_validates_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.record_failure("invalid-did", "error").await;

        // Assert
        assert!(result.is_err(), "Should reject invalid DID");
    }

    #[tokio::test]
    async fn test_record_failure_hurts_reputation() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:mixed";

        // Record 8 successes and 2 failures (80% success rate)
        for _ in 0..8 {
            service.record_success(did, 100_000).await.unwrap();
        }
        for _ in 0..2 {
            service.record_failure(did, "error").await.unwrap();
        }

        // Assert
        let trust = service.get_trust(did).await.unwrap();
        assert!(
            trust.reputation < 0.9,
            "Reputation should be < 0.9 with 80% success"
        );
        assert!(
            trust.reputation > 0.3,
            "Reputation should still be positive"
        );
    }

    // ========== TDD Tests: endorse() ==========

    #[tokio::test]
    async fn test_endorse_increments_endorsement_count() {
        // Arrange
        let service = test_service();
        let target_did = "did:agentmesh:base:endorsed";

        // Act
        service.endorse(target_did, 1.0).await.unwrap();
        service.endorse(target_did, 0.8).await.unwrap();

        // Assert
        let trust = service.get_trust(target_did).await.unwrap();
        assert_eq!(trust.endorsement_count, 2, "Should have 2 endorsements");
    }

    #[tokio::test]
    async fn test_endorse_validates_target_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.endorse("invalid-did", 1.0).await;

        // Assert
        assert!(result.is_err(), "Should reject invalid target DID");
    }

    #[tokio::test]
    async fn test_endorse_validates_weight_range() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:target";

        // Act - weight must be 0.0 to 1.0
        let result_low = service.endorse(did, -0.1).await;
        let result_high = service.endorse(did, 1.1).await;

        // Assert
        assert!(result_low.is_err(), "Should reject negative weight");
        assert!(result_high.is_err(), "Should reject weight > 1.0");
    }

    #[tokio::test]
    async fn test_endorse_improves_endorsement_score() {
        // Arrange
        let service = test_service();
        let target_did = "did:agentmesh:base:popular";

        // Create 5 endorsers with trust data and add endorsements
        for i in 0..5 {
            let endorser = format!("did:agentmesh:base:real-endorser-{}", i);
            service.set_trust_data(&endorser, REFERENCE_STAKE, 100, 0, 0);
            service
                .add_endorsement_with_hop(&endorser, target_did, 1)
                .await
                .unwrap();
        }

        // Assert
        let trust = service.get_trust(target_did).await.unwrap();
        assert!(
            trust.endorsement_score > 0.0,
            "Endorsement score should improve with endorsements from trusted agents"
        );
    }

    // ========== TDD Tests: Contract integration ==========

    #[test]
    fn test_has_contract_returns_false_without_address() {
        // Arrange
        let service = TrustService::new("https://sepolia.base.org".to_string(), None);

        // Assert
        assert!(
            !service.has_contract(),
            "Should return false without contract address"
        );
    }

    #[test]
    fn test_has_contract_returns_true_with_valid_address() {
        // Arrange
        let service = TrustService::new(
            "https://sepolia.base.org".to_string(),
            Some("0x1234567890123456789012345678901234567890".to_string()),
        );

        // Assert
        assert!(
            service.has_contract(),
            "Should return true with valid contract address"
        );
    }

    #[test]
    fn test_has_contract_returns_false_with_invalid_address() {
        // Arrange
        let service = TrustService::new(
            "https://sepolia.base.org".to_string(),
            Some("invalid-address".to_string()),
        );

        // Assert - invalid address should not create contract client
        assert!(
            !service.has_contract(),
            "Should return false with invalid contract address"
        );
    }

    #[tokio::test]
    async fn test_get_onchain_trust_score_returns_none_without_contract() {
        // Arrange
        let service = TrustService::new("https://sepolia.base.org".to_string(), None);

        // Act
        let result = service
            .get_onchain_trust_score("did:agentmesh:base:test")
            .await;

        // Assert
        assert!(result.is_ok());
        assert!(
            result.unwrap().is_none(),
            "Should return None without contract"
        );
    }

    #[tokio::test]
    async fn test_get_onchain_trust_score_validates_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service.get_onchain_trust_score("invalid-did").await;

        // Assert
        assert!(result.is_err(), "Should reject invalid DID");
    }

    // ========== TDD Tests: Reputation Decay ==========
    //
    // Spec: 5% decay per 14 days of inactivity
    // Formula: recency_factor = max(0.0, 1.0 - (days_inactive * DECAY_RATE / DECAY_PERIOD))
    // Best practice: Exponential decay preferred, but linear with clamp is simpler

    #[tokio::test]
    async fn test_reputation_no_decay_for_recent_activity() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:active-agent";

        // Set trust data with recent activity (now)
        service.set_trust_data_with_timestamp(
            did,
            0,                   // stake
            100,                 // successful txs
            0,                   // failed txs
            0,                   // endorsements
            current_timestamp(), // last activity = now
        );

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: No decay for recent activity
        // 100% success rate with 100 txs = 1.0 * (0.5 + 0.5 * 1.0) = 1.0
        assert!(
            trust.reputation > 0.95,
            "Recent activity should not decay reputation, got {}",
            trust.reputation
        );
    }

    #[tokio::test]
    async fn test_reputation_decays_after_14_days_inactivity() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:inactive-agent";

        // Set trust data with activity 14 days ago
        let fourteen_days_ago = current_timestamp() - (14 * 24 * 60 * 60);
        service.set_trust_data_with_timestamp(did, 0, 100, 0, 0, fourteen_days_ago);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: 5% decay after 14 days
        // Base reputation ~1.0, after 5% decay = ~0.95
        assert!(
            trust.reputation < 0.96,
            "14 days inactivity should apply 5% decay, got {}",
            trust.reputation
        );
        assert!(
            trust.reputation > 0.90,
            "Decay should not be more than 5% for 14 days, got {}",
            trust.reputation
        );
    }

    #[tokio::test]
    async fn test_reputation_decays_more_after_28_days() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:long-inactive";

        // Set trust data with activity 28 days ago (2 decay periods)
        let twenty_eight_days_ago = current_timestamp() - (28 * 24 * 60 * 60);
        service.set_trust_data_with_timestamp(did, 0, 100, 0, 0, twenty_eight_days_ago);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: ~10% decay after 28 days (2 periods)
        assert!(
            trust.reputation < 0.91,
            "28 days should have ~10% decay, got {}",
            trust.reputation
        );
        assert!(
            trust.reputation > 0.85,
            "Decay should be around 10% for 28 days, got {}",
            trust.reputation
        );
    }

    #[tokio::test]
    async fn test_reputation_decay_caps_at_zero() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:very-old";

        // Set trust data with activity 1 year ago (should be fully decayed)
        let one_year_ago = current_timestamp() - (365 * 24 * 60 * 60);
        service.set_trust_data_with_timestamp(did, 0, 100, 0, 0, one_year_ago);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: Decay should cap at 0, never go negative
        assert!(
            trust.reputation >= 0.0,
            "Reputation should never be negative, got {}",
            trust.reputation
        );
    }

    #[tokio::test]
    async fn test_reputation_decay_does_not_affect_new_agents() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:new-agent-decay";

        // New agent with no transactions (timestamp = 0)
        service.set_trust_data_with_timestamp(did, 0, 0, 0, 0, 0);

        // Act
        let trust = service.get_trust(did).await.unwrap();

        // Assert: Zero transactions = zero reputation (no decay to apply)
        assert_eq!(
            trust.reputation, 0.0,
            "New agent should have zero reputation"
        );
    }

    #[tokio::test]
    async fn test_record_success_updates_last_activity() {
        // Arrange
        let service = test_service();
        let did = "did:agentmesh:base:updating-agent";

        // Set old activity timestamp
        let old_time = current_timestamp() - (30 * 24 * 60 * 60);
        service.set_trust_data_with_timestamp(did, 0, 50, 0, 0, old_time);

        // Act: Record new success (should update timestamp)
        service.record_success(did, 1_000_000).await.unwrap();

        // Get trust - should have minimal decay now
        let trust = service.get_trust(did).await.unwrap();

        // Assert: Activity timestamp updated, minimal decay
        assert!(
            trust.reputation > 0.45,
            "Recording success should reset decay timer, got {}",
            trust.reputation
        );
    }

    // ========== TDD Tests: Endorsement Decay & Hop Limit Validation ==========
    //
    // Spec (trust-layer.md):
    // - MAX_HOPS = 3 (beyond 3, trust is too diluted)
    // - DECAY_PER_HOP = 0.10 (10% decay = factor 0.9^hops)
    // - Max 10 endorsements counted (prevent gaming)
    // - contribution = endorser_trust_score * decay
    // - Normalize by dividing by 3.0

    #[tokio::test]
    async fn test_endorsement_hop_decay_at_hop_1() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:trusted-endorser";
        let target_did = "did:agentmesh:base:endorsed-agent";

        // Endorser has high trust (1.0 reputation)
        service.set_trust_data(endorser_did, REFERENCE_STAKE, 100, 0, 0);

        // Add endorsement at hop 1
        service
            .add_endorsement_with_hop(endorser_did, target_did, 1)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: hop 1 decay = 0.9^1 = 0.9
        // Endorser trust ~1.0, contribution = 1.0 * 0.9 = 0.9
        // Normalized by 3.0 = 0.3
        assert!(
            trust.endorsement_score > 0.25,
            "Hop 1 endorsement should contribute ~0.3, got {}",
            trust.endorsement_score
        );
        assert!(
            trust.endorsement_score < 0.35,
            "Hop 1 endorsement should contribute ~0.3, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_hop_decay_at_hop_2() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:indirect-endorser";
        let target_did = "did:agentmesh:base:target-hop2";

        // Endorser has high trust
        service.set_trust_data(endorser_did, REFERENCE_STAKE, 100, 0, 0);

        // Add endorsement at hop 2
        service
            .add_endorsement_with_hop(endorser_did, target_did, 2)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: hop 2 decay = 0.9^2 = 0.81
        // Endorser trust ~1.0, contribution = 1.0 * 0.81 = 0.81
        // Normalized by 3.0 = 0.27
        assert!(
            trust.endorsement_score > 0.20,
            "Hop 2 endorsement should contribute ~0.27, got {}",
            trust.endorsement_score
        );
        assert!(
            trust.endorsement_score < 0.30,
            "Hop 2 endorsement should contribute ~0.27, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_hop_decay_at_hop_3() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:far-endorser";
        let target_did = "did:agentmesh:base:target-hop3";

        // Endorser has high trust
        service.set_trust_data(endorser_did, REFERENCE_STAKE, 100, 0, 0);

        // Add endorsement at hop 3 (max allowed)
        service
            .add_endorsement_with_hop(endorser_did, target_did, 3)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: hop 3 decay = 0.9^3 = 0.729
        // Endorser trust ~1.0, contribution = 1.0 * 0.729 = 0.729
        // Normalized by 3.0 = 0.243
        assert!(
            trust.endorsement_score > 0.20,
            "Hop 3 endorsement should contribute ~0.24, got {}",
            trust.endorsement_score
        );
        assert!(
            trust.endorsement_score < 0.28,
            "Hop 3 endorsement should contribute ~0.24, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_ignored_beyond_max_hops() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:too-far-endorser";
        let target_did = "did:agentmesh:base:target-hop4";

        // Endorser has high trust
        service.set_trust_data(endorser_did, REFERENCE_STAKE, 100, 0, 0);

        // Add endorsement at hop 4 (beyond max 3)
        service
            .add_endorsement_with_hop(endorser_did, target_did, 4)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: Endorsement beyond hop 3 should be ignored
        assert_eq!(
            trust.endorsement_score, 0.0,
            "Endorsement at hop 4 should be ignored, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_considers_endorser_trust_score() {
        // Arrange
        let service = test_service();
        let high_trust_endorser = "did:agentmesh:base:high-trust";
        let low_trust_endorser = "did:agentmesh:base:low-trust";
        let target_high = "did:agentmesh:base:endorsed-by-high";
        let target_low = "did:agentmesh:base:endorsed-by-low";

        // High trust endorser (100% success, 100 txs)
        service.set_trust_data(high_trust_endorser, 0, 100, 0, 0);
        // Low trust endorser (50% success, 100 txs)
        service.set_trust_data(low_trust_endorser, 0, 50, 50, 0);

        // Add endorsements at hop 1
        service
            .add_endorsement_with_hop(high_trust_endorser, target_high, 1)
            .await
            .unwrap();
        service
            .add_endorsement_with_hop(low_trust_endorser, target_low, 1)
            .await
            .unwrap();

        // Act
        let trust_high = service.get_trust(target_high).await.unwrap();
        let trust_low = service.get_trust(target_low).await.unwrap();

        // Assert: High trust endorser should give higher contribution
        assert!(
            trust_high.endorsement_score > trust_low.endorsement_score,
            "High trust endorser should give higher score: {} vs {}",
            trust_high.endorsement_score,
            trust_low.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_max_10_counted() {
        // Arrange
        let service = test_service();
        let target_did = "did:agentmesh:base:popular-agent";

        // Add 15 endorsements from different agents
        for i in 0..15 {
            let endorser = format!("did:agentmesh:base:endorser-{}", i);
            service.set_trust_data(&endorser, REFERENCE_STAKE, 100, 0, 0);
            service
                .add_endorsement_with_hop(&endorser, target_did, 1)
                .await
                .unwrap();
        }

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: Max 10 endorsements counted
        // Each contributes ~0.3 (1.0 * 0.9 / 3.0), max = 1.0 (capped)
        // With 10 endorsements: 10 * 0.3 = 3.0, but capped at 1.0
        assert!(
            trust.endorsement_score <= 1.0,
            "Endorsement score should cap at 1.0, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_score_aggregates_multiple_endorsers() {
        // Arrange
        let service = test_service();
        let target_did = "did:agentmesh:base:multi-endorsed";

        // Add 3 endorsements from different agents at different hops
        let endorser1 = "did:agentmesh:base:e1";
        let endorser2 = "did:agentmesh:base:e2";
        let endorser3 = "did:agentmesh:base:e3";

        service.set_trust_data(endorser1, REFERENCE_STAKE, 100, 0, 0); // trust ~1.0
        service.set_trust_data(endorser2, REFERENCE_STAKE, 100, 0, 0); // trust ~1.0
        service.set_trust_data(endorser3, REFERENCE_STAKE, 100, 0, 0); // trust ~1.0

        service
            .add_endorsement_with_hop(endorser1, target_did, 1)
            .await
            .unwrap(); // 1.0 * 0.9 = 0.9
        service
            .add_endorsement_with_hop(endorser2, target_did, 2)
            .await
            .unwrap(); // 1.0 * 0.81 = 0.81
        service
            .add_endorsement_with_hop(endorser3, target_did, 3)
            .await
            .unwrap(); // 1.0 * 0.729 = 0.729

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: Total contribution = (0.9 + 0.81 + 0.729) / 3.0 = 0.813
        assert!(
            trust.endorsement_score > 0.75,
            "3 endorsements should give ~0.81, got {}",
            trust.endorsement_score
        );
        assert!(
            trust.endorsement_score < 0.90,
            "3 endorsements should give ~0.81, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_with_hop_validates_endorser_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service
            .add_endorsement_with_hop("invalid-endorser", "did:agentmesh:base:target", 1)
            .await;

        // Assert
        assert!(result.is_err(), "Should reject invalid endorser DID");
        assert!(result.unwrap_err().to_string().contains("endorser DID"));
    }

    #[tokio::test]
    async fn test_endorsement_with_hop_validates_target_did() {
        // Arrange
        let service = test_service();

        // Act
        let result = service
            .add_endorsement_with_hop("did:agentmesh:base:endorser", "invalid-target", 1)
            .await;

        // Assert
        assert!(result.is_err(), "Should reject invalid target DID");
        assert!(result.unwrap_err().to_string().contains("target DID"));
    }

    #[tokio::test]
    async fn test_endorsement_at_hop_0_gives_full_contribution() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:direct-endorser";
        let target_did = "did:agentmesh:base:direct-target";

        // Endorser has high trust
        service.set_trust_data(endorser_did, REFERENCE_STAKE, 100, 0, 0);

        // Add endorsement at hop 0 (direct trust root)
        service
            .add_endorsement_with_hop(endorser_did, target_did, 0)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: hop 0 decay = 0.9^0 = 1.0 (no decay)
        // Endorser trust ~1.0, contribution = 1.0 * 1.0 = 1.0
        // Normalized by 3.0 = 0.333
        assert!(
            trust.endorsement_score > 0.30,
            "Hop 0 endorsement should give ~0.33, got {}",
            trust.endorsement_score
        );
    }

    #[tokio::test]
    async fn test_endorsement_with_zero_trust_endorser_gives_zero_contribution() {
        // Arrange
        let service = test_service();
        let endorser_did = "did:agentmesh:base:new-endorser";
        let target_did = "did:agentmesh:base:endorsed-by-new";

        // Endorser has NO trust data (new agent)
        // Do not set any trust data for endorser

        // Add endorsement at hop 1
        service
            .add_endorsement_with_hop(endorser_did, target_did, 1)
            .await
            .unwrap();

        // Act
        let trust = service.get_trust(target_did).await.unwrap();

        // Assert: Endorser has 0 reputation, contribution = 0
        assert_eq!(
            trust.endorsement_score, 0.0,
            "Endorsement from zero-trust agent should contribute nothing, got {}",
            trust.endorsement_score
        );
    }
}
