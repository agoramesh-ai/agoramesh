//! Arbitration Integration for AgentMe.
//!
//! This module provides a tiered dispute resolution system:
//!
//! - **Tier 1** (< $10): Automatic smart contract resolution
//! - **Tier 2** ($10-$1000): AI-assisted arbitration with appeal flow
//! - **Tier 3** (> $1000): Kleros decentralized community arbitration
//!
//! ## Features
//!
//! - **ERC-792 Compatible**: Implements IArbitrable interface patterns
//! - **AI Arbitration**: Explainable AI-assisted dispute resolution (Tier 2)
//! - **Dispute Lifecycle**: Create, evidence submission, appeal, settlement
//! - **Cost Calculation**: Arbitration and appeal fee estimation
//! - **Status Tracking**: Monitor dispute progression
//!
//! ## AI Arbitration (Tier 2)
//!
//! Based on AAA-ICDR AI Arbitrator standards:
//! - Explainable reasoning with transparent decision-making
//! - Evidence-based evaluation with structured submissions
//! - Human oversight through appeal to Tier 3 (Kleros)
//! - Due process with equal opportunity for both parties
//!
//! ```rust,ignore
//! use agentme_node::arbitration::{AIArbitrator, AIArbitrationConfig, Evidence};
//!
//! let config = AIArbitrationConfig::default();
//! let arbitrator = AIArbitrator::new(config);
//!
//! // Submit dispute with evidence
//! let dispute_id = arbitrator.create_dispute(escrow_id, client_did, provider_did, amount).await?;
//!
//! // Submit evidence from both parties
//! arbitrator.submit_evidence(dispute_id, &client_evidence).await?;
//! arbitrator.submit_evidence(dispute_id, &provider_evidence).await?;
//!
//! // Request AI ruling
//! let ruling = arbitrator.request_ruling(dispute_id).await?;
//!
//! // Appeal to Tier 3 if unsatisfied
//! if ruling.can_appeal() {
//!     let kleros_dispute = arbitrator.appeal_to_kleros(dispute_id).await?;
//! }
//! ```
//!
//! ## Kleros Integration (Tier 3)
//!
//! Kleros supports Base L2 as of 2025. Key contracts:
//! - KlerosLiquid: Main arbitrator contract
//! - DisputeKitClassic: Standard dispute resolution
//!
//! ## Usage
//!
//! ```rust,ignore
//! use agentme_node::arbitration::{KlerosClient, KlerosConfig, DisputeStatus};
//!
//! let config = KlerosConfig {
//!     rpc_url: "https://sepolia.base.org".to_string(),
//!     arbitrator_address: "0x...".to_string(),
//!     ..Default::default()
//! };
//!
//! let client = KlerosClient::new(config)?;
//!
//! // Check arbitration cost
//! let cost = client.get_arbitration_cost(3).await?; // 3 choices
//!
//! // Create dispute
//! let dispute_id = client.create_dispute(escrow_id, evidence_uri, choices).await?;
//!
//! // Check status
//! let status = client.get_dispute_status(dispute_id).await?;
//! ```

use alloy::primitives::{Address, U256};
use alloy::sol;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::error::{Error, Result};

// ========== Dispute Tier Thresholds ==========

/// Tier 1 threshold: disputes below $10 are resolved automatically.
pub const TIER_1_MAX_USDC: u64 = 10_000_000; // $10 in USDC (6 decimals)

/// Tier 2 threshold: disputes $10-$1000 use AI arbitration.
pub const TIER_2_MAX_USDC: u64 = 1_000_000_000; // $1000 in USDC (6 decimals)

/// Tier 3 threshold: disputes above $1000 use Kleros community arbitration.
pub const TIER_3_MIN_USDC: u64 = 1_000_000_000; // $1000 in USDC (6 decimals)

/// Determine the appropriate dispute tier for a given amount.
pub fn determine_tier(amount_usdc: u64) -> DisputeTier {
    if amount_usdc < TIER_1_MAX_USDC {
        DisputeTier::Automatic
    } else if amount_usdc < TIER_2_MAX_USDC {
        DisputeTier::AIAssisted
    } else {
        DisputeTier::Community
    }
}

/// Dispute resolution tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisputeTier {
    /// Tier 1: Automatic resolution via smart contract rules (< $10).
    Automatic,
    /// Tier 2: AI-assisted arbitration ($10-$1000).
    AIAssisted,
    /// Tier 3: Community arbitration via Kleros (> $1000).
    Community,
}

impl DisputeTier {
    /// Get human-readable tier name.
    pub fn name(&self) -> &'static str {
        match self {
            DisputeTier::Automatic => "Automatic",
            DisputeTier::AIAssisted => "AI-Assisted",
            DisputeTier::Community => "Community",
        }
    }

    /// Get the tier number (1, 2, or 3).
    pub fn number(&self) -> u8 {
        match self {
            DisputeTier::Automatic => 1,
            DisputeTier::AIAssisted => 2,
            DisputeTier::Community => 3,
        }
    }
}

// ========== ERC-792 Contract Interfaces ==========

sol!(
    #[allow(missing_docs)]
    #[sol(rpc)]
    IArbitrator,
    r#"[
        {
            "type": "function",
            "name": "createDispute",
            "inputs": [
                {"name": "_choices", "type": "uint256"},
                {"name": "_extraData", "type": "bytes"}
            ],
            "outputs": [{"name": "disputeID", "type": "uint256"}],
            "stateMutability": "payable"
        },
        {
            "type": "function",
            "name": "arbitrationCost",
            "inputs": [
                {"name": "_extraData", "type": "bytes"}
            ],
            "outputs": [{"name": "cost", "type": "uint256"}],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "appeal",
            "inputs": [
                {"name": "_disputeID", "type": "uint256"},
                {"name": "_extraData", "type": "bytes"}
            ],
            "outputs": [],
            "stateMutability": "payable"
        },
        {
            "type": "function",
            "name": "appealCost",
            "inputs": [
                {"name": "_disputeID", "type": "uint256"},
                {"name": "_extraData", "type": "bytes"}
            ],
            "outputs": [{"name": "cost", "type": "uint256"}],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "appealPeriod",
            "inputs": [
                {"name": "_disputeID", "type": "uint256"}
            ],
            "outputs": [
                {"name": "start", "type": "uint256"},
                {"name": "end", "type": "uint256"}
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "disputeStatus",
            "inputs": [
                {"name": "_disputeID", "type": "uint256"}
            ],
            "outputs": [{"name": "status", "type": "uint8"}],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "currentRuling",
            "inputs": [
                {"name": "_disputeID", "type": "uint256"}
            ],
            "outputs": [{"name": "ruling", "type": "uint256"}],
            "stateMutability": "view"
        }
    ]"#
);

// ========== Types ==========

/// Dispute status as defined in ERC-792.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisputeStatus {
    /// Dispute is waiting for arbitration.
    Waiting = 0,
    /// Dispute has a ruling that can be appealed.
    Appealable = 1,
    /// Dispute is fully resolved.
    Solved = 2,
}

impl TryFrom<u8> for DisputeStatus {
    type Error = Error;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(DisputeStatus::Waiting),
            1 => Ok(DisputeStatus::Appealable),
            2 => Ok(DisputeStatus::Solved),
            _ => Err(Error::Contract(format!(
                "Invalid dispute status: {}",
                value
            ))),
        }
    }
}

impl DisputeStatus {
    /// Check if dispute is still pending resolution.
    pub fn is_pending(&self) -> bool {
        matches!(self, DisputeStatus::Waiting | DisputeStatus::Appealable)
    }

    /// Check if dispute is final.
    pub fn is_final(&self) -> bool {
        matches!(self, DisputeStatus::Solved)
    }

    /// Get human-readable status name.
    pub fn name(&self) -> &'static str {
        match self {
            DisputeStatus::Waiting => "Waiting",
            DisputeStatus::Appealable => "Appealable",
            DisputeStatus::Solved => "Solved",
        }
    }
}

/// Ruling options for AgentMe disputes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Ruling {
    /// Ruling not yet given or abstained (0).
    None = 0,
    /// Favor the client (refund).
    FavorClient = 1,
    /// Favor the provider (release).
    FavorProvider = 2,
    /// Split funds according to percentages.
    Split = 3,
}

impl TryFrom<u64> for Ruling {
    type Error = Error;

    fn try_from(value: u64) -> Result<Self> {
        match value {
            0 => Ok(Ruling::None),
            1 => Ok(Ruling::FavorClient),
            2 => Ok(Ruling::FavorProvider),
            3 => Ok(Ruling::Split),
            _ => Err(Error::Contract(format!("Invalid ruling: {}", value))),
        }
    }
}

impl Ruling {
    /// Get human-readable ruling name.
    pub fn name(&self) -> &'static str {
        match self {
            Ruling::None => "None",
            Ruling::FavorClient => "Favor Client",
            Ruling::FavorProvider => "Favor Provider",
            Ruling::Split => "Split",
        }
    }
}

/// Appeal period window.
#[derive(Debug, Clone, Copy)]
pub struct AppealPeriod {
    /// Start timestamp (Unix).
    pub start: u64,
    /// End timestamp (Unix).
    pub end: u64,
}

impl AppealPeriod {
    /// Check if we're currently in the appeal period.
    pub fn is_active(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        now >= self.start && now < self.end
    }

    /// Get remaining time in appeal period.
    pub fn remaining_secs(&self) -> i64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        (self.end as i64) - (now as i64)
    }

    /// Get the duration of the appeal period.
    pub fn duration(&self) -> Duration {
        Duration::from_secs(self.end.saturating_sub(self.start))
    }
}

/// Full dispute information from Kleros.
#[derive(Debug, Clone)]
pub struct KlerosDispute {
    /// Kleros dispute ID.
    pub dispute_id: U256,
    /// Current status.
    pub status: DisputeStatus,
    /// Current ruling (may change until Solved).
    pub ruling: Ruling,
    /// Appeal period if in Appealable status.
    pub appeal_period: Option<AppealPeriod>,
    /// Number of choices in the dispute.
    pub choices: u64,
}

// ========== Configuration ==========

/// Configuration for Kleros client.
#[derive(Debug, Clone)]
pub struct KlerosConfig {
    /// Ethereum RPC URL.
    pub rpc_url: String,

    /// Kleros arbitrator contract address.
    pub arbitrator_address: String,

    /// Court/subcourt ID for AgentMe disputes.
    pub court_id: u64,

    /// Number of jurors for initial round.
    pub initial_jurors: u64,

    /// Timeout for RPC calls.
    pub timeout: Duration,
}

impl Default for KlerosConfig {
    fn default() -> Self {
        Self {
            rpc_url: "https://sepolia.base.org".to_string(),
            // Kleros on Base Sepolia (placeholder - replace with actual deployment)
            arbitrator_address: "0x0000000000000000000000000000000000000000".to_string(),
            court_id: 0, // General court
            initial_jurors: 3,
            timeout: Duration::from_secs(30),
        }
    }
}

impl KlerosConfig {
    /// Create config with custom RPC URL and arbitrator address.
    pub fn new(rpc_url: impl Into<String>, arbitrator_address: impl Into<String>) -> Self {
        Self {
            rpc_url: rpc_url.into(),
            arbitrator_address: arbitrator_address.into(),
            ..Default::default()
        }
    }

    /// Set the court ID for disputes.
    pub fn with_court_id(mut self, court_id: u64) -> Self {
        self.court_id = court_id;
        self
    }

    /// Set the number of initial jurors.
    pub fn with_jurors(mut self, jurors: u64) -> Self {
        self.initial_jurors = jurors;
        self
    }

    /// Encode extra data for Kleros (court ID + jurors).
    pub fn encode_extra_data(&self) -> Vec<u8> {
        // Kleros extraData format: abi.encode(courtId, minJurors)
        let mut data = Vec::with_capacity(64);

        // Court ID (uint96 in Kleros, but we'll encode as uint256)
        let court_bytes = U256::from(self.court_id).to_be_bytes::<32>();
        data.extend_from_slice(&court_bytes);

        // Min jurors (uint256)
        let juror_bytes = U256::from(self.initial_jurors).to_be_bytes::<32>();
        data.extend_from_slice(&juror_bytes);

        data
    }
}

// ========== Statistics ==========

/// Statistics for Kleros client operations.
#[derive(Debug, Default)]
pub struct KlerosStats {
    /// Number of disputes created.
    pub disputes_created: AtomicU64,
    /// Number of appeals filed.
    pub appeals_filed: AtomicU64,
    /// Number of rulings received.
    pub rulings_received: AtomicU64,
    /// Number of RPC errors.
    pub rpc_errors: AtomicU64,
}

impl KlerosStats {
    /// Record a dispute creation.
    pub fn record_dispute_created(&self) {
        self.disputes_created.fetch_add(1, Ordering::Relaxed);
    }

    /// Record an appeal.
    pub fn record_appeal(&self) {
        self.appeals_filed.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a ruling received.
    pub fn record_ruling(&self) {
        self.rulings_received.fetch_add(1, Ordering::Relaxed);
    }

    /// Record an RPC error.
    pub fn record_error(&self) {
        self.rpc_errors.fetch_add(1, Ordering::Relaxed);
    }
}

// ========== Kleros Client ==========

/// Client for interacting with Kleros arbitrator contract.
///
/// Provides methods for creating disputes, checking status, and filing appeals.
pub struct KlerosClient {
    config: KlerosConfig,
    arbitrator_address: Address,
    stats: Arc<KlerosStats>,
}

impl KlerosClient {
    /// Create a new Kleros client.
    pub fn new(config: KlerosConfig) -> Result<Self> {
        let arbitrator_address = config
            .arbitrator_address
            .parse::<Address>()
            .map_err(|e| Error::Config(format!("Invalid arbitrator address: {}", e)))?;

        Ok(Self {
            config,
            arbitrator_address,
            stats: Arc::new(KlerosStats::default()),
        })
    }

    /// Create a disabled client for testing.
    pub fn disabled() -> Self {
        Self {
            config: KlerosConfig::default(),
            arbitrator_address: Address::ZERO,
            stats: Arc::new(KlerosStats::default()),
        }
    }

    /// Get client statistics.
    pub fn stats(&self) -> &KlerosStats {
        &self.stats
    }

    /// Get the client configuration.
    pub fn config(&self) -> &KlerosConfig {
        &self.config
    }

    /// Get the arbitrator contract address.
    pub fn arbitrator_address(&self) -> Address {
        self.arbitrator_address
    }

    /// Check if the client is properly configured.
    pub fn is_configured(&self) -> bool {
        self.arbitrator_address != Address::ZERO
    }

