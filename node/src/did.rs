//! W3C DID Document support for AgoraMesh.
//!
//! This module provides:
//! - DID Document creation and validation
//! - DID resolution via DHT
//! - Verification method management

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// DID method for AgoraMesh.
pub const DID_METHOD: &str = "agoramesh";

/// DID Document following W3C DID Core 1.0 spec.
///
/// <https://www.w3.org/TR/did-core/>
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DIDDocument {
    /// JSON-LD context.
    #[serde(rename = "@context")]
    pub context: Vec<String>,

    /// The DID for this document.
    pub id: String,

    /// Optional controller DID(s).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller: Option<Vec<String>>,

    /// Verification methods (public keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_method: Option<Vec<VerificationMethod>>,

    /// Authentication methods (references to verification methods).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authentication: Option<Vec<String>>,

    /// Assertion methods.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assertion_method: Option<Vec<String>>,

    /// Service endpoints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<Vec<ServiceEndpoint>>,

    /// AgoraMesh-specific metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<DIDMetadata>,
}

/// Verification method (public key) in a DID Document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationMethod {
    /// Unique identifier for this method.
    pub id: String,

    /// The verification method type.
    #[serde(rename = "type")]
    pub method_type: String,

    /// The controller DID.
    pub controller: String,

    /// Public key in multibase format (for Ed25519).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key_multibase: Option<String>,

    /// Public key in JWK format.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key_jwk: Option<serde_json::Value>,

    /// Ethereum address (for blockchain keys).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blockchain_account_id: Option<String>,
}

/// Service endpoint in a DID Document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEndpoint {
    /// Unique identifier for this service.
    pub id: String,

    /// The service type.
    #[serde(rename = "type")]
    pub service_type: String,

    /// The service endpoint URL.
    pub service_endpoint: String,

    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// AgoraMesh-specific metadata in DID Document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DIDMetadata {
    /// Chain ID where the agent is registered.
    pub chain_id: u64,

    /// Contract address for trust registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_registry: Option<String>,

    /// Capability card URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_card_url: Option<String>,

    /// Creation timestamp (Unix seconds).
    pub created: u64,

    /// Last update timestamp (Unix seconds).
    pub updated: u64,
}

/// DID Document builder for creating new documents.
#[derive(Debug, Default)]
pub struct DIDDocumentBuilder {
    chain_name: String,
    identifier: String,
    verification_methods: Vec<VerificationMethod>,
    services: Vec<ServiceEndpoint>,
    chain_id: Option<u64>,
    trust_registry: Option<String>,
    capability_card_url: Option<String>,
}

impl DIDDocumentBuilder {
    /// Create a new builder with the required chain name and identifier.
    pub fn new(chain_name: &str, identifier: &str) -> Self {
        Self {
            chain_name: chain_name.to_string(),
            identifier: identifier.to_string(),
            ..Default::default()
        }
    }

    /// Add a verification method (public key).
    pub fn add_verification_method(mut self, method: VerificationMethod) -> Self {
        self.verification_methods.push(method);
        self
    }

    /// Add an Ed25519 public key.
    pub fn add_ed25519_key(mut self, key_id: &str, public_key_multibase: &str) -> Self {
        let did = self.did();
        self.verification_methods.push(VerificationMethod {
            id: format!("{}#{}", did, key_id),
            method_type: "Ed25519VerificationKey2020".to_string(),
            controller: did.clone(),
            public_key_multibase: Some(public_key_multibase.to_string()),
            public_key_jwk: None,
            blockchain_account_id: None,
        });
        self
    }

    /// Add an Ethereum account verification method.
    pub fn add_ethereum_account(mut self, key_id: &str, address: &str, chain_id: u64) -> Self {
        let did = self.did();
        // CAIP-10 format: eip155:{chainId}:{address}
        let account_id = format!("eip155:{}:{}", chain_id, address);
        self.verification_methods.push(VerificationMethod {
            id: format!("{}#{}", did, key_id),
            method_type: "EcdsaSecp256k1RecoveryMethod2020".to_string(),
            controller: did.clone(),
            public_key_multibase: None,
            public_key_jwk: None,
            blockchain_account_id: Some(account_id),
        });
        self
    }

