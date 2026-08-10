//! Trash bin for profiles.
//!
//! A deleted profile is not removed outright — it is compressed into a
//! recoverable archive under `data_dir()/trash` so the user can restore
//! it later. Purging removes the archive for good.
//!
//! Per trashed profile `{uuid}`:
//! - `trash/{uuid}.tar.gz` — the whole profile dir (`metadata.json` +
//!   browser data), minus rebuildable browser caches, gzip level 9.
//! - `trash/{uuid}.json`   — slim index (name, browser, timestamps,
//!   sizes) so `list_trash` needs no decompression.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use tar::Builder as TarBuilder;
use uuid::Uuid;

use crate::profile::BrowserProfile;

/// Emitted whenever the trash changes (restore / purge / empty) so the
/// frontend can refresh its trash list without re-questioning profiles.
pub const TRASH_EVENT: &str = "trash-changed";

/// Directory names treated as rebuildable browser caches. Chrome-family
/// caches are large and already-compressed; skipping them is the single
/// biggest space win for a profile sitting in the trash.
const SKIP_DIRS: &[&str] = &[
  "cache",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "DawnWebGPU",
  "GraphicsPipelineCache",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
  pub id: String,
  pub name: String,
  pub browser: String,
  pub version: String,
  pub deleted_at: u64,
  pub original_size: u64,
  pub archive_size: u64,
}

impl TrashEntry {
  fn archive_path(&self) -> PathBuf {
    trash_dir().join(format!("{}.tar.gz", self.id))
  }

  fn index_path(&self) -> PathBuf {
    trash_dir().join(format!("{}.json", self.id))
  }
}

fn trash_dir() -> PathBuf {
  crate::app_dirs::data_dir().join("trash")
}

fn is_skippable(name: &str) -> bool {
  SKIP_DIRS.contains(&name)
}

/// Best-effort byte size of a file tree (does not follow symlinks).
fn tree_size(path: &Path) -> u64 {
  let Ok(meta) = fs::symlink_metadata(path) else {
    return 0;
  };
  if meta.is_file() {
    return meta.len();
  }
  if !meta.is_dir() {
    return 0;
  }
  let Ok(entries) = fs::read_dir(path) else {
    return 0;
  };
  entries
    .flatten()
    .map(|entry| tree_size(&entry.path()))
    .sum()
}

/// Recursively append `path` into the tar builder, with entries stored
/// relative to `root`, skipping rebuildable cache directories.
fn append_paths(
  builder: &mut TarBuilder<GzEncoder<BufWriter<fs::File>>>,
  root: &Path,
  path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
  for entry in fs::read_dir(path)? {
    let entry = entry?;
    let src = entry.path();
    let name = entry.file_name();
    let name = name.to_string_lossy();

    if src.is_dir() && is_skippable(&name) {
      log::info!("Trash: skipping cache dir {}", src.display());
      continue;
    }

    let rel = src.strip_prefix(root)?;
    if src.is_dir() {
      builder.append_dir(rel, &src)?;
      append_paths(builder, root, &src)?;
    } else if src.is_file() {
      // append_path_with_name dereferences symlinks, which is what we want:
      // the archive should carry file contents, never dangling links.
      builder.append_path_with_name(&src, rel)?;
    }
  }
  Ok(())
}

/// Compress a profile directory into the trash and write its index.
/// The original directory is left untouched — the caller removes it.
pub fn trash_profile(
  src_dir: &Path,
  profile: &BrowserProfile,
) -> Result<TrashEntry, Box<dyn std::error::Error>> {
  let dir = trash_dir();
  fs::create_dir_all(&dir)?;

  let id = profile.id.to_string();
  let archive_path = dir.join(format!("{id}.tar.gz"));
  let index_path = dir.join(format!("{id}.json"));

  let file = fs::File::create(&archive_path)?;
  let encoder = GzEncoder::new(BufWriter::new(file), Compression::best());
  let mut builder = TarBuilder::new(encoder);
  append_paths(&mut builder, src_dir, src_dir)?;
  let encoder = builder.into_inner()?;
  encoder.finish()?;

  let entry = TrashEntry {
    id,
    name: profile.name.clone(),
    browser: profile.browser.clone(),
    version: profile.version.clone(),
    deleted_at: crate::proxy_manager::now_secs(),
    original_size: tree_size(src_dir),
    archive_size: fs::metadata(&archive_path)?.len(),
  };

  fs::write(&index_path, serde_json::to_string_pretty(&entry)?)?;

  log::info!(
    "Trashed profile {} ({}): {} -> {} bytes",
    profile.id,
    profile.name,
    entry.original_size,
    entry.archive_size
  );
  Ok(entry)
}