    /// Get the arbitration cost for a dispute with given number of choices.
    ///
    /// # Arguments
    /// * `choices` - Number of possible rulings (typically 3 for AgentMe)
    ///
    /// # Returns
    /// Cost in wei (ETH for gas, not USDC)
    pub async fn get_arbitration_cost(&self, _choices: u64) -> Result<U256> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        // In a real implementation, we would call the contract:
        // let provider = ProviderBuilder::new().connect_http(self.config.rpc_url.parse()?);
        // let contract = IArbitrator::new(self.arbitrator_address, provider);
        // let extra_data = self.config.encode_extra_data();
        // let cost = contract.arbitrationCost(extra_data.into()).call().await?;

        // For now, return a placeholder cost (0.01 ETH = 10^16 wei)
        // Real cost depends on court and juror count
        Ok(U256::from(10_000_000_000_000_000u64))
    }

    /// Get the appeal cost for an existing dispute.
    ///
    /// # Arguments
    /// * `dispute_id` - Kleros dispute ID
    ///
    /// # Returns
    /// Cost in wei for filing an appeal
    pub async fn get_appeal_cost(&self, _dispute_id: U256) -> Result<U256> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        // Appeal cost is typically 2x the previous round
        // Real implementation would call appealCost()
        Ok(U256::from(20_000_000_000_000_000u64))
    }

    /// Get the current status of a dispute.
    ///
    /// # Arguments
    /// * `dispute_id` - Kleros dispute ID
    ///
    /// # Returns
    /// Current dispute status
    pub async fn get_dispute_status(&self, _dispute_id: U256) -> Result<DisputeStatus> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        // Real implementation would call disputeStatus()
        Ok(DisputeStatus::Waiting)
    }

    /// Get the current ruling for a dispute.
    ///
    /// Note: Ruling may change until dispute status is Solved.
    ///
    /// # Arguments
    /// * `dispute_id` - Kleros dispute ID
    ///
    /// # Returns
    /// Current ruling
    pub async fn get_current_ruling(&self, _dispute_id: U256) -> Result<Ruling> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        self.stats.record_ruling();

        // Real implementation would call currentRuling()
        Ok(Ruling::None)
    }

    /// Get the appeal period for a dispute.
    ///
    /// # Arguments
    /// * `dispute_id` - Kleros dispute ID
    ///
    /// # Returns
    /// Appeal period start and end timestamps, or None if not appealable
    pub async fn get_appeal_period(&self, _dispute_id: U256) -> Result<Option<AppealPeriod>> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        // Real implementation would call appealPeriod()
        // Returns (0, 0) if not in appeal period
        Ok(None)
    }

    /// Get full dispute information.
    ///
    /// # Arguments
    /// * `dispute_id` - Kleros dispute ID
    /// * `choices` - Number of choices in the dispute
    ///
    /// # Returns
    /// Full dispute information
    pub async fn get_dispute(&self, dispute_id: U256, choices: u64) -> Result<KlerosDispute> {
        let status = self.get_dispute_status(dispute_id).await?;
        let ruling = self.get_current_ruling(dispute_id).await?;
        let appeal_period = if status == DisputeStatus::Appealable {
            self.get_appeal_period(dispute_id).await?
        } else {
            None
        };

        Ok(KlerosDispute {
            dispute_id,
            status,
            ruling,
            appeal_period,
            choices,
        })
    }

    /// Calculate the minimum stake required for Tier 3 disputes.
    ///
    /// Based on Kleros economics: jurors must stake PNK tokens.
    /// For AgentMe, we require a minimum USDC stake equivalent.
    ///
    /// # Arguments
    /// * `disputed_amount` - Amount in dispute (USDC with 6 decimals)
    ///
    /// # Returns
    /// Minimum stake required (USDC with 6 decimals)
    pub fn calculate_min_stake(&self, disputed_amount: U256) -> U256 {
        // Tier 3 minimum is $1,000 USDC
        let tier_3_min = U256::from(1_000_000_000u64); // 1000 * 10^6

        // Require 10% of disputed amount as stake, minimum $100
        let stake_percentage = disputed_amount / U256::from(10);
        let min_stake = U256::from(100_000_000u64); // 100 * 10^6

        stake_percentage
            .max(min_stake)
            .max(tier_3_min / U256::from(10))
    }

    /// Check if a disputed amount qualifies for Tier 3 (Kleros).
    ///
    /// # Arguments
    /// * `amount` - Disputed amount (USDC with 6 decimals)
    ///
    /// # Returns
    /// True if amount >= $1,000 USDC
    pub fn is_tier_3_eligible(&self, amount: U256) -> bool {
        let tier_3_threshold = U256::from(1_000_000_000u64); // $1,000 in USDC (6 decimals)
        amount >= tier_3_threshold
    }

    /// Create a new dispute on Kleros.
    ///
    /// In production, this would:
    /// 1. Call `createDispute` on the Kleros Arbitrator contract
    /// 2. Pay the arbitration cost in ETH
    /// 3. Return the on-chain dispute ID
    ///
    /// # Arguments
    /// * `evidence_uri` - IPFS URI containing the evidence bundle
    /// * `choices` - Number of possible rulings (typically 3 for AgentMe)
    /// * `arbitration_cost` - Cost in wei to pay for arbitration
    ///
    /// # Returns
    /// Kleros dispute ID (U256)
    pub async fn create_dispute(
        &self,
        evidence_uri: &str,
        choices: u64,
        _arbitration_cost: U256,
    ) -> Result<U256> {
        if !self.is_configured() {
            return Err(Error::Config("Kleros client not configured".to_string()));
        }

        // Validate inputs
        if choices == 0 {
            return Err(Error::Validation(
                "Choices must be greater than zero".to_string(),
            ));
        }

        if evidence_uri.is_empty() {
            return Err(Error::Validation(
                "Evidence URI cannot be empty".to_string(),
            ));
        }

        // In production, this would:
        // 1. Connect to the RPC provider
        // 2. Call the createDispute function on the Kleros Arbitrator contract:
        //    arbitrator.createDispute{value: arbitration_cost}(choices, extra_data)
        // 3. Listen for the DisputeCreation event to get the dispute ID
        //
        // For now, generate a mock dispute ID based on timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| Error::Internal(format!("System clock error: {}", e)))?
            .as_secs();

        // Use timestamp + hash of evidence URI as mock dispute ID
        let evidence_hash = evidence_uri
            .bytes()
            .fold(0u64, |acc, b| acc.wrapping_add(b as u64));
        let dispute_id = U256::from(timestamp.wrapping_add(evidence_hash));

        // Record stats
        self.stats.disputes_created.fetch_add(1, Ordering::Relaxed);

        tracing::info!(
            dispute_id = %dispute_id,
            evidence_uri = %evidence_uri,
            choices = choices,
            "Created Kleros dispute (mock)"
        );

        Ok(dispute_id)
    }
}

// ========== AI Arbitration (Tier 2) ==========

/// Evidence type for AI arbitration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceType {
    /// Text description of the issue.
    Text,
    /// Screenshot or image proof.
    Image,
    /// Log or transaction data.
    Log,
    /// Contract or agreement terms.
    Contract,
    /// Communication/chat history.
    Communication,
    /// Other evidence type.
    Other(String),
}

impl EvidenceType {
    /// Get human-readable type name.
    pub fn name(&self) -> &str {
        match self {
            EvidenceType::Text => "Text",
            EvidenceType::Image => "Image",
            EvidenceType::Log => "Log",
            EvidenceType::Contract => "Contract",
            EvidenceType::Communication => "Communication",
            EvidenceType::Other(s) => s,
        }
    }
}

/// Evidence submitted by a party.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    /// Unique evidence ID.
    pub id: String,
    /// DID of the party submitting evidence.
    pub submitter_did: String,
    /// Type of evidence.
    pub evidence_type: EvidenceType,
    /// Title or summary.
    pub title: String,
    /// Detailed description.
    pub description: String,
    /// URI to evidence data (e.g., IPFS hash).
    pub data_uri: Option<String>,
    /// Submission timestamp (Unix).
    pub submitted_at: u64,
}

impl Evidence {
    /// Create new evidence.
    pub fn new(
        submitter_did: impl Into<String>,
        evidence_type: EvidenceType,
        title: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            submitter_did: submitter_did.into(),
            evidence_type,
            title: title.into(),
            description: description.into(),
            data_uri: None,
            submitted_at: now,
        }
    }

    /// Add a data URI to the evidence.
    pub fn with_data_uri(mut self, uri: impl Into<String>) -> Self {
        self.data_uri = Some(uri.into());
        self
    }
}

/// AI dispute state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AIDisputeState {
    /// Dispute created, waiting for evidence.
    AwaitingEvidence,
    /// Evidence period closed, AI is analyzing.
    Analyzing,
    /// AI has rendered a ruling.
    Ruled,
    /// Ruling appealed, escalating to Tier 3.
    Appealed,
    /// Dispute resolved (final).
    Resolved,
}

impl AIDisputeState {
    /// Get human-readable state name.
    pub fn name(&self) -> &'static str {
        match self {
            AIDisputeState::AwaitingEvidence => "Awaiting Evidence",
            AIDisputeState::Analyzing => "Analyzing",
            AIDisputeState::Ruled => "Ruled",
            AIDisputeState::Appealed => "Appealed",
            AIDisputeState::Resolved => "Resolved",
        }
    }

    /// Check if dispute is still active.
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            AIDisputeState::AwaitingEvidence | AIDisputeState::Analyzing
        )
    }

    /// Check if ruling can be appealed.
    pub fn can_appeal(&self) -> bool {
        matches!(self, AIDisputeState::Ruled)
    }
}

/// AI ruling with explainable reasoning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIRuling {
    /// The ruling decision.
    pub decision: Ruling,
    /// Confidence score (0.0-1.0).
    pub confidence: f64,
    /// Reasoning explanation (AAA-ICDR style explainability).
    pub reasoning: String,
    /// Key factors that influenced the decision.
    pub key_factors: Vec<String>,
    /// Evidence IDs that were most relevant.
    pub relevant_evidence: Vec<String>,
    /// Ruling timestamp.
    pub ruled_at: u64,
    /// Appeal deadline (Unix timestamp).
    pub appeal_deadline: u64,
}

impl AIRuling {
    /// Create a new AI ruling.
    pub fn new(
        decision: Ruling,
        confidence: f64,
        reasoning: impl Into<String>,
        key_factors: Vec<String>,
        relevant_evidence: Vec<String>,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Appeal period is 72 hours for Tier 2
        let appeal_deadline = now + 72 * 3600;

        Self {
            decision,
            confidence,
            reasoning: reasoning.into(),
            key_factors,
            relevant_evidence,
            ruled_at: now,
            appeal_deadline,
        }
    }

    /// Check if the ruling can still be appealed.
    pub fn can_appeal(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        now < self.appeal_deadline
    }

    /// Get remaining appeal time in seconds.
    pub fn appeal_time_remaining(&self) -> i64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        (self.appeal_deadline as i64) - (now as i64)
    }

    /// Check if the AI is confident in the ruling (>= 70%).
    pub fn is_confident(&self) -> bool {
        self.confidence >= 0.70
    }
}

/// AI dispute record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIDispute {
    /// Unique dispute ID.
    pub id: String,
    /// Related escrow ID.
    pub escrow_id: String,
    /// Client DID (the party that initiated dispute).
    pub client_did: String,
    /// Provider DID (the service provider).
    pub provider_did: String,
    /// Disputed amount (USDC with 6 decimals).
    pub amount_usdc: u64,
    /// Current dispute state.
    pub state: AIDisputeState,
    /// Evidence from client.
    pub client_evidence: Vec<Evidence>,
    /// Evidence from provider.
    pub provider_evidence: Vec<Evidence>,
    /// AI ruling (if rendered).
    pub ruling: Option<AIRuling>,
    /// Kleros dispute ID (if appealed to Tier 3).
    pub kleros_dispute_id: Option<U256>,
    /// Creation timestamp.
    pub created_at: u64,
    /// Evidence deadline (Unix timestamp).
    pub evidence_deadline: u64,
}

impl AIDispute {
    /// Create a new AI dispute.
    pub fn new(
        escrow_id: impl Into<String>,
        client_did: impl Into<String>,
        provider_did: impl Into<String>,
        amount_usdc: u64,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Evidence period is 48 hours for Tier 2
        let evidence_deadline = now + 48 * 3600;

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            escrow_id: escrow_id.into(),
            client_did: client_did.into(),
            provider_did: provider_did.into(),
            amount_usdc,
            state: AIDisputeState::AwaitingEvidence,
            client_evidence: Vec::new(),
            provider_evidence: Vec::new(),
            ruling: None,
            kleros_dispute_id: None,
            created_at: now,
            evidence_deadline,
        }
    }

    /// Check if evidence can still be submitted.
    pub fn can_submit_evidence(&self) -> bool {
        if self.state != AIDisputeState::AwaitingEvidence {
            return false;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        now < self.evidence_deadline
    }

    /// Get total evidence count.
    pub fn total_evidence_count(&self) -> usize {
        self.client_evidence.len() + self.provider_evidence.len()
    }
}

/// Configuration for AI arbitration.
#[derive(Debug, Clone)]
pub struct AIArbitrationConfig {
    /// Evidence submission period in hours.
    pub evidence_period_hours: u64,
    /// Appeal period in hours.
    pub appeal_period_hours: u64,
    /// Maximum evidence items per party.
    pub max_evidence_per_party: usize,
    /// Minimum confidence for auto-execution (no appeal needed).
    pub auto_execute_confidence: f64,
    /// Kleros client for escalation.
    pub kleros_config: Option<KlerosConfig>,
}

impl Default for AIArbitrationConfig {
    fn default() -> Self {
        Self {
            evidence_period_hours: 48,
            appeal_period_hours: 72,
            max_evidence_per_party: 10,
            auto_execute_confidence: 0.95,
            kleros_config: None,
        }
    }
}

impl AIArbitrationConfig {
    /// Create config with Kleros escalation enabled.
    pub fn with_kleros(mut self, config: KlerosConfig) -> Self {
        self.kleros_config = Some(config);
        self
    }

    /// Set evidence period.
    pub fn with_evidence_period(mut self, hours: u64) -> Self {
        self.evidence_period_hours = hours;
        self
    }

    /// Set appeal period.
    pub fn with_appeal_period(mut self, hours: u64) -> Self {
        self.appeal_period_hours = hours;
        self
    }
}

/// Statistics for AI arbitration.
#[derive(Debug, Default)]
pub struct AIArbitrationStats {
    /// Total disputes created.
    pub disputes_created: AtomicU64,
    /// Disputes ruled by AI.
    pub disputes_ruled: AtomicU64,
    /// Disputes appealed to Kleros.
    pub disputes_appealed: AtomicU64,
    /// Evidence items submitted.
    pub evidence_submitted: AtomicU64,
    /// Rulings favoring client.
    pub rulings_favor_client: AtomicU64,
    /// Rulings favoring provider.
    pub rulings_favor_provider: AtomicU64,
    /// Split rulings.
    pub rulings_split: AtomicU64,
}