    /// Add a service endpoint.
    pub fn add_service(mut self, service: ServiceEndpoint) -> Self {
        self.services.push(service);
        self
    }

    /// Add an A2A agent service endpoint.
    pub fn add_a2a_service(mut self, url: &str) -> Self {
        let did = self.did();
        self.services.push(ServiceEndpoint {
            id: format!("{}#a2a", did),
            service_type: "A2AAgent".to_string(),
            service_endpoint: url.to_string(),
            description: Some("A2A Protocol endpoint".to_string()),
        });
        self
    }

    /// Add a capability card service endpoint.
    pub fn add_capability_card_service(mut self, url: &str) -> Self {
        let did = self.did();
        self.capability_card_url = Some(url.to_string());
        self.services.push(ServiceEndpoint {
            id: format!("{}#capability-card", did),
            service_type: "CapabilityCard".to_string(),
            service_endpoint: url.to_string(),
            description: Some("AgoraMesh Capability Card".to_string()),
        });
        self
    }

    /// Set the chain ID for metadata.
    pub fn chain_id(mut self, chain_id: u64) -> Self {
        self.chain_id = Some(chain_id);
        self
    }

    /// Set the trust registry address.
    pub fn trust_registry(mut self, address: &str) -> Self {
        self.trust_registry = Some(address.to_string());
        self
    }

    /// Build the DID string.
    fn did(&self) -> String {
        format!("did:{}:{}:{}", DID_METHOD, self.chain_name, self.identifier)
    }

    /// Build the DID Document.
    pub fn build(self) -> Result<DIDDocument> {
        if self.chain_name.is_empty() {
            return Err(Error::Did("Chain name is required".to_string()));
        }
        if self.identifier.is_empty() {
            return Err(Error::Did("Identifier is required".to_string()));
        }

        let did = self.did();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Build authentication references from verification methods
        let auth: Vec<String> = self
            .verification_methods
            .iter()
            .map(|vm| vm.id.clone())
            .collect();

        Ok(DIDDocument {
            context: vec![
                "https://www.w3.org/ns/did/v1".to_string(),
                "https://w3id.org/security/suites/ed25519-2020/v1".to_string(),
            ],
            id: did,
            controller: None,
            verification_method: if self.verification_methods.is_empty() {
                None
            } else {
                Some(self.verification_methods)
            },
            authentication: if auth.is_empty() { None } else { Some(auth) },
            assertion_method: None,
            service: if self.services.is_empty() {
                None
            } else {
                Some(self.services)
            },
            metadata: Some(DIDMetadata {
                chain_id: self.chain_id.unwrap_or(84532), // Base Sepolia default
                trust_registry: self.trust_registry,
                capability_card_url: self.capability_card_url,
                created: now,
                updated: now,
            }),
        })
    }
}

impl DIDDocument {
    /// Parse a DID string and extract components.
    ///
    /// Format: `did:agoramesh:{chain}:{identifier}`
    pub fn parse_did(did: &str) -> Result<(String, String, String)> {
        let parts: Vec<&str> = did.split(':').collect();
        if parts.len() != 4 {
            return Err(Error::Did(format!(
                "Invalid DID format: '{}'. Expected did:agoramesh:chain:identifier",
                did
            )));
        }
        if parts[0] != "did" {
            return Err(Error::Did(format!(
                "Invalid DID scheme: '{}'. Must start with 'did:'",
                parts[0]
            )));
        }
        if parts[1] != DID_METHOD {
            return Err(Error::Did(format!(
                "Invalid DID method: '{}'. Expected '{}'",
                parts[1], DID_METHOD
            )));
        }

        Ok((
            parts[1].to_string(), // method
            parts[2].to_string(), // chain
            parts[3].to_string(), // identifier
        ))
    }

