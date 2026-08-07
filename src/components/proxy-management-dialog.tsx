"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import {
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuChevronUp,
  LuClipboard,
  LuDownload,
  LuGauge,
  LuPencil,
  LuRefreshCw,
  LuSearch,
  LuTrash2,
  LuUpload,
  LuX,
} from "react-icons/lu";
import { toast } from "sonner";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "@/components/data-table-action-bar";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { ProxyExportDialog } from "@/components/proxy-export-dialog";
import { ProxyFormDialog } from "@/components/proxy-form-dialog";
import { ProxyImportDialog } from "@/components/proxy-import-dialog";
import { AnimatedSwitch } from "@/components/ui/animated-switch";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsTrigger,
} from "@/components/ui/animated-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FadingScrollArea } from "@/components/ui/fading-scroll-area";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { parseBackendError, translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type {
  ProxyCheckResult,
  ProxyManagementSnapshot,
  StoredProxy,
  VpnConfig,
} from "@/types";
import { ProxyCheckButton } from "./proxy-check-button";
import { RippleButton } from "./ui/ripple";
import { VpnCheckButton } from "./vpn-check-button";
import { VpnFormDialog } from "./vpn-form-dialog";
import { VpnImportDialog } from "./vpn-import-dialog";

type SyncStatus = "disabled" | "syncing" | "synced" | "error" | "waiting";
type ProxyListFilter =
  | "all"
  | "working"
  | "failed"
  | "unchecked"
  | "used"
  | "unused";

const PROXY_BULK_CONCURRENCY = 6;

async function runConcurrently<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
  concurrency = PROXY_BULK_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await task(items[index]),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );
  return results;
}

function proxyConnectionUrl(proxy: StoredProxy): string {
  const settings = proxy.proxy_settings;
  const credentials = settings.username
    ? `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password ?? "")}@`
    : "";
  return `${settings.proxy_type}://${credentials}${settings.host}:${settings.port}`;
}

function getSyncStatusDot(
  item: { sync_enabled?: boolean; last_sync?: number },
  liveStatus: SyncStatus | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
  errorMessage?: string,
): { color: string; tooltip: string; animate: boolean } {
  const status = liveStatus ?? (item.sync_enabled ? "synced" : "disabled");

  switch (status) {
    case "syncing":
      return {
        color: "bg-warning",
        tooltip: t("syncTooltips.syncing"),
        animate: true,
      };
    case "synced":
      return {
        color: "bg-success",
        tooltip: item.last_sync
          ? t("syncTooltips.syncedAt", {
              time: new Date(item.last_sync * 1000).toLocaleString(),
            })
          : t("syncTooltips.synced"),
        animate: false,
      };
    case "waiting":
      return {
        color: "bg-warning",
        tooltip: t("syncTooltips.waiting"),
        animate: false,
      };
    case "error":
      return {
        color: "bg-destructive",
        tooltip: errorMessage
          ? t("syncTooltips.errorWith", { error: errorMessage })
          : t("syncTooltips.error"),
        animate: false,
      };
    default:
      return {
        color: "bg-muted-foreground",
        tooltip: t("syncTooltips.notSynced"),
        animate: false,
      };
  }
}

interface ProxyManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  subPage?: boolean;
  /** Which tab to display first when the dialog mounts; defaults to "proxies". */
  initialTab?: "proxies" | "vpns";
}

