use lazy_static::lazy_static;
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use crate::cloud_auth::{CloudAuthManager, CLOUD_API_URL, CLOUD_AUTH};
use crate::settings_manager::SettingsManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileLockInfo {
  #[serde(rename = "profileId")]
  pub profile_id: String,
  #[serde(rename = "lockedBy")]
  pub locked_by: String,
  #[serde(rename = "lockedByEmail")]
  pub locked_by_email: String,
  #[serde(rename = "lockedAt")]
  pub locked_at: String,
  #[serde(rename = "expiresAt", default)]
  pub expires_at: Option<String>,
  #[serde(rename = "ownedByCurrent", default)]
  pub owned_by_current: bool,
}

#[derive(Debug, Deserialize)]
struct AcquireLockResponse {
  success: bool,
  #[serde(default)]
  lock: Option<ProfileLockInfo>,
  #[serde(rename = "lockedByEmail")]
  locked_by_email: Option<String>,
}

#[derive(Debug, Serialize)]
struct SelfHostedOwner<'a> {
  #[serde(rename = "ownerId")]
  owner_id: &'a str,
  #[serde(rename = "ownerLabel")]
  owner_label: &'a str,
}

#[derive(Clone)]
enum LockBackend {
  Cloud {
    base_url: String,
    token: String,
    owner_id: String,
    owner_label: String,
  },
  SelfHosted {
    base_url: String,
    token: String,
    owner_id: String,
    owner_label: String,
  },
}

impl LockBackend {
  fn base_url(&self) -> &str {
    match self {
      Self::Cloud { base_url, .. } | Self::SelfHosted { base_url, .. } => base_url,
    }
  }

  fn token(&self) -> &str {
    match self {
      Self::Cloud { token, .. } | Self::SelfHosted { token, .. } => token,
    }
  }

  fn owner_id(&self) -> &str {
    match self {
      Self::Cloud { owner_id, .. } | Self::SelfHosted { owner_id, .. } => owner_id,
    }
  }

  fn owner_label(&self) -> &str {
    match self {
      Self::Cloud { owner_label, .. } | Self::SelfHosted { owner_label, .. } => owner_label,
    }
  }

  fn is_cloud(&self) -> bool {
    matches!(self, Self::Cloud { .. })
  }

  fn profile_url(&self, profile_id: &str) -> String {
    format!("{}/{profile_id}", self.base_url())
  }

  fn add_owner_body(&self, request: RequestBuilder) -> RequestBuilder {
    match self {
      Self::Cloud { .. } => request,
      Self::SelfHosted { .. } => request.json(&SelfHostedOwner {
        owner_id: self.owner_id(),
        owner_label: self.owner_label(),
      }),
    }
  }
}

pub struct ProfileLockManager {
  client: Client,
  locks: RwLock<HashMap<String, ProfileLockInfo>>,
  backend: RwLock<Option<LockBackend>>,
  heartbeat_handle: Mutex<Option<JoinHandle<()>>>,
  connected: Mutex<bool>,
}

lazy_static! {
  pub static ref PROFILE_LOCK: ProfileLockManager = ProfileLockManager::new();
}

pub use PROFILE_LOCK as TEAM_LOCK;

fn annotate_lock_ownership(lock: &mut ProfileLockInfo, owner_id: &str) {
  lock.owned_by_current = lock.locked_by == owner_id;
}