    /// Validate the DID document.
    pub fn validate(&self) -> Result<()> {
        // Validate DID format
        Self::parse_did(&self.id)?;

        // Validate verification methods reference the correct controller
        if let Some(ref methods) = self.verification_method {
            for method in methods {
                if !method.id.starts_with(&self.id) {
                    return Err(Error::Did(format!(
                        "Verification method '{}' does not belong to DID '{}'",
                        method.id, self.id
                    )));
                }
                if method.controller != self.id {
                    return Err(Error::Did(format!(
                        "Verification method '{}' has incorrect controller",
                        method.id
                    )));
                }
            }
        }

        // Validate service endpoints reference the correct DID
        if let Some(ref services) = self.service {
            for service in services {
                if !service.id.starts_with(&self.id) {
                    return Err(Error::Did(format!(
                        "Service '{}' does not belong to DID '{}'",
                        service.id, self.id
                    )));
                }
            }
        }

        Ok(())
    }

    /// Get the A2A service endpoint URL if present.
    pub fn a2a_endpoint(&self) -> Option<&str> {
        self.service.as_ref().and_then(|services| {
            services
                .iter()
                .find(|s| s.service_type == "A2AAgent")
                .map(|s| s.service_endpoint.as_str())
        })
    }

    /// Get the capability card URL if present.
    pub fn capability_card_url(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|m| m.capability_card_url.as_deref())
    }

    /// Get a verification method by key ID fragment.
    pub fn get_verification_method(&self, key_id: &str) -> Option<&VerificationMethod> {
        self.verification_method.as_ref().and_then(|methods| {
            methods
                .iter()
                .find(|m| m.id.ends_with(&format!("#{}", key_id)))
        })
    }

    /// Serialize to JSON.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| Error::Did(format!("Failed to serialize DID document: {}", e)))
    }

    /// Deserialize from JSON.
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json)
            .map_err(|e| Error::Did(format!("Failed to parse DID document: {}", e)))
    }
}

/// DID Resolution result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DIDResolutionResult {
    /// The resolved DID document (if found).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub did_document: Option<DIDDocument>,

    /// Resolution metadata.
    pub did_resolution_metadata: DIDResolutionMetadata,

    /// Document metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub did_document_metadata: Option<DIDDocumentMetadata>,
}

/// Metadata about the resolution process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DIDResolutionMetadata {
    /// Content type of the resolved document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,

    /// Error code if resolution failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// Error message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Metadata about the DID document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DIDDocumentMetadata {
    /// When the document was created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,

    /// When the document was last updated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,

    /// Whether the DID has been deactivated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deactivated: Option<bool>,
}

impl DIDResolutionResult {
    /// Create a successful resolution result.
    pub fn success(document: DIDDocument) -> Self {
        let created = document.metadata.as_ref().map(|m| m.created.to_string());
        let updated = document.metadata.as_ref().map(|m| m.updated.to_string());
        Self {
            did_document: Some(document),
            did_resolution_metadata: DIDResolutionMetadata {
                content_type: Some("application/did+ld+json".to_string()),
                error: None,
                message: None,
            },
            did_document_metadata: Some(DIDDocumentMetadata {
                created,
                updated,
                deactivated: Some(false),
            }),
        }
    }

    /// Create a not found error result.
    pub fn not_found(did: &str) -> Self {
        Self {
            did_document: None,
            did_resolution_metadata: DIDResolutionMetadata {
                content_type: None,
                error: Some("notFound".to_string()),
                message: Some(format!("DID '{}' not found", did)),
            },
            did_document_metadata: None,
        }
    }

