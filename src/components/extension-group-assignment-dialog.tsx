"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadingButton } from "@/components/loading-button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { translateBackendError } from "@/lib/backend-errors";
import type { BrowserProfile, ExtensionGroup } from "@/types";
import { RippleButton } from "./ui/ripple";

interface ExtensionGroupAssignmentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedProfiles: string[];
  onAssignmentComplete: () => void;
  profiles?: BrowserProfile[];
}

export function ExtensionGroupAssignmentDialog({
  isOpen,
  onClose,
  selectedProfiles,
  onAssignmentComplete,
  profiles = [],
}: ExtensionGroupAssignmentDialogProps) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<ExtensionGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<
    string | null | undefined
  >(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const initializedForOpenRef = useRef(false);

  const loadGroups = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const groupList = await invoke<ExtensionGroup[]>("list_extension_groups");
      setGroups(groupList);
    } catch (err) {
      console.error("Failed to load extension groups:", err);
      setError(translateBackendError(t, err));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const handleAssign = useCallback(async () => {
    if (selectedGroupId === undefined) return;
    setIsAssigning(true);
    setError(null);
    try {
      for (const profileId of selectedProfiles) {
        await invoke("assign_extension_group_to_profile", {
          profileId,
          extensionGroupId: selectedGroupId,
        });
      }

      toast.success(t("extensions.assignSuccess"));
      onAssignmentComplete();
      onClose();
    } catch (err) {
      console.error("Failed to assign extension group:", err);
      const errorMessage = translateBackendError(t, err);
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsAssigning(false);
    }
  }, [selectedProfiles, selectedGroupId, onAssignmentComplete, onClose, t]);

  useEffect(() => {
    if (!isOpen) {
      initializedForOpenRef.current = false;
      return;
    }
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;

    void loadGroups();
    const currentGroups = selectedProfiles
      .map((profileId) => profilesById.get(profileId))
      .filter((profile): profile is BrowserProfile => profile !== undefined)
      .map((profile) => profile.extension_group_id ?? null);
    const firstGroup = currentGroups[0];
    setSelectedGroupId(
      currentGroups.length > 0 &&
        currentGroups.every((groupId) => groupId === firstGroup)
        ? firstGroup
        : undefined,
    );
    setError(null);
  }, [isOpen, loadGroups, profilesById, selectedProfiles]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("extensions.assignTitle")}</DialogTitle>
          <DialogDescription>
            {t("extensions.assignDescription", {
              count: selectedProfiles.length,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("extensions.assignTitle")}:</Label>
            <div className="max-h-[min(8rem,20vh)] overflow-y-auto rounded-md bg-muted p-3">
              <ul className="space-y-1 text-sm">
                {selectedProfiles.map((profileId) => {
                  const profile = profilesById.get(profileId);
                  const displayName = profile ? profile.name : profileId;
                  return (
                    <li key={profileId} className="truncate">
                      • {displayName}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="extension-group-select">
              {t("extensions.extensionGroup")}:
            </Label>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">
                {t("common.buttons.loading")}
              </div>
            ) : (
              <Select
                value={
                  selectedGroupId === undefined
                    ? undefined
                    : (selectedGroupId ?? "none")
                }
                onValueChange={(value) => {
                  setSelectedGroupId(value === "none" ? null : value);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("groupAssignment.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("extensions.noGroup")}
                  </SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
            disabled={isLoading || selectedGroupId === undefined}
          >
            {t("common.buttons.apply")}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
