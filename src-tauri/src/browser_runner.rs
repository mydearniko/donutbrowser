use crate::browser::ProxySettings;
use crate::cloud_auth::CLOUD_AUTH;
use crate::downloaded_browsers_registry::DownloadedBrowsersRegistry;
use crate::events;
use crate::profile::{BrowserProfile, ProfileManager};
use crate::proxy_manager::PROXY_MANAGER;
use crate::wayfern_manager::{WayfernConfig, WayfernManager};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct BrowserRunner {
  pub profile_manager: &'static ProfileManager,
  pub downloaded_browsers_registry: &'static DownloadedBrowsersRegistry,
  auto_updater: &'static crate::auto_updater::AutoUpdater,
  wayfern_manager: &'static WayfernManager,
  profile_lifecycle_locks: StdMutex<HashMap<uuid::Uuid, Arc<tokio::sync::Mutex<()>>>>,
  handled_browser_exits: StdMutex<HashMap<uuid::Uuid, u32>>,
}

impl BrowserRunner {
  fn new() -> Self {
    Self {
      profile_manager: ProfileManager::instance(),
      downloaded_browsers_registry: DownloadedBrowsersRegistry::instance(),
      auto_updater: crate::auto_updater::AutoUpdater::instance(),
      wayfern_manager: WayfernManager::instance(),
      profile_lifecycle_locks: StdMutex::new(HashMap::new()),
      handled_browser_exits: StdMutex::new(HashMap::new()),
    }
  }

