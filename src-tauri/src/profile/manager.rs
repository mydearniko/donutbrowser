use crate::browser::{create_browser, BrowserType};
use crate::cloud_auth::CLOUD_AUTH;
use crate::downloaded_browsers_registry::DownloadedBrowsersRegistry;
use crate::events;
use crate::profile::types::{get_host_os, BrowserProfile, SyncMode};
use crate::proxy_manager::PROXY_MANAGER;
use crate::wayfern_manager::WayfernConfig;
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
use url::Url;

fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
  let tmp = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
    Some(ext) => format!("{ext}.tmp"),
    None => "tmp".to_string(),
  });
  {
    let mut f = fs::File::create(&tmp)?;
    use std::io::Write;
    f.write_all(data)?;
    f.sync_all()?;
  }
  fs::rename(&tmp, path)
}

pub struct ProfileManager {
  wayfern_manager: &'static crate::wayfern_manager::WayfernManager,
}

impl ProfileManager {
  fn new() -> Self {
    Self {
      wayfern_manager: crate::wayfern_manager::WayfernManager::instance(),
    }
  }

  pub fn instance() -> &'static ProfileManager {
    &PROFILE_MANAGER
  }

  pub fn get_profiles_dir(&self) -> PathBuf {
    crate::app_dirs::profiles_dir()
  }

  pub fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  fn normalize_launch_hook(
    launch_hook: Option<String>,
  ) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let Some(raw) = launch_hook else {
      return Ok(None);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
      return Ok(None);
    }

    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid launch hook URL: {e}"))?;
    match parsed.scheme() {
      "http" | "https" => Ok(Some(parsed.to_string())),
      _ => Err("Launch hook URL must use http or https".into()),
    }
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn create_profile_with_group(
    &self,
    app_handle: &tauri::AppHandle,
    name: &str,
    browser: &str,
    version: &str,
    release_type: &str,
    proxy_id: Option<String>,
    vpn_id: Option<String>,
    wayfern_config: Option<WayfernConfig>,
    group_id: Option<String>,
    ephemeral: bool,
    dns_blocklist: Option<String>,
    launch_hook: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    if name.trim().is_empty() {
      return Err(
        serde_json::json!({ "code": "NAME_CANNOT_BE_EMPTY" })
          .to_string()
          .into(),
      );
    }

    if proxy_id.is_some() && vpn_id.is_some() {
      return Err("Cannot set both proxy_id and vpn_id".into());
    }

    let launch_hook = Self::normalize_launch_hook(launch_hook)?;

    // Sync cloud proxy credentials if the profile uses a cloud or cloud-derived proxy
    if let Some(ref pid) = proxy_id {
      if PROXY_MANAGER.is_cloud_or_derived(pid) || pid == crate::proxy_manager::CLOUD_PROXY_ID {
        log::info!("Syncing cloud proxy credentials before profile creation");
        CLOUD_AUTH.sync_cloud_proxy().await;
      }
    }

    log::info!("Attempting to create profile: {name}");

    if browser == "camoufox" {
      return Err(
        serde_json::json!({ "code": "CAMOUFOX_REMOVED" })
          .to_string()
          .into(),
      );
    }

    // Check if a profile with this name already exists (case insensitive)
    let existing_profiles = self.list_profiles()?;
    if existing_profiles
      .iter()
      .any(|p| p.name.to_lowercase() == name.to_lowercase())
    {
      return Err(format!("Profile with name '{name}' already exists").into());
    }

    // Generate a new UUID for this profile
    let profile_id = uuid::Uuid::new_v4();
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile_id.to_string());
    let profile_data_dir = profile_uuid_dir.join("profile");
    let profile_file = profile_uuid_dir.join("metadata.json");

    // Create profile directory with UUID and profile subdirectory
    create_dir_all(&profile_uuid_dir)?;
    if !ephemeral {
      create_dir_all(&profile_data_dir)?;
    }

    // For Wayfern profiles, generate fingerprint during creation
    let final_wayfern_config = if browser == "wayfern" {
      let mut config = wayfern_config.unwrap_or_else(|| {
        log::info!("Creating default Wayfern config for profile: {name}");
        crate::wayfern_manager::WayfernConfig::default()
      });

      // Always ensure executable_path is set to the user's binary location
      // Pass upstream proxy information to config for fingerprint generation
      if let Some(proxy_id_ref) = &proxy_id {
        if let Some(proxy_settings) = PROXY_MANAGER.get_proxy_settings_by_id(proxy_id_ref) {
          let proxy_url = if let (Some(username), Some(password)) =
            (&proxy_settings.username, &proxy_settings.password)
          {
            format!(
              "{}://{}:{}@{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              username,
              password,
              proxy_settings.host,
              proxy_settings.port
            )
          } else {
            format!(
              "{}://{}:{}",
              proxy_settings.proxy_type.to_lowercase(),
              proxy_settings.host,
              proxy_settings.port
            )
          };
          config.proxy = Some(proxy_url);
          log::info!(
            "Using upstream proxy for Wayfern fingerprint generation: {}://{}:{}",
            proxy_settings.proxy_type.to_lowercase(),
            proxy_settings.host,
            proxy_settings.port
          );
        }
      }

      // Whether the fingerprint's location fields are known to match the
      // profile's routing. Provided fingerprints keep the old stamping
      // behavior; for generated ones this comes from the geolocation lookup.
      let mut geolocation_applied = true;

      // Generate fingerprint if not already provided
      if config.fingerprint.is_none() {
        log::info!("Generating fingerprint for Wayfern profile: {name}");

        // Create a temporary profile for fingerprint generation
        let temp_profile = BrowserProfile {
          id: uuid::Uuid::new_v4(),
          name: name.to_string(),
          browser: browser.to_string(),
          version: version.to_string(),
          proxy_id: proxy_id.clone(),
          vpn_id: None,
          launch_hook: launch_hook.clone(),
          process_id: None,
          last_launch: None,
          release_type: release_type.to_string(),
          wayfern_config: None,
          group_id: group_id.clone(),
          tags: Vec::new(),
          note: None,
          window_color: None,
          sync_mode: SyncMode::Disabled,
          encryption_salt: None,
          last_sync: None,
          host_os: None,
          ephemeral: false,
          extension_group_id: None,
          proxy_bypass_rules: Vec::new(),
          created_by_id: None,
          created_by_email: None,
          dns_blocklist: None,
          password_protected: false,
          created_at: None,
          updated_at: None,
        };

        match self
          .wayfern_manager
          .generate_fingerprint_config(app_handle, &temp_profile, &config)
          .await
        {
          Ok((generated_fingerprint, geo_applied)) => {
            config.fingerprint = Some(generated_fingerprint);
            geolocation_applied = geo_applied;
            log::info!("Successfully generated fingerprint for Wayfern profile: {name}");
          }
          Err(e) => {
            return Err(
              format!("Failed to generate fingerprint for Wayfern profile '{name}': {e}").into(),
            );
          }
        }
      } else {
        log::info!("Using provided fingerprint for Wayfern profile: {name}");
      }

      // Record which proxy/geoip the fingerprint's location data was computed
      // for. On launch this is compared against the profile's current routing
      // so a proxy that was changed after creation triggers a location refresh
      // instead of showing a stale timezone. Only stamped when geolocation
      // actually succeeded: on failure the fingerprint carries the HOST
      // timezone/locale, and a stamped signature would match at launch and
      // suppress the refresh that repairs it — latching the leak permanently.
      let routing_signature = crate::wayfern_manager::WayfernManager::geo_signature(
        proxy_id
          .as_ref()
          .and_then(|id| PROXY_MANAGER.get_proxy_settings_by_id(id))
          .as_ref(),
        None,
        config.geoip.as_ref(),
      );
      config.geo_proxy_signature = if geolocation_applied {
        Some(routing_signature.clone())
      } else {
        if !matches!(config.geoip.as_ref(), Some(serde_json::Value::Bool(false))) {
          log::warn!(
            "Geolocation could not be applied for Wayfern profile {name}; leaving geo signature unset so the next launch refreshes location through the profile's proxy"
          );
        }
        None
      };

      // This fingerprint has never been exposed by a browser session, so it
      // is already the correct first value for randomize-on-launch. Mark it as
      // prepared instead of booting a second hidden browser immediately on the
      // profile's first launch. It is consumed once and the launch path then
      // prepares the following session's independent fingerprint in the
      // background.
      if config.randomize_fingerprint_on_launch == Some(true) {
        let location_is_ready = geolocation_applied
          || matches!(config.geoip.as_ref(), Some(serde_json::Value::Bool(false)));
        if let Some(fingerprint) = config.fingerprint.clone().filter(|_| location_is_ready) {
          config.prepared_fingerprint = Some(fingerprint);
          config.prepared_fingerprint_signature = Some(
            crate::browser_runner::BrowserRunner::fingerprint_preparation_signature(
              &config,
              &routing_signature,
            ),
          );
        }
      }

      // Clear the proxy from config after fingerprint generation
      config.proxy = None;

      Some(config)
    } else {
      wayfern_config.clone()
    };

    let mut profile = BrowserProfile {
      id: profile_id,
      name: name.to_string(),
      browser: browser.to_string(),
      version: version.to_string(),
      proxy_id: proxy_id.clone(),
      vpn_id: vpn_id.clone(),
      launch_hook,
      process_id: None,
      last_launch: None,
      release_type: release_type.to_string(),
      wayfern_config: final_wayfern_config,
      group_id: group_id.clone(),
      tags: Vec::new(),
      note: None,
      // A random-looking pastel derived from the (random) profile id, so every
      // new profile gets a distinct, stable window color it can later override.
      window_color: Some(crate::wayfern_manager::derive_profile_color(&profile_id)),
      sync_mode: SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: Some(get_host_os()),
      ephemeral,
      extension_group_id: None,
      proxy_bypass_rules: Vec::new(),
      created_by_id: None,
      created_by_email: None,
      dns_blocklist,
      password_protected: false,
      created_at: Some(
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs())
          .unwrap_or(0),
      ),
      updated_at: Some(crate::proxy_manager::now_secs()),
    };

    // Save profile info
    self.save_profile(&profile)?;

    // Verify the profile was saved correctly
    if !profile_file.exists() {
      return Err(format!("Failed to create profile file for '{name}'").into());
    }

    crate::sync::apply_default_profile_sync_mode(app_handle, &mut profile).await;

    log::info!("Profile '{name}' created successfully with ID: {profile_id}");

    // Emit profile creation event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn save_profile(&self, profile: &BrowserProfile) -> Result<(), Box<dyn std::error::Error>> {
    self.save_profile_metadata(profile)?;

    // Update tag suggestions after any save
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    Ok(())
  }

  fn save_profile_metadata(
    &self,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
    let profile_file = profile_uuid_dir.join("metadata.json");

    // Ensure the UUID directory exists
    create_dir_all(&profile_uuid_dir)?;

    let json = serde_json::to_string_pretty(profile)?;
    atomic_write(&profile_file, json.as_bytes())?;
    Ok(())
  }

  pub(crate) fn save_runtime_profile(
    &self,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error>> {
    self.save_profile_metadata(profile)
  }

  pub fn list_profiles(&self) -> Result<Vec<BrowserProfile>, Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    if !profiles_dir.exists() {
      return Ok(vec![]);
    }

    let mut profiles = Vec::new();
    for entry in fs::read_dir(profiles_dir)? {
      let entry = entry?;
      let path = entry.path();

      // Look for UUID directories containing metadata.json
      if path.is_dir() {
        let metadata_file = path.join("metadata.json");
        if metadata_file.exists() {
          let content = match fs::read_to_string(&metadata_file) {
            Ok(c) => c,
            Err(e) => {
              log::warn!(
                "Skipping profile at {}: failed to read metadata.json: {e}",
                path.display()
              );
              continue;
            }
          };
          let mut profile: BrowserProfile = match serde_json::from_str(&content) {
            Ok(p) => p,
            Err(e) => {
              log::warn!(
                "Skipping profile at {}: invalid metadata.json: {e}",
                path.display()
              );
              continue;
            }
          };

          // Backfill host_os from browser config for profiles created before
          // the field existed (or synced without it).
          if profile.host_os.is_none() {
            let inferred_os = profile.resolved_os().map(str::to_string);
            if let Some(os) = inferred_os {
              profile.host_os = Some(os);
              if let Ok(json) = serde_json::to_string_pretty(&profile) {
                let _ = atomic_write(&metadata_file, json.as_bytes());
              }
            }
          }

          profiles.push(profile);
        }
      }
    }

    Ok(profiles)
  }

  pub fn get_profile_by_id(
    &self,
    profile_id: uuid::Uuid,
  ) -> Result<Option<BrowserProfile>, Box<dyn std::error::Error>> {
    let metadata_file = self
      .get_profiles_dir()
      .join(profile_id.to_string())
      .join("metadata.json");
    if !metadata_file.is_file() {
      return Ok(None);
    }
    let content = fs::read_to_string(&metadata_file)?;
    let mut profile: BrowserProfile = serde_json::from_str(&content)?;
    if profile.host_os.is_none() {
      if let Some(os) = profile.resolved_os().map(str::to_string) {
        profile.host_os = Some(os);
        let json = serde_json::to_string_pretty(&profile)?;
        atomic_write(&metadata_file, json.as_bytes())?;
      }
    }
    Ok(Some(profile))
  }

  pub fn rename_profile(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    new_name: &str,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    if new_name.trim().is_empty() {
      return Err(
        serde_json::json!({ "code": "NAME_CANNOT_BE_EMPTY" })
          .to_string()
          .into(),
      );
    }

    // Check if new name already exists (case insensitive)
    let existing_profiles = self.list_profiles()?;
    if existing_profiles
      .iter()
      .any(|p| p.name.to_lowercase() == new_name.to_lowercase())
    {
      return Err(format!("Profile with name '{new_name}' already exists").into());
    }

    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let mut profile = existing_profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Update profile name (no need to move directories since we use UUID)
    profile.name = new_name.to_string();
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    // Save profile with new name
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Keep tag suggestions up to date after name change (rebuild from all profiles)
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    // Emit profile rename event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn delete_profile(
    &self,
    app_handle: &tauri::AppHandle,
    profile_id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    log::info!("Attempting to delete profile with ID: {profile_id}");

    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Check if browser is running (cross-OS profiles can't be running locally)
    if profile.process_id.is_some() && !profile.is_cross_os() {
      return Err(
        "Cannot delete profile while browser is running. Please stop the browser first.".into(),
      );
    }

    // Remember sync mode before deleting local files
    let was_sync_enabled = profile.is_sync_enabled();

    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());

    // Move the profile into the trash (compressed) instead of deleting it.
    // The original directory is removed once it has been archived.
    if profile_uuid_dir.exists() {
      crate::profile::trash::trash_profile(&profile_uuid_dir, &profile)?;
      fs::remove_dir_all(&profile_uuid_dir)?;
      if profile_uuid_dir.exists() {
        return Err(format!("Failed to completely delete profile '{}'", profile.name).into());
      }
    }

    log::info!(
      "Profile '{}' (ID: {}) moved to trash",
      profile.name,
      profile_id
    );

    // If sync was enabled, also delete from S3
    if was_sync_enabled {
      let profile_id_owned = profile_id.to_string();
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        match crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          Ok(engine) => {
            if let Err(e) = engine.delete_profile(&profile_id_owned).await {
              log::warn!(
                "Failed to delete profile {} from sync: {}",
                profile_id_owned,
                e
              );
            } else {
              log::info!("Profile {} deleted from S3 sync storage", profile_id_owned);
            }
          }
          Err(e) => {
            log::debug!("Sync not configured, skipping remote deletion: {}", e);
          }
        }
      });
    }

    // Rebuild tag suggestions after deletion
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    // Always perform cleanup after profile deletion to remove unused binaries
    if let Err(e) = DownloadedBrowsersRegistry::instance().cleanup_unused_binaries() {
      log::warn!("Warning: Failed to cleanup unused binaries after profile deletion: {e}");
    }

    // Emit profile deletion event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }
    let _ = events::emit_empty(crate::profile::trash::TRASH_EVENT);

    Ok(())
  }

  /// Delete a profile from the local filesystem only, without triggering remote sync deletion.
  /// Used when a profile was deleted on another device and the local copy should be cleaned up.
  pub fn delete_profile_local_only(
    &self,
    profile_id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_dir = profiles_dir.join(profile_id);
    if profile_dir.exists() {
      // Also recoverable: tombstone deletes compress into the trash too, so
      // a profile removed on another device can still be restored here.
      let profile_uuid = uuid::Uuid::parse_str(profile_id).unwrap_or_default();
      if let Ok(Some(profile)) = self.get_profile_by_id(profile_uuid) {
        if let Err(e) = crate::profile::trash::trash_profile(&profile_dir, &profile) {
          log::warn!("Failed to trash tombstoned profile {profile_id}: {e}");
        }
      }
      fs::remove_dir_all(&profile_dir)?;
      log::info!("Deleted local profile {} (tombstoned remotely)", profile_id);
    }

    if let Err(e) = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance()
      .cleanup_unused_binaries()
    {
      log::warn!("Failed to cleanup binaries after tombstone deletion: {e}");
    }

    let _ = crate::events::emit_empty("profiles-changed");
    let _ = crate::events::emit_empty(crate::profile::trash::TRASH_EVENT);
    Ok(())
  }

  pub fn update_profile_version(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    version: &str,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Check if the browser is currently running
    if profile.process_id.is_some() {
      return Err(
        "Cannot update version while browser is running. Please stop the browser first.".into(),
      );
    }

    // Verify the new version is downloaded
    let browser_type = BrowserType::from_str(&profile.browser)
      .map_err(|_| format!("Invalid browser type: {}", profile.browser))?;
    let browser = create_browser(browser_type.clone());
    let binaries_dir = self.get_binaries_dir();

    if !browser.is_version_downloaded(version, &binaries_dir) {
      return Err(format!("Browser version {version} is not downloaded").into());
    }

    // Update version
    profile.version = version.to_string();

    profile.release_type = "stable".to_string();

    // Save the updated profile
    self.save_profile(&profile)?;

    // Emit profile update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn assign_profiles_to_group(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_ids: Vec<String>,
    group_id: Option<String>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;

    for profile_id in profile_ids {
      let profile_uuid = uuid::Uuid::parse_str(&profile_id)
        .map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
      let mut profile = profiles
        .iter()
        .find(|p| p.id == profile_uuid)
        .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?
        .clone();

      // Check if browser is running
      if profile.process_id.is_some() {
        return Err(format!(
          "Cannot modify group for profile '{}' while browser is running. Please stop the browser first.", profile.name
        ).into());
      }

      profile.group_id = group_id.clone();
      profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));
      self.save_profile(&profile)?;

      crate::sync::queue_profile_sync_if_eligible(&profile);

      // Auto-enable sync for new group if profile has sync enabled
      if profile.is_sync_enabled() {
        if let Some(ref new_group_id) = group_id {
          let group_id_clone = new_group_id.clone();
          tauri::async_runtime::spawn(async move {
            let _ = crate::sync::enable_group_sync_if_needed(&group_id_clone).await;
            if let Some(scheduler) = crate::sync::get_global_scheduler() {
              scheduler.queue_group_sync(group_id_clone).await;
            }
          });
        }
      }
    }

    // Rebuild tag suggestions after group changes just in case
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    // Emit profile group assignment event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  pub fn update_profile_tags(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    tags: Vec<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<String> = Vec::with_capacity(tags.len());
    for t in tags.into_iter() {
      if seen.insert(t.clone()) {
        deduped.push(t);
      }
    }
    profile.tags = deduped;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    // Save profile
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Update global tag suggestions from all profiles
    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|tm| {
      let _ = tm.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    // Emit profile tags update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_note(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    note: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    // Find the profile by ID
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Update note (trim whitespace, set to None if empty)
    profile.note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    // Save profile
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Emit profile note update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_window_color(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    window_color: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    // Normalize to lowercase #RRGGBB, or clear (None) for an invalid/empty value
    // so it reverts to the auto id-derived color at next launch.
    profile.window_color = window_color.and_then(|c| {
      let hex = c.trim().trim_start_matches('#');
      (hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_lowercase()))
    });
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    self.save_profile(&profile)?;
    crate::sync::queue_profile_sync_if_eligible(&profile);
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_launch_hook(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    launch_hook: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.launch_hook = Self::normalize_launch_hook(launch_hook)?;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_proxy_bypass_rules(
    &self,
    _app_handle: &tauri::AppHandle,
    profile_id: &str,
    rules: Vec<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.proxy_bypass_rules = rules;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn update_profile_dns_blocklist(
    &self,
    profile_id: &str,
    dns_blocklist: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.dns_blocklist = dns_blocklist;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub fn delete_multiple_profiles(
    &self,
    app_handle: &tauri::AppHandle,
    profile_ids: Vec<String>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;
    let mut sync_enabled_ids: Vec<String> = Vec::new();

    for profile_id in profile_ids {
      let profile_uuid = uuid::Uuid::parse_str(&profile_id)
        .map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
      let profile = profiles
        .iter()
        .find(|p| p.id == profile_uuid)
        .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

      // Check if browser is running (cross-OS profiles can't be running locally)
      if profile.process_id.is_some() && !profile.is_cross_os() {
        return Err(
          format!(
            "Cannot delete profile '{}' while browser is running. Please stop the browser first.",
            profile.name
          )
          .into(),
        );
      }

      // Track sync-enabled profiles for remote deletion
      if profile.is_sync_enabled() {
        sync_enabled_ids.push(profile_id.clone());
      }

      // Move the profile into the trash (compressed) instead of deleting it
      let profiles_dir = self.get_profiles_dir();
      let profile_uuid_dir = profiles_dir.join(profile.id.to_string());

      if profile_uuid_dir.exists() {
        crate::profile::trash::trash_profile(&profile_uuid_dir, profile)?;
        std::fs::remove_dir_all(&profile_uuid_dir)?;
      }
    }

    // Delete sync-enabled profiles from S3
    if !sync_enabled_ids.is_empty() {
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        if let Ok(engine) = crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          for profile_id in sync_enabled_ids {
            if let Err(e) = engine.delete_profile(&profile_id).await {
              log::warn!("Failed to delete profile {} from sync: {}", profile_id, e);
            }
          }
        }
      });
    }

    // Emit profile deletion event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }
    let _ = events::emit_empty(crate::profile::trash::TRASH_EVENT);

    Ok(())
  }

  fn generate_clone_name(&self, original_name: &str) -> Result<String, Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;
    let existing_names: std::collections::HashSet<String> =
      profiles.iter().map(|p| p.name.clone()).collect();

    let candidate = format!("{original_name} (Copy)");
    if !existing_names.contains(&candidate) {
      return Ok(candidate);
    }

    for i in 2.. {
      let candidate = format!("{original_name} (Copy {i})");
      if !existing_names.contains(&candidate) {
        return Ok(candidate);
      }
    }

    unreachable!()
  }

  pub fn clone_profile(
    &self,
    profile_id: &str,
    custom_name: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let source = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    if source.process_id.is_some() {
      return Err(
        "Cannot clone profile while browser is running. Please stop the browser first.".into(),
      );
    }

    let new_id = uuid::Uuid::new_v4();
    let clone_name = match custom_name {
      Some(name) if !name.trim().is_empty() => name.trim().to_string(),
      _ => self.generate_clone_name(&source.name)?,
    };

    let profiles_dir = self.get_profiles_dir();
    let source_dir = profiles_dir.join(source.id.to_string());
    let dest_dir = profiles_dir.join(new_id.to_string());

    if source_dir.exists() {
      crate::profile_importer::ProfileImporter::copy_directory_recursive(&source_dir, &dest_dir)?;
    } else {
      fs::create_dir_all(&dest_dir)?;
    }

    let mut new_profile = BrowserProfile {
      id: new_id,
      name: clone_name,
      browser: source.browser,
      version: source.version,
      proxy_id: source.proxy_id,
      vpn_id: source.vpn_id,
      launch_hook: source.launch_hook,
      process_id: None,
      last_launch: None,
      release_type: source.release_type,
      wayfern_config: source.wayfern_config,
      group_id: source.group_id,
      tags: source.tags,
      note: source.note,
      window_color: source.window_color,
      sync_mode: SyncMode::Disabled,
      encryption_salt: None,
      last_sync: None,
      host_os: Some(get_host_os()),
      ephemeral: false,
      extension_group_id: source.extension_group_id,
      proxy_bypass_rules: source.proxy_bypass_rules,
      created_by_id: None,
      created_by_email: None,
      dns_blocklist: source.dns_blocklist,
      password_protected: false,
      created_at: Some(
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_secs())
          .unwrap_or(0),
      ),
      updated_at: Some(crate::proxy_manager::now_secs()),
    };

    // Donut: a clone must NOT be linkable to its source. The source
    // wayfern_config embeds the persisted fingerprint JSON (including the
    // canvas_noise_seed), so copying it verbatim makes the clone emit
    // BYTE-IDENTICAL canvas/WebGL/audio readback hashes and identical device
    // signals as the source — trivially linkable if both run concurrently. Clear
    // the fingerprint so the launch path mints a fresh one (a new
    // canvas_noise_seed via RandBytes + an independent device fingerprint),
    // exactly as create_profile does when fingerprint.is_none(). NOTE: the
    // user-data-dir copy above still duplicates cookies/localStorage/TLS state —
    // a separate storage-linkage vector the user must clear if they want full
    // isolation between a clone and its source.
    if let Some(cfg) = new_profile.wayfern_config.as_mut() {
      cfg.fingerprint = None;
      cfg.prepared_fingerprint = None;
      cfg.prepared_fingerprint_signature = None;
    }

    self.save_profile(&new_profile)?;

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(new_profile)
  }

  pub async fn update_wayfern_config(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: &str,
    config: WayfernConfig,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Find the profile by ID
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Check if the browser is currently running using the comprehensive status check
    let is_running = self
      .check_browser_status(app_handle.clone(), &profile)
      .await?;

    if is_running {
      return Err(
        "Cannot update Wayfern configuration while browser is running. Please stop the browser first.".into(),
      );
    }

    // Update the Wayfern configuration
    profile.wayfern_config = Some(config);

    // Save the updated profile
    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    log::info!(
      "Wayfern configuration updated for profile '{}' (ID: {}).",
      profile.name,
      profile_id
    );

    // Emit profile config update event
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(())
  }

  pub async fn update_profile_proxy(
    &self,
    _app_handle: tauri::AppHandle,
    profile_id: &str,
    proxy_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    // Find the profile by ID
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;

    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Remember old proxy_id for cleanup (not used yet, but may be needed for cleanup)
    let _old_proxy_id = profile.proxy_id.clone();

    // Update proxy settings and clear VPN (mutual exclusion)
    profile.proxy_id = proxy_id.clone();
    profile.vpn_id = None;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    // Save the updated profile
    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for new proxy if profile has sync enabled
    if profile.is_sync_enabled() {
      if let Some(ref new_proxy_id) = proxy_id {
        let _ = crate::sync::enable_proxy_sync_if_needed(new_proxy_id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_proxy_sync(new_proxy_id.clone()).await;
        }
      }
    }

    // Emit profile update event so frontend UIs can refresh immediately (e.g. proxy manager)
    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    // Emit general profiles changed event for profile list updates
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  /// Assign one proxy, one VPN, or a direct connection to many profiles in a
  /// single metadata pass. The previous frontend loop re-read every profile
  /// directory and emitted multiple events per row, which became painfully
  /// slow for large selections.
  pub async fn assign_profiles_network(
    &self,
    profile_ids: Vec<String>,
    proxy_id: Option<String>,
    vpn_id: Option<String>,
  ) -> Result<usize, String> {
    if proxy_id.is_some() && vpn_id.is_some() {
      return Err(
        serde_json::json!({
          "code": "INTERNAL_ERROR",
          "params": { "detail": "proxy_id and vpn_id are mutually exclusive" }
        })
        .to_string(),
      );
    }

    if let Some(ref id) = proxy_id {
      if crate::proxy_manager::PROXY_MANAGER
        .get_proxy_settings_by_id(id)
        .is_none()
      {
        return Err(serde_json::json!({ "code": "PROXY_NOT_FOUND" }).to_string());
      }
    }

    if let Some(ref id) = vpn_id {
      let storage = crate::vpn::VPN_STORAGE.lock().map_err(|error| {
        serde_json::json!({
          "code": "INTERNAL_ERROR",
          "params": { "detail": error.to_string() }
        })
        .to_string()
      })?;
      if storage.load_config(id).is_err() {
        return Err(serde_json::json!({ "code": "VPN_NOT_FOUND" }).to_string());
      }
    }

    let profiles = self.list_profiles().map_err(|error| {
      serde_json::json!({
        "code": "INTERNAL_ERROR",
        "params": { "detail": error.to_string() }
      })
      .to_string()
    })?;
    let profiles_by_id: std::collections::HashMap<uuid::Uuid, BrowserProfile> = profiles
      .into_iter()
      .map(|profile| (profile.id, profile))
      .collect();
    let mut requested_ids = Vec::with_capacity(profile_ids.len());
    let mut seen = std::collections::HashSet::new();

    for profile_id in profile_ids {
      let id = uuid::Uuid::parse_str(&profile_id)
        .map_err(|_| serde_json::json!({ "code": "INVALID_PROFILE_ID" }).to_string())?;
      if !profiles_by_id.contains_key(&id) {
        return Err(serde_json::json!({ "code": "PROFILE_NOT_FOUND" }).to_string());
      }
      if seen.insert(id) {
        requested_ids.push(id);
      }
    }

    let mut updated_profiles = Vec::with_capacity(requested_ids.len());
    for id in requested_ids {
      let mut profile = profiles_by_id[&id].clone();
      if profile.proxy_id == proxy_id && profile.vpn_id == vpn_id {
        continue;
      }
      profile.proxy_id = proxy_id.clone();
      profile.vpn_id = vpn_id.clone();
      profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));
      self.save_profile_metadata(&profile).map_err(|error| {
        serde_json::json!({
          "code": "INTERNAL_ERROR",
          "params": { "detail": error.to_string() }
        })
        .to_string()
      })?;
      crate::sync::queue_profile_sync_if_eligible(&profile);
      updated_profiles.push(profile);
    }

    if updated_profiles.is_empty() {
      return Ok(0);
    }

    let _ = crate::tag_manager::TAG_MANAGER.lock().map(|manager| {
      let _ = manager.rebuild_from_profiles(&self.list_profiles().unwrap_or_default());
    });

    if updated_profiles
      .iter()
      .any(|profile| profile.is_sync_enabled())
    {
      if let Some(ref id) = proxy_id {
        let _ = crate::sync::enable_proxy_sync_if_needed(id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_proxy_sync(id.clone()).await;
        }
      }
      if let Some(ref id) = vpn_id {
        let _ = crate::sync::enable_vpn_sync_if_needed(id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_vpn_sync(id.clone()).await;
        }
      }
    }

    if let Err(error) = events::emit_empty("profiles-changed") {
      log::warn!("Failed to emit profiles-changed after network assignment: {error}");
    }

    Ok(updated_profiles.len())
  }

  pub async fn update_profile_vpn(
    &self,
    _app_handle: tauri::AppHandle,
    profile_id: &str,
    vpn_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    let profile_uuid = uuid::Uuid::parse_str(profile_id).map_err(
      |_| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Invalid profile ID: {profile_id}").into()
      },
    )?;
    let profiles =
      self
        .list_profiles()
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to list profiles: {e}").into()
        })?;

    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Profile with ID '{profile_id}' not found").into()
      })?;

    // Update VPN and clear proxy (mutual exclusion)
    profile.vpn_id = vpn_id.clone();
    profile.proxy_id = None;
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));

    self
      .save_profile(&profile)
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        format!("Failed to save profile: {e}").into()
      })?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for the new VPN if profile has sync enabled.
    if profile.is_sync_enabled() {
      if let Some(ref new_vpn_id) = vpn_id {
        let _ = crate::sync::enable_vpn_sync_if_needed(new_vpn_id).await;
        if let Some(scheduler) = crate::sync::get_global_scheduler() {
          scheduler.queue_vpn_sync(new_vpn_id.clone()).await;
        }
      }
    }

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Warning: Failed to emit profile update event: {e}");
    }

    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Warning: Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  /// Unlink every profile currently assigned to `proxy_id`, falling back to
  /// direct routing. Bumps each affected profile's `updated_at` so the new
  /// (direct) routing wins under sync last-write-wins, persists it, and
  /// queues a profile sync for synced profiles. Returns the number of
  /// profiles that referenced the proxy, or an error if the profile list or
  /// any metadata write failed.
  pub fn unlink_proxy_from_profiles(
    &self,
    proxy_id: &str,
  ) -> Result<usize, Box<dyn std::error::Error>> {
    let profiles = self.list_profiles()?;
    let mut unlinked = 0;
    for mut profile in profiles {
      if profile.proxy_id.as_deref() != Some(proxy_id) {
        continue;
      }
      profile.proxy_id = None;
      profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));
      self.save_profile_metadata(&profile)?;
      crate::sync::queue_profile_sync_if_eligible(&profile);
      unlinked += 1;
    }
    Ok(unlinked)
  }

  pub fn update_profile_extension_group(
    &self,
    profile_id: &str,
    extension_group_id: Option<String>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
    let profile_uuid =
      uuid::Uuid::parse_str(profile_id).map_err(|_| format!("Invalid profile ID: {profile_id}"))?;
    let profiles = self.list_profiles()?;
    let mut profile = profiles
      .into_iter()
      .find(|p| p.id == profile_uuid)
      .ok_or_else(|| format!("Profile with ID '{profile_id}' not found"))?;

    profile.extension_group_id = extension_group_id.clone();
    profile.updated_at = Some(crate::proxy_manager::next_updated_at(profile.updated_at));
    self.save_profile(&profile)?;

    crate::sync::queue_profile_sync_if_eligible(&profile);

    // Auto-enable sync for the new extension group if profile has sync
    // enabled. The helper is sync internally; we fire-and-forget through
    // the async runtime so any I/O doesn't block this caller.
    if profile.is_sync_enabled() {
      if let Some(new_group_id) = extension_group_id {
        tauri::async_runtime::spawn(async move {
          let _ = crate::sync::enable_extension_group_sync_if_needed(&new_group_id).await;
          if let Some(scheduler) = crate::sync::get_global_scheduler() {
            scheduler.queue_extension_group_sync(new_group_id).await;
          }
        });
      }
    }

    if let Err(e) = events::emit("profile-updated", &profile) {
      log::warn!("Failed to emit profile update event: {e}");
    }
    if let Err(e) = events::emit_empty("profiles-changed") {
      log::warn!("Failed to emit profiles-changed event: {e}");
    }

    Ok(profile)
  }

  pub async fn check_browser_status(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    self
      .check_browser_status_inner(app_handle, profile, false)
      .await
  }

  pub(crate) async fn check_browser_status_with_lifecycle_lock(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    self
      .check_browser_status_inner(app_handle, profile, true)
      .await
  }

  async fn check_browser_status_inner(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    lifecycle_lock_held: bool,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    // Handle Wayfern profiles using WayfernManager-based status checking
    if profile.browser == "wayfern" {
      return self
        .check_wayfern_status(&app_handle, profile, lifecycle_lock_held)
        .await;
    }

    // For non-wayfern browsers, use the existing PID-based logic
    let inner_profile = profile.clone();
    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );
    let mut is_running = false;
    let mut found_pid: Option<u32> = None;

    // First check if the stored PID is still valid
    if let Some(pid) = profile.process_id {
      if let Some(process) = system.process(Pid::from(pid as usize)) {
        let cmd = process.cmd();
        // Verify this process is actually our browser with the correct profile
        let profiles_dir = self.get_profiles_dir();
        let profile_data_path = profile.get_profile_data_path(&profiles_dir);
        let profile_data_path_str = profile_data_path.to_string_lossy();
        let profile_path_match = cmd.iter().any(|s| {
          let arg = s.to_str().unwrap_or("");
          // Match the Chromium --user-data-dir flag or an exact profile path argument
          arg.contains(&format!("--user-data-dir={profile_data_path_str}"))
            || arg == profile_data_path_str
        });

        if profile_path_match {
          is_running = true;
          found_pid = Some(pid);
        }
      }
    }

    // If we didn't find the browser with the stored PID, search all processes
    if !is_running {
      for (pid, process) in system.processes() {
        let cmd = process.cmd();
        if cmd.len() >= 2 {
          // Check if this is the right browser executable first
          let exe_name = process.name().to_string_lossy().to_lowercase();
          let is_correct_browser = match profile.browser.as_str() {
            "wayfern" => {
              exe_name.contains("wayfern")
                || exe_name.contains("chromium")
                || exe_name.contains("chrome")
            }
            _ => false,
          };

          if !is_correct_browser {
            continue;
          }

          // Check for profile path match
          let profiles_dir = self.get_profiles_dir();
          let profile_data_path = profile.get_profile_data_path(&profiles_dir);
          let profile_data_path_str = profile_data_path.to_string_lossy();
          let profile_path_match = cmd.iter().any(|s| {
            let arg = s.to_str().unwrap_or("");
            // Match the Chromium --user-data-dir flag or an exact profile path argument
            arg.contains(&format!("--user-data-dir={profile_data_path_str}"))
              || arg == profile_data_path_str
          });

          if profile_path_match {
            // Found a matching process
            found_pid = Some(pid.as_u32());
            is_running = true;
            log::info!(
              "Found browser process with PID: {} for profile: {}",
              pid.as_u32(),
              profile.name
            );
            break;
          }
        }
      }
    }

    // Only persist status changes if the profile metadata still exists on disk
    let profiles_dir = self.get_profiles_dir();
    let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
    let metadata_file = profile_uuid_dir.join("metadata.json");
    let metadata_exists = metadata_file.exists();

    if metadata_exists {
      // Load the latest profile from disk to avoid overwriting fields like proxy_id
      let latest_profile: BrowserProfile = match std::fs::read_to_string(&metadata_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
      {
        Some(p) => p,
        None => inner_profile.clone(),
      };

      let mut merged = latest_profile.clone();
      let mut detected_stop = false;

      if let Some(pid) = found_pid {
        if merged.process_id != Some(pid) {
          let old_pid = merged.process_id;
          merged.process_id = Some(pid);
          if let Err(e) = self.save_profile(&merged) {
            log::warn!("Warning: Failed to update profile with new PID: {e}");
          }
          if let Some(prev) = old_pid {
            let _ = crate::proxy_manager::PROXY_MANAGER.update_proxy_pid(prev, pid);
          }
        }
      } else if merged.process_id.is_some() {
        // Clear the PID if no process found
        merged.process_id = None;
        if let Err(e) = self.save_profile(&merged) {
          log::warn!("Warning: Failed to clear profile PID: {e}");
        }
        detected_stop = true;
      }

      if detected_stop {
        if let Some(updated) = crate::auto_updater::AutoUpdater::instance()
          .update_profile_to_latest_installed(&app_handle, &merged)
        {
          merged = updated;
        }
      }

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &merged) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }
    }

    Ok(is_running)
  }

  // Check Wayfern status using WayfernManager
  async fn check_wayfern_status(
    &self,
    app_handle: &tauri::AppHandle,
    profile: &BrowserProfile,
    lifecycle_lock_held: bool,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let manager = self.wayfern_manager;
    let profiles_dir = self.get_profiles_dir();
    let profile_data_path =
      crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
    let profile_path_str = profile_data_path.to_string_lossy();

    // A successful launch persists its PID before releasing the lifecycle
    // lock. With no persisted PID there cannot be a recovered browser from a
    // previous GUI process, so avoid an expensive all-process command-line
    // scan on the normal closed-profile launch path.
    if profile.process_id.is_none() {
      if profile.ephemeral {
        crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
      }
      return Ok(false);
    }

    // Check if there's a running Wayfern instance for this profile
    match manager.find_wayfern_by_profile(&profile_path_str).await {
      Some(wayfern_process) => {
        // Found a running instance, update profile with process info if changed
        let profiles_dir = self.get_profiles_dir();
        let profile_uuid_dir = profiles_dir.join(profile.id.to_string());
        let metadata_file = profile_uuid_dir.join("metadata.json");
        let metadata_exists = metadata_file.exists();

        if metadata_exists {
          // Load latest to avoid overwriting other fields
          let mut latest: BrowserProfile = match std::fs::read_to_string(&metadata_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
          {
            Some(p) => p,
            None => profile.clone(),
          };

          if latest.process_id != wayfern_process.processId {
            let old_pid = latest.process_id;
            latest.process_id = wayfern_process.processId;
            if let Err(e) = self.save_runtime_profile(&latest) {
              log::warn!("Warning: Failed to update Wayfern profile with process info: {e}");
            }
            if let (Some(prev), Some(new)) = (old_pid, wayfern_process.processId) {
              let _ = crate::proxy_manager::PROXY_MANAGER.update_proxy_pid(prev, new);
            }

            // Emit profile update event to frontend
            if let Err(e) = events::emit("profile-updated", &latest) {
              log::warn!("Warning: Failed to emit profile update event: {e}");
            }

            log::info!(
              "Wayfern process has started for profile '{}' with PID: {:?}",
              profile.name,
              wayfern_process.processId
            );
          }
        }
        Ok(true)
      }
      None => {
        // The child-process watcher normally reaches this shared finalizer
        // immediately. This path is also the recovery fallback for a browser
        // found through a process scan after the Donut GUI was restarted.
        if let Some(pid) = profile.process_id {
          let runner = crate::browser_runner::BrowserRunner::instance();
          if lifecycle_lock_held {
            runner
              .handle_natural_browser_exit_with_lifecycle_lock(app_handle.clone(), profile.id, pid)
              .await;
          } else {
            runner
              .handle_natural_browser_exit(app_handle.clone(), profile.id, pid)
              .await;
          }
        } else if profile.ephemeral {
          crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
        }
        Ok(false)
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  use tempfile::TempDir;

  fn create_test_profile_manager() -> (&'static ProfileManager, TempDir) {
    let temp_dir = TempDir::new().unwrap();

    // Mock the base directories by setting environment variables
    unsafe {
      std::env::set_var("HOME", temp_dir.path());
    }

    let profile_manager = ProfileManager::instance();
    (profile_manager, temp_dir)
  }

  #[test]
  fn test_profile_manager_creation() {
    let (_manager, _temp_dir) = create_test_profile_manager();
    // If we get here without panicking, the test passes
  }

  #[test]
  fn test_get_profiles_dir() {
    let (manager, _temp_dir) = create_test_profile_manager();
    let profiles_dir = manager.get_profiles_dir();

    assert!(
      profiles_dir.to_string_lossy().contains("DonutBrowser"),
      "Profiles dir should contain DonutBrowser"
    );
    assert!(
      profiles_dir.to_string_lossy().contains("profiles"),
      "Profiles dir should contain profiles"
    );
  }

  #[test]
  fn test_get_binaries_dir() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let binaries_dir = manager.get_binaries_dir();
    let path_str = binaries_dir.to_string_lossy();

    assert!(
      path_str.contains("DonutBrowser"),
      "Binaries dir should contain DonutBrowser"
    );
    assert!(
      path_str.contains("binaries"),
      "Binaries dir should contain binaries"
    );
  }

  #[test]
  fn test_normalize_launch_hook_accepts_http_and_https() {
    let http =
      ProfileManager::normalize_launch_hook(Some(" http://localhost:3000/hook ".to_string()))
        .unwrap();
    let https = ProfileManager::normalize_launch_hook(Some(
      "https://example.com/hooks/profile-launch".to_string(),
    ))
    .unwrap();

    assert_eq!(http.as_deref(), Some("http://localhost:3000/hook"));
    assert_eq!(
      https.as_deref(),
      Some("https://example.com/hooks/profile-launch")
    );
  }

  #[test]
  fn test_normalize_launch_hook_clears_empty_values() {
    let result = ProfileManager::normalize_launch_hook(Some("   ".to_string())).unwrap();
    assert!(result.is_none());
  }

  #[test]
  fn test_normalize_launch_hook_rejects_invalid_scheme() {
    let err = ProfileManager::normalize_launch_hook(Some("ftp://example.com/hook".to_string()))
      .unwrap_err();
    assert!(err.to_string().contains("http or https"));
  }

  #[test]
  fn test_validate_launch_hook_accepts_https_url() {
    let result = super::validate_launch_hook(Some("https://example.com/track")).unwrap();
    assert_eq!(result.as_deref(), Some("https://example.com/track"));
  }

  #[test]
  fn test_validate_launch_hook_rejects_garbage_with_code() {
    let err = super::validate_launch_hook(Some("not a url")).unwrap_err();
    let parsed: serde_json::Value = serde_json::from_str(&err).expect("error must be JSON");
    assert_eq!(parsed["code"], "INVALID_LAUNCH_HOOK_URL");
  }

  #[test]
  fn test_validate_launch_hook_rejects_non_http_scheme_with_code() {
    let err = super::validate_launch_hook(Some("ftp://example.com/hook")).unwrap_err();
    let parsed: serde_json::Value = serde_json::from_str(&err).expect("error must be JSON");
    assert_eq!(parsed["code"], "INVALID_LAUNCH_HOOK_URL");
  }

  #[test]
  fn test_validate_launch_hook_empty_clears_hook() {
    let result = super::validate_launch_hook(Some("")).unwrap();
    assert!(result.is_none());

    let result_ws = super::validate_launch_hook(Some("   ")).unwrap();
    assert!(result_ws.is_none());

    let result_none = super::validate_launch_hook(None).unwrap();
    assert!(result_none.is_none());
  }

  #[test]
  fn test_unlink_proxy_from_profiles_clears_assignment_and_bumps_updated_at() {
    let (manager, _temp_dir) = create_test_profile_manager();

    let proxy_id = "proxy-delete-me";
    let other_proxy = "proxy-keep";

    let make = |name: &str, px: Option<&str>, updated_at: u64| BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: name.to_string(),
      proxy_id: px.map(|s| s.to_string()),
      updated_at: Some(updated_at),
      ..Default::default()
    };
    let a = make("a", Some(proxy_id), 10);
    let b = make("b", Some(proxy_id), 20);
    let c = make("c", Some(other_proxy), 30);
    let d = make("d", None, 40);
    for p in [&a, &b, &c, &d] {
      manager.save_profile_metadata(p).unwrap();
    }

    let unlinked = manager.unlink_proxy_from_profiles(proxy_id).unwrap();
    assert_eq!(unlinked, 2);

    // Reload from disk (unlink must persist) and map by id.
    let by_id: std::collections::HashMap<_, _> = manager
      .list_profiles()
      .unwrap()
      .into_iter()
      .map(|p| (p.id, p))
      .collect();

    // a and b lost the proxy and got a bumped updated_at (last-write-wins).
    let a2 = by_id.get(&a.id).unwrap();
    assert_eq!(a2.proxy_id, None);
    assert!(a2.updated_at.unwrap() > a.updated_at.unwrap());
    let b2 = by_id.get(&b.id).unwrap();
    assert_eq!(b2.proxy_id, None);
    assert!(b2.updated_at.unwrap() > b.updated_at.unwrap());

    // c (different proxy) and d (already direct) are untouched.
    let c2 = by_id.get(&c.id).unwrap();
    assert_eq!(c2.proxy_id, c.proxy_id);
    assert_eq!(c2.updated_at, c.updated_at);
    let d2 = by_id.get(&d.id).unwrap();
    assert_eq!(d2.proxy_id, None);
    assert_eq!(d2.updated_at, d.updated_at);
  }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_browser_profile_with_group(
  app_handle: tauri::AppHandle,
  name: String,
  browser: String,
  version: String,
  release_type: String,
  proxy_id: Option<String>,
  vpn_id: Option<String>,
  wayfern_config: Option<WayfernConfig>,
  group_id: Option<String>,
  ephemeral: bool,
  dns_blocklist: Option<String>,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .create_profile_with_group(
      &app_handle,
      &name,
      &browser,
      &version,
      &release_type,
      proxy_id,
      vpn_id,
      wayfern_config,
      group_id,
      ephemeral,
      dns_blocklist,
      launch_hook,
    )
    .await
    .map_err(|e| crate::wrap_backend_error(e, "Failed to create profile"))
}

#[tauri::command]
pub fn list_browser_profiles() -> Result<Vec<BrowserProfile>, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .list_profiles()
    .map_err(|e| format!("Failed to list profiles: {e}"))
}

#[tauri::command]
pub async fn update_profile_proxy(
  app_handle: tauri::AppHandle,
  profile_id: String,
  proxy_id: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_proxy(app_handle, &profile_id, proxy_id)
    .await
    .map_err(|e| format!("Failed to update profile: {e}"))
}

#[tauri::command]
pub async fn assign_profiles_network(
  profile_ids: Vec<String>,
  proxy_id: Option<String>,
  vpn_id: Option<String>,
) -> Result<usize, String> {
  ProfileManager::instance()
    .assign_profiles_network(profile_ids, proxy_id, vpn_id)
    .await
}

#[tauri::command]
pub async fn update_profile_vpn(
  app_handle: tauri::AppHandle,
  profile_id: String,
  vpn_id: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_vpn(app_handle, &profile_id, vpn_id)
    .await
    .map_err(|e| format!("Failed to update profile VPN: {e}"))
}

#[tauri::command]
pub fn update_profile_tags(
  app_handle: tauri::AppHandle,
  profile_id: String,
  tags: Vec<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_tags(&app_handle, &profile_id, tags)
    .map_err(|e| format!("Failed to update profile tags: {e}"))
}

#[tauri::command]
pub fn update_profile_note(
  app_handle: tauri::AppHandle,
  profile_id: String,
  note: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_note(&app_handle, &profile_id, note)
    .map_err(|e| format!("Failed to update profile note: {e}"))
}

#[tauri::command]
pub fn update_profile_window_color(
  app_handle: tauri::AppHandle,
  profile_id: String,
  window_color: Option<String>,
) -> Result<BrowserProfile, String> {
  ProfileManager::instance()
    .update_profile_window_color(&app_handle, &profile_id, window_color)
    .map_err(|e| format!("Failed to update profile window color: {e}"))
}

/// Validate a launch hook value. Returns `Ok(None)` for "clear the hook"
/// (`None`, empty, or whitespace-only), `Ok(Some(_))` for a valid http(s)
/// URL, or `Err` with the `INVALID_LAUNCH_HOOK_URL` code payload.
pub(crate) fn validate_launch_hook(launch_hook: Option<&str>) -> Result<Option<String>, String> {
  let Some(raw) = launch_hook else {
    return Ok(None);
  };
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  let ok = url::Url::parse(trimmed)
    .ok()
    .map(|u| matches!(u.scheme(), "http" | "https"))
    .unwrap_or(false);
  if !ok {
    return Err(serde_json::json!({ "code": "INVALID_LAUNCH_HOOK_URL" }).to_string());
  }
  Ok(Some(trimmed.to_string()))
}

#[tauri::command]
pub fn update_profile_launch_hook(
  app_handle: tauri::AppHandle,
  profile_id: String,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  validate_launch_hook(launch_hook.as_deref())?;
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_launch_hook(&app_handle, &profile_id, launch_hook)
    .map_err(|e| format!("Failed to update profile launch hook: {e}"))
}

#[tauri::command]
pub fn update_profile_proxy_bypass_rules(
  app_handle: tauri::AppHandle,
  profile_id: String,
  rules: Vec<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_proxy_bypass_rules(&app_handle, &profile_id, rules)
    .map_err(|e| format!("Failed to update proxy bypass rules: {e}"))
}

#[tauri::command]
pub fn update_profile_dns_blocklist(
  profile_id: String,
  dns_blocklist: Option<String>,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_profile_dns_blocklist(&profile_id, dns_blocklist)
    .map_err(|e| format!("Failed to update DNS blocklist: {e}"))
}

#[tauri::command]
pub async fn check_browser_status(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
) -> Result<bool, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .check_browser_status(app_handle, &profile)
    .await
    .map_err(|e| format!("Failed to check browser status: {e}"))
}

