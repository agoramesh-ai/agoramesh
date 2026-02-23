//! Plugin Registry - manages plugin lifecycle

use super::action::{ActionContext, ActionResult, TrackedAction};
use super::error::{PluginError, PluginResult};
use super::provider::{CachedProvider, ProviderContext, ProviderData};
use super::service::{ManagedService, ServiceContext, ServiceStatus};
use super::types::{Plugin, PluginInfo};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// Registered plugin with all its components
pub struct RegisteredPlugin {
    /// The plugin itself
    pub plugin: Arc<RwLock<dyn Plugin>>,
    /// Plugin info (cached for fast access)
    pub info: PluginInfo,
    /// Registered actions
    pub actions: HashMap<String, TrackedAction>,
    /// Registered providers
    pub providers: HashMap<String, CachedProvider>,
    /// Registered services
    pub services: HashMap<String, ManagedService>,
    /// Whether the plugin is enabled
    pub enabled: bool,
}

/// The Plugin Registry
///
/// Manages plugin lifecycle including:
/// - Registration and unregistration
/// - Dependency resolution
/// - Action/Provider/Service lookup
/// - Plugin health monitoring
///
/// # Example
///
/// ```rust,ignore
/// use agoramesh_node::plugin::{PluginRegistry, PluginBuilder, ActionContext};
///
/// let mut registry = PluginRegistry::new();
///
/// // Register a plugin
/// let plugin = PluginBuilder::new("my-plugin")
///     .description("My awesome plugin")
///     .build();
/// registry.register(plugin).await?;
///
/// // Execute an action
/// let result = registry.execute_action(
///     "my_action",
///     &ActionContext::new("did:agoramesh:base:0x..."),
///     serde_json::json!({"param": "value"})
/// ).await?;
/// ```
pub struct PluginRegistry {
    /// Registered plugins by name
    plugins: HashMap<String, RegisteredPlugin>,
    /// Action name to plugin name mapping
    action_index: HashMap<String, String>,
    /// Provider name to plugin name mapping
    provider_index: HashMap<String, String>,
    /// Service name to plugin name mapping
    service_index: HashMap<String, String>,
}

impl PluginRegistry {
    /// Create a new plugin registry
    pub fn new() -> Self {
        Self {
            plugins: HashMap::new(),
            action_index: HashMap::new(),
            provider_index: HashMap::new(),
            service_index: HashMap::new(),
        }
    }

    /// Register a plugin
    ///
    /// This will:
    /// 1. Validate the plugin
    /// 2. Check dependencies
    /// 3. Initialize the plugin
    /// 4. Register all actions, providers, and services
    pub async fn register(&mut self, mut plugin: impl Plugin + 'static) -> PluginResult<()> {
        let info = plugin.info().clone();
        let plugin_name = info.name.clone();

        // Check if already registered
        if self.plugins.contains_key(&plugin_name) {
            return Err(PluginError::AlreadyRegistered(plugin_name));
        }

        // Check dependencies
        for dep in &info.dependencies {
            if !self.plugins.contains_key(dep) {
                return Err(PluginError::DependencyNotSatisfied {
                    plugin: plugin_name.clone(),
                    dependency: dep.clone(),
                });
            }
        }

        // Initialize the plugin
        if let Err(e) = plugin.init().await {
            return Err(PluginError::InitializationFailed {
                plugin: plugin_name.clone(),
                reason: e.to_string(),
            });
        }

        // Get components before moving plugin
        let actions = plugin.actions();
        let providers = plugin.providers();
        let services = plugin.services();
        let enabled = plugin.is_enabled();

        // Convert to Arc<RwLock>
        let plugin: Arc<RwLock<dyn Plugin>> = Arc::new(RwLock::new(plugin));

        // Register actions
        let mut action_map = HashMap::new();
        for action in actions {
            let name = action.metadata().name.clone();
            if self.action_index.contains_key(&name) {
                warn!(
                    "Action '{}' already registered, skipping from plugin '{}'",
                    name, plugin_name
                );
                continue;
            }
            self.action_index.insert(name.clone(), plugin_name.clone());
            action_map.insert(name, TrackedAction::new(action));
        }

        // Register providers
        let mut provider_map = HashMap::new();
        for provider in providers {
            let name = provider.metadata().name.clone();
            if self.provider_index.contains_key(&name) {
                warn!(
                    "Provider '{}' already registered, skipping from plugin '{}'",
                    name, plugin_name
                );
                continue;
            }
            self.provider_index
                .insert(name.clone(), plugin_name.clone());
            provider_map.insert(name, CachedProvider::new(provider));
        }

        // Register services - store the Arc directly
        let mut service_map = HashMap::new();
        for service in services {
            let name = service.metadata().name.clone();
            if self.service_index.contains_key(&name) {
                warn!(
                    "Service '{}' already registered, skipping from plugin '{}'",
                    name, plugin_name
                );
                continue;
            }
            self.service_index.insert(name.clone(), plugin_name.clone());
            // Create a new managed service wrapper
            service_map.insert(name, ManagedService::wrap(service));
        }

        info!(
            "Registered plugin '{}' with {} actions, {} providers, {} services",
            plugin_name,
            action_map.len(),
            provider_map.len(),
            service_map.len()
        );

        self.plugins.insert(
            plugin_name,
            RegisteredPlugin {
                plugin,
                info,
                actions: action_map,
                providers: provider_map,
                services: service_map,
                enabled,
            },
        );

        Ok(())
    }

