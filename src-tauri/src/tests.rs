use super::*;

mod agent_configuration;
mod claude_code_live;
mod deepseek_harness_catalog;
mod deepseek_desktop;
mod agent_paths;
mod agent_state;
mod agent_transactions;
mod alias_delete;
mod alias_edit;
mod alias_edit_regressions;
mod alias_save;
mod app_settings;
mod app_update;
mod core_config;
mod core_runtime;
mod core_v8_contract;
mod desktop_alias_routing;
#[cfg(windows)]
mod file_replace;
mod instance_lock;
mod model_aliases;
mod platform;
mod provider_health;
mod support;
