"use client";

import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuChevronsUpDown } from "react-icons/lu";
import { toast } from "sonner";
import { LoadingButton } from "@/components/loading-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { translateBackendError } from "@/lib/backend-errors";
import { cn } from "@/lib/utils";
import type { BrowserProfile, StoredProxy, VpnConfig } from "@/types";
import { RippleButton } from "./ui/ripple";

const ASSIGNMENT_PICKER_LIMIT = 100;

interface ProxyAssignmentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedProfiles: string[];
  onAssignmentComplete: () => void;
  profiles?: BrowserProfile[];
  storedProxies?: StoredProxy[];
  vpnConfigs?: VpnConfig[];
}

export function ProxyAssignmentDialog({
  isOpen,
  onClose,
  selectedProfiles,
  onAssignmentComplete,
  profiles = [],
  storedProxies = [],
  vpnConfigs = [],
}: ProxyAssignmentDialogProps) {
  const { t } = useTranslation();
  const proxyListboxId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionType, setSelectionType] = useState<
    "unselected" | "none" | "proxy" | "vpn"
  >("unselected");
  const [isAssigning, setIsAssigning] = useState(false);
  const [proxyPopoverOpen, setProxyPopoverOpen] = useState(false);
  const [proxyQuery, setProxyQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const initializedForOpenRef = useRef(false);

  const queryTokens = useMemo(
    () => proxyQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [proxyQuery],
  );
  const matchesQuery = useCallback(
    (values: Array<string | number>) => {
      if (queryTokens.length === 0) return true;
      const searchable = values.join(" ").toLowerCase();
      return queryTokens.every((token) => searchable.includes(token));
    },
    [queryTokens],
  );
  const matchingProxies = useMemo(
    () =>
      storedProxies.filter((proxy) => {
        if (proxy.is_cloud_managed || proxy.is_cloud_derived) return false;
        const settings = proxy.proxy_settings;
        return matchesQuery([
          proxy.name,
          settings.proxy_type,
          settings.host,
          settings.port,
          settings.username ?? "",
          proxy.geo_country ?? "",
          proxy.geo_region ?? "",
          proxy.geo_city ?? "",
        ]);
      }),
    [matchesQuery, storedProxies],
  );
  const matchingVpns = useMemo(
    () =>
      vpnConfigs.filter((vpn) =>
        matchesQuery([vpn.name, "vpn", "wireguard", "wg"]),
      ),
    [matchesQuery, vpnConfigs],
  );
  const visibleProxies = matchingProxies.slice(0, ASSIGNMENT_PICKER_LIMIT);
  const visibleVpns = matchingVpns.slice(0, ASSIGNMENT_PICKER_LIMIT);
  const totalMatches = matchingProxies.length + matchingVpns.length;
  const shownMatches = visibleProxies.length + visibleVpns.length;

  const handleValueChange = useCallback((value: string) => {
    if (value === "none") {
      setSelectedId(null);
      setSelectionType("none");
    } else if (value.startsWith("vpn-")) {
      setSelectedId(value.slice(4));
      setSelectionType("vpn");
    } else {
      setSelectedId(value);
      setSelectionType("proxy");
    }
  }, []);

  const handleAssign = useCallback(async () => {
    if (selectionType === "unselected") return;
    setIsAssigning(true);
    setError(null);
    try {
      const validProfiles = selectedProfiles.filter((profileId) =>
        profilesById.has(profileId),
      );

      if (validProfiles.length === 0) {
        setError(t("proxyAssignment.noValidProfiles"));
        setIsAssigning(false);
        return;
      }

      const assignedCount = await invoke<number>("assign_profiles_network", {
        profileIds: validProfiles,
        proxyId: selectionType === "proxy" ? selectedId : null,
        vpnId: selectionType === "vpn" ? selectedId : null,
      });
      toast.success(
        t("proxyAssignment.success", {
          count: assignedCount,
        }),
      );
      onAssignmentComplete();
      onClose();
    } catch (err) {
      console.error("Failed to assign proxy/VPN to profiles:", err);
      const errorMessage = translateBackendError(t, err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsAssigning(false);
    }
  }, [
    selectedProfiles,
    selectedId,
    selectionType,
    profilesById,
    onAssignmentComplete,
    onClose,
    t,
  ]);

  useEffect(() => {
    if (!isOpen) {
      initializedForOpenRef.current = false;
      return;
    }
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;

    setSelectedId(null);
    const currentNetworks = selectedProfiles
      .map((profileId) => profilesById.get(profileId))
      .filter((profile): profile is BrowserProfile => profile !== undefined)
      .map((profile) =>
        profile.proxy_id
          ? `proxy:${profile.proxy_id}`
          : profile.vpn_id
            ? `vpn:${profile.vpn_id}`
            : "none",
      );
    const firstNetwork = currentNetworks[0];
    if (
      currentNetworks.length > 0 &&
      currentNetworks.every((network) => network === firstNetwork)
    ) {
      if (firstNetwork?.startsWith("proxy:")) {
        setSelectedId(firstNetwork.slice(6));
        setSelectionType("proxy");
      } else if (firstNetwork?.startsWith("vpn:")) {
        setSelectedId(firstNetwork.slice(4));
        setSelectionType("vpn");
      } else {
        setSelectionType("none");
      }
    } else {
      setSelectionType("unselected");
    }
    setProxyQuery("");
    setError(null);
  }, [isOpen, profilesById, selectedProfiles]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("proxyAssignment.title")}</DialogTitle>
          <DialogDescription>
            {selectedProfiles.length === 1
              ? t("proxyAssignment.description_one", {
                  count: selectedProfiles.length,
                })
              : t("proxyAssignment.description_other", {
                  count: selectedProfiles.length,
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("proxyAssignment.selectedProfilesLabel")}</Label>
            <div className="max-h-[min(8rem,20vh)] overflow-y-auto rounded-md bg-muted p-3">
              <ul className="space-y-1 text-sm">
                {selectedProfiles.map((profileId) => {
                  const profile = profilesById.get(profileId);
                  const displayName = profile ? profile.name : profileId;
                  return (
                    <li key={profileId} className="truncate">
                      &bull; {displayName}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="proxy-vpn-select">
              {t("proxyAssignment.assignProxyVpnLabel")}
            </Label>
            <Popover open={proxyPopoverOpen} onOpenChange={setProxyPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={proxyPopoverOpen}
                  aria-controls={proxyListboxId}
                  className="w-full justify-between font-normal"
                >
                  {(() => {
                    if (selectionType === "unselected")
                      return t("proxyAssignment.placeholder");
                    if (selectionType === "none")
                      return t("proxyAssignment.noneOption");
                    if (selectionType === "vpn") {
                      const vpn = vpnConfigs.find((v) => v.id === selectedId);
                      return vpn
                        ? `WG — ${vpn.name}`
                        : t("proxyAssignment.noneOption");
                    }
                    const proxy = storedProxies.find(
                      (p) => p.id === selectedId,
                    );
                    return proxy ? proxy.name : t("proxyAssignment.noneOption");
                  })()}
                  <LuChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                id={proxyListboxId}
                className="w-(--radix-popover-trigger-width) p-0"
                sideOffset={8}
              >
                <Command shouldFilter={false}>
                  <CommandInput
                    value={proxyQuery}
                    onValueChange={setProxyQuery}
                    placeholder={t("proxyAssignment.searchPlaceholder")}
                  />
                  <CommandList>
                    <CommandGroup>
                      <CommandItem
                        value="__none__"
                        onSelect={() => {
                          handleValueChange("none");
                          setProxyPopoverOpen(false);
                        }}
                      >
                        <LuCheck
                          className={cn(
                            "mr-2 size-4",
                            selectionType === "none"
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        {t("proxyAssignment.noneOption")}
                      </CommandItem>
                      {visibleProxies.map((proxy) => {
                        const settings = proxy.proxy_settings;
                        return (
                          <CommandItem
                            key={proxy.id}
                            value={proxy.name}
                            onSelect={() => {
                              handleValueChange(proxy.id);
                              setProxyPopoverOpen(false);
                            }}
                          >
                            <LuCheck
                              className={cn(
                                "mr-2 size-4 shrink-0",
                                selectionType === "proxy" &&
                                  selectedId === proxy.id
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">
                                {proxy.name}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                {settings.proxy_type.toUpperCase()} ·{" "}
                                {settings.host}:{settings.port}
                              </span>
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                    {visibleVpns.length > 0 && (
                      <CommandGroup
                        heading={t("proxyAssignment.vpnGroupHeading")}
                      >
                        {visibleVpns.map((vpn) => (
                          <CommandItem
                            key={vpn.id}
                            value={`vpn-${vpn.name}`}
                            onSelect={() => {
                              handleValueChange(`vpn-${vpn.id}`);
                              setProxyPopoverOpen(false);
                            }}
                          >
                            <LuCheck
                              className={cn(
                                "mr-2 size-4",
                                selectionType === "vpn" && selectedId === vpn.id
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
                    {totalMatches === 0 && (
                      <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                        {t("proxyAssignment.notFound")}
                      </div>
                    )}
                    {shownMatches < totalMatches && (
                      <div className="border-t px-3 py-2 text-xs text-muted-foreground">
                        {t("proxyAssignment.limitedResults", {
                          shown: shownMatches,
                          total: totalMatches,
                        })}
                      </div>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <RippleButton
            variant="outline"
            onClick={onClose}
            disabled={isAssigning}
          >
            {t("common.buttons.cancel")}
          </RippleButton>
          <LoadingButton
            isLoading={isAssigning}
            onClick={() => void handleAssign()}
            disabled={selectionType === "unselected"}
          >
            {t("proxyAssignment.assignButton")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