    /// Unregister a plugin
    pub async fn unregister(&mut self, plugin_name: &str) -> PluginResult<()> {
        let plugin = self
            .plugins
            .remove(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.to_string()))?;

        // Stop all services
        for (name, service) in &plugin.services {
            if let Err(e) = service.stop().await {
                error!("Failed to stop service '{}': {}", name, e);
            }
        }

        // Shutdown the plugin
        {
            let mut p = plugin.plugin.write().await;
            if let Err(e) = p.shutdown().await {
                error!("Failed to shutdown plugin '{}': {}", plugin_name, e);
            }
        }

        // Remove from indexes
        for action_name in plugin.actions.keys() {
            self.action_index.remove(action_name);
        }
        for provider_name in plugin.providers.keys() {
            self.provider_index.remove(provider_name);
        }
        for service_name in plugin.services.keys() {
            self.service_index.remove(service_name);
        }

        info!("Unregistered plugin '{}'", plugin_name);
        Ok(())
    }

    /// Get a plugin by name
    pub fn get_plugin(&self, name: &str) -> Option<&RegisteredPlugin> {
        self.plugins.get(name)
    }

    /// Get all registered plugins
    pub fn plugins(&self) -> impl Iterator<Item = &RegisteredPlugin> {
        self.plugins.values()
    }

    /// List all registered plugin names
    pub fn plugin_names(&self) -> Vec<String> {
        self.plugins.keys().cloned().collect()
    }

    // ============ Action Methods ============

    /// Execute an action by name
    pub async fn execute_action(
        &self,
        action_name: &str,
        ctx: &ActionContext,
        input: serde_json::Value,
    ) -> PluginResult<ActionResult> {
        let plugin_name = self
            .action_index
            .get(action_name)
            .ok_or_else(|| PluginError::NotFound(format!("Action '{}'", action_name)))?;

        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.clone()))?;

        if !plugin.enabled {
            return Err(PluginError::Disabled(plugin_name.clone()));
        }

        let action = plugin
            .actions
            .get(action_name)
            .ok_or_else(|| PluginError::NotFound(format!("Action '{}'", action_name)))?;

        // Validate input
        action.inner().validate_input(&input)?;

        // Check if can execute
        if !action.inner().can_execute(ctx) {
            return Err(PluginError::ActionFailed {
                action: action_name.to_string(),
                reason: "Action cannot be executed in this context".to_string(),
            });
        }

        debug!(
            "Executing action '{}' for agent '{}'",
            action_name, ctx.agent_did
        );
        action.execute_tracked(ctx, input).await
    }

    /// List all available actions
    pub fn list_actions(&self) -> Vec<super::action::ActionMetadata> {
        self.plugins
            .values()
            .filter(|p| p.enabled)
            .flat_map(|p| p.actions.values().map(|a| a.inner().metadata()))
            .collect()
    }

    /// Get action by name
    pub fn get_action(&self, name: &str) -> Option<&TrackedAction> {
        let plugin_name = self.action_index.get(name)?;
        let plugin = self.plugins.get(plugin_name)?;
        plugin.actions.get(name)
    }

    // ============ Provider Methods ============

    /// Get data from a provider
    pub async fn get_provider_data(
        &self,
        provider_name: &str,
        ctx: &ProviderContext,
    ) -> PluginResult<ProviderData> {
        let plugin_name = self
            .provider_index
            .get(provider_name)
            .ok_or_else(|| PluginError::NotFound(format!("Provider '{}'", provider_name)))?;

        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.clone()))?;

        if !plugin.enabled {
            return Err(PluginError::Disabled(plugin_name.clone()));
        }

        let provider = plugin
            .providers
            .get(provider_name)
            .ok_or_else(|| PluginError::NotFound(format!("Provider '{}'", provider_name)))?;

        debug!(
            "Getting data from provider '{}' for agent '{}'",
            provider_name, ctx.agent_did
        );
        provider.get_cached(ctx).await
    }

    /// List all available providers
    pub fn list_providers(&self) -> Vec<super::provider::ProviderMetadata> {
        self.plugins
            .values()
            .filter(|p| p.enabled)
            .flat_map(|p| {
                p.providers.values().map(|_provider| {
                    // We need to access the inner provider's metadata
                    // This is a bit awkward due to the CachedProvider wrapper
                    // For now, we'll store metadata separately or use a different approach
                    super::provider::ProviderMetadata::default()
                })
            })
            .collect()
    }

    // ============ Service Methods ============

    /// Start a service
    pub async fn start_service(&self, service_name: &str, ctx: ServiceContext) -> PluginResult<()> {
        let plugin_name = self
            .service_index
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.clone()))?;

        if !plugin.enabled {
            return Err(PluginError::Disabled(plugin_name.clone()));
        }

        let service = plugin
            .services
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        info!("Starting service '{}'", service_name);
        service.start(ctx).await
    }

    /// Stop a service
    pub async fn stop_service(&self, service_name: &str) -> PluginResult<()> {
        let plugin_name = self
            .service_index
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.clone()))?;

        let service = plugin
            .services
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        info!("Stopping service '{}'", service_name);
        service.stop().await
    }

    /// Get service status
    pub async fn service_status(&self, service_name: &str) -> PluginResult<ServiceStatus> {
        let plugin_name = self
            .service_index
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::NotFound(plugin_name.clone()))?;

        let service = plugin
            .services
            .get(service_name)
            .ok_or_else(|| PluginError::NotFound(format!("Service '{}'", service_name)))?;

        Ok(service.status().await)
    }

    /// List all services
    pub fn list_services(&self) -> Vec<(String, String)> {
        self.service_index
            .iter()
            .map(|(service, plugin)| (service.clone(), plugin.clone()))
            .collect()
    }

    /// Start all services marked as auto-start
    pub async fn start_auto_services(&self, agent_did: &str) -> Vec<PluginResult<()>> {
        let mut results = Vec::new();

        for plugin in self.plugins.values() {
            if !plugin.enabled {
                continue;
            }

            for (service_name, service) in &plugin.services {
                let metadata = service.metadata().await;
                if metadata.auto_start {
                    let ctx = ServiceContext::new(agent_did);
                    results.push(self.start_service(service_name, ctx).await);
                }
            }
        }

        results
    }

    // ============ Plugin Management ============

    /// Enable a plugin
    pub fn enable_plugin(&mut self, name: &str) -> PluginResult<()> {
        let plugin = self
            .plugins
            .get_mut(name)
            .ok_or_else(|| PluginError::NotFound(name.to_string()))?;

        plugin.enabled = true;
        info!("Enabled plugin '{}'", name);
        Ok(())
    }

    /// Disable a plugin
    pub fn disable_plugin(&mut self, name: &str) -> PluginResult<()> {
        let plugin = self
            .plugins
            .get_mut(name)
            .ok_or_else(|| PluginError::NotFound(name.to_string()))?;

        plugin.enabled = false;
        info!("Disabled plugin '{}'", name);
        Ok(())
    }

    /// Get plugin count
    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    /// Get action count
    pub fn action_count(&self) -> usize {
        self.action_index.len()
    }

    /// Get provider count
    pub fn provider_count(&self) -> usize {
        self.provider_index.len()
    }

    /// Get service count
    pub fn service_count(&self) -> usize {
        self.service_index.len()
    }
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{Action, ActionMetadata, PluginBuilder};

    // Simple test action
    struct TestAction;

    #[async_trait::async_trait]
    impl Action for TestAction {
        fn metadata(&self) -> ActionMetadata {
            ActionMetadata {
                name: "test_action".to_string(),
                description: "A test action".to_string(),
                ..Default::default()
            }
        }

        async fn execute(
            &self,
            _ctx: &ActionContext,
            input: serde_json::Value,
        ) -> PluginResult<ActionResult> {
            Ok(ActionResult::success(input))
        }
    }

    #[tokio::test]
    async fn test_register_plugin() {
        let mut registry = PluginRegistry::new();

        let plugin = PluginBuilder::new("test-plugin")
            .description("Test plugin")
            .action(Arc::new(TestAction))
            .build();

        registry.register(plugin).await.unwrap();

        assert_eq!(registry.plugin_count(), 1);
        assert_eq!(registry.action_count(), 1);
    }

    #[tokio::test]
    async fn test_execute_action() {
        let mut registry = PluginRegistry::new();

        let plugin = PluginBuilder::new("test-plugin")
            .action(Arc::new(TestAction))
            .build();

        registry.register(plugin).await.unwrap();

        let ctx = ActionContext::new("did:test:agent");
        let input = serde_json::json!({"test": "value"});

        let result = registry
            .execute_action("test_action", &ctx, input.clone())
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(result.output, input);
    }

    #[tokio::test]
    async fn test_duplicate_registration() {
        let mut registry = PluginRegistry::new();

        let plugin1 = PluginBuilder::new("test-plugin").build();
        let plugin2 = PluginBuilder::new("test-plugin").build();

        registry.register(plugin1).await.unwrap();
        let result = registry.register(plugin2).await;

        assert!(matches!(result, Err(PluginError::AlreadyRegistered(_))));
    }

    #[tokio::test]
    async fn test_unregister_plugin() {
        let mut registry = PluginRegistry::new();

        let plugin = PluginBuilder::new("test-plugin")
            .action(Arc::new(TestAction))
            .build();

        registry.register(plugin).await.unwrap();
        assert_eq!(registry.plugin_count(), 1);

        registry.unregister("test-plugin").await.unwrap();
        assert_eq!(registry.plugin_count(), 0);
        assert_eq!(registry.action_count(), 0);
    }

    #[tokio::test]
    async fn test_dependency_check() {
        let mut registry = PluginRegistry::new();

        let plugin = PluginBuilder::new("child-plugin")
            .dependency("parent-plugin")
            .build();

        let result = registry.register(plugin).await;

        assert!(matches!(
            result,
            Err(PluginError::DependencyNotSatisfied { .. })
        ));
    }

    #[tokio::test]
    async fn test_disabled_plugin() {
        let mut registry = PluginRegistry::new();

        let plugin = PluginBuilder::new("test-plugin")
            .action(Arc::new(TestAction))
            .build();

        registry.register(plugin).await.unwrap();
        registry.disable_plugin("test-plugin").unwrap();

        let ctx = ActionContext::new("did:test:agent");
        let result = registry
            .execute_action("test_action", &ctx, serde_json::json!({}))
            .await;

        assert!(matches!(result, Err(PluginError::Disabled(_))));
    }
}
