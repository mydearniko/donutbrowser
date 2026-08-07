"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type Row,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { Dispatch, SetStateAction } from "react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import { FiWifi } from "react-icons/fi";
import {
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuChevronUp,
  LuCookie,
  LuEllipsis,
  LuFolder,
  LuFolderOpen,
  LuInfo,
  LuLock,
  LuPencil,
  LuPlay,
  LuPlus,
  LuPuzzle,
  LuRefreshCw,
  LuSquare,
  LuTrash2,
  LuTriangleAlert,
  LuUsers,
} from "react-icons/lu";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { DeleteGroupDialog } from "@/components/delete-group-dialog";
import {
  ProfileBypassRulesDialog,
  ProfileDnsBlocklistDialog,
  ProfileInfoDialog,
  ProfileLaunchHookDialog,
} from "@/components/profile-info-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { useBrowserState } from "@/hooks/use-browser-state";
import { useCloudAuth } from "@/hooks/use-cloud-auth";
import { useProxyEvents } from "@/hooks/use-proxy-events";
import { useScrollFade } from "@/hooks/use-scroll-fade";
import { useTableSorting } from "@/hooks/use-table-sorting";
import { useTeamLocks } from "@/hooks/use-team-locks";
import { useVpnEvents } from "@/hooks/use-vpn-events";
import { translateBackendError } from "@/lib/backend-errors";
import {
  getBrowserDisplayName,
  getOSDisplayName,
  getProfileIcon,
  isCrossOsProfile,
} from "@/lib/browser-utils";
import { formatRelativeTime } from "@/lib/flag-utils";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import { cn } from "@/lib/utils";
import type {
  BrowserProfile,
  ExtensionGroup,
  GroupWithCount,
  LocationItem,
  ProxyCheckResult,
  StoredProxy,
  SyncSessionInfo,
  TrafficSnapshot,
  VpnConfig,
} from "@/types";
import { BandwidthMiniChart } from "./bandwidth-mini-chart";
import {
  DataTableActionBar,
  DataTableActionBarAction,
  DataTableActionBarSelection,
} from "./data-table-action-bar";
import MultipleSelector, { type Option } from "./multiple-selector";
import { ProxyCheckButton } from "./proxy-check-button";
import { TrafficDetailsDialog } from "./traffic-details-dialog";
import { Input } from "./ui/input";
import { RippleButton } from "./ui/ripple";

const PROFILE_TABLE_FIXED_WIDTHS = {
  select: 36,
  actions: 48,
  sync: 32,
  settings: 44,
} as const;

const PROFILE_TABLE_FLEX_COLUMNS = {
  name: { min: 168, weight: 3 },
  proxy: { min: 144, weight: 2.2 },
  tags: { min: 104, weight: 1.2 },
  ext: { min: 104, weight: 1 },
  dns: { min: 96, weight: 1 },
  note: { min: 96, weight: 0.8 },
} as const;

type ProfileTableFlexColumnId = keyof typeof PROFILE_TABLE_FLEX_COLUMNS;

const PROFILE_TABLE_FLEX_ENTRIES = Object.entries(
  PROFILE_TABLE_FLEX_COLUMNS,
) as Array<
  [
    ProfileTableFlexColumnId,
    (typeof PROFILE_TABLE_FLEX_COLUMNS)[ProfileTableFlexColumnId],
  ]
>;

const PROFILE_TABLE_OPTIONAL_COLUMNS = [
  { id: "tags", reserve: 64 },
  { id: "ext", reserve: 96 },
  { id: "dns", reserve: 128 },
  { id: "note", reserve: 160 },
] as const;

const PROFILE_TABLE_VISIBILITY_HYSTERESIS = 24;
const PROFILE_TABLE_FIXED_WIDTH = Object.values(
  PROFILE_TABLE_FIXED_WIDTHS,
).reduce((total, width) => total + width, 0);

function getProfileTableColumnVisibility(
  containerWidth: number,
  previous?: VisibilityState,
): VisibilityState {
  const visibility: VisibilityState = { created_at: false };
  let minimumWidth =
    PROFILE_TABLE_FIXED_WIDTH +
    PROFILE_TABLE_FLEX_COLUMNS.name.min +
    PROFILE_TABLE_FLEX_COLUMNS.proxy.min;

  for (const column of PROFILE_TABLE_OPTIONAL_COLUMNS) {
    minimumWidth += PROFILE_TABLE_FLEX_COLUMNS[column.id].min;
    const showAt = minimumWidth + column.reserve;
    const hideAt = showAt - PROFILE_TABLE_VISIBILITY_HYSTERESIS;
    visibility[column.id] =
      containerWidth >= (previous?.[column.id] ? hideAt : showAt);
  }

  return visibility;
}

function getProfileTableColumnWidths(
  containerWidth: number,
  visibility: VisibilityState,
): Record<string, number> {
  const widths: Record<string, number> = { ...PROFILE_TABLE_FIXED_WIDTHS };
  const visibleColumns = PROFILE_TABLE_FLEX_ENTRIES.filter(
    ([id]) => visibility[id] !== false,
  );
  const minimumFlexibleWidth = visibleColumns.reduce(
    (total, [, config]) => total + config.min,
    0,
  );
  const totalWeight = visibleColumns.reduce(
    (total, [, config]) => total + config.weight,
    0,
  );
  const extraWidth = Math.max(
    0,
    containerWidth - PROFILE_TABLE_FIXED_WIDTH - minimumFlexibleWidth,
  );

  let assignedWidth = PROFILE_TABLE_FIXED_WIDTH;
  for (const [id, config] of visibleColumns) {
    const width = Math.floor(
      config.min + (extraWidth * config.weight) / totalWeight,
    );
    widths[id] = width;
    assignedWidth += width;
  }

  if (containerWidth > assignedWidth) {
    widths.name += containerWidth - assignedWidth;
  }

  return widths;
}

// Stable table meta type to pass volatile state/handlers into TanStack Table without
// causing column definitions to be recreated on every render.
interface TableMeta {
  t: (key: string, options?: Record<string, unknown>) => string;
  selectedProfiles: string[];
  selectableCount: number;
  showCheckboxes: boolean;
  isClient: boolean;
  runningProfiles: Set<string>;
  launchingProfiles: Set<string>;
  stoppingProfiles: Set<string>;
  isUpdating: (browser: string) => boolean;
  browserState: ReturnType<typeof useBrowserState>;

  // Tags editor state
  tagsOverrides: Record<string, string[]>;
  allTags: string[];
  openTagsEditorFor: string | null;
  setAllTags: React.Dispatch<React.SetStateAction<string[]>>;
  setOpenTagsEditorFor: React.Dispatch<React.SetStateAction<string | null>>;
  setTagsOverrides: React.Dispatch<
    React.SetStateAction<Record<string, string[]>>
  >;

  // Note editor state
  noteOverrides: Record<string, string | null>;
  openNoteEditorFor: string | null;
  setOpenNoteEditorFor: React.Dispatch<React.SetStateAction<string | null>>;
  setNoteOverrides: React.Dispatch<
    React.SetStateAction<Record<string, string | null>>
  >;

  // Proxy selector state
  openProxySelectorFor: string | null;
  setOpenProxySelectorFor: React.Dispatch<React.SetStateAction<string | null>>;
  proxyOverrides: Record<string, string | null>;
  storedProxies: StoredProxy[];
  handleProxySelection: (
    profileId: string,
    proxyId: string | null,
  ) => void | Promise<void>;
  checkingProfileId: string | null;
  proxyCheckResults: Record<string, ProxyCheckResult>;
  onEditProxy: (proxy: StoredProxy) => void;

  // VPN selector state
  vpnConfigs: VpnConfig[];
  vpnOverrides: Record<string, string | null>;
  handleVpnSelection: (
    profileId: string,
    vpnId: string | null,
  ) => void | Promise<void>;

  // Extension groups (for Ext column lookup)
  extensionGroups: ExtensionGroup[];

  // Click handlers for inline Ext / DNS cell editing
  onAssignExtensionGroup?: (profileIds: string[]) => void;
  setDnsBlocklistProfile: React.Dispatch<
    React.SetStateAction<BrowserProfile | null>
  >;

  // Selection helpers
  isProfileSelected: (id: string) => boolean;
  handleToggleAll: (checked: boolean) => void;
  handleCheckboxChange: (id: string, checked: boolean) => void;
  handleIconClick: (id: string) => void;

  // Rename helpers
  handleRename: () => void | Promise<void>;
  setProfileToRename: React.Dispatch<
    React.SetStateAction<BrowserProfile | null>
  >;
  setNewProfileName: React.Dispatch<React.SetStateAction<string>>;
  setRenameError: React.Dispatch<React.SetStateAction<string | null>>;
  profileToRename: BrowserProfile | null;
  newProfileName: string;
  isRenamingSaving: boolean;
  renameError: string | null;

  // Launch/stop helpers
  setLaunchingProfiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  setStoppingProfiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  onKillProfile: (profile: BrowserProfile) => void | Promise<void>;
  onLaunchProfile: (profile: BrowserProfile) => void | Promise<void>;

  // Overflow actions
  onAssignProfilesToGroup?: (profileIds: string[]) => void;
  onConfigureWayfern?: (profile: BrowserProfile) => void;
  onCloneProfile?: (profile: BrowserProfile) => void;
  onCopyCookiesToProfile?: (profile: BrowserProfile) => void;
  onOpenCookieManagement?: (profile: BrowserProfile) => void;

  // Traffic snapshots (lightweight real-time data)
  trafficSnapshots: Record<string, TrafficSnapshot>;
  onOpenTrafficDialog?: (profileId: string) => void;

  // Sync
  syncStatuses: Record<string, { status: string; error?: string }>;
  onOpenProfileSyncDialog?: (profile: BrowserProfile) => void;
  onToggleProfileSync?: (profile: BrowserProfile) => void;

  // Country proxy creation (inline in proxy dropdown)
  countries: LocationItem[];
  canCreateLocationProxy: boolean;
  loadCountries: () => Promise<void>;
  handleCreateCountryProxy: (
    profileId: string,
    country: LocationItem,
  ) => Promise<void>;

  // Team locks
  isProfileLockedByAnother: (profileId: string) => boolean;
  getProfileLockEmail: (profileId: string) => string | undefined;

  // Synchronizer
  getProfileSyncInfo: (profileId: string) =>
    | {
        session: SyncSessionInfo;
        isLeader: boolean;
        failedAtUrl: string | null;
      }
    | undefined;
  onLaunchWithSync: (profile: BrowserProfile) => void;
}

interface SyncStatusDot {
  color: string;
  tooltip: string;
  animate: boolean;
  encrypted: boolean;
}

function getProfileSyncStatusDot(
  profile: BrowserProfile,
  liveStatus:
    | "syncing"
    | "waiting"
    | "synced"
    | "error"
    | "disabled"
    | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
  errorMessage?: string,
): SyncStatusDot | null {
  const encrypted = profile.sync_mode === "Encrypted";
  const status =
    liveStatus ??
    (profile.sync_mode && profile.sync_mode !== "Disabled"
      ? "synced"
      : "disabled");

  switch (status) {
    case "syncing":
      return {
        color: "bg-warning",
        tooltip: t("profileTable.syncTooltipSyncing"),
        animate: true,
        encrypted,
      };
    case "waiting":
      return {
        color: "bg-warning",
        tooltip: t("profileTable.syncTooltipCloseToSync"),
        animate: false,
        encrypted,
      };
    case "synced":
      return {
        color: "bg-success",
        tooltip: profile.last_sync
          ? t("profileTable.syncTooltipSyncedAt", {
              time: new Date(profile.last_sync * 1000).toLocaleString(),
            })
          : t("profileTable.syncTooltipSynced"),
        animate: false,
        encrypted,
      };
    case "error":
      return {
        color: "bg-destructive",
        tooltip: errorMessage
          ? t("profileTable.syncTooltipErrorWith", { error: errorMessage })
          : t("profileTable.syncTooltipError"),
        animate: false,
        encrypted,
      };
    case "disabled":
      if (profile.last_sync) {
        return {
          color: "bg-muted-foreground",
          tooltip: t("profileTable.syncTooltipDisabledWithLast", {
            time: formatRelativeTime(profile.last_sync),
          }),
          animate: false,
          encrypted: false,
        };
      }
      return null;
    default:
      return null;
  }
}

