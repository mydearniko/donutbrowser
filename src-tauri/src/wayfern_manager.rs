use crate::browser_runner::BrowserRunner;
use crate::profile::BrowserProfile;
use futures_util::future::join_all;
use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WayfernConfig {
  #[serde(default)]
  pub fingerprint: Option<String>,
  #[serde(default)]
  pub randomize_fingerprint_on_launch: Option<bool>,
  #[serde(default)]
  pub os: Option<String>,
  #[serde(default)]
  pub screen_max_width: Option<u32>,
  #[serde(default)]
  pub screen_max_height: Option<u32>,
  #[serde(default)]
  pub screen_min_width: Option<u32>,
  #[serde(default)]
  pub screen_min_height: Option<u32>,
  #[serde(default)]
  pub geoip: Option<serde_json::Value>, // For compatibility with shared config form
  #[serde(default)]
  pub block_images: Option<bool>, // For compatibility with shared config form
  #[serde(default)]
  pub block_webrtc: Option<bool>,
  #[serde(default)]
  pub block_webgl: Option<bool>,
  #[serde(default, skip_serializing)]
  pub proxy: Option<String>,
  /// Stable signature of the proxy/VPN/geoip the fingerprint's location data
  /// (timezone, latitude/longitude, language) was last computed for. Compared
  /// on launch to detect that the routing changed since creation, so the
  /// location can be refreshed instead of showing stale data.
  #[serde(default)]
  pub geo_proxy_signature: Option<String>,
  #[serde(default)]
  pub prepared_fingerprint: Option<String>,
  #[serde(default)]
  pub prepared_fingerprint_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct WayfernLaunchResult {
  pub id: String,
  #[serde(alias = "process_id")]
  pub processId: Option<u32>,
  #[serde(alias = "profile_path")]
  pub profilePath: Option<String>,
  pub url: Option<String>,
  pub cdp_port: Option<u16>,
  /// The fingerprint Wayfern actually applied, echoed back by
  /// Wayfern.setFingerprint. It may be UPGRADED from the stored fingerprint
  /// (e.g. when the stored one targets an older browser version). Internal
  /// only — the caller persists it to the profile; never sent to the frontend.
  #[serde(default, skip_serializing)]
  pub used_fingerprint: Option<String>,
}

struct WayfernInstance {
  id: String,
  process_id: Option<u32>,
  profile_path: Option<String>,
  url: Option<String>,
  cdp_port: Option<u16>,
  exit_watch_arm: Option<tokio::sync::oneshot::Sender<BrowserExitWatchContext>>,
}

struct BrowserExitWatchContext {
  app_handle: AppHandle,
  profile_id: uuid::Uuid,
}

struct WayfernManagerInner {
  instances: HashMap<String, WayfernInstance>,
}

pub struct WayfernManager {
  inner: Arc<AsyncMutex<WayfernManagerInner>>,
  http_client: Client,
  placement_sequence: AtomicU64,
}

#[derive(Debug, Deserialize)]
struct CdpTarget {
  #[serde(rename = "type")]
  target_type: String,
  #[serde(rename = "webSocketDebuggerUrl")]
  websocket_debugger_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowPlacement {
  x: i32,
  y: i32,
  width: u32,
  height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LogicalWorkArea {
  x: i32,
  y: i32,
  width: u32,
  height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct WindowLaunchConfig {
  placement: WindowPlacement,
  scale_factor: f64,
  screen_width: u32,
  screen_height: u32,
  work_area: LogicalWorkArea,
}

const DEFAULT_WINDOW_MIN_WIDTH: u32 = 1211;
const DEFAULT_WINDOW_MAX_WIDTH: u32 = 1282;
const DEFAULT_WINDOW_MIN_HEIGHT: u32 = 710;
const DEFAULT_WINDOW_MAX_HEIGHT: u32 = 751;
const WINDOW_EDGE_MARGIN: u32 = 12;
const MAX_CDP_TARGET_RACE: usize = 4;
/// Chromium switch that overrides the startup preference and reopens the
/// windows/tabs stored inside this profile's own user-data directory.
pub(crate) const RESTORE_LAST_SESSION_ARG: &str = "--restore-last-session";
const WINDOW_CASCADE_OFFSETS: [(i32, i32); 9] = [
  (0, 0),
  (56, 36),
  (-56, 36),
  (56, -36),
  (-56, -36),
  (0, 62),
  (0, -62),
  (82, 0),
  (-82, 0),
];

impl WayfernManager {
  fn new() -> Self {
    Self {
      inner: Arc::new(AsyncMutex::new(WayfernManagerInner {
        instances: HashMap::new(),
      })),
      // CDP is always on loopback. Disable env/system proxies so a Windows
      // WinHTTP/IE proxy (or HTTP_PROXY) cannot intercept /json/version and
      // return 502 Bad Gateway while the browser is actually listening.
      http_client: Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .expect("Failed to build reqwest client for wayfern_manager"),
      placement_sequence: AtomicU64::new(0),
    }
  }

  pub fn instance() -> &'static WayfernManager {
    &WAYFERN_MANAGER
  }

  #[allow(dead_code)]
  pub fn get_profiles_dir(&self) -> PathBuf {
    crate::app_dirs::profiles_dir()
  }

  #[allow(dead_code)]
  fn get_binaries_dir(&self) -> PathBuf {
    crate::app_dirs::binaries_dir()
  }

  async fn find_free_port() -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
  }

  fn profile_launch_args(port: u16, profile_path: &str) -> Vec<String> {
    vec![
      format!("--remote-debugging-port={port}"),
      "--remote-debugging-address=127.0.0.1".to_string(),
      format!("--user-data-dir={profile_path}"),
      "--no-first-run".to_string(),
      "--no-default-browser-check".to_string(),
      RESTORE_LAST_SESSION_ARG.to_string(),
      "--disable-background-mode".to_string(),
      "--disable-component-update".to_string(),
      "--disable-background-timer-throttling".to_string(),
      "--crash-server-url=".to_string(),
      "--disable-updater".to_string(),
      "--disable-session-crashed-bubble".to_string(),
      "--hide-crash-restore-bubble".to_string(),
      "--disable-infobars".to_string(),
      // Prefetch* / NoStatePrefetch: cross-site Speculation-Rules prefetch uses
      // an isolated NetworkContext that defaults to DIRECT egress (real host IP
      // leaks past the per-profile proxy). Disabling via a LAUNCH FLAG cannot be
      // re-enabled by an imported/synced network_prediction_options pref (which a
      // compile-time pref default could be).
      "--disable-features=DialMediaRouteProvider,DnsOverHttps,AsyncDns,Prefetch,PrefetchProxy,SpeculationRulesPrefetchFuture,NoStatePrefetch".to_string(),
      "--use-mock-keychain".to_string(),
      "--password-store=basic".to_string(),
    ]
  }

  /// Normalize fingerprint data from Wayfern CDP format to our storage format.
  /// Wayfern returns fields like fonts, webglParameters as JSON strings which we keep as-is.
  fn normalize_fingerprint(fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern returns:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // The form displays them as JSON text areas, so no conversion needed.
    fingerprint
  }

  /// Denormalize fingerprint data from our storage format to Wayfern CDP format.
  /// Wayfern expects certain fields as JSON strings.
  fn denormalize_fingerprint(fingerprint: serde_json::Value) -> serde_json::Value {
    // Our storage format matches what Wayfern expects:
    // - fonts, plugins, mimeTypes, voices are JSON strings
    // - webglParameters, webgl2Parameters, etc. are JSON strings
    // So no conversion is needed
    fingerprint
  }

  fn logical_work_area_from_physical(
    work_area_x: i32,
    work_area_y: i32,
    work_area_width: u32,
    work_area_height: u32,
    scale_factor: f64,
  ) -> Option<LogicalWorkArea> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
      return None;
    }

    let logical_coordinate = |value: i32| {
      (f64::from(value) / scale_factor)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    };
    let logical_length = |value: u32| {
      (f64::from(value) / scale_factor)
        .floor()
        .clamp(1.0, f64::from(u32::MAX)) as u32
    };

    Some(LogicalWorkArea {
      x: logical_coordinate(work_area_x),
      y: logical_coordinate(work_area_y),
      width: logical_length(work_area_width),
      height: logical_length(work_area_height),
    })
  }

  fn fit_window_size_to_work_area(
    work_area: LogicalWorkArea,
    window_size: (u32, u32),
  ) -> (u32, u32) {
    let fit = |area_length: u32, window_length: u32| {
      window_length.min(
        area_length
          .saturating_sub(WINDOW_EDGE_MARGIN.saturating_mul(2))
          .max(1),
      )
    };

    (
      fit(work_area.width, window_size.0),
      fit(work_area.height, window_size.1),
    )
  }

  fn position_window_in_work_area(
    work_area: LogicalWorkArea,
    window_size: (u32, u32),
    offset: (i32, i32),
  ) -> WindowPlacement {
    let position_axis =
      |start: i32, area_length: u32, window_length: u32, requested_offset: i32| {
        let slack = area_length.saturating_sub(window_length);
        let margin = WINDOW_EDGE_MARGIN.min(slack / 2);
        let centered = i64::from(slack / 2) + i64::from(requested_offset);
        let offset = centered.clamp(i64::from(margin), i64::from(slack - margin));
        (i64::from(start) + offset).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
      };

    WindowPlacement {
      x: position_axis(work_area.x, work_area.width, window_size.0, offset.0),
      y: position_axis(work_area.y, work_area.height, window_size.1, offset.1),
      width: window_size.0,
      height: window_size.1,
    }
  }

  fn cascade_offset(sequence: u64, jitter_x: i32, jitter_y: i32) -> (i32, i32) {
    let base = WINDOW_CASCADE_OFFSETS[sequence as usize % WINDOW_CASCADE_OFFSETS.len()];
    (
      base.0.saturating_add(jitter_x),
      base.1.saturating_add(jitter_y),
    )
  }

  fn random_default_window_size() -> (u32, u32) {
    (
      rand::random_range(DEFAULT_WINDOW_MIN_WIDTH..=DEFAULT_WINDOW_MAX_WIDTH),
      rand::random_range(DEFAULT_WINDOW_MIN_HEIGHT..=DEFAULT_WINDOW_MAX_HEIGHT),
    )
  }

  /// Scale a logical (CSS px) placement to physical screen pixels for
  /// Chromium's --window-size/--window-position. With scale 1.0 the
  /// placement is unchanged; values are clamped to stay within the native
  /// integer ranges. Used on Windows (where the flags are raw physical
  /// pixels); exercised by tests on every platform.
  #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
  fn scale_placement(placement: WindowPlacement, scale: f64) -> WindowPlacement {
    let clamp_i32 = |value: f64| {
      value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
    };
    let clamp_u32 = |value: f64| value.round().clamp(0.0, f64::from(u32::MAX)) as u32;
    WindowPlacement {
      x: clamp_i32(f64::from(placement.x) * scale),
      y: clamp_i32(f64::from(placement.y) * scale),
      width: clamp_u32(f64::from(placement.width) * scale),
      height: clamp_u32(f64::from(placement.height) * scale),
    }
  }

  /// The user-configured browser-window size range from Settings, when all
  /// four bounds are set and non-zero. Min/max are normalized so min <=
  /// max even if the user enters them inverted.
  fn configured_window_size_bounds() -> Option<((u32, u32), (u32, u32))> {
    fn pair(min: u32, max: u32) -> (u32, u32) {
      (min.min(max), min.max(max).max(1))
    }
    crate::settings_manager::SettingsManager::instance()
      .load_settings()
      .ok()
      .and_then(|settings| {
        match (
          settings.browser_window_min_width,
          settings.browser_window_max_width,
          settings.browser_window_min_height,
          settings.browser_window_max_height,
        ) {
          (Some(min_w), Some(max_w), Some(min_h), Some(max_h))
            if min_w > 0 && max_w > 0 && min_h > 0 && max_h > 0 =>
          {
            Some((pair(min_w, max_w), pair(min_h, max_h)))
          }
          _ => None,
        }
      })
  }

  fn window_launch_config(
    app_handle: &AppHandle,
    sequence: u64,
    desired_size: (u32, u32),
  ) -> Option<WindowLaunchConfig> {
    let monitor = app_handle
      .get_webview_window("main")
      .and_then(|window| window.current_monitor().ok().flatten())
      .or_else(|| {
        let cursor = app_handle.cursor_position().ok()?;
        app_handle
          .monitor_from_point(cursor.x, cursor.y)
          .ok()
          .flatten()
      })
      .or_else(|| app_handle.primary_monitor().ok().flatten())?;
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let logical_work_area = Self::logical_work_area_from_physical(
      work_area.position.x,
      work_area.position.y,
      work_area.size.width,
      work_area.size.height,
      scale_factor,
    )?;
    let logical_screen = Self::logical_work_area_from_physical(
      monitor.position().x,
      monitor.position().y,
      monitor.size().width,
      monitor.size().height,
      scale_factor,
    )?;
    let window_size = Self::fit_window_size_to_work_area(logical_work_area, desired_size);
    let offset = Self::cascade_offset(
      sequence,
      rand::random_range(-7..=7),
      rand::random_range(-7..=7),
    );

    Some(WindowLaunchConfig {
      placement: Self::position_window_in_work_area(logical_work_area, window_size, offset),
      scale_factor,
      screen_width: logical_screen.width,
      screen_height: logical_screen.height,
      work_area: logical_work_area,
    })
  }

  fn apply_display_metrics_to_fingerprint(
    fingerprint: &mut serde_json::Value,
    launch: WindowLaunchConfig,
    actual_metrics: Option<&serde_json::Map<String, serde_json::Value>>,
  ) {
    let Some(obj) = fingerprint.as_object_mut() else {
      return;
    };
    let read = |key: &str| -> Option<u32> {
      let value = obj.get(key)?;
      value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        .and_then(|value| u32::try_from(value).ok())
    };
    let inner_width =
      read("windowOuterWidth")
        .zip(read("windowInnerWidth"))
        .map(|(outer, inner)| {
          launch
            .placement
            .width
            .saturating_sub(outer.saturating_sub(inner))
            .max(1)
        });
    let inner_height = read("windowOuterHeight")
      .zip(read("windowInnerHeight"))
      .map(|(outer, inner)| {
        launch
          .placement
          .height
          .saturating_sub(outer.saturating_sub(inner))
          .max(1)
      });

    obj.insert("screenWidth".to_string(), json!(launch.screen_width));
    obj.insert("screenHeight".to_string(), json!(launch.screen_height));
    obj.insert(
      "screenAvailWidth".to_string(),
      json!(launch.work_area.width),
    );
    obj.insert(
      "screenAvailHeight".to_string(),
      json!(launch.work_area.height),
    );
    obj.insert("devicePixelRatio".to_string(), json!(launch.scale_factor));
    obj.insert(
      "windowOuterWidth".to_string(),
      json!(launch.placement.width),
    );
    obj.insert(
      "windowOuterHeight".to_string(),
      json!(launch.placement.height),
    );
    obj.insert("screenX".to_string(), json!(launch.placement.x));
    obj.insert("screenY".to_string(), json!(launch.placement.y));
    if let Some(width) = inner_width {
      obj.insert("windowInnerWidth".to_string(), json!(width));
    }
    if let Some(height) = inner_height {
      obj.insert("windowInnerHeight".to_string(), json!(height));
    }

    const METRIC_KEYS: [&str; 13] = [
      "screenWidth",
      "screenHeight",
      "screenAvailWidth",
      "screenAvailHeight",
      "screenColorDepth",
      "screenPixelDepth",
      "devicePixelRatio",
      "windowOuterWidth",
      "windowOuterHeight",
      "windowInnerWidth",
      "windowInnerHeight",
      "screenX",
      "screenY",
    ];
    if let Some(actual_metrics) = actual_metrics {
      for key in METRIC_KEYS {
        if let Some(value) = actual_metrics.get(key).filter(|value| value.is_number()) {
          obj.insert(key.to_string(), value.clone());
        }
      }
    }
  }

  async fn wait_for_cdp_ready(
    &self,
    port: u16,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(60);
    let mut attempt = 0_u32;
    let detail = loop {
      let error = match self.http_client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
          log::info!("CDP ready on port {port} after {attempt} attempts");
          return Ok(());
        }
        Ok(resp) => format!("HTTP {} from {url}", resp.status()),
        Err(e) => format!("request failed: {e}"),
      };
      if tokio::time::Instant::now() >= deadline {
        break error;
      }
      attempt += 1;
      let elapsed = started.elapsed();
      let delay = if elapsed < Duration::from_secs(2) {
        Duration::from_millis(20)
      } else if elapsed < Duration::from_secs(10) {
        Duration::from_millis(100)
      } else {
        Duration::from_millis(500)
      };
      tokio::time::sleep(delay).await;
    };

    log::error!("CDP not ready within 60 seconds on port {port}: {detail}");
    Err(format!("CDP not ready within 60 seconds on port {port}: {detail}").into())
  }

  async fn get_cdp_targets(
    &self,
    port: u16,
  ) -> Result<Vec<CdpTarget>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("http://127.0.0.1:{port}/json");
    let resp = self.http_client.get(&url).send().await?;
    let targets: Vec<CdpTarget> = resp.json().await?;
    Ok(targets)
  }

  async fn request_graceful_browser_close(
    &self,
    port: u16,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let version_url = format!("http://127.0.0.1:{port}/json/version");
    let version: serde_json::Value = self
      .http_client
      .get(&version_url)
      .send()
      .await?
      .error_for_status()?
      .json()
      .await?;
    let ws_url = version
      .get("webSocketDebuggerUrl")
      .and_then(serde_json::Value::as_str)
      .ok_or("CDP version response did not include a browser WebSocket URL")?;

    let (mut ws_stream, _) = connect_async(ws_url).await?;
    use futures_util::sink::SinkExt;
    ws_stream
      .send(Message::Text(
        json!({
          "id": 1,
          "method": "Browser.close",
          "params": {},
        })
        .to_string()
        .into(),
      ))
      .await?;
    Ok(())
  }

  fn is_process_running(pid: u32) -> bool {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().without_tasks()),
    )
    .process(sysinfo::Pid::from_u32(pid))
    .is_some()
  }

  async fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let started = tokio::time::Instant::now();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
      if !Self::is_process_running(pid) {
        return true;
      }
      if tokio::time::Instant::now() >= deadline {
        return false;
      }
      let delay = if started.elapsed() < Duration::from_millis(750) {
        Duration::from_millis(20)
      } else {
        Duration::from_millis(100)
      };
      tokio::time::sleep(delay).await;
    }
  }

  /// Deadline for CDP commands that legitimately take seconds to complete:
  /// `Wayfern` fingerprint commands (generation with a `wayfernToken`
  /// contacts an external fingerprint service) and page navigation. Quick
  /// commands keep the default 2-second deadline so a genuinely stuck one
  /// still fails fast instead of stalling the profile flow.
  const SLOW_CDP_TIMEOUT: Duration = Duration::from_secs(30);

  async fn send_cdp_command(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    self
      .send_cdp_command_with_timeout(ws_url, method, params, Duration::from_secs(2))
      .await
  }

  async fn send_cdp_command_with_timeout(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    match tokio::time::timeout(timeout, self.send_cdp_command_inner(ws_url, method, params)).await {
      Ok(result) => result,
      Err(_) => Err(
        format!(
          "CDP command {method} timed out after {} seconds",
          timeout.as_secs()
        )
        .into(),
      ),
    }
  }

  async fn send_cdp_command_inner(
    &self,
    ws_url: &str,
    method: &str,
    params: serde_json::Value,
  ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    let (mut ws_stream, _) = connect_async(ws_url).await?;

    let command = json!({
      "id": 1,
      "method": method,
      "params": params
    });

    use futures_util::sink::SinkExt;
    ws_stream
      .send(Message::Text(command.to_string().into()))
      .await?;

    while let Some(msg) = ws_stream.next().await {
      match msg? {
        Message::Text(text) => {
          let response: serde_json::Value = serde_json::from_str(text.as_str())?;
          if response.get("id") == Some(&json!(1)) {
            if let Some(error) = response.get("error") {
              return Err(format!("CDP error: {}", error).into());
            }
            return Ok(response.get("result").cloned().unwrap_or(json!({})));
          }
        }
        Message::Close(_) => break,
        _ => {}
      }
    }

    Err("No response received from CDP".into())
  }

  fn display_metrics_from_evaluation(
    evaluation: &serde_json::Value,
  ) -> Option<serde_json::Map<String, serde_json::Value>> {
    evaluation.get("result")?.get("value")?.as_object().cloned()
  }

  async fn read_actual_display_metrics(
    &self,
    page_targets: &[&CdpTarget],
  ) -> Option<serde_json::Map<String, serde_json::Value>> {
    const EXPRESSION: &str = r#"(() => ({
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      screenAvailWidth: window.screen.availWidth,
      screenAvailHeight: window.screen.availHeight,
      screenColorDepth: window.screen.colorDepth,
      screenPixelDepth: window.screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio,
      windowOuterWidth: window.outerWidth,
      windowOuterHeight: window.outerHeight,
      windowInnerWidth: window.innerWidth,
      windowInnerHeight: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY
    }))()"#;

    let mut evaluations = FuturesUnordered::new();
    for target in page_targets.iter().take(MAX_CDP_TARGET_RACE) {
      if let Some(ws_url) = &target.websocket_debugger_url {
        evaluations.push(async move {
          (
            ws_url,
            self
              .send_cdp_command(
                ws_url,
                "Runtime.evaluate",
                json!({
                  "expression": EXPRESSION,
                  "returnByValue": true,
                }),
              )
              .await,
          )
        });
      }
    }

    while let Some((_ws_url, result)) = evaluations.next().await {
      match result {
        Ok(evaluation) => {
          if let Some(metrics) = Self::display_metrics_from_evaluation(&evaluation) {
            return Some(metrics);
          }
          log::warn!("Chromium returned display metrics in an unexpected CDP shape");
        }
        Err(error) => log::warn!("Could not read actual Chromium display metrics: {error}"),
      }
    }

    None
  }

  /// Stable signature describing what determines this profile's geolocation
  /// (timezone, latitude/longitude, language): the geoip mode first, then the
  /// VPN, the proxy, or a direct connection. Compared across creation and
  /// launch to detect a change. The VPN case keys off `vpn_id` rather than the
  /// per-launch local port, and the proxy case off type/host/port/username so
  /// that editing the proxy is also caught.
  pub fn geo_signature(
    proxy: Option<&crate::browser::ProxySettings>,
    vpn_id: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> String {
    // The "v2:" prefix invalidates every signature stamped before geolocation
    // failures stopped being stamped: those may describe fingerprints that
    // silently carry the host's location, so each pre-v2 profile gets one
    // launch-time refresh and is re-stamped in the current format.
    let base = match geoip {
      Some(serde_json::Value::Bool(false)) => "off".to_string(),
      Some(serde_json::Value::String(ip)) if !ip.is_empty() => format!("ip:{ip}"),
      _ => {
        if let Some(id) = vpn_id {
          format!("vpn:{id}")
        } else if let Some(p) = proxy {
          format!(
            "proxy:{}://{}@{}:{}",
            p.proxy_type.to_lowercase(),
            p.username.as_deref().unwrap_or(""),
            p.host,
            p.port
          )
        } else {
          "direct".to_string()
        }
      }
    };
    format!("v2:{base}")
  }

  /// Apply timezone/geolocation fields to a fingerprint object from the proxy's
  /// exit IP (or a fixed geoip IP). Mutates `fingerprint` in place. Returns true
  /// if fresh geolocation was fetched and applied, false if geolocation is
  /// disabled or could not be resolved (in which case only safe defaults are
  /// filled in). Shared by fingerprint generation and the launch-time refresh
  /// so both produce identical location data.
  async fn apply_geolocation(
    fingerprint: &mut serde_json::Value,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> bool {
    // Default to auto-detect; only an explicit `false` disables geolocation.
    let should_geolocate = !matches!(geoip, Some(serde_json::Value::Bool(false)));
    if !should_geolocate {
      return false;
    }

    let geo_result = async {
      let ip = match geoip {
        Some(serde_json::Value::String(ip_str)) => ip_str.clone(),
        _ => crate::ip_utils::fetch_public_ip(proxy)
          .await
          .map_err(|e| format!("Failed to fetch public IP: {e}"))?,
      };
      crate::geolocation::get_geolocation(&ip)
        .map_err(|e| format!("Failed to get geolocation for IP {ip}: {e}"))
    }
    .await;

    match geo_result {
      Ok(geo) => {
        if let Some(obj) = fingerprint.as_object_mut() {
          obj.insert("timezone".to_string(), json!(geo.timezone));
          // Calculate timezone offset from IANA timezone name
          if let Ok(tz) = geo.timezone.parse::<chrono_tz::Tz>() {
            use chrono::Offset;
            let now = chrono::Utc::now().with_timezone(&tz);
            let offset_seconds = now.offset().fix().local_minus_utc();
            let offset_minutes = -(offset_seconds / 60);
            obj.insert("timezoneOffset".to_string(), json!(offset_minutes));
          }
          obj.insert("latitude".to_string(), json!(geo.latitude));
          obj.insert("longitude".to_string(), json!(geo.longitude));
          let locale_str = geo.locale.as_string();
          obj.insert("language".to_string(), json!(&locale_str));
          obj.insert(
            "languages".to_string(),
            json!([&locale_str, &geo.locale.language]),
          );
        }
        log::info!(
          "Applied geolocation to Wayfern fingerprint: {} ({})",
          geo.locale.as_string(),
          geo.timezone
        );
        true
      }
      Err(e) => {
        log::warn!("Geolocation failed, using defaults: {e}");
        if let Some(obj) = fingerprint.as_object_mut() {
          if !obj.contains_key("timezone") {
            obj.insert("timezone".to_string(), json!("America/New_York"));
          }
          if !obj.contains_key("timezoneOffset") {
            obj.insert("timezoneOffset".to_string(), json!(300));
          }
        }
        false
      }
    }
  }

  /// Refresh ONLY the location fields (timezone, offset, latitude/longitude,
  /// language) of an already-generated fingerprint to match the current proxy,
  /// leaving every other fingerprint field untouched. `proxy` is the local
  /// proxy URL the browser will use. Returns the updated fingerprint JSON on
  /// success, or None if geolocation is disabled or could not be resolved, in
  /// which case the caller keeps the existing fingerprint and retries on the
  /// next launch.
  pub async fn refresh_fingerprint_geolocation(
    fingerprint_json: &str,
    proxy: Option<&str>,
    geoip: Option<&serde_json::Value>,
  ) -> Option<String> {
    let mut fp: serde_json::Value = serde_json::from_str(fingerprint_json).ok()?;
    if Self::apply_geolocation(&mut fp, proxy, geoip).await {
      serde_json::to_string(&fp).ok()
    } else {
      None
    }
  }

  /// True when `url` is a socks proxy on a remote (non-loopback) host — the
  /// case where reqwest's SOCKS connector can't be trusted with the
  /// geolocation fetch. Loopback socks URLs are the app's own donut-proxy
  /// workers, whose single-segment replies don't trigger the connector bug.
  fn is_remote_socks_url(url: &str) -> bool {
    url.starts_with("socks")
      && url::Url::parse(url)
        .ok()
        .and_then(|u| match u.host() {
          Some(url::Host::Ipv4(ip)) => Some(!ip.is_loopback()),
          Some(url::Host::Ipv6(ip)) => Some(!ip.is_loopback()),
          // socks is a non-special scheme, so the url crate keeps even
          // IP-literal hosts as Domain — parse them before comparing.
          Some(url::Host::Domain(domain)) => Some(
            domain != "localhost"
              && domain
                .parse::<std::net::IpAddr>()
                .map(|ip| !ip.is_loopback())
                .unwrap_or(true),
          ),
          None => None,
        })
        .unwrap_or(false)
  }

  /// Generate a fingerprint for `config`, returning the fingerprint JSON and
  /// whether fresh geolocation was applied to it. Callers must only stamp
  /// `geo_proxy_signature` when geolocation succeeded: the base fingerprint
  /// comes from a headless Wayfern launched without a proxy, so on failure it
  /// silently carries the HOST timezone/locale — stamping the signature then
  /// would tell the launch-time refresh the location is already correct for
  /// this proxy and permanently disable the one path that can repair it.
  pub async fn generate_fingerprint_config(
    &self,
    _app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
  ) -> Result<(String, bool), Box<dyn std::error::Error + Send + Sync>> {
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = Self::find_free_port().await?;
    log::info!("Launching headless Wayfern on port {port} for fingerprint generation");

    let temp_profile_dir =
      std::env::temp_dir().join(format!("wayfern_fingerprint_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_profile_dir)?;

    let mut cmd = TokioCommand::new(&executable_path);
    cmd
      .arg("--headless=new")
      .arg(format!("--remote-debugging-port={port}"))
      .arg("--remote-debugging-address=127.0.0.1")
      .arg(format!("--user-data-dir={}", temp_profile_dir.display()))
      .arg("--no-first-run")
      .arg("--no-default-browser-check")
      .arg("--disable-background-mode")
      .arg("--use-mock-keychain")
      .arg("--password-store=basic")
      .arg("--disable-features=DialMediaRouteProvider");

    #[cfg(target_os = "linux")]
    cmd
      .arg("--no-sandbox")
      .arg("--disable-setuid-sandbox")
      .arg("--disable-dev-shm-usage");

    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
      // OS error 14001 = SxS / missing Visual C++ Redistributable
      let hint = if e.raw_os_error() == Some(14001) {
        ". This usually means the Visual C++ Redistributable is not installed. \
         Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
      } else {
        ""
      };
      format!("Failed to spawn headless Wayfern: {e}{hint}")
    })?;
    let child_id = child.id();

    let cleanup = || async {
      if let Some(id) = child_id {
        #[cfg(unix)]
        {
          use nix::sys::signal::{kill, Signal};
          use nix::unistd::Pid;
          let _ = kill(Pid::from_raw(id as i32), Signal::SIGTERM);
        }
        #[cfg(windows)]
        {
          use std::os::windows::process::CommandExt;
          const CREATE_NO_WINDOW: u32 = 0x08000000;
          let _ = std::process::Command::new("taskkill")
            .args(["/PID", &id.to_string(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        }
      }
      let _ = std::fs::remove_dir_all(&temp_profile_dir);
    };

    if let Err(e) = self.wait_for_cdp_ready(port).await {
      // Try to capture stderr from the failed process for diagnostics
      let stderr_output = if let Some(id) = child_id {
        // Check if process is still running
        let is_running = sysinfo::System::new_with_specifics(
          sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
        )
        .process(sysinfo::Pid::from(id as usize))
        .is_some();

        if !is_running {
          // Process exited — try to read its stderr
          String::from("(process exited before CDP became ready)")
        } else {
          String::from("(process still running but not responding on CDP)")
        }
      } else {
        String::new()
      };

      log::error!(
        "Fingerprint-generation Wayfern (headless, pid={child_id:?}) never became CDP-ready: {e}. {stderr_output}"
      );
      cleanup().await;
      return Err(e);
    }

    let targets = match self.get_cdp_targets(port).await {
      Ok(t) => t,
      Err(e) => {
        cleanup().await;
        return Err(e);
      }
    };

    let page_target = targets
      .iter()
      .find(|t| t.target_type == "page" && t.websocket_debugger_url.is_some());

    let ws_url = match page_target {
      Some(target) => target.websocket_debugger_url.as_ref().unwrap().clone(),
      None => {
        cleanup().await;
        return Err("No page target found for CDP".into());
      }
    };

    let os = config
      .os
      .as_deref()
      .unwrap_or(if cfg!(target_os = "macos") {
        "macos"
      } else if cfg!(target_os = "linux") {
        "linux"
      } else {
        "windows"
      });

    // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
    let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    if wayfern_token.is_none()
      && crate::cloud_auth::CLOUD_AUTH
        .has_active_paid_subscription()
        .await
    {
      tokio::spawn(async {
        if let Err(error) = crate::cloud_auth::CLOUD_AUTH.request_wayfern_token().await {
          log::debug!("Background Wayfern token refresh failed: {error}");
        }
      });
    }
    let mut refresh_params = json!({ "operatingSystem": os });
    if let Some(ref token) = wayfern_token {
      refresh_params
        .as_object_mut()
        .unwrap()
        .insert("wayfernToken".to_string(), json!(token));
    }

    let refresh_result = self
      .send_cdp_command_with_timeout(
        &ws_url,
        "Wayfern.refreshFingerprint",
        refresh_params,
        Self::SLOW_CDP_TIMEOUT,
      )
      .await;

    if let Err(e) = refresh_result {
      cleanup().await;
      return Err(format!("Failed to refresh fingerprint: {e}").into());
    }

    let get_result = self
      .send_cdp_command_with_timeout(
        &ws_url,
        "Wayfern.getFingerprint",
        json!({}),
        Self::SLOW_CDP_TIMEOUT,
      )
      .await;

    let (fingerprint, geolocation_applied) = match get_result {
      Ok(result) => {
        // Wayfern.getFingerprint returns { fingerprint: {...} }
        // We need to extract just the fingerprint object
        let fp = result.get("fingerprint").cloned().unwrap_or(result);
        // Normalize the fingerprint: convert JSON string fields to proper types
        let mut normalized = Self::normalize_fingerprint(fp);

        // reqwest's SOCKS connector (hyper-util) corrupts its parse buffer
        // when a proxy splits a handshake reply across TCP segments, so a
        // socks upstream here can fail even though the proxy is healthy.
        // Route the geolocation lookup through a temporary local donut-proxy
        // worker — the same path the browser itself uses — and fall back to
        // the upstream URL only if the worker can't start. Two exclusions:
        // no worker when geolocation won't fetch through the proxy at all
        // (disabled, or a fixed geoip IP), and none for loopback socks URLs —
        // launch-time callers pass the already-running local worker's
        // socks5://127.0.0.1 URL, whose single-segment replies don't trigger
        // the bug, so chaining a second worker would only add latency.
        let needs_proxied_geo_fetch = !matches!(
          config.geoip.as_ref(),
          Some(serde_json::Value::Bool(false)) | Some(serde_json::Value::String(_))
        );
        let remote_socks_upstream = config
          .proxy
          .as_deref()
          .filter(|url| Self::is_remote_socks_url(url));
        let (geo_proxy, temp_worker_id) = match remote_socks_upstream {
          Some(url) if needs_proxied_geo_fetch => {
            match crate::proxy_runner::start_proxy_process(Some(url.to_string()), None)
              .await
              .map_err(|e| e.to_string())
            {
              Ok(worker) => {
                let local_url = format!("http://127.0.0.1:{}", worker.local_port.unwrap_or(0));
                (Some(local_url), Some(worker.id))
              }
              Err(e) => {
                log::warn!(
                  "Could not start local proxy worker for geolocation ({e}); using the socks upstream directly"
                );
                (config.proxy.clone(), None)
              }
            }
          }
          _ => (config.proxy.clone(), None),
        };

        // Apply timezone/geolocation for the proxy this fingerprint is being
        // generated against. Shared with the launch-time location refresh.
        let geolocation_applied =
          Self::apply_geolocation(&mut normalized, geo_proxy.as_deref(), config.geoip.as_ref())
            .await;

        if let Some(worker_id) = temp_worker_id {
          let _ = crate::proxy_runner::stop_proxy_process(&worker_id).await;
        }

        (normalized, geolocation_applied)
      }
      Err(e) => {
        cleanup().await;
        return Err(format!("Failed to get fingerprint: {e}").into());
      }
    };

    cleanup().await;

    let fingerprint_json = serde_json::to_string(&fingerprint)
      .map_err(|e| format!("Failed to serialize fingerprint: {e}"))?;

    log::info!(
      "Generated Wayfern fingerprint for OS: {}, fields: {:?}",
      os,
      fingerprint
        .as_object()
        .map(|o| o.keys().collect::<Vec<_>>())
    );

    // Log timezone/geolocation fields specifically for debugging
    if let Some(obj) = fingerprint.as_object() {
      log::info!(
        "Generated fingerprint - timezone: {:?}, timezoneOffset: {:?}, latitude: {:?}, longitude: {:?}, language: {:?}",
        obj.get("timezone"),
        obj.get("timezoneOffset"),
        obj.get("latitude"),
        obj.get("longitude"),
        obj.get("language")
      );
    }

    Ok((fingerprint_json, geolocation_applied))
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn launch_wayfern(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    profile_path: &str,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
    ephemeral: bool,
    extension_paths: &[String],
    remote_debugging_port: Option<u16>,
    headless: bool,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let launch_started = std::time::Instant::now();
    let executable_path = BrowserRunner::instance()
      .get_browser_executable_path(profile)
      .map_err(|e| format!("Failed to get Wayfern executable path: {e}"))?;

    let port = match remote_debugging_port {
      Some(p) => p,
      None => Self::find_free_port().await?,
    };
    log::info!("Launching Wayfern on CDP port {port} (detached)");

    if log::log_enabled!(log::Level::Trace) {
      let profile_path_buf = std::path::PathBuf::from(profile_path);
      let key_path = profile_path_buf.join("os_crypt_key");
      let cookies_path = {
        let network = profile_path_buf
          .join("Default")
          .join("Network")
          .join("Cookies");
        if network.exists() {
          network
        } else {
          profile_path_buf.join("Default").join("Cookies")
        }
      };

      if key_path.exists() {
        let key_text = std::fs::read_to_string(&key_path).unwrap_or_default();
        log::trace!(
          "Pre-launch: os_crypt_key present ({} bytes)",
          key_text.len()
        );
      } else {
        log::warn!("Pre-launch: os_crypt_key NOT FOUND");
      }

      if cookies_path.exists() {
        // Try to open Cookies DB and check if encrypted cookies can be decrypted
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
          &cookies_path,
          rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
          let cookie_count: i64 = conn
            .query_row(
              "SELECT COUNT(*) FROM cookies WHERE length(encrypted_value) > 0",
              [],
              |r| r.get(0),
            )
            .unwrap_or(0);
          let total_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cookies", [], |r| r.get(0))
            .unwrap_or(0);
          log::trace!(
            "Pre-launch: Cookies DB has {} total cookies, {} encrypted",
            total_count,
            cookie_count
          );

          // Try decrypting one cookie using the cookie_manager
          if let Some(encryption_key) =
            crate::cookie_manager::chrome_decrypt::get_encryption_key(&profile_path_buf)
          {
            if let Ok(mut stmt) = conn.prepare(
              "SELECT name, host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 0 LIMIT 1",
            ) {
              if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                  let name: String = row.get(0).unwrap_or_default();
                  let host: String = row.get(1).unwrap_or_default();
                  let encrypted: Vec<u8> = row.get(2).unwrap_or_default();
                  let decrypted = crate::cookie_manager::chrome_decrypt::decrypt(
                    &encrypted,
                    &host,
                    &encryption_key,
                  );
                  match decrypted {
                    Some(val) => log::trace!(
                      "Pre-launch: Cookie decryption SUCCEEDED for '{}' (host: {}, decrypted {} bytes)",
                      name, host, val.len()
                    ),
                    None => log::error!(
                      "Pre-launch: Cookie decryption FAILED for '{}' (host: {}, encrypted {} bytes)",
                      name, host, encrypted.len()
                    ),
                  }
                }
              }
            }
          } else {
            log::error!("Pre-launch: Failed to derive encryption key from os_crypt_key");
          }
        }
      } else {
        log::warn!("Pre-launch: Cookies NOT FOUND");
      }
    }

    let mut args = Self::profile_launch_args(port, profile_path);

    // Browser-window size: a random size within the user-configured range
    // from Settings, or within the built-in default range when unset.
    // Random-per-launch keeps the built-in anti-fingerprint behavior while
    // letting the user bound the size.
    let desired_default_size = match Self::configured_window_size_bounds() {
      Some(((min_w, max_w), (min_h, max_h))) => (
        rand::random_range(min_w..=max_w),
        rand::random_range(min_h..=max_h),
      ),
      None => Self::random_default_window_size(),
    };

    let window_launch_config = if headless {
      None
    } else {
      let sequence = self.placement_sequence.fetch_add(1, Ordering::Relaxed);
      Self::window_launch_config(app_handle, sequence, desired_default_size)
    };

    if headless {
      args.push("--headless=new".to_string());
    } else if let Some(launch) = window_launch_config {
      // Chromium's --window-size/--window-position are applied as raw
      // physical screen pixels (browser_window_state.cc), whereas our
      // placement is computed in logical (CSS) pixels to match
      // --force-device-scale-factor. On Windows, multiply by the scale
      // factor so the window keeps its intended size on scaled (HiDPI)
      // displays; without this the window opens tiny on anything above
      // 100% scaling.
      let placement = launch.placement;
      #[cfg(target_os = "windows")]
      let placement = Self::scale_placement(placement, launch.scale_factor);
      log::info!(
        "Opening Wayfern window at {},{} with taskbar-safe size {}x{} and scale {}",
        placement.x,
        placement.y,
        placement.width,
        placement.height,
        launch.scale_factor
      );
      args.push(format!(
        "--window-size={},{}",
        placement.width, placement.height
      ));
      args.push(format!("--window-position={},{}", placement.x, placement.y));
      #[cfg(target_os = "windows")]
      args.push(format!(
        "--force-device-scale-factor={}",
        launch.scale_factor
      ));
    } else {
      let (width, height) = desired_default_size;
      log::warn!(
        "Could not determine a monitor work area; letting the OS position the {width}x{height} Wayfern window"
      );
      args.push(format!("--window-size={width},{height}"));
    }

    #[cfg(target_os = "linux")]
    {
      args.push("--no-sandbox".to_string());
      args.push("--disable-setuid-sandbox".to_string());
      args.push("--disable-dev-shm-usage".to_string());
    }

    if ephemeral {
      args.push("--disk-cache-size=1".to_string());
      args.push("--disable-breakpad".to_string());
      args.push("--disable-crash-reporter".to_string());
      args.push("--no-service-autorun".to_string());
      args.push("--disable-sync".to_string());
    }

    if !extension_paths.is_empty() {
      args.push(format!("--load-extension={}", extension_paths.join(",")));
    }

    // Per-profile window label + distinct frame color so concurrent profile
    // windows are easy to tell apart. Wayfern reads these in
    // BrowserView::GetWindowTitle() (label) and BrowserFrameView::GetFrameColor()
    // (color). The label is the profile name; the color is the user's
    // window_color when set, otherwise deterministically derived from the
    // profile id so every profile still gets a stable, distinct color.
    if !profile.name.is_empty() {
      args.push(format!("--wayfern-profile-label={}", profile.name));
    }
    // Profiles created before this feature have no stored color; persist the
    // id-derived one so the info dialog shows the same frame color the window
    // uses. It's deterministic per id, so no updated_at bump/sync is needed.
    if profile
      .window_color
      .as_deref()
      .map(str::trim)
      .unwrap_or("")
      .is_empty()
    {
      let mut backfilled = profile.clone();
      backfilled.window_color = Some(derive_profile_color(&backfilled.id));
      let _ = crate::profile::ProfileManager::instance().save_runtime_profile(&backfilled);
    }
    let profile_color = profile
      .window_color
      .clone()
      .filter(|c| !c.trim().is_empty())
      .unwrap_or_else(|| derive_profile_color(&profile.id));
    // Wayfern expects the frame color as bare RRGGBB hex, with no leading '#'
    // (the stored/user value may include one).
    let profile_color = profile_color.trim().trim_start_matches('#');
    args.push(format!("--wayfern-profile-color={profile_color}"));

    let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
    if let Some(ref token) = wayfern_token {
      args.push(format!("--wayfern-token={token}"));
      log::info!("Wayfern token passed as CLI flag (length: {})", token.len());
    }

    if let Some(proxy) = proxy_url {
      // Map the local proxy scheme to the matching PAC directive. SOCKS5 lets
      // Chromium route UDP (QUIC/WebRTC) and resolve DNS through the proxy;
      // PROXY is HTTP CONNECT (TCP only). The host:port is the same either way.
      let (pac_directive, host_port) = if let Some(rest) = proxy.strip_prefix("socks5://") {
        ("SOCKS5", rest)
      } else {
        (
          "PROXY",
          proxy
            .trim_start_matches("http://")
            .trim_start_matches("https://"),
        )
      };
      let pac_data = format!(
        "data:application/x-ns-proxy-autoconfig,function FindProxyForURL(url,host){{return \"{pac_directive} {host_port}\";}}",
      );
      args.push(format!("--proxy-pac-url={pac_data}"));
      args.push("--dns-prefetch-disable".to_string());
    }

    let mut command = TokioCommand::new(&executable_path);
    command
      .args(&args)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());

    let mut child = command
      .spawn()
      .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
        let hint = if e.raw_os_error() == Some(14001) {
          ". This usually means the Visual C++ Redistributable is not installed. \
           Download it from https://aka.ms/vs/17/release/vc_redist.x64.exe"
        } else {
          ""
        };
        format!("Failed to spawn Wayfern: {e}{hint}").into()
      })?;
    let process_id = child.id();
    #[cfg(target_os = "windows")]
    if let Some(pid) = process_id {
      use windows::Win32::Foundation::CloseHandle;
      use windows::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
      };
      unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SET_INFORMATION, false, pid) {
          let _ = SetPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS);
          let _ = CloseHandle(handle);
        }
      }
    }
    log::info!(
      "[launch-timing] profile={} browser-spawned={}ms",
      profile.id,
      launch_started.elapsed().as_millis()
    );

    self.wait_for_cdp_ready(port).await?;
    log::info!(
      "[launch-timing] profile={} cdp-listening={}ms",
      profile.id,
      launch_started.elapsed().as_millis()
    );

    let targets = self.get_cdp_targets(port).await?;
    log::info!("Found {} CDP targets", targets.len());

    let page_targets: Vec<_> = targets.iter().filter(|t| t.target_type == "page").collect();
    log::info!("Found {} page targets", page_targets.len());

    // Apply fingerprint if configured
    let mut used_fingerprint: Option<String> = None;
    if let Some(fingerprint_json) = &config.fingerprint {
      log::info!(
        "Applying fingerprint to Wayfern browser, fingerprint length: {} chars",
        fingerprint_json.len()
      );

      let actual_display_metrics = if window_launch_config.is_some() {
        self.read_actual_display_metrics(&page_targets).await
      } else {
        None
      };

      let stored_value: serde_json::Value = serde_json::from_str(fingerprint_json)
        .map_err(|e| format!("Failed to parse stored fingerprint JSON: {e}"))?;

      // The stored fingerprint should be the fingerprint object directly (after our fix in generate_fingerprint_config)
      // But for backwards compatibility, also handle the wrapped format
      let mut fingerprint = if stored_value.get("fingerprint").is_some() {
        // Old format: {"fingerprint": {...}} - extract the inner fingerprint
        stored_value.get("fingerprint").cloned().unwrap()
      } else {
        // New format: fingerprint object directly {...}
        stored_value.clone()
      };

      if let Some(launch) = window_launch_config {
        Self::apply_display_metrics_to_fingerprint(
          &mut fingerprint,
          launch,
          actual_display_metrics.as_ref(),
        );
      }

      // Add default timezone if not present (for profiles created before timezone was added)
      if let Some(obj) = fingerprint.as_object_mut() {
        if !obj.contains_key("timezone") {
          obj.insert("timezone".to_string(), json!("America/New_York"));
          log::info!("Added default timezone to fingerprint");
        }
        if !obj.contains_key("timezoneOffset") {
          obj.insert("timezoneOffset".to_string(), json!(300));
          log::info!("Added default timezoneOffset to fingerprint");
        }
      }

      // Denormalize fingerprint for Wayfern CDP (convert arrays/objects to JSON strings)
      let mut fingerprint_for_cdp = Self::denormalize_fingerprint(fingerprint);

      // Normalize languages: if it's a comma-separated string, convert to array
      if let Some(obj) = fingerprint_for_cdp.as_object_mut() {
        if let Some(serde_json::Value::String(s)) = obj.get("languages").cloned() {
          let arr: Vec<&str> = s.split(',').map(|l| l.trim()).collect();
          obj.insert("languages".to_string(), json!(arr));
        }
      }

      log::info!(
        "Fingerprint prepared for CDP command, fields: {:?}",
        fingerprint_for_cdp
          .as_object()
          .map(|o| o.keys().collect::<Vec<_>>())
      );

      // Log timezone and geolocation fields specifically for debugging
      if let Some(obj) = fingerprint_for_cdp.as_object() {
        log::info!(
          "Timezone/Geolocation fields - timezone: {:?}, timezoneOffset: {:?}, latitude: {:?}, longitude: {:?}, language: {:?}, languages: {:?}",
          obj.get("timezone"),
          obj.get("timezoneOffset"),
          obj.get("latitude"),
          obj.get("longitude"),
          obj.get("language"),
          obj.get("languages")
        );
      }

      // Include wayfern token if available (enables cross-OS fingerprinting for paid users)
      let wayfern_token = crate::cloud_auth::CLOUD_AUTH.get_wayfern_token().await;
      let mut fingerprint_params = fingerprint_for_cdp.clone();
      if let Some(ref token) = wayfern_token {
        if let Some(obj) = fingerprint_params.as_object_mut() {
          obj.insert("wayfernToken".to_string(), json!(token));
        }
      }

      let mut fingerprint_applications = FuturesUnordered::new();
      for target in page_targets.iter().take(MAX_CDP_TARGET_RACE) {
        if let Some(ws_url) = target.websocket_debugger_url.as_ref() {
          let fingerprint_params = fingerprint_params.clone();
          fingerprint_applications.push(async move {
            (
              ws_url,
              self
                .send_cdp_command_with_timeout(
                  ws_url,
                  "Wayfern.setFingerprint",
                  fingerprint_params,
                  Self::SLOW_CDP_TIMEOUT,
                )
                .await,
            )
          });
        }
      }
      let mut fingerprint_applied = false;
      while let Some((ws_url, result)) = fingerprint_applications.next().await {
        log::info!("Applying fingerprint to target via WebSocket: {}", ws_url);
        match result {
          Ok(result) => {
            fingerprint_applied = true;
            log::info!("Successfully applied fingerprint to page target");
            // Wayfern.setFingerprint echoes back the fingerprint it actually
            // used, which may be UPGRADED from what we sent (e.g. when the
            // stored fingerprint targets an older browser version). Capture
            // it once, from the first target that succeeds, so the caller can
            // persist the upgraded value to the profile.
            if used_fingerprint.is_none() {
              // getFingerprint/setFingerprint wrap the object as
              // { fingerprint: {...} }; tolerate a bare object too.
              let fp = result.get("fingerprint").cloned().unwrap_or(result);
              if fp.is_object() {
                match serde_json::to_string(&Self::normalize_fingerprint(fp)) {
                  Ok(s) => used_fingerprint = Some(s),
                  Err(e) => {
                    log::warn!("Failed to serialize used fingerprint: {e}")
                  }
                }
              }
            }
            // Wayfern.setFingerprint installs the snapshot in the browser
            // context, so every restored/current page shares it. Remaining
            // page-target calls are redundant; dropping their futures also
            // prevents one stalled restored tab from delaying launch.
            break;
          }
          Err(e) => log::error!("Failed to apply fingerprint to target: {e}"),
        }
      }
      if !fingerprint_applied {
        log::error!(
          "Could not confirm fingerprint application for any page target in profile {}",
          profile.name
        );
      }
    } else {
      log::warn!("No fingerprint found in config, browser will use default fingerprint");
    }
    log::info!(
      "[launch-timing] profile={} fingerprint-applied={}ms targets={}",
      profile.id,
      launch_started.elapsed().as_millis(),
      page_targets.len()
    );

    // Geolocation is handled internally by the browser binary.

    if let Some(url) = url {
      log::info!("Navigating to URL via CDP: {}", url);
      if let Some(target) = page_targets.first() {
        if let Some(ws_url) = &target.websocket_debugger_url {
          if let Err(e) = self
            .send_cdp_command_with_timeout(
              ws_url,
              "Page.navigate",
              json!({ "url": url }),
              Self::SLOW_CDP_TIMEOUT,
            )
            .await
          {
            log::error!("Failed to navigate to URL: {e}");
          }
        }
      }
    }

    let cleanup_targets: Vec<String> = page_targets
      .iter()
      .filter_map(|target| target.websocket_debugger_url.clone())
      .collect();
    tokio::spawn(async move {
      let manager = WayfernManager::instance();
      let cleanup_commands = cleanup_targets.iter().map(|ws_url| async move {
        let _ = manager
          .send_cdp_command(ws_url, "Emulation.clearDeviceMetricsOverride", json!({}))
          .await;
        let _ = manager
          .send_cdp_command(
            ws_url,
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": false }),
          )
          .await;
        let _ = manager
          .send_cdp_command(
            ws_url,
            "Emulation.setEmulatedMedia",
            json!({ "media": "", "features": [] }),
          )
          .await;
      });
      join_all(cleanup_commands).await;
    });

    let id = uuid::Uuid::new_v4().to_string();
    let exit_watch_arm = if let Some(watched_pid) = process_id {
      let (arm, armed) = tokio::sync::oneshot::channel::<BrowserExitWatchContext>();
      let watched_instance_id = id.clone();

      tokio::spawn(async move {
        let exit_status = child.wait().await;
        let context = match armed.await {
          Ok(context) => context,
          Err(_) => return,
        };

        let is_natural_exit = WayfernManager::instance()
          .claim_naturally_exited_instance(&watched_instance_id, watched_pid)
          .await;
        if !is_natural_exit {
          return;
        }

        match exit_status {
          Ok(status) => log::info!(
            "Wayfern process {watched_pid} exited naturally with status {status}; finalizing profile {}",
            context.profile_id
          ),
          Err(error) => log::warn!(
            "Could not read exit status for Wayfern process {watched_pid}: {error}; finalizing profile {}",
            context.profile_id
          ),
        }

        BrowserRunner::instance()
          .handle_natural_browser_exit(context.app_handle, context.profile_id, watched_pid)
          .await;
      });

      Some(arm)
    } else {
      drop(child);
      None
    };

    let instance = WayfernInstance {
      id: id.clone(),
      process_id,
      profile_path: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
      exit_watch_arm,
    };

    let mut inner = self.inner.lock().await;
    inner.instances.insert(id.clone(), instance);

    Ok(WayfernLaunchResult {
      id,
      processId: process_id,
      profilePath: Some(profile_path.to_string()),
      url: url.map(|s| s.to_string()),
      cdp_port: Some(port),
      used_fingerprint,
    })
  }

  /// Arm the child-process waiter only after the caller has persisted the
  /// profile PID. This closes the race where a browser exits during launch
  /// and an early callback is then overwritten by stale "running" metadata.
  pub async fn arm_exit_watcher(
    &self,
    instance_id: &str,
    app_handle: AppHandle,
    profile_id: uuid::Uuid,
  ) {
    let arm = {
      let mut inner = self.inner.lock().await;
      inner
        .instances
        .get_mut(instance_id)
        .and_then(|instance| instance.exit_watch_arm.take())
    };

    if let Some(arm) = arm {
      if arm
        .send(BrowserExitWatchContext {
          app_handle,
          profile_id,
        })
        .is_err()
      {
        log::debug!("Wayfern exit watcher ended before it could be armed for {profile_id}");
      }
    }
  }

  async fn claim_naturally_exited_instance(&self, instance_id: &str, pid: u32) -> bool {
    let mut inner = self.inner.lock().await;
    let matches = inner
      .instances
      .get(instance_id)
      .is_some_and(|instance| instance.process_id == Some(pid));
    if matches {
      inner.instances.remove(instance_id);
    }
    matches
  }

  pub async fn stop_wayfern(
    &self,
    id: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let instance = {
      let mut inner = self.inner.lock().await;
      inner.instances.remove(id)
    };

    let Some(instance) = instance else {
      return Ok(());
    };
    log::info!("Cleaning up Wayfern instance {}", instance.id);
    let Some(pid) = instance.process_id else {
      return Ok(());
    };

    if let Some(port) = instance.cdp_port {
      match self.request_graceful_browser_close(port).await {
        Ok(()) => {
          log::info!(
            "Requested graceful Wayfern shutdown on CDP port {port} so session tabs can be saved"
          );
          if Self::wait_for_process_exit(pid, Duration::from_secs(3)).await {
            log::info!("Wayfern saved its session and exited cleanly (PID: {pid})");
            return Ok(());
          }
        }
        Err(error) => {
          log::warn!("Could not request graceful Wayfern shutdown on CDP port {port}: {error}");
        }
      }
    }

    log::warn!(
      "Wayfern did not exit through CDP; falling back to process termination (PID: {pid})"
    );
    #[cfg(unix)]
    {
      use nix::sys::signal::{kill, Signal};
      use nix::unistd::Pid;
      let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
      if !Self::wait_for_process_exit(pid, Duration::from_millis(500)).await {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
      }
    }
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x08000000;
      let output = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
      if !output.status.success() && Self::is_process_running(pid) {
        return Err(
          format!(
            "taskkill failed for Wayfern PID {pid}: {}",
            String::from_utf8_lossy(&output.stderr)
          )
          .into(),
        );
      }
    }
    if !Self::wait_for_process_exit(pid, Duration::from_secs(1)).await {
      return Err(format!("Wayfern PID {pid} remained alive after termination").into());
    }
    log::info!("Stopped Wayfern instance {id} (PID: {pid})");
    Ok(())
  }

  /// Opens a URL in a new tab for an existing Wayfern instance.
  pub async fn open_url_in_tab(
    &self,
    profile_path: &str,
    url: &str,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    let port = inner
      .instances
      .values()
      .find(|i| {
        i.profile_path
          .as_deref()
          .map(|p| {
            std::path::Path::new(p)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(p).to_path_buf())
              == target_path
          })
          .unwrap_or(false)
      })
      .and_then(|i| i.cdp_port)
      .ok_or("Wayfern instance (with CDP port) not found for profile")?;
    drop(inner);

    // Open the URL in a new tab via the CDP HTTP convenience endpoint.
    let new_tab_url = format!(
      "http://127.0.0.1:{port}/json/new?{}",
      urlencoding::encode(url)
    );
    let resp = self
      .http_client
      .put(&new_tab_url)
      .send()
      .await
      .map_err(|e| format!("Failed to open new tab: {e}"))?;
    if !resp.status().is_success() {
      return Err(format!("CDP /json/new returned HTTP {}", resp.status()).into());
    }

    log::info!("Opened URL in new tab via CDP: {}", url);
    Ok(())
  }

  pub async fn get_cdp_port(&self, profile_path: &str) -> Option<u16> {
    let inner = self.inner.lock().await;
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    for instance in inner.instances.values() {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          return instance.cdp_port;
        }
      }
    }
    None
  }

  pub async fn find_wayfern_by_profile(&self, profile_path: &str) -> Option<WayfernLaunchResult> {
    let mut inner = self.inner.lock().await;

    // Canonicalize the target path for comparison
    let target_path = std::path::Path::new(profile_path)
      .canonicalize()
      .unwrap_or_else(|_| std::path::Path::new(profile_path).to_path_buf());

    // Find the instance with the matching profile path
    let mut found_id: Option<String> = None;
    for (id, instance) in &inner.instances {
      if let Some(path) = &instance.profile_path {
        let instance_path = std::path::Path::new(path)
          .canonicalize()
          .unwrap_or_else(|_| std::path::Path::new(path).to_path_buf());
        if instance_path == target_path {
          found_id = Some(id.clone());
          break;
        }
      }
    }

    // If we found an instance, verify the process is still running
    if let Some(id) = found_id {
      if let Some(instance) = inner.instances.get(&id) {
        if let Some(pid) = instance.process_id {
          if Self::is_process_running(pid) {
            return Some(WayfernLaunchResult {
              id: id.clone(),
              processId: instance.process_id,
              profilePath: instance.profile_path.clone(),
              url: instance.url.clone(),
              cdp_port: instance.cdp_port,
              used_fingerprint: None,
            });
          } else {
            log::info!(
              "Wayfern process {} for profile {} is no longer running, cleaning up",
              pid,
              profile_path
            );
            inner.instances.remove(&id);
            return None;
          }
        }
      }
    }

    // If not found in in-memory instances, scan system processes.
    // This handles the case where the GUI was restarted but Wayfern is still running.
    if let Some((pid, found_profile_path, cdp_port)) =
      Self::find_wayfern_process_by_profile(&target_path)
    {
      log::info!(
        "Found running Wayfern process (PID: {}) for profile path via system scan",
        pid
      );

      let instance_id = format!("recovered_{}", pid);
      inner.instances.insert(
        instance_id.clone(),
        WayfernInstance {
          id: instance_id.clone(),
          process_id: Some(pid),
          profile_path: Some(found_profile_path.clone()),
          url: None,
          cdp_port,
          exit_watch_arm: None,
        },
      );

      return Some(WayfernLaunchResult {
        id: instance_id,
        processId: Some(pid),
        profilePath: Some(found_profile_path),
        url: None,
        cdp_port,
        used_fingerprint: None,
      });
    }

    None
  }

  /// Scan system processes to find a Wayfern/Chromium process using a specific profile path
  fn find_wayfern_process_by_profile(
    target_path: &std::path::Path,
  ) -> Option<(u32, String, Option<u16>)> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(
        ProcessRefreshKind::nothing()
          .with_cmd(UpdateKind::Always)
          .without_tasks(),
      ),
    );

    let target_path_str = target_path.to_string_lossy();

    for (pid, process) in system.processes() {
      let cmd = process.cmd();
      if cmd.is_empty() {
        continue;
      }

      let exe_name = process.name().to_string_lossy().to_lowercase();
      let is_chromium_like = exe_name.contains("wayfern")
        || exe_name.contains("chromium")
        || exe_name.contains("chrome");

      if !is_chromium_like {
        continue;
      }

      // Skip child processes (renderer, GPU, utility, zygote, etc.)
      // Only the main browser process lacks a --type= argument
      let is_child = cmd
        .iter()
        .any(|a| a.to_str().is_some_and(|s| s.starts_with("--type=")));
      if is_child {
        continue;
      }

      let mut matched = false;
      let mut cdp_port: Option<u16> = None;

      for arg in cmd.iter() {
        if let Some(arg_str) = arg.to_str() {
          if let Some(dir_val) = arg_str.strip_prefix("--user-data-dir=") {
            let cmd_path = std::path::Path::new(dir_val)
              .canonicalize()
              .unwrap_or_else(|_| std::path::Path::new(dir_val).to_path_buf());
            if cmd_path == target_path {
              matched = true;
            }
          }

          if let Some(port_val) = arg_str.strip_prefix("--remote-debugging-port=") {
            cdp_port = port_val.parse().ok();
          }
        }
      }

      if matched {
        return Some((pid.as_u32(), target_path_str.to_string(), cdp_port));
      }
    }

    None
  }

  #[allow(dead_code)]
  pub async fn launch_wayfern_profile(
    &self,
    app_handle: &AppHandle,
    profile: &BrowserProfile,
    config: &WayfernConfig,
    url: Option<&str>,
    proxy_url: Option<&str>,
  ) -> Result<WayfernLaunchResult, Box<dyn std::error::Error + Send + Sync>> {
    let profiles_dir = self.get_profiles_dir();
    let profile_path = profiles_dir.join(profile.id.to_string()).join("profile");
    let profile_path_str = profile_path.to_string_lossy().to_string();

    std::fs::create_dir_all(&profile_path)?;

    if let Some(existing) = self.find_wayfern_by_profile(&profile_path_str).await {
      log::info!("Stopping existing Wayfern instance for profile");
      self.stop_wayfern(&existing.id).await?;
    }

    self
      .launch_wayfern(
        app_handle,
        profile,
        &profile_path_str,
        config,
        url,
        proxy_url,
        profile.ephemeral,
        &[],
        None,
        false,
      )
      .await
  }

  #[allow(dead_code)]
  pub async fn cleanup_dead_instances(&self) {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};

    let mut inner = self.inner.lock().await;
    let mut dead_ids = Vec::new();

    let system = System::new_with_specifics(
      RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
    );

    for (id, instance) in &inner.instances {
      if let Some(pid) = instance.process_id {
        let pid = sysinfo::Pid::from_u32(pid);
        if !system.processes().contains_key(&pid) {
          dead_ids.push(id.clone());
        }
      }
    }

    for id in dead_ids {
      log::info!("Cleaning up dead Wayfern instance: {id}");
      inner.instances.remove(&id);
    }
  }
}