impl AIArbitrationStats {
    /// Record dispute creation.
    pub fn record_dispute_created(&self) {
        self.disputes_created.fetch_add(1, Ordering::Relaxed);
    }

    /// Record AI ruling.
    pub fn record_ruling(&self, ruling: &Ruling) {
        self.disputes_ruled.fetch_add(1, Ordering::Relaxed);
        match ruling {
            Ruling::FavorClient => self.rulings_favor_client.fetch_add(1, Ordering::Relaxed),
            Ruling::FavorProvider => self.rulings_favor_provider.fetch_add(1, Ordering::Relaxed),
            Ruling::Split => self.rulings_split.fetch_add(1, Ordering::Relaxed),
            Ruling::None => 0,
        };
    }

    /// Record appeal to Kleros.
    pub fn record_appeal(&self) {
        self.disputes_appealed.fetch_add(1, Ordering::Relaxed);
    }

    /// Record evidence submission.
    pub fn record_evidence(&self) {
        self.evidence_submitted.fetch_add(1, Ordering::Relaxed);
    }
}

/// AI Arbitrator for Tier 2 dispute resolution.
///
/// Provides AI-assisted arbitration following AAA-ICDR standards:
/// - Explainable reasoning with transparent decision-making
/// - Evidence-based evaluation
/// - Appeal pathway to Tier 3 (Kleros)
pub struct AIArbitrator {
    config: AIArbitrationConfig,
    disputes: RwLock<HashMap<String, AIDispute>>,
    kleros_client: Option<KlerosClient>,
    stats: Arc<AIArbitrationStats>,
}

impl AIArbitrator {
    /// Create a new AI arbitrator.
    pub fn new(config: AIArbitrationConfig) -> Result<Self> {
        let kleros_client = if let Some(ref kleros_config) = config.kleros_config {
            Some(KlerosClient::new(kleros_config.clone())?)
        } else {
            None
        };

        Ok(Self {
            config,
            disputes: RwLock::new(HashMap::new()),
            kleros_client,
            stats: Arc::new(AIArbitrationStats::default()),
        })
    }

    /// Create a disabled arbitrator for testing.
    pub fn disabled() -> Self {
        Self {
            config: AIArbitrationConfig::default(),
            disputes: RwLock::new(HashMap::new()),
            kleros_client: None,
            stats: Arc::new(AIArbitrationStats::default()),
        }
    }

    /// Get arbitrator configuration.
    pub fn config(&self) -> &AIArbitrationConfig {
        &self.config
    }

    /// Get arbitrator statistics.
    pub fn stats(&self) -> &AIArbitrationStats {
        &self.stats
    }

    /// Check if Kleros escalation is available.
    pub fn can_escalate_to_kleros(&self) -> bool {
        self.kleros_client
            .as_ref()
            .is_some_and(|c| c.is_configured())
    }

    /// Create a new dispute.
    pub fn create_dispute(
        &self,
        escrow_id: impl Into<String>,
        client_did: impl Into<String>,
        provider_did: impl Into<String>,
        amount_usdc: u64,
    ) -> Result<String> {
        // Verify amount is in Tier 2 range
        if amount_usdc < TIER_1_MAX_USDC {
            return Err(Error::Contract(format!(
                "Amount ${:.2} is below Tier 2 minimum ($10). Use automatic resolution.",
                amount_usdc as f64 / 1_000_000.0
            )));
        }

        if amount_usdc >= TIER_2_MAX_USDC {
            return Err(Error::Contract(format!(
                "Amount ${:.2} exceeds Tier 2 maximum ($1000). Use Kleros arbitration.",
                amount_usdc as f64 / 1_000_000.0
            )));
        }

        let dispute = AIDispute::new(escrow_id, client_did, provider_did, amount_usdc);
        let dispute_id = dispute.id.clone();

        let mut disputes = self
            .disputes
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;
        disputes.insert(dispute_id.clone(), dispute);

        self.stats.record_dispute_created();

        Ok(dispute_id)
    }

    /// Get a dispute by ID.
    pub fn get_dispute(&self, dispute_id: &str) -> Result<AIDispute> {
        let disputes = self
            .disputes
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        disputes
            .get(dispute_id)
            .cloned()
            .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))
    }

    /// Submit evidence for a dispute.
    pub fn submit_evidence(&self, dispute_id: &str, evidence: Evidence) -> Result<()> {
        let mut disputes = self
            .disputes
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let dispute = disputes
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

        // Check if evidence can still be submitted
        if !dispute.can_submit_evidence() {
            return Err(Error::Contract(
                "Evidence period has ended or dispute is not in awaiting evidence state"
                    .to_string(),
            ));
        }

        // Determine which party is submitting
        let is_client = evidence.submitter_did == dispute.client_did;
        let is_provider = evidence.submitter_did == dispute.provider_did;

        if !is_client && !is_provider {
            return Err(Error::Contract(
                "Evidence submitter is not a party to this dispute".to_string(),
            ));
        }

        // Check evidence limit
        let current_count = if is_client {
            dispute.client_evidence.len()
        } else {
            dispute.provider_evidence.len()
        };

        if current_count >= self.config.max_evidence_per_party {
            return Err(Error::Contract(format!(
                "Maximum evidence limit ({}) reached for this party",
                self.config.max_evidence_per_party
            )));
        }

        // Add evidence
        if is_client {
            dispute.client_evidence.push(evidence);
        } else {
            dispute.provider_evidence.push(evidence);
        }

        self.stats.record_evidence();

        Ok(())
    }

    /// Close evidence period and transition to analyzing state.
    pub fn close_evidence_period(&self, dispute_id: &str) -> Result<()> {
        let mut disputes = self
            .disputes
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let dispute = disputes
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

        if dispute.state != AIDisputeState::AwaitingEvidence {
            return Err(Error::Contract(
                "Dispute is not in awaiting evidence state".to_string(),
            ));
        }

        dispute.state = AIDisputeState::Analyzing;

        Ok(())
    }

    /// Request AI ruling for a dispute.
    ///
    /// This method analyzes the evidence and generates an explainable ruling.
    /// In a production system, this would call an LLM with structured prompts.
    pub async fn request_ruling(&self, dispute_id: &str) -> Result<AIRuling> {
        // First, ensure dispute is in analyzing state
        {
            let disputes = self
                .disputes
                .read()
                .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

            let dispute = disputes
                .get(dispute_id)
                .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

            if dispute.state != AIDisputeState::Analyzing {
                // If still awaiting evidence, close the period first
                if dispute.state == AIDisputeState::AwaitingEvidence {
                    drop(disputes);
                    self.close_evidence_period(dispute_id)?;
                } else {
                    return Err(Error::Contract(format!(
                        "Cannot request ruling: dispute is in {} state",
                        dispute.state.name()
                    )));
                }
            }
        }

        // Get dispute for analysis
        let dispute = self.get_dispute(dispute_id)?;

        // AI Analysis (in production, this would call an LLM)
        let ruling = self.analyze_dispute(&dispute).await?;

        // Update dispute with ruling
        {
            let mut disputes = self
                .disputes
                .write()
                .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

            let dispute = disputes
                .get_mut(dispute_id)
                .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

            dispute.ruling = Some(ruling.clone());
            dispute.state = AIDisputeState::Ruled;
        }

        self.stats.record_ruling(&ruling.decision);

        Ok(ruling)
    }

    /// Analyze dispute and generate AI ruling.
    ///
    /// In production, this would use structured LLM prompts with:
    /// - Contract terms analysis
    /// - Evidence evaluation
    /// - Precedent matching
    /// - Explainable reasoning generation
    async fn analyze_dispute(&self, dispute: &AIDispute) -> Result<AIRuling> {
        // Collect all evidence IDs
        let mut evidence_ids: Vec<String> = dispute
            .client_evidence
            .iter()
            .map(|e| e.id.clone())
            .collect();
        evidence_ids.extend(dispute.provider_evidence.iter().map(|e| e.id.clone()));

        // Simple heuristic for demo (production would use LLM):
        // - More evidence from one party suggests stronger case
        // - Contract/Log evidence weighted higher
        let client_score = self.score_evidence(&dispute.client_evidence);
        let provider_score = self.score_evidence(&dispute.provider_evidence);

        let (decision, confidence, reasoning, key_factors) = if client_score > provider_score * 1.5
        {
            (
                Ruling::FavorClient,
                0.75 + (client_score - provider_score) * 0.05,
                format!(
                    "Based on the submitted evidence, the client's claim is substantiated. \
                     The client provided {} piece(s) of evidence with a weighted score of {:.2}, \
                     compared to the provider's {} piece(s) with a score of {:.2}. \
                     The evidence supports the client's position that the service was not delivered as agreed.",
                    dispute.client_evidence.len(),
                    client_score,
                    dispute.provider_evidence.len(),
                    provider_score
                ),
                vec![
                    "Client evidence quality and quantity".to_string(),
                    "Contract terms analysis".to_string(),
                    "Timeline of events".to_string(),
                ],
            )
        } else if provider_score > client_score * 1.5 {
            (
                Ruling::FavorProvider,
                0.75 + (provider_score - client_score) * 0.05,
                format!(
                    "Based on the submitted evidence, the provider's position is substantiated. \
                     The provider submitted {} piece(s) of evidence with a weighted score of {:.2}, \
                     demonstrating that the service was delivered as specified in the agreement. \
                     The client's {} piece(s) of evidence (score: {:.2}) do not sufficiently support the claim.",
                    dispute.provider_evidence.len(),
                    provider_score,
                    dispute.client_evidence.len(),
                    client_score
                ),
                vec![
                    "Provider evidence of service delivery".to_string(),
                    "Contract compliance verification".to_string(),
                    "Communication records".to_string(),
                ],
            )
        } else {
            (
                Ruling::Split,
                0.60 + (client_score.min(provider_score)) * 0.02,
                format!(
                    "The evidence from both parties is relatively balanced. \
                     Client score: {:.2}, Provider score: {:.2}. \
                     A partial refund is recommended to fairly resolve this dispute. \
                     Neither party has conclusively proven their full position.",
                    client_score, provider_score
                ),
                vec![
                    "Balanced evidence from both parties".to_string(),
                    "Partial service delivery indicated".to_string(),
                    "Equitable resolution principle".to_string(),
                ],
            )
        };

        let confidence = confidence.min(0.95); // Cap at 95%

        Ok(AIRuling::new(
            decision,
            confidence,
            reasoning,
            key_factors,
            evidence_ids,
        ))
    }

    /// Score evidence based on type and quantity.
    fn score_evidence(&self, evidence: &[Evidence]) -> f64 {
        let mut score = 0.0;

        for e in evidence {
            let type_weight = match e.evidence_type {
                EvidenceType::Contract => 3.0,
                EvidenceType::Log => 2.5,
                EvidenceType::Communication => 2.0,
                EvidenceType::Image => 1.5,
                EvidenceType::Text => 1.0,
                EvidenceType::Other(_) => 0.5,
            };

            // Bonus for detailed descriptions
            let detail_bonus = if e.description.len() > 200 { 0.5 } else { 0.0 };

            // Bonus for data URI (actual proof attached)
            let uri_bonus = if e.data_uri.is_some() { 0.5 } else { 0.0 };

            score += type_weight + detail_bonus + uri_bonus;
        }

        score
    }

    /// Appeal a ruling to Tier 3 (Kleros).
    pub async fn appeal_to_kleros(&self, dispute_id: &str) -> Result<U256> {
        // Verify Kleros client is available
        let kleros_client = self
            .kleros_client
            .as_ref()
            .ok_or_else(|| Error::Config("Kleros escalation not configured".to_string()))?;

        if !kleros_client.is_configured() {
            return Err(Error::Config(
                "Kleros client not properly configured".to_string(),
            ));
        }

        // Check dispute can be appealed
        let dispute = self.get_dispute(dispute_id)?;

        if dispute.state != AIDisputeState::Ruled {
            return Err(Error::Contract(
                "Dispute must be in Ruled state to appeal".to_string(),
            ));
        }

        if let Some(ref ruling) = dispute.ruling {
            if !ruling.can_appeal() {
                return Err(Error::Contract("Appeal deadline has passed".to_string()));
            }
        } else {
            return Err(Error::Contract("No ruling to appeal".to_string()));
        }

        // Build evidence URI (in production, this would be IPFS hash)
        // For now, create a mock URI based on dispute ID
        let evidence_uri = format!("ipfs://Qm{}", dispute.id.replace('-', ""));

        // Get arbitration cost (3 choices: client wins, provider wins, split)
        let arbitration_cost = kleros_client.get_arbitration_cost(3).await?;

        // Create dispute on Kleros
        let kleros_dispute_id = kleros_client
            .create_dispute(&evidence_uri, 3, arbitration_cost)
            .await?;

        tracing::info!(
            dispute_id = %dispute_id,
            kleros_dispute_id = %kleros_dispute_id,
            evidence_uri = %evidence_uri,
            "Appealed dispute to Kleros"
        );

        // Update dispute state
        {
            let mut disputes = self
                .disputes
                .write()
                .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

            let dispute = disputes
                .get_mut(dispute_id)
                .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

            dispute.state = AIDisputeState::Appealed;
            dispute.kleros_dispute_id = Some(kleros_dispute_id);
        }

        self.stats.record_appeal();

        Ok(kleros_dispute_id)
    }

    /// Resolve a dispute (mark as final).
    pub fn resolve_dispute(&self, dispute_id: &str) -> Result<()> {
        let mut disputes = self
            .disputes
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let dispute = disputes
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Dispute not found: {}", dispute_id)))?;

        // Can only resolve from Ruled or Appealed states
        if !matches!(
            dispute.state,
            AIDisputeState::Ruled | AIDisputeState::Appealed
        ) {
            return Err(Error::Contract(format!(
                "Cannot resolve dispute in {} state",
                dispute.state.name()
            )));
        }

        dispute.state = AIDisputeState::Resolved;

        Ok(())
    }

    /// Get all active disputes.
    pub fn get_active_disputes(&self) -> Result<Vec<AIDispute>> {
        let disputes = self
            .disputes
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        Ok(disputes
            .values()
            .filter(|d| d.state.is_active())
            .cloned()
            .collect())
    }

    /// Get disputes by party DID.
    pub fn get_disputes_by_party(&self, did: &str) -> Result<Vec<AIDispute>> {
        let disputes = self
            .disputes
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        Ok(disputes
            .values()
            .filter(|d| d.client_did == did || d.provider_did == did)
            .cloned()
            .collect())
    }
}

// ========== Community Arbitration (Tier 3) - Juror Selection ==========

/// Juror status in the pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JurorStatus {
    /// Juror is active and can be selected.
    Active,
    /// Juror is currently serving on a case.
    Serving,
    /// Juror is temporarily inactive (self-paused).
    Inactive,
    /// Juror has been slashed and removed.
    Slashed,
}

