//! AgoraMesh Plugin System
//!
//! A modular, extensible plugin architecture for AI agents.
//!
//! Inspired by the ElizaOS plugin architecture, this system provides:
//! - **Plugins**: Modular bundles of functionality
//! - **Actions**: Capabilities the agent can execute
//! - **Providers**: Data sources the agent can access
//! - **Services**: External systems the agent connects to
//!
//! # Example
//!
//! ```rust,ignore
//! use agoramesh_node::plugin::{Plugin, PluginRegistry, Action, ActionContext};
//!
//! // Define a simple action
//! struct EchoAction;
//!
//! #[async_trait::async_trait]
//! impl Action for EchoAction {
//!     fn name(&self) -> &str { "echo" }
//!     fn description(&self) -> &str { "Echoes input back" }
//!
//!     async fn execute(&self, ctx: &ActionContext, input: serde_json::Value)
//!         -> Result<serde_json::Value, PluginError>
//!     {
//!         Ok(input)
//!     }
//! }
//!
//! // Create a plugin with the action
//! let plugin = PluginBuilder::new("echo-plugin")
//!     .description("Simple echo functionality")
//!     .action(Box::new(EchoAction))
//!     .build();
//!
//! // Register with the registry
//! let mut registry = PluginRegistry::new();
//! registry.register(plugin).await?;
//! ```

mod action;
mod builder;
mod error;
mod provider;
mod registry;
mod service;
mod types;

pub use action::{Action, ActionContext, ActionMetadata};
pub use builder::PluginBuilder;
pub use error::{PluginError, PluginResult};
pub use provider::{Provider, ProviderContext, ProviderMetadata};
pub use registry::{PluginRegistry, RegisteredPlugin};
pub use service::{Service, ServiceContext, ServiceMetadata, ServiceStatus};
pub use types::{Plugin, PluginConfig, PluginInfo, PluginPriority};