  pub fn instance() -> &'static BrowserRunner {
    &BROWSER_RUNNER
  }

  fn profile_lifecycle_lock(&self, profile_id: uuid::Uuid) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = self.profile_lifecycle_locks.lock().unwrap();
    locks
      .entry(profile_id)
      .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
      .clone()
  }

  fn browser_exit_was_handled(&self, profile_id: uuid::Uuid, pid: u32) -> bool {
    self
      .handled_browser_exits
      .lock()
      .unwrap()
      .get(&profile_id)
      .is_some_and(|handled_pid| *handled_pid == pid)
  }

  fn mark_browser_exit_handled(&self, profile_id: uuid::Uuid, pid: u32) {
    self
      .handled_browser_exits
      .lock()
      .unwrap()
      .insert(profile_id, pid);
  }

  fn clear_browser_exit_marker(&self, profile_id: uuid::Uuid) {
    self
      .handled_browser_exits
      .lock()
      .unwrap()
      .remove(&profile_id);
  }

  fn inherit_fingerprint_location(generated: &str, active: &str) -> Option<String> {
    const LOCATION_KEYS: [&str; 6] = [
      "timezone",
      "timezoneOffset",
      "latitude",
      "longitude",
      "language",
      "languages",
    ];
    let mut generated: serde_json::Value = serde_json::from_str(generated).ok()?;
    let active: serde_json::Value = serde_json::from_str(active).ok()?;
    let generated = generated.as_object_mut()?;
    let active = active.as_object()?;
    if !active.contains_key("timezone") {
      return None;
    }
    for key in LOCATION_KEYS {
      if let Some(value) = active.get(key) {
        generated.insert(key.to_string(), value.clone());
      }
    }
    serde_json::to_string(generated).ok()
  }

  fn fingerprint_with_safe_location(
    generated: String,
    geolocation_applied: bool,
    active_config: &WayfernConfig,
    routing_signature: &str,
  ) -> Option<String> {
    let geolocation_disabled = matches!(
      active_config.geoip.as_ref(),
      Some(serde_json::Value::Bool(false))
    );
    if geolocation_applied || geolocation_disabled {
      return Some(generated);
    }
    if active_config.geo_proxy_signature.as_deref() != Some(routing_signature) {
      return None;
    }
    Self::inherit_fingerprint_location(&generated, active_config.fingerprint.as_deref()?)
  }

  pub(crate) fn fingerprint_preparation_signature(config: &WayfernConfig, routing: &str) -> String {
    format!(
      "{routing}|os:{}",
      config.os.as_deref().unwrap_or(std::env::consts::OS)
    )
  }

  fn proxy_settings_url(settings: &ProxySettings) -> String {
    if let (Some(username), Some(password)) = (&settings.username, &settings.password) {
      format!(
        "{}://{}:{}@{}:{}",
        settings.proxy_type.to_lowercase(),
        username,
        password,
        settings.host,
        settings.port
      )
    } else {
      format!(
        "{}://{}:{}",
        settings.proxy_type.to_lowercase(),
        settings.host,
        settings.port
      )
    }
  }

  /// Prepare the most recently used legacy randomizing profile as soon as the
  /// app starts. New profiles already carry an unused first prepared value,
  /// and every successful launch prepares its successor; this is the one-time
  /// bridge for profiles created by older builds.
  pub fn prewarm_recent_random_fingerprint(&self, app_handle: tauri::AppHandle) {
    let Ok(mut profiles) = self.profile_manager.list_profiles() else {
      return;
    };
    profiles.sort_by(|left, right| {
      right
        .last_launch
        .or(right.created_at)
        .unwrap_or_default()
        .cmp(&left.last_launch.or(left.created_at).unwrap_or_default())
    });
    let Some(candidate) = profiles.into_iter().find(|profile| {
      profile.browser == "wayfern"
        && profile.process_id.is_none()
        && profile.vpn_id.is_none()
        && profile.wayfern_config.as_ref().is_some_and(|config| {
          config.randomize_fingerprint_on_launch == Some(true)
            && config.prepared_fingerprint.is_none()
        })
    }) else {
      return;
    };

    tauri::async_runtime::spawn(async move {
      let started = Instant::now();
      let runner = BrowserRunner::instance();
      let lifecycle_lock = runner.profile_lifecycle_lock(candidate.id);
      let _guard = lifecycle_lock.lock().await;
      let Ok(Some(profile)) = runner.profile_manager.get_profile_by_id(candidate.id) else {
        return;
      };
      if profile.process_id.is_some() || profile.vpn_id.is_some() {
        return;
      }
      let mut config = profile.wayfern_config.clone().unwrap_or_default();
      if config.randomize_fingerprint_on_launch != Some(true) {
        return;
      }

      let upstream_proxy = match runner
        .resolve_proxy_with_refresh(profile.proxy_id.as_ref(), Some(&profile.id.to_string()))
        .await
      {
        Ok(proxy) => proxy,
        Err(error) => {
          log::debug!(
            "Skipping random fingerprint prewarm for profile {}: {error}",
            profile.name
          );
          return;
        }
      };
      let routing_signature =
        WayfernManager::geo_signature(upstream_proxy.as_ref(), None, config.geoip.as_ref());
      let preparation_signature =
        Self::fingerprint_preparation_signature(&config, &routing_signature);
      if config.prepared_fingerprint.is_some()
        && config.prepared_fingerprint_signature.as_deref() == Some(preparation_signature.as_str())
      {
        return;
      }

      let active_config = config.clone();
      config.proxy = upstream_proxy.as_ref().map(Self::proxy_settings_url);
      config.fingerprint = None;
      config.prepared_fingerprint = None;
      config.prepared_fingerprint_signature = None;
      let generated = WayfernManager::instance()
        .generate_fingerprint_config(&app_handle, &profile, &config)
        .await;
      let (generated, geolocation_applied) = match generated {
        Ok(result) => result,
        Err(error) => {
          log::debug!(
            "Could not prewarm a random fingerprint for profile {}: {error}",
            profile.name
          );
          return;
        }
      };
      let Some(fingerprint) = Self::fingerprint_with_safe_location(
        generated,
        geolocation_applied,
        &active_config,
        &routing_signature,
      ) else {
        return;
      };

      let Ok(Some(mut latest)) = runner.profile_manager.get_profile_by_id(profile.id) else {
        return;
      };
      if latest.process_id.is_some()
        || latest.proxy_id != profile.proxy_id
        || latest.vpn_id != profile.vpn_id
        || latest.updated_at != profile.updated_at
      {
        return;
      }
      let mut latest_config = latest.wayfern_config.clone().unwrap_or_default();
      if latest_config.randomize_fingerprint_on_launch != Some(true)
        || latest_config.os != active_config.os
        || latest_config.geoip != active_config.geoip
      {
        return;
      }
      latest_config.prepared_fingerprint = Some(fingerprint);
      latest_config.prepared_fingerprint_signature = Some(preparation_signature);
      latest.wayfern_config = Some(latest_config);
      if let Err(error) = runner.profile_manager.save_runtime_profile(&latest) {
        log::debug!(
          "Could not save startup fingerprint prewarm for profile {}: {error}",
          profile.name
        );
        return;
      }
      log::info!(
        "[launch-prewarm] profile={} prepared={}ms",
        profile.id,
        started.elapsed().as_millis()
      );
    });
  }

  fn prepare_next_random_fingerprint(
    &self,
    app_handle: tauri::AppHandle,
    profile: BrowserProfile,
    mut generation_config: WayfernConfig,
    routing_signature: String,
    expected_pid: u32,
  ) {
    tauri::async_runtime::spawn(async move {
      // Let the visible browser finish its initial tab restore before starting
      // the low-priority preparation work for the next session.
      tokio::time::sleep(Duration::from_secs(2)).await;

      let active_config = generation_config.clone();
      generation_config.fingerprint = None;
      generation_config.prepared_fingerprint = None;
      generation_config.prepared_fingerprint_signature = None;

      let generated = WayfernManager::instance()
        .generate_fingerprint_config(&app_handle, &profile, &generation_config)
        .await;
      let (fingerprint, geolocation_applied) = match generated {
        Ok(result) => result,
        Err(error) => {
          log::warn!(
            "Could not prepare the next random fingerprint for profile {}: {error}",
            profile.name
          );
          return;
        }
      };

      let Some(fingerprint) = Self::fingerprint_with_safe_location(
        fingerprint,
        geolocation_applied,
        &active_config,
        &routing_signature,
      ) else {
        return;
      };

      let runner = BrowserRunner::instance();
      let lifecycle_lock = runner.profile_lifecycle_lock(profile.id);
      let _guard = lifecycle_lock.lock().await;
      let Ok(Some(mut latest)) = runner.profile_manager.get_profile_by_id(profile.id) else {
        return;
      };
      if latest.process_id != Some(expected_pid) {
        return;
      }
      let mut config = latest.wayfern_config.clone().unwrap_or_default();
      if config.randomize_fingerprint_on_launch != Some(true)
        || config.prepared_fingerprint.is_some()
      {
        return;
      }
      config.prepared_fingerprint = Some(fingerprint);
      config.prepared_fingerprint_signature = Some(Self::fingerprint_preparation_signature(
        &generation_config,
        &routing_signature,
      ));
      latest.wayfern_config = Some(config);
      if let Err(error) = runner.profile_manager.save_runtime_profile(&latest) {
        log::warn!(
          "Could not save the prepared random fingerprint for profile {}: {error}",
          profile.name
        );
      } else {
        log::info!(
          "Prepared the next random fingerprint for profile {} outside the launch path",
          profile.name
        );
      }
    });
  }

  pub fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  /// Resolve the DNS blocklist level to a cached file path.
  /// If a level is set but the cache is missing, fetches on demand (blocks until done).
  async fn resolve_blocklist_file(
    profile: &crate::profile::BrowserProfile,
  ) -> Result<Option<String>, String> {
    let Some(ref level_str) = profile.dns_blocklist else {
      return Ok(None);
    };
    let Some(level) = crate::dns_blocklist::BlocklistLevel::parse_level(level_str) else {
      return Ok(None);
    };
    if level == crate::dns_blocklist::BlocklistLevel::None {
      return Ok(None);
    }
    let path = crate::dns_blocklist::BlocklistManager::ensure_cached(level)
      .await
      .map_err(|e| format!("Failed to fetch DNS blocklist: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
  }

  /// Resolve proxy settings with a profile-specific sid for sticky sessions.
  /// Cached cloud credentials are usable immediately; their periodic refresh
  /// must not put a cloud API round trip in every browser launch.
  async fn resolve_proxy_with_refresh(
    &self,
    proxy_id: Option<&String>,
    profile_id: Option<&str>,
  ) -> Result<Option<ProxySettings>, String> {
    let proxy_id = match proxy_id {
      Some(id) => id,
      None => return Ok(None),
    };

    let is_cloud = PROXY_MANAGER.is_cloud_or_derived(proxy_id);
    let resolve_cached = || {
      if is_cloud {
        profile_id
          .and_then(|pid| PROXY_MANAGER.resolve_proxy_for_profile(proxy_id, pid))
          .or_else(|| PROXY_MANAGER.get_proxy_settings_by_id(proxy_id))
      } else {
        PROXY_MANAGER.get_proxy_settings_by_id(proxy_id)
      }
    };

    if let Some(settings) = resolve_cached() {
      if is_cloud {
        tokio::spawn(async {
          CLOUD_AUTH.sync_cloud_proxy().await;
        });
      }
      return Ok(Some(settings));
    }

    if is_cloud {
      log::info!("Cloud proxy is not cached yet; fetching credentials before first launch");
      CLOUD_AUTH.sync_cloud_proxy().await;
    }
    Ok(resolve_cached())
  }

  fn fire_launch_hook(profile: &BrowserProfile) {
    let Some(raw_url) = profile.launch_hook.as_deref() else {
      return;
    };
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
      return;
    }

    let parsed = match url::Url::parse(trimmed) {
      Ok(u) => u,
      Err(e) => {
        log::warn!(
          "Skipping launch hook for profile {} (ID: {}): invalid URL: {e}",
          profile.name,
          profile.id
        );
        return;
      }
    };

    if !matches!(parsed.scheme(), "http" | "https") {
      log::warn!(
        "Skipping launch hook for profile {} (ID: {}): URL must be http or https",
        profile.name,
        profile.id
      );
      return;
    }

    let url = parsed.to_string();
    let profile_name = profile.name.clone();
    let profile_id = profile.id.to_string();

    log::info!("Firing launch hook GET {url} for profile {profile_name} (ID: {profile_id})");

    tokio::spawn(async move {
      let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
      {
        Ok(c) => c,
        Err(e) => {
          log::warn!("Launch hook client build failed for {url}: {e}");
          return;
        }
      };

      match client.get(&url).send().await {
        Ok(resp) => {
          log::info!(
            "Launch hook {url} for profile {profile_name} returned status {}",
            resp.status()
          );
        }
        Err(e) => {
          log::warn!("Launch hook {url} for profile {profile_name} failed: {e}");
        }
      }
    });
  }

  async fn resolve_launch_proxy(
    &self,
    profile: &BrowserProfile,
  ) -> Result<Option<ProxySettings>, String> {
    Self::fire_launch_hook(profile);

    self
      .resolve_proxy_with_refresh(profile.proxy_id.as_ref(), Some(&profile.id.to_string()))
      .await
  }

  /// Get the executable path for a browser profile
  /// This is a common helper to eliminate code duplication across the codebase
  pub fn get_browser_executable_path(
    &self,
    profile: &BrowserProfile,
  ) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    // Create browser instance to get executable path
    let browser_type = crate::browser::BrowserType::from_str(&profile.browser)
      .map_err(|e| format!("Invalid browser type: {e}"))?;
    let browser = crate::browser::create_browser(browser_type);

    // Construct browser directory path: binaries/<browser>/<version>/
    let mut browser_dir = self.get_binaries_dir();
    browser_dir.push(&profile.browser);
    browser_dir.push(&profile.version);

    // Get platform-specific executable path
    browser
      .get_executable_path(&browser_dir)
      .map_err(|e| format!("Failed to get executable path for {}: {e}", profile.browser).into())
  }

  pub async fn launch_browser(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    local_proxy_settings: Option<&ProxySettings>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    self
      .launch_browser_internal(app_handle, profile, url, local_proxy_settings, None, false)
      .await
  }

  async fn launch_browser_internal(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    _local_proxy_settings: Option<&ProxySettings>,
    remote_debugging_port: Option<u16>,
    headless: bool,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      let launch_started = Instant::now();
      // Get or create wayfern config
      let mut wayfern_config = profile.wayfern_config.clone().unwrap_or_else(|| {
        log::info!(
          "No wayfern config found for profile {}, using default",
          profile.name
        );
        WayfernConfig::default()
      });

      // Extension archive inspection/unpacking is independent of the browser
      // profile directory. Start it immediately on the blocking pool so a
      // cold extension cache overlaps proxy and fingerprint preparation
      // instead of delaying the browser spawn afterwards.
      let extension_preparation = if profile.extension_group_id.is_some() {
        let extension_profile = profile.clone();
        Some(tokio::task::spawn_blocking(move || {
          let manager = crate::extension_manager::EXTENSION_MANAGER
            .lock()
            .map_err(|error| format!("Failed to lock extension manager: {error}"))?;
          manager
            .install_extensions_for_profile(&extension_profile)
            .map_err(|error| error.to_string())
        }))
      } else {
        None
      };

      // Always start a local proxy for Wayfern (for traffic monitoring and geoip support)
      // DNS blocklist I/O is unrelated to proxy credential resolution, so do
      // both concurrently. A missing first-run blocklist can otherwise add its
      // whole download time directly to launch.
      let (upstream_proxy, blocklist_file) = tokio::join!(
        self.resolve_launch_proxy(profile),
        Self::resolve_blocklist_file(profile)
      );
      let mut upstream_proxy =
        upstream_proxy.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
      let blocklist_file =
        blocklist_file.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

      // If profile has a VPN instead of proxy, start VPN worker and use it as upstream
      if upstream_proxy.is_none() {
        if let Some(ref vpn_id) = profile.vpn_id {
          match crate::vpn_worker_runner::start_vpn_worker(vpn_id).await {
            Ok(vpn_worker) => {
              if let Some(port) = vpn_worker.local_port {
                upstream_proxy = Some(ProxySettings {
                  proxy_type: "socks5".to_string(),
                  host: "127.0.0.1".to_string(),
                  port,
                  username: None,
                  password: None,
                });
                log::info!("VPN worker started for Wayfern profile on port {}", port);
              }
            }
            Err(e) => {
              return Err(format!("Failed to start VPN worker: {e}").into());
            }
          }
        }
      }
      log::info!(
        "[launch-timing] profile={} proxy-resolved={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      log::info!(
        "Starting local proxy for Wayfern profile: {} (upstream: {})",
        profile.name,
        upstream_proxy
          .as_ref()
          .map(|p| format!("{}:{}", p.host, p.port))
          .unwrap_or_else(|| "DIRECT".to_string())
      );

      // Start the proxy and get local proxy settings
      // If proxy startup fails, DO NOT launch Wayfern - it requires local proxy
      let profile_id_str = profile.id.to_string();
      let local_proxy = PROXY_MANAGER
        .start_proxy(
          app_handle.clone(),
          upstream_proxy.as_ref(),
          0, // Use 0 as temporary PID, will be updated later
          Some(&profile_id_str),
          profile.proxy_bypass_rules.clone(),
          blocklist_file,
          // Wayfern (Chromium) uses a local SOCKS5 proxy so QUIC and WebRTC
          // UDP can be routed through it (via SOCKS5 UDP ASSOCIATE) without
          // leaking the real IP, rather than being forced direct as they
          // would be over an HTTP CONNECT proxy.
          "socks5",
        )
        .await
        .map_err(|e| {
          let error_msg = format!("Failed to start local proxy for Wayfern: {e}");
          log::error!("{}", error_msg);
          error_msg
        })?;
      log::info!(
        "[launch-timing] profile={} local-proxy-ready={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      // Format proxy URL for wayfern - use SOCKS5 for the local proxy so
      // Chromium proxies UDP (QUIC/WebRTC), not just TCP.
      let proxy_url = format!("socks5://{}:{}", local_proxy.host, local_proxy.port);

      // Set proxy in wayfern config
      wayfern_config.proxy = Some(proxy_url);

      log::info!(
        "Configured local proxy for Wayfern: {:?}",
        wayfern_config.proxy
      );

      let current_geo_sig = crate::wayfern_manager::WayfernManager::geo_signature(
        upstream_proxy.as_ref(),
        profile.vpn_id.as_deref(),
        wayfern_config.geoip.as_ref(),
      );
      let geo_enabled = !matches!(
        wayfern_config.geoip.as_ref(),
        Some(serde_json::Value::Bool(false))
      );

      // Check if we need to generate a new fingerprint on every launch
      let mut updated_profile = profile.clone();
      if wayfern_config.randomize_fingerprint_on_launch == Some(true) {
        let preparation_signature =
          Self::fingerprint_preparation_signature(&wayfern_config, &current_geo_sig);
        let prepared_matches_routing = wayfern_config.prepared_fingerprint_signature.as_deref()
          == Some(preparation_signature.as_str());
        let prepared = if prepared_matches_routing {
          wayfern_config.prepared_fingerprint.take()
        } else {
          None
        };
        let (new_fingerprint, geolocation_applied) = if let Some(prepared) = prepared {
          log::info!(
            "Using the prepared random fingerprint for Wayfern profile: {}",
            profile.name
          );
          (prepared, geo_enabled)
        } else {
          log::info!(
            "Generating random fingerprint for Wayfern profile: {}",
            profile.name
          );
          let mut config_for_generation = wayfern_config.clone();
          config_for_generation.fingerprint = None;
          config_for_generation.prepared_fingerprint = None;
          config_for_generation.prepared_fingerprint_signature = None;
          self
            .wayfern_manager
            .generate_fingerprint_config(&app_handle, profile, &config_for_generation)
            .await
            .map_err(|e| format!("Failed to generate random fingerprint: {e}"))?
        };

        log::info!(
          "New fingerprint generated, length: {} chars",
          new_fingerprint.len()
        );

        // Update the config with the new fingerprint for launching
        wayfern_config.fingerprint = Some(new_fingerprint.clone());
        wayfern_config.prepared_fingerprint = None;
        wayfern_config.prepared_fingerprint_signature = None;

        // Save the updated fingerprint to the profile so it persists.
        let mut updated_wayfern_config = updated_profile.wayfern_config.clone().unwrap_or_default();
        updated_wayfern_config.fingerprint = Some(new_fingerprint);
        updated_wayfern_config.prepared_fingerprint = None;
        updated_wayfern_config.prepared_fingerprint_signature = None;
        // Preserve the randomize flag so it persists across launches
        updated_wayfern_config.randomize_fingerprint_on_launch = Some(true);
        // Preserve the OS setting so it's used for future fingerprint generation
        if wayfern_config.os.is_some() {
          updated_wayfern_config.os = wayfern_config.os.clone();
        }
        // The fresh fingerprint's location matches the current routing; record
        // its signature so launches keep it in sync with the non-randomize
        // path. Only when geolocation actually applied — otherwise leave it
        // unset so the refresh path can repair the location if the user later
        // turns randomize off.
        updated_wayfern_config.geo_proxy_signature = if geolocation_applied {
          Some(current_geo_sig.clone())
        } else {
          None
        };
        wayfern_config.geo_proxy_signature = updated_wayfern_config.geo_proxy_signature.clone();
        updated_profile.wayfern_config = Some(updated_wayfern_config.clone());

        log::info!(
          "Updated profile wayfern_config with new fingerprint for profile: {}, fingerprint length: {}",
          profile.name,
          updated_wayfern_config.fingerprint.as_ref().map(|f| f.len()).unwrap_or(0)
        );
      } else {
        // Safety net: the stored fingerprint's timezone and geolocation were
        // computed for whatever proxy was set when the fingerprint was
        // generated. If the profile's proxy or VPN has changed since (the
        // common case being a user who forgot to set a proxy at creation and
        // added one afterwards), that location data is stale and the user would
        // see the wrong timezone on first launch. When the routing signature no
        // longer matches, refresh just the location fields of the stored
        // fingerprint through the current proxy. Wayfern only; the randomize
        // path above already regenerates the whole fingerprint each launch.
        if geo_enabled
          && wayfern_config.geo_proxy_signature.as_deref() != Some(current_geo_sig.as_str())
        {
          if let Some(stored_fp) = wayfern_config.fingerprint.clone() {
            log::info!(
              "Routing changed for Wayfern profile {} since its fingerprint was generated (was {:?}, now {}); refreshing timezone and geolocation",
              profile.name,
              wayfern_config.geo_proxy_signature,
              current_geo_sig
            );
            match crate::wayfern_manager::WayfernManager::refresh_fingerprint_geolocation(
              &stored_fp,
              wayfern_config.proxy.as_deref(),
              wayfern_config.geoip.as_ref(),
            )
            .await
            {
              Some(refreshed) => {
                // Use the refreshed fingerprint for this launch...
                wayfern_config.fingerprint = Some(refreshed.clone());
                wayfern_config.geo_proxy_signature = Some(current_geo_sig.clone());
                // ...and persist it so the corrected location sticks and we do
                // not refresh again on the next launch with the same proxy.
                let mut cfg = updated_profile.wayfern_config.clone().unwrap_or_default();
                cfg.fingerprint = Some(refreshed);
                cfg.geo_proxy_signature = Some(current_geo_sig.clone());
                updated_profile.wayfern_config = Some(cfg);
              }
              None => {
                log::warn!(
                  "Could not refresh geolocation for Wayfern profile {} (proxy unreachable?); launching with existing location and will retry next launch",
                  profile.name
                );
              }
            }
          }
        }
      }
      log::info!(
        "[launch-timing] profile={} fingerprint-ready={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      // Create ephemeral dir for ephemeral or password-protected profiles
      if profile.password_protected {
        crate::profile::password::prepare_for_launch(profile)
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::create_ephemeral_dir(&profile.id.to_string())
          .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
      }
      log::info!(
        "[launch-timing] profile={} profile-data-ready={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      // Launch Wayfern browser
      log::info!("Launching Wayfern for profile: {}", profile.name);

      // Get profile path for Wayfern
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(&updated_profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy().to_string();

      // Install extensions if an extension group is assigned
      let mut extension_paths = Vec::new();
      if let Some(preparation) = extension_preparation {
        match preparation.await {
          Ok(Ok(paths)) => extension_paths = paths,
          Ok(Err(error)) => {
            log::warn!("Failed to install extensions for Wayfern profile: {error}")
          }
          Err(error) => log::warn!("Extension preparation task failed: {error}"),
        }
        if !extension_paths.is_empty() {
          log::info!(
            "Prepared {} Chromium extensions for profile: {}",
            extension_paths.len(),
            updated_profile.name
          );
        }
      }
      log::info!(
        "[launch-timing] profile={} extensions-ready={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      // Get proxy URL from config
      let proxy_url = wayfern_config.proxy.as_deref();

      let wayfern_result = self
        .wayfern_manager
        .launch_wayfern(
          &app_handle,
          &updated_profile,
          &profile_path_str,
          &wayfern_config,
          url.as_deref(),
          proxy_url,
          profile.ephemeral,
          &extension_paths,
          remote_debugging_port,
          headless,
        )
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
          format!("Failed to launch Wayfern: {e}").into()
        })?;
      log::info!(
        "[launch-timing] profile={} browser-cdp-ready={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      // Get the process ID from launch result
      let process_id = wayfern_result.processId.unwrap_or(0);
      log::info!("Wayfern launched successfully with PID: {process_id}");

      // Wayfern.setFingerprint echoes back the fingerprint the browser actually
      // applied, which may be UPGRADED from the stored one (e.g. when the
      // stored fingerprint targets an older browser version). Persist it so the
      // next launch starts from the upgraded value — saved below via
      // save_process_info(&updated_profile).
      if let Some(used_fp) = wayfern_result.used_fingerprint.clone() {
        let mut cfg = updated_profile.wayfern_config.clone().unwrap_or_default();
        if cfg.fingerprint.as_deref() != Some(used_fp.as_str()) {
          log::info!(
            "Persisting upgraded fingerprint from Wayfern.setFingerprint for profile: {} (len {})",
            profile.name,
            used_fp.len()
          );
          cfg.fingerprint = Some(used_fp);
          updated_profile.wayfern_config = Some(cfg);
        }
      }

      // Update profile with the process info
      updated_profile.process_id = Some(process_id);
      updated_profile.last_launch = Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs());

      // Update the proxy manager with the correct PID
      if let Err(e) = PROXY_MANAGER.update_proxy_pid(0, process_id) {
        log::warn!("Warning: Failed to update proxy PID mapping: {e}");
      } else {
        log::info!("Updated proxy PID mapping from temp (0) to actual PID: {process_id}");
      }

      // Persist the real browser PID so the detached proxy worker self-reaps
      // when this browser dies, even after the GUI exits/restarts.
      PROXY_MANAGER.set_browser_pid_for_profile(&updated_profile.id.to_string(), process_id);

      // Save the updated profile
      log::info!(
        "Saving profile {} with wayfern_config fingerprint length: {}",
        updated_profile.name,
        updated_profile
          .wayfern_config
          .as_ref()
          .and_then(|c| c.fingerprint.as_ref())
          .map(|f| f.len())
          .unwrap_or(0)
      );
      self.save_process_info(&updated_profile)?;
      self.clear_browser_exit_marker(updated_profile.id);
      self
        .wayfern_manager
        .arm_exit_watcher(&wayfern_result.id, app_handle.clone(), updated_profile.id)
        .await;
      log::info!(
        "Successfully saved profile with process info: {}",
        updated_profile.name
      );

      // Emit profiles-changed to trigger frontend to reload profiles from disk
      if let Err(e) = events::emit_empty("profiles-changed") {
        log::warn!("Warning: Failed to emit profiles-changed event: {e}");
      }

      log::info!(
        "Emitting profile events for successful Wayfern launch: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event to frontend
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }

      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: updated_profile.process_id.is_some(),
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Wayfern {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      if wayfern_config.randomize_fingerprint_on_launch == Some(true) && process_id != 0 {
        let mut generation_config = updated_profile.wayfern_config.clone().unwrap_or_default();
        generation_config.proxy = wayfern_config.proxy.clone();
        self.prepare_next_random_fingerprint(
          app_handle,
          updated_profile.clone(),
          generation_config,
          current_geo_sig,
          process_id,
        );
      }

      log::info!(
        "[launch-timing] profile={} launch-pipeline-complete={}ms",
        profile.id,
        launch_started.elapsed().as_millis()
      );

      return Ok(updated_profile);
    }

    Err(format!("Unsupported browser type: {}", profile.browser).into())
  }

  pub async fn open_url_in_existing_browser(
    &self,
    _app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: &str,
    _internal_proxy_settings: Option<&ProxySettings>,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      // Check if the process is running
      match self
        .wayfern_manager
        .find_wayfern_by_profile(&profile_path_str)
        .await
      {
        Some(_wayfern_process) => {
          log::info!(
            "Opening URL in existing Wayfern process for profile: {} (ID: {})",
            profile.name,
            profile.id
          );

          // Use CDP to open URL in a new tab
          self
            .wayfern_manager
            .open_url_in_tab(&profile_path_str, url)
            .await?;
          return Ok(());
        }
        None => {
          return Err("Wayfern browser is not running".into());
        }
      }
    }

    Err(format!("Unsupported browser type: {}", profile.browser).into())
  }

  pub async fn launch_or_open_url(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    internal_proxy_settings: Option<&ProxySettings>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    let lifecycle_lock = self.profile_lifecycle_lock(profile.id);
    let _lifecycle_guard = lifecycle_lock.lock().await;
    self
      .launch_or_open_url_unlocked(app_handle, profile, url, internal_proxy_settings)
      .await
  }

  async fn launch_or_open_url_unlocked(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
    url: Option<String>,
    internal_proxy_settings: Option<&ProxySettings>,
  ) -> Result<BrowserProfile, Box<dyn std::error::Error + Send + Sync>> {
    log::info!(
      "launch_or_open_url called for profile: {} (ID: {})",
      profile.name,
      profile.id
    );

    // Get the most up-to-date profile data
    let updated_profile = self
      .profile_manager
      .get_profile_by_id(profile.id)
      .map_err(|e| format!("Failed to load profile in launch_or_open_url: {e}"))?
      .unwrap_or_else(|| profile.clone());

    log::info!(
      "Checking browser status for profile: {} (ID: {})",
      updated_profile.name,
      updated_profile.id
    );

    // Check if browser is already running
    let status_started = Instant::now();
    let is_running = self
      .check_browser_status_with_lifecycle_lock(app_handle.clone(), &updated_profile)
      .await
      .map_err(|e| format!("Failed to check browser status: {e}"))?;
    log::info!(
      "[launch-timing] profile={} status-check={}ms running={}",
      updated_profile.id,
      status_started.elapsed().as_millis(),
      is_running
    );

    // Get the updated profile again after status check (PID might have been updated)
    let final_profile = self
      .profile_manager
      .get_profile_by_id(profile.id)
      .map_err(|e| format!("Failed to reload profile after status check: {e}"))?
      .unwrap_or_else(|| updated_profile.clone());

    log::info!(
      "Browser status check - Profile: {} (ID: {}), Running: {}, URL: {:?}, PID: {:?}",
      final_profile.name,
      final_profile.id,
      is_running,
      url,
      final_profile.process_id
    );

    if is_running && url.is_some() {
      // Browser is running and we have a URL to open
      if let Some(url_ref) = url.as_ref() {
        log::info!("Opening URL in existing browser: {url_ref}");

        match self
          .open_url_in_existing_browser(
            app_handle.clone(),
            &final_profile,
            url_ref,
            internal_proxy_settings,
          )
          .await
        {
          Ok(()) => {
            log::info!("Successfully opened URL in existing browser");
            Ok(final_profile)
          }
          Err(e) => {
            log::info!("Failed to open URL in existing browser: {e}");

            // Fall back to launching a new instance
            log::info!(
              "Falling back to new instance for browser: {}",
              final_profile.browser
            );
            // Fallback to launching a new instance for other browsers
            self
              .launch_browser_internal(
                app_handle.clone(),
                &final_profile,
                url,
                internal_proxy_settings,
                None,
                false,
              )
              .await
          }
        }
      } else {
        // This case shouldn't happen since we checked is_some() above, but handle it gracefully
        log::info!("URL was unexpectedly None, launching new browser instance");
        self
          .launch_browser(
            app_handle.clone(),
            &final_profile,
            url,
            internal_proxy_settings,
          )
          .await
      }
    } else {
      // Browser is not running or no URL provided, launch new instance
      if !is_running {
        log::info!("Launching new browser instance - browser not running");
      } else {
        log::info!("Launching new browser instance - no URL provided");
      }
      self
        .launch_browser_internal(
          app_handle.clone(),
          &final_profile,
          url,
          internal_proxy_settings,
          None,
          false,
        )
        .await
    }
  }

  fn save_process_info(
    &self,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Use the regular save_profile method which handles the UUID structure
    self
      .profile_manager
      .save_runtime_profile(profile)
      .map_err(|e| {
        let error_string = e.to_string();
        Box::new(std::io::Error::other(error_string)) as Box<dyn std::error::Error + Send + Sync>
      })
  }

  pub async fn check_browser_status(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    self
      .profile_manager
      .check_browser_status(app_handle, profile)
      .await
  }

  async fn check_browser_status_with_lifecycle_lock(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    self
      .profile_manager
      .check_browser_status_with_lifecycle_lock(app_handle, profile)
      .await
  }

  /// Finalize a browser that the user closed through Wayfern itself. The
  /// child-process waiter calls this immediately; the periodic status scan
  /// calls the same method as a fallback for browsers recovered after a GUI
  /// restart. A per-profile lifecycle lock prevents a new launch from racing
  /// password re-encryption or sync release.
  pub async fn handle_natural_browser_exit(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: uuid::Uuid,
    expected_pid: u32,
  ) {
    let lifecycle_lock = self.profile_lifecycle_lock(profile_id);
    let _lifecycle_guard = lifecycle_lock.lock().await;
    self
      .handle_natural_browser_exit_with_lifecycle_lock(app_handle, profile_id, expected_pid)
      .await;
  }

  pub(crate) async fn handle_natural_browser_exit_with_lifecycle_lock(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: uuid::Uuid,
    expected_pid: u32,
  ) {
    if self.browser_exit_was_handled(profile_id, expected_pid) {
      return;
    }

    let profile = match self.profile_manager.get_profile_by_id(profile_id) {
      Ok(profile) => profile,
      Err(error) => {
        log::warn!("Could not load profile {profile_id} after browser exit: {error}");
        return;
      }
    };
    let Some(mut profile) = profile else {
      log::debug!("Profile {profile_id} was removed before its browser exit was finalized");
      return;
    };

    // A late waiter from an older browser generation must never stop or
    // re-encrypt a newly launched process that happened to reuse the profile.
    if profile.process_id != Some(expected_pid) {
      log::debug!(
        "Ignoring stale browser-exit notification for profile {profile_id}: expected PID {expected_pid}, current PID {:?}",
        profile.process_id
      );
      return;
    }

    profile.process_id = None;
    if let Err(error) = self.save_process_info(&profile) {
      // Leave the generation unclaimed so the fallback scanner can retry.
      log::error!("Could not persist stopped state for profile {profile_id}: {error}");
      return;
    }
    self.mark_browser_exit_handled(profile_id, expected_pid);

    if let Err(error) = events::emit("profile-updated", &profile) {
      log::warn!("Failed to emit profile update after natural browser exit: {error}");
    }
    if let Err(error) = events::emit_empty("profiles-changed") {
      log::warn!("Failed to emit profiles changed after natural browser exit: {error}");
    }

    #[derive(Serialize)]
    struct RunningChangedPayload {
      id: String,
      is_running: bool,
    }
    let payload = RunningChangedPayload {
      id: profile_id.to_string(),
      is_running: false,
    };
    if let Err(error) = events::emit("profile-running-changed", &payload) {
      log::warn!("Failed to emit natural browser exit: {error}");
    }

    // These independent cleanup operations run together. Re-encryption still
    // completes before sync is released, and the lifecycle lock remains held
    // until all profile data is safe for another launch.
    let proxy_cleanup = async {
      if let Err(error) = PROXY_MANAGER
        .stop_proxy_by_profile_id(app_handle.clone(), &profile_id.to_string())
        .await
      {
        log::warn!("Failed to stop proxy after browser exit for {profile_id}: {error}");
      }
    };
    let data_cleanup = async {
      if profile.password_protected {
        crate::profile::password::complete_after_quit_and_wait(&profile).await;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::remove_ephemeral_dir(&profile_id.to_string());
      }
    };
    let (_, _) = tokio::join!(proxy_cleanup, data_cleanup);

    // A queued sync may only see the profile after fresh ciphertext has been
    // written above. Keep its lease until that atomic sync handoff completes,
    // so another device cannot open the previous remote snapshot in between.
    if let Some(scheduler) = crate::sync::get_global_scheduler() {
      scheduler
        .mark_profile_stopped(&profile_id.to_string())
        .await;
      if !profile.is_sync_enabled() {
        crate::team_lock::release_team_lock_if_needed(&profile).await;
      }
    } else {
      crate::team_lock::release_team_lock_if_needed(&profile).await;
    }

    if let Some(updated) = self
      .auto_updater
      .update_profile_to_latest_installed(&app_handle, &profile)
    {
      if let Err(error) = events::emit("profile-updated", &updated) {
        log::warn!("Failed to emit auto-updated profile after browser exit: {error}");
      }
    }

    log::info!(
      "Natural Wayfern exit finalized safely for profile {} (PID {expected_pid})",
      profile.name
    );
  }

  pub async fn kill_browser_process(
    &self,
    app_handle: tauri::AppHandle,
    profile: &BrowserProfile,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Handle Wayfern profiles using WayfernManager
    if profile.browser == "wayfern" {
      let lifecycle_lock = self.profile_lifecycle_lock(profile.id);
      let _lifecycle_guard = lifecycle_lock.lock().await;
      let profiles_dir = self.profile_manager.get_profiles_dir();
      let profile_data_path =
        crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
      let profile_path_str = profile_data_path.to_string_lossy();

      log::info!(
        "Attempting to kill Wayfern process for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      let profile_id_str = profile.id.to_string();
      let wayfern_process = self
        .wayfern_manager
        .find_wayfern_by_profile(&profile_path_str)
        .await;
      let stopped_pid = wayfern_process
        .as_ref()
        .and_then(|process| process.processId)
        .or(profile.process_id);

      let browser_stop = async {
        match wayfern_process {
          Some(wayfern_process) => {
            log::info!(
              "Found Wayfern process: {} (PID: {:?})",
              wayfern_process.id,
              wayfern_process.processId
            );
            self.wayfern_manager.stop_wayfern(&wayfern_process.id).await
          }
          None => {
            log::info!(
              "No running Wayfern process found for profile: {} (ID: {})",
              profile.name,
              profile.id
            );
            Ok(())
          }
        }
      };
      let proxy_stop = PROXY_MANAGER.stop_proxy_by_profile_id(app_handle.clone(), &profile_id_str);
      let (browser_result, proxy_result) = tokio::join!(browser_stop, proxy_stop);
      if let Err(error) = proxy_result {
        log::warn!("Failed to stop proxy for profile {profile_id_str}: {error}");
      }
      browser_result?;

      // Clear the process ID from the profile and save immediately so that
      // subsequent calls to update_profile_version (which re-reads from disk)
      // see the cleared process_id.
      let mut updated_profile = profile.clone();
      updated_profile.process_id = None;
      self
        .save_process_info(&updated_profile)
        .map_err(|e| format!("Failed to update profile: {e}"))?;
      if let Some(pid) = stopped_pid {
        self.mark_browser_exit_handled(profile.id, pid);
      }

      // Check for pending updates and apply them
      if let Ok(Some(pending_update)) = self
        .auto_updater
        .get_pending_update(&profile.browser, &profile.version)
      {
        log::info!(
          "Found pending update for Wayfern profile {}: {} -> {}",
          profile.name,
          profile.version,
          pending_update.new_version
        );

        match self.profile_manager.update_profile_version(
          &app_handle,
          &profile.id.to_string(),
          &pending_update.new_version,
        ) {
          Ok(updated_profile_after_update) => {
            log::info!(
              "Successfully updated Wayfern profile {} from version {} to {}",
              profile.name,
              profile.version,
              pending_update.new_version
            );
            updated_profile = updated_profile_after_update;

            if let Err(e) = self
              .auto_updater
              .dismiss_update_notification(&pending_update.id)
            {
              log::warn!("Warning: Failed to dismiss pending update notification: {e}");
            }
          }
          Err(e) => {
            log::error!(
              "Failed to apply pending update for Wayfern profile {}: {}",
              profile.name,
              e
            );
          }
        }
      }

      // If no pending update was applied, check if a newer installed version exists
      if updated_profile.version == profile.version {
        if let Some(p) = self
          .auto_updater
          .update_profile_to_latest_installed(&app_handle, &updated_profile)
        {
          updated_profile = p;
        }
      }

      log::info!(
        "Emitting profile events for successful Wayfern kill: {}",
        updated_profile.name
      );

      // Emit profile update event to frontend
      if let Err(e) = events::emit("profile-updated", &updated_profile) {
        log::warn!("Warning: Failed to emit profile update event: {e}");
      }

      // Emit minimal running changed event
      #[derive(Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      let payload = RunningChangedPayload {
        id: updated_profile.id.to_string(),
        is_running: false,
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      } else {
        log::info!(
          "Successfully emitted profile-running-changed event for Wayfern {}: running={}",
          updated_profile.name,
          payload.is_running
        );
      }

      if profile.password_protected {
        // Await the re-encryption so the queued sync (released later by
        // `mark_profile_stopped` in `kill_browser`) sees fresh ciphertext on
        // disk instead of the previous snapshot.
        crate::profile::password::complete_after_quit_and_wait(profile).await;
      } else if profile.ephemeral {
        crate::ephemeral_dirs::remove_ephemeral_dir(&profile.id.to_string());
      }

      log::info!(
        "Wayfern process cleanup completed for profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Keep the lifecycle lock until the old run's shared state is fully
      // released. The sync scheduler keeps the distributed lease through the
      // final atomic manifest upload, then releases it for another device.
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        scheduler
          .mark_profile_stopped(&profile.id.to_string())
          .await;
        if !profile.is_sync_enabled() {
          crate::team_lock::release_team_lock_if_needed(profile).await;
        }
      } else {
        crate::team_lock::release_team_lock_if_needed(profile).await;
      }

      return Ok(());
    }

    Err(
      format!(
        "Unsupported browser '{}' for profile '{}' — only Wayfern is supported",
        profile.browser, profile.name
      )
      .into(),
    )
  }

  pub async fn open_url_with_profile(
    &self,
    app_handle: tauri::AppHandle,
    profile_id: String,
    url: String,
  ) -> Result<(), String> {
    let profile_uuid = uuid::Uuid::parse_str(&profile_id)
      .map_err(|_| format!("Profile '{profile_id}' not found"))?;
    let profile = self
      .profile_manager
      .get_profile_by_id(profile_uuid)
      .map_err(|e| format!("Failed to load profile: {e}"))?
      .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    if profile.is_cross_os() {
      return Err(format!(
        "Cannot open URL with profile '{}': this profile was created on {} and cannot be used on a different operating system",
        profile.name,
        profile.host_os.as_deref().unwrap_or("another OS"),
      ));
    }

    log::info!("Opening URL '{url}' with profile '{profile_id}'");

    // Use launch_or_open_url which handles both launching new instances and opening in existing ones
    self
      .launch_or_open_url(app_handle, &profile, Some(url.clone()), None)
      .await
      .map_err(|e| {
        log::info!("Failed to open URL with profile '{profile_id}': {e}");
        format!("Failed to open URL with profile: {e}")
      })?;

    log::info!("Successfully opened URL '{url}' with profile '{profile_id}'");
    Ok(())
  }
}

const LAUNCH_SYNC_PREFLIGHT_ATTEMPTS: usize = 2;
const LAUNCH_SYNC_SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const LAUNCH_SYNC_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug)]
enum LaunchSyncPreflightError {
  SetupFailed,
  SetupTimedOut,
  Sync(crate::sync::SyncError),
}