    /// Create an invalid DID error result.
    pub fn invalid_did(message: &str) -> Self {
        Self {
            did_document: None,
            did_resolution_metadata: DIDResolutionMetadata {
                content_type: None,
                error: Some("invalidDid".to_string()),
                message: Some(message.to_string()),
            },
            did_document_metadata: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== TDD Tests: DID parsing ==========

    #[test]
    fn test_parse_did_valid() {
        let result = DIDDocument::parse_did("did:agoramesh:base:abc123");

        assert!(result.is_ok());
        let (method, chain, identifier) = result.unwrap();
        assert_eq!(method, "agoramesh");
        assert_eq!(chain, "base");
        assert_eq!(identifier, "abc123");
    }

    #[test]
    fn test_parse_did_invalid_format() {
        let result = DIDDocument::parse_did("did:agoramesh:base");

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Invalid DID format"));
    }

    #[test]
    fn test_parse_did_wrong_scheme() {
        let result = DIDDocument::parse_did("urn:agoramesh:base:abc");

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("scheme"));
    }

    #[test]
    fn test_parse_did_wrong_method() {
        let result = DIDDocument::parse_did("did:web:example.com:user");

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("method"));
    }

    // ========== TDD Tests: DIDDocumentBuilder ==========

    #[test]
    fn test_builder_creates_valid_document() {
        let doc = DIDDocumentBuilder::new("base", "test-agent")
            .chain_id(84532)
            .build();

        assert!(doc.is_ok());
        let doc = doc.unwrap();
        assert_eq!(doc.id, "did:agoramesh:base:test-agent");
        assert!(doc
            .context
            .contains(&"https://www.w3.org/ns/did/v1".to_string()));
    }

    #[test]
    fn test_builder_requires_chain_name() {
        let doc = DIDDocumentBuilder::new("", "test").build();

        assert!(doc.is_err());
        assert!(doc.unwrap_err().to_string().contains("Chain name"));
    }

    #[test]
    fn test_builder_requires_identifier() {
        let doc = DIDDocumentBuilder::new("base", "").build();

        assert!(doc.is_err());
        assert!(doc.unwrap_err().to_string().contains("Identifier"));
    }

    #[test]
    fn test_builder_adds_ed25519_key() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ed25519_key("key-1", "z6MkpTHR8VNs...")
            .build()
            .unwrap();

