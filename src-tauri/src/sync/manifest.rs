use chrono::{DateTime, Utc};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use super::types::{SyncError, SyncResult};
use crate::profile::types::BrowserProfile;

pub(crate) const HIGH_VALUE_FILE_PATTERNS: &[&str] = &[
  "Cookies",
  "Login Data",
  "Local Storage",
  "Local State",
  "Preferences",
  "Secure Preferences",
  "Web Data",
  "History",
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
  "Sessions/",
  "Extension Cookies",
  "cookies.sqlite",
  "key4.db",
  "logins.json",
  "cert9.db",
  "places.sqlite",
  "formhistory.sqlite",
  "permissions.sqlite",
  "prefs.js",
  "storage.sqlite",
];

pub(crate) fn is_high_value_profile_file(path: &str) -> bool {
  HIGH_VALUE_FILE_PATTERNS
    .iter()
    .any(|pattern| path.contains(pattern))
}

/// Default exclude patterns for volatile browser profile files.
/// Patterns use `**/` prefix to match at any directory depth, since the sync
/// engine scans from `profiles/{uuid}/` which contains `profile/Default/...`.
pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &[
  "**/Cache/**",
  "**/Code Cache/**",
  "**/GPUCache/**",
  "**/GrShaderCache/**",
  "**/ShaderCache/**",
  "**/DawnCache/**",
  "**/DawnGraphiteCache/**",
  "**/Service Worker/CacheStorage/**",
  "**/Service Worker/ScriptCache/**",
  "**/Session Storage/**",
  "**/blob_storage/**",
  "**/Crashpad/**",
  "**/Crash Reports/**",
  "**/BrowserMetrics/**",
  "**/optimization_guide_model_store/**",
  "**/Safe Browsing/**",
  "**/component_crx_cache/**",
  "**/cache2/**",
  "**/startupCache/**",
  "**/safebrowsing/**",
  "**/storage/temporary/**",
  "**/storage/default/*/cache/**",
  "**/datareporting/**",
  "**/saved-telemetry-pings/**",
  "**/sessionstore-backups/**",
  "**/sessions/**",
  "**/serviceworker.txt",
  "**/AlternateServices.bin",
  "**/SiteSecurityServiceState.bin",
  "**/favicons.sqlite",
  "**/favicons.sqlite-*",
  "**/crashes/**",
  "**/minidumps/**",
  "*.tmp",
  "**/LOG",
  "**/LOG.old",
  "**/LOCK",
  "**/*-journal",
  "**/*-wal",
  "**/SingletonLock",
  "**/SingletonSocket",
  "**/SingletonCookie",
  "**/Secure Preferences",
  "**/GraphiteDawnCache/**",
  "**/DawnWebGPUCache/**",
  "**/BrowserMetrics*",
  "**/.DS_Store",
  ".donut-sync/**",
  // Orphaned local-only marker from earlier rollover-based fingerprint
  // regeneration. Keep excluding it so any markers left on disk from
  // prior builds never get uploaded.
  ".last-fp-refresh",
];

/// A single file entry in the manifest
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestFileEntry {
  pub path: String,
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

/// The sync manifest for a profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
  pub version: u32,
  #[serde(rename = "profileId")]
  pub profile_id: String,
  #[serde(rename = "generatedAt")]
  pub generated_at: String,
  #[serde(rename = "updatedAt")]
  pub updated_at: String,
  #[serde(rename = "excludeGlobs")]
  pub exclude_globs: Vec<String>,
  pub files: Vec<ManifestFileEntry>,
  #[serde(default)]
  pub encrypted: bool,
}

impl SyncManifest {
  pub fn new(profile_id: String, exclude_globs: Vec<String>) -> Self {
    let now = Utc::now().to_rfc3339();
    Self {
      version: 1,
      profile_id,
      generated_at: now.clone(),
      updated_at: now,
      exclude_globs,
      files: Vec::new(),
      encrypted: false,
    }
  }

  pub fn updated_at_datetime(&self) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&self.updated_at)
      .ok()
      .map(|dt| dt.with_timezone(&Utc))
  }
}