impl LaunchSyncPreflightError {
  fn is_transient(&self) -> bool {
    matches!(
      self,
      Self::SetupFailed
        | Self::SetupTimedOut
        | Self::Sync(
          crate::sync::SyncError::NetworkError(_)
            | crate::sync::SyncError::SerializationError(_)
            | crate::sync::SyncError::Cancelled
        )
    )
  }

  fn kind(&self) -> &'static str {
    match self {
      Self::SetupFailed => "setup failed",
      Self::SetupTimedOut => "setup timed out",
      Self::Sync(crate::sync::SyncError::NotConfigured) => "not configured",
      Self::Sync(crate::sync::SyncError::NetworkError(_)) => "network error",
      Self::Sync(crate::sync::SyncError::AuthError(_)) => "authentication error",
      Self::Sync(crate::sync::SyncError::IoError(_)) => "I/O error",
      Self::Sync(crate::sync::SyncError::SerializationError(_)) => "response error",
      Self::Sync(crate::sync::SyncError::ConflictError(_)) => "conflict",
      Self::Sync(crate::sync::SyncError::InvalidData(_)) => "invalid data",
      Self::Sync(crate::sync::SyncError::Cancelled) => "cancelled",
    }
  }
}

async fn retry_launch_sync_preflight<F, Fut>(
  profile_id: uuid::Uuid,
  max_attempts: usize,
  retry_delay: Duration,
  mut preflight: F,
) -> Result<(), LaunchSyncPreflightError>
where
  F: FnMut() -> Fut,
  Fut: Future<Output = Result<(), LaunchSyncPreflightError>>,
{
  assert!(max_attempts > 0);
  let mut attempt = 1;
  loop {
    log::info!(
      "Profile {} launch sync preflight attempt {}/{} started",
      profile_id,
      attempt,
      max_attempts
    );
    match preflight().await {
      Ok(()) => {
        log::info!(
          "Profile {} launch sync preflight attempt {}/{} completed",
          profile_id,
          attempt,
          max_attempts
        );
        return Ok(());
      }
      Err(error) => {
        let will_retry = attempt < max_attempts && error.is_transient();
        log::warn!(
          "Profile {} launch sync preflight attempt {}/{} failed ({}, retry={})",
          profile_id,
          attempt,
          max_attempts,
          error.kind(),
          will_retry
        );
        if !will_retry {
          return Err(error);
        }
      }
    }
    tokio::time::sleep(retry_delay).await;
    attempt += 1;
  }
}

