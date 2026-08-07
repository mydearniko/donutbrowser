"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCloud,
  LuEye,
  LuEyeOff,
  LuLogOut,
  LuRefreshCw,
  LuUser,
} from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type { SyncSettings } from "@/types";

interface AccountPageProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
  onOpenSignIn: () => void;
}

type ConnectionStatus = "unknown" | "testing" | "connected" | "error";

interface EnableRegularSyncResult {
  total: number;
  enabled: number;
  already_enabled: number;
  skipped_running: number;
  skipped_ephemeral: number;
  skipped_cross_os: number;
  failed: number;
}

interface SyncDeviceIdentity {
  device_id: string;
  device_name: string;
}

export function AccountPage({
  isOpen,
  onClose,
  subPage,
  onOpenSignIn,
}: AccountPageProps) {
  const { t } = useTranslation();
  const {
    user,
    isLoggedIn,
    isLoading: isCloudLoading,
    logout,
    refreshProfile,
  } = useCloudAuth();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Self-hosted server state. Loaded once when the dialog opens and persisted
  // via `save_sync_settings` so the rest of the app picks up the new URL/token
  // from `SettingsManager`.
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isSavingSelfHosted, setIsSavingSelfHosted] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [hasSavedSelfHostedConfig, setHasSavedSelfHostedConfig] =
    useState(false);
  const [regularSyncByDefault, setRegularSyncByDefault] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [savedDeviceId, setSavedDeviceId] = useState("");
  const [savedDeviceName, setSavedDeviceName] = useState("");
  const [isSavingDeviceIdentity, setIsSavingDeviceIdentity] = useState(false);
  const [isSavingSyncDefault, setIsSavingSyncDefault] = useState(false);
  const [isApplyingSyncEverywhere, setIsApplyingSyncEverywhere] =
    useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("unknown");

  const hasConfig = Boolean(serverUrl && token);
  // Self-hosted and cloud are mutually exclusive — both share the same sync
  // engine and a profile can't be sync'd to two backends. The tab trigger is
  // disabled here AND the backend rejects mixed state (see `save_sync_settings`
  // / `cloud_logout`), so even if someone bypasses the UI we don't end up
  // with split-brain.
  const selfHostedDisabled = isLoggedIn || isCloudLoading;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshProfile();
      showSuccessToast(t("account.refreshed"));
    } catch (e) {
      showErrorToast(String(e));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      // The backend wipes sync URL + token as part of cloud_logout (see
      // `cloud_auth::cloud_logout`); pull the now-empty settings back into
      // the form so a user who flips to the Self-hosted tab doesn't see the
      // pre-logout production URL still sitting there.
      await loadSelfHostedSettings();
      showSuccessToast(t("account.loggedOut"));
    } catch (e) {
      showErrorToast(String(e));
    } finally {
      setIsLoggingOut(false);
    }
  };

  const loadSelfHostedSettings = useCallback(async () => {
    try {
      const settings = await invoke<SyncSettings>("get_sync_settings");
      setServerUrl(settings.sync_server_url ?? "");
      setToken(settings.sync_token ?? "");
      setHasSavedSelfHostedConfig(
        Boolean(settings.sync_server_url && settings.sync_token),
      );
      setRegularSyncByDefault(settings.default_profile_sync_mode === "Regular");
      setDeviceId(settings.sync_device_id ?? "");
      setDeviceName(settings.sync_device_name ?? "");
      setSavedDeviceId(settings.sync_device_id ?? "");
      setSavedDeviceName(settings.sync_device_name ?? "");
      setConnectionStatus(
        settings.sync_server_url && settings.sync_token ? "unknown" : "unknown",
      );
    } catch (error) {
      console.error("Failed to load sync settings:", error);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadSelfHostedSettings();
    }
  }, [isOpen, loadSelfHostedSettings]);

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl) {
      showErrorToast(t("sync.config.serverUrlRequired"));
      return;
    }
    setIsTestingConnection(true);
    setConnectionStatus("testing");
    try {
      const healthUrl = `${serverUrl.replace(/\/$/, "")}/health`;
      const response = await fetch(healthUrl);
      if (response.ok) {
        setConnectionStatus("connected");
        showSuccessToast(t("sync.config.connectionSuccess"));
      } else {
        setConnectionStatus("error");
        showErrorToast(t("sync.config.serverError"));
      }
    } catch {
      setConnectionStatus("error");
      showErrorToast(t("sync.config.connectFailed"));
    } finally {
      setIsTestingConnection(false);
    }
  }, [serverUrl, t]);

  const handleSaveSelfHosted = useCallback(async () => {
    setIsSavingSelfHosted(true);
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: serverUrl || null,
        syncToken: token || null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      setHasSavedSelfHostedConfig(Boolean(serverUrl && token));
      showSuccessToast(t("sync.config.settingsSaved"));
    } catch (error) {
      console.error("Failed to save sync settings:", error);
      // Use the structured backend-error translator so the cloud-vs-self-
      // hosted mutex (`SELF_HOSTED_REQUIRES_LOGOUT`) shows a clear message
      // instead of the generic "save failed" toast.
      showErrorToast(translateBackendError(t as never, error));
    } finally {
      setIsSavingSelfHosted(false);
    }
  }, [serverUrl, token, t]);

  const handleDisconnectSelfHosted = useCallback(async () => {
    setIsSavingSelfHosted(true);
    try {
      await invoke<SyncSettings>("save_sync_settings", {
        syncServerUrl: null,
        syncToken: null,
      });
      try {
        await invoke("restart_sync_service");
      } catch (e) {
        console.error("Failed to restart sync service:", e);
      }
      setServerUrl("");
      setToken("");
      setHasSavedSelfHostedConfig(false);
      setRegularSyncByDefault(false);
      setConnectionStatus("unknown");
      showSuccessToast(t("sync.config.disconnected"));
    } catch (error) {
      console.error("Failed to disconnect:", error);
      showErrorToast(t("sync.config.disconnectFailed"));
    } finally {
      setIsSavingSelfHosted(false);
    }
  }, [t]);

  const handleRegularSyncDefaultChange = useCallback(
    async (enabled: boolean) => {
      setIsSavingSyncDefault(true);
      try {
        await invoke("set_regular_sync_default", { enabled });
        setRegularSyncByDefault(enabled);
        showSuccessToast(
          t(
            enabled
              ? "account.selfHosted.syncDefaults.enabledToast"
              : "account.selfHosted.syncDefaults.disabledToast",
          ),
        );
      } catch (error) {
        showErrorToast(translateBackendError(t as never, error));
      } finally {
        setIsSavingSyncDefault(false);
      }
    },
    [t],
  );

  const handleSaveDeviceIdentity = useCallback(async () => {
    setIsSavingDeviceIdentity(true);
    try {
      const identity = await invoke<SyncDeviceIdentity>(
        "save_sync_device_identity",
        {
          deviceId,
          deviceName,
        },
      );
      setDeviceId(identity.device_id);
      setDeviceName(identity.device_name);
      setSavedDeviceId(identity.device_id);
      setSavedDeviceName(identity.device_name);
      await invoke("restart_sync_service");
      showSuccessToast(t("account.selfHosted.deviceIdentity.saved"));
    } catch (error) {
      showErrorToast(translateBackendError(t as never, error));
    } finally {
      setIsSavingDeviceIdentity(false);
    }
  }, [deviceId, deviceName, t]);

  const handleEnableRegularSyncEverywhere = useCallback(async () => {
    setIsApplyingSyncEverywhere(true);
    try {
      const result = await invoke<EnableRegularSyncResult>(
        "enable_regular_sync_everywhere",
      );
      setRegularSyncByDefault(true);
      const skipped =
        result.skipped_running +
        result.skipped_ephemeral +
        result.skipped_cross_os;
      const description = t("account.selfHosted.syncDefaults.applyResult", {
        enabled: result.enabled,
        alreadyEnabled: result.already_enabled,
        skipped,
        failed: result.failed,
      });
      if (result.failed > 0) {
        showErrorToast(t("account.selfHosted.syncDefaults.applyPartial"), {
          description,
        });
      } else {
        showSuccessToast(t("account.selfHosted.syncDefaults.applySuccess"), {
          description,
        });
      }
    } catch (error) {
      showErrorToast(translateBackendError(t as never, error));
    } finally {
      setIsApplyingSyncEverywhere(false);
    }
  }, [t]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
      <DialogContent className="flex max-h-[calc(100vh-4rem)] max-w-2xl flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
            subPage && "mx-auto w-full max-w-2xl",
          )}
        >
          <AnimatedTabs defaultValue="account">
            <AnimatedTabsList>
              <AnimatedTabsTrigger value="account">
                {t("account.tabs.account")}
              </AnimatedTabsTrigger>
              <AnimatedTabsTrigger
                value="self-hosted"
                disabled={selfHostedDisabled}
                title={
                  selfHostedDisabled
                    ? t("account.selfHosted.disabledWhileLoggedIn")
                    : undefined
                }
              >
                {t("account.tabs.selfHosted")}
              </AnimatedTabsTrigger>
            </AnimatedTabsList>

            <AnimatedTabsContent value="account" className="mt-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <div className="grid size-12 shrink-0 place-items-center rounded-full bg-accent text-foreground">
                    <LuUser className="size-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    {isLoggedIn && user ? (
                      <>
                        <h2 className="truncate text-base font-semibold">
                          {user.email}
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("account.plan", {
                            plan: user.plan,
                            period: user.planPeriod ?? "—",
                          })}
                        </p>
                      </>
                    ) : (
                      <>
                        <h2 className="text-base font-semibold">
                          {t("account.signedOut")}
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("account.signedOutDescription")}
                        </p>
                      </>
                    )}
                  </div>
                </div>

                {isLoggedIn && user && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        {t("account.fields.plan")}
                      </p>
                      <p className="mt-0.5 font-medium uppercase">
                        {user.plan}
                      </p>
                    </div>
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        {t("account.fields.status")}
                      </p>
                      <p className="mt-0.5">{user.subscriptionStatus ?? "—"}</p>
                    </div>
                    {user.teamRole && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                          {t("account.fields.teamRole")}
                        </p>
                        <p className="mt-0.5">{user.teamRole}</p>
                      </div>
                    )}
                    {user.planPeriod && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                          {t("account.fields.period")}
                        </p>
                        <p className="mt-0.5">{user.planPeriod}</p>
                      </div>
                    )}
                    {typeof user.deviceOrdinal === "number" && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                          {t("account.fields.device")}
                        </p>
                        <p className="mt-0.5">
                          {t("account.deviceOrdinal", {
                            ordinal: user.deviceOrdinal,
                            count: user.deviceCount ?? user.deviceOrdinal,
                          })}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  {isLoggedIn ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void handleRefresh();
                        }}
                        disabled={isRefreshing}
                        className="h-8 gap-1.5 text-xs"
                      >
                        <LuRefreshCw className="size-3" />
                        {t("account.refresh")}
                      </Button>
                      <LoadingButton
                        size="sm"
                        variant="destructive"
                        isLoading={isLoggingOut}
                        disabled={isRefreshing}
                        onClick={() => {
                          void handleLogout();
                        }}
                        className="h-8 gap-1.5 text-xs"
                      >
                        <LuLogOut className="size-3" />
                        {t("account.logout")}
                      </LoadingButton>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      onClick={onOpenSignIn}
                      className="h-8 gap-1.5 text-xs"
                    >
                      <LuCloud className="size-3" />
                      {t("account.signIn")}
                    </Button>
                  )}
                </div>
              </div>
            </AnimatedTabsContent>

            <AnimatedTabsContent value="self-hosted" className="mt-4">
              {selfHostedDisabled ? (
                // Defensive: the tab trigger is disabled while the user is
                // logged in, so this branch shouldn't be reachable via UI —
                // but if state flips mid-render (e.g. a cloud login finishes
                // while the tab is open), show the explanation instead of
                // a silent empty card.
                <p className="text-sm text-muted-foreground">
                  {t("account.selfHosted.disabledWhileLoggedIn")}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-sm font-medium">
                      {t("account.selfHosted.title")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("account.selfHosted.description")}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="self-hosted-server-url" className="text-xs">
                      {t("sync.serverUrl")}
                    </Label>
                    <Input
                      id="self-hosted-server-url"
                      type="url"
                      placeholder={t("sync.serverUrlPlaceholder")}
                      value={serverUrl}
                      onChange={(e) => {
                        setServerUrl(e.target.value);
                        setConnectionStatus("unknown");
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="self-hosted-token" className="text-xs">
                      {t("sync.token")}
                    </Label>
                    <div className="relative">
                      <Input
                        id="self-hosted-token"
                        type={showToken ? "text" : "password"}
                        placeholder={t("sync.tokenPlaceholder")}
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                          setConnectionStatus("unknown");
                        }}
                        autoComplete="off"
                        spellCheck={false}
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setShowToken((v) => !v);
                        }}
                        aria-label={
                          showToken
                            ? t("common.aria.hideToken")
                            : t("common.aria.showToken")
                        }
                        className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                      >
                        {showToken ? (
                          <LuEyeOff className="size-3.5" />
                        ) : (
                          <LuEye className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {t("account.selfHosted.connectionStatus")}
                    </span>
                    {connectionStatus === "connected" && (
                      <Badge
                        variant="default"
                        className="bg-success text-success-foreground"
                      >
                        {t("sync.status.connected")}
                      </Badge>
                    )}
                    {connectionStatus === "error" && (
                      <Badge variant="destructive">
                        {t("sync.status.error")}
                      </Badge>
                    )}
                    {connectionStatus === "testing" && (
                      <Badge variant="secondary">
                        {t("sync.status.syncing")}
                      </Badge>
                    )}
                    {connectionStatus === "unknown" && (
                      <Badge variant="secondary">
                        {t("account.selfHosted.statusUnknown")}
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <LoadingButton
                      size="sm"
                      variant="outline"
                      isLoading={isTestingConnection}
                      disabled={!serverUrl || isSavingSelfHosted}
                      onClick={() => void handleTestConnection()}
                      className="h-8 text-xs"
                    >
                      {t("account.selfHosted.testConnection")}
                    </LoadingButton>
                    <LoadingButton
                      size="sm"
                      isLoading={isSavingSelfHosted}
                      disabled={!serverUrl || !token || isTestingConnection}
                      onClick={() => void handleSaveSelfHosted()}
                      className="h-8 text-xs"
                    >
                      {t("common.buttons.save")}
                    </LoadingButton>
                    {hasConfig && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={isSavingSelfHosted || isTestingConnection}
                        onClick={() => void handleDisconnectSelfHosted()}
                        className="h-8 text-xs"
                      >
                        {t("account.selfHosted.disconnect")}
                      </Button>
                    )}
                  </div>

                  <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                    <div>
                      <p className="text-sm font-medium">
                        {t("account.selfHosted.deviceIdentity.title")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("account.selfHosted.deviceIdentity.description")}
                      </p>
                    </div>

                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="sync-device-name" className="text-xs">
                          {t("account.selfHosted.deviceIdentity.name")}
                        </Label>
                        <Input
                          id="sync-device-name"
                          value={deviceName}
                          maxLength={80}
                          onChange={(event) =>
                            setDeviceName(event.target.value)
                          }
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="sync-device-id" className="text-xs">
                          {t("account.selfHosted.deviceIdentity.id")}
                        </Label>
                        <Input
                          id="sync-device-id"
                          value={deviceId}
                          maxLength={128}
                          onChange={(event) => setDeviceId(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                        />
                      </div>
                    </div>

                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("account.selfHosted.deviceIdentity.changeHint")}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs"
                        disabled={isSavingDeviceIdentity}
                        onClick={() => setDeviceId(crypto.randomUUID())}
                      >
                        <LuRefreshCw className="size-3" />
                        {t("account.selfHosted.deviceIdentity.regenerate")}
                      </Button>
                      <LoadingButton
                        size="sm"
                        className="h-8 text-xs"
                        isLoading={isSavingDeviceIdentity}
                        disabled={
                          !deviceId.trim() ||
                          !deviceName.trim() ||
                          (deviceId === savedDeviceId &&
                            deviceName === savedDeviceName)
                        }
                        onClick={() => void handleSaveDeviceIdentity()}
                      >
                        {t("common.buttons.save")}
                      </LoadingButton>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/60 bg-card/50 p-3">
                    <div>
                      <p className="text-sm font-medium">
                        {t("account.selfHosted.syncDefaults.title")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("account.selfHosted.syncDefaults.description")}
                      </p>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <Label
                        htmlFor="regular-sync-by-default"
                        className="min-w-0 cursor-pointer"
                      >
                        <span className="text-xs font-medium">
                          {t("account.selfHosted.syncDefaults.newProfiles")}
                        </span>
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {t(
                            "account.selfHosted.syncDefaults.newProfilesDescription",
                          )}
                        </span>
                      </Label>
                      <AnimatedSwitch
                        id="regular-sync-by-default"
                        checked={regularSyncByDefault}
                        disabled={
                          !hasSavedSelfHostedConfig ||
                          isSavingSyncDefault ||
                          isApplyingSyncEverywhere
                        }
                        onCheckedChange={(enabled) =>
                          void handleRegularSyncDefaultChange(enabled)
                        }
                        aria-label={t(
                          "account.selfHosted.syncDefaults.newProfiles",
                        )}
                      />
                    </div>

                    <div className="mt-3 border-t border-border/60 pt-3">
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "account.selfHosted.syncDefaults.everywhereDescription",
                        )}
                      </p>
                      <LoadingButton
                        size="sm"
                        variant="outline"
                        className="mt-2 h-8 text-xs"
                        isLoading={isApplyingSyncEverywhere}
                        disabled={
                          !hasSavedSelfHostedConfig || isSavingSyncDefault
                        }
                        onClick={() => void handleEnableRegularSyncEverywhere()}
                      >
                        {t("account.selfHosted.syncDefaults.enableEverywhere")}
                      </LoadingButton>
                      {!hasSavedSelfHostedConfig && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t(
                            "account.selfHosted.syncDefaults.requiresConnection",
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </AnimatedTabsContent>
          </AnimatedTabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