impl JurorStatus {
    /// Get human-readable status name.
    pub fn name(&self) -> &'static str {
        match self {
            JurorStatus::Active => "Active",
            JurorStatus::Serving => "Serving",
            JurorStatus::Inactive => "Inactive",
            JurorStatus::Slashed => "Slashed",
        }
    }

    /// Check if juror can be selected for new cases.
    pub fn is_selectable(&self) -> bool {
        matches!(self, JurorStatus::Active)
    }
}

/// Individual juror in the pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Juror {
    /// Juror's DID.
    pub did: String,
    /// Staked amount (USDC with 6 decimals).
    pub stake_usdc: u64,
    /// Current status.
    pub status: JurorStatus,
    /// Court/subcourt IDs the juror is eligible for.
    pub courts: Vec<u64>,
    /// Reputation score (0.0-1.0) based on coherence history.
    pub reputation: f64,
    /// Total cases participated in.
    pub cases_total: u64,
    /// Cases where juror voted with majority.
    pub cases_coherent: u64,
    /// Registration timestamp.
    pub registered_at: u64,
    /// Last activity timestamp.
    pub last_active_at: u64,
}

impl Juror {
    /// Create a new juror.
    pub fn new(did: impl Into<String>, stake_usdc: u64, courts: Vec<u64>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            did: did.into(),
            stake_usdc,
            status: JurorStatus::Active,
            courts,
            reputation: 1.0, // Start with full reputation
            cases_total: 0,
            cases_coherent: 0,
            registered_at: now,
            last_active_at: now,
        }
    }

    /// Calculate the effective stake (stake × reputation).
    pub fn effective_stake(&self) -> u64 {
        (self.stake_usdc as f64 * self.reputation) as u64
    }

    /// Calculate coherence ratio.
    pub fn coherence_ratio(&self) -> f64 {
        if self.cases_total == 0 {
            1.0
        } else {
            self.cases_coherent as f64 / self.cases_total as f64
        }
    }

    /// Update reputation based on coherence.
    pub fn update_reputation(&mut self) {
        // Reputation is weighted average of coherence history
        // Minimum reputation is 0.1 to allow recovery
        self.reputation = (0.9 * self.coherence_ratio() + 0.1).clamp(0.1, 1.0);
    }

    /// Record a case result.
    pub fn record_case(&mut self, was_coherent: bool) {
        self.cases_total += 1;
        if was_coherent {
            self.cases_coherent += 1;
        }
        self.update_reputation();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.last_active_at = now;
    }

    /// Check if juror is eligible for a court.
    pub fn is_eligible_for_court(&self, court_id: u64) -> bool {
        self.courts.contains(&court_id)
    }
}

/// Vote cast by a juror.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JurorVote {
    /// Juror DID.
    pub juror_did: String,
    /// The ruling choice.
    pub choice: Ruling,
    /// Justification for the vote.
    pub justification: String,
    /// Vote timestamp.
    pub voted_at: u64,
    /// Whether vote is committed (hidden) or revealed.
    pub revealed: bool,
    /// Commitment hash (for commit-reveal scheme).
    pub commitment: Option<String>,
}

impl JurorVote {
    /// Create a committed (hidden) vote.
    pub fn commit(juror_did: impl Into<String>, commitment: impl Into<String>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            juror_did: juror_did.into(),
            choice: Ruling::None, // Hidden until reveal
            justification: String::new(),
            voted_at: now,
            revealed: false,
            commitment: Some(commitment.into()),
        }
    }

    /// Create a revealed vote.
    pub fn reveal(
        juror_did: impl Into<String>,
        choice: Ruling,
        justification: impl Into<String>,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            juror_did: juror_did.into(),
            choice,
            justification: justification.into(),
            voted_at: now,
            revealed: true,
            commitment: None,
        }
    }
}

/// Voting session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VotingState {
    /// Evidence period - gathering evidence.
    Evidence,
    /// Commit period - jurors commit (hide) votes.
    Commit,
    /// Reveal period - jurors reveal votes.
    Reveal,
    /// Voting completed, ruling determined.
    Completed,
    /// Appeal period after ruling.
    Appeal,
}

impl VotingState {
    /// Get human-readable state name.
    pub fn name(&self) -> &'static str {
        match self {
            VotingState::Evidence => "Evidence",
            VotingState::Commit => "Commit",
            VotingState::Reveal => "Reveal",
            VotingState::Completed => "Completed",
            VotingState::Appeal => "Appeal",
        }
    }
}

/// Voting session for a community dispute.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VotingSession {
    /// Kleros dispute ID.
    pub dispute_id: String,
    /// Selected jurors (DIDs).
    pub jurors: Vec<String>,
    /// Votes cast.
    pub votes: Vec<JurorVote>,
    /// Current state.
    pub state: VotingState,
    /// Number of jurors required to vote.
    pub required_votes: usize,
    /// Evidence submission deadline.
    pub evidence_deadline: u64,
    /// Commit period deadline.
    pub commit_deadline: u64,
    /// Reveal period deadline.
    pub reveal_deadline: u64,
    /// Final ruling (after completion).
    pub final_ruling: Option<Ruling>,
    /// Reward/slash amounts per juror.
    pub coherence_results: HashMap<String, i64>,
}

impl VotingSession {
    /// Create a new voting session.
    pub fn new(dispute_id: impl Into<String>, jurors: Vec<String>, required_votes: usize) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Default periods: 24h evidence, 12h commit, 12h reveal
        let evidence_deadline = now + 24 * 3600;
        let commit_deadline = evidence_deadline + 12 * 3600;
        let reveal_deadline = commit_deadline + 12 * 3600;

        Self {
            dispute_id: dispute_id.into(),
            jurors,
            votes: Vec::new(),
            state: VotingState::Evidence,
            required_votes,
            evidence_deadline,
            commit_deadline,
            reveal_deadline,
            final_ruling: None,
            coherence_results: HashMap::new(),
        }
    }

    /// Check if a juror is part of this session.
    pub fn has_juror(&self, juror_did: &str) -> bool {
        self.jurors.iter().any(|j| j == juror_did)
    }

    /// Check if a juror has voted.
    pub fn has_voted(&self, juror_did: &str) -> bool {
        self.votes.iter().any(|v| v.juror_did == juror_did)
    }

    /// Count revealed votes.
    pub fn revealed_vote_count(&self) -> usize {
        self.votes.iter().filter(|v| v.revealed).count()
    }

    /// Count committed (not yet revealed) votes.
    pub fn committed_vote_count(&self) -> usize {
        self.votes.iter().filter(|v| !v.revealed).count()
    }

    /// Determine the majority ruling from revealed votes.
    pub fn determine_majority(&self) -> Option<Ruling> {
        let revealed: Vec<_> = self.votes.iter().filter(|v| v.revealed).collect();
        if revealed.is_empty() {
            return None;
        }

        let mut counts = HashMap::new();
        for vote in &revealed {
            *counts.entry(vote.choice).or_insert(0) += 1;
        }

        // Find ruling with most votes
        counts
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .map(|(ruling, _)| ruling)
    }

    /// Calculate coherence results (Schelling point redistribution).
    ///
    /// Based on Kleros whitepaper:
    /// - Coherent jurors (voted with majority) receive rewards
    /// - Incoherent jurors lose portion of stake
    /// - Returns map of juror DID -> amount (positive = reward, negative = slash)
    pub fn calculate_coherence(&mut self, stake_at_risk_percent: u64) -> HashMap<String, i64> {
        let majority = match self.determine_majority() {
            Some(r) => r,
            None => return HashMap::new(),
        };

        let revealed: Vec<_> = self.votes.iter().filter(|v| v.revealed).collect();
        let total_votes = revealed.len() as i64;
        if total_votes == 0 {
            return HashMap::new();
        }

        // Calculate coherent/incoherent counts
        let coherent_count = revealed.iter().filter(|v| v.choice == majority).count() as i64;
        let incoherent_count = total_votes - coherent_count;

        // Base stake at risk (in basis points, e.g., 1000 = 10%)
        let risk_bps = stake_at_risk_percent as i64;

        // Pool from incoherent jurors
        let slash_per_incoherent = risk_bps; // Simplified: flat percentage

        // Reward for coherent jurors (split pool)
        let reward_per_coherent = if coherent_count > 0 && incoherent_count > 0 {
            (incoherent_count * slash_per_incoherent) / coherent_count
        } else {
            0
        };

        let mut results = HashMap::new();
        for vote in &revealed {
            let amount = if vote.choice == majority {
                reward_per_coherent
            } else {
                -slash_per_incoherent
            };
            results.insert(vote.juror_did.clone(), amount);
        }

        self.coherence_results = results.clone();
        results
    }
}

/// Configuration for juror pool.
#[derive(Debug, Clone)]
pub struct JurorPoolConfig {
    /// Minimum stake to be a juror (USDC with 6 decimals).
    pub min_stake_usdc: u64,
    /// Maximum stake considered for selection (to limit whale advantage).
    pub max_effective_stake_usdc: u64,
    /// Number of jurors for initial round.
    pub initial_jurors: usize,
    /// Stake at risk percentage (basis points, e.g., 1000 = 10%).
    pub stake_at_risk_bps: u64,
    /// Default court ID.
    pub default_court_id: u64,
}

impl Default for JurorPoolConfig {
    fn default() -> Self {
        Self {
            min_stake_usdc: 100_000_000,              // $100 minimum stake
            max_effective_stake_usdc: 10_000_000_000, // $10,000 max effective
            initial_jurors: 3,
            stake_at_risk_bps: 1000, // 10% at risk
            default_court_id: 0,
        }
    }
}

impl JurorPoolConfig {
    /// Set minimum stake.
    pub fn with_min_stake(mut self, stake_usdc: u64) -> Self {
        self.min_stake_usdc = stake_usdc;
        self
    }

    /// Set number of initial jurors.
    pub fn with_juror_count(mut self, count: usize) -> Self {
        self.initial_jurors = count;
        self
    }
}

/// Juror pool for community arbitration.
///
/// Implements stake-weighted random selection following Kleros model:
/// - Jurors stake tokens to be eligible
/// - Selection probability proportional to effective stake (stake × reputation)
/// - Schelling point incentives: coherent voters rewarded, incoherent slashed
pub struct JurorPool {
    config: JurorPoolConfig,
    jurors: RwLock<HashMap<String, Juror>>,
    sessions: RwLock<HashMap<String, VotingSession>>,
    stats: Arc<JurorPoolStats>,
}

/// Statistics for juror pool.
#[derive(Debug, Default)]
pub struct JurorPoolStats {
    /// Total jurors registered.
    pub jurors_registered: AtomicU64,
    /// Active jurors.
    pub jurors_active: AtomicU64,
    /// Total sessions created.
    pub sessions_created: AtomicU64,
    /// Total votes cast.
    pub votes_cast: AtomicU64,
    /// Total coherent votes.
    pub votes_coherent: AtomicU64,
}

impl JurorPoolStats {
    /// Record juror registration.
    pub fn record_registration(&self) {
        self.jurors_registered.fetch_add(1, Ordering::Relaxed);
        self.jurors_active.fetch_add(1, Ordering::Relaxed);
    }

    /// Record juror deactivation.
    pub fn record_deactivation(&self) {
        self.jurors_active.fetch_sub(1, Ordering::Relaxed);
    }

    /// Record session creation.
    pub fn record_session(&self) {
        self.sessions_created.fetch_add(1, Ordering::Relaxed);
    }

