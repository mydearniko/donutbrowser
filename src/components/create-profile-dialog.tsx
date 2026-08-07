"use client";

import { invoke } from "@tauri-apps/api/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import {
  LuCheck,
  LuChevronDown,
  LuChevronsUpDown,
  LuLoaderCircle,
} from "react-icons/lu";
import { LoadingButton } from "@/components/loading-button";
import { ProxyFormDialog } from "@/components/proxy-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WayfernConfigForm } from "@/components/wayfern-config-form";
import { useBrowserDownload } from "@/hooks/use-browser-download";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { cn } from "@/lib/utils";
import type { BrowserReleaseTypes, WayfernConfig, WayfernOS } from "@/types";
import { RippleButton } from "./ui/ripple";

type BrowserTypeString = "wayfern";

const OS_LABELS: Record<WayfernOS, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

interface CreateProfileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProfile: (profileData: {
    name: string;
    browserStr: BrowserTypeString;
    version: string;
    releaseType: string;
    proxyId?: string;
    vpnId?: string;
    wayfernConfig?: WayfernConfig;
    groupId?: string;
    extensionGroupId?: string;
    ephemeral?: boolean;
    dnsBlocklist?: string;
    launchHook?: string;
    password?: string;
  }) => Promise<void>;
  selectedGroupId?: string;
}

interface CompactDisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  summary: string;
  children: ReactNode;
}

function CompactDisclosure({
  open,
  onOpenChange,
  title,
  summary,
  children,
}: CompactDisclosureProps) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-3 text-left hover:bg-accent/50"
        aria-expanded={open}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {summary}
          </span>
        </span>
        <LuChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-75",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </section>
  );
}

const getCurrentOS = (): WayfernOS => {
  if (typeof navigator === "undefined") return "linux";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  return "linux";
};

const getDefaultWayfernConfig = (): WayfernConfig => ({
  os: getCurrentOS(),
  ...(typeof window === "undefined"
    ? {}
    : {
        screen_max_width: window.screen.width,
        screen_max_height: window.screen.height,
      }),
});