lazy_static::lazy_static! {
  static ref WAYFERN_MANAGER: WayfernManager = WayfernManager::new();
}

/// Deterministically derive a pleasant, distinct window frame color from a
/// profile id so concurrent profile windows are visually distinguishable even
/// when the user has not picked a custom color. Stable per profile (same id
/// always yields the same color). Returns "#RRGGBB".
pub fn derive_profile_color(id: &uuid::Uuid) -> String {
  // FNV-1a over the 16 id bytes -> hue in [0,360). The hue varies per profile
  // while saturation/lightness are fixed to a pastel band (see below).
  let mut h: u32 = 2166136261;
  for &b in id.as_bytes() {
    h = (h ^ u32::from(b)).wrapping_mul(16777619);
  }
  let hue = f64::from(h % 360);
  // Pastel: high lightness + soft saturation so windows stay easy to tell apart
  // without a garish frame.
  let (r, g, b) = hsl_to_rgb(hue, 0.6, 0.8);
  format!("#{r:02x}{g:02x}{b:02x}")
}

/// Convert HSL (h in [0,360), s/l in [0,1]) to 8-bit RGB.
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
  let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
  let hp = h / 60.0;
  let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
  let (r1, g1, b1) = match hp as i32 {
    0 => (c, x, 0.0),
    1 => (x, c, 0.0),
    2 => (0.0, c, x),
    3 => (0.0, x, c),
    4 => (x, 0.0, c),
    _ => (c, 0.0, x),
  };
  let m = l - c / 2.0;
  let to_u8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
  (to_u8(r1), to_u8(g1), to_u8(b1))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn natural_exit_claim_requires_the_current_instance_and_pid() {
    let manager = WayfernManager::instance();
    let instance_id = uuid::Uuid::new_v4().to_string();
    manager.inner.lock().await.instances.insert(
      instance_id.clone(),
      WayfernInstance {
        id: instance_id.clone(),
        process_id: Some(424_242),
        profile_path: None,
        url: None,
        cdp_port: None,
        exit_watch_arm: None,
      },
    );

    assert!(
      !manager
        .claim_naturally_exited_instance(&instance_id, 111_111)
        .await
    );
    assert!(
      manager
        .claim_naturally_exited_instance(&instance_id, 424_242)
        .await
    );
    assert!(
      !manager
        .claim_naturally_exited_instance(&instance_id, 424_242)
        .await
    );
  }

  #[test]
  fn primary_wayfern_launch_restores_the_profiles_previous_tabs() {
    let args = WayfernManager::profile_launch_args(9222, "/tmp/test-profile");
    assert!(args.iter().any(|arg| arg == RESTORE_LAST_SESSION_ARG));
  }

  #[test]
  fn remote_socks_url_detection() {
    // Remote socks upstreams (the hyper-util-affected case) are detected...
    assert!(WayfernManager::is_remote_socks_url(
      "socks5://user:pass@gw.dataimpulse.com:10000"
    ));
    assert!(WayfernManager::is_remote_socks_url("socks5://1.2.3.4:1080"));
    assert!(WayfernManager::is_remote_socks_url("socks4://1.2.3.4:1080"));

    // ...but the app's own loopback workers are not. socks is a non-special
    // URL scheme, so the IP literal parses as Host::Domain — the launch-time
    // randomize path depends on this returning false.
    assert!(!WayfernManager::is_remote_socks_url(
      "socks5://127.0.0.1:24001"
    ));
    assert!(!WayfernManager::is_remote_socks_url("socks5://[::1]:24001"));
    assert!(!WayfernManager::is_remote_socks_url(
      "socks5://localhost:24001"
    ));

    // Non-socks schemes and unparsable URLs never need the workaround.
    assert!(!WayfernManager::is_remote_socks_url(
      "http://gw.dataimpulse.com:10000"
    ));
    assert!(!WayfernManager::is_remote_socks_url(
      "https://gw.dataimpulse.com:10000"
    ));
    assert!(!WayfernManager::is_remote_socks_url("socks5://"));
    assert!(!WayfernManager::is_remote_socks_url("not a url"));
  }

  #[test]
  fn work_area_conversion_accounts_for_windows_scaling() {
    assert_eq!(
      WayfernManager::logical_work_area_from_physical(0, 40, 2560, 1400, 1.25),
      Some(LogicalWorkArea {
        x: 0,
        y: 32,
        width: 2048,
        height: 1120,
      })
    );
    assert_eq!(
      WayfernManager::logical_work_area_from_physical(0, 0, 1920, 1080, 0.0),
      None
    );
  }

  #[test]
  fn scaled_placement_grows_window_on_high_dpi_and_rounds() {
    // A 200% display needs the window physically twice as large so it still
    // looks like the intended logical size.
    let logical = WindowPlacement {
      x: 10,
      y: 20,
      width: 1217,
      height: 732,
    };
    assert_eq!(
      WayfernManager::scale_placement(logical, 2.0),
      WindowPlacement {
        x: 20,
        y: 40,
        width: 2434,
        height: 1464,
      }
    );
    assert_eq!(
      WayfernManager::scale_placement(logical, 1.5),
      WindowPlacement {
        x: 15,
        y: 30,
        width: 1826,
        height: 1098,
      }
    );
  }

  #[test]
  fn scaled_placement_is_identity_at_scale_one() {
    let logical = WindowPlacement {
      x: -123,
      y: 45,
      width: 1211,
      height: 710,
    };
    assert_eq!(WayfernManager::scale_placement(logical, 1.0), logical);
  }

  #[test]
  fn scaled_placement_clamps_to_native_ranges() {
    let logical = WindowPlacement {
      x: i32::MAX,
      y: i32::MIN,
      width: u32::MAX,
      height: u32::MAX,
    };
    assert_eq!(
      WayfernManager::scale_placement(logical, 4.0),
      WindowPlacement {
        x: i32::MAX,
        y: i32::MIN,
        width: u32::MAX,
        height: u32::MAX,
      }
    );
  }

  #[test]
  fn window_size_is_clamped_inside_small_work_areas() {
    assert_eq!(
      WayfernManager::fit_window_size_to_work_area(
        LogicalWorkArea {
          x: 0,
          y: 0,
          width: 1024,
          height: 700,
        },
        (1282, 751),
      ),
      (1000, 676)
    );
  }

  #[test]
  fn default_window_size_stays_inside_requested_random_range() {
    for _ in 0..128 {
      let (width, height) = WayfernManager::random_default_window_size();
      assert!((DEFAULT_WINDOW_MIN_WIDTH..=DEFAULT_WINDOW_MAX_WIDTH).contains(&width));
      assert!((DEFAULT_WINDOW_MIN_HEIGHT..=DEFAULT_WINDOW_MAX_HEIGHT).contains(&height));
    }
  }

  #[test]
  fn staggered_windows_stay_centered_and_inside_the_work_area() {
    let work_area = LogicalWorkArea {
      x: 0,
      y: 32,
      width: 2048,
      height: 1120,
    };
    let centered = WayfernManager::position_window_in_work_area(work_area, (1282, 751), (0, 0));
    assert_eq!(
      centered,
      WindowPlacement {
        x: 383,
        y: 216,
        width: 1282,
        height: 751,
      }
    );

    let staggered = WayfernManager::position_window_in_work_area(work_area, (1282, 751), (56, 36));
    assert_eq!((staggered.x, staggered.y), (439, 252));
    assert!(staggered.x >= WINDOW_EDGE_MARGIN as i32);
    assert!(staggered.y >= 32 + WINDOW_EDGE_MARGIN as i32);
    assert!(staggered.x + staggered.width as i32 <= 2048 - WINDOW_EDGE_MARGIN as i32);
    assert!(staggered.y + staggered.height as i32 <= 1152 - WINDOW_EDGE_MARGIN as i32);
  }

  #[test]
  fn staggered_windows_handle_negative_monitor_coordinates() {
    let placement = WayfernManager::position_window_in_work_area(
      LogicalWorkArea {
        x: -1920,
        y: 30,
        width: 1920,
        height: 1050,
      },
      (1280, 750),
      (-56, 36),
    );
    assert_eq!((placement.x, placement.y), (-1656, 216));
    assert!(placement.x >= -1920 + WINDOW_EDGE_MARGIN as i32);
    assert!(placement.x + placement.width as i32 <= -(WINDOW_EDGE_MARGIN as i32));
    assert!(placement.y + placement.height as i32 <= 1080 - WINDOW_EDGE_MARGIN as i32);
  }

  #[test]
  fn first_three_cascade_slots_are_distinct() {
    assert_eq!(WayfernManager::cascade_offset(0, 0, 0), (0, 0));
    assert_eq!(WayfernManager::cascade_offset(1, 0, 0), (56, 36));
    assert_eq!(WayfernManager::cascade_offset(2, 0, 0), (-56, 36));
  }

  #[test]
  fn launch_metrics_keep_fingerprint_scale_and_geometry_consistent() {
    let mut fingerprint = json!({
      "windowOuterWidth": 1268,
      "windowOuterHeight": 764,
      "windowInnerWidth": 1253,
      "windowInnerHeight": 630,
      "screenX": 0,
      "screenY": 0,
    });
    WayfernManager::apply_display_metrics_to_fingerprint(
      &mut fingerprint,
      WindowLaunchConfig {
        placement: WindowPlacement {
          x: 383,
          y: 216,
          width: 1211,
          height: 710,
        },
        scale_factor: 1.25,
        screen_width: 2048,
        screen_height: 1152,
        work_area: LogicalWorkArea {
          x: 0,
          y: 32,
          width: 2048,
          height: 1120,
        },
      },
      None,
    );

    assert_eq!(fingerprint["screenWidth"], 2048);
    assert_eq!(fingerprint["screenHeight"], 1152);
    assert_eq!(fingerprint["screenAvailWidth"], 2048);
    assert_eq!(fingerprint["screenAvailHeight"], 1120);
    assert_eq!(fingerprint["devicePixelRatio"], 1.25);
    assert_eq!(fingerprint["windowOuterWidth"], 1211);
    assert_eq!(fingerprint["windowOuterHeight"], 710);
    assert_eq!(fingerprint["windowInnerWidth"], 1196);
    assert_eq!(fingerprint["windowInnerHeight"], 576);
    assert_eq!(fingerprint["screenX"], 383);
    assert_eq!(fingerprint["screenY"], 216);
  }

  #[test]
  fn measured_browser_metrics_override_geometry_estimates() {
    let mut fingerprint = json!({});
    let actual = json!({
      "screenWidth": 2048,
      "screenHeight": 1152,
      "screenAvailWidth": 2048,
      "screenAvailHeight": 1120,
      "screenColorDepth": 24,
      "screenPixelDepth": 24,
      "devicePixelRatio": 1.25,
      "windowOuterWidth": 1220,
      "windowOuterHeight": 720,
      "windowInnerWidth": 1205,
      "windowInnerHeight": 586,
      "screenX": 390,
      "screenY": 220,
    });
    let actual = actual.as_object().unwrap();
    WayfernManager::apply_display_metrics_to_fingerprint(
      &mut fingerprint,
      WindowLaunchConfig {
        placement: WindowPlacement {
          x: 383,
          y: 216,
          width: 1211,
          height: 710,
        },
        scale_factor: 1.25,
        screen_width: 2048,
        screen_height: 1152,
        work_area: LogicalWorkArea {
          x: 0,
          y: 32,
          width: 2048,
          height: 1120,
        },
      },
      Some(actual),
    );

    assert_eq!(fingerprint["windowOuterWidth"], 1220);
    assert_eq!(fingerprint["windowOuterHeight"], 720);
    assert_eq!(fingerprint["windowInnerWidth"], 1205);
    assert_eq!(fingerprint["windowInnerHeight"], 586);
    assert_eq!(fingerprint["screenX"], 390);
    assert_eq!(fingerprint["screenY"], 220);
    assert_eq!(fingerprint["devicePixelRatio"], 1.25);
  }

  #[test]
  fn display_metrics_are_extracted_from_cdp_evaluation() {
    let evaluation = json!({
      "result": {
        "type": "object",
        "value": {
          "devicePixelRatio": 1.25,
          "windowOuterWidth": 1211,
        }
      }
    });
    let metrics = WayfernManager::display_metrics_from_evaluation(&evaluation).unwrap();

    assert_eq!(metrics["devicePixelRatio"], 1.25);
    assert_eq!(metrics["windowOuterWidth"], 1211);
  }
}