#[tauri::command]
pub fn rename_profile(
  app_handle: tauri::AppHandle,
  profile_id: String,
  new_name: String,
) -> Result<BrowserProfile, String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .rename_profile(&app_handle, &profile_id, &new_name)
    .map_err(|e| crate::wrap_backend_error(e, "Failed to rename profile"))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_browser_profile_new(
  app_handle: tauri::AppHandle,
  name: String,
  browser_str: String,
  version: String,
  release_type: String,
  proxy_id: Option<String>,
  vpn_id: Option<String>,
  wayfern_config: Option<WayfernConfig>,
  group_id: Option<String>,
  ephemeral: Option<bool>,
  dns_blocklist: Option<String>,
  launch_hook: Option<String>,
) -> Result<BrowserProfile, String> {
  // A dead/unreachable proxy or VPN (or a 402 from an expired proxy
  // subscription) cancels creation with a translatable error.
  crate::validate_profile_network(proxy_id.as_deref(), vpn_id.as_deref()).await?;

  let browser_type =
    BrowserType::from_str(&browser_str).map_err(|e| format!("Invalid browser type: {e}"))?;
  create_browser_profile_with_group(
    app_handle,
    name,
    browser_type.as_str().to_string(),
    version,
    release_type,
    proxy_id,
    vpn_id,
    wayfern_config,
    group_id,
    ephemeral.unwrap_or(false),
    dns_blocklist,
    launch_hook,
  )
  .await
}

