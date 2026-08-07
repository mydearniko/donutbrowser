#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
windows_target="x86_64-pc-windows-gnu"
# Named Cargo profile used only by this portable packaging script; the normal
# `release` profile (macOS/Linux) is left untouched.
windows_profile="release-portable"
release_dir="$project_dir/src-tauri/target/$windows_target/$windows_profile"
app_binary="$release_dir/donutbrowser.exe"
proxy_binary="$release_dir/donut-proxy.exe"
loader_binary="$release_dir/WebView2Loader.dll"
staged_proxy="$project_dir/src-tauri/binaries/donut-proxy-$windows_target.exe"
core_count="$(nproc)"

for required_command in cargo node pnpm 7z file sha256sum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

app_version="$(
  cd "$project_dir"
  node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version'
)"
default_output="/tmp/Donut_${app_version}_$(date +%Y%m%d-%H%M%S)_x64-portable.zip"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
output_path="${1:-$default_output}"

if (( $# > 1 )); then
  echo "Usage: $0 [output.zip]" >&2
  exit 1
fi
if [[ "$output_path" != /* ]]; then
  output_path="$PWD/$output_path"
fi
if [[ -e "$output_path" ]]; then
  echo "Refusing to overwrite existing output: $output_path" >&2
  exit 1
fi
if [[ ! -d "$(dirname -- "$output_path")" ]]; then
  echo "Output directory does not exist: $(dirname -- "$output_path")" >&2
  exit 1
fi

frontend_stamp="$project_dir/dist/index.html"
frontend_inputs=(
  "$project_dir/src"
  "$project_dir/public"
  "$project_dir/pnpm-lock.yaml"
  "$project_dir/next.config.ts"
  "$project_dir/postcss.config.mjs"
  "$project_dir/tailwind.config.js"
  "$project_dir/tsconfig.json"
)

frontend_is_stale=false
if [[ "${FORCE_FRONTEND:-0}" == "1" || ! -f "$frontend_stamp" ]]; then
  frontend_is_stale=true
elif find "${frontend_inputs[@]}" -type f -newer "$frontend_stamp" -print -quit | grep -q .; then
  frontend_is_stale=true
fi

proxy_inputs=(
  "$project_dir/src-tauri/Cargo.lock"
  "$project_dir/src-tauri/Cargo.toml"
  "$project_dir/src-tauri/app.manifest"
  "$project_dir/src-tauri/build.rs"
  "$project_dir/src-tauri/src/lib.rs"
  "$project_dir/src-tauri/src/app_dirs.rs"
  "$project_dir/src-tauri/src/bin/proxy_server.rs"
  "$project_dir/src-tauri/src/proxy_runner.rs"
  "$project_dir/src-tauri/src/proxy_server.rs"
  "$project_dir/src-tauri/src/proxy_storage.rs"
  "$project_dir/src-tauri/src/socks5_local.rs"
  "$project_dir/src-tauri/src/traffic_stats.rs"
)

proxy_is_stale=false
if [[ "${FORCE_PROXY:-0}" == "1" || ! -f "$proxy_binary" ]]; then
  proxy_is_stale=true
elif find "${proxy_inputs[@]}" -type f -newer "$proxy_binary" -print -quit | grep -q .; then
  proxy_is_stale=true
fi

build_frontend() {
  (
    cd "$project_dir"
    pnpm exec next build
  )
}

build_proxy() {
  (
    cd "$project_dir/src-tauri"
    cargo build --locked --profile "$windows_profile" --target "$windows_target" --bin donut-proxy
  )
}

if [[ "$frontend_is_stale" == "true" && "$proxy_is_stale" == "true" ]] && (( core_count >= 8 )); then
  echo "Building changed frontend assets and Windows proxy sidecar in parallel ($core_count cores)..."
  build_frontend &
  frontend_pid=$!
  build_proxy &
  proxy_pid=$!
  parallel_status=0
  wait "$frontend_pid" || parallel_status=1
  wait "$proxy_pid" || parallel_status=1
  if (( parallel_status != 0 )); then
    echo "A parallel frontend/proxy build step failed." >&2
    exit 1
  fi
else
  if [[ "$frontend_is_stale" == "true" ]]; then
    echo "Building changed frontend assets..."
    build_frontend
  else
    echo "Frontend assets are current; skipping Next.js build."
  fi

  if [[ "$proxy_is_stale" == "true" ]]; then
    echo "Building changed Windows proxy sidecar..."
    build_proxy
  else
    echo "Windows proxy sidecar is current; skipping its build."
  fi
fi

if [[ ! -f "$staged_proxy" ]] || ! cmp -s "$proxy_binary" "$staged_proxy"; then
  install -m 0755 "$proxy_binary" "$staged_proxy"
  echo "Updated the staged Windows proxy sidecar."
else
  echo "Staged Windows proxy sidecar is current."
fi

app_inputs=(
  "$project_dir/src-tauri/src"
  "$project_dir/src-tauri/.cargo/config.toml"
  "$project_dir/src-tauri/Cargo.toml"
  "$project_dir/src-tauri/Cargo.lock"
  "$project_dir/src-tauri/build.rs"
  "$project_dir/src-tauri/app.manifest"
  "$project_dir/src-tauri/tauri.conf.json"
  "$project_dir/src-tauri/capabilities"
  "$project_dir/src-tauri/icons"
  "$project_dir/src-tauri/entitlements.plist"
  "$project_dir/src-tauri/Info.plist"
)

app_is_stale=false
if [[ "${FORCE_APP:-0}" == "1" || ! -f "$app_binary" ]]; then
  app_is_stale=true
elif find "${app_inputs[@]}" -type f -newer "$app_binary" -print -quit | grep -q .; then
  app_is_stale=true
fi

if [[ "$app_is_stale" == "true" ]]; then
  echo "Building changed Windows application binary..."
  (
    cd "$project_dir/src-tauri"
    cargo build --locked --profile "$windows_profile" --target "$windows_target" --bin donutbrowser
  )
else
  echo "Windows application binary is current; skipping its build."
fi

for portable_binary in "$app_binary" "$proxy_binary" "$loader_binary"; do
  if [[ ! -f "$portable_binary" ]]; then
    echo "Missing portable runtime file: $portable_binary" >&2
    exit 1
  fi
  if ! file "$portable_binary" | grep -q 'PE32+.*x86-64'; then
    echo "Portable runtime file is not a Windows x64 PE binary: $portable_binary" >&2
    exit 1
  fi
done

portable_stage_root="$(mktemp -d /tmp/donut-portable.XXXXXX)"
cleanup() {
  if [[ "$portable_stage_root" == /tmp/donut-portable.* ]]; then
    rm -rf -- "$portable_stage_root"
  fi
}
trap cleanup EXIT

portable_dir="$portable_stage_root/Donut-Portable"
mkdir "$portable_dir"
touch "$portable_dir/.portable"
install -m 0755 "$app_binary" "$portable_dir/Donut.exe"
install -m 0755 "$proxy_binary" "$portable_dir/donut-proxy.exe"
install -m 0644 "$loader_binary" "$portable_dir/WebView2Loader.dll"

(
  cd "$portable_stage_root"
  7z a -tzip -mx=5 "$output_path" Donut-Portable >/dev/null
)
7z t "$output_path" >/dev/null

echo "Portable archive: $output_path"
echo "SHA-256: $(sha256sum "$output_path" | awk '{print $1}')"

if [[ "${IDOUD_UPLOAD:-0}" == "1" ]]; then
  if ! command -v idoud >/dev/null 2>&1; then
    echo "Missing required command for upload: idoud" >&2
    exit 1
  fi
  idoud -N -o url -n "$(basename -- "$output_path")" "$output_path"
fi
