import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ProfileLockInfo {
  profileId: string;
  lockedBy: string;
  lockedByEmail: string;
  lockedAt: string;
  expiresAt: string;
}

export interface ProfileLockRequest {
  ownerId: string;
  ownerLabel?: string;
}

export interface ProfileLockResult {
  success: boolean;
  lock?: ProfileLockInfo;
  lockedBy?: string;
  lockedByEmail?: string;
}

interface StoredProfileLock extends ProfileLockInfo {
  expiresAtMs: number;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

@Injectable()
export class ProfileLockService implements OnModuleInit {
  private readonly logger = new Logger(ProfileLockService.name);
  private readonly lockFile: string;
  private readonly temporaryDirectory: string;
  private readonly leaseMs: number;
  private locks = new Map<string, StoredProfileLock>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(configService: ConfigService) {
    const requestedDriver = configService
      .get<string>("STORAGE_DRIVER")
      ?.toLowerCase();
    const usesS3 =
      requestedDriver === "s3" ||
      (!requestedDriver && Boolean(configService.get<string>("S3_ENDPOINT")));
    const dataDirectory = path.resolve(
      configService.get<string>("DATA_DIR") ||
        (usesS3 ? path.join(os.tmpdir(), "donut-sync") : "/data"),
    );
    this.lockFile = path.join(dataDirectory, ".profile-locks.json");
    this.temporaryDirectory = path.join(dataDirectory, ".tmp");

    const configuredLease = Number(configService.get<string>("LOCK_LEASE_MS"));
    this.leaseMs = Number.isFinite(configuredLease)
      ? Math.max(5_000, Math.min(configuredLease, 5 * 60_000))
      : 45_000;
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.temporaryDirectory, { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.lockFile, "utf8")) as unknown;
      if (Array.isArray(data)) {
        for (const candidate of data) {
          if (this.isStoredLock(candidate)) {
            this.locks.set(candidate.profileId, candidate);
          }
        }
      }
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        this.logger.warn("Ignoring invalid persisted profile lock state");
      }
    }

    await this.runExclusive(async () => {
      if (this.purgeExpired()) await this.persist();
    });
  }

  async list(): Promise<ProfileLockInfo[]> {
    return this.runExclusive(async () => {
      if (this.purgeExpired()) await this.persist();
      return [...this.locks.values()].map((lock) => this.publicLock(lock));
    });
  }

  async acquire(
    profileId: string,
    request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    this.validate(profileId, request);
    return this.runExclusive(async () => {
      const purged = this.purgeExpired();
      const existing = this.locks.get(profileId);
      if (existing && existing.lockedBy !== request.ownerId) {
        if (purged) await this.persist();
        return {
          success: false,
          lock: this.publicLock(existing),
          lockedBy: existing.lockedBy,
          lockedByEmail: existing.lockedByEmail,
        };
      }

      const now = Date.now();
      if (
        existing &&
        existing.lockedBy === request.ownerId &&
        existing.expiresAtMs - now > this.leaseMs / 2
      ) {
        // Centralized launch paths may defensively acquire twice. A fresh
        // same-owner lease is already exclusive, so avoid another disk fsync.
        return { success: true, lock: this.publicLock(existing) };
      }
      const lock: StoredProfileLock = {
        profileId,
        lockedBy: request.ownerId,
        lockedByEmail: this.ownerLabel(request),
        lockedAt: existing?.lockedAt || new Date(now).toISOString(),
        expiresAt: new Date(now + this.leaseMs).toISOString(),
        expiresAtMs: now + this.leaseMs,
      };
      this.locks.set(profileId, lock);
      await this.persist();
      return { success: true, lock: this.publicLock(lock) };
    });
  }

  async heartbeat(
    profileId: string,
    request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    this.validate(profileId, request);
    return this.runExclusive(async () => {
      const purged = this.purgeExpired();
      const existing = this.locks.get(profileId);
      if (!existing || existing.lockedBy !== request.ownerId) {
        if (purged) await this.persist();
        return existing
          ? {
              success: false,
              lock: this.publicLock(existing),
              lockedBy: existing.lockedBy,
              lockedByEmail: existing.lockedByEmail,
            }
          : { success: false };
      }

      const expiresAtMs = Date.now() + this.leaseMs;
      existing.expiresAtMs = expiresAtMs;
      existing.expiresAt = new Date(expiresAtMs).toISOString();
      existing.lockedByEmail = this.ownerLabel(request);
      await this.persist();
      return { success: true, lock: this.publicLock(existing) };
    });
  }

  async release(
    profileId: string,
    request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    this.validate(profileId, request);
    return this.runExclusive(async () => {
      const purged = this.purgeExpired();
      const existing = this.locks.get(profileId);
      if (!existing) {
        if (purged) await this.persist();
        return { success: true };
      }
      if (existing.lockedBy !== request.ownerId) {
        if (purged) await this.persist();
        return {
          success: false,
          lock: this.publicLock(existing),
          lockedBy: existing.lockedBy,
          lockedByEmail: existing.lockedByEmail,
        };
      }

      this.locks.delete(profileId);
      await this.persist();
      return { success: true };
    });
  }

  private validate(profileId: string, request: ProfileLockRequest): void {
    if (
      !profileId ||
      profileId.length > 200 ||
      !request?.ownerId ||
      request.ownerId.length > 200 ||
      (request.ownerLabel?.length ?? 0) > 300
    ) {
      throw new BadRequestException("Invalid profile lock request");
    }
  }

  private ownerLabel(request: ProfileLockRequest): string {
    return request.ownerLabel?.trim() || request.ownerId;
  }

  private purgeExpired(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [profileId, lock] of this.locks) {
      if (lock.expiresAtMs <= now) {
        this.locks.delete(profileId);
        changed = true;
      }
    }
    return changed;
  }

  private publicLock(lock: StoredProfileLock): ProfileLockInfo {
    return {
      profileId: lock.profileId,
      lockedBy: lock.lockedBy,
      lockedByEmail: lock.lockedByEmail,
      lockedAt: lock.lockedAt,
      expiresAt: lock.expiresAt,
    };
  }

  private isStoredLock(value: unknown): value is StoredProfileLock {
    if (!value || typeof value !== "object") return false;
    const lock = value as Partial<StoredProfileLock>;
    return (
      typeof lock.profileId === "string" &&
      typeof lock.lockedBy === "string" &&
      typeof lock.lockedByEmail === "string" &&
      typeof lock.lockedAt === "string" &&
      typeof lock.expiresAt === "string" &&
      typeof lock.expiresAtMs === "number"
    );
  }

  private async persist(): Promise<void> {
    const temporary = path.join(
      this.temporaryDirectory,
      `.profile-locks-${randomUUID()}`,
    );
    await writeFile(temporary, JSON.stringify([...this.locks.values()]), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      const handle = await open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.lockFile);
      await this.syncDirectory(path.dirname(this.lockFile));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (
        !["EISDIR", "EINVAL", "EPERM", "ENOTSUP", "ENOENT"].includes(code || "")
      ) {
        throw error;
      }
    }
  }
}