async fn resolve_lock_backend() -> Result<Option<LockBackend>, String> {
  if CLOUD_AUTH.is_logged_in().await {
    if !CLOUD_AUTH.has_active_paid_subscription().await {
      return Ok(None);
    }
    let token =
      CloudAuthManager::load_access_token()?.ok_or_else(|| "Not logged in".to_string())?;
    let user = CLOUD_AUTH
      .get_user()
      .await
      .ok_or_else(|| "Cloud user is unavailable".to_string())?;
    return Ok(Some(LockBackend::Cloud {
      base_url: format!("{CLOUD_API_URL}/api/profile-locks"),
      token,
      owner_id: user.user.id,
      owner_label: user.user.email,
    }));
  }

  let settings_manager = SettingsManager::instance();
  let settings = settings_manager
    .get_sync_settings()
    .map_err(|e| format!("Failed to load sync settings: {e}"))?;
  let Some(server_url) = settings
    .sync_server_url
    .filter(|url| !url.trim().is_empty())
  else {
    return Ok(None);
  };
  let Some(token) = settings_manager
    .load_sync_token()
    .map_err(|e| format!("Failed to load sync token: {e}"))?
    .filter(|token| !token.is_empty())
  else {
    return Ok(None);
  };

  let identity = settings_manager
    .get_or_create_sync_device_identity()
    .map_err(|error| format!("Failed to load sync device identity: {error}"))?;
  Ok(Some(LockBackend::SelfHosted {
    base_url: format!("{}/v1/locks", server_url.trim_end_matches('/')),
    token,
    owner_id: identity.device_id,
    owner_label: identity.device_name,
  }))
}

impl ProfileLockManager {
  fn new() -> Self {
    Self {
      client: Client::new(),
      locks: RwLock::new(HashMap::new()),
      backend: RwLock::new(None),
      heartbeat_handle: Mutex::new(None),
      connected: Mutex::new(false),
    }
  }

  pub async fn connect(&self) {
    let backend = match resolve_lock_backend().await {
      Ok(Some(backend)) => backend,
      Ok(None) => {
        log::debug!("Profile locks are not configured");
        self.disconnect().await;
        return;
      }
      Err(error) => {
        log::warn!("Failed to configure profile locks: {error}");
        return;
      }
    };

    log::info!("Connecting profile lock manager");
    *self.backend.write().await = Some(backend.clone());
    *self.connected.lock().await = true;

    if let Err(error) = self.fetch_locks_with_backend(&backend).await {
      log::warn!("Failed to fetch initial profile locks: {error}");
    }

    self.start_heartbeat_loop().await;
  }

  pub async fn disconnect(&self) {
    log::info!("Disconnecting profile lock manager");

    if let Some(handle) = self.heartbeat_handle.lock().await.take() {
      handle.abort();
    }
    self.locks.write().await.clear();
    *self.backend.write().await = None;
    *self.connected.lock().await = false;
  }

  pub async fn is_connected(&self) -> bool {
    *self.connected.lock().await
  }

  pub async fn acquire_lock(&self, profile_id: &str) -> Result<(), String> {
    let backend = self
      .current_backend()
      .await?
      .ok_or_else(|| "Profile locks are not configured".to_string())?;
    let request = self
      .client
      .post(backend.profile_url(profile_id))
      .bearer_auth(backend.token());
    let response = backend
      .add_owner_body(request)
      .send()
      .await
      .map_err(|e| format!("Failed to acquire lock: {e}"))?;

    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(format!("Lock acquisition failed ({status}): {body}"));
    }

    let result: AcquireLockResponse = response
      .json()
      .await
      .map_err(|e| format!("Failed to parse lock response: {e}"))?;

    if !result.success {
      let label = result
        .locked_by_email
        .or_else(|| {
          result
            .lock
            .as_ref()
            .map(|lock| lock.locked_by_email.clone())
        })
        .unwrap_or_else(|| "another device".to_string());
      return Err(format!("Profile is in use by {label}"));
    }

    let mut lock = result.lock.unwrap_or_else(|| ProfileLockInfo {
      profile_id: profile_id.to_string(),
      locked_by: backend.owner_id().to_string(),
      locked_by_email: backend.owner_label().to_string(),
      locked_at: chrono::Utc::now().to_rfc3339(),
      expires_at: None,
      owned_by_current: true,
    });
    annotate_lock_ownership(&mut lock, backend.owner_id());
    self
      .locks
      .write()
      .await
      .insert(profile_id.to_string(), lock);

