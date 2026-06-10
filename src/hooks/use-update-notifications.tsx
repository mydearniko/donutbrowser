import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";

interface UpdateNotification {
  id: string;
  browser: string;
  current_version: string;
  new_version: string;
  affected_profiles: string[];
  is_stable_update: boolean;
  timestamp: number;
  is_rolling_release: boolean;
}

export function useUpdateNotifications() {
  const [notifications, setNotifications] = useState<UpdateNotification[]>([]);
  const [updatingBrowsers] = useState<Set<string>>(new Set());
  const [processedNotifications, setProcessedNotifications] = useState<
    Set<string>
  >(new Set());

  const isUpdating = useCallback(
    (browser: string) => updatingBrowsers.has(browser),
    [updatingBrowsers],
  );

  // Add refs to track ongoing operations to prevent duplicates
  const isCheckingForUpdates = useRef(false);

  const checkForUpdates = useCallback(async () => {
    // Prevent multiple simultaneous calls
    if (isCheckingForUpdates.current) {
      console.log("Already checking for updates, skipping duplicate call");
      return;
    }

    isCheckingForUpdates.current = true;

    try {
      const updates = await invoke<UpdateNotification[]>(
        "check_for_browser_updates",
      );

      // Filter out already processed notifications
      const newUpdates = updates.filter((notification) => {
        return !processedNotifications.has(notification.id);
      });

      setNotifications(newUpdates);

      // Keep notifications only; automatic browser downloads are disabled.
      for (const notification of newUpdates) {
        if (!processedNotifications.has(notification.id)) {
          setProcessedNotifications((prev) =>
            new Set(prev).add(notification.id),
          );
        }
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    } finally {
      isCheckingForUpdates.current = false;
    }
  }, [processedNotifications]);

  return {
    notifications,
    isUpdating,
    checkForUpdates,
  };
}