// Inline extension-group dropdown for the Ext column. Matches the
// proxy column's Popover-style picker — no nested dialog.
function ExtCell({
  profile,
  meta,
}: {
  profile: BrowserProfile;
  meta: TableMeta;
}) {
  const [open, setOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const groupId = profile.extension_group_id ?? null;
  const group = groupId
    ? meta.extensionGroups.find((g) => g.id === groupId)
    : undefined;
  const label = group?.name ?? meta.t("profiles.table.extDefault");

  const onPick = async (nextId: string | null) => {
    setIsSaving(true);
    try {
      await invoke("assign_extension_group_to_profile", {
        profileId: profile.id,
        extensionGroupId: nextId,
      });
    } catch (err) {
      console.error("Failed to assign extension group:", err);
    } finally {
      setIsSaving(false);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isSaving}
          className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
        >
          <LuPuzzle className="size-3 shrink-0" />
          <span className="flex-1 truncate" title={label}>
            {label}
          </span>
          <LuChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={meta.t("profiles.table.extSearch")} />
          <CommandList>
            <CommandEmpty>{meta.t("profiles.table.extEmpty")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__default__"
                onSelect={() => {
                  void onPick(null);
                }}
              >
                {groupId === null && <LuCheck className="mr-2 size-3.5" />}
                <span className={groupId === null ? "" : "ml-5"}>
                  {meta.t("profiles.table.extDefault")}
                </span>
              </CommandItem>
              {meta.extensionGroups.map((g) => (
                <CommandItem
                  key={g.id}
                  value={g.name}
                  onSelect={() => {
                    void onPick(g.id);
                  }}
                >
                  {groupId === g.id && <LuCheck className="mr-2 size-3.5" />}
                  <span className={groupId === g.id ? "" : "ml-5"}>
                    {g.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Inline DNS blocklist dropdown — same Popover/Command pattern as Ext.
function DnsCell({
  profile,
  meta,
}: {
  profile: BrowserProfile;
  meta: TableMeta;
}) {
  const [open, setOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const level = profile.dns_blocklist ?? null;
  // Backend levels are: light, normal, pro, pro_plus, ultimate (+ null).
  // Keep the list ordered from least to most restrictive.
  const LEVELS: { value: string; labelKey: string }[] = [
    { value: "light", labelKey: "dnsBlocklist.light" },
    { value: "normal", labelKey: "dnsBlocklist.normal" },
    { value: "pro", labelKey: "dnsBlocklist.pro" },
    { value: "pro_plus", labelKey: "dnsBlocklist.proPlus" },
    { value: "ultimate", labelKey: "dnsBlocklist.ultimate" },
  ];
  const currentLabel =
    level === null
      ? null
      : (LEVELS.find((l) => l.value === level)?.labelKey ?? null);

  const onPick = async (nextLevel: string | null) => {
    setIsSaving(true);
    try {
      await invoke("update_profile_dns_blocklist", {
        profileId: profile.id,
        dnsBlocklist: nextLevel,
      });
    } catch (err) {
      console.error("Failed to update DNS blocklist:", err);
    } finally {
      setIsSaving(false);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-onborda="dns-blocklist"
          disabled={isSaving}
          className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs text-muted-foreground transition-colors duration-100 hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
          title={
            level
              ? meta.t("profiles.table.dnsLevel", { level })
              : meta.t("dnsBlocklist.none")
          }
        >
          <FiWifi className="size-3 shrink-0" />
          <span className="flex-1 truncate text-[11px] tracking-wide">
            {currentLabel ? meta.t(currentLabel) : "—"}
          </span>
          <LuChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => {
                  void onPick(null);
                }}
              >
                {level === null && <LuCheck className="mr-2 size-3.5" />}
                <span className={level === null ? "" : "ml-5"}>
                  {meta.t("dnsBlocklist.none")}
                </span>
              </CommandItem>
              {LEVELS.map((l) => (
                <CommandItem
                  key={l.value}
                  value={l.value}
                  onSelect={() => {
                    void onPick(l.value);
                  }}
                >
                  {level === l.value && <LuCheck className="mr-2 size-3.5" />}
                  <span className={level === l.value ? "" : "ml-5"}>
                    {meta.t(l.labelKey)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const TagsCell = React.memo<{
  profile: BrowserProfile;
  isDisabled: boolean;
  tagsOverrides: Record<string, string[]>;
  allTags: string[];
  setAllTags: React.Dispatch<React.SetStateAction<string[]>>;
  openTagsEditorFor: string | null;
  setOpenTagsEditorFor: React.Dispatch<React.SetStateAction<string | null>>;
  setTagsOverrides: React.Dispatch<
    React.SetStateAction<Record<string, string[]>>
  >;
}>(
  ({
    profile,
    isDisabled,
    tagsOverrides,
    allTags,
    setAllTags,
    openTagsEditorFor,
    setOpenTagsEditorFor,
    setTagsOverrides,
  }) => {
    const { t: translate } = useTranslation();
    const effectiveTags: string[] = Object.hasOwn(tagsOverrides, profile.id)
      ? tagsOverrides[profile.id]
      : (profile.tags ?? []);

    const valueOptions: Option[] = React.useMemo(
      () => effectiveTags.map((t) => ({ value: t, label: t })),
      [effectiveTags],
    );
    const allOptions: Option[] = React.useMemo(
      () => allTags.map((t) => ({ value: t, label: t })),
      [allTags],
    );

    const onTagsChange = React.useCallback(
      async (newTagsRaw: string[]) => {
        // Dedupe tags
        const seen = new Set<string>();
        const newTags: string[] = [];
        for (const t of newTagsRaw) {
          if (!seen.has(t)) {
            seen.add(t);
            newTags.push(t);
          }
        }
        setTagsOverrides((prev) => ({ ...prev, [profile.id]: newTags }));
        try {
          await invoke<BrowserProfile>("update_profile_tags", {
            profileId: profile.id,
            tags: newTags,
          });
          setAllTags((prev) => {
            const next = new Set(prev);
            for (const t of newTags) next.add(t);
            return Array.from(next).sort();
          });
        } catch (error) {
          console.error("Failed to update tags:", error);
        }
      },
      [profile.id, setTagsOverrides, setAllTags],
    );

    const handleChange = React.useCallback(
      async (opts: Option[]) => {
        const newTagsRaw = opts.map((o) => o.value);
        await onTagsChange(newTagsRaw);
      },
      [onTagsChange],
    );

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const editorRef = React.useRef<HTMLDivElement | null>(null);
    const [visibleCount, setVisibleCount] = React.useState<number>(
      effectiveTags.length,
    );
    const [isFocused, setIsFocused] = React.useState(false);

    React.useLayoutEffect(() => {
      // Only measure when not editing this profile's tags
      if (openTagsEditorFor === profile.id) return;
      const container = containerRef.current;
      if (!container) return;

      let timeoutId: number | undefined;
      const compute = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => {
          const available = container.clientWidth;
          if (available <= 0) return;
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const style = window.getComputedStyle(container);
          const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          ctx.font = font;
          const padding = 16;
          const gap = 4;
          let used = 0;
          let count = 0;
          for (let i = 0; i < effectiveTags.length; i++) {
            const text = effectiveTags[i];
            const width = Math.ceil(ctx.measureText(text).width) + padding;
            const remaining = effectiveTags.length - (i + 1);
            let extra = 0;
            if (remaining > 0) {
              const plusText = `+${remaining}`;
              extra = Math.ceil(ctx.measureText(plusText).width) + padding;
            }
            const nextUsed =
              used +
              (used > 0 ? gap : 0) +
              width +
              (remaining > 0 ? gap + extra : 0);
            if (nextUsed <= available) {
              used += (used > 0 ? gap : 0) + width;
              count = i + 1;
            } else {
              break;
            }
          }
          setVisibleCount(count);
        }, 16); // Debounce with RAF timing
      };
      compute();
      const ro = new ResizeObserver(compute);
      ro.observe(container);
      return () => {
        ro.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
      };
    }, [effectiveTags, openTagsEditorFor, profile.id]);

    React.useEffect(() => {
      if (openTagsEditorFor !== profile.id) return;
      const handleClick = (e: MouseEvent) => {
        const target = e.target as Node | null;
        if (
          editorRef.current &&
          target &&
          !editorRef.current.contains(target)
        ) {
          setOpenTagsEditorFor(null);
        }
      };
      document.addEventListener("mousedown", handleClick);
      return () => {
        document.removeEventListener("mousedown", handleClick);
      };
    }, [openTagsEditorFor, profile.id, setOpenTagsEditorFor]);

    React.useEffect(() => {
      if (openTagsEditorFor === profile.id && editorRef.current) {
        // Focus the inner input of MultipleSelector on open
        const inputEl = editorRef.current.querySelector("input");
        if (inputEl) {
          inputEl.focus();
        }
      }
    }, [openTagsEditorFor, profile.id]);

    if (openTagsEditorFor !== profile.id) {
      const hiddenCount = Math.max(0, effectiveTags.length - visibleCount);
      const ButtonContent = (
        <button
          type="button"
          ref={containerRef as unknown as React.RefObject<HTMLButtonElement>}
          className={cn(
            "flex h-6 w-full cursor-pointer items-center gap-1 overflow-hidden rounded border-none bg-transparent px-2 py-1",
            isDisabled
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:bg-accent/50",
          )}
          onClick={() => {
            if (!isDisabled) setOpenTagsEditorFor(profile.id);
          }}
        >
          {effectiveTags.slice(0, visibleCount).map((t) => (
            <Badge key={t} variant="secondary" className="px-2 py-0 text-xs">
              {t}
            </Badge>
          ))}
          {effectiveTags.length === 0 && (
            <span className="text-muted-foreground">
              {translate("profileTable.noTags")}
            </span>
          )}
          {hiddenCount > 0 && (
            <Badge variant="outline" className="px-2 py-0 text-xs">
              +{hiddenCount}
            </Badge>
          )}
        </button>
      );

      return (
        <div className="h-6 w-full cursor-pointer">
          <Tooltip>
            <TooltipTrigger asChild>{ButtonContent}</TooltipTrigger>
            {hiddenCount > 0 && (
              <TooltipContent className="max-w-[320px]">
                <div className="flex flex-wrap gap-1">
                  {effectiveTags.map((t) => (
                    <Badge
                      key={t}
                      variant="secondary"
                      className="px-2 py-0 text-xs"
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "relative h-6 w-full",
          isDisabled && "pointer-events-none opacity-60",
        )}
      >
        <div
          ref={editorRef}
          className="absolute top-0 left-0 z-50 min-h-6 w-40 rounded-md bg-popover shadow-md"
        >
          <MultipleSelector
            value={valueOptions}
            options={allOptions}
            onChange={(opts) => void handleChange(opts)}
            creatable
            selectFirstItem={false}
            placeholder={
              effectiveTags.length === 0
                ? translate("profileTable.addTagsPlaceholder")
                : ""
            }
            className={cn(
              "border-0! bg-transparent focus-within:ring-0!",
              "[&_div:first-child]:border-0! [&_div:first-child]:ring-0! [&_div:first-child]:focus-within:ring-0!",
              "[&_div:first-child]:min-h-6! [&_div:first-child]:px-2! [&_div:first-child]:py-1!",
              "[&_div:first-child>div]:h-6! [&_div:first-child>div]:items-center",
              "[&_input]:mt-0! [&_input]:ml-0! [&_input]:px-0!",
              !isFocused && "[&_div:first-child>div]:justify-center",
            )}
            badgeClassName="shrink-0"
            inputProps={{
              className: "!py-0 text-sm caret-current !ml-0 !mt-0 !px-0",
              onKeyDown: (e) => {
                if (e.key === "Escape") setOpenTagsEditorFor(null);
              },
              onFocus: () => {
                setIsFocused(true);
              },
              onBlur: () => {
                setIsFocused(false);
              },
            }}
          />
        </div>
      </div>
    );
  },
);

TagsCell.displayName = "TagsCell";

const NonHoverableTooltip = React.memo<{
  children: React.ReactNode;
  content: React.ReactNode;
  sideOffset?: number;
  alignOffset?: number;
  horizontalOffset?: number;
}>(
  ({
    children,
    content,
    sideOffset = 4,
    alignOffset = 0,
    horizontalOffset = 0,
  }) => {
    const [isOpen, setIsOpen] = React.useState(false);

    return (
      <Tooltip open={isOpen} onOpenChange={setIsOpen}>
        <TooltipTrigger
          asChild
          onMouseEnter={() => {
            setIsOpen(true);
          }}
          onMouseLeave={() => {
            setIsOpen(false);
          }}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          arrowOffset={horizontalOffset}
          onPointerEnter={(e) => {
            e.preventDefault();
          }}
          onPointerLeave={() => {
            setIsOpen(false);
          }}
          className="pointer-events-none"
          style={
            horizontalOffset !== 0
              ? { transform: `translateX(${horizontalOffset}px)` }
              : undefined
          }
        >
          {content}
        </TooltipContent>
      </Tooltip>
    );
  },
);

NonHoverableTooltip.displayName = "NonHoverableTooltip";

// CSS-truncated text whose tooltip only appears when the text actually
// overflows its column (measured on hover, so it tracks live resizes).
const OverflowTooltipText = React.memo<{
  text: string;
  className?: string;
}>(({ text, className }) => {
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (!open) return;
        const el = textRef.current;
        if (el) setIsOverflowing(el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <span
          ref={textRef}
          className={cn("block max-w-full min-w-0 truncate", className)}
        >
          {text}
        </span>
      </TooltipTrigger>
      {isOverflowing && <TooltipContent>{text}</TooltipContent>}
    </Tooltip>
  );
});

OverflowTooltipText.displayName = "OverflowTooltipText";

// Must be rendered inside a <Popover>; the tooltip shows the full assignment
// name only when it is truncated in the cell.
const ProxyCellTrigger = React.memo<{
  displayName: string;
  hasAssignment: boolean;
  vpnBadge: string | null;
  isDisabled: boolean;
}>(({ displayName, hasAssignment, vpnBadge, isDisabled }) => {
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (!open) return;
        const el = textRef.current;
        if (el) setIsOverflowing(el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <span
            className={cn(
              "flex max-w-full min-w-0 items-center gap-2 rounded px-2 py-1",
              isDisabled
                ? "pointer-events-none cursor-not-allowed opacity-60"
                : "cursor-pointer hover:bg-accent/50",
            )}
          >
            {vpnBadge && (
              <Badge
                variant="outline"
                className="shrink-0 px-1 py-0 text-[10px] leading-tight"
              >
                {vpnBadge}
              </Badge>
            )}
            <span
              ref={textRef}
              className={cn(
                "min-w-0 truncate text-sm",
                !hasAssignment && "text-muted-foreground",
              )}
            >
              {displayName}
            </span>
          </span>
        </PopoverTrigger>
      </TooltipTrigger>
      {hasAssignment && isOverflowing && (
        <TooltipContent>{displayName}</TooltipContent>
      )}
    </Tooltip>
  );
});

ProxyCellTrigger.displayName = "ProxyCellTrigger";

const PROFILE_PROXY_PICKER_LIMIT = 100;

function matchesPickerQuery(query: string, values: Array<string | number>) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const searchable = values.join(" ").toLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function ProfileProxyPicker({
  profile,
  meta,
  effectiveProxyId,
  effectiveVpnId,
  effectiveProxy,
  effectiveVpn,
}: {
  profile: BrowserProfile;
  meta: TableMeta;
  effectiveProxyId: string | null;
  effectiveVpnId: string | null;
  effectiveProxy: StoredProxy | null;
  effectiveVpn: VpnConfig | null;
}) {
  const [query, setQuery] = React.useState("");
  const matchingProxies = React.useMemo(
    () =>
      meta.storedProxies.filter((proxy) => {
        if (proxy.is_cloud_managed || proxy.is_cloud_derived) return false;
        const settings = proxy.proxy_settings;
        return matchesPickerQuery(query, [
          proxy.name,
          settings.proxy_type,
          settings.host,
          settings.port,
          settings.username ?? "",
          proxy.geo_country ?? "",
          proxy.geo_region ?? "",
          proxy.geo_city ?? "",
          proxy.geo_isp ?? "",
        ]);
      }),
    [meta.storedProxies, query],
  );
  const matchingVpns = React.useMemo(
    () =>
      meta.vpnConfigs.filter((vpn) =>
        matchesPickerQuery(query, [vpn.name, "vpn", "wireguard", "wg"]),
      ),
    [meta.vpnConfigs, query],
  );
  const visibleProxies = matchingProxies.slice(0, PROFILE_PROXY_PICKER_LIMIT);
  const visibleVpns = matchingVpns.slice(0, PROFILE_PROXY_PICKER_LIMIT);
  const totalMatches = matchingProxies.length + matchingVpns.length;
  const shownMatches = visibleProxies.length + visibleVpns.length;

  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={
          meta.canCreateLocationProxy
            ? meta.t("createProfile.proxy.searchWithCountries")
            : meta.t("createProfile.proxy.search")
        }
        onFocus={() => {
          if (meta.canCreateLocationProxy) void meta.loadCountries();
        }}
      />
      <CommandList>
        <CommandGroup>
          {effectiveProxy && !effectiveVpn && (
            <CommandItem
              value="__edit_assigned_proxy__"
              onSelect={() => {
                meta.setOpenProxySelectorFor(null);
                meta.onEditProxy(effectiveProxy);
              }}
            >
              <LuPencil className="mr-2 size-4" />
              <span className="min-w-0 truncate">
                {meta.t("profileTable.editAssignedProxy", {
                  name: effectiveProxy.name,
                })}
              </span>
            </CommandItem>
          )}
          <CommandItem
            value="__none__"
            onSelect={() => void meta.handleProxySelection(profile.id, null)}
          >
            <LuCheck
              className={cn(
                "mr-2 size-4",
                effectiveProxyId === null && effectiveVpnId === null
                  ? "opacity-100"
                  : "opacity-0",
              )}
            />
            {meta.t("common.labels.none")}
          </CommandItem>
          {visibleProxies.map((proxy) => {
            const settings = proxy.proxy_settings;
            return (
              <CommandItem
                key={proxy.id}
                value={proxy.id}
                onSelect={() =>
                  void meta.handleProxySelection(profile.id, proxy.id)
                }
              >
                <LuCheck
                  className={cn(
                    "mr-2 size-4 shrink-0",
                    effectiveProxyId === proxy.id && !effectiveVpn
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{proxy.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {settings.proxy_type.toUpperCase()} · {settings.host}:
                    {settings.port}
                  </span>
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {visibleVpns.length > 0 && (
          <CommandGroup heading={meta.t("profileTable.vpnsHeading")}>
            {visibleVpns.map((vpn) => (
              <CommandItem
                key={vpn.id}
                value={vpn.id}
                onSelect={() =>
                  void meta.handleVpnSelection(profile.id, vpn.id)
                }
              >
                <LuCheck
                  className={cn(
                    "mr-2 size-4",
                    effectiveVpnId === vpn.id ? "opacity-100" : "opacity-0",
                  )}
                />
                <Badge
                  variant="outline"
                  className="mr-1 px-1 py-0 text-[10px] leading-tight"
                >
                  WG
                </Badge>
                <span className="truncate">{vpn.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {meta.canCreateLocationProxy && meta.countries.length > 0 && (
          <CommandGroup heading={meta.t("profileTable.createByCountryHeading")}>
            {meta.countries
              .filter(
                (country) =>
                  matchesPickerQuery(query, [country.name, country.code]) &&
                  !meta.storedProxies.some(
                    (proxy) =>
                      proxy.is_cloud_derived &&
                      proxy.geo_country === country.code,
                  ),
              )
              .slice(0, PROFILE_PROXY_PICKER_LIMIT)
              .map((country) => (
                <CommandItem
                  key={`country-${country.code}`}
                  value={`create-${country.code}`}
                  onSelect={() =>
                    void meta.handleCreateCountryProxy(profile.id, country)
                  }
                >
                  <span className="mr-2 size-4" />+ {country.name}
                </CommandItem>
              ))}
          </CommandGroup>
        )}
        {totalMatches === 0 && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {meta.t("createProfile.proxy.notFound")}
          </div>
        )}
        {shownMatches < totalMatches && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {meta.t("profileTable.proxyPickerLimited", {
              shown: shownMatches,
              total: totalMatches,
            })}
          </div>
        )}
      </CommandList>
    </Command>
  );
}

const NoteCell = React.memo<{
  profile: BrowserProfile;
  isDisabled: boolean;
  noteOverrides: Record<string, string | null>;
  openNoteEditorFor: string | null;
  setOpenNoteEditorFor: React.Dispatch<React.SetStateAction<string | null>>;
  setNoteOverrides: React.Dispatch<
    React.SetStateAction<Record<string, string | null>>
  >;
}>(
  ({
    profile,
    isDisabled,
    noteOverrides,
    openNoteEditorFor,
    setOpenNoteEditorFor,
    setNoteOverrides,
  }) => {
    const { t } = useTranslation();
    const effectiveNote: string | null = Object.hasOwn(
      noteOverrides,
      profile.id,
    )
      ? noteOverrides[profile.id]
      : (profile.note ?? null);

    const onNoteChange = React.useCallback(
      async (newNote: string | null) => {
        const trimmedNote = newNote?.trim() ?? null;
        setNoteOverrides((prev) => ({ ...prev, [profile.id]: trimmedNote }));
        try {
          await invoke<BrowserProfile>("update_profile_note", {
            profileId: profile.id,
            note: trimmedNote,
          });
        } catch (error) {
          console.error("Failed to update note:", error);
        }
      },
      [profile.id, setNoteOverrides],
    );

    const editorRef = React.useRef<HTMLDivElement | null>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [noteValue, setNoteValue] = React.useState(effectiveNote ?? "");

    // Update local state when effective note changes (from outside)
    React.useEffect(() => {
      if (openNoteEditorFor !== profile.id) {
        setNoteValue(effectiveNote ?? "");
      }
    }, [effectiveNote, openNoteEditorFor, profile.id]);

    // Auto-resize textarea on open
    React.useEffect(() => {
      if (openNoteEditorFor === profile.id && textareaRef.current) {
        const textarea = textareaRef.current;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      }
    }, [openNoteEditorFor, profile.id]);

    const handleTextareaChange = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        setNoteValue(newValue);
        // Auto-resize
        const textarea = e.target;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      },
      [],
    );

    React.useEffect(() => {
      if (openNoteEditorFor !== profile.id) return;
      const handleClick = (e: MouseEvent) => {
        const target = e.target as Node | null;
        if (
          editorRef.current &&
          target &&
          !editorRef.current.contains(target)
        ) {
          const currentValue = textareaRef.current?.value ?? "";
          void onNoteChange(currentValue);
          setOpenNoteEditorFor(null);
        }
      };
      document.addEventListener("mousedown", handleClick);
      return () => {
        document.removeEventListener("mousedown", handleClick);
      };
    }, [openNoteEditorFor, profile.id, setOpenNoteEditorFor, onNoteChange]);

    React.useEffect(() => {
      if (openNoteEditorFor === profile.id && textareaRef.current) {
        textareaRef.current.focus();
        // Move cursor to end
        const len = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(len, len);
      }
    }, [openNoteEditorFor, profile.id]);

    const displayNote = effectiveNote ?? "";
    const showTooltip = displayNote.length > 0;

    if (openNoteEditorFor !== profile.id) {
      return (
        <div className="min-h-6 w-full">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex min-h-6 w-full min-w-0 items-center rounded border-none bg-transparent px-2 py-1 text-left",
                  isDisabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:bg-accent/50",
                )}
                onClick={() => {
                  if (!isDisabled) {
                    setNoteValue(effectiveNote ?? "");
                    setOpenNoteEditorFor(profile.id);
                  }
                }}
              >
                <span
                  className={cn(
                    "block w-full truncate text-sm",
                    !effectiveNote && "text-muted-foreground",
                  )}
                >
                  {effectiveNote ? displayNote : t("profiles.note.empty")}
                </span>
              </button>
            </TooltipTrigger>
            {showTooltip && (
              <TooltipContent className="max-w-[320px]">
                <p className="wrap-break-word whitespace-pre-wrap">
                  {effectiveNote ?? t("profiles.note.empty")}
                </p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "relative w-full",
          isDisabled && "pointer-events-none opacity-60",
        )}
      >
        <div
          ref={editorRef}
          className="absolute top-[-15px] -left-px z-50 min-h-6 w-60 rounded-md border bg-popover shadow-md"
        >
          <textarea
            ref={textareaRef}
            value={noteValue}
            onChange={handleTextareaChange}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setNoteValue(effectiveNote ?? "");
                setOpenNoteEditorFor(null);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void onNoteChange(noteValue);
                setOpenNoteEditorFor(null);
              }
            }}
            onBlur={() => {
              void onNoteChange(noteValue);
              setOpenNoteEditorFor(null);
            }}
            placeholder={t("profiles.note.placeholder")}
            className="max-h-[200px] min-h-6 w-full resize-none border-0 bg-transparent px-2 py-1 text-sm focus:ring-0 focus:outline-none"
            style={{
              overflow: "auto",
            }}
            rows={1}
          />
        </div>
      </div>
    );
  },
);

NoteCell.displayName = "NoteCell";

interface ProfilesDataTableProps {
  profiles: BrowserProfile[];
  allProfiles: BrowserProfile[];
  groups: GroupWithCount[];
  onLaunchProfile: (profile: BrowserProfile) => void | Promise<void>;
  onKillProfile: (profile: BrowserProfile) => void | Promise<void>;
  onCloneProfile: (profile: BrowserProfile) => void | Promise<void>;
  onDeleteProfile: (profile: BrowserProfile) => void | Promise<void>;
  onRenameProfile: (profileId: string, newName: string) => Promise<void>;
  onConfigureWayfern: (profile: BrowserProfile) => void;
  onCopyCookiesToProfile?: (profile: BrowserProfile) => void;
  onOpenCookieManagement?: (profile: BrowserProfile) => void;
  runningProfiles: Set<string>;
  isUpdating: (browser: string) => boolean;
  onDeleteSelectedProfiles: (profileIds: string[]) => Promise<void>;
  onAssignProfilesToGroup: (profileIds: string[]) => void;
  onAssignProfilesToProxy: (profileIds: string[]) => void;
  onCopyCookiesToProfiles: (profileIds: string[]) => void;
  onCreateProfileInGroup: (groupId: string | null) => void;
  onGroupDeleted: (groupId: string) => void;
  onRunProfiles: (profileIds: string[]) => void;
  onStopProfiles: (profileIds: string[]) => void;
  selectedGroupId: string | null;
  isFiltering?: boolean;
  selectedProfiles: string[];
  onSelectedProfilesChange: Dispatch<SetStateAction<string[]>>;
  onBulkDelete?: () => void;
  onBulkGroupAssignment?: () => void;
  onBulkProxyAssignment?: () => void;
  onBulkCopyCookies?: () => void;
  onBulkRun?: () => void;
  onBulkStop?: () => void;
  onBulkExtensionGroupAssignment?: () => void;
  onAssignExtensionGroup?: (profileIds: string[]) => void;
  onOpenProfileSyncDialog?: (profile: BrowserProfile) => void;
  onToggleProfileSync?: (profile: BrowserProfile) => void;
  getProfileSyncInfo?: (profileId: string) =>
    | {
        session: SyncSessionInfo;
        isLeader: boolean;
        failedAtUrl: string | null;
      }
    | undefined;
  onLaunchWithSync?: (profile: BrowserProfile) => void;
  onSetPassword?: (profile: BrowserProfile) => void;
  onChangePassword?: (profile: BrowserProfile) => void;
  onRemovePassword?: (profile: BrowserProfile) => void;
  /**
   * When provided, the info dialog is controlled by the parent. Allows the
   * command palette in page.tsx to open the dialog directly without lifting
   * every other piece of internal table state.
   */
  infoDialogProfile?: BrowserProfile | null;
  onInfoDialogProfileChange?: (profile: BrowserProfile | null) => void;
}

const COLLAPSED_PROFILE_GROUPS_KEY = "donut.profile-groups.collapsed";
const UNGROUPED_PROFILE_GROUP_KEY = "__ungrouped__";

interface ProfileFolderDisplayItem {
  type: "folder";
  key: string;
  name: string;
  group: GroupWithCount | null;
  rows: Row<BrowserProfile>[];
  profileIds: string[];
}

interface ProfileRowDisplayItem {
  type: "profile";
  key: string;
  row: Row<BrowserProfile>;
}

type ProfileDisplayItem = ProfileFolderDisplayItem | ProfileRowDisplayItem;

export function ProfilesDataTable({
  profiles,
  allProfiles,
  groups,
  onLaunchProfile,
  onKillProfile,
  onCloneProfile,
  onDeleteProfile,
  onRenameProfile,
  onConfigureWayfern,
  onCopyCookiesToProfile,
  onOpenCookieManagement,
  runningProfiles,
  isUpdating,
  onAssignProfilesToGroup,
  onAssignProfilesToProxy,
  onCopyCookiesToProfiles,
  onCreateProfileInGroup,
  onGroupDeleted,
  onRunProfiles,
  onStopProfiles,
  selectedGroupId,
  isFiltering = false,
  selectedProfiles,
  onSelectedProfilesChange,
  onBulkDelete,
  onBulkGroupAssignment,
  onBulkProxyAssignment,
  onBulkCopyCookies,
  onBulkRun,
  onBulkStop,
  onBulkExtensionGroupAssignment,
  onAssignExtensionGroup,
  onOpenProfileSyncDialog,
  onToggleProfileSync,
  getProfileSyncInfo,
  onLaunchWithSync,
  onSetPassword,
  onChangePassword,
  onRemovePassword,
  infoDialogProfile,
  onInfoDialogProfileChange,
}: ProfilesDataTableProps) {
  const { t } = useTranslation();
  const { getTableSorting, updateSorting, isLoaded } = useTableSorting();
  const [sorting, setSorting] = React.useState<SortingState>([]);

  // Sync external selectedProfiles with table's row selection state
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const prevSelectedProfilesRef = React.useRef<string[]>(selectedProfiles);

  // Update row selection when external selectedProfiles changes
  React.useEffect(() => {
    // Only update if selectedProfiles actually changed
    if (
      prevSelectedProfilesRef.current.length !== selectedProfiles.length ||
      !prevSelectedProfilesRef.current.every((id) =>
        selectedProfiles.includes(id),
      )
    ) {
      const newSelection: RowSelectionState = {};
      for (const profileId of selectedProfiles) {
        newSelection[profileId] = true;
      }
      setRowSelection(newSelection);
      prevSelectedProfilesRef.current = selectedProfiles;
      // When the parent clears the selection (e.g. after a bulk action like
      // delete / move-to-group), collapse the checkbox column back to icons.
      // Otherwise the row checkboxes stay visible and only revert after the
      // user clicks one — which the per-checkbox handler resets.
      if (selectedProfiles.length === 0) {
        setShowCheckboxes(false);
      }
    }
  }, [selectedProfiles]);

  // Update external selectedProfiles when table selection changes
  const handleRowSelectionChange = React.useCallback(
    (updater: React.SetStateAction<RowSelectionState>) => {
      setRowSelection((prevSelection) => {
        const newSelection =
          typeof updater === "function" ? updater(prevSelection) : updater;

        const selectedIds = Object.keys(newSelection).filter(
          (id) => newSelection[id],
        );

        // Only update external state if selection actually changed.
        // A Set gives O(1) membership; Array.includes() inside .every() would
        // be O(n*m) over large selections.
        const prevIdSet = new Set(
          Object.keys(prevSelection).filter((id) => prevSelection[id]),
        );

        if (
          selectedIds.length !== prevIdSet.size ||
          !selectedIds.every((id) => prevIdSet.has(id))
        ) {
          onSelectedProfilesChange(selectedIds);
        }

        return newSelection;
      });
    },
    [onSelectedProfilesChange],
  );
  const [profileToRename, setProfileToRename] =
    React.useState<BrowserProfile | null>(null);
  const [newProfileName, setNewProfileName] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [isRenamingSaving, setIsRenamingSaving] = React.useState(false);
  const renameContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [profileToDelete, setProfileToDelete] =
    React.useState<BrowserProfile | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [internalInfoDialogProfile, setInternalInfoDialogProfile] =
    React.useState<BrowserProfile | null>(null);
  const isInfoDialogControlled = onInfoDialogProfileChange !== undefined;
  const profileForInfoDialog = isInfoDialogControlled
    ? (infoDialogProfile ?? null)
    : internalInfoDialogProfile;
  const setProfileForInfoDialog = React.useCallback(
    (p: BrowserProfile | null) => {
      if (isInfoDialogControlled) {
        onInfoDialogProfileChange?.(p);
      } else {
        setInternalInfoDialogProfile(p);
      }
    },
    [isInfoDialogControlled, onInfoDialogProfileChange],
  );
  const [bypassRulesProfile, setBypassRulesProfile] =
    React.useState<BrowserProfile | null>(null);
  const [dnsBlocklistProfile, setDnsBlocklistProfile] =
    React.useState<BrowserProfile | null>(null);
  const [launchHookProfile, setLaunchHookProfile] =
    React.useState<BrowserProfile | null>(null);
  const [launchingProfiles, setLaunchingProfiles] = React.useState<Set<string>>(
    new Set(),
  );
  const [stoppingProfiles, setStoppingProfiles] = React.useState<Set<string>>(
    new Set(),
  );

  const { storedProxies } = useProxyEvents();
  const { vpnConfigs } = useVpnEvents();
  const { user } = useCloudAuth();
  const { isProfileLocked, getLockInfo } = useTeamLocks(user?.id);

  const [proxyOverrides, setProxyOverrides] = React.useState<
    Record<string, string | null>
  >({});
  const [vpnOverrides, setVpnOverrides] = React.useState<
    Record<string, string | null>
  >({});
  const [showCheckboxes, setShowCheckboxes] = React.useState(false);
  const [collapsedGroupIds, setCollapsedGroupIds] = React.useState<Set<string>>(
    new Set(),
  );
  const [collapsedGroupsLoaded, setCollapsedGroupsLoaded] =
    React.useState(false);
  const [renamingGroupId, setRenamingGroupId] = React.useState<string | null>(
    null,
  );
  const [groupNameDraft, setGroupNameDraft] = React.useState("");
  const [groupToDelete, setGroupToDelete] =
    React.useState<GroupWithCount | null>(null);
  const [togglingGroupSyncId, setTogglingGroupSyncId] = React.useState<
    string | null
  >(null);
  const groupRenameSubmittingRef = React.useRef(false);
  const groupRenameCancelingRef = React.useRef(false);
  const [tagsOverrides, setTagsOverrides] = React.useState<
    Record<string, string[]>
  >({});
  const [allTags, setAllTags] = React.useState<string[]>([]);
  const [openTagsEditorFor, setOpenTagsEditorFor] = React.useState<
    string | null
  >(null);
  const [openProxySelectorFor, setOpenProxySelectorFor] = React.useState<
    string | null
  >(null);
  const [editingProxy, setEditingProxy] = React.useState<StoredProxy | null>(
    null,
  );

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSED_PROFILE_GROUPS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) {
          setCollapsedGroupIds(
            new Set(
              parsed.filter(
                (value): value is string => typeof value === "string",
              ),
            ),
          );
        }
      }
    } catch (error) {
      console.error("Failed to restore collapsed profile groups:", error);
    } finally {
      setCollapsedGroupsLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    if (!collapsedGroupsLoaded) return;
    try {
      window.localStorage.setItem(
        COLLAPSED_PROFILE_GROUPS_KEY,
        JSON.stringify(Array.from(collapsedGroupIds)),
      );
    } catch (error) {
      console.error("Failed to save collapsed profile groups:", error);
    }
  }, [collapsedGroupIds, collapsedGroupsLoaded]);
  const [checkingProfileId, setCheckingProfileId] = React.useState<
    string | null
  >(null);
  const [proxyCheckResults, setProxyCheckResults] = React.useState<
    Record<string, ProxyCheckResult>
  >({});
  const [noteOverrides, setNoteOverrides] = React.useState<
    Record<string, string | null>
  >({});
  const [openNoteEditorFor, setOpenNoteEditorFor] = React.useState<
    string | null
  >(null);
  const [trafficSnapshots, setTrafficSnapshots] = React.useState<
    Record<string, TrafficSnapshot>
  >({});
  const [trafficDialogProfile, setTrafficDialogProfile] = React.useState<{
    id: string;
    name?: string;
  } | null>(null);
  const [syncStatuses, setSyncStatuses] = React.useState<
    Record<string, { status: string; error?: string }>
  >({});

  // Country proxy creation state (for inline proxy creation in dropdown)
  const [countries, setCountries] = React.useState<LocationItem[]>([]);
  const [countriesLoaded, setCountriesLoaded] = React.useState(false);

  // Extension groups for the Ext column lookup. Refreshed when the
  // backend emits 'extensions-changed' (group rename/create/delete).
  const [extensionGroups, setExtensionGroups] = React.useState<
    ExtensionGroup[]
  >([]);

  React.useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const load = async () => {
      try {
        const data = await invoke<ExtensionGroup[]>("list_extension_groups");
        if (mounted) setExtensionGroups(data);
      } catch (e) {
        console.error("Failed to load extension groups:", e);
      }
    };
    void load();
    void listen("extensions-changed", () => {
      void load();
    }).then((u) => {
      if (mounted) unlisten = u;
      else u();
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);
  const canCreateLocationProxy = false;

  const loadCountries = React.useCallback(async () => {
    if (countriesLoaded || !canCreateLocationProxy) return;
    try {
      const data = await invoke<LocationItem[]>("cloud_get_countries");
      setCountries(data);
      setCountriesLoaded(true);
    } catch (e) {
      console.error("Failed to load countries:", e);
    }
  }, [countriesLoaded]);

  // Load cached check results for proxies
  React.useEffect(() => {
    let cancelled = false;
    const proxyIds = Array.from(
      new Set(
        profiles
          .map((profile) => profile.proxy_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (proxyIds.length === 0) {
      setProxyCheckResults({});
      return;
    }

    void invoke<Record<string, ProxyCheckResult>>("get_cached_proxy_checks", {
      proxyIds,
    })
      .then((results) => {
        if (!cancelled) setProxyCheckResults(results);
      })
      .catch((error: unknown) => {
        console.error("Failed to load cached proxy checks:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [profiles]);

  const loadAllTags = React.useCallback(async () => {
    try {
      const tags = await invoke<string[]>("get_all_tags");
      setAllTags(tags);
    } catch (error) {
      console.error("Failed to load tags:", error);
    }
  }, []);

  const handleProxySelection = React.useCallback(
    async (profileId: string, proxyId: string | null) => {
      try {
        await invoke("update_profile_proxy", {
          profileId,
          proxyId,
        });
        setProxyOverrides((prev) => ({ ...prev, [profileId]: proxyId }));
        setVpnOverrides((prev) => ({ ...prev, [profileId]: null }));
        await emit("profile-updated");
      } catch (error) {
        console.error("Failed to update proxy settings:", error);
      } finally {
        setOpenProxySelectorFor(null);
      }
    },
    [],
  );

  const handleVpnSelection = React.useCallback(
    async (profileId: string, vpnId: string | null) => {
      try {
        await invoke("update_profile_vpn", {
          profileId,
          vpnId,
        });
        setVpnOverrides((prev) => ({ ...prev, [profileId]: vpnId }));
        setProxyOverrides((prev) => ({ ...prev, [profileId]: null }));
        await emit("profile-updated");
      } catch (error) {
        console.error("Failed to update VPN settings:", error);
      } finally {
        setOpenProxySelectorFor(null);
      }
    },
    [],
  );

  const handleCreateCountryProxy = React.useCallback(
    async (profileId: string, country: LocationItem) => {
      try {
        await invoke("create_cloud_location_proxy", {
          name: country.name,
          country: country.code,
          region: null,
          city: null,
          isp: null,
        });
        await emit("stored-proxies-changed");
        // Wait briefly for proxy list to update, then find and assign the new proxy
        await new Promise((r) => setTimeout(r, 200));
        const updatedProxies =
          await invoke<StoredProxy[]>("get_stored_proxies");
        const newProxy = updatedProxies.find(
          (p: StoredProxy) =>
            p.is_cloud_derived && p.geo_country === country.code,
        );
        if (newProxy) {
          await handleProxySelection(profileId, newProxy.id);
        }
        setOpenProxySelectorFor(null);
      } catch (error) {
        console.error("Failed to create country proxy:", error);
      }
    },
    [handleProxySelection],
  );

  // Use shared browser state hook
  const browserState = useBrowserState(
    profiles,
    runningProfiles,
    isUpdating,
    launchingProfiles,
    stoppingProfiles,
  );

  // Listen for sync status events
  React.useEffect(() => {
    if (!browserState.isClient) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<{
          profile_id: string;
          status: string;
          error?: string;
        }>("profile-sync-status", (event) => {
          const { profile_id, status, error } = event.payload;
          setSyncStatuses((prev) => ({
            ...prev,
            [profile_id]: { status, error },
          }));
        });
      } catch (error) {
        console.error("Failed to listen for sync status events:", error);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [browserState.isClient]);

  // Fetch traffic snapshots for running profiles (lightweight, real-time data)
  // Convert Set to sorted array to avoid Set reference comparison issues in dependencies
  const runningProfileIds = React.useMemo(
    () => Array.from(runningProfiles).sort(),
    [runningProfiles],
  );
  const runningCount = runningProfileIds.length;
  React.useEffect(() => {
    if (!browserState.isClient) return;

    if (runningCount === 0) {
      setTrafficSnapshots({});
      return;
    }

    const fetchTrafficSnapshots = async () => {
      try {
        const allSnapshots = await invoke<TrafficSnapshot[]>(
          "get_all_traffic_snapshots",
        );
        const newSnapshots: Record<string, TrafficSnapshot> = {};
        // O(1) membership; runningProfileIds.includes() in this loop would be
        // O(snapshots * runningProfiles).
        const runningSet = new Set(runningProfileIds);
        for (const snapshot of allSnapshots) {
          if (snapshot.profile_id) {
            // Only keep snapshots for profiles that are currently running
            if (runningSet.has(snapshot.profile_id)) {
              const existing = newSnapshots[snapshot.profile_id];
              if (!existing || snapshot.last_update > existing.last_update) {
                newSnapshots[snapshot.profile_id] = snapshot;
              }
            }
          }
        }
        setTrafficSnapshots(newSnapshots);
      } catch (error) {
        console.error("Failed to fetch traffic snapshots:", error);
      }
    };

    void fetchTrafficSnapshots();
    const interval = setInterval(() => {
      void fetchTrafficSnapshots();
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [browserState.isClient, runningCount, runningProfileIds]);

  // Clean up snapshots for profiles that are no longer running
  React.useEffect(() => {
    if (!browserState.isClient) return;

    setTrafficSnapshots((prev) => {
      const cleaned: Record<string, TrafficSnapshot> = {};
      const runningSet = new Set(runningProfileIds);
      for (const [profileId, snapshot] of Object.entries(prev)) {
        // Only keep snapshots for profiles that are currently running
        if (runningSet.has(profileId)) {
          cleaned[profileId] = snapshot;
        }
      }
      // Only update if something was removed
      if (Object.keys(cleaned).length !== Object.keys(prev).length) {
        return cleaned;
      }
      return prev;
    });
  }, [browserState.isClient, runningProfileIds]);

  // Clear launching/stopping spinners when backend reports running status changes
  React.useEffect(() => {
    if (!browserState.isClient) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<{ id: string; is_running: boolean }>(
          "profile-running-changed",
          (event) => {
            const { id } = event.payload;
            // Clear launching state for this profile if present
            setLaunchingProfiles((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            // Clear stopping state for this profile if present
            setStoppingProfiles((prev) => {
              if (!prev.has(id)) return prev;
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          },
        );
      } catch (error) {
        console.error("Failed to listen for profile running changes:", error);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [browserState.isClient]);

  // Keep stored proxies up-to-date by listening for changes emitted elsewhere in the app
  React.useEffect(() => {
    if (!browserState.isClient) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen("stored-proxies-changed", () => {
          // Also refresh tags on profile updates
          void loadAllTags();
        });
      } catch (_err) {
        // Best-effort only
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [browserState.isClient, loadAllTags]);

  // Automatically deselect profiles that become running, updating, launching, or stopping
  React.useEffect(() => {
    const newSet = new Set(selectedProfiles);
    let hasChanges = false;

    for (const profileId of selectedProfiles) {
      const profile = profiles.find((p) => p.id === profileId);
      if (profile) {
        const isRunning =
          browserState.isClient && runningProfiles.has(profile.id);
        const isLaunching = launchingProfiles.has(profile.id);
        const isStopping = stoppingProfiles.has(profile.id);

        if (isRunning || isLaunching || isStopping) {
          newSet.delete(profileId);
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      onSelectedProfilesChange(Array.from(newSet));
    }
  }, [
    profiles,
    runningProfiles,
    launchingProfiles,
    stoppingProfiles,
    browserState.isClient,
    onSelectedProfilesChange,
    selectedProfiles,
  ]);

  // Update local sorting state when settings are loaded
  React.useEffect(() => {
    if (isLoaded && browserState.isClient) {
      setSorting(getTableSorting());
    }
  }, [isLoaded, getTableSorting, browserState.isClient]);

  // Handle sorting changes
  const handleSortingChange = React.useCallback(
    (updater: React.SetStateAction<SortingState>) => {
      if (!browserState.isClient) return;
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);
      updateSorting(newSorting);
    },
    [browserState.isClient, sorting, updateSorting],
  );

  const handleRename = React.useCallback(async () => {
    if (!profileToRename || !newProfileName.trim()) return;

    try {
      setIsRenamingSaving(true);
      await onRenameProfile(profileToRename.id, newProfileName.trim());
      setProfileToRename(null);
      setNewProfileName("");
      setRenameError(null);
    } catch (error) {
      setRenameError(
        error instanceof Error
          ? error.message
          : t("errors.renameProfileFailed", { error: String(error) }),
      );
    } finally {
      setIsRenamingSaving(false);
    }
  }, [profileToRename, newProfileName, onRenameProfile, t]);

  const beginGroupRename = React.useCallback((group: GroupWithCount) => {
    groupRenameCancelingRef.current = false;
    setRenamingGroupId(group.id);
    setGroupNameDraft(group.name);
  }, []);

  const cancelGroupRename = React.useCallback(() => {
    groupRenameCancelingRef.current = true;
    setRenamingGroupId(null);
    setGroupNameDraft("");
  }, []);

  const submitGroupRename = React.useCallback(
    async (group: GroupWithCount) => {
      const name = groupNameDraft.trim();
      if (groupRenameCancelingRef.current) {
        groupRenameCancelingRef.current = false;
        return;
      }
      if (groupRenameSubmittingRef.current) return;
      if (!name || name === group.name) {
        cancelGroupRename();
        return;
      }

      groupRenameSubmittingRef.current = true;
      try {
        await invoke("update_profile_group", {
          groupId: group.id,
          name,
        });
        showSuccessToast(t("groups.updateSuccess"));
        cancelGroupRename();
      } catch (error) {
        showErrorToast(translateBackendError(t, error));
      } finally {
        groupRenameSubmittingRef.current = false;
      }
    },
    [cancelGroupRename, groupNameDraft, t],
  );

  const toggleGroupSync = React.useCallback(
    async (group: GroupWithCount) => {
      if (togglingGroupSyncId) return;
      const enabled = !group.sync_enabled;
      setTogglingGroupSyncId(group.id);
      try {
        await invoke("set_group_sync_enabled", {
          groupId: group.id,
          enabled,
        });
        showSuccessToast(
          t(enabled ? "groups.sync.enabled" : "groups.sync.disabled"),
        );
      } catch (error) {
        showErrorToast(translateBackendError(t, error));
      } finally {
        setTogglingGroupSyncId(null);
      }
    },
    [t, togglingGroupSyncId],
  );

  // Cancel inline rename on outside click
  React.useEffect(() => {
    if (!profileToRename) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        renameContainerRef.current &&
        !renameContainerRef.current.contains(target)
      ) {
        setProfileToRename(null);
        setNewProfileName("");
        setRenameError(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [profileToRename]);

  const handleDelete = async () => {
    if (!profileToDelete) return;

    setIsDeleting(true);
    // Minimum loading time for visual feedback
    const minLoadingTime = new Promise((r) => setTimeout(r, 300));
    try {
      await Promise.all([onDeleteProfile(profileToDelete), minLoadingTime]);
      setProfileToDelete(null);
    } catch (error) {
      console.error("Failed to delete profile:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle icon/checkbox click
  const handleIconClick = React.useCallback(
    (profileId: string) => {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;

      // Prevent selection of profiles whose browsers are updating
      if (!browserState.canSelectProfile(profile)) {
        return;
      }

      setShowCheckboxes(true);
      const newSet = new Set(selectedProfiles);
      if (newSet.has(profileId)) {
        newSet.delete(profileId);
      } else {
        newSet.add(profileId);
      }

      // Hide checkboxes if no profiles are selected
      if (newSet.size === 0) {
        setShowCheckboxes(false);
      }

      onSelectedProfilesChange(Array.from(newSet));
    },
    [profiles, browserState, onSelectedProfilesChange, selectedProfiles],
  );

  React.useEffect(() => {
    if (browserState.isClient) {
      void loadAllTags();
    }
  }, [browserState.isClient, loadAllTags]);

  // Handle checkbox change
  const handleCheckboxChange = React.useCallback(
    (profileId: string, checked: boolean) => {
      const newSet = new Set(selectedProfiles);
      if (checked) {
        newSet.add(profileId);
      } else {
        newSet.delete(profileId);
      }

      // Hide checkboxes if no profiles are selected
      if (newSet.size === 0) {
        setShowCheckboxes(false);
      }

      onSelectedProfilesChange(Array.from(newSet));
    },
    [onSelectedProfilesChange, selectedProfiles],
  );

  // Handle select all checkbox
  const handleToggleAll = React.useCallback(
    (checked: boolean) => {
      const newSet = checked
        ? new Set(
            profiles
              .filter((profile) => {
                const isRunning =
                  browserState.isClient && runningProfiles.has(profile.id);
                const isLaunching = launchingProfiles.has(profile.id);
                const isStopping = stoppingProfiles.has(profile.id);
                return !isRunning && !isLaunching && !isStopping;
              })
              .map((profile) => profile.id),
          )
        : new Set<string>();

      setShowCheckboxes(checked);
      onSelectedProfilesChange(Array.from(newSet));
    },
    [
      profiles,
      onSelectedProfilesChange,
      browserState.isClient,
      runningProfiles,
      launchingProfiles,
      stoppingProfiles,
    ],
  );

  // Memoize selectableProfiles calculation
  const selectableProfiles = React.useMemo(() => {
    return profiles.filter((profile) => {
      const isRunning =
        browserState.isClient && runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);
      return !isRunning && !isLaunching && !isStopping;
    });
  }, [
    profiles,
    browserState.isClient,
    runningProfiles,
    launchingProfiles,
    stoppingProfiles,
  ]);

  const selectableProfileIds = React.useMemo(
    () => new Set(selectableProfiles.map((profile) => profile.id)),
    [selectableProfiles],
  );

  const handleToggleFolderSelection = React.useCallback(
    (profileIds: string[], checked: boolean) => {
      const next = new Set(selectedProfiles);
      for (const profileId of profileIds) {
        if (!selectableProfileIds.has(profileId)) continue;
        if (checked) next.add(profileId);
        else next.delete(profileId);
      }
      setShowCheckboxes(next.size > 0);
      onSelectedProfilesChange(Array.from(next));
    },
    [onSelectedProfilesChange, selectableProfileIds, selectedProfiles],
  );

  const toggleFolder = React.useCallback((folderKey: string) => {
    setCollapsedGroupIds((previous) => {
      const next = new Set(previous);
      if (next.has(folderKey)) next.delete(folderKey);
      else next.add(folderKey);
      return next;
    });
  }, []);

  // Build table meta from volatile state so columns can stay stable
  const tableMeta = React.useMemo<TableMeta>(
    () => ({
      t,
      selectedProfiles,
      selectableCount: selectableProfiles.length,
      showCheckboxes,
      isClient: browserState.isClient,
      runningProfiles,
      launchingProfiles,
      stoppingProfiles,
      isUpdating,
      browserState,

      // Tags editor state
      tagsOverrides,
      allTags,
      openTagsEditorFor,
      setAllTags,
      setOpenTagsEditorFor,
      setTagsOverrides,

      // Note editor state
      noteOverrides,
      openNoteEditorFor,
      setOpenNoteEditorFor,
      setNoteOverrides,

      // Proxy selector state
      openProxySelectorFor,
      setOpenProxySelectorFor,
      proxyOverrides,
      storedProxies,
      handleProxySelection,
      checkingProfileId,
      proxyCheckResults,
      onEditProxy: (proxy: StoredProxy) => {
        setOpenProxySelectorFor(null);
        setEditingProxy(proxy);
      },

      // VPN selector state
      vpnConfigs,
      vpnOverrides,
      handleVpnSelection,

      // Extension groups
      extensionGroups,
      onAssignExtensionGroup,
      setDnsBlocklistProfile,

      // Selection helpers
      isProfileSelected: (id: string) => selectedProfiles.includes(id),
      handleToggleAll,
      handleCheckboxChange,
      handleIconClick,

      // Rename helpers
      handleRename,
      setProfileToRename,
      setNewProfileName,
      setRenameError,
      profileToRename,
      newProfileName,
      isRenamingSaving,
      renameError,

      // Launch/stop helpers
      setLaunchingProfiles,
      setStoppingProfiles,
      onKillProfile,
      onLaunchProfile,

      // Overflow actions
      onAssignProfilesToGroup,
      onCloneProfile: onCloneProfile
        ? (profile: BrowserProfile) => {
            void onCloneProfile(profile);
          }
        : undefined,
      onConfigureWayfern,
      onCopyCookiesToProfile,
      onOpenCookieManagement,

      // Traffic snapshots (lightweight real-time data)
      trafficSnapshots,
      onOpenTrafficDialog: (profileId: string) => {
        const profile = profiles.find((p) => p.id === profileId);
        setTrafficDialogProfile({ id: profileId, name: profile?.name });
      },

      // Sync
      syncStatuses,
      onOpenProfileSyncDialog,
      onToggleProfileSync,

      // Country proxy creation
      countries,
      canCreateLocationProxy,
      loadCountries,
      handleCreateCountryProxy,

      // Team locks
      isProfileLockedByAnother: isProfileLocked,
      getProfileLockEmail: (profileId: string) =>
        getLockInfo(profileId)?.lockedByEmail,

      // Synchronizer
      getProfileSyncInfo: getProfileSyncInfo ?? (() => undefined),
      onLaunchWithSync:
        onLaunchWithSync ??
        (() => {
          /* empty */
        }),
    }),
    [
      t,
      selectedProfiles,
      selectableProfiles.length,
      showCheckboxes,
      browserState.isClient,
      runningProfiles,
      launchingProfiles,
      stoppingProfiles,
      isUpdating,
      browserState,
      tagsOverrides,
      allTags,
      openTagsEditorFor,
      noteOverrides,
      openNoteEditorFor,
      openProxySelectorFor,
      proxyOverrides,
      storedProxies,
      handleProxySelection,
      checkingProfileId,
      proxyCheckResults,
      vpnConfigs,
      vpnOverrides,
      handleVpnSelection,
      extensionGroups,
      onAssignExtensionGroup,
      handleToggleAll,
      handleCheckboxChange,
      handleIconClick,
      handleRename,
      profileToRename,
      newProfileName,
      isRenamingSaving,
      trafficSnapshots,
      profiles,
      renameError,
      onKillProfile,
      onLaunchProfile,
      onAssignProfilesToGroup,
      onCloneProfile,
      onConfigureWayfern,
      onCopyCookiesToProfile,
      onOpenCookieManagement,
      syncStatuses,
      onOpenProfileSyncDialog,
      onToggleProfileSync,
      countries,
      loadCountries,
      handleCreateCountryProxy,
      isProfileLocked,
      getLockInfo,
      getProfileSyncInfo,
      onLaunchWithSync,
    ],
  );

  const columns: ColumnDef<BrowserProfile>[] = React.useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return (
            <span>
              <Checkbox
                checked={
                  meta.selectedProfiles.length === meta.selectableCount &&
                  meta.selectableCount !== 0
                }
                onCheckedChange={(value) => {
                  meta.handleToggleAll(!!value);
                }}
                aria-label={t("common.aria.selectAll")}
                className="cursor-pointer"
              />
            </span>
          );
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          const browser = profile.browser;
          const IconComponent = getProfileIcon(profile);
          const isCrossOs = isCrossOsProfile(profile);

          const isSelected = meta.isProfileSelected(profile.id);
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isDisabled = isRunning || isLaunching || isStopping;

          // Cross-OS profiles: show OS icon when checkboxes aren't visible, show checkbox when they are
          if (isCrossOs && !meta.showCheckboxes && !isSelected) {
            const resolvedOs = profile.host_os || profile.wayfern_config?.os;
            const osName = resolvedOs
              ? getOSDisplayName(resolvedOs)
              : "another OS";
            const crossOsTooltip = t("crossOs.viewOnly", { os: osName });
            const OsIcon =
              resolvedOs === "macos"
                ? FaApple
                : resolvedOs === "windows"
                  ? FaWindows
                  : FaLinux;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex size-4 items-center justify-center">
                    <button
                      type="button"
                      className="flex cursor-pointer items-center justify-center border-none p-0"
                      onClick={() => {
                        meta.handleIconClick(profile.id);
                      }}
                      aria-label={t("common.aria.selectProfile")}
                    >
                      <span className="group size-4">
                        <OsIcon className="size-4 text-muted-foreground group-hover:hidden" />
                        <span className="peer pointer-events-none hidden size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs transition-shadow duration-150 outline-none group-hover:block dark:bg-input/30 dark:data-[state=checked]:bg-primary" />
                      </span>
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{crossOsTooltip}</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          // Cross-OS profiles with checkboxes visible: show checkbox (selectable for bulk delete)
          if (isCrossOs && (meta.showCheckboxes || isSelected)) {
            const resolvedOs = profile.host_os || profile.wayfern_config?.os;
            const osName = resolvedOs
              ? getOSDisplayName(resolvedOs)
              : "another OS";
            const crossOsTooltip = t("crossOs.viewOnly", { os: osName });
            return (
              <NonHoverableTooltip
                content={<p>{crossOsTooltip}</p>}
                sideOffset={4}
                horizontalOffset={8}
              >
                <span className="flex size-4 items-center justify-center">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(value) => {
                      meta.handleCheckboxChange(profile.id, !!value);
                    }}
                    aria-label={t("common.aria.selectRow")}
                    className="size-4"
                  />
                </span>
              </NonHoverableTooltip>
            );
          }

          if (isDisabled) {
            const tooltipMessage = isRunning
              ? t("profiles.table.cantModifyRunning")
              : isLaunching
                ? t("profiles.table.cantModifyLaunching")
                : isStopping
                  ? t("profiles.table.cantModifyStopping")
                  : t("profiles.table.cantModifyUpdating");

            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex size-4 cursor-not-allowed items-center justify-center">
                    {IconComponent && (
                      <IconComponent className="size-4 opacity-50" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{tooltipMessage}</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          const browserName = getBrowserDisplayName(browser);

          if (meta.showCheckboxes || isSelected) {
            return (
              <NonHoverableTooltip
                content={<p>{browserName}</p>}
                sideOffset={4}
                horizontalOffset={8}
              >
                <span className="flex size-4 items-center justify-center">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(value) => {
                      meta.handleCheckboxChange(profile.id, !!value);
                    }}
                    aria-label={t("common.aria.selectRow")}
                    className="size-4"
                  />
                </span>
              </NonHoverableTooltip>
            );
          }

          return (
            <NonHoverableTooltip
              content={<p>{browserName}</p>}
              sideOffset={4}
              horizontalOffset={8}
            >
              <span className="relative flex size-4 items-center justify-center">
                <button
                  type="button"
                  className="flex cursor-pointer items-center justify-center border-none p-0"
                  onClick={() => {
                    meta.handleIconClick(profile.id);
                  }}
                  aria-label={t("common.aria.selectProfile")}
                >
                  <span className="group size-4">
                    {IconComponent && (
                      <IconComponent className="size-4 group-hover:hidden" />
                    )}
                    <span className="peer pointer-events-none hidden size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs transition-shadow duration-150 outline-none group-hover:block dark:bg-input/30 dark:data-[state=checked]:bg-primary" />
                  </span>
                </button>
              </span>
            </NonHoverableTooltip>
          );
        },
        enableSorting: false,
        enableHiding: false,
        size: PROFILE_TABLE_FIXED_WIDTHS.select,
      },
      {
        id: "actions",
        size: PROFILE_TABLE_FIXED_WIDTHS.actions,
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isLockedByAnother = meta.isProfileLockedByAnother(profile.id);
          const canLaunch =
            meta.browserState.canLaunchProfile(profile) && !isLockedByAnother;
          const lockEmail = meta.getProfileLockEmail(profile.id);
          const tooltipContent = isLockedByAnother
            ? meta.t("sync.team.cannotLaunchLocked", { email: lockEmail })
            : meta.browserState.getLaunchTooltipContent(profile);

          const handleProfileStop = async (profile: BrowserProfile) => {
            meta.setStoppingProfiles((prev: Set<string>) =>
              new Set(prev).add(profile.id),
            );
            try {
              await meta.onKillProfile(profile);
            } catch (error) {
              meta.setStoppingProfiles((prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(profile.id);
                return next;
              });
              throw error;
            }
          };

          const handleProfileLaunch = async (profile: BrowserProfile) => {
            meta.setLaunchingProfiles((prev: Set<string>) =>
              new Set(prev).add(profile.id),
            );
            try {
              await meta.onLaunchProfile(profile);
            } finally {
              // Always clear launching state — the running state is tracked
              // separately via profile-running-changed events
              meta.setLaunchingProfiles((prev: Set<string>) => {
                const next = new Set(prev);
                next.delete(profile.id);
                return next;
              });
            }
          };

          const syncInfo = meta.getProfileSyncInfo(profile.id);
          const isLeader = syncInfo?.isLeader === true;
          const isFollower = syncInfo?.isLeader === false;
          const isDesynced = isFollower && syncInfo.failedAtUrl != null;
          const stopTooltip = isLeader
            ? meta.t("profiles.synchronizer.stopLeader")
            : isFollower
              ? meta.t("profiles.synchronizer.stopFollower", {
                  leaderName: syncInfo.session.leader_profile_name ?? "",
                })
              : tooltipContent;

          const handleStop = async () => {
            if (isLeader && syncInfo) {
              // Stop leader: invoke stop_sync_session which kills leader + all followers
              try {
                await invoke("stop_sync_session", {
                  sessionId: syncInfo.session.id,
                });
              } catch (error) {
                console.error("Failed to stop sync session:", error);
              }
            } else if (isFollower && syncInfo) {
              // Stop follower: remove from session
              try {
                await invoke("remove_sync_follower", {
                  sessionId: syncInfo.session.id,
                  followerProfileId: profile.id,
                });
              } catch (error) {
                console.error("Failed to remove sync follower:", error);
              }
            } else {
              await handleProfileStop(profile);
            }
          };

          const buttonVariant = isRunning
            ? isFollower
              ? "secondary"
              : "destructive"
            : "default";

          return (
            <div className="flex items-center gap-2">
              {isDesynced && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <LuTriangleAlert className="size-4 text-warning" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {meta.t("profiles.synchronizer.desyncedTooltip", {
                      url: syncInfo?.failedAtUrl ?? "",
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <RippleButton
                      variant={buttonVariant}
                      size="sm"
                      disabled={!canLaunch || isLaunching || isStopping}
                      aria-label={
                        isRunning
                          ? meta.t("profiles.actions.stop")
                          : meta.t("profiles.actions.launch")
                      }
                      className={cn(
                        "grid size-7 place-items-center p-0",
                        !canLaunch && "cursor-not-allowed opacity-50",
                        canLaunch && "cursor-pointer",
                        isFollower && "border-accent",
                        isRunning &&
                          "bg-destructive/10 text-destructive hover:bg-destructive/20",
                      )}
                      onClick={() =>
                        isRunning
                          ? void handleStop()
                          : void handleProfileLaunch(profile)
                      }
                    >
                      {isLaunching || isStopping ? (
                        <div className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
                      ) : isRunning ? (
                        <LuSquare className="size-3.5 fill-current" />
                      ) : (
                        <LuPlay className="size-3.5 fill-current" />
                      )}
                    </RippleButton>
                  </span>
                </TooltipTrigger>
                {(stopTooltip || tooltipContent) && (
                  <TooltipContent>
                    {isRunning ? stopTooltip : tooltipContent}
                  </TooltipContent>
                )}
              </Tooltip>
            </div>
          );
        },
      },
      {
        // Hidden, sort-only column so profiles can be sorted by creation date
        // without showing a Created column in the table. Kept
        // hidden via columnVisibility; sorting still works on hidden columns.
        id: "created_at",
        accessorFn: (row) => row.created_at ?? 0,
        enableSorting: true,
        enableHiding: true,
        sortingFn: "basic",
        header: () => null,
        cell: () => null,
      },
      {
        accessorKey: "name",
        size: PROFILE_TABLE_FLEX_COLUMNS.name.min,
        // The Name header doubles as the sort control: clicking opens a menu to
        // sort by name (A–Z / Z–A) or by creation date (newest / oldest), so
        // creation-date sorting needs no visible column.
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          const sort = table.getState().sorting[0];
          const isActive = (id: string, desc: boolean) =>
            sort?.id === id && !!sort.desc === desc;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto cursor-pointer justify-start p-0 text-left font-semibold"
                >
                  {meta.t("common.labels.name")}
                  {isActive("name", false) ? (
                    <LuChevronUp className="ml-2 size-4" />
                  ) : isActive("name", true) ? (
                    <LuChevronDown className="ml-2 size-4" />
                  ) : (
                    <LuChevronDown className="ml-2 size-4 opacity-50" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() =>
                    table.setSorting([{ id: "name", desc: false }])
                  }
                >
                  {isActive("name", false) && (
                    <LuCheck className="mr-2 size-3.5" />
                  )}
                  {meta.t("profiles.sort.nameAsc")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => table.setSorting([{ id: "name", desc: true }])}
                >
                  {isActive("name", true) && (
                    <LuCheck className="mr-2 size-3.5" />
                  )}
                  {meta.t("profiles.sort.nameDesc")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    table.setSorting([{ id: "created_at", desc: true }])
                  }
                >
                  {isActive("created_at", true) && (
                    <LuCheck className="mr-2 size-3.5" />
                  )}
                  {meta.t("profiles.sort.newest")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    table.setSorting([{ id: "created_at", desc: false }])
                  }
                >
                  {isActive("created_at", false) && (
                    <LuCheck className="mr-2 size-3.5" />
                  )}
                  {meta.t("profiles.sort.oldest")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
        enableSorting: true,
        sortingFn: "alphanumeric",
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original as BrowserProfile;
          const rawName: string = row.getValue("name");
          const name = getBrowserDisplayName(rawName);
          const isEditing = meta.profileToRename?.id === profile.id;

          if (isEditing) {
            return (
              <div
                ref={renameContainerRef}
                className="relative overflow-visible"
              >
                <Input
                  autoFocus
                  value={meta.newProfileName}
                  onChange={(e) => {
                    meta.setNewProfileName(e.target.value);
                    if (meta.renameError) meta.setRenameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                      void meta.handleRename();
                    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      void meta.handleRename();
                    } else if (e.key === "Escape") {
                      meta.setProfileToRename(null);
                      meta.setNewProfileName("");
                      meta.setRenameError(null);
                    }
                  }}
                  onBlur={() => {
                    if (
                      meta.newProfileName.trim().length > 0 &&
                      meta.newProfileName.trim() !== profile.name
                    ) {
                      void meta.handleRename();
                    } else {
                      meta.setProfileToRename(null);
                      meta.setNewProfileName("");
                      meta.setRenameError(null);
                    }
                  }}
                  className="h-6 w-full max-w-full min-w-0 border-0 px-2 py-1 text-sm leading-none font-medium shadow-none focus-visible:ring-0"
                />
              </div>
            );
          }

          const display = (
            <OverflowTooltipText
              text={name}
              className="text-left leading-none font-medium"
            />
          );

          const isCrossOs = isCrossOsProfile(profile);
          const isCrossOsBlocked = isCrossOs;
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isDisabled =
            isRunning || isLaunching || isStopping || isCrossOsBlocked;
          const lockedEmail = meta.getProfileLockEmail(profile.id);
          const isLocked = meta.isProfileLockedByAnother(profile.id);

          return (
            <div className="flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden">
              <button
                type="button"
                className={cn(
                  "mr-auto h-6 max-w-full min-w-0 overflow-hidden rounded border-none bg-transparent px-2 py-1 text-left",
                  isDisabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:bg-accent/50",
                )}
                onClick={() => {
                  if (isDisabled) return;
                  meta.setProfileToRename(profile);
                  meta.setNewProfileName(profile.name);
                  meta.setRenameError(null);
                }}
                onKeyDown={(e) => {
                  if (isDisabled) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    meta.setProfileToRename(profile);
                    meta.setNewProfileName(profile.name);
                    meta.setRenameError(null);
                  }
                }}
              >
                {display}
              </button>
              {isLocked && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <LuLock className="size-3 text-muted-foreground" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {meta.t("sync.team.profileLocked", { email: lockedEmail })}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        },
      },
      {
        id: "tags",
        size: PROFILE_TABLE_FLEX_COLUMNS.tags.min,
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return meta.t("profileTable.tagsHeader");
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          const isCrossOs = isCrossOsProfile(profile);
          const isCrossOsBlocked = isCrossOs;
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isDisabled =
            isRunning || isLaunching || isStopping || isCrossOsBlocked;

          return (
            <TagsCell
              profile={profile}
              isDisabled={isDisabled}
              tagsOverrides={meta.tagsOverrides ?? {}}
              allTags={meta.allTags ?? []}
              setAllTags={meta.setAllTags}
              openTagsEditorFor={meta.openTagsEditorFor ?? null}
              setOpenTagsEditorFor={meta.setOpenTagsEditorFor}
              setTagsOverrides={meta.setTagsOverrides}
            />
          );
        },
      },
      {
        id: "note",
        size: PROFILE_TABLE_FLEX_COLUMNS.note.min,
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return meta.t("profileTable.noteHeader");
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          const isCrossOs = isCrossOsProfile(profile);
          const isCrossOsBlocked = isCrossOs;
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isDisabled =
            isRunning || isLaunching || isStopping || isCrossOsBlocked;

          return (
            <NoteCell
              profile={profile}
              isDisabled={isDisabled}
              noteOverrides={meta.noteOverrides ?? {}}
              openNoteEditorFor={meta.openNoteEditorFor ?? null}
              setOpenNoteEditorFor={meta.setOpenNoteEditorFor}
              setNoteOverrides={meta.setNoteOverrides}
            />
          );
        },
      },
      {
        id: "proxy",
        size: PROFILE_TABLE_FLEX_COLUMNS.proxy.min,
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return meta.t("profiles.table.proxy");
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          const isCrossOs = isCrossOsProfile(profile);
          const isCrossOsBlocked = isCrossOs;
          const isRunning =
            meta.isClient && meta.runningProfiles.has(profile.id);
          const isLaunching = meta.launchingProfiles.has(profile.id);
          const isStopping = meta.stoppingProfiles.has(profile.id);
          const isDisabled =
            isRunning || isLaunching || isStopping || isCrossOsBlocked;

          const hasProxyOverride = Object.hasOwn(
            meta.proxyOverrides,
            profile.id,
          );
          const effectiveProxyId = hasProxyOverride
            ? meta.proxyOverrides[profile.id]
            : (profile.proxy_id ?? null);
          const effectiveProxy = effectiveProxyId
            ? (meta.storedProxies.find((p) => p.id === effectiveProxyId) ??
              null)
            : null;

          const hasVpnOverride = Object.hasOwn(meta.vpnOverrides, profile.id);
          const effectiveVpnId = hasVpnOverride
            ? meta.vpnOverrides[profile.id]
            : (profile.vpn_id ?? null);
          const effectiveVpn = effectiveVpnId
            ? (meta.vpnConfigs.find((v) => v.id === effectiveVpnId) ?? null)
            : null;

          const hasAssignment = Boolean(effectiveProxy || effectiveVpn);
          const displayName = effectiveVpn
            ? effectiveVpn.name
            : effectiveProxy
              ? effectiveProxy.name
              : meta.t("profiles.table.notSelected");
          const vpnBadge = effectiveVpn ? "WG" : null;
          const isSelectorOpen = meta.openProxySelectorFor === profile.id;

          // When profile is running, show bandwidth chart instead of proxy selector
          if (isRunning && meta.trafficSnapshots) {
            const snapshot = meta.trafficSnapshots[profile.id];
            const bandwidthData = snapshot?.recent_bandwidth
              ? [...snapshot.recent_bandwidth]
              : [];
            const currentBandwidth =
              (snapshot?.current_bytes_sent ?? 0) +
              (snapshot?.current_bytes_received ?? 0);

            return (
              <div className="min-w-0 overflow-hidden">
                <BandwidthMiniChart
                  key={`${profile.id}-${snapshot?.last_update ?? 0}-${bandwidthData.length}`}
                  data={bandwidthData}
                  currentBandwidth={currentBandwidth}
                  onClick={() => meta.onOpenTrafficDialog?.(profile.id)}
                />
              </div>
            );
          }

          return (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <Popover
                open={isSelectorOpen}
                onOpenChange={(open) => {
                  meta.setOpenProxySelectorFor(open ? profile.id : null);
                }}
              >
                <ProxyCellTrigger
                  displayName={displayName}
                  hasAssignment={hasAssignment}
                  vpnBadge={vpnBadge}
                  isDisabled={isDisabled}
                />

                {!isDisabled && (
                  <PopoverContent
                    className="w-[320px] p-0"
                    align="end"
                    sideOffset={8}
                  >
                    <ProfileProxyPicker
                      profile={profile}
                      meta={meta}
                      effectiveProxyId={effectiveProxyId}
                      effectiveVpnId={effectiveVpnId}
                      effectiveProxy={effectiveProxy}
                      effectiveVpn={effectiveVpn}
                    />
                  </PopoverContent>
                )}
              </Popover>
              {effectiveProxy && !effectiveVpn && !isDisabled && (
                <div className="flex shrink-0 items-center">
                  <ProxyCheckButton
                    proxy={effectiveProxy}
                    profileId={profile.id}
                    checkingProfileId={meta.checkingProfileId}
                    cachedResult={meta.proxyCheckResults[effectiveProxy.id]}
                    setCheckingProfileId={setCheckingProfileId}
                    onCheckComplete={(result) => {
                      setProxyCheckResults((prev) => ({
                        ...prev,
                        [effectiveProxy.id]: result,
                      }));
                    }}
                    onCheckFailed={(result) => {
                      setProxyCheckResults((prev) => ({
                        ...prev,
                        [effectiveProxy.id]: result,
                      }));
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => {
                          meta.onEditProxy(effectiveProxy);
                        }}
                        aria-label={meta.t("profileTable.editAssignedProxy", {
                          name: effectiveProxy.name,
                        })}
                      >
                        <LuPencil className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {meta.t("profileTable.editAssignedProxy", {
                        name: effectiveProxy.name,
                      })}
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "ext",
        size: PROFILE_TABLE_FLEX_COLUMNS.ext.min,
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return meta.t("profiles.table.ext");
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          return <ExtCell profile={profile} meta={meta} />;
        },
      },
      {
        id: "dns",
        size: PROFILE_TABLE_FLEX_COLUMNS.dns.min,
        header: ({ table }) => {
          const meta = table.options.meta as TableMeta;
          return meta.t("profiles.table.dns");
        },
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;
          return <DnsCell profile={profile} meta={meta} />;
        },
      },
      {
        id: "sync",
        header: "",
        size: PROFILE_TABLE_FIXED_WIDTHS.sync,
        cell: ({ row, table }) => {
          const profile = row.original;
          const meta = table.options.meta as TableMeta;
          const syncEntry = meta.syncStatuses[profile.id];
          const liveStatus = syncEntry?.status as
            | "syncing"
            | "waiting"
            | "synced"
            | "error"
            | "disabled"
            | undefined;

          const dot = getProfileSyncStatusDot(
            profile,
            liveStatus,
            meta.t,
            syncEntry?.error,
          );
          if (!dot) return null;

          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex h-9 w-full items-center justify-center">
                  {dot.encrypted ? (
                    <LuLock
                      className={`size-3 ${dot.color.replace("bg-", "text-")}${dot.animate ? " animate-pulse" : ""}`}
                    />
                  ) : (
                    <span
                      className={`size-2 rounded-full ${dot.color}${dot.animate ? " animate-pulse" : ""}`}
                    />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent>{dot.tooltip}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "settings",
        size: PROFILE_TABLE_FIXED_WIDTHS.settings,
        cell: ({ row, table }) => {
          const meta = table.options.meta as TableMeta;
          const profile = row.original;

          return (
            <div className="flex h-9 w-full items-center justify-end">
              <Button
                variant="ghost"
                className="size-7 p-0"
                disabled={!meta.isClient}
                onClick={() => {
                  setProfileForInfoDialog(profile);
                }}
              >
                <span className="sr-only">
                  {t("profiles.aria.profileInfo")}
                </span>
                <LuInfo className="size-4" />
              </Button>
            </div>
          );
        },
      },
    ],
    [t, setProfileForInfoDialog],
  );

  // Optional columns appear only when their minimum width plus breathing room
  // is available. A small hysteresis keeps them from flickering at a resize
  // boundary while their data remains available in profile info.
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>(() => getProfileTableColumnVisibility(0));
  const [containerWidth, setContainerWidth] = React.useState(0);

  const table = useReactTable({
    data: profiles,
    columns,
    state: {
      sorting,
      rowSelection,
      columnVisibility,
    },
    onSortingChange: handleSortingChange,
    onRowSelectionChange: handleRowSelectionChange,
    enableRowSelection: (row) => {
      const profile = row.original;
      const isRunning =
        browserState.isClient && runningProfiles.has(profile.id);
      const isLaunching = launchingProfiles.has(profile.id);
      const isStopping = stoppingProfiles.has(profile.id);
      return !isRunning && !isLaunching && !isStopping;
    },
    getSortedRowModel: getSortedRowModel(),
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    meta: tableMeta,
  });

  const scrollParentRef = React.useRef<HTMLDivElement | null>(null);
  const columnWidths = React.useMemo(
    () => getProfileTableColumnWidths(containerWidth, columnVisibility),
    [containerWidth, columnVisibility],
  );
  const sortedRows = table.getRowModel().rows;
  const displayItems = React.useMemo<ProfileDisplayItem[]>(() => {
    const rowsByGroup = new Map<string, Row<BrowserProfile>[]>();
    const knownGroupIds = new Set(groups.map((group) => group.id));

    for (const row of sortedRows) {
      const profileGroupId = row.original.group_id;
      const groupKey =
        profileGroupId && knownGroupIds.has(profileGroupId)
          ? profileGroupId
          : UNGROUPED_PROFILE_GROUP_KEY;
      const rows = rowsByGroup.get(groupKey) ?? [];
      rows.push(row);
      rowsByGroup.set(groupKey, rows);
    }

    const folders: ProfileFolderDisplayItem[] = [];
    if (selectedGroupId && selectedGroupId !== "__all__") {
      const isUngrouped = selectedGroupId === UNGROUPED_PROFILE_GROUP_KEY;
      const group = isUngrouped
        ? undefined
        : groups.find((item) => item.id === selectedGroupId);
      const rows = sortedRows;
      if (!isFiltering || rows.length > 0) {
        folders.push({
          type: "folder",
          key: selectedGroupId,
          name: isUngrouped
            ? t("groups.noGroup")
            : (group?.name ?? t("groups.unknownGroup")),
          group: group ?? null,
          rows,
          profileIds: allProfiles
            .filter((profile) =>
              isUngrouped
                ? !profile.group_id || !knownGroupIds.has(profile.group_id)
                : profile.group_id === selectedGroupId,
            )
            .map((profile) => profile.id),
        });
      }
    } else {
      for (const group of groups) {
        const rows = rowsByGroup.get(group.id) ?? [];
        if (!isFiltering || rows.length > 0) {
          folders.push({
            type: "folder",
            key: group.id,
            name: group.name,
            group,
            rows,
            profileIds: allProfiles
              .filter((profile) => profile.group_id === group.id)
              .map((profile) => profile.id),
          });
        }
      }

      const ungroupedRows = rowsByGroup.get(UNGROUPED_PROFILE_GROUP_KEY) ?? [];
      if (ungroupedRows.length > 0) {
        folders.push({
          type: "folder",
          key: UNGROUPED_PROFILE_GROUP_KEY,
          name: t("groups.noGroup"),
          group: null,
          rows: ungroupedRows,
          profileIds: allProfiles
            .filter(
              (profile) =>
                !profile.group_id || !knownGroupIds.has(profile.group_id),
            )
            .map((profile) => profile.id),
        });
      }
    }

    return folders.flatMap((folder) => {
      const items: ProfileDisplayItem[] = [folder];
      if (!collapsedGroupIds.has(folder.key)) {
        items.push(
          ...folder.rows.map(
            (row): ProfileRowDisplayItem => ({
              type: "profile",
              key: row.id,
              row,
            }),
          ),
        );
      }
      return items;
    });
  }, [
    collapsedGroupIds,
    allProfiles,
    groups,
    isFiltering,
    selectedGroupId,
    sortedRows,
    t,
  ]);
  useScrollFade(scrollParentRef);

  React.useLayoutEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setContainerWidth((previous) => (previous === width ? previous : width));
      setColumnVisibility((previous) => {
        const next = getProfileTableColumnVisibility(width, previous);
        return Object.keys(next).every((key) => previous[key] === next[key])
          ? previous
          : next;
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  // Estimates must match the fixed folder/profile row heights or virtualizer
  // placement drifts under scroll.
  const PROFILE_ROW_HEIGHT = 36;
  const FOLDER_ROW_HEIGHT = 40;

  const rowVirtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) =>
      displayItems[index]?.type === "folder"
        ? FOLDER_ROW_HEIGHT
        : PROFILE_ROW_HEIGHT,
    overscan: 8,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1].end
      : 0;

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollParentRef}
          className={cn(
            "scroll-fade relative min-h-0 flex-1 overflow-auto",
            // Clearance for the floating selection action bar (bottom-6 +
            // ~46px tall) so the last rows can scroll out from behind it.
            // Same predicate DataTableActionBar uses for its visibility.
            table.getFilteredSelectedRowModel().rows.length > 0 && "pb-20",
          )}
          style={
            {
              // Sticky table header is 32px tall (h-8); shift the top
              // fade band below it so the header stays fully opaque and
              // only body rows fade as they scroll past.
              "--scroll-fade-top-offset": "32px",
            } as React.CSSProperties
          }
        >
          <Table className="table-fixed" containerClassName="overflow-visible">
            <colgroup>
              {table.getVisibleLeafColumns().map((column) => (
                <col
                  key={column.id}
                  style={{
                    width: `${columnWidths[column.id] ?? column.getSize()}px`,
                  }}
                />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 overflow-visible bg-background [&_tr]:border-0">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow
                  key={headerGroup.id}
                  className="overflow-visible border-0!"
                >
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody className="overflow-visible">
              {displayItems.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="h-24 text-center"
                  >
                    {t("profiles.table.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {paddingTop > 0 && (
                    <tr style={{ height: `${paddingTop}px` }}>
                      <td colSpan={table.getVisibleLeafColumns().length} />
                    </tr>
                  )}
                  {virtualRows.map((virtualRow) => {
                    const item = displayItems[virtualRow.index];
                    if (item.type === "folder") {
                      const visibleProfileIds = item.rows.map(
                        (row) => row.original.id,
                      );
                      const selectableFolderIds = visibleProfileIds.filter(
                        (profileId) => selectableProfileIds.has(profileId),
                      );
                      const selectedFolderCount = selectableFolderIds.filter(
                        (profileId) => selectedProfiles.includes(profileId),
                      ).length;
                      const folderSelectionState =
                        selectableFolderIds.length > 0 &&
                        selectedFolderCount === selectableFolderIds.length
                          ? true
                          : selectedFolderCount > 0
                            ? "indeterminate"
                            : false;
                      const isCollapsed = collapsedGroupIds.has(item.key);
                      const folderGroup = item.group;
                      const isRenamingGroup =
                        folderGroup?.id === renamingGroupId;
                      const hasStoppedProfiles = item.profileIds.some(
                        (profileId) => !runningProfiles.has(profileId),
                      );
                      const hasRunningProfiles = item.profileIds.some(
                        (profileId) => runningProfiles.has(profileId),
                      );

                      return (
                        <TableRow
                          key={`folder-${item.key}`}
                          style={{ height: `${FOLDER_ROW_HEIGHT}px` }}
                          className="border-0! bg-muted/35 hover:bg-muted/55"
                        >
                          <TableCell
                            colSpan={table.getVisibleLeafColumns().length}
                            className="p-0"
                          >
                            <div className="flex h-10 items-center gap-2 px-2">
                              <Checkbox
                                checked={folderSelectionState}
                                disabled={selectableFolderIds.length === 0}
                                onCheckedChange={(checked) => {
                                  handleToggleFolderSelection(
                                    visibleProfileIds,
                                    checked === true,
                                  );
                                }}
                                aria-label={t("common.aria.selectAll")}
                              />
                              {isRenamingGroup && folderGroup ? (
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  {isCollapsed ? (
                                    <LuChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <LuChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                  )}
                                  {isCollapsed ? (
                                    <LuFolder className="size-4 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <LuFolderOpen className="size-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <Input
                                    autoFocus
                                    value={groupNameDraft}
                                    onChange={(event) => {
                                      setGroupNameDraft(event.target.value);
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void submitGroupRename(folderGroup);
                                      } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelGroupRename();
                                      }
                                    }}
                                    onBlur={() => {
                                      void submitGroupRename(folderGroup);
                                    }}
                                    aria-label={t("groups.form.name")}
                                    className="h-7 min-w-24 flex-1 px-2 text-sm font-medium"
                                  />
                                  <Badge
                                    variant="secondary"
                                    className="h-5 min-w-5 shrink-0 justify-center px-1.5 text-[11px] font-normal"
                                  >
                                    {item.profileIds.length}
                                  </Badge>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left"
                                  aria-expanded={!isCollapsed}
                                  onClick={() => {
                                    toggleFolder(item.key);
                                  }}
                                >
                                  {isCollapsed ? (
                                    <LuChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <LuChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                  )}
                                  {isCollapsed ? (
                                    <LuFolder className="size-4 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <LuFolderOpen className="size-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <span className="truncate text-sm font-medium">
                                    {item.name}
                                  </span>
                                  {folderGroup && (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span
                                          className={cn(
                                            "size-1.5 shrink-0 rounded-full",
                                            folderGroup.sync_enabled
                                              ? "bg-success"
                                              : "bg-muted-foreground",
                                          )}
                                        />
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {t(
                                          folderGroup.sync_enabled
                                            ? "groups.sync.enabled"
                                            : "groups.sync.disabled",
                                        )}
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  <Badge
                                    variant="secondary"
                                    className="h-5 min-w-5 shrink-0 justify-center px-1.5 text-[11px] font-normal"
                                  >
                                    {item.profileIds.length}
                                  </Badge>
                                </button>
                              )}

                              {folderGroup && !isRenamingGroup && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="size-7 shrink-0"
                                      aria-label={t(
                                        "groupManagement.editGroupTooltip",
                                      )}
                                      onClick={() => {
                                        beginGroupRename(folderGroup);
                                      }}
                                    >
                                      <LuPencil className="size-3.5" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {t("groupManagement.editGroupTooltip")}
                                  </TooltipContent>
                                </Tooltip>
                              )}

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 shrink-0"
                                    aria-label={t(
                                      "profiles.actionBar.runSelected",
                                    )}
                                    disabled={!hasStoppedProfiles}
                                    onClick={() => {
                                      onRunProfiles(item.profileIds);
                                    }}
                                  >
                                    <LuPlay className="size-3.5 fill-current" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t("profiles.actionBar.runSelected")}
                                </TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 shrink-0"
                                    aria-label={t(
                                      "profiles.actionBar.stopSelected",
                                    )}
                                    disabled={!hasRunningProfiles}
                                    onClick={() => {
                                      onStopProfiles(item.profileIds);
                                    }}
                                  >
                                    <LuSquare className="size-3.5 fill-current" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t("profiles.actionBar.stopSelected")}
                                </TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 shrink-0"
                                    aria-label={t(
                                      "profiles.actionBar.assignProxy",
                                    )}
                                    disabled={item.profileIds.length === 0}
                                    onClick={() => {
                                      onAssignProfilesToProxy(item.profileIds);
                                    }}
                                  >
                                    <FiWifi className="size-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t("profiles.actionBar.assignProxy")}
                                </TooltipContent>
                              </Tooltip>

                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 shrink-0"
                                  >
                                    <LuEllipsis className="size-4" />
                                    <span className="sr-only">
                                      {t("common.labels.actions")}
                                    </span>
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      onCreateProfileInGroup(
                                        folderGroup?.id ?? null,
                                      );
                                    }}
                                  >
                                    <LuPlus />
                                    {t("header.newProfile")}
                                  </DropdownMenuItem>
                                  {folderGroup && (
                                    <>
                                      <DropdownMenuItem
                                        onSelect={() => {
                                          beginGroupRename(folderGroup);
                                        }}
                                      >
                                        <LuPencil />
                                        {t("groups.edit")}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        disabled={
                                          togglingGroupSyncId === folderGroup.id
                                        }
                                        onSelect={() => {
                                          void toggleGroupSync(folderGroup);
                                        }}
                                      >
                                        <LuRefreshCw
                                          className={cn(
                                            togglingGroupSyncId ===
                                              folderGroup.id && "animate-spin",
                                          )}
                                        />
                                        {t(
                                          folderGroup.sync_enabled
                                            ? "syncTooltips.disable"
                                            : "syncTooltips.enable",
                                        )}
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                  <DropdownMenuSeparator />
                                  {onAssignExtensionGroup && (
                                    <DropdownMenuItem
                                      disabled={item.profileIds.length === 0}
                                      onSelect={() => {
                                        onAssignExtensionGroup(item.profileIds);
                                      }}
                                    >
                                      <LuPuzzle />
                                      {t(
                                        "profiles.actionBar.assignExtensionGroup",
                                      )}
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    disabled={item.profileIds.length === 0}
                                    onSelect={() => {
                                      onAssignProfilesToGroup(item.profileIds);
                                    }}
                                  >
                                    <LuUsers />
                                    {t("profiles.actionBar.assignToGroup")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={item.profileIds.length === 0}
                                    onSelect={() => {
                                      onCopyCookiesToProfiles(item.profileIds);
                                    }}
                                  >
                                    <LuCookie />
                                    {t("profiles.actionBar.copyCookies")}
                                  </DropdownMenuItem>
                                  {folderGroup && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onSelect={() => {
                                          setGroupToDelete(folderGroup);
                                        }}
                                      >
                                        <LuTrash2 />
                                        {t("groups.delete")}
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    }

                    const row = item.row;
                    const rowIsCrossOs = isCrossOsProfile(row.original);
                    const crossOsTitle = rowIsCrossOs
                      ? t("crossOs.viewOnly", {
                          os: getOSDisplayName(
                            row.original.host_os ||
                              row.original.wayfern_config?.os ||
                              "",
                          ),
                        })
                      : undefined;
                    return (
                      <TableRow
                        key={row.id}
                        data-state={row.getIsSelected() && "selected"}
                        title={crossOsTitle}
                        style={{ height: `${PROFILE_ROW_HEIGHT}px` }}
                        className={cn(
                          "overflow-visible border-0! hover:bg-accent/50",
                          rowIsCrossOs && "opacity-60",
                        )}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            className="overflow-visible py-0"
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                  {paddingBottom > 0 && (
                    <tr style={{ height: `${paddingBottom}px` }}>
                      <td colSpan={table.getVisibleLeafColumns().length} />
                    </tr>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <DeleteConfirmationDialog
        isOpen={profileToDelete !== null}
        onClose={() => {
          setProfileToDelete(null);
        }}
        onConfirm={handleDelete}
        title={t("profiles.delete.title")}
        description={t("profiles.delete.description", {
          profileName: profileToDelete?.name ?? "",
        })}
        confirmButtonText={t("profiles.delete.confirmButton")}
        isLoading={isDeleting}
      />
      <DeleteGroupDialog
        isOpen={groupToDelete !== null}
        onClose={() => {
          setGroupToDelete(null);
        }}
        group={groupToDelete}
        onGroupDeleted={() => {
          if (groupToDelete) onGroupDeleted(groupToDelete.id);
          setGroupToDelete(null);
        }}
      />
      <ProxyFormDialog
        isOpen={editingProxy !== null}
        onClose={() => {
          setEditingProxy(null);
        }}
        editingProxy={editingProxy}
      />
      {profileForInfoDialog &&
        (() => {
          const infoProfile =
            profiles.find((p) => p.id === profileForInfoDialog.id) ??
            profileForInfoDialog;
          const infoIsRunning =
            browserState.isClient && runningProfiles.has(infoProfile.id);
          const infoIsLaunching = launchingProfiles.has(infoProfile.id);
          const infoIsStopping = stoppingProfiles.has(infoProfile.id);
          const infoIsCrossOs = isCrossOsProfile(infoProfile);
          const infoIsDisabled =
            infoIsRunning || infoIsLaunching || infoIsStopping || infoIsCrossOs;
          return (
            <ProfileInfoDialog
              isOpen={profileForInfoDialog !== null}
              onClose={() => {
                setProfileForInfoDialog(null);
              }}
              profile={infoProfile}
              storedProxies={storedProxies}
              vpnConfigs={vpnConfigs}
              onOpenTrafficDialog={(profileId) => {
                const profile = profiles.find((p) => p.id === profileId);
                setTrafficDialogProfile({ id: profileId, name: profile?.name });
              }}
              onOpenProfileSyncDialog={onOpenProfileSyncDialog}
              onAssignProfilesToGroup={onAssignProfilesToGroup}
              onConfigureWayfern={onConfigureWayfern}
              onCopyCookiesToProfile={onCopyCookiesToProfile}
              onOpenCookieManagement={onOpenCookieManagement}
              onAssignExtensionGroup={onAssignExtensionGroup}
              onOpenBypassRules={(profile) => {
                setBypassRulesProfile(profile);
              }}
              onOpenDnsBlocklist={(profile) => {
                setDnsBlocklistProfile(profile);
              }}
              onOpenLaunchHook={(profile) => {
                setLaunchHookProfile(profile);
              }}
              onCloneProfile={onCloneProfile}
              onLaunchWithSync={onLaunchWithSync}
              onSetPassword={onSetPassword}
              onChangePassword={onChangePassword}
              onRemovePassword={onRemovePassword}
              onDeleteProfile={(profile) => {
                setProfileForInfoDialog(null);
                setProfileToDelete(profile);
              }}
              isRunning={infoIsRunning}
              isDisabled={infoIsDisabled}
              isCrossOs={infoIsCrossOs}
              syncStatuses={syncStatuses}
            />
          );
        })()}
      <DataTableActionBar table={table}>
        <DataTableActionBarSelection table={table} />
        {onBulkRun && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.runSelected")}
            onClick={onBulkRun}
            size="icon"
          >
            <LuPlay className="fill-current" />
          </DataTableActionBarAction>
        )}
        {onBulkStop && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.stopSelected")}
            onClick={onBulkStop}
            size="icon"
          >
            <LuSquare className="fill-current" />
          </DataTableActionBarAction>
        )}
        {onBulkGroupAssignment && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.assignToGroup")}
            onClick={onBulkGroupAssignment}
            size="icon"
          >
            <LuUsers />
          </DataTableActionBarAction>
        )}
        {onBulkProxyAssignment && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.assignProxy")}
            onClick={onBulkProxyAssignment}
            size="icon"
          >
            <FiWifi />
          </DataTableActionBarAction>
        )}
        {onBulkExtensionGroupAssignment && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.assignExtensionGroup")}
            onClick={onBulkExtensionGroupAssignment}
            size="icon"
          >
            <LuPuzzle />
          </DataTableActionBarAction>
        )}
        {onBulkCopyCookies && (
          <DataTableActionBarAction
            tooltip={t("profiles.actionBar.copyCookies")}
            onClick={onBulkCopyCookies}
            size="icon"
          >
            <LuCookie />
          </DataTableActionBarAction>
        )}
        {onBulkDelete && (
          <DataTableActionBarAction
            tooltip={t("common.buttons.delete")}
            onClick={onBulkDelete}
            size="icon"
            variant="destructive"
            className="border-destructive bg-destructive/50 hover:bg-destructive/70"
          >
            <LuTrash2 />
          </DataTableActionBarAction>
        )}
      </DataTableActionBar>
      {trafficDialogProfile && (
        <TrafficDetailsDialog
          isOpen={trafficDialogProfile !== null}
          onClose={() => {
            setTrafficDialogProfile(null);
          }}
          profileId={trafficDialogProfile.id}
          profileName={trafficDialogProfile.name}
        />
      )}
      <ProfileBypassRulesDialog
        isOpen={bypassRulesProfile !== null}
        onClose={() => {
          setBypassRulesProfile(null);
        }}
        profileId={bypassRulesProfile?.id ?? null}
        initialRules={bypassRulesProfile?.proxy_bypass_rules ?? []}
      />
      <ProfileDnsBlocklistDialog
        isOpen={dnsBlocklistProfile !== null}
        onClose={() => {
          setDnsBlocklistProfile(null);
        }}
        profileId={dnsBlocklistProfile?.id ?? null}
        currentLevel={dnsBlocklistProfile?.dns_blocklist ?? null}
      />
      <ProfileLaunchHookDialog
        isOpen={launchHookProfile !== null}
        onClose={() => {
          setLaunchHookProfile(null);
        }}
        profileId={launchHookProfile?.id ?? null}
        currentLaunchHook={launchHookProfile?.launch_hook ?? null}
      />
    </>
  );
}