/// List every trashed profile, most recently deleted first.
pub fn list_trash() -> Result<Vec<TrashEntry>, Box<dyn std::error::Error>> {
  let dir = trash_dir();
  if !dir.exists() {
    return Ok(vec![]);
  }
  let mut entries = Vec::new();
  for entry in fs::read_dir(&dir)? {
    let path = entry?.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    if let Ok(content) = fs::read_to_string(&path) {
      if let Ok(entry) = serde_json::from_str::<TrashEntry>(&content) {
        entries.push(entry);
      }
    }
  }
  entries.sort_by_key(|b| std::cmp::Reverse(b.deleted_at));
  Ok(entries)
}

fn find_entry(id: &str) -> Result<TrashEntry, Box<dyn std::error::Error>> {
  Ok(
    list_trash()?
      .into_iter()
      .find(|e| e.id == id)
      .ok_or_else(|| format!("Trashed profile '{id}' not found"))?,
  )
}

/// Decompress a trashed profile back into `profiles_dir`, then remove it
/// from the trash. Returns the restored profile metadata.
pub fn restore_profile(
  profiles_dir: &Path,
  id: &str,
) -> Result<BrowserProfile, Box<dyn std::error::Error>> {
  let entry = find_entry(id)?;
  let profile_uuid =
    Uuid::parse_str(&entry.id).map_err(|_| format!("Invalid trashed profile ID: {}", entry.id))?;
  let dest = profiles_dir.join(profile_uuid.to_string());

  if dest.exists() {
    return Err(
      serde_json::json!({ "code": "PROFILE_ALREADY_EXISTS" })
        .to_string()
        .into(),
    );
  }

  let archive_path = entry.archive_path();
  if !archive_path.exists() {
    return Err(format!("Trash archive for profile '{}' is missing", entry.id).into());
  }

  // Extract into a staging dir, then move in, so a partial extraction
  // never leaves a half-restored profile directory behind.
  let dir = trash_dir();
  let staging = dir.join(format!(".restore-{profile_uuid}"));
  let _ = fs::remove_dir_all(&staging);
  fs::create_dir_all(&staging)?;

  let result = (|| -> Result<(), Box<dyn std::error::Error>> {
    let file = fs::File::open(&archive_path)?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&staging)?;

    fs::create_dir_all(&dest)?;
    for entry in fs::read_dir(&staging)? {
      let entry = entry?;
      fs::rename(entry.path(), dest.join(entry.file_name()))?;
    }
    Ok(())
  })();
  let _ = fs::remove_dir_all(&staging);
  result?;

  // Trash should hold at most one version of a profile; clear it out.
  let _ = fs::remove_file(&archive_path);
  let _ = fs::remove_file(entry.index_path());

  let metadata_path = dest.join("metadata.json");
  let content = fs::read_to_string(&metadata_path)?;
  let profile: BrowserProfile = serde_json::from_str(&content)?;

  log::info!(
    "Restored profile {} ({}) from trash",
    profile.id,
    profile.name
  );
  Ok(profile)
}

/// Permanently delete a single trashed profile.
pub fn purge_profile(id: &str) -> Result<(), Box<dyn std::error::Error>> {
  let entry = find_entry(id)?;
  let _ = fs::remove_file(entry.archive_path());
  let _ = fs::remove_file(entry.index_path());
  log::info!("Purged profile {id} from trash");
  Ok(())
}