/// Local hash cache to avoid re-hashing unchanged files
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HashCache {
  pub entries: HashMap<String, HashCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashCacheEntry {
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

impl HashCache {
  pub fn load(cache_path: &Path) -> Self {
    if !cache_path.exists() {
      return Self::default();
    }

    match fs::read_to_string(cache_path) {
      Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
      Err(_) => Self::default(),
    }
  }

  pub fn save(&self, cache_path: &Path) -> SyncResult<()> {
    if let Some(parent) = cache_path.parent() {
      fs::create_dir_all(parent).map_err(|e| {
        SyncError::IoError(format!(
          "Failed to create cache directory {}: {e}",
          parent.display()
        ))
      })?;
    }

    let json = serde_json::to_string_pretty(self)
      .map_err(|e| SyncError::SerializationError(format!("Failed to serialize hash cache: {e}")))?;

    fs::write(cache_path, json).map_err(|e| {
      SyncError::IoError(format!(
        "Failed to write hash cache {}: {e}",
        cache_path.display()
      ))
    })?;

    Ok(())
  }

  pub fn get(&self, path: &str, size: u64, mtime: i64) -> Option<&str> {
    self.entries.get(path).and_then(|entry| {
      if entry.size == size && entry.mtime == mtime {
        Some(entry.hash.as_str())
      } else {
        None
      }
    })
  }

  pub fn insert(&mut self, path: String, size: u64, mtime: i64, hash: String) {
    self
      .entries
      .insert(path, HashCacheEntry { size, mtime, hash });
  }
}

/// Build a GlobSet from exclude patterns
fn build_exclude_globset(patterns: &[String]) -> SyncResult<GlobSet> {
  let mut builder = GlobSetBuilder::new();
  for pattern in patterns {
    let glob = Glob::new(pattern)
      .map_err(|e| SyncError::InvalidData(format!("Invalid exclude pattern '{}': {e}", pattern)))?;
    builder.add(glob);
  }
  builder
    .build()
    .map_err(|e| SyncError::InvalidData(format!("Failed to build exclude globset: {e}")))
}

/// Compute blake3 hash of a file
/// Returns None if the file doesn't exist (was deleted)
fn check_cancelled(cancel: Option<&AtomicBool>) -> SyncResult<()> {
  if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
    Err(SyncError::Cancelled)
  } else {
    Ok(())
  }
}

fn hash_file(path: &Path, cancel: Option<&AtomicBool>) -> Result<Option<String>, SyncError> {
  let file = match File::open(path) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to open {}: {e}",
        path.display()
      )));
    }
  };

  let mut reader = BufReader::new(file);
  let mut hasher = blake3::Hasher::new();
  let mut buffer = [0u8; 65536]; // 64KB buffer

  loop {
    check_cancelled(cancel)?;
    let bytes_read = reader
      .read(&mut buffer)
      .map_err(|e| SyncError::IoError(format!("Failed to read {}: {e}", path.display())))?;
    if bytes_read == 0 {
      break;
    }
    hasher.update(&buffer[..bytes_read]);
  }

  Ok(Some(hasher.finalize().to_hex().to_string()))
}

/// Compute blake3 hash of metadata.json after sanitizing volatile fields.
/// This prevents infinite sync loops where updating last_sync triggers a new sync.
fn hash_sanitized_metadata(path: &Path) -> Result<Option<String>, SyncError> {
  let content = match fs::read(path) {
    Ok(c) => c,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to read metadata at {}: {e}",
        path.display()
      )));
    }
  };

  Ok(Some(hash_manifest_bytes("metadata.json", &content)?))
}

/// Hash bytes exactly as manifest generation does. Transfer workers use this
/// before committing a file so the uploaded/downloaded object is guaranteed to
/// match the manifest that will become visible last.
pub(crate) fn hash_manifest_bytes(relative_path: &str, content: &[u8]) -> SyncResult<String> {
  if relative_path != "metadata.json" {
    return Ok(blake3::hash(content).to_hex().to_string());
  }

  let mut profile: BrowserProfile = serde_json::from_slice(content).map_err(|e| {
    SyncError::SerializationError(format!("Failed to parse metadata for hashing: {e}"))
  })?;

  // Sanitize volatile fields that should not trigger a re-sync
  profile.last_sync = None;
  profile.process_id = None;
  profile.last_launch = None;

  let sanitized_json = serde_json::to_string(&profile).map_err(|e| {
    SyncError::SerializationError(format!("Failed to serialize sanitized metadata: {e}"))
  })?;

  let mut hasher = blake3::Hasher::new();
  hasher.update(sanitized_json.as_bytes());

  Ok(hasher.finalize().to_hex().to_string())
}