#[tauri::command]
pub async fn update_wayfern_config(
  app_handle: tauri::AppHandle,
  profile_id: String,
  config: WayfernConfig,
) -> Result<(), String> {
  let profile_manager = ProfileManager::instance();
  profile_manager
    .update_wayfern_config(app_handle, &profile_id, config)
    .await
    .map_err(|e| format!("Failed to update Wayfern config: {e}"))
}

#[tauri::command]
pub async fn clone_profile(
  app_handle: tauri::AppHandle,
  profile_id: String,
  name: Option<String>,
) -> Result<BrowserProfile, String> {
  let mut profile = ProfileManager::instance()
    .clone_profile(&profile_id, name)
    .map_err(|e| format!("Failed to clone profile: {e}"))?;
  crate::sync::apply_default_profile_sync_mode(&app_handle, &mut profile).await;
  Ok(profile)
}

#[tauri::command]
pub fn delete_profile(app_handle: tauri::AppHandle, profile_id: String) -> Result<(), String> {
  ProfileManager::instance()
    .delete_profile(&app_handle, &profile_id)
    .map_err(|e| format!("Failed to delete profile: {e}"))
}

#[tauri::command]
pub fn list_trash() -> Result<Vec<crate::profile::trash::TrashEntry>, String> {
  crate::profile::trash::list_trash().map_err(|e| format!("Failed to list trash: {e}"))
}

