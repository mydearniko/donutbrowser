fn main() {
  println!("cargo::rustc-check-cfg=cfg(mobile)");

  // Ensure dist folder exists for tauri::generate_context!() macro
  // This allows running cargo test without building the frontend first
  ensure_dist_folder_exists();

  // Generate tray icon PNG files from SVG (macOS template icon format)
  generate_tray_icons();

  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
    println!("cargo:rustc-link-lib=framework=CoreServices");
  }

  // Inject build version based on environment variables set by CI
  if let Ok(build_tag) = std::env::var("BUILD_TAG") {
    // Custom BUILD_TAG takes highest priority (used for nightly builds)
    println!("cargo:rustc-env=BUILD_VERSION={build_tag}");
  } else if let Ok(tag_name) = std::env::var("GITHUB_REF_NAME") {
    // This is set by GitHub Actions to the tag name (e.g., "v1.0.0")
    println!("cargo:rustc-env=BUILD_VERSION={tag_name}");
  } else if std::env::var("STABLE_RELEASE").is_ok() {
    // Fallback for stable releases - use CARGO_PKG_VERSION with 'v' prefix
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.1.0".to_string());
    println!("cargo:rustc-env=BUILD_VERSION=v{version}");
  } else if let Ok(commit_hash) = std::env::var("GITHUB_SHA") {
    // For nightly builds, use timestamp format or fallback to commit hash
    let short_hash = &commit_hash[0..7.min(commit_hash.len())];
    println!("cargo:rustc-env=BUILD_VERSION=nightly-{short_hash}");
  } else {
    // Development build fallback
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.1.0".to_string());
    println!("cargo:rustc-env=BUILD_VERSION=dev-{version}");
  }

  // Inject the exact commit so the log identifies which build is running
  // (debugging "that build is old" reports). GITHUB_SHA is set by GitHub
  // Actions; locally we read the working tree's HEAD.
  let commit = if let Ok(sha) = std::env::var("GITHUB_SHA") {
    sha.chars().take(7).collect::<String>()
  } else {
    std::process::Command::new("git")
      .args(["rev-parse", "--short", "HEAD"])
      .output()
      .ok()
      .filter(|o| o.status.success())
      .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
      .unwrap_or_else(|| "unknown".to_string())
  };
  println!("cargo:rustc-env=COMMIT_SHA={commit}");

  // Inject vault password at build time
  if let Ok(vault_password) = std::env::var("DONUT_BROWSER_VAULT_PASSWORD") {
    println!("cargo:rustc-env=DONUT_BROWSER_VAULT_PASSWORD={vault_password}");
  } else {
    // Use default password if environment variable is not set
    println!("cargo:rustc-env=DONUT_BROWSER_VAULT_PASSWORD=donutbrowser-api-vault-password");
  }

  // Tell Cargo to rebuild if the proxy binary source changes
  println!("cargo:rerun-if-changed=src/bin/proxy_server.rs");
  println!("cargo:rerun-if-changed=src/proxy_server.rs");
  println!("cargo:rerun-if-changed=src/proxy_runner.rs");
  println!("cargo:rerun-if-changed=src/proxy_storage.rs");

  // Tell Cargo to rebuild when binaries directory contents change
  // This ensures tauri_build is re-run after sidecar binaries are copied
  println!("cargo:rerun-if-changed=binaries");

  // Run tauri_build only when it won't hit missing external sidecars.
  // tauri_build ALSO compiles the runtime ACL (capabilities) into OUT_DIR,
  // which tauri::generate_context embeds. If it never runs the embedded ACL
  // is EMPTY and every `core:` command is denied at runtime — the
  // "Command plugin:event|listen not allowed by ACL" toasts, window close /
  // minimize / start-dragging all dead — while custom #[tauri::command]s
  // still work, a confusingly half-broken app. Its only step that needs the
  // donut-proxy sidecar is the final external-binary copy, so when the
  // sidecar is absent we still run it to emit the ACL (and tolerate that
  // expected failure; release packaging stages the sidecar itself).
  if external_binaries_exist() {
    tauri_build::build();

    // tauri_build embeds the manifest for bin targets only (cargo:rustc-link-arg-bins).
    // Test binaries (including `cargo test --lib`) also need the comctl32 v6 manifest
    // or they crash with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). We embed the
    // manifest for all targets, then suppress the duplicate for bins with /MANIFEST:NO
    // (tauri_build's resource-embedded manifest still takes effect for bins).
    #[cfg(target_os = "windows")]
    {
      embed_windows_manifest();
      println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
  } else {
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::default()) {
      println!(
        "cargo:warning=tauri_build emitted the ACL but skipped the sidecar copy (donut-proxy not built yet): {e}"
      );
    }

    #[cfg(target_os = "windows")]
    embed_windows_manifest();
  }
}