/// Permanently delete every trashed profile.
pub fn empty_trash() -> Result<(), Box<dyn std::error::Error>> {
  let dir = trash_dir();
  if !dir.exists() {
    return Ok(());
  }
  let mut removed = 0u32;
  for entry in fs::read_dir(&dir)? {
    let path = entry?.path();
    if path.is_dir() {
      fs::remove_dir_all(&path)?;
      removed += 1;
    } else if path.is_file() {
      fs::remove_file(&path)?;
      removed += 1;
    }
  }
  log::info!("Emptied trash (removed {removed} files)");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  struct Fixture {
    _tmp: TempDir,
    _guard: crate::app_dirs::TestDirGuard,
    profiles_dir: PathBuf,
    profile: BrowserProfile,
  }

  fn fixture(with_cache: bool) -> Fixture {
    let tmp = TempDir::new().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().join("data"));
    let profiles_dir = crate::app_dirs::data_dir().join("profiles");

    let id = Uuid::new_v4();
    let profile = BrowserProfile {
      id,
      name: "Agent Smith".into(),
      browser: "wayfern".into(),
      version: "0.0.0".into(),
      ..Default::default()
    };

    let src = profiles_dir.join(id.to_string());
    fs::create_dir_all(src.join("profile")).unwrap();
    fs::write(
      src.join("metadata.json"),
      serde_json::to_string(&profile).unwrap(),
    )
    .unwrap();
    fs::write(
      src.join("profile").join("Preferences"),
      "{repeatable}".repeat(40),
    )
    .unwrap();
    fs::create_dir_all(src.join("profile").join("Local Storage").join("leveldb")).unwrap();
    fs::write(
      src
        .join("profile")
        .join("Local Storage")
        .join("leveldb")
        .join("CURRENT"),
      vec![0u8; 4096],
    )
    .unwrap();

    if with_cache {
      // Rebuildable browser caches must be excluded from the archive.
      fs::create_dir_all(src.join("profile").join("Cache")).unwrap();
      fs::write(
        src.join("profile").join("Cache").join("f_000001"),
        vec![0u8; 250_000],
      )
      .unwrap();
    }

    Fixture {
      _tmp: tmp,
      _guard,
      profiles_dir,
      profile,
    }
  }

  #[test]
  fn test_trash_restore_roundtrip() {
    let fixture = fixture(true);
    let src = fixture.profiles_dir.join(fixture.profile.id.to_string());

    let entry = trash_profile(&src, &fixture.profile).unwrap();
    assert_eq!(entry.id, fixture.profile.id.to_string());
    // The rebuildable 250KB cache is excluded, so the archive is small.
    assert!(entry.original_size < 300_000, "cache should be skipped");
    assert!(entry.archive_size > 0);

    // Original dir is left intact by trash_profile (caller removes it).
    assert!(src.join("metadata.json").exists());

    // Simulate the caller removing the original directory after trashing.
    fs::remove_dir_all(&src).unwrap();
    assert!(!src.exists());

    // Restore brings the profile back, minus the skipped cache.
    let restored = restore_profile(&fixture.profiles_dir, &entry.id).unwrap();
    assert_eq!(restored.name, "Agent Smith");
    assert!(src.join("metadata.json").exists());
    assert!(src.join("profile").join("Preferences").exists());
    assert!(src
      .join("profile")
      .join("Local Storage")
      .join("leveldb")
      .exists());
    assert!(
      !src.join("profile").join("Cache").exists(),
      "Cache must be omitted from the trash archive"
    );

    // Trash is empty after restore.
    assert!(list_trash().unwrap().is_empty());
  }

  #[test]
  fn test_trash_restore_into_existing_dir_fails() {
    let fixture = fixture(false);
    let src = fixture.profiles_dir.join(fixture.profile.id.to_string());
    trash_profile(&src, &fixture.profile).unwrap();
    // Do not remove the original; restore must still work from the archive.
    let err = restore_profile(&fixture.profiles_dir, &fixture.profile.id.to_string()).unwrap_err();
    assert!(err.to_string().contains("PROFILE_ALREADY_EXISTS"));
  }

  #[test]
  fn test_list_purge_empty() {
    let fixture = fixture(false);
    let src = fixture.profiles_dir.join(fixture.profile.id.to_string());
    trash_profile(&src, &fixture.profile).unwrap();

    let second = BrowserProfile {
      id: Uuid::new_v4(),
      name: "Trinity".into(),
      browser: "wayfern".into(),
      ..Default::default()
    };
    let src2 = fixture.profiles_dir.join(second.id.to_string());
    fs::create_dir_all(&src2).unwrap();
    fs::write(
      src2.join("metadata.json"),
      serde_json::to_string(&second).unwrap(),
    )
    .unwrap();
    trash_profile(&src2, &second).unwrap();

    let listed = list_trash().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed
      .iter()
      .any(|e| e.id == fixture.profile.id.to_string()));

    purge_profile(&fixture.profile.id.to_string()).unwrap();
    let listed = list_trash().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Trinity");

    empty_trash().unwrap();
    assert!(list_trash().unwrap().is_empty());

    // Purging an unknown id errors.
    assert!(purge_profile(&Uuid::new_v4().to_string()).is_err());
  }
}
