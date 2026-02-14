//! Smart contract interactions for TrustRegistry.
//!
//! This module provides a client for interacting with the TrustRegistry
//! smart contract on Base L2.

use alloy::primitives::{Address, FixedBytes};
use alloy::providers::ProviderBuilder;
use alloy::sol;

use crate::error::{Error, Result};

// Generate contract bindings from ABI
sol!(
    #[allow(missing_docs)]
    #[sol(rpc)]
    TrustRegistry,
    r#"[
        {
            "type": "function",
            "name": "recordTransaction",
            "inputs": [
                {"name": "agentDid", "type": "bytes32"},
                {"name": "volumeUsd", "type": "uint256"},
                {"name": "successful", "type": "bool"}
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "endorse",
            "inputs": [
                {"name": "endorseeDid", "type": "bytes32"},
                {"name": "message", "type": "string"}
            ],
            "outputs": [],
            "stateMutability": "nonpayable"
        },
        {
            "type": "function",
            "name": "getTrustScore",
            "inputs": [
                {"name": "didHash", "type": "bytes32"}
            ],
            "outputs": [
                {"name": "compositeScore", "type": "uint256"}
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "getTrustDetails",
            "inputs": [
                {"name": "didHash", "type": "bytes32"}
            ],
            "outputs": [
                {"name": "reputationScore", "type": "uint256"},
                {"name": "stakeScore", "type": "uint256"},
                {"name": "endorsementScore", "type": "uint256"},
                {"name": "compositeScore", "type": "uint256"}
            ],
            "stateMutability": "view"
        },
        {
            "type": "function",
            "name": "getReputation",
            "inputs": [
                {"name": "didHash", "type": "bytes32"}
            ],
            "outputs": [
                {"name": "score", "type": "uint256"},
                {"name": "transactions", "type": "uint256"},
                {"name": "successRate", "type": "uint256"}
            ],
            "stateMutability": "view"
        }
    ]"#
);

/// Trust score details from the contract.
#[derive(Debug, Clone)]
pub struct OnChainTrustDetails {
    /// Reputation component (0-10000).
    pub reputation_score: u64,
    /// Stake component (0-10000).
    pub stake_score: u64,
    /// Endorsement component (0-10000).
    pub endorsement_score: u64,
    /// Weighted composite score (0-10000).
    pub composite_score: u64,
}

/// Client for interacting with TrustRegistry contract.
pub struct TrustRegistryClient {
    rpc_url: String,
    contract_address: Address,
}

impl TrustRegistryClient {
    /// Create a new TrustRegistry client.
    ///
    /// # Arguments
    ///
    /// * `rpc_url` - Ethereum RPC URL (e.g., https://sepolia.base.org)
    /// * `contract_address` - TrustRegistry contract address
    pub fn new(rpc_url: String, contract_address: &str) -> Result<Self> {
        let address = contract_address
            .parse::<Address>()
            .map_err(|e| Error::Config(format!("Invalid contract address: {}", e)))?;

        Ok(Self {
            rpc_url,
            contract_address: address,
        })
    }

    /// Convert DID string to bytes32 hash.
    ///
    /// Uses keccak256 hash of the DID string.
    pub fn did_to_hash(did: &str) -> FixedBytes<32> {
        use alloy::primitives::keccak256;
        keccak256(did.as_bytes())
    }

    /// Get trust score for an agent from the contract.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID string
    ///
    /// # Returns
    ///
    /// Composite trust score (0-10000).
    pub async fn get_trust_score(&self, did: &str) -> Result<u64> {
        let provider = ProviderBuilder::new().connect_http(
            self.rpc_url
                .parse()
                .map_err(|e| Error::Network(format!("Invalid RPC URL: {}", e)))?,
        );

        let contract = TrustRegistry::new(self.contract_address, provider);
        let did_hash = Self::did_to_hash(did);

        let result = contract
            .getTrustScore(did_hash)
            .call()
            .await
            .map_err(|e| Error::Contract(format!("Failed to get trust score: {}", e)))?;

        // Result is a single U256 value for getTrustScore
        // Convert U256 to u64 (safe since score is 0-10000)
        Ok(result.try_into().unwrap_or(0))
    }

    /// Get detailed trust breakdown for an agent.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID string
    ///
    /// # Returns
    ///
    /// Trust details with all component scores.
    pub async fn get_trust_details(&self, did: &str) -> Result<OnChainTrustDetails> {
        let provider = ProviderBuilder::new().connect_http(
            self.rpc_url
                .parse()
                .map_err(|e| Error::Network(format!("Invalid RPC URL: {}", e)))?,
        );

        let contract = TrustRegistry::new(self.contract_address, provider);
        let did_hash = Self::did_to_hash(did);

        let result = contract
            .getTrustDetails(did_hash)
            .call()
            .await
            .map_err(|e| Error::Contract(format!("Failed to get trust details: {}", e)))?;

        Ok(OnChainTrustDetails {
            reputation_score: result.reputationScore.try_into().unwrap_or(0),
            stake_score: result.stakeScore.try_into().unwrap_or(0),
            endorsement_score: result.endorsementScore.try_into().unwrap_or(0),
            composite_score: result.compositeScore.try_into().unwrap_or(0),
        })
    }

    /// Get reputation data for an agent.
    ///
    /// # Arguments
    ///
    /// * `did` - Agent's DID string
    ///
    /// # Returns
    ///
    /// Tuple of (score, transactions, success_rate).
    pub async fn get_reputation(&self, did: &str) -> Result<(u64, u64, u64)> {
        let provider = ProviderBuilder::new().connect_http(
            self.rpc_url
                .parse()
                .map_err(|e| Error::Network(format!("Invalid RPC URL: {}", e)))?,
        );

        let contract = TrustRegistry::new(self.contract_address, provider);
        let did_hash = Self::did_to_hash(did);

        let result = contract
            .getReputation(did_hash)
            .call()
            .await
            .map_err(|e| Error::Contract(format!("Failed to get reputation: {}", e)))?;

        Ok((
            result.score.try_into().unwrap_or(0),
            result.transactions.try_into().unwrap_or(0),
            result.successRate.try_into().unwrap_or(0),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_did_to_hash_produces_consistent_output() {
        let did = "did:agentme:base:test-agent";
        let hash1 = TrustRegistryClient::did_to_hash(did);
        let hash2 = TrustRegistryClient::did_to_hash(did);

        assert_eq!(hash1, hash2, "Same DID should produce same hash");
    }

    #[test]
    fn test_did_to_hash_different_dids_produce_different_hashes() {
        let hash1 = TrustRegistryClient::did_to_hash("did:agentme:base:agent1");
        let hash2 = TrustRegistryClient::did_to_hash("did:agentme:base:agent2");

        assert_ne!(
            hash1, hash2,
            "Different DIDs should produce different hashes"
        );
    }

    #[test]
    fn test_new_client_validates_contract_address() {
        let result =
            TrustRegistryClient::new("https://sepolia.base.org".to_string(), "invalid-address");

        assert!(result.is_err(), "Should reject invalid address");
    }

    #[test]
    fn test_new_client_accepts_valid_address() {
        let result = TrustRegistryClient::new(
            "https://sepolia.base.org".to_string(),
            "0x1234567890123456789012345678901234567890",
        );

        assert!(result.is_ok(), "Should accept valid address");
    }

    #[test]
    fn test_did_hash_is_32_bytes() {
        let hash = TrustRegistryClient::did_to_hash("did:agentme:base:test");

        assert_eq!(hash.len(), 32, "Hash should be 32 bytes");
    }
}