    /// Record vote.
    pub fn record_vote(&self, coherent: bool) {
        self.votes_cast.fetch_add(1, Ordering::Relaxed);
        if coherent {
            self.votes_coherent.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl JurorPool {
    /// Create a new juror pool.
    pub fn new(config: JurorPoolConfig) -> Self {
        Self {
            config,
            jurors: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            stats: Arc::new(JurorPoolStats::default()),
        }
    }

    /// Create a disabled juror pool for testing.
    pub fn disabled() -> Self {
        Self::new(JurorPoolConfig::default())
    }

    /// Get pool configuration.
    pub fn config(&self) -> &JurorPoolConfig {
        &self.config
    }

    /// Get pool statistics.
    pub fn stats(&self) -> &JurorPoolStats {
        &self.stats
    }

    /// Register a new juror.
    pub fn register_juror(
        &self,
        did: impl Into<String>,
        stake_usdc: u64,
        courts: Vec<u64>,
    ) -> Result<()> {
        let did = did.into();

        if stake_usdc < self.config.min_stake_usdc {
            return Err(Error::Contract(format!(
                "Stake ${:.2} is below minimum ${:.2}",
                stake_usdc as f64 / 1_000_000.0,
                self.config.min_stake_usdc as f64 / 1_000_000.0
            )));
        }

        let mut jurors = self
            .jurors
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        if jurors.contains_key(&did) {
            return Err(Error::Contract(format!("Juror {} already registered", did)));
        }

        let courts = if courts.is_empty() {
            vec![self.config.default_court_id]
        } else {
            courts
        };

        jurors.insert(did.clone(), Juror::new(did, stake_usdc, courts));
        self.stats.record_registration();

        Ok(())
    }

    /// Update juror stake.
    pub fn update_stake(&self, did: &str, new_stake: u64) -> Result<()> {
        if new_stake < self.config.min_stake_usdc {
            return Err(Error::Contract(format!(
                "New stake ${:.2} is below minimum ${:.2}",
                new_stake as f64 / 1_000_000.0,
                self.config.min_stake_usdc as f64 / 1_000_000.0
            )));
        }

        let mut jurors = self
            .jurors
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let juror = jurors
            .get_mut(did)
            .ok_or_else(|| Error::Contract(format!("Juror not found: {}", did)))?;

        juror.stake_usdc = new_stake;

        Ok(())
    }

    /// Get a juror by DID.
    pub fn get_juror(&self, did: &str) -> Result<Juror> {
        let jurors = self
            .jurors
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        jurors
            .get(did)
            .cloned()
            .ok_or_else(|| Error::Contract(format!("Juror not found: {}", did)))
    }

    /// Set juror status.
    pub fn set_juror_status(&self, did: &str, status: JurorStatus) -> Result<()> {
        let mut jurors = self
            .jurors
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let juror = jurors
            .get_mut(did)
            .ok_or_else(|| Error::Contract(format!("Juror not found: {}", did)))?;

        let was_active = juror.status.is_selectable();
        juror.status = status;
        let is_active = juror.status.is_selectable();

        if was_active && !is_active {
            self.stats.record_deactivation();
        } else if !was_active && is_active {
            self.stats.jurors_active.fetch_add(1, Ordering::Relaxed);
        }

        Ok(())
    }

    /// Get count of selectable jurors.
    pub fn selectable_count(&self) -> Result<usize> {
        let jurors = self
            .jurors
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        Ok(jurors.values().filter(|j| j.status.is_selectable()).count())
    }

    /// Select jurors for a dispute using stake-weighted random selection.
    ///
    /// Algorithm (based on Kleros):
    /// 1. Calculate total effective stake of all selectable jurors
    /// 2. Generate random number for each selection slot
    /// 3. Map random number to juror based on stake proportion
    pub fn select_jurors(&self, court_id: u64, count: usize, seed: u64) -> Result<Vec<String>> {
        let jurors = self
            .jurors
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        // Get eligible jurors
        let eligible: Vec<_> = jurors
            .values()
            .filter(|j| j.status.is_selectable() && j.is_eligible_for_court(court_id))
            .collect();

        if eligible.len() < count {
            return Err(Error::Contract(format!(
                "Not enough eligible jurors: need {}, have {}",
                count,
                eligible.len()
            )));
        }

        // Calculate total effective stake (capped)
        let total_stake: u64 = eligible
            .iter()
            .map(|j| {
                j.effective_stake()
                    .min(self.config.max_effective_stake_usdc)
            })
            .sum();

        if total_stake == 0 {
            return Err(Error::Contract("Total stake is zero".to_string()));
        }

        // Stake-weighted random selection
        let mut selected = Vec::with_capacity(count);
        let mut rng_state = seed;

        for _ in 0..count {
            // Simple PRNG (in production, use VRF or on-chain randomness)
            rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
            let random_stake = rng_state % total_stake;

            // Find juror at this stake position
            let mut cumulative = 0u64;
            for juror in &eligible {
                let stake = juror
                    .effective_stake()
                    .min(self.config.max_effective_stake_usdc);
                cumulative += stake;

                if cumulative > random_stake && !selected.contains(&juror.did) {
                    selected.push(juror.did.clone());
                    break;
                }
            }
        }

        // If we couldn't select enough (due to collisions), fill with remaining
        if selected.len() < count {
            for juror in &eligible {
                if !selected.contains(&juror.did) {
                    selected.push(juror.did.clone());
                    if selected.len() >= count {
                        break;
                    }
                }
            }
        }

        Ok(selected.into_iter().take(count).collect())
    }

    /// Create a voting session for a dispute.
    pub fn create_session(&self, dispute_id: impl Into<String>, court_id: u64) -> Result<String> {
        let dispute_id = dispute_id.into();

        // Select jurors
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        let jurors = self.select_jurors(court_id, self.config.initial_jurors, seed)?;

        // Mark jurors as serving
        for juror_did in &jurors {
            self.set_juror_status(juror_did, JurorStatus::Serving)?;
        }

        let session = VotingSession::new(&dispute_id, jurors, self.config.initial_jurors);

        let mut sessions = self
            .sessions
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        sessions.insert(dispute_id.clone(), session);
        self.stats.record_session();

        Ok(dispute_id)
    }

    /// Get a voting session.
    pub fn get_session(&self, dispute_id: &str) -> Result<VotingSession> {
        let sessions = self
            .sessions
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        sessions
            .get(dispute_id)
            .cloned()
            .ok_or_else(|| Error::Contract(format!("Session not found: {}", dispute_id)))
    }

    /// Transition session to next state.
    pub fn advance_session_state(&self, dispute_id: &str) -> Result<VotingState> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let session = sessions
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Session not found: {}", dispute_id)))?;

        session.state = match session.state {
            VotingState::Evidence => VotingState::Commit,
            VotingState::Commit => VotingState::Reveal,
            VotingState::Reveal => {
                // Calculate final ruling
                session.final_ruling = session.determine_majority();
                VotingState::Completed
            }
            VotingState::Completed => VotingState::Appeal,
            VotingState::Appeal => {
                return Err(Error::Contract(
                    "Session already in final state".to_string(),
                ))
            }
        };

        Ok(session.state)
    }

    /// Cast a vote (commit phase).
    pub fn commit_vote(&self, dispute_id: &str, juror_did: &str, commitment: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let session = sessions
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Session not found: {}", dispute_id)))?;

        if session.state != VotingState::Commit {
            return Err(Error::Contract(format!(
                "Cannot commit vote: session is in {} state",
                session.state.name()
            )));
        }

        if !session.has_juror(juror_did) {
            return Err(Error::Contract(format!(
                "Juror {} is not part of this session",
                juror_did
            )));
        }

        if session.has_voted(juror_did) {
            return Err(Error::Contract(format!(
                "Juror {} has already voted",
                juror_did
            )));
        }

        session.votes.push(JurorVote::commit(juror_did, commitment));

        Ok(())
    }

    /// Reveal a vote (reveal phase).
    pub fn reveal_vote(
        &self,
        dispute_id: &str,
        juror_did: &str,
        choice: Ruling,
        justification: &str,
    ) -> Result<()> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let session = sessions
            .get_mut(dispute_id)
            .ok_or_else(|| Error::Contract(format!("Session not found: {}", dispute_id)))?;

        if session.state != VotingState::Reveal {
            return Err(Error::Contract(format!(
                "Cannot reveal vote: session is in {} state",
                session.state.name()
            )));
        }

        // Find the committed vote
        let vote = session
            .votes
            .iter_mut()
            .find(|v| v.juror_did == juror_did)
            .ok_or_else(|| Error::Contract(format!("No commit found for juror {}", juror_did)))?;

        if vote.revealed {
            return Err(Error::Contract(format!(
                "Juror {} has already revealed",
                juror_did
            )));
        }

        // In production, verify commitment matches reveal
        // For now, just reveal the vote
        vote.choice = choice;
        vote.justification = justification.to_string();
        vote.revealed = true;

        Ok(())
    }

    /// Finalize session and apply coherence results.
    pub fn finalize_session(&self, dispute_id: &str) -> Result<HashMap<String, i64>> {
        // Calculate coherence
        let coherence_results = {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

            let session = sessions
                .get_mut(dispute_id)
                .ok_or_else(|| Error::Contract(format!("Session not found: {}", dispute_id)))?;

            if session.state != VotingState::Completed {
                return Err(Error::Contract(format!(
                    "Cannot finalize: session is in {} state",
                    session.state.name()
                )));
            }

            session.calculate_coherence(self.config.stake_at_risk_bps)
        };

        // Update juror records
        let majority = self.get_session(dispute_id)?.final_ruling;

        {
            let mut jurors = self
                .jurors
                .write()
                .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

            let session = self.get_session(dispute_id)?;

            for vote in session.votes.iter().filter(|v| v.revealed) {
                if let Some(juror) = jurors.get_mut(&vote.juror_did) {
                    let was_coherent = majority.map(|m| vote.choice == m).unwrap_or(false);
                    juror.record_case(was_coherent);
                    juror.status = JurorStatus::Active; // Release from serving

                    self.stats.record_vote(was_coherent);
                }
            }
        }

        Ok(coherence_results)
    }

    /// Get jurors by court.
    pub fn get_jurors_by_court(&self, court_id: u64) -> Result<Vec<Juror>> {
        let jurors = self
            .jurors
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        Ok(jurors
            .values()
            .filter(|j| j.is_eligible_for_court(court_id))
            .cloned()
            .collect())
    }

    /// Get top jurors by effective stake.
    pub fn get_top_jurors(&self, limit: usize) -> Result<Vec<Juror>> {
        let jurors = self
            .jurors
            .read()
            .map_err(|e| Error::Contract(format!("Lock error: {}", e)))?;

        let mut sorted: Vec<_> = jurors.values().cloned().collect();
        sorted.sort_by_key(|j| std::cmp::Reverse(j.effective_stake()));

        Ok(sorted.into_iter().take(limit).collect())
    }
}

// ========== TDD Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    // ========== RED Phase: DisputeStatus Tests ==========

    #[test]
    fn test_dispute_status_from_u8_waiting() {
        let status = DisputeStatus::try_from(0u8).unwrap();
        assert_eq!(status, DisputeStatus::Waiting);
    }

    #[test]
    fn test_dispute_status_from_u8_appealable() {
        let status = DisputeStatus::try_from(1u8).unwrap();
        assert_eq!(status, DisputeStatus::Appealable);
    }

    #[test]
    fn test_dispute_status_from_u8_solved() {
        let status = DisputeStatus::try_from(2u8).unwrap();
        assert_eq!(status, DisputeStatus::Solved);
    }

    #[test]
    fn test_dispute_status_from_u8_invalid() {
        let result = DisputeStatus::try_from(3u8);
        assert!(result.is_err());
    }

    #[test]
    fn test_dispute_status_is_pending() {
        assert!(DisputeStatus::Waiting.is_pending());
        assert!(DisputeStatus::Appealable.is_pending());
        assert!(!DisputeStatus::Solved.is_pending());
    }

    #[test]
    fn test_dispute_status_is_final() {
        assert!(!DisputeStatus::Waiting.is_final());
        assert!(!DisputeStatus::Appealable.is_final());
        assert!(DisputeStatus::Solved.is_final());
    }

    #[test]
    fn test_dispute_status_name() {
        assert_eq!(DisputeStatus::Waiting.name(), "Waiting");
        assert_eq!(DisputeStatus::Appealable.name(), "Appealable");
        assert_eq!(DisputeStatus::Solved.name(), "Solved");
    }

    // ========== RED Phase: Ruling Tests ==========

    #[test]
    fn test_ruling_from_u64() {
        assert_eq!(Ruling::try_from(0u64).unwrap(), Ruling::None);
        assert_eq!(Ruling::try_from(1u64).unwrap(), Ruling::FavorClient);
        assert_eq!(Ruling::try_from(2u64).unwrap(), Ruling::FavorProvider);
        assert_eq!(Ruling::try_from(3u64).unwrap(), Ruling::Split);
    }

    #[test]
    fn test_ruling_from_u64_invalid() {
        let result = Ruling::try_from(4u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_ruling_names() {
        assert_eq!(Ruling::None.name(), "None");
        assert_eq!(Ruling::FavorClient.name(), "Favor Client");
        assert_eq!(Ruling::FavorProvider.name(), "Favor Provider");
        assert_eq!(Ruling::Split.name(), "Split");
    }

    // ========== RED Phase: AppealPeriod Tests ==========

    #[test]
    fn test_appeal_period_duration() {
        let period = AppealPeriod {
            start: 1000,
            end: 2000,
        };

        assert_eq!(period.duration(), Duration::from_secs(1000));
    }

    #[test]
    fn test_appeal_period_remaining_expired() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let period = AppealPeriod {
            start: now - 2000,
            end: now - 1000, // Ended 1000 seconds ago
        };

        assert!(period.remaining_secs() < 0);
    }

    #[test]
    fn test_appeal_period_is_active_future() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let period = AppealPeriod {
            start: now + 1000, // Starts in 1000 seconds
            end: now + 2000,
        };

        assert!(!period.is_active());
    }

    #[test]
    fn test_appeal_period_is_active_current() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let period = AppealPeriod {
            start: now - 100, // Started 100 seconds ago
            end: now + 100,   // Ends in 100 seconds
        };