/// Get mtime as nanoseconds since the Unix epoch.
///
/// Second precision can reuse a stale hash when Chromium rewrites a same-sized
/// database twice in one second. Nanoseconds also let directory mtimes carry
/// file deletions into the manifest ordering.
/// Returns None if the file doesn't exist (was deleted)
fn get_mtime(path: &Path) -> Result<Option<i64>, SyncError> {
  let metadata = match path.metadata() {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to get metadata for {}: {e}",
        path.display()
      )));
    }
  };

  let mtime = metadata
    .modified()
    .map_err(|e| SyncError::IoError(format!("Failed to get mtime for {}: {e}", path.display())))?;

  Ok(Some(
    mtime
      .duration_since(SystemTime::UNIX_EPOCH)
      .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
      .unwrap_or(0),
  ))
}

/// Generate a manifest for a profile directory
pub fn generate_manifest(
  profile_id: &str,
  profile_dir: &Path,
  cache: &mut HashCache,
) -> SyncResult<SyncManifest> {
  generate_manifest_inner(profile_id, profile_dir, cache, None)
}

pub(crate) fn generate_manifest_cancellable(
  profile_id: &str,
  profile_dir: &Path,
  cache: &mut HashCache,
  cancel: &AtomicBool,
) -> SyncResult<SyncManifest> {
  generate_manifest_inner(profile_id, profile_dir, cache, Some(cancel))
}

fn generate_manifest_inner(
  profile_id: &str,
  profile_dir: &Path,
  cache: &mut HashCache,
  cancel: Option<&AtomicBool>,
) -> SyncResult<SyncManifest> {
  check_cancelled(cancel)?;
  let exclude_patterns: Vec<String> = DEFAULT_EXCLUDE_PATTERNS
    .iter()
    .map(|s| s.to_string())
    .collect();
  let globset = build_exclude_globset(&exclude_patterns)?;

  let mut manifest = SyncManifest::new(profile_id.to_string(), exclude_patterns);

  if !profile_dir.exists() {
    log::debug!(
      "Profile directory doesn't exist: {}, creating empty manifest",
      profile_dir.display()
    );
    return Ok(manifest);
  }
  let mut max_mtime = get_mtime(profile_dir)?.unwrap_or(0);

  fn walk_dir(
    dir: &Path,
    base_dir: &Path,
    globset: &GlobSet,
    cache: &mut HashCache,
    files: &mut Vec<ManifestFileEntry>,
    max_mtime: &mut i64,
    cancel: Option<&AtomicBool>,
  ) -> SyncResult<()> {
    let entries = fs::read_dir(dir).map_err(|e| {
      SyncError::IoError(format!("Failed to read directory {}: {e}", dir.display()))
    })?;

    for entry in entries {
      check_cancelled(cancel)?;
      let entry = entry.map_err(|e| {
        SyncError::IoError(format!("Failed to read entry in {}: {e}", dir.display()))
      })?;

      let path = entry.path();
      let relative_path = path
        .strip_prefix(base_dir)
        .map_err(|_| SyncError::IoError("Failed to compute relative path".to_string()))?
        .to_string_lossy()
        .replace('\\', "/");

      // Check if excluded
      if globset.is_match(&relative_path) {
        continue;
      }

      // Get metadata - skip if file was deleted between directory read and metadata access
      let metadata = match path.metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
          log::debug!(
            "File disappeared during manifest generation, skipping: {}",
            path.display()
          );
          continue;
        }
        Err(e) => {
          return Err(SyncError::IoError(format!(
            "Failed to get metadata for {}: {e}",
            path.display()
          )));
        }
      };

      if metadata.is_dir() {
        if let Some(mtime) = get_mtime(&path)? {
          *max_mtime = (*max_mtime).max(mtime);
        }
        walk_dir(&path, base_dir, globset, cache, files, max_mtime, cancel)?;
      } else if metadata.is_file() {
        let size = metadata.len();
        let mtime = match get_mtime(&path)? {
          Some(m) => m,
          None => {
            // File was deleted, skip it
            log::debug!(
              "File disappeared during manifest generation, skipping: {}",
              path.display()
            );
            continue;
          }
        };

        *max_mtime = (*max_mtime).max(mtime);

        // Check cache for existing hash
        let hash = if relative_path == "metadata.json" {
          // Special case: sanitize metadata.json before hashing to prevent sync loops
          match hash_sanitized_metadata(&path)? {
            Some(computed_hash) => computed_hash,
            None => {
              log::debug!(
                "File disappeared during manifest generation, skipping: {}",
                path.display()
              );
              continue;
            }
          }
        } else {
          // Timestamp granularity is not guaranteed even when the platform
          // exposes nanoseconds. Rehash cheap files and state that would be
          // costly to lose; retain the cache for large, noncritical content.
          let cached_hash = if size > 64 * 1024 && !is_high_value_profile_file(&relative_path) {
            cache
              .get(&relative_path, size, mtime)
              .map(ToOwned::to_owned)
          } else {
            None
          };
          if let Some(cached_hash) = cached_hash {
            cached_hash
          } else {
            match hash_file(&path, cancel)? {
              Some(computed_hash) => {
                cache.insert(relative_path.clone(), size, mtime, computed_hash.clone());
                computed_hash
              }
              None => {
                // File was deleted, skip it
                log::debug!(
                  "File disappeared during manifest generation, skipping: {}",
                  path.display()
                );
                continue;
              }
            }
          }
        };

        files.push(ManifestFileEntry {
          path: relative_path,
          size,
          mtime,
          hash,
        });
      }
    }

    Ok(())
  }

  walk_dir(
    profile_dir,
    profile_dir,
    &globset,
    cache,
    &mut manifest.files,
    &mut max_mtime,
    cancel,
  )?;

  // Sort files for deterministic manifest
  manifest.files.sort_by(|a, b| a.path.cmp(&b.path));

  // Update the updatedAt timestamp to max mtime
  if max_mtime > 0 {
    let seconds = max_mtime / 1_000_000_000;
    let nanoseconds = (max_mtime % 1_000_000_000) as u32;
    if let Some(dt) = DateTime::from_timestamp(seconds, nanoseconds) {
      manifest.updated_at = dt.to_rfc3339();
    }
  }

  Ok(manifest)
}

