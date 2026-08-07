mod client;
pub mod encryption;
mod engine;
pub mod manifest;
pub mod scheduler;
pub mod subscription;
pub mod types;

pub use client::SyncClient;
pub use encryption::{
  check_has_e2e_password, delete_e2e_password, set_e2e_password, verify_e2e_password,
};
pub use engine::{
  apply_default_profile_sync_mode, cancel_profile_sync, enable_extension_group_sync_if_needed,
  enable_group_sync_if_needed, enable_proxy_sync_if_needed, enable_regular_sync_everywhere,
  enable_sync_for_all_entities, enable_vpn_sync_if_needed, get_unsynced_entity_counts,
  is_group_in_use_by_synced_profile, is_group_used_by_synced_profile,
  is_proxy_in_use_by_synced_profile, is_proxy_used_by_synced_profile, is_sync_configured,
  is_vpn_in_use_by_synced_profile, is_vpn_used_by_synced_profile, request_profile_sync,
  rollover_encryption_for_all_entities, set_extension_group_sync_enabled,
  set_extension_sync_enabled, set_group_sync_enabled, set_profile_sync_mode,
  set_proxy_sync_enabled, set_regular_sync_default, set_vpn_sync_enabled, sync_profile,
  trigger_sync_for_profile, SyncEngine,
};
pub use manifest::{compute_diff, generate_manifest, HashCache, ManifestDiff, SyncManifest};
pub use scheduler::{get_global_scheduler, set_global_scheduler, SyncScheduler};
pub use subscription::{SubscriptionManager, SyncWorkItem};
pub use types::{SyncError, SyncResult};

static FALLBACK_SYNC_CLIENT_ID: std::sync::LazyLock<String> =
  std::sync::LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub(crate) fn sync_client_id() -> String {
  crate::settings_manager::SettingsManager::instance()
    .get_or_create_sync_device_identity()
    .map(|identity| identity.device_id)
    .unwrap_or_else(|error| {
      log::warn!("Failed to load persistent sync device ID: {error}");
      FALLBACK_SYNC_CLIENT_ID.clone()
    })
}

/// Queue a profile sync if the profile has sync enabled. No-op otherwise.
///
/// Called from profile metadata update paths so a rename / tag edit / proxy
/// reassignment shows up on other devices without waiting for the next
/// scheduled tick. Spawns the async queue call so this helper is callable
/// from both sync and async contexts.
pub fn queue_profile_sync_if_eligible(profile: &crate::profile::BrowserProfile) {
  if !profile.is_sync_enabled() {
    return;
  }
  let profile_id = profile.id.to_string();
  tauri::async_runtime::spawn(async move {
    if let Some(scheduler) = get_global_scheduler() {
      scheduler.queue_profile_sync(profile_id).await;
    }
  });
}