        assert!(period.is_active());
    }

    // ========== RED Phase: KlerosConfig Tests ==========

    #[test]
    fn test_default_config() {
        let config = KlerosConfig::default();

        assert!(!config.rpc_url.is_empty());
        assert_eq!(config.court_id, 0);
        assert!(config.initial_jurors >= 3);
    }

    #[test]
    fn test_config_new() {
        let config = KlerosConfig::new(
            "https://test.rpc.com",
            "0x1234567890123456789012345678901234567890",
        );

        assert_eq!(config.rpc_url, "https://test.rpc.com");
        assert_eq!(
            config.arbitrator_address,
            "0x1234567890123456789012345678901234567890"
        );
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = KlerosConfig::default().with_court_id(5).with_jurors(7);

        assert_eq!(config.court_id, 5);
        assert_eq!(config.initial_jurors, 7);
    }

    #[test]
    fn test_config_encode_extra_data() {
        let config = KlerosConfig::default().with_court_id(1).with_jurors(3);

        let extra_data = config.encode_extra_data();

        // Should be 64 bytes (two uint256)
        assert_eq!(extra_data.len(), 64);

        // Court ID in first 32 bytes
        assert_eq!(extra_data[31], 1); // court_id = 1

        // Jurors in second 32 bytes
        assert_eq!(extra_data[63], 3); // jurors = 3
    }

    // ========== RED Phase: KlerosStats Tests ==========

    #[test]
    fn test_stats_starts_at_zero() {
        let stats = KlerosStats::default();

        assert_eq!(stats.disputes_created.load(Ordering::Relaxed), 0);
        assert_eq!(stats.appeals_filed.load(Ordering::Relaxed), 0);
        assert_eq!(stats.rulings_received.load(Ordering::Relaxed), 0);
        assert_eq!(stats.rpc_errors.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_stats_record_dispute_created() {
        let stats = KlerosStats::default();

        stats.record_dispute_created();
        stats.record_dispute_created();

        assert_eq!(stats.disputes_created.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn test_stats_record_appeal() {
        let stats = KlerosStats::default();

        stats.record_appeal();

        assert_eq!(stats.appeals_filed.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_stats_record_ruling() {
        let stats = KlerosStats::default();

        stats.record_ruling();

        assert_eq!(stats.rulings_received.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_stats_record_error() {
        let stats = KlerosStats::default();

        stats.record_error();

        assert_eq!(stats.rpc_errors.load(Ordering::Relaxed), 1);
    }

    // ========== RED Phase: KlerosClient Tests ==========

    #[test]
    fn test_client_new_valid_address() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );

        let client = KlerosClient::new(config);

        assert!(client.is_ok());
        assert!(client.unwrap().is_configured());
    }

    #[test]
    fn test_client_new_invalid_address() {
        let config = KlerosConfig::new("https://sepolia.base.org", "invalid-address");

        let result = KlerosClient::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_client_disabled() {
        let client = KlerosClient::disabled();

        assert!(!client.is_configured());
        assert_eq!(client.arbitrator_address(), Address::ZERO);
    }

    #[test]
    fn test_client_exposes_config() {
        let config = KlerosConfig::default().with_court_id(5);
        let client = KlerosClient::new(config).unwrap();

        assert_eq!(client.config().court_id, 5);
    }

    #[test]
    fn test_client_exposes_stats() {
        let client = KlerosClient::disabled();

        assert_eq!(client.stats().disputes_created.load(Ordering::Relaxed), 0);
    }

    // ========== RED Phase: Tier 3 Eligibility Tests ==========

    #[test]
    fn test_is_tier_3_eligible_below_threshold() {
        let client = KlerosClient::disabled();

        // $999 USDC (below $1,000 threshold)
        let amount = U256::from(999_000_000u64);

        assert!(!client.is_tier_3_eligible(amount));
    }

    #[test]
    fn test_is_tier_3_eligible_at_threshold() {
        let client = KlerosClient::disabled();

        // Exactly $1,000 USDC
        let amount = U256::from(1_000_000_000u64);

        assert!(client.is_tier_3_eligible(amount));
    }

    #[test]
    fn test_is_tier_3_eligible_above_threshold() {
        let client = KlerosClient::disabled();

        // $5,000 USDC
        let amount = U256::from(5_000_000_000u64);

        assert!(client.is_tier_3_eligible(amount));
    }

    // ========== RED Phase: Stake Calculation Tests ==========

    #[test]
    fn test_calculate_min_stake_small_amount() {
        let client = KlerosClient::disabled();

        // $1,000 USDC - should require minimum $100 stake
        let amount = U256::from(1_000_000_000u64);
        let stake = client.calculate_min_stake(amount);

        // 10% of $1,000 = $100 (meets minimum)
        assert_eq!(stake, U256::from(100_000_000u64));
    }

    #[test]
    fn test_calculate_min_stake_large_amount() {
        let client = KlerosClient::disabled();

        // $10,000 USDC - should require 10% = $1,000 stake
        let amount = U256::from(10_000_000_000u64);
        let stake = client.calculate_min_stake(amount);

        // 10% of $10,000 = $1,000
        assert_eq!(stake, U256::from(1_000_000_000u64));
    }

    #[test]
    fn test_calculate_min_stake_enforces_minimum() {
        let client = KlerosClient::disabled();

        // $1,001 USDC - 10% would be $100.10, but minimum is $100
        let amount = U256::from(1_001_000_000u64);
        let stake = client.calculate_min_stake(amount);

        // Should be 10% = $100.1, or minimum $100
        assert!(stake >= U256::from(100_000_000u64));
    }

    // ========== RED Phase: Async Method Tests ==========

    #[tokio::test]
    async fn test_get_arbitration_cost_not_configured() {
        let client = KlerosClient::disabled();

        let result = client.get_arbitration_cost(3).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_arbitration_cost_configured() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let client = KlerosClient::new(config).unwrap();

        let result = client.get_arbitration_cost(3).await;

        // Should return a placeholder cost since we're not actually calling the contract
        assert!(result.is_ok());
        assert!(result.unwrap() > U256::ZERO);
    }

    #[tokio::test]
    async fn test_get_appeal_cost_not_configured() {
        let client = KlerosClient::disabled();

        let result = client.get_appeal_cost(U256::from(1)).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_dispute_status_not_configured() {
        let client = KlerosClient::disabled();

        let result = client.get_dispute_status(U256::from(1)).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_current_ruling_not_configured() {
        let client = KlerosClient::disabled();

        let result = client.get_current_ruling(U256::from(1)).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_appeal_period_not_configured() {
        let client = KlerosClient::disabled();

        let result = client.get_appeal_period(U256::from(1)).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_dispute_configured() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let client = KlerosClient::new(config).unwrap();

        let result = client.get_dispute(U256::from(1), 3).await;

        assert!(result.is_ok());
        let dispute = result.unwrap();
        assert_eq!(dispute.dispute_id, U256::from(1));
        assert_eq!(dispute.choices, 3);
    }

    // ========== TDD Tests: KlerosClient.create_dispute() (Task #67) ==========
    // These tests verify Kleros dispute creation functionality

    #[tokio::test]
    async fn test_kleros_create_dispute_disabled_client_fails() {
        let client = KlerosClient::disabled();

        let result = client
            .create_dispute(
                "ipfs://QmEvidence123",
                3,
                U256::from(10_000_000_000_000_000u64),
            )
            .await;

        assert!(
            result.is_err(),
            "Disabled client should fail to create dispute"
        );
        assert!(result.unwrap_err().to_string().contains("not configured"));
    }

    #[tokio::test]
    async fn test_kleros_create_dispute_configured_client_returns_id() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let client = KlerosClient::new(config).unwrap();

        let result = client
            .create_dispute(
                "ipfs://QmEvidence123",
                3,
                U256::from(10_000_000_000_000_000u64),
            )
            .await;

        // Should return a dispute ID (placeholder in test mode)
        assert!(
            result.is_ok(),
            "Configured client should create dispute: {:?}",
            result.err()
        );
        assert!(
            result.unwrap() > U256::ZERO,
            "Dispute ID should be non-zero"
        );
    }

    #[tokio::test]
    async fn test_kleros_create_dispute_records_stats() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let client = KlerosClient::new(config).unwrap();

        // Initial count
        let initial_count = client.stats().disputes_created.load(Ordering::Relaxed);

        // Create dispute
        let _ = client
            .create_dispute("ipfs://QmTest", 3, U256::from(10_000_000_000_000_000u64))
            .await;

        // Should increment count
        let final_count = client.stats().disputes_created.load(Ordering::Relaxed);
        assert_eq!(
            final_count,
            initial_count + 1,
            "Should record dispute creation"
        );
    }

    #[tokio::test]
    async fn test_kleros_create_dispute_validates_choices() {
        let config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let client = KlerosClient::new(config).unwrap();

        // Zero choices should fail
        let result = client
            .create_dispute("ipfs://QmTest", 0, U256::from(10_000_000_000_000_000u64))
            .await;

        assert!(result.is_err(), "Should reject zero choices");
    }

    // ========== AI Arbitration Tests (Tier 2) ==========

    // --- DisputeTier Tests ---

    #[test]
    fn test_determine_tier_automatic() {
        // $5 USDC - should be Tier 1 (automatic)
        let tier = determine_tier(5_000_000);
        assert_eq!(tier, DisputeTier::Automatic);
    }

    #[test]
    fn test_determine_tier_ai_assisted() {
        // $100 USDC - should be Tier 2 (AI-assisted)
        let tier = determine_tier(100_000_000);
        assert_eq!(tier, DisputeTier::AIAssisted);
    }

    #[test]
    fn test_determine_tier_community() {
        // $5000 USDC - should be Tier 3 (community/Kleros)
        let tier = determine_tier(5_000_000_000);
        assert_eq!(tier, DisputeTier::Community);
    }

    #[test]
    fn test_dispute_tier_names() {
        assert_eq!(DisputeTier::Automatic.name(), "Automatic");
        assert_eq!(DisputeTier::AIAssisted.name(), "AI-Assisted");
        assert_eq!(DisputeTier::Community.name(), "Community");
    }

    #[test]
    fn test_dispute_tier_numbers() {
        assert_eq!(DisputeTier::Automatic.number(), 1);
        assert_eq!(DisputeTier::AIAssisted.number(), 2);
        assert_eq!(DisputeTier::Community.number(), 3);
    }

    // --- Evidence Tests ---

    #[test]
    fn test_evidence_type_names() {
        assert_eq!(EvidenceType::Text.name(), "Text");
        assert_eq!(EvidenceType::Image.name(), "Image");
        assert_eq!(EvidenceType::Log.name(), "Log");
        assert_eq!(EvidenceType::Contract.name(), "Contract");
        assert_eq!(EvidenceType::Communication.name(), "Communication");
        assert_eq!(EvidenceType::Other("Custom".to_string()).name(), "Custom");
    }

    #[test]
    fn test_evidence_new() {
        let evidence = Evidence::new(
            "did:agentme:base:client123",
            EvidenceType::Text,
            "Issue Description",
            "The service was not delivered as promised",
        );

        assert!(!evidence.id.is_empty());
        assert_eq!(evidence.submitter_did, "did:agentme:base:client123");
        assert_eq!(evidence.evidence_type, EvidenceType::Text);
        assert_eq!(evidence.title, "Issue Description");
        assert!(evidence.data_uri.is_none());
        assert!(evidence.submitted_at > 0);
    }

    #[test]
    fn test_evidence_with_data_uri() {
        let evidence = Evidence::new(
            "did:agentme:base:client123",
            EvidenceType::Image,
            "Screenshot",
            "Evidence of failure",
        )
        .with_data_uri("ipfs://QmTest123");

        assert_eq!(evidence.data_uri, Some("ipfs://QmTest123".to_string()));
    }

    // --- AIDisputeState Tests ---

    #[test]
    fn test_ai_dispute_state_names() {
        assert_eq!(AIDisputeState::AwaitingEvidence.name(), "Awaiting Evidence");
        assert_eq!(AIDisputeState::Analyzing.name(), "Analyzing");
        assert_eq!(AIDisputeState::Ruled.name(), "Ruled");
        assert_eq!(AIDisputeState::Appealed.name(), "Appealed");
        assert_eq!(AIDisputeState::Resolved.name(), "Resolved");
    }

    #[test]
    fn test_ai_dispute_state_is_active() {
        assert!(AIDisputeState::AwaitingEvidence.is_active());
        assert!(AIDisputeState::Analyzing.is_active());
        assert!(!AIDisputeState::Ruled.is_active());
        assert!(!AIDisputeState::Appealed.is_active());
        assert!(!AIDisputeState::Resolved.is_active());
    }

    #[test]
    fn test_ai_dispute_state_can_appeal() {
        assert!(!AIDisputeState::AwaitingEvidence.can_appeal());
        assert!(!AIDisputeState::Analyzing.can_appeal());
        assert!(AIDisputeState::Ruled.can_appeal());
        assert!(!AIDisputeState::Appealed.can_appeal());
        assert!(!AIDisputeState::Resolved.can_appeal());
    }

    // --- AIRuling Tests ---

    #[test]
    fn test_ai_ruling_new() {
        let ruling = AIRuling::new(
            Ruling::FavorClient,
            0.85,
            "Based on evidence, client's claim is valid.",
            vec!["Evidence quality".to_string()],
            vec!["evidence-1".to_string()],
        );

        assert_eq!(ruling.decision, Ruling::FavorClient);
        assert_eq!(ruling.confidence, 0.85);
        assert!(!ruling.reasoning.is_empty());
        assert!(!ruling.key_factors.is_empty());
        assert!(ruling.ruled_at > 0);
        assert!(ruling.appeal_deadline > ruling.ruled_at);
    }

    #[test]
    fn test_ai_ruling_can_appeal() {
        let ruling = AIRuling::new(Ruling::FavorClient, 0.85, "Test ruling", vec![], vec![]);

        // Should be appealable (deadline is 72 hours in future)
        assert!(ruling.can_appeal());
        assert!(ruling.appeal_time_remaining() > 0);
    }

    #[test]
    fn test_ai_ruling_is_confident() {
        let confident = AIRuling::new(Ruling::FavorClient, 0.75, "Test", vec![], vec![]);
        let not_confident = AIRuling::new(Ruling::FavorClient, 0.65, "Test", vec![], vec![]);

        assert!(confident.is_confident());
        assert!(!not_confident.is_confident());
    }

    // --- AIDispute Tests ---

    #[test]
    fn test_ai_dispute_new() {
        let dispute = AIDispute::new(
            "escrow-123",
            "did:agentme:base:client",
            "did:agentme:base:provider",
            100_000_000, // $100 USDC
        );

        assert!(!dispute.id.is_empty());
        assert_eq!(dispute.escrow_id, "escrow-123");
        assert_eq!(dispute.client_did, "did:agentme:base:client");
        assert_eq!(dispute.provider_did, "did:agentme:base:provider");
        assert_eq!(dispute.amount_usdc, 100_000_000);
        assert_eq!(dispute.state, AIDisputeState::AwaitingEvidence);
        assert!(dispute.client_evidence.is_empty());
        assert!(dispute.provider_evidence.is_empty());
        assert!(dispute.ruling.is_none());
        assert!(dispute.kleros_dispute_id.is_none());
    }

    #[test]
    fn test_ai_dispute_can_submit_evidence() {
        let dispute = AIDispute::new("escrow-123", "did:client", "did:provider", 100_000_000);

        // Should be able to submit evidence in new dispute
        assert!(dispute.can_submit_evidence());
    }

    #[test]
    fn test_ai_dispute_total_evidence_count() {
        let mut dispute = AIDispute::new("escrow-123", "did:client", "did:provider", 100_000_000);

        dispute.client_evidence.push(Evidence::new(
            "did:client",
            EvidenceType::Text,
            "Test",
            "Description",
        ));

        dispute.provider_evidence.push(Evidence::new(
            "did:provider",
            EvidenceType::Log,
            "Logs",
            "Service logs",
        ));

        assert_eq!(dispute.total_evidence_count(), 2);
    }

    // --- AIArbitrationConfig Tests ---

    #[test]
    fn test_ai_arbitration_config_default() {
        let config = AIArbitrationConfig::default();

        assert_eq!(config.evidence_period_hours, 48);
        assert_eq!(config.appeal_period_hours, 72);
        assert_eq!(config.max_evidence_per_party, 10);
        assert_eq!(config.auto_execute_confidence, 0.95);
        assert!(config.kleros_config.is_none());
    }

    #[test]
    fn test_ai_arbitration_config_with_kleros() {
        let kleros_config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );

        let config = AIArbitrationConfig::default().with_kleros(kleros_config);

        assert!(config.kleros_config.is_some());
    }

    #[test]
    fn test_ai_arbitration_config_builder() {
        let config = AIArbitrationConfig::default()
            .with_evidence_period(24)
            .with_appeal_period(48);

        assert_eq!(config.evidence_period_hours, 24);
        assert_eq!(config.appeal_period_hours, 48);
    }

    // --- AIArbitrationStats Tests ---

    #[test]
    fn test_ai_arbitration_stats_default() {
        let stats = AIArbitrationStats::default();

        assert_eq!(stats.disputes_created.load(Ordering::Relaxed), 0);
        assert_eq!(stats.disputes_ruled.load(Ordering::Relaxed), 0);
        assert_eq!(stats.disputes_appealed.load(Ordering::Relaxed), 0);
        assert_eq!(stats.evidence_submitted.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_ai_arbitration_stats_record_dispute_created() {
        let stats = AIArbitrationStats::default();
        stats.record_dispute_created();

        assert_eq!(stats.disputes_created.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_ai_arbitration_stats_record_ruling() {
        let stats = AIArbitrationStats::default();

        stats.record_ruling(&Ruling::FavorClient);
        stats.record_ruling(&Ruling::FavorProvider);
        stats.record_ruling(&Ruling::Split);

        assert_eq!(stats.disputes_ruled.load(Ordering::Relaxed), 3);
        assert_eq!(stats.rulings_favor_client.load(Ordering::Relaxed), 1);
        assert_eq!(stats.rulings_favor_provider.load(Ordering::Relaxed), 1);
        assert_eq!(stats.rulings_split.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_ai_arbitration_stats_record_appeal() {
        let stats = AIArbitrationStats::default();
        stats.record_appeal();

        assert_eq!(stats.disputes_appealed.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_ai_arbitration_stats_record_evidence() {
        let stats = AIArbitrationStats::default();
        stats.record_evidence();
        stats.record_evidence();

        assert_eq!(stats.evidence_submitted.load(Ordering::Relaxed), 2);
    }

    // --- AIArbitrator Tests ---

    #[test]
    fn test_ai_arbitrator_new() {
        let config = AIArbitrationConfig::default();
        let arbitrator = AIArbitrator::new(config);

        assert!(arbitrator.is_ok());
    }

    #[test]
    fn test_ai_arbitrator_disabled() {
        let arbitrator = AIArbitrator::disabled();

        assert!(!arbitrator.can_escalate_to_kleros());
    }

    #[test]
    fn test_ai_arbitrator_with_kleros() {
        let kleros_config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let config = AIArbitrationConfig::default().with_kleros(kleros_config);
        let arbitrator = AIArbitrator::new(config).unwrap();

        assert!(arbitrator.can_escalate_to_kleros());
    }

    #[test]
    fn test_ai_arbitrator_create_dispute_valid_amount() {
        let arbitrator = AIArbitrator::disabled();

        let result = arbitrator.create_dispute(
            "escrow-123",
            "did:agentme:base:client",
            "did:agentme:base:provider",
            100_000_000, // $100 USDC (valid for Tier 2)
        );

        assert!(result.is_ok());
        let dispute_id = result.unwrap();
        assert!(!dispute_id.is_empty());

        // Verify stats
        assert_eq!(
            arbitrator.stats().disputes_created.load(Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn test_ai_arbitrator_create_dispute_below_tier_2() {
        let arbitrator = AIArbitrator::disabled();

        let result = arbitrator.create_dispute(
            "escrow-123",
            "did:client",
            "did:provider",
            5_000_000, // $5 USDC (below Tier 2 minimum)
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("below Tier 2"));
    }

    #[test]
    fn test_ai_arbitrator_create_dispute_above_tier_2() {
        let arbitrator = AIArbitrator::disabled();

        let result = arbitrator.create_dispute(
            "escrow-123",
            "did:client",
            "did:provider",
            5_000_000_000, // $5000 USDC (above Tier 2 maximum)
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exceeds Tier 2"));
    }

    #[test]
    fn test_ai_arbitrator_get_dispute() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let dispute = arbitrator.get_dispute(&dispute_id);
        assert!(dispute.is_ok());

        let dispute = dispute.unwrap();
        assert_eq!(dispute.id, dispute_id);
        assert_eq!(dispute.escrow_id, "escrow-123");
    }

    #[test]
    fn test_ai_arbitrator_get_dispute_not_found() {
        let arbitrator = AIArbitrator::disabled();

        let result = arbitrator.get_dispute("nonexistent-id");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    #[test]
    fn test_ai_arbitrator_submit_evidence_client() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let evidence = Evidence::new(
            "did:client",
            EvidenceType::Text,
            "My complaint",
            "Service not delivered",
        );

        let result = arbitrator.submit_evidence(&dispute_id, evidence);
        assert!(result.is_ok());

        // Verify evidence was added
        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.client_evidence.len(), 1);
        assert_eq!(dispute.provider_evidence.len(), 0);

        // Verify stats
        assert_eq!(
            arbitrator
                .stats()
                .evidence_submitted
                .load(Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn test_ai_arbitrator_submit_evidence_provider() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let evidence = Evidence::new(
            "did:provider",
            EvidenceType::Log,
            "Service logs",
            "Proof of service delivery",
        );

        let result = arbitrator.submit_evidence(&dispute_id, evidence);
        assert!(result.is_ok());

        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.client_evidence.len(), 0);
        assert_eq!(dispute.provider_evidence.len(), 1);
    }

    #[test]
    fn test_ai_arbitrator_submit_evidence_unauthorized() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let evidence = Evidence::new(
            "did:unauthorized",
            EvidenceType::Text,
            "Malicious evidence",
            "Trying to interfere",
        );

        let result = arbitrator.submit_evidence(&dispute_id, evidence);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not a party"));
    }

    #[test]
    fn test_ai_arbitrator_submit_evidence_max_limit() {
        let config = AIArbitrationConfig {
            max_evidence_per_party: 2,
            ..Default::default()
        };
        let arbitrator = AIArbitrator::new(config).unwrap();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Submit 2 pieces of evidence (should succeed)
        for i in 0..2 {
            let evidence = Evidence::new(
                "did:client",
                EvidenceType::Text,
                format!("Evidence {}", i),
                "Description",
            );
            arbitrator.submit_evidence(&dispute_id, evidence).unwrap();
        }

        // Third should fail
        let evidence = Evidence::new(
            "did:client",
            EvidenceType::Text,
            "Evidence 3",
            "Description",
        );
        let result = arbitrator.submit_evidence(&dispute_id, evidence);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Maximum evidence limit"));
    }

    #[test]
    fn test_ai_arbitrator_close_evidence_period() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let result = arbitrator.close_evidence_period(&dispute_id);
        assert!(result.is_ok());

        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.state, AIDisputeState::Analyzing);
    }

    #[tokio::test]
    async fn test_ai_arbitrator_request_ruling() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Add evidence from client
        let client_evidence = Evidence::new(
            "did:client",
            EvidenceType::Contract,
            "Contract terms",
            "The contract clearly states X. The provider failed to deliver X. This is a breach of contract with evidence attached.",
        ).with_data_uri("ipfs://QmTest123");
        arbitrator
            .submit_evidence(&dispute_id, client_evidence)
            .unwrap();

        // Add evidence from provider
        let provider_evidence = Evidence::new(
            "did:provider",
            EvidenceType::Text,
            "Response",
            "Service was delivered",
        );
        arbitrator
            .submit_evidence(&dispute_id, provider_evidence)
            .unwrap();

        // Request ruling
        let ruling = arbitrator.request_ruling(&dispute_id).await;
        assert!(ruling.is_ok());

        let ruling = ruling.unwrap();
        assert!(!ruling.reasoning.is_empty());
        assert!(ruling.confidence > 0.0 && ruling.confidence <= 1.0);
        assert!(ruling.can_appeal());

        // Verify dispute state changed
        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.state, AIDisputeState::Ruled);
        assert!(dispute.ruling.is_some());
    }

    #[tokio::test]
    async fn test_ai_arbitrator_request_ruling_no_evidence() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Request ruling without evidence (should still work)
        let ruling = arbitrator.request_ruling(&dispute_id).await;
        assert!(ruling.is_ok());

        // Should result in a split ruling due to balanced (zero) evidence
        let ruling = ruling.unwrap();
        assert_eq!(ruling.decision, Ruling::Split);
    }

    #[tokio::test]
    async fn test_ai_arbitrator_ruling_favors_stronger_evidence() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Client submits strong evidence
        for i in 0..3 {
            let evidence = Evidence::new(
                "did:client",
                EvidenceType::Contract,
                format!("Contract {}", i),
                "A detailed description of the contract violation with all relevant context and supporting documentation that proves the breach.",
            ).with_data_uri(format!("ipfs://Qm{}", i));
            arbitrator.submit_evidence(&dispute_id, evidence).unwrap();
        }

        // Provider submits weak evidence
        let evidence = Evidence::new(
            "did:provider",
            EvidenceType::Text,
            "Simple response",
            "Service was delivered.",
        );
        arbitrator.submit_evidence(&dispute_id, evidence).unwrap();

        let ruling = arbitrator.request_ruling(&dispute_id).await.unwrap();

        // Should favor client due to stronger evidence
        assert_eq!(ruling.decision, Ruling::FavorClient);
    }

    #[test]
    fn test_ai_arbitrator_resolve_dispute() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Close evidence and move to ruled state
        arbitrator.close_evidence_period(&dispute_id).unwrap();

        // Set ruling manually for test
        {
            let mut disputes = arbitrator.disputes.write().unwrap();
            let dispute = disputes.get_mut(&dispute_id).unwrap();
            dispute.state = AIDisputeState::Ruled;
            dispute.ruling = Some(AIRuling::new(
                Ruling::FavorClient,
                0.8,
                "Test",
                vec![],
                vec![],
            ));
        }

        let result = arbitrator.resolve_dispute(&dispute_id);
        assert!(result.is_ok());

        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.state, AIDisputeState::Resolved);
    }

    #[test]
    fn test_ai_arbitrator_resolve_dispute_wrong_state() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Try to resolve without ruling
        let result = arbitrator.resolve_dispute(&dispute_id);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Cannot resolve"));
    }

    #[test]
    fn test_ai_arbitrator_get_active_disputes() {
        let arbitrator = AIArbitrator::disabled();

        // Create some disputes
        let id1 = arbitrator
            .create_dispute("escrow-1", "did:c1", "did:p1", 100_000_000)
            .unwrap();
        let id2 = arbitrator
            .create_dispute("escrow-2", "did:c2", "did:p2", 200_000_000)
            .unwrap();

        // Resolve one
        arbitrator.close_evidence_period(&id1).unwrap();
        {
            let mut disputes = arbitrator.disputes.write().unwrap();
            let dispute = disputes.get_mut(&id1).unwrap();
            dispute.state = AIDisputeState::Resolved;
        }

        let active = arbitrator.get_active_disputes().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, id2);
    }

    #[test]
    fn test_ai_arbitrator_get_disputes_by_party() {
        let arbitrator = AIArbitrator::disabled();

        arbitrator
            .create_dispute("escrow-1", "did:alice", "did:bob", 100_000_000)
            .unwrap();
        arbitrator
            .create_dispute("escrow-2", "did:alice", "did:charlie", 200_000_000)
            .unwrap();
        arbitrator
            .create_dispute("escrow-3", "did:bob", "did:charlie", 300_000_000)
            .unwrap();

        let alice_disputes = arbitrator.get_disputes_by_party("did:alice").unwrap();
        assert_eq!(alice_disputes.len(), 2);

        let charlie_disputes = arbitrator.get_disputes_by_party("did:charlie").unwrap();
        assert_eq!(charlie_disputes.len(), 2);

        let bob_disputes = arbitrator.get_disputes_by_party("did:bob").unwrap();
        assert_eq!(bob_disputes.len(), 2);
    }

    #[tokio::test]
    async fn test_ai_arbitrator_appeal_to_kleros_no_config() {
        let arbitrator = AIArbitrator::disabled();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        let result = arbitrator.appeal_to_kleros(&dispute_id).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not configured"));
    }

    #[tokio::test]
    async fn test_ai_arbitrator_appeal_to_kleros_not_ruled() {
        let kleros_config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let config = AIArbitrationConfig::default().with_kleros(kleros_config);
        let arbitrator = AIArbitrator::new(config).unwrap();

        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Try to appeal without a ruling
        let result = arbitrator.appeal_to_kleros(&dispute_id).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("must be in Ruled state"));
    }

    #[tokio::test]
    async fn test_ai_arbitrator_full_appeal_flow() {
        let kleros_config = KlerosConfig::new(
            "https://sepolia.base.org",
            "0x1234567890123456789012345678901234567890",
        );
        let config = AIArbitrationConfig::default().with_kleros(kleros_config);
        let arbitrator = AIArbitrator::new(config).unwrap();

        // Create dispute
        let dispute_id = arbitrator
            .create_dispute("escrow-123", "did:client", "did:provider", 100_000_000)
            .unwrap();

        // Submit evidence
        let evidence = Evidence::new(
            "did:client",
            EvidenceType::Text,
            "Complaint",
            "The service was not delivered",
        );
        arbitrator.submit_evidence(&dispute_id, evidence).unwrap();

        // Request AI ruling
        let ruling = arbitrator.request_ruling(&dispute_id).await.unwrap();
        assert!(ruling.can_appeal());

        // Appeal to Kleros
        let kleros_id = arbitrator.appeal_to_kleros(&dispute_id).await.unwrap();
        assert!(kleros_id > U256::ZERO);

        // Verify dispute state
        let dispute = arbitrator.get_dispute(&dispute_id).unwrap();
        assert_eq!(dispute.state, AIDisputeState::Appealed);
        assert_eq!(dispute.kleros_dispute_id, Some(kleros_id));

        // Verify stats
        assert_eq!(
            arbitrator.stats().disputes_appealed.load(Ordering::Relaxed),
            1
        );
    }

    // ========== Community Arbitration (Tier 3) - Juror Selection Tests ==========

    // --- JurorStatus Tests ---

    #[test]
    fn test_juror_status_names() {
        assert_eq!(JurorStatus::Active.name(), "Active");
        assert_eq!(JurorStatus::Serving.name(), "Serving");
        assert_eq!(JurorStatus::Inactive.name(), "Inactive");
        assert_eq!(JurorStatus::Slashed.name(), "Slashed");
    }

    #[test]
    fn test_juror_status_is_selectable() {
        assert!(JurorStatus::Active.is_selectable());
        assert!(!JurorStatus::Serving.is_selectable());
        assert!(!JurorStatus::Inactive.is_selectable());
        assert!(!JurorStatus::Slashed.is_selectable());
    }

    // --- Juror Tests ---

    #[test]
    fn test_juror_new() {
        let juror = Juror::new("did:agentme:base:juror1", 500_000_000, vec![0, 1]);

        assert_eq!(juror.did, "did:agentme:base:juror1");
        assert_eq!(juror.stake_usdc, 500_000_000);
        assert_eq!(juror.status, JurorStatus::Active);
        assert_eq!(juror.courts, vec![0, 1]);
        assert_eq!(juror.reputation, 1.0);
        assert_eq!(juror.cases_total, 0);
        assert_eq!(juror.cases_coherent, 0);
    }

    #[test]
    fn test_juror_effective_stake() {
        let mut juror = Juror::new("did:juror", 1_000_000_000, vec![0]);

        // Full reputation = full stake
        assert_eq!(juror.effective_stake(), 1_000_000_000);

        // Reduced reputation = reduced effective stake
        juror.reputation = 0.5;
        assert_eq!(juror.effective_stake(), 500_000_000);
    }

    #[test]
    fn test_juror_coherence_ratio() {
        let mut juror = Juror::new("did:juror", 500_000_000, vec![0]);

        // No cases = 100% coherence
        assert_eq!(juror.coherence_ratio(), 1.0);

        // Record some cases
        juror.cases_total = 10;
        juror.cases_coherent = 8;
        assert_eq!(juror.coherence_ratio(), 0.8);
    }

    #[test]
    fn test_juror_record_case() {
        let mut juror = Juror::new("did:juror", 500_000_000, vec![0]);

        juror.record_case(true);
        assert_eq!(juror.cases_total, 1);
        assert_eq!(juror.cases_coherent, 1);

        juror.record_case(false);
        assert_eq!(juror.cases_total, 2);
        assert_eq!(juror.cases_coherent, 1);
        assert_eq!(juror.coherence_ratio(), 0.5);
    }

    #[test]
    fn test_juror_is_eligible_for_court() {
        let juror = Juror::new("did:juror", 500_000_000, vec![0, 2, 5]);

        assert!(juror.is_eligible_for_court(0));
        assert!(!juror.is_eligible_for_court(1));
        assert!(juror.is_eligible_for_court(2));
        assert!(!juror.is_eligible_for_court(3));
        assert!(juror.is_eligible_for_court(5));
    }

    // --- JurorVote Tests ---

    #[test]
    fn test_juror_vote_commit() {
        let vote = JurorVote::commit("did:juror", "commitment_hash_123");

        assert_eq!(vote.juror_did, "did:juror");
        assert_eq!(vote.choice, Ruling::None);
        assert!(!vote.revealed);
        assert_eq!(vote.commitment, Some("commitment_hash_123".to_string()));
    }

    #[test]
    fn test_juror_vote_reveal() {
        let vote = JurorVote::reveal(
            "did:juror",
            Ruling::FavorClient,
            "Client provided better evidence",
        );

        assert_eq!(vote.juror_did, "did:juror");
        assert_eq!(vote.choice, Ruling::FavorClient);
        assert!(vote.revealed);
        assert!(vote.commitment.is_none());
        assert!(!vote.justification.is_empty());
    }

    // --- VotingState Tests ---

    #[test]
    fn test_voting_state_names() {
        assert_eq!(VotingState::Evidence.name(), "Evidence");
        assert_eq!(VotingState::Commit.name(), "Commit");
        assert_eq!(VotingState::Reveal.name(), "Reveal");
        assert_eq!(VotingState::Completed.name(), "Completed");
        assert_eq!(VotingState::Appeal.name(), "Appeal");
    }

    // --- VotingSession Tests ---

    #[test]
    fn test_voting_session_new() {
        let session = VotingSession::new(
            "dispute-123",
            vec![
                "did:j1".to_string(),
                "did:j2".to_string(),
                "did:j3".to_string(),
            ],
            3,
        );

        assert_eq!(session.dispute_id, "dispute-123");
        assert_eq!(session.jurors.len(), 3);
        assert_eq!(session.state, VotingState::Evidence);
        assert_eq!(session.required_votes, 3);
        assert!(session.votes.is_empty());
        assert!(session.final_ruling.is_none());
    }

    #[test]
    fn test_voting_session_has_juror() {
        let session = VotingSession::new(
            "dispute-123",
            vec!["did:j1".to_string(), "did:j2".to_string()],
            2,
        );

        assert!(session.has_juror("did:j1"));
        assert!(session.has_juror("did:j2"));
        assert!(!session.has_juror("did:j3"));
    }

    #[test]
    fn test_voting_session_determine_majority() {
        let mut session = VotingSession::new("dispute-123", vec![], 3);

        // No votes = no majority
        assert!(session.determine_majority().is_none());

        // Add revealed votes
        session
            .votes
            .push(JurorVote::reveal("j1", Ruling::FavorClient, "reason"));
        session
            .votes
            .push(JurorVote::reveal("j2", Ruling::FavorClient, "reason"));
        session
            .votes
            .push(JurorVote::reveal("j3", Ruling::FavorProvider, "reason"));

        // 2 FavorClient vs 1 FavorProvider = FavorClient wins
        assert_eq!(session.determine_majority(), Some(Ruling::FavorClient));
    }

    #[test]
    fn test_voting_session_calculate_coherence() {
        let mut session = VotingSession::new("dispute-123", vec![], 3);

        session
            .votes
            .push(JurorVote::reveal("j1", Ruling::FavorClient, "reason"));
        session
            .votes
            .push(JurorVote::reveal("j2", Ruling::FavorClient, "reason"));
        session
            .votes
            .push(JurorVote::reveal("j3", Ruling::FavorProvider, "reason"));

        let results = session.calculate_coherence(1000); // 10% stake at risk

        // j1 and j2 are coherent (voted with majority), j3 is not
        assert!(results.get("j1").unwrap() > &0);
        assert!(results.get("j2").unwrap() > &0);
        assert!(results.get("j3").unwrap() < &0);
    }

    // --- JurorPoolConfig Tests ---

    #[test]
    fn test_juror_pool_config_default() {
        let config = JurorPoolConfig::default();

        assert_eq!(config.min_stake_usdc, 100_000_000); // $100
        assert_eq!(config.initial_jurors, 3);
        assert_eq!(config.stake_at_risk_bps, 1000); // 10%
    }

    #[test]
    fn test_juror_pool_config_builder() {
        let config = JurorPoolConfig::default()
            .with_min_stake(200_000_000)
            .with_juror_count(5);

        assert_eq!(config.min_stake_usdc, 200_000_000);
        assert_eq!(config.initial_jurors, 5);
    }

    // --- JurorPoolStats Tests ---

    #[test]
    fn test_juror_pool_stats_default() {
        let stats = JurorPoolStats::default();

        assert_eq!(stats.jurors_registered.load(Ordering::Relaxed), 0);
        assert_eq!(stats.jurors_active.load(Ordering::Relaxed), 0);
        assert_eq!(stats.sessions_created.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_juror_pool_stats_record() {
        let stats = JurorPoolStats::default();

        stats.record_registration();
        stats.record_session();
        stats.record_vote(true);
        stats.record_vote(false);

        assert_eq!(stats.jurors_registered.load(Ordering::Relaxed), 1);
        assert_eq!(stats.jurors_active.load(Ordering::Relaxed), 1);
        assert_eq!(stats.sessions_created.load(Ordering::Relaxed), 1);
        assert_eq!(stats.votes_cast.load(Ordering::Relaxed), 2);
        assert_eq!(stats.votes_coherent.load(Ordering::Relaxed), 1);
    }

    // --- JurorPool Tests ---

    #[test]
    fn test_juror_pool_new() {
        let config = JurorPoolConfig::default();
        let pool = JurorPool::new(config);

        assert_eq!(pool.config().min_stake_usdc, 100_000_000);
        assert_eq!(pool.stats().jurors_registered.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_juror_pool_register_juror() {
        let pool = JurorPool::disabled();

        let result = pool.register_juror("did:juror1", 500_000_000, vec![0]);
        assert!(result.is_ok());

        let juror = pool.get_juror("did:juror1").unwrap();
        assert_eq!(juror.did, "did:juror1");
        assert_eq!(juror.stake_usdc, 500_000_000);
        assert_eq!(pool.stats().jurors_registered.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_juror_pool_register_below_minimum() {
        let pool = JurorPool::disabled();

        // $50 is below $100 minimum
        let result = pool.register_juror("did:juror1", 50_000_000, vec![0]);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("below minimum"));
    }

    #[test]
    fn test_juror_pool_register_duplicate() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        let result = pool.register_juror("did:juror1", 600_000_000, vec![0]);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("already registered"));
    }

    #[test]
    fn test_juror_pool_update_stake() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.update_stake("did:juror1", 1_000_000_000).unwrap();

        let juror = pool.get_juror("did:juror1").unwrap();
        assert_eq!(juror.stake_usdc, 1_000_000_000);
    }

    #[test]
    fn test_juror_pool_set_status() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.set_juror_status("did:juror1", JurorStatus::Inactive)
            .unwrap();

        let juror = pool.get_juror("did:juror1").unwrap();
        assert_eq!(juror.status, JurorStatus::Inactive);
    }

    #[test]
    fn test_juror_pool_selectable_count() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:juror2", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:juror3", 500_000_000, vec![0])
            .unwrap();

        assert_eq!(pool.selectable_count().unwrap(), 3);

        pool.set_juror_status("did:juror2", JurorStatus::Inactive)
            .unwrap();
        assert_eq!(pool.selectable_count().unwrap(), 2);
    }

    #[test]
    fn test_juror_pool_select_jurors() {
        let pool = JurorPool::disabled();

        // Register 5 jurors
        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        // Select 3 jurors
        let selected = pool.select_jurors(0, 3, 12345).unwrap();

        assert_eq!(selected.len(), 3);
        // All selected should be unique
        let unique: std::collections::HashSet<_> = selected.iter().collect();
        assert_eq!(unique.len(), 3);
    }

    #[test]
    fn test_juror_pool_select_jurors_not_enough() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:juror2", 500_000_000, vec![0])
            .unwrap();

        // Try to select 5 jurors when only 2 available
        let result = pool.select_jurors(0, 5, 12345);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Not enough eligible"));
    }

    #[test]
    fn test_juror_pool_select_by_court() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:juror2", 500_000_000, vec![0, 1])
            .unwrap();
        pool.register_juror("did:juror3", 500_000_000, vec![1])
            .unwrap();

        // Court 0 should only select juror1 and juror2
        let selected = pool.select_jurors(0, 2, 12345).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(!selected.contains(&"did:juror3".to_string()));
    }

    #[test]
    fn test_juror_pool_create_session() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        let dispute_id = pool.create_session("dispute-123", 0).unwrap();
        assert_eq!(dispute_id, "dispute-123");

        let session = pool.get_session("dispute-123").unwrap();
        assert_eq!(session.jurors.len(), 3); // Default 3 jurors
        assert_eq!(session.state, VotingState::Evidence);
    }

    #[test]
    fn test_juror_pool_advance_session_state() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        pool.create_session("dispute-123", 0).unwrap();

        // Evidence -> Commit
        let state = pool.advance_session_state("dispute-123").unwrap();
        assert_eq!(state, VotingState::Commit);

        // Commit -> Reveal
        let state = pool.advance_session_state("dispute-123").unwrap();
        assert_eq!(state, VotingState::Reveal);

        // Reveal -> Completed
        let state = pool.advance_session_state("dispute-123").unwrap();
        assert_eq!(state, VotingState::Completed);
    }

    #[test]
    fn test_juror_pool_commit_and_reveal_vote() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        pool.create_session("dispute-123", 0).unwrap();
        let session = pool.get_session("dispute-123").unwrap();
        let juror_did = session.jurors[0].clone();

        // Advance to Commit phase
        pool.advance_session_state("dispute-123").unwrap();

        // Commit vote
        pool.commit_vote("dispute-123", &juror_did, "hash123")
            .unwrap();

        // Advance to Reveal phase
        pool.advance_session_state("dispute-123").unwrap();

        // Reveal vote
        pool.reveal_vote(
            "dispute-123",
            &juror_did,
            Ruling::FavorClient,
            "Client evidence was stronger",
        )
        .unwrap();

        let session = pool.get_session("dispute-123").unwrap();
        assert_eq!(session.revealed_vote_count(), 1);
    }

    #[test]
    fn test_juror_pool_commit_vote_wrong_state() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        pool.create_session("dispute-123", 0).unwrap();
        let session = pool.get_session("dispute-123").unwrap();
        let juror_did = session.jurors[0].clone();

        // Try to commit in Evidence state (should fail)
        let result = pool.commit_vote("dispute-123", &juror_did, "hash123");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Cannot commit vote"));
    }

    #[test]
    fn test_juror_pool_commit_vote_not_juror() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        pool.create_session("dispute-123", 0).unwrap();
        pool.advance_session_state("dispute-123").unwrap();

        // Try to commit as non-juror
        let result = pool.commit_vote("dispute-123", "did:outsider", "hash123");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("not part of this session"));
    }

    #[test]
    fn test_juror_pool_finalize_session() {
        let pool = JurorPool::disabled();

        for i in 1..=5 {
            pool.register_juror(format!("did:juror{}", i), 500_000_000, vec![0])
                .unwrap();
        }

        pool.create_session("dispute-123", 0).unwrap();
        let session = pool.get_session("dispute-123").unwrap();
        let jurors: Vec<_> = session.jurors.clone();

        // Go through voting phases
        pool.advance_session_state("dispute-123").unwrap(); // Commit

        for juror_did in &jurors {
            pool.commit_vote("dispute-123", juror_did, "hash").unwrap();
        }

        pool.advance_session_state("dispute-123").unwrap(); // Reveal

        // 2 vote FavorClient, 1 votes FavorProvider
        pool.reveal_vote("dispute-123", &jurors[0], Ruling::FavorClient, "reason")
            .unwrap();
        pool.reveal_vote("dispute-123", &jurors[1], Ruling::FavorClient, "reason")
            .unwrap();
        pool.reveal_vote("dispute-123", &jurors[2], Ruling::FavorProvider, "reason")
            .unwrap();

        pool.advance_session_state("dispute-123").unwrap(); // Completed

        let session = pool.get_session("dispute-123").unwrap();
        assert_eq!(session.final_ruling, Some(Ruling::FavorClient));

        // Finalize and check coherence results
        let results = pool.finalize_session("dispute-123").unwrap();
        assert_eq!(results.len(), 3);

        // Coherent jurors should have positive, incoherent negative
        assert!(results.get(&jurors[0]).unwrap() > &0);
        assert!(results.get(&jurors[1]).unwrap() > &0);
        assert!(results.get(&jurors[2]).unwrap() < &0);
    }

    #[test]
    fn test_juror_pool_get_jurors_by_court() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:juror1", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:juror2", 500_000_000, vec![0, 1])
            .unwrap();
        pool.register_juror("did:juror3", 500_000_000, vec![1])
            .unwrap();

        let court_0_jurors = pool.get_jurors_by_court(0).unwrap();
        assert_eq!(court_0_jurors.len(), 2);

        let court_1_jurors = pool.get_jurors_by_court(1).unwrap();
        assert_eq!(court_1_jurors.len(), 2);
    }

    #[test]
    fn test_juror_pool_get_top_jurors() {
        let pool = JurorPool::disabled();

        pool.register_juror("did:small", 100_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:medium", 500_000_000, vec![0])
            .unwrap();
        pool.register_juror("did:large", 1_000_000_000, vec![0])
            .unwrap();

        let top = pool.get_top_jurors(2).unwrap();

        assert_eq!(top.len(), 2);
        assert_eq!(top[0].did, "did:large");
        assert_eq!(top[1].did, "did:medium");
    }

    #[test]
    fn test_juror_pool_stake_weighted_selection_prefers_higher_stakes() {
        let pool = JurorPool::disabled();

        // Register jurors with vastly different stakes
        pool.register_juror("did:whale", 5_000_000_000, vec![0])
            .unwrap(); // $5000
        pool.register_juror("did:small1", 100_000_000, vec![0])
            .unwrap(); // $100
        pool.register_juror("did:small2", 100_000_000, vec![0])
            .unwrap(); // $100
        pool.register_juror("did:small3", 100_000_000, vec![0])
            .unwrap(); // $100
        pool.register_juror("did:small4", 100_000_000, vec![0])
            .unwrap(); // $100

        // Run selection multiple times and count whale selections
        let mut whale_count = 0;
        for seed in 0..100 {
            let selected = pool.select_jurors(0, 3, seed).unwrap();
            if selected.contains(&"did:whale".to_string()) {
                whale_count += 1;
            }
        }

        // Whale should be selected significantly more often (>70% of the time)
        // due to 50x higher stake
        assert!(
            whale_count > 70,
            "Whale selected {} times, expected >70",
            whale_count
        );
    }
}