fn external_binaries_exist() -> bool {
  use std::env;
  use std::path::PathBuf;

  let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
    Ok(dir) => dir,
    Err(_) => return false,
  };

  let target = match env::var("TARGET") {
    Ok(t) => t,
    Err(_) => return false,
  };

  let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");

  // Check for all required external binaries (must match tauri.conf.json externalBin)
  let donut_proxy_name = if target.contains("windows") {
    format!("donut-proxy-{}.exe", target)
  } else {
    format!("donut-proxy-{}", target)
  };

  binaries_dir.join(&donut_proxy_name).exists()
}

fn ensure_dist_folder_exists() {
  use std::fs;
  use std::path::PathBuf;

  let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
  let dist_dir = PathBuf::from(&manifest_dir).join("..").join("dist");

  if !dist_dir.exists() {
    fs::create_dir_all(&dist_dir).expect("Failed to create dist directory");
    let index_path = dist_dir.join("index.html");
    fs::write(
      &index_path,
      "<!DOCTYPE html><html><head></head><body></body></html>",
    )
    .expect("Failed to create stub index.html");
    println!(
      "cargo:warning=Created stub dist folder for compilation. Run 'pnpm build' for full frontend."
    );
  }

  println!("cargo:rerun-if-changed=../dist");
}

#[cfg(target_os = "windows")]
fn embed_windows_manifest() {
  use std::path::PathBuf;

  let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
  let manifest_path = PathBuf::from(&manifest_dir).join("app.manifest");

  if !manifest_path.exists() {
    println!("cargo:warning=app.manifest not found, skipping manifest embedding");
    return;
  }

  // Use the path directly (avoid canonicalize which adds \\?\ prefix that mt.exe rejects)
  let manifest_str = manifest_path.to_str().unwrap().replace('/', "\\");
  println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
  println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest_str}");
  println!("cargo:rerun-if-changed=app.manifest");
}

fn generate_tray_icons() {
  use resvg::tiny_skia::{Pixmap, Transform};
  use resvg::usvg::{Options, Tree};
  use std::fs;
  use std::path::PathBuf;

  let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
  let icons_dir = PathBuf::from(&manifest_dir).join("icons");
  let svg_path = icons_dir.join("tray-icon.svg");

  println!("cargo:rerun-if-changed=icons/tray-icon.svg");

  if !svg_path.exists() {
    println!("cargo:warning=tray-icon.svg not found, skipping tray icon generation");
    return;
  }

  let svg_data = fs::read(&svg_path).expect("Failed to read tray-icon.svg");
  let tree = Tree::from_data(&svg_data, &Options::default()).expect("Failed to parse SVG");

  // Generate template icons at different sizes for macOS menu bar
  // 22x22 is standard, 44x44 is retina (@2x)
  let sizes = [(22, "tray-icon-22.png"), (44, "tray-icon-44.png")];

  for (size, filename) in sizes {
    let mut pixmap = Pixmap::new(size, size).expect("Failed to create pixmap");

    let svg_size = tree.size();
    let scale = size as f32 / svg_size.width().max(svg_size.height());
    let transform = Transform::from_scale(scale, scale);

    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // Convert to template icon format: black silhouette with alpha channel
    // macOS will automatically handle light/dark mode by inverting the icon
    // For template icons: RGB should be 0,0,0 (black) and alpha controls visibility
    let data = pixmap.data_mut();
    for pixel in data.chunks_exact_mut(4) {
      // Keep the original alpha (shows where icon content is)
      // but make the color black for template icon format
      pixel[0] = 0; // R
      pixel[1] = 0; // G
      pixel[2] = 0; // B
                    // pixel[3] (alpha) stays as-is
    }

    let output_path = icons_dir.join(filename);
    save_png_if_changed(&pixmap, &output_path);
  }

  // Generate a full-color icon for Windows tray (no template conversion)
  {
    let size = 44u32;
    let mut pixmap = Pixmap::new(size, size).expect("Failed to create pixmap");

    let svg_size = tree.size();
    let scale = size as f32 / svg_size.width().max(svg_size.height());
    let transform = Transform::from_scale(scale, scale);

    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let output_path = icons_dir.join("tray-icon-win-44.png");
    save_png_if_changed(&pixmap, &output_path);
  }
}

fn save_png_if_changed(pixmap: &resvg::tiny_skia::Pixmap, output_path: &std::path::Path) {
  let png = pixmap.encode_png().expect("Failed to encode tray icon PNG");
  if std::fs::read(output_path).is_ok_and(|existing| existing == png) {
    return;
  }
  std::fs::write(output_path, png).expect("Failed to save tray icon PNG");
}