export function CreateProfileDialog({
  isOpen,
  onClose,
  onCreateProfile,
  selectedGroupId,
}: CreateProfileDialogProps) {
  const { t } = useTranslation();
  const proxyListboxId = useId();
  const [profileName, setProfileName] = useState("");
  const [selectedProxyId, setSelectedProxyId] = useState<string>();
  const [proxyPopoverOpen, setProxyPopoverOpen] = useState(false);
  const [dnsBlocklist, setDnsBlocklist] = useState("");
  const [launchHook, setLaunchHook] = useState("");
  const [wayfernConfig, setWayfernConfig] = useState<WayfernConfig>(
    getDefaultWayfernConfig,
  );
  const [fingerprintOpen, setFingerprintOpen] = useState(false);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const [enablePassword, setEnablePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [selectedExtensionGroupId, setSelectedExtensionGroupId] =
    useState<string>();
  const [extensionGroups, setExtensionGroups] = useState<
    { id: string; name: string; extension_ids: string[] }[]
  >([]);
  const [releaseTypes, setReleaseTypes] = useState<BrowserReleaseTypes>();
  const [isLoadingReleaseTypes, setIsLoadingReleaseTypes] = useState(false);
  const [releaseTypesError, setReleaseTypesError] = useState(false);
  const releaseRequestRef = useRef(0);
  const PASSWORD_MIN_LEN = 8;

  const { storedProxies } = useProxyEvents();
  const { vpnConfigs } = useVpnEvents();
  const {
    isBrowserDownloading,
    downloadBrowser,
    loadDownloadedVersions,
    isVersionDownloaded,
    downloadedVersionsMap,
  } = useBrowserDownload();

  const loadReleaseTypes = useCallback(async () => {
    const request = ++releaseRequestRef.current;
    setIsLoadingReleaseTypes(true);
    setReleaseTypesError(false);

    try {
      const rawReleaseTypes = await invoke<BrowserReleaseTypes>(
        "get_browser_release_types",
        { browserStr: "wayfern" },
      );
      const downloaded = await loadDownloadedVersions("wayfern");
      if (releaseRequestRef.current !== request) return;

      const filtered: BrowserReleaseTypes = {};
      if (rawReleaseTypes.stable) filtered.stable = rawReleaseTypes.stable;
      if (!filtered.stable && downloaded.length > 0) {
        filtered.stable = downloaded[0];
      }
      setReleaseTypes(filtered);
    } catch (error) {
      console.error("Failed to load Wayfern release types:", error);
      try {
        const downloaded = await loadDownloadedVersions("wayfern");
        if (releaseRequestRef.current !== request) return;
        if (downloaded.length > 0) {
          setReleaseTypes({ stable: downloaded[0] });
        } else {
          setReleaseTypes({});
          setReleaseTypesError(true);
        }
      } catch (downloadError) {
        console.error(
          "Failed to load downloaded Wayfern versions:",
          downloadError,
        );
        if (releaseRequestRef.current === request) {
          setReleaseTypes({});
          setReleaseTypesError(true);
        }
      }
    } finally {
      if (releaseRequestRef.current === request) {
        setIsLoadingReleaseTypes(false);
      }
    }
  }, [loadDownloadedVersions]);

  const checkAndDownloadGeoIPDatabase = useCallback(async () => {
    try {
      const isAvailable = await invoke<boolean>("is_geoip_database_available");
      if (!isAvailable) await invoke("download_geoip_database");
    } catch (error) {
      console.error("Failed to prepare GeoIP database:", error);
    }
  }, []);

  useEffect(() => {
    if (isOpen) setWayfernConfig(getDefaultWayfernConfig());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    void loadReleaseTypes();
    void checkAndDownloadGeoIPDatabase();
    void invoke<{ id: string; name: string; extension_ids: string[] }[]>(
      "list_extension_groups",
    )
      .then(setExtensionGroups)
      .catch((error) => {
        console.error("Failed to load extension groups:", error);
        setExtensionGroups([]);
      });
  }, [isOpen, loadReleaseTypes, checkAndDownloadGeoIPDatabase]);

  const bestVersion = useMemo(() => {
    if (!releaseTypes?.stable) return null;
    return { version: releaseTypes.stable, releaseType: "stable" as const };
  }, [releaseTypes]);

  const creatableVersion = useMemo(() => {
    if (bestVersion && isVersionDownloaded(bestVersion.version)) {
      return bestVersion;
    }
    const downloaded = downloadedVersionsMap.wayfern ?? [];
    if (downloaded.length === 0) return null;
    return { version: downloaded[0], releaseType: "stable" as const };
  }, [bestVersion, downloadedVersionsMap.wayfern, isVersionDownloaded]);

  const isDownloading = isBrowserDownloading("wayfern");
  const updateAvailable =
    !!bestVersion &&
    !!creatableVersion &&
    bestVersion.version !== creatableVersion.version &&
    !isVersionDownloaded(bestVersion.version);

  const selectedProxyLabel = useMemo(() => {
    if (!selectedProxyId) return t("createProfile.proxy.noProxy");
    if (selectedProxyId.startsWith("vpn-")) {
      const vpn = vpnConfigs.find(
        (item) => item.id === selectedProxyId.slice(4),
      );
      return vpn ? `WG — ${vpn.name}` : t("createProfile.proxy.noProxy");
    }
    return (
      storedProxies.find((item) => item.id === selectedProxyId)?.name ??
      t("createProfile.proxy.noProxy")
    );
  }, [selectedProxyId, storedProxies, t, vpnConfigs]);

  const resetPassword = () => {
    setEnablePassword(false);
    setPassword("");
    setPasswordConfirm("");
    setPasswordError(null);
  };

  const handleClose = () => {
    releaseRequestRef.current += 1;
    setProfileName("");
    setSelectedProxyId(undefined);
    setProxyPopoverOpen(false);
    setDnsBlocklist("");
    setLaunchHook("");
    setWayfernConfig(getDefaultWayfernConfig());
    setFingerprintOpen(false);
    setMoreOptionsOpen(false);
    setReleaseTypes(undefined);
    setIsLoadingReleaseTypes(false);
    setReleaseTypesError(false);
    setEphemeral(false);
    resetPassword();
    setSelectedExtensionGroupId(undefined);
    onClose();
  };

  const updateWayfernConfig = (key: keyof WayfernConfig, value: unknown) => {
    setWayfernConfig((previous) => ({ ...previous, [key]: value }));
  };

  const handleDownload = async () => {
    if (!bestVersion) return;
    try {
      await downloadBrowser("wayfern", bestVersion.version);
      await loadReleaseTypes();
    } catch (error) {
      console.error("Failed to download Wayfern:", error);
    }
  };

  const isCreateDisabled =
    !profileName.trim() || !creatableVersion || isDownloading || isCreating;

  const handleCreate = async () => {
    if (isCreateDisabled || !creatableVersion) return;

    if (enablePassword && !ephemeral) {
      if (password.length < PASSWORD_MIN_LEN) {
        setPasswordError(
          t("profilePassword.errors.tooShort", { min: PASSWORD_MIN_LEN }),
        );
        return;
      }
      if (password !== passwordConfirm) {
        setPasswordError(t("profilePassword.errors.mismatch"));
        return;
      }
    }

    setPasswordError(null);
    setIsCreating(true);
    const isVpnSelection = selectedProxyId?.startsWith("vpn-") ?? false;

    try {
      await onCreateProfile({
        name: profileName.trim(),
        browserStr: "wayfern",
        version: creatableVersion.version,
        releaseType: creatableVersion.releaseType,
        proxyId: isVpnSelection ? undefined : selectedProxyId,
        vpnId:
          isVpnSelection && selectedProxyId
            ? selectedProxyId.slice(4)
            : undefined,
        wayfernConfig: { ...wayfernConfig },
        groupId:
          selectedGroupId && selectedGroupId !== "__all__"
            ? selectedGroupId
            : undefined,
        extensionGroupId: selectedExtensionGroupId,
        ephemeral,
        dnsBlocklist: dnsBlocklist || undefined,
        launchHook: launchHook.trim() || undefined,
        password: enablePassword && !ephemeral ? password : undefined,
      });
      handleClose();
    } catch (error) {
      console.error("Failed to create profile:", error);
    } finally {
      setIsCreating(false);
    }
  };

  const fingerprintSummary = `${
    OS_LABELS[wayfernConfig.os ?? getCurrentOS()]
  } · ${t("fingerprint.automatic")}`;
  const dnsBlocklistTranslationKey =
    dnsBlocklist === "pro_plus" ? "proPlus" : dnsBlocklist;
  const moreOptionsSummary = [
    dnsBlocklistTranslationKey
      ? t(`dnsBlocklist.${dnsBlocklistTranslationKey}`)
      : t("dnsBlocklist.none"),
    selectedExtensionGroupId
      ? t("extensions.extensionGroup")
      : t("profileInfo.values.none"),
  ].join(" · ");

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[min(44rem,calc(100vh-2rem))] max-w-[min(46rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate">
              {t("createProfile.configureTitle", {
                browser: t("createProfile.chromiumLabel"),
              })}
            </DialogTitle>
            {creatableVersion && (
              <Badge variant="outline" className="shrink-0 font-normal">
                v{creatableVersion.version}
              </Badge>
            )}
            {isLoadingReleaseTypes && (
              <LuLoaderCircle
                className="size-4 shrink-0 animate-spin text-muted-foreground"
                aria-label={t("createProfile.version.fetching")}
              />
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-3">
            {releaseTypesError && (
              <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <p className="min-w-0 flex-1 text-sm text-destructive">
                  {t("createProfile.version.fetchError")}
                </p>
                <RippleButton
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void loadReleaseTypes();
                  }}
                >
                  {t("common.buttons.retry")}
                </RippleButton>
              </div>
            )}

            {!releaseTypesError && bestVersion && !creatableVersion && (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {t("createProfile.version.needsDownload", {
                    browser: "Wayfern",
                    version: bestVersion.version,
                  })}
                </p>
                <LoadingButton
                  size="sm"
                  isLoading={isDownloading}
                  disabled={isDownloading}
                  onClick={() => {
                    void handleDownload();
                  }}
                >
                  {isDownloading
                    ? t("common.buttons.downloading")
                    : t("common.buttons.download")}
                </LoadingButton>
              </div>
            )}

            {updateAvailable && (
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2 pl-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t("createProfile.version.upgradeAvailable", {
                    browser: "Wayfern",
                    version: bestVersion?.version,
                  })}
                </p>
                <LoadingButton
                  size="sm"
                  variant="outline"
                  isLoading={isDownloading}
                  disabled={isDownloading}
                  onClick={() => {
                    void handleDownload();
                  }}
                >
                  {t("common.buttons.download")}
                </LoadingButton>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">
                  {t("createProfile.profileName")}
                </Label>
                <Input
                  id="profile-name"
                  autoFocus
                  value={profileName}
                  onChange={(event) => {
                    setProfileName(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !isCreateDisabled) {
                      void handleCreate();
                    }
                  }}
                  placeholder={t("createProfile.profileNamePlaceholder")}
                />
              </div>

              <div className="space-y-1.5">
                <Label>{t("createProfile.proxy.title")}</Label>
                <div className="flex gap-2">
                  <Popover
                    open={proxyPopoverOpen}
                    onOpenChange={setProxyPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={proxyPopoverOpen}
                        aria-controls={proxyListboxId}
                        className="min-w-0 flex-1 justify-between font-normal"
                      >
                        <span className="truncate">{selectedProxyLabel}</span>
                        <LuChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      id={proxyListboxId}
                      className="w-[min(22rem,calc(100vw-2rem))] p-0"
                      sideOffset={6}
                    >
                      <Command>
                        <CommandInput
                          placeholder={t("createProfile.proxy.search")}
                        />
                        <CommandList>
                          <CommandEmpty>
                            {t("createProfile.proxy.notFound")}
                          </CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="__none__"
                              onSelect={() => {
                                setSelectedProxyId(undefined);
                                setProxyPopoverOpen(false);
                              }}
                            >
                              <LuCheck
                                className={cn(
                                  "mr-2 size-4",
                                  selectedProxyId ? "opacity-0" : "opacity-100",
                                )}
                              />
                              {t("common.labels.none")}
                            </CommandItem>
                            {storedProxies.map((proxy) => (
                              <CommandItem
                                key={proxy.id}
                                value={proxy.name}
                                onSelect={() => {
                                  setSelectedProxyId(proxy.id);
                                  setProxyPopoverOpen(false);
                                }}
                              >
                                <LuCheck
                                  className={cn(
                                    "mr-2 size-4",
                                    selectedProxyId === proxy.id
                                      ? "opacity-100"
                                      : "opacity-0",
                                  )}
                                />
                                {proxy.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                          {vpnConfigs.length > 0 && (
                            <CommandGroup
                              heading={t("proxyAssignment.vpnGroupHeading")}
                            >
                              {vpnConfigs.map((vpn) => (
                                <CommandItem
                                  key={vpn.id}
                                  value={`vpn-${vpn.name}`}
                                  onSelect={() => {
                                    setSelectedProxyId(`vpn-${vpn.id}`);
                                    setProxyPopoverOpen(false);
                                  }}
                                >
                                  <LuCheck
                                    className={cn(
                                      "mr-2 size-4",
                                      selectedProxyId === `vpn-${vpn.id}`
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  />
                                  <Badge
                                    variant="outline"
                                    className="mr-1 px-1 py-0 text-[10px] leading-tight"
                                  >
                                    WG
                                  </Badge>
                                  {vpn.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    title={t("createProfile.proxy.addProxy")}
                    onClick={() => {
                      setShowProxyForm(true);
                    }}
                  >
                    <GoPlus className="size-4" />
                    <span className="sr-only">
                      {t("createProfile.proxy.addProxy")}
                    </span>
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label
                htmlFor="create-profile-ephemeral"
                className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border bg-muted/20 p-3 hover:bg-accent/40"
              >
                <Checkbox
                  id="create-profile-ephemeral"
                  className="mt-0.5"
                  checked={ephemeral}
                  onCheckedChange={(checked) => {
                    const enabled = checked === true;
                    setEphemeral(enabled);
                    if (enabled) resetPassword();
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {t("profiles.ephemeral")}
                  </span>
                  <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
                    {t("profiles.ephemeralDescription")}
                  </span>
                </span>
              </label>

              <label
                htmlFor="create-profile-password"
                className={cn(
                  "flex min-h-16 items-start gap-3 rounded-lg border bg-muted/20 p-3",
                  ephemeral
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-accent/40",
                )}
              >
                <Checkbox
                  id="create-profile-password"
                  className="mt-0.5"
                  checked={enablePassword}
                  disabled={ephemeral}
                  onCheckedChange={(checked) => {
                    if (checked === true) {
                      setEnablePassword(true);
                    } else {
                      resetPassword();
                    }
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {t("createProfile.passwordProtect.label")}
                  </span>
                  <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
                    {t("createProfile.passwordProtect.description")}
                  </span>
                </span>
              </label>
            </div>

            {enablePassword && !ephemeral && (
              <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError(null);
                  }}
                  placeholder={t("profilePassword.fields.newPassword")}
                  autoComplete="new-password"
                />
                <Input
                  type="password"
                  value={passwordConfirm}
                  onChange={(event) => {
                    setPasswordConfirm(event.target.value);
                    setPasswordError(null);
                  }}
                  placeholder={t("profilePassword.fields.confirm")}
                  autoComplete="new-password"
                />
                {passwordError && (
                  <p className="text-sm text-destructive sm:col-span-2">
                    {passwordError}
                  </p>
                )}
              </div>
            )}

            <CompactDisclosure
              open={fingerprintOpen}
              onOpenChange={setFingerprintOpen}
              title={t("profileInfo.sections.fingerprint")}
              summary={fingerprintSummary}
            >
              <WayfernConfigForm
                config={wayfernConfig}
                onConfigChange={updateWayfernConfig}
                isCreating
                compact
                profileVersion={creatableVersion?.version}
                profileBrowser="wayfern"
              />
            </CompactDisclosure>

            <CompactDisclosure
              open={moreOptionsOpen}
              onOpenChange={setMoreOptionsOpen}
              title={t("createProfile.moreOptions")}
              summary={moreOptionsSummary}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("dnsBlocklist.title")}</Label>
                  <Select
                    value={dnsBlocklist || "none"}
                    onValueChange={(value) => {
                      setDnsBlocklist(value === "none" ? "" : value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("dnsBlocklist.none")} />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "none",
                        "light",
                        "normal",
                        "pro",
                        "proPlus",
                        "ultimate",
                      ].map((level) => (
                        <SelectItem
                          key={level}
                          value={level === "proPlus" ? "pro_plus" : level}
                        >
                          {t(`dnsBlocklist.${level}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {extensionGroups.length > 0 && (
                  <div className="space-y-1.5">
                    <Label>{t("extensions.extensionGroup")}</Label>
                    <Select
                      value={selectedExtensionGroupId ?? "none"}
                      onValueChange={(value) => {
                        setSelectedExtensionGroupId(
                          value === "none" ? undefined : value,
                        );
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("profileInfo.values.none")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          {t("profileInfo.values.none")}
                        </SelectItem>
                        {extensionGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name} ({group.extension_ids.length})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="launch-hook-url">
                    {t("createProfile.launchHook.label")}
                  </Label>
                  <Input
                    id="launch-hook-url"
                    value={launchHook}
                    onChange={(event) => {
                      setLaunchHook(event.target.value);
                    }}
                    placeholder={t("createProfile.launchHook.placeholder")}
                    disabled={isCreating}
                  />
                </div>
              </div>
            </CompactDisclosure>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t px-4 py-3">
          <RippleButton variant="outline" onClick={handleClose}>
            {t("common.buttons.cancel")}
          </RippleButton>
          <LoadingButton
            onClick={handleCreate}
            isLoading={isCreating}
            disabled={isCreateDisabled}
          >
            {t("common.buttons.create")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>

      <ProxyFormDialog
        isOpen={showProxyForm}
        onClose={() => {
          setShowProxyForm(false);
        }}
      />
    </Dialog>
  );
}
