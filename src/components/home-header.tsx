"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GoPlus } from "react-icons/go";
import {
  LuChevronLeft,
  LuChevronRight,
  LuFolderPlus,
  LuSearch,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { getCurrentOS } from "@/lib/browser-utils";
import { cn } from "@/lib/utils";
import type { GroupWithCount } from "@/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// The whole titlebar is a native window-drag surface via Tauri's
// `data-tauri-drag-region="deep"` attribute: any non-clickable pixel
// (gaps, the title, empty padding) drags the undecorated Windows window,
// while clickable controls (buttons, inputs, links) block the drag and
// keep receiving clicks — handled entirely by the injected drag script,
// no JS/IPC round-trip. Double-clicking empty titlebar space also
// toggles maximize natively.

const ALL_FILTER_ID = "__all__";
const UNGROUPED_FILTER_ID = "__ungrouped__";

interface Props {
  onCreateProfileDialogOpen: (open: boolean) => void;
  onCreateGroup: () => void;
  onOpenTrash: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  groups: GroupWithCount[];
  totalProfiles: number;
  ungroupedProfiles: number;
  selectedGroupId: string | null;
  onGroupSelect: (groupId: string) => void;
  pageTitle?: string;
}

const HomeHeader = ({
  onCreateProfileDialogOpen,
  onCreateGroup,
  onOpenTrash,
  searchQuery,
  onSearchQueryChange,
  groups,
  totalProfiles,
  ungroupedProfiles,
  selectedGroupId,
  onGroupSelect,
  pageTitle,
}: Props) => {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<string>("macos");

  useEffect(() => {
    setPlatform(getCurrentOS());
  }, []);

  // Diagnostic only: prove the header mounted and that pointer events reach
  // it, so support reports can separate "clicks never land" from a backend
  // problem. Log-string only, never rendered.
  useEffect(() => {
    void invoke("log_frontend_event", {
      kind: "header.mounted",
      detail: navigator.userAgent,
    });
  }, []);

  const reportHeaderPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type !== "pointerdown") return;
    void invoke("log_frontend_event", {
      kind: "header.pointerdown",
      detail: `x=${Math.round(e.clientX)} y=${Math.round(
        e.clientY,
      )} button=${e.button} target=${(e.target as HTMLElement).tagName.toLowerCase()}`,
    });
    // Drag the undecorated window natively (Rust side) on primary press —
    // but only when the press is not on an interactive control, so buttons,
    // inputs and links still receive their clicks. This mirrors Tauri's
    // `data-tauri-drag-region="deep"` detection but routes through a custom
    // command that works even when the `core:window` ACL allows are
    // unavailable (the injected drag script dies there, leaving the header
    // undraggable on some machines).
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (
      target.closest(
        'button, a, input, select, textarea, [role="button"], [contenteditable="true"], label, summary, [tabindex]',
      )
    ) {
      return;
    }
    void invoke("app_window_action", { action: "start_drag" }).catch(() => {
      // Non-fatal: dragging just won't engage; clicks still work.
    });
  };

  const isMacOS = platform === "macos";
  const showProfileToolbar = !pageTitle;

  // Horizontal scroll fades for the group filter strip — when the user
  // has more groups than fit, the right edge fades to hint at overflow.
  const groupsScrollRef = useRef<HTMLDivElement | null>(null);
  const [groupsFadeLeft, setGroupsFadeLeft] = useState(false);
  const [groupsFadeRight, setGroupsFadeRight] = useState(false);
  const groupStripLayoutKey = [
    ...groups.map((group) => `${group.id}:${group.name}:${group.count}`),
    ...(ungroupedProfiles > 0 ? [`ungrouped:${ungroupedProfiles}`] : []),
  ].join("|");
  useEffect(() => {
    if (!groupStripLayoutKey) {
      setGroupsFadeLeft(false);
      setGroupsFadeRight(false);
      return;
    }
    const el = groupsScrollRef.current;
    if (!el) return;
    const update = () => {
      setGroupsFadeLeft(el.scrollLeft > 1);
      setGroupsFadeRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [groupStripLayoutKey]);

  const isWindows = platform === "windows";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: window titlebar drag surface — pointer input is for OS window dragging, not a virtual widget; interactive children (buttons/inputs) handle their own semantics.
    <div
      onPointerDown={reportHeaderPointer}
      onDoubleClick={(e) => {
        const target = e.target as Element;
        if (
          !target.closest(
            'button, a, input, select, textarea, [role="button"], [contenteditable="true"], label, summary, [tabindex]',
          )
        ) {
          void invoke("app_window_action", { action: "toggle_maximize" });
        }
      }}
      className={cn(
        "flex h-11 items-center gap-2 border-b border-border bg-card pl-3 select-none",
        // Windows: WindowDragArea renders three 44px native-style controls
        // (minimize + maximize/restore + close) fixed at top-right with
        // z-50, total 132px wide. Reserve 144px on the right edge so the
        // "+ New" button and search input clear them with a few pixels of
        // breathing room and never sit underneath the controls.
        isWindows ? "pr-[144px]" : "pr-3",
      )}
    >
      {isMacOS && (
        <div
          aria-hidden="true"
          className="mr-1 flex shrink-0 items-center gap-[7px]"
        >
          {/* Reserve space for the macOS native traffic lights — the OS draws
              the colored buttons here through the transparent titlebar. */}
          <div className="size-[11px] rounded-full" />
          <div className="size-[11px] rounded-full" />
          <div className="size-[11px] rounded-full" />
        </div>
      )}

      {pageTitle ? (
        <span className="ml-2 text-xs font-semibold text-card-foreground">
          {pageTitle}
        </span>
      ) : null}

      {showProfileToolbar && (
        <div className="relative flex min-w-0 flex-1 items-center">
          {groupsFadeLeft && (
            <button
              type="button"
              aria-label={t("header.scrollGroupsLeft")}
              onClick={() => {
                const el = groupsScrollRef.current;
                if (el)
                  el.scrollBy({
                    left: -el.clientWidth * 0.6,
                    behavior: "smooth",
                  });
              }}
              className="absolute top-1/2 left-0 z-10 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              <LuChevronLeft className="size-3" />
            </button>
          )}
          <div
            ref={groupsScrollRef}
            className="ml-2 flex scrollbar-none items-center gap-3 overflow-x-auto scroll-smooth [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{
              paddingLeft: groupsFadeLeft ? 22 : 0,
              paddingRight: groupsFadeRight ? 22 : 0,
            }}
          >
            {/* "All" filter — shows every profile regardless of group. */}
            {(() => {
              const active = selectedGroupId === ALL_FILTER_ID;
              return (
                <button
                  key="__all__"
                  type="button"
                  onClick={() => {
                    onGroupSelect(ALL_FILTER_ID);
                  }}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 px-1 text-xs transition-colors duration-100",
                    active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{t("groups.all")}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {totalProfiles}
                  </span>
                </button>
              );
            })()}
            {ungroupedProfiles > 0 && (
              <button
                type="button"
                onClick={() => {
                  onGroupSelect(
                    selectedGroupId === UNGROUPED_FILTER_ID
                      ? ALL_FILTER_ID
                      : UNGROUPED_FILTER_ID,
                  );
                }}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 px-1 text-xs transition-colors duration-100",
                  selectedGroupId === UNGROUPED_FILTER_ID
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{t("groups.noGroup")}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {ungroupedProfiles}
                </span>
              </button>
            )}
            {groups.map((group) => {
              const active = selectedGroupId === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  title={group.name}
                  onClick={() => {
                    onGroupSelect(active ? ALL_FILTER_ID : group.id);
                  }}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 px-1 text-xs transition-colors duration-100",
                    active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="max-w-40 truncate">{group.name}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {group.count}
                  </span>
                </button>
              );
            })}
          </div>
          {groupsFadeRight && (
            <button
              type="button"
              aria-label={t("header.scrollGroupsRight")}
              onClick={() => {
                const el = groupsScrollRef.current;
                if (el)
                  el.scrollBy({
                    left: el.clientWidth * 0.6,
                    behavior: "smooth",
                  });
              }}
              className="absolute top-1/2 right-0 z-10 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-card/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            >
              <LuChevronRight className="size-3" />
            </button>
          )}
        </div>
      )}

      {showProfileToolbar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              onClick={onCreateGroup}
              aria-label={t("groups.add")}
            >
              <LuFolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("groups.add")}</TooltipContent>
        </Tooltip>
      )}

      {showProfileToolbar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              onClick={onOpenTrash}
              aria-label={t("header.openTrash")}
            >
              <LuTrash2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("header.openTrash")}</TooltipContent>
        </Tooltip>
      )}

      {!showProfileToolbar && <div className="flex-1" />}

      {showProfileToolbar && (
        <div className="relative shrink-0">
          <Input
            type="text"
            placeholder={t("header.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => {
              onSearchQueryChange(e.target.value);
            }}
            className="h-7 w-36 pr-7 pl-8 text-xs min-[860px]:w-52"
          />
          <LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 transform text-muted-foreground" />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                onSearchQueryChange("");
              }}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 transform rounded-sm p-0.5 transition-colors hover:bg-accent"
              aria-label={t("header.clearSearch")}
            >
              <LuX className="size-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          ) : null}
        </div>
      )}

      {showProfileToolbar && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Button
                size="sm"
                data-onborda="create-profile"
                onClick={() => {
                  onCreateProfileDialogOpen(true);
                }}
                className="flex h-7 items-center gap-1.5 px-2.5 text-xs"
              >
                <GoPlus className="size-3.5" />
                {t("header.newProfile")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("header.createProfile")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};

export default HomeHeader;
