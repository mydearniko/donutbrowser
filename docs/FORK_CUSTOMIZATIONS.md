# Fork Customizations

This file documents intentional fork-specific changes from upstream Donut Browser.
Keep it updated whenever the fork diverges from upstream behavior.

Last updated: 2026-06-10

## Baseline

- Fork custom work started from upstream history around `202f2c8 chore: update flake.nix for v0.26.0 [skip ci] (#428)`.
- Custom commits currently include `bea9d04`, `5775663`, `0301bc1`, and `9e74d83`, plus later local changes documented here.

## Fingerprint Pro Lock Removal

- Removed the Pro-lock overlay from fingerprint and cross-OS fingerprint configuration UI paths.
- Kept the broader entitlement system intact instead of globally unlocking every entitlement.
- Affected areas include fingerprint config dialogs/forms and related prop passing.
- Known intentional scope: unrelated Pro-gated features such as cloud sync, automation/team/profile limits, extension limited mode, and trial modal behavior were not broadly changed.

## Resizable Main Window

- Changed the main Tauri window from fixed-size to resizable.
- Added a minimum inner window size of `880x500`.
- Added Windows custom resize hit zones using Tauri `startResizeDragging` because the app uses custom window chrome.
- Added the required Tauri permission `core:window:allow-start-resize-dragging`.
- Key files:
  - `src-tauri/src/lib.rs`
  - `src-tauri/capabilities/default.json`
  - `src/components/window-resize-handles.tsx`
  - `src/components/client-providers.tsx`

## Windows Artifact Workflow

- Added `.github/workflows/build-windows-artifact.yml` for fork-friendly manual Windows builds.
- Workflow dispatch inputs:
  - `build_profile=debug` by default for the fastest portable executable.
  - `build_profile=release` for optimized builds.
  - `bundle_installer=false` by default to skip slow installer bundling.
  - `bundle_installer=true` is allowed only with `build_profile=release`.
- The workflow uploads `Donut_x64-portable.zip` and the built executable as a GitHub Actions artifact.
- Warm-up/caching changes:
  - Rust cache uses the `src-tauri -> target` workspace.
  - Next.js cache is persisted from `.next/cache`.
  - `CARGO_INCREMENTAL=1` is set for faster warmed debug builds.
- Measured on GitHub-hosted Windows after warm-up:
  - First successful debug warm-up run: about 24m45s.
  - Second warmed debug run: about 12m42s.

## Automatic Updates Disabled

- Automatic app update checks are disabled.
- Automatic app update downloads are disabled.
- Automatic browser update checks are disabled.
- Automatic browser downloads/profile version auto-bumps from update checks are disabled.
- Automatic profile version bumps on startup, browser stop, status polling, and manual browser download completion are disabled.
- Browser version consolidation no longer changes profile versions or removes old binaries as an update side effect.
- Browser extension auto-update preferences are disabled for generated profile prefs.
- Startup/background version polling is disabled.
- The backend app update command used for automatic checks now returns `Ok(None)`.
- The backend browser auto-update-with-progress command path is no longer registered.
- The frontend no longer starts periodic browser update checks or startup app update checks.
- Manual update commands/checks may still exist for explicit user-triggered actions, but they should not run automatically.
- Key files:
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/auto_updater.rs`
  - `src-tauri/src/app_auto_updater.rs`
  - `src-tauri/src/browser_runner.rs`
  - `src-tauri/src/downloaded_browsers_registry.rs`
  - `src-tauri/src/downloader.rs`
  - `src-tauri/src/profile/manager.rs`
  - `src-tauri/src/version_updater.rs`
  - `src-tauri/src/settings_manager.rs`
  - `src/app/page.tsx`
  - `src/hooks/use-app-update-notifications.tsx`
  - `src/hooks/use-update-notifications.tsx`
  - `src/hooks/use-version-updater.ts`

## Maintenance Notes

- If upstream changes update logic, re-check startup tasks in `src-tauri/src/lib.rs` and hooks under `src/hooks/` before merging.
- If upstream changes entitlement logic, keep fingerprint UI behavior scoped and avoid globally changing `src/lib/entitlements.ts` unless explicitly intended.
- If this fork needs faster Windows builds, prefer improving the debug portable workflow before changing release packaging.
