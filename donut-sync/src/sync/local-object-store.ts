import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";

export interface LocalObjectInfo {
  key: string;
  lastModified: string;
  size: number;
  metadata?: Record<string, string>;
  contentType?: string;
  sourceId?: string;
}

interface StoredMetadata {
  metadata?: Record<string, string>;
  contentType?: string;
  objectMtimeNs?: string;
  sourceId?: string;
}

export interface BulkTransferResult {
  itemCount: number;
  totalBytes: number;
}

export const MAX_BUNDLE_ITEMS = 512;
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Durable single-node object storage backed by a mounted directory.
 *
 * Object data and metadata live in separate trees so sidecar files never leak
 * through list operations. Writes land in `.tmp`, are fsynced, and are renamed
 * into place before a change is published to subscribers.
 */
export class LocalObjectStore {
  private readonly root: string;
  private readonly objectsRoot: string;
  private readonly metadataRoot: string;
  private readonly temporaryRoot: string;
  private readonly keyOperations = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
    this.objectsRoot = path.join(this.root, "objects");
    this.metadataRoot = path.join(this.root, ".metadata");
    this.temporaryRoot = path.join(this.root, ".tmp");
  }

  get dataDirectory(): string {
    return this.root;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.objectsRoot, { recursive: true }),
      mkdir(this.metadataRoot, { recursive: true }),
      mkdir(this.temporaryRoot, { recursive: true }),
    ]);

    const probe = path.join(this.temporaryRoot, `.ready-${randomUUID()}`);
    await writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
    await unlink(probe);
  }

  validateKey(key: string, allowEmpty = false): string {
    if (allowEmpty && key === "") return "";
    if (
      !key ||
      key.includes("\0") ||
      key.includes("\\") ||
      key.startsWith("/") ||
      key.endsWith("/..")
    ) {
      throw new Error("Invalid object key");
    }

    const normalized = path.posix.normalize(key);
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized !== key
    ) {
      throw new Error("Invalid object key");
    }
    return normalized;
  }

  private resolveUnder(root: string, key: string, allowEmpty = false): string {
    const normalized = this.validateKey(key, allowEmpty);
    const resolved = path.resolve(root, ...normalized.split("/"));
    const rootPrefix = `${path.resolve(root)}${path.sep}`;
    if (resolved !== path.resolve(root) && !resolved.startsWith(rootPrefix)) {
      throw new Error("Object key escapes storage directory");
    }
    return resolved;
  }

  private objectPath(key: string): string {
    return this.resolveUnder(this.objectsRoot, key);
  }

  private metadataPath(key: string): string {
    return `${this.resolveUnder(this.metadataRoot, key)}.json`;
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await this.initialize();
      return true;
    } catch {
      return false;
    }
  }

  async head(key: string): Promise<LocalObjectInfo | null> {
    return this.runForKey(key, () => this.headUnlocked(key));
  }

  private async headUnlocked(key: string): Promise<LocalObjectInfo | null> {
    const objectPath = this.objectPath(key);
    try {
      const objectStat = await stat(objectPath, { bigint: true });
      if (!objectStat.isFile()) return null;
      const storedMetadata = await this.readMetadata(key);
      const metadataMatches =
        !storedMetadata?.objectMtimeNs ||
        storedMetadata.objectMtimeNs === objectStat.mtimeNs.toString();
      return {
        key,
        lastModified: objectStat.mtime.toISOString(),
        size: Number(objectStat.size),
        metadata: metadataMatches ? storedMetadata?.metadata : undefined,
        contentType: metadataMatches ? storedMetadata?.contentType : undefined,
        sourceId: metadataMatches ? storedMetadata?.sourceId : undefined,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getDownload(key: string): Promise<{
    stream: Readable;
    size: number;
    contentType: string;
  }> {
    return this.runForKey(key, async () => {
      const file = await open(this.objectPath(key), "r");
      try {
        const objectStat = await file.stat({ bigint: true });
        if (!objectStat.isFile()) throw new Error("Object not found");
        const storedMetadata = await this.readMetadata(key);
        const metadataMatches =
          !storedMetadata?.objectMtimeNs ||
          storedMetadata.objectMtimeNs === objectStat.mtimeNs.toString();
        return {
          // Keep this descriptor pinned to the selected inode. A concurrent
          // atomic replacement can change the pathname after this method
          // returns, but it cannot change the bytes or size sent here.
          stream: file.createReadStream({ autoClose: true }),
          size: Number(objectStat.size),
          contentType:
            (metadataMatches ? storedMetadata?.contentType : undefined) ||
            "application/octet-stream",
        };
      } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async putStream(
    key: string,
    input: Readable,
    contentType?: string,
    metadata?: Record<string, string>,
    sourceId?: string,
  ): Promise<LocalObjectInfo> {
    return this.runForKey(key, async () => {
      const destination = this.objectPath(key);
      const temporary = path.join(this.temporaryRoot, randomUUID());
      await mkdir(path.dirname(destination), { recursive: true });

      try {
        await pipeline(
          input,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        const handle = await open(temporary, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const temporaryStat = await stat(temporary, { bigint: true });
        if (contentType || metadata || sourceId) {
          // Commit the sidecar first with the exact body generation it
          // describes. Profile file payloads deliberately omit a sidecar:
          // their hash and size live in the profile manifest, and avoiding a
          // second fsync per tiny Chromium file materially improves uploads.
          await this.writeMetadata(key, {
            contentType,
            metadata,
            objectMtimeNs: temporaryStat.mtimeNs.toString(),
            sourceId,
          });
        }
        await rename(temporary, destination);
        if (!contentType && !metadata && !sourceId) {
          await rm(this.metadataPath(key), { force: true }).catch(
            () => undefined,
          );
        }
        await this.syncDirectory(path.dirname(destination));
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }

      const info = await this.headUnlocked(key);
      if (!info) throw new Error("Object disappeared after upload");
      return info;
    });
  }

  async putBuffer(
    key: string,
    data: Buffer | string,
    contentType?: string,
    metadata?: Record<string, string>,
    sourceId?: string,
  ): Promise<LocalObjectInfo> {
    const { Readable } = await import("node:stream");
    return this.putStream(
      key,
      Readable.from([typeof data === "string" ? Buffer.from(data) : data]),
      contentType,
      metadata,
      sourceId,
    );
  }

  async putTarGzipBundle(
    prefix: string,
    input: Readable,
  ): Promise<BulkTransferResult> {
    this.validateBundlePrefix(prefix);
    const stagingRoot = path.join(this.temporaryRoot, `bundle-${randomUUID()}`);
    await mkdir(stagingRoot, { recursive: true });

    const extracted: Array<{
      key: string;
      stagingPath: string;
      size: number;
    }> = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const extractor = tar.extract();

    extractor.on("entry", (header, entry, next) => {
      void (async () => {
        if (header.type && header.type !== "file") {
          throw new Error("Bulk archives may only contain regular files");
        }
        const relativePath = this.validateBundlePath(header.name);
        if (seen.has(relativePath)) {
          throw new Error("Bulk archive contains a duplicate path");
        }
        if (extracted.length >= MAX_BUNDLE_ITEMS) {
          throw new Error("Bulk archive contains too many files");
        }
        const expectedSize = header.size;
        if (
          !Number.isSafeInteger(expectedSize) ||
          expectedSize === undefined ||
          expectedSize < 0 ||
          totalBytes + expectedSize > MAX_BUNDLE_BYTES
        ) {
          throw new Error("Bulk archive exceeds the allowed size");
        }

        seen.add(relativePath);
        const stagingPath = path.join(stagingRoot, extracted.length.toString());
        await pipeline(
          entry,
          createWriteStream(stagingPath, { flags: "wx", mode: 0o600 }),
        );
        const staged = await stat(stagingPath);
        if (staged.size !== expectedSize) {
          throw new Error("Bulk archive entry size mismatch");
        }
        totalBytes += staged.size;
        extracted.push({
          key: `${prefix}${relativePath}`,
          stagingPath,
          size: staged.size,
        });
        next();
      })().catch((error: unknown) => {
        entry.resume();
        next(error);
      });
    });

    try {
      await pipeline(input, createGunzip(), extractor);
      if (extracted.length === 0) {
        throw new Error("Bulk archive is empty");
      }

      for (let offset = 0; offset < extracted.length; offset += 32) {
        await Promise.all(
          extracted.slice(offset, offset + 32).map(async ({ stagingPath }) => {
            const handle = await open(stagingPath, "r");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }),
        );
      }

      const objectDirectories = new Set<string>();
      await Promise.all(
        extracted.map(({ key, stagingPath }) =>
          this.runForKey(key, async () => {
            const destination = this.objectPath(key);
            const directory = path.dirname(destination);
            await mkdir(directory, { recursive: true });
            await rename(stagingPath, destination);
            await rm(this.metadataPath(key), { force: true }).catch(
              () => undefined,
            );
            objectDirectories.add(directory);
          }),
        ),
      );
      await Promise.all(
        [...objectDirectories].map((directory) =>
          this.syncDirectory(directory),
        ),
      );

      return { itemCount: extracted.length, totalBytes };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  async createTarGzipBundle(
    prefix: string,
    paths: string[],
  ): Promise<Readable> {
    this.validateBundlePrefix(prefix);
    if (paths.length === 0 || paths.length > MAX_BUNDLE_ITEMS) {
      throw new Error("Invalid bulk download item count");
    }
    const normalizedPaths = paths.map((item) => this.validateBundlePath(item));
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw new Error("Bulk download contains duplicate paths");
    }

    const archive = tar.pack();
    const compressed = createGzip({ level: 1 });
    archive.pipe(compressed);

    void (async () => {
      for (const relativePath of normalizedPaths) {
        const key = `${prefix}${relativePath}`;
        const object = await this.getDownload(key);
        await new Promise<void>((resolve, reject) => {
          const entry = archive.entry(
            {
              name: relativePath,
              type: "file",
              mode: 0o600,
              size: object.size,
              mtime: new Date(0),
            },
            (error) => (error ? reject(error) : resolve()),
          );
          object.stream.once("error", reject);
          entry.once("error", reject);
          object.stream.pipe(entry);
        });
      }
      archive.finalize();
    })().catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      archive.destroy(cause);
      compressed.destroy(cause);
    });

    return compressed;
  }

  async delete(key: string): Promise<boolean> {
    return this.runForKey(key, async () => {
      const objectPath = this.objectPath(key);
      let deleted = false;
      try {
        await unlink(objectPath);
        deleted = true;
        await this.syncDirectory(path.dirname(objectPath));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const sidecar = this.metadataPath(key);
      await rm(sidecar, { force: true }).catch(() => undefined);
      await this.syncDirectory(path.dirname(sidecar));
      return deleted;
    });
  }

  async deletePrefix(prefix: string): Promise<LocalObjectInfo[]> {
    this.validateKey(prefix, prefix === "");
    const objects = await this.listAll(prefix);
    for (let offset = 0; offset < objects.length; offset += 128) {
      await Promise.all(
        objects
          .slice(offset, offset + 128)
          .map((object) => this.delete(object.key)),
      );
    }
    return objects;
  }

  async list(
    prefix: string,
    maxKeys = 1000,
    continuationToken?: string,
  ): Promise<{
    objects: LocalObjectInfo[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  }> {
    this.validateKey(prefix, prefix === "");
    const allKeys = await this.collectKeysForPrefix(prefix);
    allKeys.sort();

    let after = "";
    if (continuationToken) {
      try {
        after = Buffer.from(continuationToken, "base64url").toString("utf8");
      } catch {
        throw new Error("Invalid continuation token");
      }
    }

    const eligible = after ? allKeys.filter((key) => key > after) : allKeys;
    const pageKeys = eligible.slice(0, Math.max(1, Math.min(maxKeys, 1000)));
    const objects = (
      await Promise.all(pageKeys.map((key) => this.head(key)))
    ).filter((value): value is LocalObjectInfo => value !== null);
    const isTruncated = eligible.length > pageKeys.length;
    const lastKey = pageKeys.at(-1);

    return {
      objects,
      isTruncated,
      nextContinuationToken:
        isTruncated && lastKey
          ? Buffer.from(lastKey).toString("base64url")
          : undefined,
    };
  }

  async listAll(prefix: string): Promise<LocalObjectInfo[]> {
    const objects: LocalObjectInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.list(prefix, 1000, continuationToken);
      objects.push(...page.objects);
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
    return objects;
  }

  async listSyncSignals(scope = ""): Promise<LocalObjectInfo[]> {
    this.validateKey(scope, scope === "");
    const prefixes = [
      "proxies/",
      "groups/",
      "vpns/",
      "extensions/",
      "extension_groups/",
      "tombstones/",
    ];
    const batches = await Promise.all([
      ...prefixes.map((prefix) => this.listAll(`${scope}${prefix}`)),
      this.listProfileSignals(`${scope}profiles/`),
    ]);
    return batches.flat();
  }

  async listProfileManifests(prefix: string): Promise<LocalObjectInfo[]> {
    this.validateKey(prefix.slice(0, -1));
    if (!prefix.endsWith("/")) throw new Error("Invalid profile prefix");
    const profileRoot = this.resolveUnder(this.objectsRoot, prefix);
    let entries;
    try {
      entries = await readdir(profileRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const keys = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${prefix}${entry.name}/manifest.json`);
    return (await Promise.all(keys.map((key) => this.head(key)))).filter(
      (value): value is LocalObjectInfo => value !== null,
    );
  }

  private async collectKeysForPrefix(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf("/");
    const directoryPrefix = slash >= 0 ? prefix.slice(0, slash + 1) : "";
    const scanRoot = this.resolveUnder(
      this.objectsRoot,
      directoryPrefix,
      directoryPrefix === "",
    );
    const keys: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }

      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const key = path
              .relative(this.objectsRoot, fullPath)
              .split(path.sep)
              .join("/");
            if (key.startsWith(prefix)) keys.push(key);
          }
        }),
      );
    };

    await walk(scanRoot);
    return keys;
  }

  private validateBundlePrefix(prefix: string): void {
    this.validateKey(prefix.slice(0, -1));
    if (!prefix.endsWith("/") || !/^profiles\/[^/]+\/files\/$/.test(prefix)) {
      throw new Error("Invalid profile bundle prefix");
    }
  }

  private validateBundlePath(value: string): string {
    const normalized = this.validateKey(value);
    if (Buffer.byteLength(normalized, "utf8") > 4096) {
      throw new Error("Bulk archive path is too long");
    }
    return normalized;
  }

  private async listProfileSignals(prefix: string): Promise<LocalObjectInfo[]> {
    const profileRoot = this.resolveUnder(this.objectsRoot, prefix);
    let entries;
    try {
      entries = await readdir(profileRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const keys: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".tar.gz")) {
        keys.push(`${prefix}${entry.name}`);
      } else if (entry.isDirectory()) {
        keys.push(
          `${prefix}${entry.name}/manifest.json`,
          `${prefix}${entry.name}/metadata.json`,
        );
      }
    }
    return (await Promise.all(keys.map((key) => this.head(key)))).filter(
      (value): value is LocalObjectInfo => value !== null,
    );
  }

  private async readMetadata(key: string): Promise<StoredMetadata | null> {
    try {
      const raw = await readFile(this.metadataPath(key), "utf8");
      return JSON.parse(raw) as StoredMetadata;
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async writeMetadata(
    key: string,
    metadata: StoredMetadata,
  ): Promise<void> {
    const destination = this.metadataPath(key);
    const temporary = path.join(this.temporaryRoot, randomUUID());
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify(metadata), {
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
      await rename(temporary, destination);
      await this.syncDirectory(path.dirname(destination));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async runForKey<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.validateKey(key);
    const previous = this.keyOperations.get(key) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.keyOperations.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.keyOperations.get(key) === tail) {
        this.keyOperations.delete(key);
      }
    }
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
      // Windows does not consistently allow opening directories. File fsync +
      // atomic rename still provide the strongest portable fallback there.
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