/// Compute the diff between local and remote manifests
#[derive(Debug, Default)]
pub struct ManifestDiff {
  pub files_to_upload: Vec<ManifestFileEntry>,
  pub files_to_download: Vec<ManifestFileEntry>,
  pub files_to_delete_local: Vec<String>,
  pub files_to_delete_remote: Vec<String>,
}

/// Compare only the synchronized file set and hashes. Generation timestamps
/// and local mtimes are intentionally ignored: they are hints, not identity.
pub fn manifests_have_same_content(left: &SyncManifest, right: &SyncManifest) -> bool {
  if left.files.len() != right.files.len() {
    return false;
  }
  left
    .files
    .iter()
    .zip(&right.files)
    .all(|(left, right)| left.path == right.path && left.hash == right.hash)
}

/// Stable identity of the committed file set. This deliberately ignores
/// generation timestamps and local mtimes so it can be stored as remote object
/// metadata and compared without downloading or walking the profile.
pub fn manifest_content_hash(manifest: &SyncManifest) -> String {
  let mut files: Vec<_> = manifest.files.iter().collect();
  files.sort_by(|left, right| left.path.cmp(&right.path));

  let mut hasher = blake3::Hasher::new();
  hasher.update(&manifest.version.to_le_bytes());
  hasher.update(&(manifest.profile_id.len() as u64).to_le_bytes());
  hasher.update(manifest.profile_id.as_bytes());
  hasher.update(&[u8::from(manifest.encrypted)]);
  for file in files {
    hasher.update(&(file.path.len() as u64).to_le_bytes());
    hasher.update(file.path.as_bytes());
    hasher.update(&(file.hash.len() as u64).to_le_bytes());
    hasher.update(file.hash.as_bytes());
  }
  hasher.finalize().to_hex().to_string()
}

fn diff_local_to_remote(
  local_files: &HashMap<&str, &ManifestFileEntry>,
  remote_files: &HashMap<&str, &ManifestFileEntry>,
) -> ManifestDiff {
  let mut diff = ManifestDiff::default();
  for (path, local_entry) in local_files {
    match remote_files.get(path) {
      Some(remote_entry) if remote_entry.hash != local_entry.hash => {
        diff.files_to_upload.push((*local_entry).clone());
      }
      None => diff.files_to_upload.push((*local_entry).clone()),
      _ => {}
    }
  }
  for path in remote_files.keys() {
    if !local_files.contains_key(path) {
      diff.files_to_delete_remote.push(path.to_string());
    }
  }
  diff
}