#[tauri::command]
pub fn restore_profile_from_trash(
  profile_id: String,
) -> Result<crate::profile::BrowserProfile, String> {
  let profiles_dir = ProfileManager::instance().get_profiles_dir();
  let profile = crate::profile::trash::restore_profile(&profiles_dir, &profile_id)
    .map_err(|e| format!("Failed to restore profile from trash: {e}"))?;

  // Re-upload to sync when the profile is sync-enabled, then refresh both
  // the profile list and the trash dialog.
  crate::sync::queue_profile_sync_if_eligible(&profile);
  let _ = crate::events::emit_empty("profiles-changed");
  let _ = crate::events::emit_empty(crate::profile::trash::TRASH_EVENT);
  Ok(profile)
}

#[tauri::command]
pub fn purge_profile_from_trash(profile_id: String) -> Result<(), String> {
  crate::profile::trash::purge_profile(&profile_id)
    .map_err(|e| format!("Failed to purge profile from trash: {e}"))?;
  let _ = crate::events::emit_empty(crate::profile::trash::TRASH_EVENT);
  Ok(())
}

#[tauri::command]
pub fn empty_profile_trash() -> Result<(), String> {
  crate::profile::trash::empty_trash().map_err(|e| format!("Failed to empty trash: {e}"))?;
  let _ = crate::events::emit_empty(crate::profile::trash::TRASH_EVENT);
  Ok(())
}

lazy_static::lazy_static! {
  static ref PROFILE_MANAGER: ProfileManager = ProfileManager::new();
}