    let _ = crate::events::emit(
      "profile-lock-changed",
      serde_json::json!({ "profileId": profile_id, "action": "acquired" }),
    );
    Ok(())
  }

  pub async fn release_lock(&self, profile_id: &str) -> Result<(), String> {
    let backend = self.current_backend().await?;

    self.locks.write().await.remove(profile_id);
    let _ = crate::events::emit(
      "profile-lock-changed",
      serde_json::json!({ "profileId": profile_id, "action": "released" }),
    );

    let Some(backend) = backend else {
      return Ok(());
    };
    let request = self
      .client
      .delete(backend.profile_url(profile_id))
      .bearer_auth(backend.token());
    let response = backend
      .add_owner_body(request)
      .send()
      .await
      .map_err(|e| format!("Failed to release lock: {e}"))?;
    if !response.status().is_success() {
      return Err(format!("Lock release failed ({})", response.status()));
    }
    if matches!(backend, LockBackend::SelfHosted { .. }) {
      let result: AcquireLockResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse lock release response: {e}"))?;
      if !result.success {
        return Err("Profile lock is owned by another device".to_string());
      }
    }
    Ok(())
  }

  pub async fn get_locks(&self) -> Vec<ProfileLockInfo> {
    self.locks.read().await.values().cloned().collect()
  }

  pub async fn get_lock_status(&self, profile_id: &str) -> Option<ProfileLockInfo> {
    self.locks.read().await.get(profile_id).cloned()
  }

  pub async fn release_all_owned_locks(&self) -> Result<(), String> {
    let Some(backend) = self.current_backend().await? else {
      self.locks.write().await.clear();
      return Ok(());
    };
    let profile_ids: Vec<String> = self
      .locks
      .read()
      .await
      .values()
      .filter(|lock| lock.locked_by == backend.owner_id())
      .map(|lock| lock.profile_id.clone())
      .collect();

    let mut failures = Vec::new();
    for profile_id in profile_ids {
      if let Err(error) = self.release_lock(&profile_id).await {
        failures.push(format!("{profile_id}: {error}"));
      }
    }
    if failures.is_empty() {
      Ok(())
    } else {
      Err(failures.join("; "))
    }
  }

  pub async fn is_locked_by_another(&self, profile_id: &str) -> bool {
    let lock = self.locks.read().await.get(profile_id).cloned();
    let Some(lock) = lock else {
      return false;
    };

    !lock.owned_by_current
  }

  pub async fn is_locked_by_current(&self, profile_id: &str) -> bool {
    let lock = self.locks.read().await.get(profile_id).cloned();
    let Some(lock) = lock else {
      return false;
    };

    lock.owned_by_current
  }

  async fn current_backend(&self) -> Result<Option<LockBackend>, String> {
    if let Some(backend) = self.backend.read().await.clone() {
      return Ok(Some(backend));
    }
    let backend = resolve_lock_backend().await?;
    if let Some(value) = &backend {
      *self.backend.write().await = Some(value.clone());
    }
    Ok(backend)
  }

  async fn fetch_locks_with_backend(&self, backend: &LockBackend) -> Result<(), String> {
    let response = self
      .client
      .get(backend.base_url())
      .bearer_auth(backend.token())
      .send()
      .await
      .map_err(|e| format!("Failed to fetch locks: {e}"))?;
    if !response.status().is_success() {
      return Err(format!("Failed to fetch locks ({})", response.status()));
    }

    let lock_list: Vec<ProfileLockInfo> = response
      .json()
      .await
      .map_err(|e| format!("Failed to parse locks: {e}"))?;
    let mut locks = self.locks.write().await;
    locks.clear();
    for mut lock in lock_list {
      annotate_lock_ownership(&mut lock, backend.owner_id());
      locks.insert(lock.profile_id.clone(), lock);
    }
    Ok(())
  }

  async fn send_heartbeat(backend: &LockBackend, profile_id: &str) -> Result<(), String> {
    let request = PROFILE_LOCK
      .client
      .post(format!("{}/heartbeat", backend.profile_url(profile_id)))
      .bearer_auth(backend.token());
    let response = backend
      .add_owner_body(request)
      .send()
      .await
      .map_err(|e| format!("Failed to heartbeat profile lock: {e}"))?;
    if !response.status().is_success() {
      return Err(format!(
        "Profile lock heartbeat failed ({})",
        response.status()
      ));
    }
    if matches!(backend, LockBackend::SelfHosted { .. }) {
      let result: AcquireLockResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse lock heartbeat response: {e}"))?;
      if !result.success {
        return Err("Profile lock lease was lost".to_string());
      }
    }
    Ok(())
  }

  async fn start_heartbeat_loop(&self) {
    let mut handle = self.heartbeat_handle.lock().await;
    if let Some(existing) = handle.take() {
      existing.abort();
    }

    *handle = Some(tokio::spawn(async move {
      loop {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        if !PROFILE_LOCK.is_connected().await {
          break;
        }

        let mut backend = match PROFILE_LOCK.current_backend().await {
          Ok(Some(backend)) => backend,
          Ok(None) => {
            PROFILE_LOCK.locks.write().await.clear();
            *PROFILE_LOCK.backend.write().await = None;
            *PROFILE_LOCK.connected.lock().await = false;
            break;
          }
          Err(error) => {
            log::debug!("Failed to resolve profile lock backend: {error}");
            continue;
          }
        };
        if backend.is_cloud() {
          if let Ok(Some(refreshed)) = resolve_lock_backend().await {
            *PROFILE_LOCK.backend.write().await = Some(refreshed.clone());
            backend = refreshed;
          }
        }
        let held_locks: Vec<String> = PROFILE_LOCK
          .locks
          .read()
          .await
          .values()
          .filter(|lock| lock.locked_by == backend.owner_id())
          .map(|lock| lock.profile_id.clone())
          .collect();

        for profile_id in held_locks {
          if let Err(error) = Self::send_heartbeat(&backend, &profile_id).await {
            log::warn!("{error}");
          }
        }
        if let Err(error) = PROFILE_LOCK.fetch_locks_with_backend(&backend).await {
          log::debug!("Failed to refresh profile locks: {error}");
        }
      }
    }));
  }
}