#[tauri::command]
pub async fn launch_browser_profile(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
  url: Option<String>,
) -> Result<BrowserProfile, String> {
  launch_browser_profile_impl(app_handle, profile, url, None, false, false).await
}

pub async fn launch_browser_profile_impl(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
  url: Option<String>,
  remote_debugging_port: Option<u16>,
  headless: bool,
  force_new: bool,
) -> Result<BrowserProfile, String> {
  let launch_started = Instant::now();
  log::info!(
    "Launch request received for profile: {} (ID: {})",
    profile.name,
    profile.id
  );

  if profile.is_cross_os() {
    return Err(format!(
      "Cannot launch profile '{}': this profile was created on {} and cannot be launched on a different operating system",
      profile.name,
      profile.host_os.as_deref().unwrap_or("another OS"),
    ));
  }

  let browser_runner = BrowserRunner::instance();
  let lifecycle_lock = browser_runner.profile_lifecycle_lock(profile.id);
  let _lifecycle_guard = lifecycle_lock.lock().await;
  log::info!(
    "[launch-timing] profile={} lifecycle-lock={}ms",
    profile.id,
    launch_started.elapsed().as_millis()
  );

  // Requests can wait behind another launch/exit while carrying an older
  // profile snapshot. Refresh under the lifecycle mutex before deciding
  // whether a second local process is allowed or touching sync state.
  let profile = browser_runner
    .profile_manager
    .get_profile_by_id(profile.id)
    .map_err(|error| {
      serde_json::json!({
        "code": "INTERNAL_ERROR",
        "params": { "detail": format!("Failed to refresh profile before launch: {error}") }
      })
      .to_string()
    })?
    .unwrap_or(profile);

  if force_new && profile.process_id.is_some() {
    return Err(serde_json::json!({ "code": "PROFILE_RUNNING" }).to_string());
  }

  // Preempt any background transfer before touching the live profile. The
  // per-profile sync mutex closes the small race between cancellation and the
  // browser process actually starting.
  if let Some(scheduler) = crate::sync::get_global_scheduler() {
    let pid = profile.id.to_string();
    scheduler.mark_profile_running(&pid).await;
    if profile.is_sync_enabled() {
      scheduler.queue_profile_sync(pid).await;
    }
  }
  let sync_mutex = crate::sync::scheduler::profile_sync_mutex(&profile.id.to_string());
  let _sync_guard = sync_mutex.lock().await;
  log::info!(
    "[launch-timing] profile={} sync-preempted={}ms",
    profile.id,
    launch_started.elapsed().as_millis()
  );

  if let Err(error) = crate::team_lock::acquire_team_lock_if_needed(&profile).await {
    if let Some(scheduler) = crate::sync::get_global_scheduler() {
      scheduler
        .mark_profile_stopped(&profile.id.to_string())
        .await;
    }
    return Err(
      if error.contains("in use") || error.contains("owned by another") {
        serde_json::json!({ "code": "PROFILE_LOCKED" }).to_string()
      } else {
        serde_json::json!({
          "code": "INTERNAL_ERROR",
          "params": { "detail": error }
        })
        .to_string()
      },
    );
  }
  log::info!(
    "[launch-timing] profile={} distributed-lock={}ms",
    profile.id,
    launch_started.elapsed().as_millis()
  );

  // Reconcile the remote snapshot while holding both the local lifecycle
  // mutex and the distributed lease. This is normally a fast manifest check;
  // when another device handed the profile off, its completed snapshot lands
  // before Chromium can touch the directory.
  if profile.is_sync_enabled() && crate::team_lock::PROFILE_LOCK.is_connected().await {
    let preflight_result = retry_launch_sync_preflight(
      profile.id,
      LAUNCH_SYNC_PREFLIGHT_ATTEMPTS,
      LAUNCH_SYNC_RETRY_DELAY,
      || {
        let app_handle = app_handle.clone();
        let profile = profile.clone();
        async move {
          let engine = match tokio::time::timeout(
            LAUNCH_SYNC_SETUP_TIMEOUT,
            crate::sync::SyncEngine::create_from_settings(&app_handle),
          )
          .await
          {
            Ok(Ok(engine)) => engine,
            Ok(Err(_)) => return Err(LaunchSyncPreflightError::SetupFailed),
            Err(_) => return Err(LaunchSyncPreflightError::SetupTimedOut),
          };
          engine
            .prepare_profile_for_launch(&app_handle, &profile)
            .await
            .map_err(LaunchSyncPreflightError::Sync)
        }
      },
    )
    .await;
    if let Err(error) = preflight_result {
      log::warn!(
        "Profile {} launch sync preflight failed ({})",
        profile.id,
        error.kind()
      );
      crate::team_lock::release_team_lock_if_needed(&profile).await;
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        scheduler
          .mark_profile_stopped(&profile.id.to_string())
          .await;
      }
      return Err(
        serde_json::json!({
          "code": "PROFILE_SYNC_PREPARE_FAILED"
        })
        .to_string(),
      );
    }
  }
  log::info!(
    "[launch-timing] profile={} sync-preflight={}ms",
    profile.id,
    launch_started.elapsed().as_millis()
  );

  // Resolve the most up-to-date profile from disk by ID to avoid using stale proxy_id/browser state
  let profile_for_launch = match browser_runner
    .profile_manager
    .get_profile_by_id(profile.id)
    .map_err(|e| format!("Failed to load profile: {e}"))
  {
    Ok(profile_on_disk) => profile_on_disk.unwrap_or_else(|| profile.clone()),
    Err(e) => {
      crate::team_lock::release_team_lock_if_needed(&profile).await;
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        scheduler
          .mark_profile_stopped(&profile.id.to_string())
          .await;
      }
      return Err(e);
    }
  };

  log::info!(
    "Resolved profile for launch: {} (ID: {})",
    profile_for_launch.name,
    profile_for_launch.id
  );

  log::info!(
    "Starting browser launch for profile: {} (ID: {})",
    profile_for_launch.name,
    profile_for_launch.id
  );

  // Launch browser or open URL in existing instance. Wayfern starts its
  // own local proxy inside `launch_browser_internal`; other browser types
  // are rejected there, so no proxy needs to be staged here.
  //
  // `force_new` callers (API/MCP) always start a fresh instance with the
  // requested debug port and headless mode, bypassing the "open URL in the
  // existing window" path which would otherwise ignore both.
  let launch_result = if force_new {
    browser_runner
      .launch_browser_internal(
        app_handle.clone(),
        &profile_for_launch,
        url,
        None,
        remote_debugging_port,
        headless,
      )
      .await
  } else {
    browser_runner
      .launch_or_open_url_unlocked(app_handle.clone(), &profile_for_launch, url, None)
      .await
  };

  if launch_result.is_err() {
    crate::team_lock::release_team_lock_if_needed(&profile_for_launch).await;
    if let Some(scheduler) = crate::sync::get_global_scheduler() {
      scheduler
        .mark_profile_stopped(&profile_for_launch.id.to_string())
        .await;
    }
  }

  let updated_profile = launch_result.map_err(|e| {
    log::info!("Browser launch failed for profile: {}, error: {}", profile_for_launch.name, e);

    // Emit a failure event to clear loading states in the frontend
    #[derive(serde::Serialize)]
    struct RunningChangedPayload {
      id: String,
      is_running: bool,
    }
    let payload = RunningChangedPayload {
      id: profile_for_launch.id.to_string(),
      is_running: false,
    };

    if let Err(e) = events::emit("profile-running-changed", &payload) {
      log::warn!("Warning: Failed to emit profile running changed event: {e}");
    }

    // Check if this is an architecture compatibility issue
    if let Some(io_error) = e.downcast_ref::<std::io::Error>() {
      if io_error.kind() == std::io::ErrorKind::Other && io_error.to_string().contains("Exec format error") {
        return format!("Failed to launch browser: Executable format error. This browser version is not compatible with your system architecture ({}). Please try a different browser or version that supports your platform.", std::env::consts::ARCH);
      }
    }
    format!("Failed to launch browser or open URL: {e}")
  })?;

  log::info!(
    "Browser launch completed for profile: {} (ID: {})",
    updated_profile.name,
    updated_profile.id
  );
  log::info!(
    "[launch-timing] profile={} command-complete={}ms",
    updated_profile.id,
    launch_started.elapsed().as_millis()
  );

  // Now update the proxy with the correct PID if we have one
  if let Some(actual_pid) = updated_profile.process_id {
    // Update the proxy manager with the correct PID (we always started with temp pid 1)
    let _ = PROXY_MANAGER.update_proxy_pid(1u32, actual_pid);
  }

  Ok(updated_profile)
}