fn diff_remote_to_local(
  local_files: &HashMap<&str, &ManifestFileEntry>,
  remote_files: &HashMap<&str, &ManifestFileEntry>,
) -> ManifestDiff {
  let mut diff = ManifestDiff::default();
  for (path, remote_entry) in remote_files {
    match local_files.get(path) {
      Some(local_entry) if local_entry.hash != remote_entry.hash => {
        diff.files_to_download.push((*remote_entry).clone());
      }
      None => diff.files_to_download.push((*remote_entry).clone()),
      _ => {}
    }
  }
  for path in local_files.keys() {
    if !remote_files.contains_key(path) {
      diff.files_to_delete_local.push(path.to_string());
    }
  }
  diff
}

fn has_browser_payload(manifest: &SyncManifest) -> bool {
  manifest
    .files
    .iter()
    .any(|file| file.path != "metadata.json")
}

impl ManifestDiff {
  pub fn is_empty(&self) -> bool {
    self.files_to_upload.is_empty()
      && self.files_to_download.is_empty()
      && self.files_to_delete_local.is_empty()
      && self.files_to_delete_remote.is_empty()
  }
}

/// Compute what needs to be synced between local and remote
pub fn compute_diff(local: &SyncManifest, remote: Option<&SyncManifest>) -> ManifestDiff {
  let Some(remote) = remote else {
    // No remote manifest - upload everything
    return ManifestDiff {
      files_to_upload: local.files.clone(),
      ..ManifestDiff::default()
    };
  };

  // Build hash maps for quick lookup
  let local_files: HashMap<&str, &ManifestFileEntry> =
    local.files.iter().map(|f| (f.path.as_str(), f)).collect();
  let remote_files: HashMap<&str, &ManifestFileEntry> =
    remote.files.iter().map(|f| (f.path.as_str(), f)).collect();

  // Safety: if local is empty but remote has files, always download from remote.
  // This prevents data loss when profile data files are deleted but metadata
  // survives — the newly generated manifest would have updated_at=NOW, which
  // would appear "newer" and cause all remote files to be deleted.
  if !has_browser_payload(local) && has_browser_payload(remote) {
    log::info!(
      "Local manifest is empty but remote has {} files — downloading from remote to recover",
      remote.files.len()
    );
    return ManifestDiff {
      files_to_download: remote.files.clone(),
      ..ManifestDiff::default()
    };
  }

  // Compare timestamps to determine direction
  let local_updated = local.updated_at_datetime();
  let remote_updated = remote.updated_at_datetime();

  let local_is_newer = match (local_updated, remote_updated) {
    (Some(l), Some(r)) => l > r,
    (Some(_), None) => true,
    (None, Some(_)) => false,
    (None, None) => true, // Default to uploading
  };

  if local_is_newer {
    diff_local_to_remote(&local_files, &remote_files)
  } else {
    diff_remote_to_local(&local_files, &remote_files)
  }
}

/// Compute a three-way diff using the last successfully synchronized manifest
/// as a baseline. With a profile lease, only one side should change at a time;
/// this makes direction independent of wall-clock skew between devices.
pub fn compute_diff_with_base(
  local: &SyncManifest,
  remote: Option<&SyncManifest>,
  base: Option<&SyncManifest>,
) -> ManifestDiff {
  let Some(remote) = remote else {
    return compute_diff(local, None);
  };
  if !has_browser_payload(local) && has_browser_payload(remote) {
    return compute_diff(local, Some(remote));
  }
  if manifests_have_same_content(local, remote) {
    return ManifestDiff::default();
  }

  let Some(base) = base else {
    return compute_diff(local, Some(remote));
  };
  let local_changed = !manifests_have_same_content(local, base);
  let remote_changed = !manifests_have_same_content(remote, base);
  let local_files: HashMap<&str, &ManifestFileEntry> = local
    .files
    .iter()
    .map(|file| (file.path.as_str(), file))
    .collect();
  let remote_files: HashMap<&str, &ManifestFileEntry> = remote
    .files
    .iter()
    .map(|file| (file.path.as_str(), file))
    .collect();

  match (local_changed, remote_changed) {
    (true, false) => diff_local_to_remote(&local_files, &remote_files),
    (false, true) => diff_remote_to_local(&local_files, &remote_files),
    // Both changed means an offline/concurrent edit escaped the supported
    // single-writer lease flow. Preserve legacy last-write-wins behavior.
    _ => compute_diff(local, Some(remote)),
  }
}