pub async fn acquire_team_lock_if_needed(
  profile: &crate::profile::BrowserProfile,
) -> Result<(), String> {
  if !profile.is_sync_enabled() {
    return Ok(());
  }
  if !PROFILE_LOCK.is_connected().await {
    PROFILE_LOCK.connect().await;
  }
  if !PROFILE_LOCK.is_connected().await {
    return match resolve_lock_backend().await? {
      Some(_) => Err("Failed to initialize profile locks".to_string()),
      None => Ok(()),
    };
  }
  PROFILE_LOCK.acquire_lock(&profile.id.to_string()).await
}

pub async fn release_team_lock_if_needed(profile: &crate::profile::BrowserProfile) {
  if !profile.is_sync_enabled() {
    return;
  }
  if let Err(error) = PROFILE_LOCK.release_lock(&profile.id.to_string()).await {
    log::warn!("Failed to release profile lock for {}: {error}", profile.id);
  }
}

#[tauri::command]
pub async fn get_team_locks() -> Result<Vec<ProfileLockInfo>, String> {
  Ok(PROFILE_LOCK.get_locks().await)
}

#[tauri::command]
pub async fn get_team_lock_status(profile_id: String) -> Result<Option<ProfileLockInfo>, String> {
  Ok(PROFILE_LOCK.get_lock_status(&profile_id).await)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lock_ownership_is_explicit_for_the_frontend() {
    let mut lock = ProfileLockInfo {
      profile_id: "profile-1".to_string(),
      locked_by: "device-a".to_string(),
      locked_by_email: "Workstation A".to_string(),
      locked_at: "2026-07-15T00:00:00Z".to_string(),
      expires_at: None,
      owned_by_current: false,
    };

    annotate_lock_ownership(&mut lock, "device-a");
    assert!(lock.owned_by_current);
    assert_eq!(serde_json::to_value(&lock).unwrap()["ownedByCurrent"], true);

    annotate_lock_ownership(&mut lock, "device-b");
    assert!(!lock.owned_by_current);
  }
}