#[tauri::command]
pub fn check_browser_exists(browser_str: String, version: String) -> bool {
  // This is an alias for is_browser_downloaded to provide clearer semantics for auto-updates
  let runner = BrowserRunner::instance();
  runner
    .downloaded_browsers_registry
    .is_browser_downloaded(&browser_str, &version)
}

#[tauri::command]
pub async fn kill_browser_profile(
  app_handle: tauri::AppHandle,
  profile: BrowserProfile,
) -> Result<(), String> {
  log::info!(
    "Kill request received for profile: {} (ID: {})",
    profile.name,
    profile.id
  );

  let browser_runner = BrowserRunner::instance();

  match browser_runner
    .kill_browser_process(app_handle.clone(), &profile)
    .await
  {
    Ok(()) => {
      log::info!(
        "Successfully killed browser profile: {} (ID: {})",
        profile.name,
        profile.id
      );

      // Auto-update non-running profiles and cleanup unused binaries
      let browser_for_update = profile.browser.clone();
      let app_handle_for_update = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        let registry = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance();
        let mut versions = registry.get_downloaded_versions(&browser_for_update);
        if !versions.is_empty() {
          versions.sort_by(|a, b| crate::api_client::compare_versions(b, a));
          let latest_version = &versions[0];

          let auto_updater = crate::auto_updater::AutoUpdater::instance();
          match auto_updater
            .auto_update_profile_versions(
              &app_handle_for_update,
              &browser_for_update,
              latest_version,
            )
            .await
          {
            Ok(updated) => {
              if !updated.is_empty() {
                log::info!(
                  "Auto-updated {} profiles after stop: {:?}",
                  updated.len(),
                  updated
                );
              }
            }
            Err(e) => {
              log::error!("Failed to auto-update profile versions after stop: {e}");
            }
          }
        }

        match registry.cleanup_unused_binaries() {
          Ok(cleaned) => {
            if !cleaned.is_empty() {
              log::info!("Cleaned up unused binaries after stop: {:?}", cleaned);
            }
          }
          Err(e) => {
            log::error!("Failed to cleanup unused binaries after stop: {e}");
          }
        }
      });

      Ok(())
    }
    Err(e) => {
      log::info!("Failed to kill browser profile {}: {}", profile.name, e);

      // Emit a failure event to clear loading states in the frontend
      #[derive(serde::Serialize)]
      struct RunningChangedPayload {
        id: String,
        is_running: bool,
      }
      // On kill failure, we assume the process is still running
      let payload = RunningChangedPayload {
        id: profile.id.to_string(),
        is_running: true,
      };

      if let Err(e) = events::emit("profile-running-changed", &payload) {
        log::warn!("Warning: Failed to emit profile running changed event: {e}");
      }

      Err(format!("Failed to kill browser: {e}"))
    }
  }
}