        assert!(doc.verification_method.is_some());
        let methods = doc.verification_method.unwrap();
        assert_eq!(methods.len(), 1);
        assert!(methods[0].id.ends_with("#key-1"));
        assert_eq!(methods[0].method_type, "Ed25519VerificationKey2020");
    }

    #[test]
    fn test_builder_adds_ethereum_account() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ethereum_account(
                "eth-key",
                "0x1234567890123456789012345678901234567890",
                84532,
            )
            .build()
            .unwrap();

        let methods = doc.verification_method.unwrap();
        assert!(methods[0]
            .blockchain_account_id
            .as_ref()
            .unwrap()
            .contains("eip155:84532:"));
    }

    #[test]
    fn test_builder_adds_a2a_service() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_a2a_service("https://agent.example.com/a2a")
            .build()
            .unwrap();

        assert!(doc.service.is_some());
        let services = doc.service.unwrap();
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].service_type, "A2AAgent");
        assert_eq!(
            services[0].service_endpoint,
            "https://agent.example.com/a2a"
        );
    }

    #[test]
    fn test_builder_adds_capability_card_service() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_capability_card_service("https://agent.example.com/.well-known/agent.json")
            .build()
            .unwrap();

        let services = doc.service.as_ref().unwrap();
        assert_eq!(services[0].service_type, "CapabilityCard");
        assert!(doc.capability_card_url().is_some());
    }

    #[test]
    fn test_builder_sets_metadata() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .chain_id(8453)
            .trust_registry("0xABCD1234567890123456789012345678901234AB")
            .build()
            .unwrap();

        let metadata = doc.metadata.unwrap();
        assert_eq!(metadata.chain_id, 8453);
        assert!(metadata.trust_registry.is_some());
    }

    // ========== TDD Tests: DIDDocument validation ==========

    #[test]
    fn test_validate_valid_document() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ed25519_key("key-1", "z6MkpTHR8VNs...")
            .add_a2a_service("https://agent.example.com")
            .build()
            .unwrap();

        let result = doc.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_detects_invalid_verification_method_controller() {
        let mut doc = DIDDocumentBuilder::new("base", "test").build().unwrap();

        doc.verification_method = Some(vec![VerificationMethod {
            id: "did:agoramesh:base:test#key-1".to_string(),
            method_type: "Ed25519VerificationKey2020".to_string(),
            controller: "did:agoramesh:base:other".to_string(), // Wrong controller
            public_key_multibase: Some("z6MkpTHR8VNs...".to_string()),
            public_key_jwk: None,
            blockchain_account_id: None,
        }]);

        let result = doc.validate();
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("incorrect controller"));
    }

    // ========== TDD Tests: DIDDocument accessors ==========

    #[test]
    fn test_a2a_endpoint_returns_url() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_a2a_service("https://agent.example.com/a2a")
            .build()
            .unwrap();

        assert_eq!(doc.a2a_endpoint(), Some("https://agent.example.com/a2a"));
    }

    #[test]
    fn test_a2a_endpoint_returns_none_when_missing() {
        let doc = DIDDocumentBuilder::new("base", "test").build().unwrap();

        assert!(doc.a2a_endpoint().is_none());
    }

    #[test]
    fn test_get_verification_method_by_key_id() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ed25519_key("primary", "z6MkpTHR8VNs...")
            .add_ed25519_key("backup", "z6MkqXYZ...")
            .build()
            .unwrap();

        let method = doc.get_verification_method("primary");
        assert!(method.is_some());
        assert!(method.unwrap().id.ends_with("#primary"));

        let method = doc.get_verification_method("backup");
        assert!(method.is_some());

        let method = doc.get_verification_method("nonexistent");
        assert!(method.is_none());
    }

    // ========== TDD Tests: Serialization ==========

    #[test]
    fn test_to_json_produces_valid_json() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ed25519_key("key-1", "z6MkpTHR8VNs...")
            .add_a2a_service("https://agent.example.com")
            .build()
            .unwrap();

        let json = doc.to_json();
        assert!(json.is_ok());

        let json = json.unwrap();
        assert!(json.contains("@context"));
        assert!(json.contains("did:agoramesh:base:test"));
    }

    #[test]
    fn test_from_json_parses_document() {
        let doc = DIDDocumentBuilder::new("base", "test")
            .add_ed25519_key("key-1", "z6MkpTHR8VNs...")
            .build()
            .unwrap();

        let json = doc.to_json().unwrap();
        let parsed = DIDDocument::from_json(&json);

        assert!(parsed.is_ok());
        let parsed = parsed.unwrap();
        assert_eq!(parsed.id, doc.id);
    }

    #[test]
    fn test_from_json_rejects_invalid() {
        let result = DIDDocument::from_json("not valid json");

        assert!(result.is_err());
    }

    // ========== TDD Tests: DIDResolutionResult ==========

    #[test]
    fn test_resolution_success() {
        let doc = DIDDocumentBuilder::new("base", "test").build().unwrap();
        let result = DIDResolutionResult::success(doc);

        assert!(result.did_document.is_some());
        assert!(result.did_resolution_metadata.error.is_none());
        assert_eq!(
            result.did_resolution_metadata.content_type,
            Some("application/did+ld+json".to_string())
        );
    }

    #[test]
    fn test_resolution_not_found() {
        let result = DIDResolutionResult::not_found("did:agoramesh:base:unknown");

        assert!(result.did_document.is_none());
        assert_eq!(
            result.did_resolution_metadata.error,
            Some("notFound".to_string())
        );
    }

    #[test]
    fn test_resolution_invalid_did() {
        let result = DIDResolutionResult::invalid_did("Invalid format");

        assert!(result.did_document.is_none());
        assert_eq!(
            result.did_resolution_metadata.error,
            Some("invalidDid".to_string())
        );
    }
}