/// Get the path to the hash cache file for a profile
pub fn get_cache_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("cache.json")
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[test]
  fn test_hash_cache_operations() {
    let cache_dir = TempDir::new().unwrap();
    let cache_path = cache_dir.path().join("cache.json");

    let mut cache = HashCache::default();
    cache.insert(
      "test.txt".to_string(),
      100,
      1234567890,
      "abc123".to_string(),
    );

    assert_eq!(cache.get("test.txt", 100, 1234567890), Some("abc123"));
    assert_eq!(cache.get("test.txt", 100, 999), None); // Different mtime
    assert_eq!(cache.get("test.txt", 50, 1234567890), None); // Different size

    cache.save(&cache_path).unwrap();

    let loaded = HashCache::load(&cache_path);
    assert_eq!(loaded.get("test.txt", 100, 1234567890), Some("abc123"));
  }

  #[test]
  fn test_generate_manifest_empty_dir() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.profile_id, "test-profile");
    assert_eq!(manifest.version, 1);
    assert!(manifest.files.is_empty());
  }

  #[test]
  fn test_generate_manifest_with_files() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "hello").unwrap();
    fs::write(profile_dir.join("file2.txt"), "world").unwrap();
    fs::create_dir_all(profile_dir.join("subdir")).unwrap();
    fs::write(profile_dir.join("subdir/file3.txt"), "nested").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 3);
    assert!(manifest.files.iter().any(|f| f.path == "file1.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "file2.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "subdir/file3.txt"));
  }

  #[test]
  fn test_hash_cache_detects_same_size_rapid_rewrite() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();
    let file = profile_dir.join("Cookies");
    fs::write(&file, "aaaa").unwrap();

    let mut cache = HashCache::default();
    let before = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();
    fs::write(&file, "bbbb").unwrap();
    let after = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_ne!(before.files[0].hash, after.files[0].hash);
  }

  #[test]
  fn test_directory_mtime_records_file_deletion() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    let nested = profile_dir.join("Default");
    fs::create_dir_all(&nested).unwrap();
    let file = nested.join("obsolete.db");
    fs::write(&file, "obsolete").unwrap();

    let mut cache = HashCache::default();
    let before = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();
    // Some filesystems can assign the create and delete operations the same
    // timestamp quantum. The three-way baseline tests cover that fast-path;
    // this test specifically verifies that directory mtimes are incorporated.
    std::thread::sleep(std::time::Duration::from_millis(2));
    fs::remove_file(file).unwrap();
    let after = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert!(
      after.updated_at_datetime() > before.updated_at_datetime(),
      "deleting a file must advance the manifest timestamp"
    );
  }

  #[test]
  fn test_generate_manifest_excludes_cache() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "keep").unwrap();
    fs::create_dir_all(profile_dir.join("Cache")).unwrap();
    fs::write(profile_dir.join("Cache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("Code Cache")).unwrap();
    fs::write(profile_dir.join("Code Cache/wasm"), "exclude").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].path, "file1.txt");
  }

  #[test]
  fn test_generate_manifest_excludes_nested_caches() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile_root");
    fs::create_dir_all(&profile_dir).unwrap();

    // Simulate real Chromium structure: profile/Default/Cache/...
    let default_dir = profile_dir.join("profile/Default");
    fs::create_dir_all(&default_dir).unwrap();
    fs::write(default_dir.join("Cookies"), "keep").unwrap();
    fs::create_dir_all(default_dir.join("Cache")).unwrap();
    fs::write(default_dir.join("Cache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Code Cache/js")).unwrap();
    fs::write(default_dir.join("Code Cache/js/abc"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("GPUCache")).unwrap();
    fs::write(default_dir.join("GPUCache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Session Storage")).unwrap();
    fs::write(default_dir.join("Session Storage/000003.log"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Local Storage/leveldb")).unwrap();
    fs::write(default_dir.join("Local Storage/leveldb/000001.ldb"), "keep").unwrap();

    // Caches at user-data-dir level
    fs::create_dir_all(profile_dir.join("profile/ShaderCache")).unwrap();
    fs::write(profile_dir.join("profile/ShaderCache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("profile/Crashpad")).unwrap();
    fs::write(profile_dir.join("profile/Crashpad/report"), "exclude").unwrap();

    // metadata.json at root
    let profile = BrowserProfile::default();
    fs::write(
      profile_dir.join("metadata.json"),
      serde_json::to_string(&profile).unwrap(),
    )
    .unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
      paths.contains(&"metadata.json"),
      "metadata.json should be synced"
    );
    assert!(
      paths.contains(&"profile/Default/Cookies"),
      "Cookies should be synced"
    );
    assert!(
      paths.contains(&"profile/Default/Local Storage/leveldb/000001.ldb"),
      "Local Storage should be synced"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Cache")),
      "Cache directories should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Session Storage")),
      "Session Storage should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Crashpad")),
      "Crashpad should be excluded: {paths:?}"
    );
  }

  #[test]
  fn test_compute_diff_upload_all_when_no_remote() {
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "file1.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "file2.txt".to_string(),
          size: 20,
          mtime: 2000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, None);

    assert_eq!(diff.files_to_upload.len(), 2);
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
  }

  #[test]
  fn test_compute_diff_detect_changes() {
    let old_time = "2024-01-01T00:00:00Z";
    let new_time = "2024-01-02T00:00:00Z";

    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: new_time.to_string(),
      updated_at: new_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 2000,
          hash: "new_hash".to_string(),
        },
        ManifestFileEntry {
          path: "new_file.txt".to_string(),
          size: 5,
          mtime: 3000,
          hash: "new".to_string(),
        },
      ],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: old_time.to_string(),
      updated_at: old_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "old_hash".to_string(),
        },
        ManifestFileEntry {
          path: "deleted.txt".to_string(),
          size: 8,
          mtime: 500,
          hash: "gone".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Local is newer, so we upload changed/new and delete remote-only
    assert_eq!(diff.files_to_upload.len(), 2); // changed + new
    assert!(diff.files_to_upload.iter().any(|f| f.path == "changed.txt"));
    assert!(diff
      .files_to_upload
      .iter()
      .any(|f| f.path == "new_file.txt"));
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert_eq!(diff.files_to_delete_remote.len(), 1);
    assert!(diff
      .files_to_delete_remote
      .contains(&"deleted.txt".to_string()));
  }

  #[test]
  fn test_manifest_encrypted_flag_default() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[]}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(!manifest.encrypted);
  }

  #[test]
  fn test_manifest_with_encrypted_flag() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[],"encrypted":true}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(manifest.encrypted);

    let serialized = serde_json::to_string(&manifest).unwrap();
    let deserialized: SyncManifest = serde_json::from_str(&serialized).unwrap();
    assert!(deserialized.encrypted);
  }

  #[test]
  fn test_compute_diff_empty_local_downloads_from_remote() {
    // When local has no files but remote does, always download from remote.
    // This prevents data loss when profile data is deleted but metadata survives.
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(), // NOW — appears newer than remote
      exclude_globs: vec![],
      files: vec![ManifestFileEntry {
        path: "metadata.json".to_string(),
        size: 10,
        mtime: 1000,
        hash: "metadata".to_string(),
      }],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: "2024-01-01T00:00:00Z".to_string(),
      updated_at: "2024-01-01T00:00:00Z".to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "Cookies".to_string(),
          size: 100,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "Local State".to_string(),
          size: 200,
          mtime: 1000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Must download all remote files, NOT delete them
    assert_eq!(diff.files_to_download.len(), 2);
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
  }

  #[test]
  fn test_generate_manifest_sanitizes_metadata() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    let profile_id = uuid::Uuid::new_v4();
    let metadata_path = profile_dir.join("metadata.json");

    let profile = BrowserProfile {
      id: profile_id,
      name: "test-profile".to_string(),
      last_sync: Some(100),
      process_id: Some(1234),
      ..Default::default()
    };

    fs::write(&metadata_path, serde_json::to_string(&profile).unwrap()).unwrap();

    let mut cache = HashCache::default();
    let manifest1 = generate_manifest(&profile_id.to_string(), &profile_dir, &mut cache).unwrap();
    let hash1 = manifest1
      .files
      .iter()
      .find(|f| f.path == "metadata.json")
      .unwrap()
      .hash
      .clone();

    // Update volatile fields
    let profile2 = BrowserProfile {
      id: profile_id,
      name: "test-profile".to_string(),
      last_sync: Some(200),
      process_id: Some(5678),
      ..Default::default()
    };

    fs::write(&metadata_path, serde_json::to_string(&profile2).unwrap()).unwrap();

    let manifest2 = generate_manifest(&profile_id.to_string(), &profile_dir, &mut cache).unwrap();
    let hash2 = manifest2
      .files
      .iter()
      .find(|f| f.path == "metadata.json")
      .unwrap()
      .hash
      .clone();

    // Hash should be identical because volatile fields are sanitized
    assert_eq!(
      hash1, hash2,
      "Metadata hash should be stable across last_sync/process_id updates"
    );

    // Change a non-volatile field
    let profile3 = BrowserProfile {
      id: profile_id,
      name: "changed-name".to_string(),
      last_sync: Some(200),
      ..Default::default()
    };

    fs::write(&metadata_path, serde_json::to_string(&profile3).unwrap()).unwrap();

    let manifest3 = generate_manifest(&profile_id.to_string(), &profile_dir, &mut cache).unwrap();
    let hash3 = manifest3
      .files
      .iter()
      .find(|f| f.path == "metadata.json")
      .unwrap()
      .hash
      .clone();

    // Hash should be different because name changed
    assert_ne!(
      hash1, hash3,
      "Metadata hash should change when non-volatile fields change"
    );
  }

  #[test]
  fn test_base_manifest_beats_clock_skew_for_local_edit() {
    let entry = |hash: &str| ManifestFileEntry {
      path: "Cookies".to_string(),
      size: 10,
      mtime: 1,
      hash: hash.to_string(),
    };
    let manifest = |updated_at: &str, hash: &str| SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: updated_at.to_string(),
      updated_at: updated_at.to_string(),
      exclude_globs: vec![],
      files: vec![entry(hash)],
      encrypted: false,
    };

    let base = manifest("2026-01-01T12:00:00Z", "base");
    let remote = manifest("2026-01-01T12:00:00Z", "base");
    // This device's wall clock is five minutes behind, but its file changed
    // after the last successful handoff.
    let local = manifest("2026-01-01T11:55:00Z", "local-edit");

    let diff = compute_diff_with_base(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_upload.len(), 1);
    assert!(diff.files_to_download.is_empty());
  }

  #[test]
  fn test_base_manifest_beats_clock_skew_for_remote_edit() {
    let entry = |hash: &str| ManifestFileEntry {
      path: "Cookies".to_string(),
      size: 10,
      mtime: 1,
      hash: hash.to_string(),
    };
    let manifest = |updated_at: &str, hash: &str| SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: updated_at.to_string(),
      updated_at: updated_at.to_string(),
      exclude_globs: vec![],
      files: vec![entry(hash)],
      encrypted: false,
    };

    let base = manifest("2026-01-01T12:00:00Z", "base");
    let local = manifest("2026-01-01T12:00:00Z", "base");
    // The remote device's clock is behind, but its content is the only side
    // that changed from the shared baseline.
    let remote = manifest("2026-01-01T11:55:00Z", "remote-edit");

    let diff = compute_diff_with_base(&local, Some(&remote), Some(&base));
    assert_eq!(diff.files_to_download.len(), 1);
    assert!(diff.files_to_upload.is_empty());
  }

  #[test]
  fn manifest_generation_stops_immediately_when_launch_preempts_sync() {
    let temp_dir = TempDir::new().unwrap();
    fs::write(temp_dir.path().join("Cookies"), vec![7_u8; 1024]).unwrap();
    let cancelled = AtomicBool::new(true);
    let result = generate_manifest_cancellable(
      "profile",
      temp_dir.path(),
      &mut HashCache::default(),
      &cancelled,
    );
    assert!(matches!(result, Err(SyncError::Cancelled)));
  }

  #[test]
  fn manifest_content_hash_tracks_only_the_committed_file_set() {
    let mut first = SyncManifest::new("profile".to_string(), vec![]);
    first.files = vec![
      ManifestFileEntry {
        path: "b".to_string(),
        size: 2,
        mtime: 10,
        hash: "hash-b".to_string(),
      },
      ManifestFileEntry {
        path: "a".to_string(),
        size: 1,
        mtime: 20,
        hash: "hash-a".to_string(),
      },
    ];
    let mut equivalent = first.clone();
    equivalent.generated_at = "different".to_string();
    equivalent.updated_at = "different".to_string();
    equivalent.files.reverse();
    equivalent.files[0].mtime = 999;

    assert_eq!(
      manifest_content_hash(&first),
      manifest_content_hash(&equivalent)
    );
    equivalent.files[0].hash = "changed".to_string();
    assert_ne!(
      manifest_content_hash(&first),
      manifest_content_hash(&equivalent)
    );
  }
}
