"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuLoader, LuRotateCcw, LuTrash2 } from "react-icons/lu";
import { translateBackendError } from "@/lib/backend-errors";
import { showErrorToast, showSuccessToast } from "@/lib/toast-utils";
import type { TrashEntry } from "@/types";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { LoadingButton } from "./loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { RippleButton } from "./ui/ripple";

const TRASH_EVENT = "trash-changed";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 0; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(1)} ${unit}`;
}

function formatDate(secs: number): string {
  return new Date(secs * 1000).toLocaleString();
}

interface TrashDialogProps {
  open: boolean;
  onClose: () => void;
}

export function TrashDialog({ open, onClose }: TrashDialogProps) {
  const { t } = useTranslation();
  const browserLabel = (browser: string) =>
    browser === "wayfern" ? t("browser.wayfern") : browser;
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<TrashEntry | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const isMounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await invoke<TrashEntry[]>("list_trash");
      if (isMounted.current) {
        setEntries(result);
      }
    } catch (err) {
      console.error("Failed to list trash:", err);
      if (isMounted.current) {
        showErrorToast(translateBackendError(t, err));
      }
    }
  }, [t]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void load().finally(() => {
      if (isMounted.current) setLoading(false);
    });
  }, [open, load]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    void listen(TRASH_EVENT, () => {
      if (active) void load();
    }).then((fn) => {
      if (active) unlisten = fn;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [load]);

  const handleRestore = useCallback(
    async (entry: TrashEntry) => {
      setBusyId(entry.id);
      try {
        const profile = await invoke<{ name: string }>(
          "restore_profile_from_trash",
          { profileId: entry.id },
        );
        if (isMounted.current) {
          // profiles-changed refreshes the profile list; trash-changed (fired
          // by the backend) refreshes this dialog.
          showSuccessToast(t("trashDialog.restored"), {
            description: t("trashDialog.restoredDescription", {
              name: profile?.name ?? entry.name,
            }),
          });
          void load();
        }
      } catch (err) {
        console.error("Failed to restore profile from trash:", err);
        if (isMounted.current) {
          showErrorToast(translateBackendError(t, err));
        }
      } finally {
        if (isMounted.current) setBusyId(null);
      }
    },
    [load, t],
  );

  const handlePurgeConfirmed = useCallback(async () => {
    if (!confirmPurge) return;
    const entry = confirmPurge;
    setConfirmPurge(null);
    try {
      await invoke("purge_profile_from_trash", { profileId: entry.id });
      if (isMounted.current) {
        showSuccessToast(t("trashDialog.purged"), {
          description: t("trashDialog.purgedDescription", { name: entry.name }),
        });
      }
    } catch (err) {
      console.error("Failed to purge profile from trash:", err);
      if (isMounted.current) {
        showErrorToast(translateBackendError(t, err));
      }
    }
  }, [confirmPurge, t]);

  const handleEmptyConfirmed = useCallback(async () => {
    setConfirmEmpty(false);
    try {
      await invoke("empty_profile_trash");
      if (isMounted.current) {
        showSuccessToast(t("trashDialog.emptied"));
      }
    } catch (err) {
      console.error("Failed to empty trash:", err);
      if (isMounted.current) {
        showErrorToast(translateBackendError(t, err));
      }
    }
  }, [t]);

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("trashDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("trashDialog.description", {
                count: entries.length,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <LuLoader className="size-5 animate-spin" />
              </div>
            ) : entries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("trashDialog.empty")}
              </p>
            ) : (
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/40 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {entry.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {browserLabel(entry.browser)}
                        {entry.version ? ` · v${entry.version}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("trashDialog.deletedAt", {
                          date: formatDate(entry.deleted_at),
                        })}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatSize(entry.archive_size)}{" "}
                        {t("trashDialog.compressedFrom", {
                          original: formatSize(entry.original_size),
                        })}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <LoadingButton
                        variant="outline"
                        size="sm"
                        isLoading={busyId === entry.id}
                        onClick={() => void handleRestore(entry)}
                        disabled={busyId !== null && busyId !== entry.id}
                      >
                        <LuRotateCcw className="size-3.5" />
                        {t("trashDialog.restore")}
                      </LoadingButton>
                      <RippleButton
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => setConfirmPurge(entry)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <LuTrash2 className="size-3.5" />
                      </RippleButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter className="border-t border-border pt-3">
            <RippleButton
              variant="outline"
              disabled={loading || entries.length === 0}
              onClick={() => setConfirmEmpty(true)}
            >
              {t("trashDialog.emptyTrash")}
            </RippleButton>
            <RippleButton variant="default" onClick={onClose}>
              {t("common.buttons.close")}
            </RippleButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        isOpen={confirmPurge !== null}
        onClose={() => setConfirmPurge(null)}
        onConfirm={handlePurgeConfirmed}
        title={t("trashDialog.purgeTitle", { name: confirmPurge?.name ?? "" })}
        description={t("trashDialog.purgeDescription")}
        confirmButtonText={t("common.buttons.deleteForever")}
      />

      <DeleteConfirmationDialog
        isOpen={confirmEmpty}
        onClose={() => setConfirmEmpty(false)}
        onConfirm={handleEmptyConfirmed}
        title={t("trashDialog.purgeAllTitle")}
        description={t("trashDialog.purgeAllDescription")}
        confirmButtonText={t("common.buttons.deleteForever")}
      />
    </>
  );
}
