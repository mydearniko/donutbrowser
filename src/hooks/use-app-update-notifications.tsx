"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppUpdateToast } from "@/components/app-update-toast";
import { showToast } from "@/lib/toast-utils";
import type { AppUpdateInfo, AppUpdateProgress } from "@/types";

export function useAppUpdateNotifications() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] =
    useState<AppUpdateProgress | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // Ensure we're on the client side to prevent hydration mismatches
  useEffect(() => {
    setIsClient(true);
  }, []);

  const checkForAppUpdates = useCallback(async () => {
    if (!isClient) return;

    try {
      const update = await invoke<AppUpdateInfo | null>(
        "check_for_app_updates",
      );

      // Don't show update if this version was already dismissed
      if (update && update.new_version !== dismissedVersion) {
        setUpdateInfo(update);
      } else if (update) {
        console.log("Update available but dismissed:", update.new_version);
      }
    } catch (error) {
      console.error("Failed to check for app updates:", error);
    }
  }, [isClient, dismissedVersion]);

  const checkForAppUpdatesManual = useCallback(async () => {
    if (!isClient) return;

    try {
      console.log("Triggering manual app update check...");
      const update = await invoke<AppUpdateInfo | null>(
        "check_for_app_updates_manual",
      );
      console.log("Manual check result:", update);

      // Always show manual check results, but never auto-download updates.
      setUpdateInfo(
        update ? { ...update, manual_update_required: true } : null,
      );
    } catch (error) {
      console.error("Failed to manually check for app updates:", error);
    }
  }, [isClient]);

  const handleRestart = useCallback(async () => {
    try {
      await invoke("restart_application");
    } catch (error) {
      console.error("Failed to restart app:", error);
      showToast({
        type: "error",
        title: t("appUpdate.toast.restartFailed"),
        description: String(error),
        duration: 6000,
      });
    }
  }, [t]);

  const dismissAppUpdate = useCallback(() => {
    if (!isClient) return;

    // Remember the dismissed version so we don't show it again
    if (updateInfo) {
      setDismissedVersion(updateInfo.new_version);
      console.log("Dismissed app update version:", updateInfo.new_version);
    }

    setUpdateInfo(null);
    toast.dismiss("app-update");
  }, [isClient, updateInfo]);

  // Listen for app update events
  useEffect(() => {
    if (!isClient) return;

    const unlistenUpdate = listen<AppUpdateInfo>(
      "app-update-available",
      (event) => {
        console.log("App update available:", event.payload);
        setUpdateInfo(event.payload);
      },
    );

    const unlistenProgress = listen<AppUpdateProgress>(
      "app-update-progress",
      (event) => {
        setUpdateProgress(event.payload);
      },
    );

    const unlistenReady = listen<string>("app-update-ready", (event) => {
      console.log("App update ready:", event.payload);
      setUpdateReady(true);
      setIsUpdating(false);
      setUpdateProgress(null);
    });

    return () => {
      void unlistenUpdate.then((unlisten) => {
        unlisten();
      });
      void unlistenProgress.then((unlisten) => {
        unlisten();
      });
      void unlistenReady.then((unlisten) => {
        unlisten();
      });
    };
  }, [isClient]);

  // Show toast only when update is ready to install or requires manual action
  useEffect(() => {
    if (!isClient) return;

    const showManualToast = updateInfo?.manual_update_required && !isUpdating;
    if (!updateReady && !showManualToast) {
      return;
    }
    if (!updateInfo) return;

    toast.custom(
      () => (
        <AppUpdateToast
          updateInfo={updateInfo}
          onRestart={handleRestart}
          onDismiss={dismissAppUpdate}
          updateReady={updateReady}
        />
      ),
      {
        id: "app-update",
        duration: Number.POSITIVE_INFINITY,
        position: "top-left",
        style: {
          zIndex: 99999,
          pointerEvents: "auto",
          marginTop: "16px",
        },
      },
    );
  }, [
    updateInfo,
    handleRestart,
    dismissAppUpdate,
    updateReady,
    isUpdating,
    isClient,
  ]);

  return {
    updateInfo,
    isUpdating,
    updateProgress,
    updateReady,
    checkForAppUpdates,
    checkForAppUpdatesManual,
    dismissAppUpdate,
  };
}
