//! Error types for AgentMe node.

use thiserror::Error;

/// Result type alias using AgentMe Error.
pub type Result<T> = std::result::Result<T, Error>;

/// AgentMe node error types.
#[derive(Error, Debug)]
pub enum Error {
    /// Configuration error.
    #[error("Configuration error: {0}")]
    Config(String),

    /// Network/P2P error.
    #[error("Network error: {0}")]
    Network(String),

    /// Discovery error.
    #[error("Discovery error: {0}")]
    Discovery(String),

    /// Trust layer error.
    #[error("Trust error: {0}")]
    Trust(String),

    /// API error.
    #[error("API error: {0}")]
    Api(String),

    /// IO error.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization error.
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// libp2p transport error.
    #[error("Transport error: {0}")]
    Transport(String),

    /// Blockchain interaction error.
    #[error("Blockchain error: {0}")]
    Blockchain(String),

    /// Smart contract error.
    #[error("Contract error: {0}")]
    Contract(String),

    /// Persistence/storage error.
    #[error("Persistence error: {0}")]
    Persistence(String),

    /// Search/embedding error.
    #[error("Search error: {0}")]
    Search(String),

    /// Channel/messaging error.
    #[error("Channel error: {0}")]
    Channel(String),

    /// DID/identity error.
    #[error("DID error: {0}")]
    Did(String),

    /// Validation error (invalid input data).
    #[error("Validation error: {0}")]
    Validation(String),

    /// Internal error (system-level failures like clock errors).
    #[error("Internal error: {0}")]
    Internal(String),
}