#[tauri::command]
pub async fn open_url_with_profile(
  app_handle: tauri::AppHandle,
  profile_id: String,
  url: String,
) -> Result<(), String> {
  let browser_runner = BrowserRunner::instance();
  browser_runner
    .open_url_with_profile(app_handle, profile_id, url)
    .await
}

// Global singleton instance
lazy_static::lazy_static! {
  static ref BROWSER_RUNNER: BrowserRunner = BrowserRunner::new();
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};

  #[test]
  fn lifecycle_locks_are_shared_per_profile_only() {
    let runner = BrowserRunner::instance();
    let first_profile = uuid::Uuid::new_v4();
    let second_profile = uuid::Uuid::new_v4();

    let first = runner.profile_lifecycle_lock(first_profile);
    let same_first = runner.profile_lifecycle_lock(first_profile);
    let second = runner.profile_lifecycle_lock(second_profile);

    assert!(Arc::ptr_eq(&first, &same_first));
    assert!(!Arc::ptr_eq(&first, &second));
  }

  #[test]
  fn handled_exit_markers_are_process_generation_specific() {
    let runner = BrowserRunner::instance();
    let profile_id = uuid::Uuid::new_v4();

    assert!(!runner.browser_exit_was_handled(profile_id, 101));
    runner.mark_browser_exit_handled(profile_id, 101);
    assert!(runner.browser_exit_was_handled(profile_id, 101));
    assert!(!runner.browser_exit_was_handled(profile_id, 202));

    runner.clear_browser_exit_marker(profile_id);
    assert!(!runner.browser_exit_was_handled(profile_id, 101));
  }

  #[tokio::test]
  async fn launch_sync_preflight_retries_a_transient_failure() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed_attempts = attempts.clone();

    let result = retry_launch_sync_preflight(uuid::Uuid::new_v4(), 2, Duration::ZERO, move || {
      let attempt = attempts.fetch_add(1, Ordering::SeqCst);
      async move {
        if attempt == 0 {
          Err(LaunchSyncPreflightError::Sync(
            crate::sync::SyncError::NetworkError("temporary".to_string()),
          ))
        } else {
          Ok(())
        }
      }
    })
    .await;

    assert!(result.is_ok());
    assert_eq!(observed_attempts.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn launch_sync_preflight_does_not_retry_invalid_data() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let observed_attempts = attempts.clone();

    let result = retry_launch_sync_preflight(uuid::Uuid::new_v4(), 2, Duration::ZERO, move || {
      attempts.fetch_add(1, Ordering::SeqCst);
      async {
        Err(LaunchSyncPreflightError::Sync(
          crate::sync::SyncError::InvalidData("permanent".to_string()),
        ))
      }
    })
    .await;

    assert!(result.is_err());
    assert_eq!(observed_attempts.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn prepared_fingerprint_can_inherit_known_good_location() {
    let generated = serde_json::json!({
      "canvasNoiseSeed": "new-seed",
      "timezone": "America/New_York",
      "latitude": 40.0
    })
    .to_string();
    let active = serde_json::json!({
      "canvasNoiseSeed": "old-seed",
      "timezone": "Europe/Paris",
      "timezoneOffset": -120,
      "latitude": 48.8566,
      "longitude": 2.3522,
      "language": "fr-FR",
      "languages": ["fr-FR", "fr"]
    })
    .to_string();

    let merged = BrowserRunner::inherit_fingerprint_location(&generated, &active).unwrap();
    let merged: serde_json::Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(merged["canvasNoiseSeed"], "new-seed");
    assert_eq!(merged["timezone"], "Europe/Paris");
    assert_eq!(merged["longitude"], 2.3522);
    assert_eq!(merged["languages"], serde_json::json!(["fr-FR", "fr"]));
  }

  #[test]
  fn prepared_fingerprint_rejects_unknown_location() {
    assert!(BrowserRunner::inherit_fingerprint_location(
      r#"{"canvasNoiseSeed":"new-seed"}"#,
      r#"{"canvasNoiseSeed":"old-seed"}"#,
    )
    .is_none());
  }

  #[test]
  fn prepared_fingerprint_requires_current_or_disabled_location() {
    let generated = r#"{"canvasNoiseSeed":"new-seed"}"#.to_string();
    let disabled = WayfernConfig {
      geoip: Some(serde_json::Value::Bool(false)),
      ..WayfernConfig::default()
    };
    assert_eq!(
      BrowserRunner::fingerprint_with_safe_location(generated.clone(), false, &disabled, "v2:off"),
      Some(generated.clone())
    );

    let stale = WayfernConfig {
      fingerprint: Some(r#"{"timezone":"Europe/Paris"}"#.to_string()),
      geo_proxy_signature: Some("v2:direct".to_string()),
      ..WayfernConfig::default()
    };
    assert!(BrowserRunner::fingerprint_with_safe_location(
      generated,
      false,
      &stale,
      "v2:proxy:http://user@127.0.0.1:8080"
    )
    .is_none());
  }

  #[test]
  fn prepared_fingerprint_signature_tracks_routing_and_os() {
    let windows = WayfernConfig {
      os: Some("windows".to_string()),
      ..WayfernConfig::default()
    };
    let linux = WayfernConfig {
      os: Some("linux".to_string()),
      ..WayfernConfig::default()
    };

    assert_ne!(
      BrowserRunner::fingerprint_preparation_signature(&windows, "v2:direct"),
      BrowserRunner::fingerprint_preparation_signature(&linux, "v2:direct")
    );
    assert_ne!(
      BrowserRunner::fingerprint_preparation_signature(&windows, "v2:direct"),
      BrowserRunner::fingerprint_preparation_signature(
        &windows,
        "v2:proxy:http://user@127.0.0.1:8080"
      )
    );
  }
}