export function ProxyManagementDialog({
  isOpen,
  onClose,
  subPage,
  initialTab = "proxies",
}: ProxyManagementDialogProps) {
  const { t } = useTranslation();
  // Proxy state
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [editingProxy, setEditingProxy] = useState<StoredProxy | null>(null);
  const [proxyToDelete, setProxyToDelete] = useState<StoredProxy | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [checkingProxyId, setCheckingProxyId] = useState<string | null>(null);
  const [proxyCheckResults, setProxyCheckResults] = useState<
    Record<string, ProxyCheckResult>
  >({});
  const [proxySyncStatus, setProxySyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [proxySyncErrors, setProxySyncErrors] = useState<
    Record<string, string>
  >({});
  const [proxyInUse, setProxyInUse] = useState<Record<string, boolean>>({});
  const [snapshotProxyUsage, setSnapshotProxyUsage] = useState<
    Record<string, number>
  >({});
  const [isTogglingSync, setIsTogglingSync] = useState<Record<string, boolean>>(
    {},
  );

  // VPN state
  const [showVpnForm, setShowVpnForm] = useState(false);
  const [showVpnImportDialog, setShowVpnImportDialog] = useState(false);
  const [editingVpn, setEditingVpn] = useState<VpnConfig | null>(null);
  const [vpnToDelete, setVpnToDelete] = useState<VpnConfig | null>(null);
  const [isDeletingVpn, setIsDeletingVpn] = useState(false);
  const [checkingVpnId, setCheckingVpnId] = useState<string | null>(null);
  const [vpnSyncStatus, setVpnSyncStatus] = useState<
    Record<string, SyncStatus>
  >({});
  const [vpnSyncErrors, setVpnSyncErrors] = useState<Record<string, string>>(
    {},
  );
  const [vpnInUse, setVpnInUse] = useState<Record<string, boolean>>({});
  const [isTogglingVpnSync, setIsTogglingVpnSync] = useState<
    Record<string, boolean>
  >({});

  // Table state
  const [proxiesSorting, setProxiesSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const [proxiesRowSelection, setProxiesRowSelection] =
    useState<RowSelectionState>({});
  const [proxiesPagination, setProxiesPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 100,
  });
  const [proxyQuery, setProxyQuery] = useState("");
  const [proxyListFilter, setProxyListFilter] =
    useState<ProxyListFilter>("all");
  const [proxyProtocolFilter, setProxyProtocolFilter] = useState("all");
  const [isBulkCheckingProxies, setIsBulkCheckingProxies] = useState(false);
  const [vpnsSorting, setVpnsSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const [vpnsRowSelection, setVpnsRowSelection] = useState<RowSelectionState>(
    {},
  );

  // Track the active tab so we can scope the floating action bar (portaled
  // to body) to only the currently visible list. Initial value comes from
  // initialTab; subsequent changes drive the animated tabs via onValueChange.
  const [activeTab, setActiveTab] = useState<"proxies" | "vpns">(initialTab);
  // Reset selections when the dialog closes so the floating action bar
  // (portaled to body) doesn't linger on the page across navigations.
  useEffect(() => {
    if (!isOpen) {
      setProxiesRowSelection({});
      setVpnsRowSelection({});
    }
  }, [isOpen]);

  // Bulk delete state
  const [isBulkDeletingProxies, setIsBulkDeletingProxies] = useState(false);
  const [showBulkDeleteProxiesDialog, setShowBulkDeleteProxiesDialog] =
    useState(false);
  const [isBulkDeletingVpns, setIsBulkDeletingVpns] = useState(false);
  const [showBulkDeleteVpnsDialog, setShowBulkDeleteVpnsDialog] =
    useState(false);

  const {
    storedProxies: rawProxies,
    proxyUsage: eventProxyUsage,
    isLoading,
  } = useProxyEvents();
  const { vpnConfigs, vpnUsage, isLoading: isLoadingVpns } = useVpnEvents();

  // Filter out cloud-managed and cloud-derived proxies (cloud proxies are
  // deprecated). Memoized — without this the derived array gets a new
  // reference on every render, which made the [storedProxies] effect below
  // refire every render → re-set state → re-render, freezing the page once
  // the dialog mounted. Keeping the reference stable when the input is
  // unchanged is what every consumer (useReactTable, useEffect, selection
  // logic) actually wants.
  const storedProxies = useMemo(
    () =>
      rawProxies
        .filter((p) => !p.is_cloud_managed && !p.is_cloud_derived)
        .sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
    [rawProxies],
  );

  // Listen for proxy sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string; error?: string }>(
        "proxy-sync-status",
        (event) => {
          const { id, status, error } = event.payload;
          setProxySyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
          if (error) {
            setProxySyncErrors((prev) => ({ ...prev, [id]: error }));
          }
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  // Listen for VPN sync status events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ id: string; status: string; error?: string }>(
        "vpn-sync-status",
        (event) => {
          const { id, status, error } = event.payload;
          setVpnSyncStatus((prev) => ({
            ...prev,
            [id]: status as SyncStatus,
          }));
          if (error) {
            setVpnSyncErrors((prev) => ({ ...prev, [id]: error }));
          }
        },
      );
    };

    void setupListener();
    return () => {
      unlisten?.();
    };
  }, []);

  // Load every per-proxy cache/sync-lock value in one IPC call. This remains
  // fast with thousands of proxies and scans profile metadata only once.
  useEffect(() => {
    let cancelled = false;
    if (storedProxies.length === 0) {
      setProxyCheckResults({});
      setProxyInUse({});
      setSnapshotProxyUsage({});
      return;
    }

    void invoke<ProxyManagementSnapshot>("get_proxy_management_snapshot", {
      proxyIds: storedProxies.map((proxy) => proxy.id),
    })
      .then((snapshot) => {
        if (cancelled) return;
        setProxyCheckResults(snapshot.cached_checks);
        setProxyInUse(
          Object.fromEntries(snapshot.synced_in_use.map((id) => [id, true])),
        );
        setSnapshotProxyUsage(snapshot.usage);
      })
      .catch((error: unknown) => {
        console.error("Failed to load proxy management snapshot:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [storedProxies]);

  const proxyUsage = useMemo(
    () => ({ ...snapshotProxyUsage, ...eventProxyUsage }),
    [eventProxyUsage, snapshotProxyUsage],
  );

  const availableProxyProtocols = useMemo(
    () =>
      Array.from(
        new Set(storedProxies.map((proxy) => proxy.proxy_settings.proxy_type)),
      ).sort((a, b) => a.localeCompare(b)),
    [storedProxies],
  );

  const filteredProxies = useMemo(() => {
    const tokens = proxyQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return storedProxies.filter((proxy) => {
      if (
        proxyProtocolFilter !== "all" &&
        proxy.proxy_settings.proxy_type !== proxyProtocolFilter
      ) {
        return false;
      }

      const result = proxyCheckResults[proxy.id];
      const usage = proxyUsage[proxy.id] ?? 0;
      if (proxyListFilter === "working" && result?.is_valid !== true)
        return false;
      if (proxyListFilter === "failed" && result?.is_valid !== false)
        return false;
      if (proxyListFilter === "unchecked" && result) return false;
      if (proxyListFilter === "used" && usage === 0) return false;
      if (proxyListFilter === "unused" && usage > 0) return false;

      if (tokens.length === 0) return true;
      const settings = proxy.proxy_settings;
      const searchable = [
        proxy.name,
        settings.proxy_type,
        settings.host,
        String(settings.port),
        settings.username ?? "",
        proxy.geo_country ?? "",
        proxy.geo_region ?? "",
        proxy.geo_city ?? "",
        proxy.geo_isp ?? "",
        result?.ip ?? "",
        result?.country ?? "",
        result?.city ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((token) => searchable.includes(token));
    });
  }, [
    proxyCheckResults,
    proxyListFilter,
    proxyProtocolFilter,
    proxyQuery,
    proxyUsage,
    storedProxies,
  ]);

  const proxyHealthCounts = useMemo(() => {
    let working = 0;
    let failed = 0;
    for (const proxy of storedProxies) {
      const result = proxyCheckResults[proxy.id];
      if (result?.is_valid) working += 1;
      else if (result) failed += 1;
    }
    return {
      working,
      failed,
      unchecked: storedProxies.length - working - failed,
      used: storedProxies.filter((proxy) => (proxyUsage[proxy.id] ?? 0) > 0)
        .length,
    };
  }, [proxyCheckResults, proxyUsage, storedProxies]);

  useEffect(() => {
    setProxiesPagination((current) => ({ ...current, pageIndex: 0 }));
  }, []);

  // Load VPN in-use status
  useEffect(() => {
    const loadVpnInUse = async () => {
      const inUse: Record<string, boolean> = {};
      for (const vpn of vpnConfigs) {
        try {
          const inUseBySynced = await invoke<boolean>(
            "is_vpn_in_use_by_synced_profile",
            { vpnId: vpn.id },
          );
          inUse[vpn.id] = inUseBySynced;
        } catch (_error) {
          // Ignore errors
        }
      }
      setVpnInUse(inUse);
    };
    if (vpnConfigs.length > 0) {
      void loadVpnInUse();
    }
  }, [vpnConfigs]);

  // Proxy handlers
  const handleDeleteProxy = useCallback((proxy: StoredProxy) => {
    setProxyToDelete(proxy);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!proxyToDelete) return;
    setIsDeleting(true);
    try {
      await invoke("delete_stored_proxy", { proxyId: proxyToDelete.id });
      toast.success(t("proxies.management.deleteSuccess"));
      await emit("stored-proxies-changed");
    } catch (error) {
      console.error("Failed to delete proxy:", error);
      toast.error(t("proxies.management.deleteFailed"));
    } finally {
      setIsDeleting(false);
      setProxyToDelete(null);
    }
  }, [proxyToDelete, t]);

  const handleCreateProxy = useCallback(() => {
    setEditingProxy(null);
    setShowProxyForm(true);
  }, []);

  const handleEditProxy = useCallback((proxy: StoredProxy) => {
    setEditingProxy(proxy);
    setShowProxyForm(true);
  }, []);

  const handleProxyFormClose = useCallback(() => {
    setShowProxyForm(false);
    setEditingProxy(null);
  }, []);

  const handleToggleSync = useCallback(
    async (proxy: StoredProxy) => {
      setIsTogglingSync((prev) => ({ ...prev, [proxy.id]: true }));
      try {
        await invoke("set_proxy_sync_enabled", {
          proxyId: proxy.id,
          enabled: !proxy.sync_enabled,
        });
        showSuccessToast(
          proxy.sync_enabled
            ? t("proxies.management.syncDisabled")
            : t("proxies.management.syncEnabled"),
        );
        await emit("stored-proxies-changed");
      } catch (error) {
        console.error("Failed to toggle sync:", error);
        showErrorToast(
          parseBackendError(error)
            ? translateBackendError(t, error)
            : t("proxies.management.updateSyncFailed"),
        );
      } finally {
        setIsTogglingSync((prev) => ({ ...prev, [proxy.id]: false }));
      }
    },
    [t],
  );

  // VPN handlers
  const handleDeleteVpn = useCallback((vpn: VpnConfig) => {
    setVpnToDelete(vpn);
  }, []);

  const handleConfirmDeleteVpn = useCallback(async () => {
    if (!vpnToDelete) return;
    setIsDeletingVpn(true);
    try {
      await invoke("delete_vpn_config", { vpnId: vpnToDelete.id });
      toast.success(t("vpns.management.deleteSuccess"));
      await emit("vpn-configs-changed");
    } catch (error) {
      console.error("Failed to delete VPN:", error);
      toast.error(t("vpns.management.deleteFailed"));
    } finally {
      setIsDeletingVpn(false);
      setVpnToDelete(null);
    }
  }, [vpnToDelete, t]);

  const handleCreateVpn = useCallback(() => {
    setEditingVpn(null);
    setShowVpnForm(true);
  }, []);

  const handleEditVpn = useCallback((vpn: VpnConfig) => {
    setEditingVpn(vpn);
    setShowVpnForm(true);
  }, []);

  const handleVpnFormClose = useCallback(() => {
    setShowVpnForm(false);
    setEditingVpn(null);
  }, []);

  const handleToggleVpnSync = useCallback(
    async (vpn: VpnConfig) => {
      setIsTogglingVpnSync((prev) => ({ ...prev, [vpn.id]: true }));
      try {
        await invoke("set_vpn_sync_enabled", {
          vpnId: vpn.id,
          enabled: !vpn.sync_enabled,
        });
        showSuccessToast(
          vpn.sync_enabled
            ? t("proxies.management.syncDisabled")
            : t("proxies.management.syncEnabled"),
        );
        await emit("vpn-configs-changed");
      } catch (error) {
        console.error("Failed to toggle VPN sync:", error);
        showErrorToast(
          parseBackendError(error)
            ? translateBackendError(t, error)
            : t("proxies.management.updateSyncFailed"),
        );
      } finally {
        setIsTogglingVpnSync((prev) => ({ ...prev, [vpn.id]: false }));
      }
    },
    [t],
  );

  const proxyColumns = useMemo<ColumnDef<StoredProxy>[]>(
    () => [
      {
        id: "select",
        size: 36,
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected()
                ? true
                : table.getIsSomeRowsSelected()
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(value) => {
              table.toggleAllRowsSelected(!!value);
            }}
            aria-label={t("common.aria.selectAll")}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onCheckedChange={(value) => {
              row.toggleSelected(!!value);
            }}
            aria-label={t("common.aria.selectRow")}
          />
        ),
      },
      {
        id: "status",
        size: 28,
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => {
          const proxy = row.original;
          const syncDot = getSyncStatusDot(
            proxy,
            proxySyncStatus[proxy.id],
            t,
            proxySyncErrors[proxy.id],
          );
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`size-2 rounded-full shrink-0 ${syncDot.color} ${
                    syncDot.animate ? "animate-pulse" : ""
                  }`}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p>{syncDot.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        accessorKey: "name",
        enableSorting: true,
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => {
              column.toggleSorting(column.getIsSorted() === "asc");
            }}
            className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
          >
            {t("common.labels.name")}
            {column.getIsSorted() === "asc" ? (
              <LuChevronUp className="ml-2 size-4" />
            ) : column.getIsSorted() === "desc" ? (
              <LuChevronDown className="ml-2 size-4" />
            ) : null}
          </Button>
        ),
        cell: ({ row }) => (
          <span className="block truncate font-medium">
            {row.original.name}
          </span>
        ),
      },
      {
        id: "protocol",
        accessorFn: (proxy) => proxy.proxy_settings.proxy_type,
        size: 96,
        enableSorting: true,
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => {
              column.toggleSorting(column.getIsSorted() === "asc");
            }}
            className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
          >
            {t("proxies.management.protocolCol")}
            {column.getIsSorted() === "asc" ? (
              <LuChevronUp className="ml-2 size-4" />
            ) : column.getIsSorted() === "desc" ? (
              <LuChevronDown className="ml-2 size-4" />
            ) : null}
          </Button>
        ),
        cell: ({ row }) => (
          <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
            {row.original.proxy_settings.proxy_type}
          </span>
        ),
      },
      {
        id: "hostPort",
        accessorFn: (proxy) =>
          `${proxy.proxy_settings.host}:${proxy.proxy_settings.port}`,
        enableSorting: true,
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => {
              column.toggleSorting(column.getIsSorted() === "asc");
            }}
            className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
          >
            {t("proxies.management.hostPort")}
            {column.getIsSorted() === "asc" ? (
              <LuChevronUp className="ml-2 size-4" />
            ) : column.getIsSorted() === "desc" ? (
              <LuChevronDown className="ml-2 size-4" />
            ) : null}
          </Button>
        ),
        cell: ({ row }) => (
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {row.original.proxy_settings.host}:
            {row.original.proxy_settings.port}
          </span>
        ),
      },
      {
        id: "usage",
        accessorFn: (proxy) => proxyUsage[proxy.id] ?? 0,
        size: 80,
        enableSorting: true,
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => {
              column.toggleSorting(column.getIsSorted() === "asc");
            }}
            className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
          >
            {t("proxies.management.usage")}
            {column.getIsSorted() === "asc" ? (
              <LuChevronUp className="ml-2 size-4" />
            ) : column.getIsSorted() === "desc" ? (
              <LuChevronDown className="ml-2 size-4" />
            ) : null}
          </Button>
        ),
        cell: ({ row }) => (
          <Badge variant="secondary">{proxyUsage[row.original.id] ?? 0}</Badge>
        ),
      },
      {
        id: "sync",
        size: 96,
        enableSorting: false,
        header: () => t("proxies.management.syncCol"),
        cell: ({ row }) => {
          const proxy = row.original;
          const locked = proxyInUse[proxy.id];
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center">
                  <AnimatedSwitch
                    checked={proxy.sync_enabled}
                    onCheckedChange={() => void handleToggleSync(proxy)}
                    disabled={isTogglingSync[proxy.id] || locked}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {locked ? (
                  <p>{t("syncTooltips.lockedInUse")}</p>
                ) : (
                  <p>
                    {proxy.sync_enabled
                      ? t("syncTooltips.disable")
                      : t("syncTooltips.enable")}
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "actions",
        size: 144,
        enableSorting: false,
        header: () => t("common.labels.actions"),
        cell: ({ row }) => {
          const proxy = row.original;
          return (
            <div className="flex gap-1">
              <ProxyCheckButton
                proxy={proxy}
                profileId={proxy.id}
                checkingProfileId={checkingProxyId}
                cachedResult={proxyCheckResults[proxy.id]}
                disabled={isBulkCheckingProxies}
                setCheckingProfileId={setCheckingProxyId}
                onCheckComplete={(result) => {
                  setProxyCheckResults((prev) => ({
                    ...prev,
                    [proxy.id]: result,
                  }));
                }}
                onCheckFailed={(result) => {
                  setProxyCheckResults((prev) => ({
                    ...prev,
                    [proxy.id]: result,
                  }));
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      handleEditProxy(proxy);
                    }}
                  >
                    <LuPencil className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("proxies.management.editProxy")}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      handleDeleteProxy(proxy);
                    }}
                  >
                    <LuTrash2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {(proxyUsage[proxy.id] ?? 0) > 0 ? (
                    <p>
                      {(proxyUsage[proxy.id] ?? 0) === 1
                        ? t("proxies.management.deleteUnlinks_one", {
                            count: proxyUsage[proxy.id],
                          })
                        : t("proxies.management.deleteUnlinks_other", {
                            count: proxyUsage[proxy.id],
                          })}
                    </p>
                  ) : (
                    <p>{t("proxies.management.deleteProxy")}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        },
      },
    ],
    [
      t,
      proxySyncStatus,
      proxySyncErrors,
      proxyUsage,
      isTogglingSync,
      proxyInUse,
      checkingProxyId,
      proxyCheckResults,
      isBulkCheckingProxies,
      handleToggleSync,
      handleEditProxy,
      handleDeleteProxy,
    ],
  );

  const proxiesTable = useReactTable({
    data: filteredProxies,
    columns: proxyColumns,
    state: {
      sorting: proxiesSorting,
      rowSelection: proxiesRowSelection,
      pagination: proxiesPagination,
    },
    onSortingChange: setProxiesSorting,
    onRowSelectionChange: setProxiesRowSelection,
    onPaginationChange: setProxiesPagination,
    enableRowSelection: (row) => !proxyInUse[row.original.id],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
  });

  const vpnColumns = useMemo<ColumnDef<VpnConfig>[]>(
    () => [
      {
        id: "select",
        size: 36,
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected()
                ? true
                : table.getIsSomeRowsSelected()
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(value) => {
              table.toggleAllRowsSelected(!!value);
            }}
            aria-label={t("common.aria.selectAll")}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onCheckedChange={(value) => {
              row.toggleSelected(!!value);
            }}
            aria-label={t("common.aria.selectRow")}
          />
        ),
      },
      {
        accessorKey: "name",
        enableSorting: true,
        sortingFn: "alphanumeric",
        header: ({ column }) => (
          <Button
            variant="ghost"
            onClick={() => {
              column.toggleSorting(column.getIsSorted() === "asc");
            }}
            className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
          >
            {t("common.labels.name")}
            {column.getIsSorted() === "asc" ? (
              <LuChevronUp className="ml-2 size-4" />
            ) : column.getIsSorted() === "desc" ? (
              <LuChevronDown className="ml-2 size-4" />
            ) : null}
          </Button>
        ),
        cell: ({ row }) => {
          const vpn = row.original;
          const syncDot = getSyncStatusDot(
            vpn,
            vpnSyncStatus[vpn.id],
            t,
            vpnSyncErrors[vpn.id],
          );
          return (
            <div className="flex min-w-0 items-center gap-2 font-medium">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={`size-2 rounded-full shrink-0 ${syncDot.color} ${
                      syncDot.animate ? "animate-pulse" : ""
                    }`}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{syncDot.tooltip}</p>
                </TooltipContent>
              </Tooltip>
              <span className="truncate">{vpn.name}</span>
            </div>
          );
        },
      },
      {
        id: "type",
        size: 96,
        enableSorting: false,
        header: () => t("common.labels.type"),
        cell: () => <Badge variant="outline">WG</Badge>,
      },
      {
        id: "usage",
        size: 80,
        enableSorting: false,
        header: () => t("proxies.management.usage"),
        cell: ({ row }) => (
          <Badge variant="secondary">{vpnUsage[row.original.id] ?? 0}</Badge>
        ),
      },
      {
        id: "sync",
        size: 96,
        enableSorting: false,
        header: () => t("proxies.management.syncCol"),
        cell: ({ row }) => {
          const vpn = row.original;
          const locked = vpnInUse[vpn.id];
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center">
                  <AnimatedSwitch
                    checked={vpn.sync_enabled}
                    onCheckedChange={() => void handleToggleVpnSync(vpn)}
                    disabled={isTogglingVpnSync[vpn.id] || locked}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {locked ? (
                  <p>{t("syncTooltips.lockedInUse")}</p>
                ) : (
                  <p>
                    {vpn.sync_enabled
                      ? t("syncTooltips.disable")
                      : t("syncTooltips.enable")}
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "actions",
        size: 144,
        enableSorting: false,
        header: () => t("common.labels.actions"),
        cell: ({ row }) => {
          const vpn = row.original;
          return (
            <div className="flex gap-1">
              <VpnCheckButton
                vpnId={vpn.id}
                vpnName={vpn.name}
                checkingVpnId={checkingVpnId}
                setCheckingVpnId={setCheckingVpnId}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      handleEditVpn(vpn);
                    }}
                  >
                    <LuPencil className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("vpns.management.editVpn")}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        handleDeleteVpn(vpn);
                      }}
                      disabled={(vpnUsage[vpn.id] ?? 0) > 0}
                    >
                      <LuTrash2 className="size-4" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {(vpnUsage[vpn.id] ?? 0) > 0 ? (
                    <p>
                      {(vpnUsage[vpn.id] ?? 0) === 1
                        ? t("vpns.management.cannotDelete_one", {
                            count: vpnUsage[vpn.id],
                          })
                        : t("vpns.management.cannotDelete_other", {
                            count: vpnUsage[vpn.id],
                          })}
                    </p>
                  ) : (
                    <p>{t("vpns.management.deleteVpn")}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        },
      },
    ],
    [
      t,
      vpnSyncStatus,
      vpnSyncErrors,
      vpnUsage,
      isTogglingVpnSync,
      vpnInUse,
      checkingVpnId,
      handleToggleVpnSync,
      handleEditVpn,
      handleDeleteVpn,
    ],
  );

  const vpnsTable = useReactTable({
    data: vpnConfigs,
    columns: vpnColumns,
    state: {
      sorting: vpnsSorting,
      rowSelection: vpnsRowSelection,
    },
    onSortingChange: setVpnsSorting,
    onRowSelectionChange: setVpnsRowSelection,
    enableRowSelection: (row) => !vpnInUse[row.original.id],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  const selectedProxies = proxiesTable
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original);
  const selectedVpns = vpnsTable
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original);
  const proxyPageCount = Math.max(proxiesTable.getPageCount(), 1);
  const proxyRangeStart =
    filteredProxies.length === 0
      ? 0
      : proxiesPagination.pageIndex * proxiesPagination.pageSize + 1;
  const proxyRangeEnd = Math.min(
    filteredProxies.length,
    (proxiesPagination.pageIndex + 1) * proxiesPagination.pageSize,
  );

  useEffect(() => {
    if (proxiesPagination.pageIndex >= proxyPageCount) {
      proxiesTable.setPageIndex(proxyPageCount - 1);
    }
  }, [proxiesPagination.pageIndex, proxiesTable, proxyPageCount]);

  const handleBulkDeleteProxies = useCallback(async () => {
    if (selectedProxies.length === 0) return;
    setIsBulkDeletingProxies(true);
    try {
      const results = await runConcurrently(selectedProxies, (proxy) =>
        invoke("delete_stored_proxy", { proxyId: proxy.id }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;
      if (succeeded > 0) {
        toast.success(t("proxies.management.deleteSuccess"));
      }
      if (failed > 0) {
        toast.error(t("proxies.management.deleteFailed"));
      }
      await emit("stored-proxies-changed");
      setProxiesRowSelection({});
    } finally {
      setIsBulkDeletingProxies(false);
      setShowBulkDeleteProxiesDialog(false);
    }
  }, [selectedProxies, t]);

  const handleBulkDeleteVpns = useCallback(async () => {
    if (selectedVpns.length === 0) return;
    setIsBulkDeletingVpns(true);
    try {
      const results = await runConcurrently(selectedVpns, (vpn) =>
        invoke("delete_vpn_config", { vpnId: vpn.id }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const succeeded = results.length - failed;
      if (succeeded > 0) {
        toast.success(t("vpns.management.deleteSuccess"));
      }
      if (failed > 0) {
        toast.error(t("vpns.management.deleteFailed"));
      }
      await emit("vpn-configs-changed");
      setVpnsRowSelection({});
    } finally {
      setIsBulkDeletingVpns(false);
      setShowBulkDeleteVpnsDialog(false);
    }
  }, [selectedVpns, t]);

  // Bulk-toggle sync: if every selectable row has sync ON, turn them all
  // OFF; otherwise turn them all ON. Items locked by a synced profile
  // (proxyInUse / vpnInUse) are skipped silently when the target is OFF.
  const handleBulkToggleProxiesSync = useCallback(async () => {
    if (selectedProxies.length === 0) return;
    const allOn = selectedProxies.every((p) => p.sync_enabled);
    const targetEnabled = !allOn;
    const targets = selectedProxies.filter((p) =>
      targetEnabled ? !p.sync_enabled : p.sync_enabled && !proxyInUse[p.id],
    );
    if (targets.length === 0) return;
    const results = await runConcurrently(targets, (proxy) =>
      invoke("set_proxy_sync_enabled", {
        proxyId: proxy.id,
        enabled: targetEnabled,
      }),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showErrorToast(
        parseBackendError(firstRejection.reason)
          ? translateBackendError(t, firstRejection.reason)
          : t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("proxies.management.syncEnabled")
          : t("proxies.management.syncDisabled"),
      );
    }
    await emit("stored-proxies-changed");
  }, [selectedProxies, proxyInUse, t]);

  const handleBulkToggleVpnsSync = useCallback(async () => {
    if (selectedVpns.length === 0) return;
    const allOn = selectedVpns.every((v) => v.sync_enabled);
    const targetEnabled = !allOn;
    const targets = selectedVpns.filter((v) =>
      targetEnabled ? !v.sync_enabled : v.sync_enabled && !vpnInUse[v.id],
    );
    if (targets.length === 0) return;
    const results = await runConcurrently(targets, (vpn) =>
      invoke("set_vpn_sync_enabled", {
        vpnId: vpn.id,
        enabled: targetEnabled,
      }),
    );
    const firstRejection = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    if (firstRejection) {
      showErrorToast(
        parseBackendError(firstRejection.reason)
          ? translateBackendError(t, firstRejection.reason)
          : t("proxies.management.updateSyncFailed"),
      );
    } else {
      showSuccessToast(
        targetEnabled
          ? t("proxies.management.syncEnabled")
          : t("proxies.management.syncDisabled"),
      );
    }
    await emit("vpn-configs-changed");
  }, [selectedVpns, vpnInUse, t]);

  const handleBulkCheckProxies = useCallback(async () => {
    if (selectedProxies.length === 0 || isBulkCheckingProxies) return;
    setIsBulkCheckingProxies(true);
    try {
      const results = await runConcurrently(selectedProxies, (proxy) =>
        invoke<ProxyCheckResult>("check_proxy_validity", {
          proxyId: proxy.id,
          proxySettings: proxy.proxy_settings,
        }),
      );
      const failedResult = (): ProxyCheckResult => ({
        ip: "",
        timestamp: Math.floor(Date.now() / 1000),
        is_valid: false,
      });
      const nextResults: Record<string, ProxyCheckResult> = {};
      let working = 0;
      results.forEach((result, index) => {
        const checked =
          result.status === "fulfilled" ? result.value : failedResult();
        nextResults[selectedProxies[index].id] = checked;
        if (checked.is_valid) working += 1;
      });
      setProxyCheckResults((current) => ({ ...current, ...nextResults }));
      toast.success(
        t("proxies.management.bulkCheckResult", {
          count: results.length,
          working,
          failed: results.length - working,
        }),
      );
    } finally {
      setIsBulkCheckingProxies(false);
    }
  }, [isBulkCheckingProxies, selectedProxies, t]);

  const handleCopySelectedProxies = useCallback(async () => {
    if (selectedProxies.length === 0) return;
    try {
      await navigator.clipboard.writeText(
        selectedProxies.map(proxyConnectionUrl).join("\n"),
      );
      toast.success(
        t("proxies.management.copiedSelected", {
          count: selectedProxies.length,
        }),
      );
    } catch (error) {
      console.error("Failed to copy proxy URLs:", error);
      toast.error(t("proxies.management.copyFailed"));
    }
  }, [selectedProxies, t]);

  // Profiles currently routed through the proxy being deleted: the confirm
  // copy warns that they all switch to direct.
  const proxyDeleteUsage = proxyToDelete
    ? (proxyUsage[proxyToDelete.id] ?? 0)
    : 0;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose} subPage={subPage}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(80rem,calc(100%-4rem))] flex-col">
          {!subPage && (
            <DialogHeader>
              <DialogTitle>{t("proxies.management.title")}</DialogTitle>
              <DialogDescription>
                {t("proxies.management.description")}
              </DialogDescription>
            </DialogHeader>
          )}

          <div className="@container flex min-h-0 w-full flex-1 flex-col">
            <AnimatedTabs
              key={initialTab}
              defaultValue={initialTab}
              onValueChange={(v) => setActiveTab(v as "proxies" | "vpns")}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <AnimatedTabsList>
                  <AnimatedTabsTrigger value="proxies">
                    <span>{t("proxies.management.tabProxies")}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {storedProxies.length}
                    </span>
                  </AnimatedTabsTrigger>
                  <AnimatedTabsTrigger value="vpns">
                    <span>{t("proxies.management.tabVpns")}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {vpnConfigs.length}
                    </span>
                  </AnimatedTabsTrigger>
                </AnimatedTabsList>
                <div className="flex items-center gap-2">
                  {activeTab === "proxies" && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RippleButton
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setShowImportDialog(true);
                            }}
                            className="flex items-center gap-2"
                            aria-label={t("common.buttons.import")}
                          >
                            <LuUpload className="size-4" />
                            <span className="hidden @2xl:inline">
                              {t("common.buttons.import")}
                            </span>
                          </RippleButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t("common.buttons.import")}</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RippleButton
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setShowExportDialog(true);
                            }}
                            className="flex items-center gap-2"
                            aria-label={t("common.buttons.export")}
                            disabled={storedProxies.length === 0}
                          >
                            <LuDownload className="size-4" />
                            <span className="hidden @2xl:inline">
                              {t("common.buttons.export")}
                            </span>
                          </RippleButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t("common.buttons.export")}</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RippleButton
                            size="sm"
                            onClick={handleCreateProxy}
                            className="flex items-center gap-2"
                            aria-label={t("proxies.management.newProxy")}
                          >
                            <GoPlus className="size-4" />
                            <span className="hidden @2xl:inline">
                              {t("proxies.management.newProxy")}
                            </span>
                          </RippleButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t("proxies.management.newProxy")}</p>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}
                  {activeTab === "vpns" && (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RippleButton
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setShowVpnImportDialog(true);
                            }}
                            className="flex items-center gap-2"
                            aria-label={t("common.buttons.import")}
                          >
                            <LuUpload className="size-4" />
                            <span className="hidden @2xl:inline">
                              {t("common.buttons.import")}
                            </span>
                          </RippleButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t("common.buttons.import")}</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <RippleButton
                            size="sm"
                            onClick={handleCreateVpn}
                            className="flex items-center gap-2"
                            aria-label={t("proxies.management.newVpn")}
                          >
                            <GoPlus className="size-4" />
                            <span className="hidden @2xl:inline">
                              {t("proxies.management.newVpn")}
                            </span>
                          </RippleButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t("proxies.management.newVpn")}</p>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>

              <AnimatedTabsContent
                value="proxies"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  {!isLoading && storedProxies.length > 0 && (
                    <div className="flex shrink-0 flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-48 flex-1">
                          <LuSearch className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={proxyQuery}
                            onChange={(event) => {
                              setProxyQuery(event.target.value);
                            }}
                            placeholder={t(
                              "proxies.management.searchPlaceholder",
                            )}
                            className="h-9 pr-9 pl-8"
                          />
                          {proxyQuery && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
                              onClick={() => {
                                setProxyQuery("");
                              }}
                              aria-label={t("common.buttons.clear")}
                            >
                              <LuX className="size-3.5" />
                            </Button>
                          )}
                        </div>
                        <Select
                          value={proxyListFilter}
                          onValueChange={(value) => {
                            setProxyListFilter(value as ProxyListFilter);
                          }}
                        >
                          <SelectTrigger className="h-9 w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">
                              {t("proxies.management.filterAll")}
                            </SelectItem>
                            <SelectItem value="working">
                              {t("proxies.management.filterWorking")}
                            </SelectItem>
                            <SelectItem value="failed">
                              {t("proxies.management.filterFailed")}
                            </SelectItem>
                            <SelectItem value="unchecked">
                              {t("proxies.management.filterUnchecked")}
                            </SelectItem>
                            <SelectItem value="used">
                              {t("proxies.management.filterUsed")}
                            </SelectItem>
                            <SelectItem value="unused">
                              {t("proxies.management.filterUnused")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={proxyProtocolFilter}
                          onValueChange={setProxyProtocolFilter}
                        >
                          <SelectTrigger className="h-9 w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">
                              {t("proxies.management.protocolAll")}
                            </SelectItem>
                            {availableProxyProtocols.map((protocol) => (
                              <SelectItem key={protocol} value={protocol}>
                                {protocol.toUpperCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span className="mr-1 tabular-nums">
                          {t("proxies.management.filteredCount", {
                            shown: filteredProxies.length,
                            total: storedProxies.length,
                          })}
                        </span>
                        <Button
                          type="button"
                          variant={
                            proxyListFilter === "working"
                              ? "secondary"
                              : "ghost"
                          }
                          size="sm"
                          className="h-6 gap-1.5 px-2 text-xs"
                          onClick={() => {
                            setProxyListFilter((current) =>
                              current === "working" ? "all" : "working",
                            );
                          }}
                        >
                          <span className="size-1.5 rounded-full bg-success" />
                          {t("proxies.management.workingCount", {
                            count: proxyHealthCounts.working,
                          })}
                        </Button>
                        <Button
                          type="button"
                          variant={
                            proxyListFilter === "failed" ? "secondary" : "ghost"
                          }
                          size="sm"
                          className="h-6 gap-1.5 px-2 text-xs"
                          onClick={() => {
                            setProxyListFilter((current) =>
                              current === "failed" ? "all" : "failed",
                            );
                          }}
                        >
                          <span className="size-1.5 rounded-full bg-destructive" />
                          {t("proxies.management.failedCount", {
                            count: proxyHealthCounts.failed,
                          })}
                        </Button>
                        <Button
                          type="button"
                          variant={
                            proxyListFilter === "unchecked"
                              ? "secondary"
                              : "ghost"
                          }
                          size="sm"
                          className="h-6 gap-1.5 px-2 text-xs"
                          onClick={() => {
                            setProxyListFilter((current) =>
                              current === "unchecked" ? "all" : "unchecked",
                            );
                          }}
                        >
                          <span className="size-1.5 rounded-full bg-muted-foreground" />
                          {t("proxies.management.uncheckedCount", {
                            count: proxyHealthCounts.unchecked,
                          })}
                        </Button>
                        <Button
                          type="button"
                          variant={
                            proxyListFilter === "used" ? "secondary" : "ghost"
                          }
                          size="sm"
                          className="h-6 gap-1.5 px-2 text-xs"
                          onClick={() => {
                            setProxyListFilter((current) =>
                              current === "used" ? "all" : "used",
                            );
                          }}
                        >
                          {t("proxies.management.usedCount", {
                            count: proxyHealthCounts.used,
                          })}
                        </Button>
                      </div>
                    </div>
                  )}
                  {isLoading ? (
                    <div className="text-sm text-muted-foreground">
                      {t("proxies.management.loading")}
                    </div>
                  ) : storedProxies.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      {t("proxies.management.noneCreated")}
                    </div>
                  ) : filteredProxies.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      {t("proxies.management.noMatches")}
                    </div>
                  ) : (
                    <>
                      <FadingScrollArea
                        className={cn(
                          "min-h-0 flex-1",
                          selectedProxies.length > 0 && "pb-16",
                        )}
                        style={
                          {
                            "--scroll-fade-top-offset": "32px",
                          } as React.CSSProperties
                        }
                      >
                        <Table
                          className="w-full table-fixed"
                          containerClassName="overflow-visible"
                        >
                          <TableHeader className="sticky top-0 z-10 bg-background">
                            {proxiesTable
                              .getHeaderGroups()
                              .map((headerGroup) => (
                                <TableRow key={headerGroup.id}>
                                  {headerGroup.headers.map((header) => (
                                    <TableHead
                                      key={header.id}
                                      style={{
                                        width:
                                          header.column.id === "name" ||
                                          header.column.id === "hostPort"
                                            ? undefined
                                            : `${header.column.getSize()}px`,
                                      }}
                                      className={cn(
                                        // name and hostPort emit no width, so
                                        // fixed layout splits the remaining
                                        // space evenly between them (hostPort
                                        // hides below @2xl, leaving name all
                                        // of it).
                                        header.column.id === "name" &&
                                          "max-w-0",
                                        header.column.id === "hostPort" &&
                                          "hidden max-w-0 @2xl:table-cell",
                                        (header.column.id === "protocol" ||
                                          header.column.id === "type") &&
                                          "hidden @2xl:table-cell",
                                      )}
                                    >
                                      {header.isPlaceholder
                                        ? null
                                        : flexRender(
                                            header.column.columnDef.header,
                                            header.getContext(),
                                          )}
                                    </TableHead>
                                  ))}
                                </TableRow>
                              ))}
                          </TableHeader>
                          <TableBody>
                            {proxiesTable.getRowModel().rows.map((row) => (
                              <TableRow
                                key={row.id}
                                data-state={row.getIsSelected() && "selected"}
                              >
                                {row.getVisibleCells().map((cell) => (
                                  <TableCell
                                    key={cell.id}
                                    style={{
                                      width:
                                        cell.column.id === "name" ||
                                        cell.column.id === "hostPort"
                                          ? undefined
                                          : `${cell.column.getSize()}px`,
                                    }}
                                    className={cn(
                                      cell.column.id === "name" && "max-w-0",
                                      cell.column.id === "hostPort" &&
                                        "hidden max-w-0 @2xl:table-cell",
                                      (cell.column.id === "protocol" ||
                                        cell.column.id === "type") &&
                                        "hidden @2xl:table-cell",
                                    )}
                                  >
                                    {flexRender(
                                      cell.column.columnDef.cell,
                                      cell.getContext(),
                                    )}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </FadingScrollArea>
                      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {t("proxies.management.resultRange", {
                            start: proxyRangeStart,
                            end: proxyRangeEnd,
                            total: filteredProxies.length,
                          })}
                        </span>
                        <div className="flex items-center gap-2">
                          <span>{t("proxies.management.rowsPerPage")}</span>
                          <Select
                            value={String(proxiesPagination.pageSize)}
                            onValueChange={(value) => {
                              proxiesTable.setPageSize(Number(value));
                            }}
                          >
                            <SelectTrigger className="h-8 w-20">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {[50, 100, 250].map((size) => (
                                <SelectItem key={size} value={String(size)}>
                                  {size}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className="min-w-24 text-center tabular-nums">
                            {t("proxies.management.pageStatus", {
                              page: proxiesPagination.pageIndex + 1,
                              pages: proxyPageCount,
                            })}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="size-8"
                                onClick={() => {
                                  proxiesTable.previousPage();
                                }}
                                disabled={!proxiesTable.getCanPreviousPage()}
                              >
                                <LuChevronLeft className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{t("proxies.management.previousPage")}</p>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="size-8"
                                onClick={() => {
                                  proxiesTable.nextPage();
                                }}
                                disabled={!proxiesTable.getCanNextPage()}
                              >
                                <LuChevronRight className="size-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{t("proxies.management.nextPage")}</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </AnimatedTabsContent>

              <AnimatedTabsContent
                value="vpns"
                className="mt-4 min-h-0 flex-1 flex-col data-[state=active]:flex"
              >
                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  {isLoadingVpns ? (
                    <div className="text-sm text-muted-foreground">
                      {t("vpns.management.loading")}
                    </div>
                  ) : vpnConfigs.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      {t("vpns.management.noneCreated")}
                    </div>
                  ) : (
                    <FadingScrollArea
                      className={cn(
                        "min-h-0 flex-1",
                        selectedVpns.length > 0 && "pb-16",
                      )}
                      style={
                        {
                          "--scroll-fade-top-offset": "32px",
                        } as React.CSSProperties
                      }
                    >
                      <Table
                        className="w-full table-fixed"
                        containerClassName="overflow-visible"
                      >
                        <TableHeader className="sticky top-0 z-10 bg-background">
                          {vpnsTable.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                              {headerGroup.headers.map((header) => (
                                <TableHead
                                  key={header.id}
                                  style={{
                                    width:
                                      header.column.id === "name" ||
                                      header.column.id === "hostPort"
                                        ? undefined
                                        : `${header.column.getSize()}px`,
                                  }}
                                  className={cn(
                                    // name and hostPort emit no width, so
                                    // fixed layout splits the remaining
                                    // space evenly between them (hostPort
                                    // hides below @2xl, leaving name all
                                    // of it).
                                    header.column.id === "name" && "max-w-0",
                                    header.column.id === "hostPort" &&
                                      "hidden max-w-0 @2xl:table-cell",
                                    (header.column.id === "protocol" ||
                                      header.column.id === "type") &&
                                      "hidden @2xl:table-cell",
                                  )}
                                >
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(
                                        header.column.columnDef.header,
                                        header.getContext(),
                                      )}
                                </TableHead>
                              ))}
                            </TableRow>
                          ))}
                        </TableHeader>
                        <TableBody>
                          {vpnsTable.getRowModel().rows.map((row) => (
                            <TableRow
                              key={row.id}
                              data-state={row.getIsSelected() && "selected"}
                            >
                              {row.getVisibleCells().map((cell) => (
                                <TableCell
                                  key={cell.id}
                                  style={{
                                    width:
                                      cell.column.id === "name" ||
                                      cell.column.id === "hostPort"
                                        ? undefined
                                        : `${cell.column.getSize()}px`,
                                  }}
                                  className={cn(
                                    cell.column.id === "name" && "max-w-0",
                                    cell.column.id === "hostPort" &&
                                      "hidden max-w-0 @2xl:table-cell",
                                    (cell.column.id === "protocol" ||
                                      cell.column.id === "type") &&
                                      "hidden @2xl:table-cell",
                                  )}
                                >
                                  {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                  )}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </FadingScrollArea>
                  )}
                </div>
              </AnimatedTabsContent>
            </AnimatedTabs>
          </div>

          {!subPage && (
            <DialogFooter>
              <RippleButton variant="outline" onClick={onClose}>
                {t("common.buttons.close")}
              </RippleButton>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <ProxyFormDialog
        isOpen={showProxyForm}
        onClose={handleProxyFormClose}
        editingProxy={editingProxy}
      />
      <DeleteConfirmationDialog
        isOpen={proxyToDelete !== null}
        onClose={() => {
          setProxyToDelete(null);
        }}
        onConfirm={handleConfirmDelete}
        title={t("proxies.management.deleteTitle")}
        description={
          proxyDeleteUsage > 0
            ? t(
                proxyDeleteUsage === 1
                  ? "proxies.management.deleteDescriptionWithUsage_one"
                  : "proxies.management.deleteDescriptionWithUsage_other",
                {
                  name: proxyToDelete?.name ?? "",
                  count: proxyDeleteUsage,
                },
              )
            : t("proxies.management.deleteDescription", {
                name: proxyToDelete?.name ?? "",
              })
        }
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isDeleting}
      />
      <ProxyImportDialog
        isOpen={showImportDialog}
        onClose={() => {
          setShowImportDialog(false);
        }}
      />
      <ProxyExportDialog
        isOpen={showExportDialog}
        onClose={() => {
          setShowExportDialog(false);
        }}
      />
      <VpnFormDialog
        isOpen={showVpnForm}
        onClose={handleVpnFormClose}
        editingVpn={editingVpn}
      />
      <DeleteConfirmationDialog
        isOpen={vpnToDelete !== null}
        onClose={() => {
          setVpnToDelete(null);
        }}
        onConfirm={handleConfirmDeleteVpn}
        title={t("vpns.management.deleteTitle")}
        description={t("vpns.management.deleteDescription", {
          name: vpnToDelete?.name ?? "",
        })}
        confirmButtonText={t("common.buttons.delete")}
        isLoading={isDeletingVpn}
      />
      <VpnImportDialog
        isOpen={showVpnImportDialog}
        onClose={() => {
          setShowVpnImportDialog(false);
        }}
      />
      {isOpen && activeTab === "proxies" && (
        <DataTableActionBar table={proxiesTable}>
          <DataTableActionBarSelection table={proxiesTable} />
          <DataTableActionBarAction
            tooltip={t("proxies.management.checkSelected")}
            onClick={() => void handleBulkCheckProxies()}
            size="icon"
            isPending={isBulkCheckingProxies}
          >
            <LuGauge />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("proxies.management.copySelected")}
            onClick={() => void handleCopySelectedProxies()}
            size="icon"
          >
            <LuClipboard />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => void handleBulkToggleProxiesSync()}
            size="icon"
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={() => {
              setShowBulkDeleteProxiesDialog(true);
            }}
            size="icon"
            variant="destructive"
            className="border-destructive bg-destructive/50 hover:bg-destructive/70"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}
      {isOpen && activeTab === "vpns" && (
        <DataTableActionBar table={vpnsTable}>
          <DataTableActionBarSelection table={vpnsTable} />
          <DataTableActionBarAction
            tooltip={t("syncTooltips.bulkToggle")}
            onClick={() => void handleBulkToggleVpnsSync()}
            size="icon"
          >
            <LuRefreshCw />
          </DataTableActionBarAction>
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={() => {
              setShowBulkDeleteVpnsDialog(true);
            }}
            size="icon"
            variant="destructive"
            className="border-destructive bg-destructive/50 hover:bg-destructive/70"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        </DataTableActionBar>
      )}
      <DeleteConfirmationDialog
        isOpen={showBulkDeleteProxiesDialog}
        onClose={() => {
          setShowBulkDeleteProxiesDialog(false);
        }}
        onConfirm={handleBulkDeleteProxies}
        title={t("proxies.bulkDelete.proxiesTitle")}
        description={t("proxies.bulkDelete.proxiesDescription", {
          count: selectedProxies.length,
          names: selectedProxies.map((p) => p.name).join(", "),
        })}
        confirmButtonText={t("proxies.bulkDelete.confirmButton", {
          count: selectedProxies.length,
        })}
        isLoading={isBulkDeletingProxies}
      />
      <DeleteConfirmationDialog
        isOpen={showBulkDeleteVpnsDialog}
        onClose={() => {
          setShowBulkDeleteVpnsDialog(false);
        }}
        onConfirm={handleBulkDeleteVpns}
        title={t("proxies.bulkDelete.vpnsTitle")}
        description={t("proxies.bulkDelete.vpnsDescription", {
          count: selectedVpns.length,
          names: selectedVpns.map((v) => v.name).join(", "),
        })}
        confirmButtonText={t("proxies.bulkDelete.confirmButton", {
          count: selectedVpns.length,
        })}
        isLoading={isBulkDeletingVpns}
      />
    </>
  );
}
