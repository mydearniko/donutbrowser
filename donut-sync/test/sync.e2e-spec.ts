import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { AppController } from "./../src/app.controller.js";
import { AppService } from "./../src/app.service.js";
import { configureHttp } from "./../src/http-config.js";
import { SyncModule } from "./../src/sync/sync.module.js";
import {
  cleanupTestEnv,
  configureTestEnv,
  TEST_SYNC_TOKEN,
} from "./test-env.js";

interface PresignResponse {
  url: string;
  expiresAt: string;
  metadata?: Record<string, string>;
}

interface ListResponse {
  objects: Array<{ key: string; lastModified: string; size: number }>;
  isTruncated: boolean;
  nextContinuationToken?: string;
}

interface DeleteResponse {
  deleted: boolean;
  tombstoneCreated: boolean;
}

interface StatResponse {
  exists: boolean;
  size?: number;
  lastModified?: string;
  metadata?: Record<string, string>;
}

interface LockResponse {
  success: boolean;
  lock?: {
    profileId: string;
    lockedBy: string;
    lockedByEmail: string;
    expiresAt: string;
  };
  lockedBy?: string;
  lockedByEmail?: string;
}

describe("SyncController (e2e)", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    await configureTestEnv();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        SyncModule,
      ],
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureHttp(app);
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestEnv();
  });

  describe("Authentication", () => {
    it("should reject requests without authorization header", () => {
      return request(app.getHttpServer())
        .post("/v1/objects/stat")
        .send({ key: "test-key" })
        .expect(401);
    });

    it("should reject requests with invalid token", () => {
      return request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", "Bearer invalid-token")
        .send({ key: "test-key" })
        .expect(401);
    });

    it("should accept requests with valid token", () => {
      return request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: "nonexistent-key" })
        .expect(200)
        .expect({ exists: false });
    });
  });

  describe("POST /v1/objects/stat", () => {
    it("should return exists: false for non-existent key", () => {
      return request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: "does-not-exist" })
        .expect(200)
        .expect({ exists: false });
    });
  });

  describe("POST /v1/objects/presign-upload", () => {
    it("should return a presigned upload URL", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/objects/presign-upload")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: "test/upload-key.txt", contentType: "text/plain" })
        .expect(200);

      const body = response.body as PresignResponse;
      expect(body.url).toBeDefined();
      expect(body.url).toContain("/v1/storage/upload");
      expect(body.expiresAt).toBeDefined();
    });
  });

  describe("POST /v1/objects/presign-download", () => {
    it("should return a presigned download URL", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/objects/presign-download")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: "test/download-key.txt" })
        .expect(200);

      const body = response.body as PresignResponse;
      expect(body.url).toBeDefined();
      expect(body.url).toContain("/v1/storage/download");
      expect(body.expiresAt).toBeDefined();
    });
  });

  describe("POST /v1/objects/list", () => {
    it("should list objects with prefix", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/objects/list")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ prefix: "profiles/" })
        .expect(200);

      const body = response.body as ListResponse;
      expect(body.objects).toBeDefined();
      expect(Array.isArray(body.objects)).toBe(true);
      expect(body.isTruncated).toBeDefined();
    });
  });

  describe("POST /v1/objects/delete", () => {
    it("should delete object and create tombstone", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/objects/delete")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({
          key: "test/to-delete.txt",
          tombstoneKey: "tombstones/test/to-delete.json",
          deletedAt: new Date().toISOString(),
        })
        .expect(200);

      const body = response.body as DeleteResponse;
      expect(body.deleted).toBeDefined();
      expect(body.tombstoneCreated).toBe(true);
    });
  });

  describe("POST /v1/objects/delete-prefix", () => {
    it("refuses an empty prefix instead of wiping the mounted data directory", () => {
      return request(app.getHttpServer())
        .post("/v1/objects/delete-prefix")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ prefix: "" })
        .expect(403);
    });
  });

  describe("Full upload/download cycle", () => {
    const testKey = `test/e2e-cycle-${Date.now()}.txt`;
    const testContent = "Hello from e2e test!";

    it("should complete full upload/download cycle with presigned URLs", async () => {
      const uploadResponse = await request(app.getHttpServer())
        .post("/v1/objects/presign-upload")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: testKey, contentType: "text/plain" })
        .expect(200);

      const uploadBody = uploadResponse.body as PresignResponse;
      expect(uploadBody.url).toBeDefined();

      const uploadResult = await fetch(uploadBody.url, {
        method: "PUT",
        body: testContent,
        headers: { "Content-Type": "text/plain" },
      });
      expect(uploadResult.ok).toBe(true);

      const statResponse = await request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: testKey })
        .expect(200);

      const statBody = statResponse.body as StatResponse;
      expect(statBody.exists).toBe(true);
      expect(statBody.size).toBeGreaterThan(0);

      const downloadResponse = await request(app.getHttpServer())
        .post("/v1/objects/presign-download")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: testKey })
        .expect(200);

      const downloadBody = downloadResponse.body as PresignResponse;
      const downloadResult = await fetch(downloadBody.url);
      expect(downloadResult.ok).toBe(true);

      const downloadedContent = await downloadResult.text();
      expect(downloadedContent).toBe(testContent);

      await request(app.getHttpServer())
        .post("/v1/objects/delete")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: testKey })
        .expect(200);

      const finalStatResponse = await request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: testKey })
        .expect(200);

      const finalStatBody = finalStatResponse.body as StatResponse;
      expect(finalStatBody.exists).toBe(false);
    });

    it("atomically keeps object metadata with the winning write", async () => {
      const key = `test/atomic-metadata-${Date.now()}.json`;
      const writes = [
        { id: "first", timestamp: "101", manifestHash: "manifest-first" },
        { id: "second", timestamp: "202", manifestHash: "manifest-second" },
      ];
      const presigns = await Promise.all(
        writes.map(async (write) => {
          const response = await request(app.getHttpServer())
            .post("/v1/objects/presign-upload")
            .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
            .send({
              key,
              contentType: "application/json",
              metadata: {
                "updated-at": write.timestamp,
                "manifest-hash": write.manifestHash,
              },
            })
            .expect(200);
          return response.body as PresignResponse;
        }),
      );

      await Promise.all(
        presigns.map((presign, index) =>
          fetch(presign.url, {
            method: "PUT",
            body: JSON.stringify(writes[index]),
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const statResponse = await request(app.getHttpServer())
        .post("/v1/objects/stat")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key })
        .expect(200);
      const downloadResponse = await request(app.getHttpServer())
        .post("/v1/objects/presign-download")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key })
        .expect(200);
      const downloaded = (await (
        await fetch((downloadResponse.body as PresignResponse).url)
      ).json()) as (typeof writes)[number];
      expect((statResponse.body as StatResponse).metadata?.["updated-at"]).toBe(
        downloaded.timestamp,
      );
      expect(
        (statResponse.body as StatResponse).metadata?.["manifest-hash"],
      ).toBe(downloaded.manifestHash);
    });
  });

  describe("Profile leases", () => {
    const profileId = `profile-lock-${Date.now()}`;
    const ownerA = { ownerId: "device-a", ownerLabel: "Device A" };
    const ownerB = { ownerId: "device-b", ownerLabel: "Device B" };

    it("keeps one owner until the lease is released", async () => {
      const acquired = await request(app.getHttpServer())
        .post(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerA)
        .expect(200);
      expect((acquired.body as LockResponse).success).toBe(true);
      expect((acquired.body as LockResponse).lock?.lockedBy).toBe(
        ownerA.ownerId,
      );

      const repeated = await request(app.getHttpServer())
        .post(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerA)
        .expect(200);
      expect((repeated.body as LockResponse).success).toBe(true);
      expect((repeated.body as LockResponse).lock?.expiresAt).toBe(
        (acquired.body as LockResponse).lock?.expiresAt,
      );

      const rejected = await request(app.getHttpServer())
        .post(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerB)
        .expect(200);
      expect((rejected.body as LockResponse).success).toBe(false);
      expect((rejected.body as LockResponse).lockedByEmail).toBe(
        ownerA.ownerLabel,
      );

      const locks = await request(app.getHttpServer())
        .get("/v1/locks")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .expect(200);
      expect(locks.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profileId,
            lockedBy: ownerA.ownerId,
          }),
        ]),
      );

      const heartbeat = await request(app.getHttpServer())
        .post(`/v1/locks/${profileId}/heartbeat`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerA)
        .expect(200);
      expect((heartbeat.body as LockResponse).success).toBe(true);

      const wrongRelease = await request(app.getHttpServer())
        .delete(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerB)
        .expect(200);
      expect((wrongRelease.body as LockResponse).success).toBe(false);

      const release = await request(app.getHttpServer())
        .delete(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerA)
        .expect(200);
      expect((release.body as LockResponse).success).toBe(true);

      const nextOwner = await request(app.getHttpServer())
        .post(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerB)
        .expect(200);
      expect((nextOwner.body as LockResponse).success).toBe(true);

      await request(app.getHttpServer())
        .delete(`/v1/locks/${profileId}`)
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send(ownerB)
        .expect(200);
    });
  });

  describe("GET /v1/objects/subscribe (SSE)", () => {
    it("should reject SSE without authorization", () => {
      return request(app.getHttpServer())
        .get("/v1/objects/subscribe")
        .expect(401);
    });

    it("should return SSE stream with valid token", async () => {
      const address = (
        app.getHttpServer() as Server
      ).address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("Expected app to be listening on a TCP port");
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/objects/subscribe`,
        {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${TEST_SYNC_TOKEN}`,
            "X-Donut-Sync-Client": "realtime-observer",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      await response.body?.cancel();
    });

    it("publishes an atomic upload without a polling delay", async () => {
      const address = (
        app.getHttpServer() as Server
      ).address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("Expected app to be listening on a TCP port");
      }

      const seedKey = `groups/realtime-seed-${Date.now()}.json`;
      const seedPresign = await request(app.getHttpServer())
        .post("/v1/objects/presign-upload")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .send({ key: seedKey, contentType: "application/json" })
        .expect(200);
      await fetch((seedPresign.body as PresignResponse).url, {
        method: "PUT",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });

      const abort = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/objects/subscribe`,
        {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${TEST_SYNC_TOKEN}`,
          },
          signal: abort.signal,
        },
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const targetKey = `profiles/realtime-${Date.now()}/manifest.json`;
      const uploadPresign = await request(app.getHttpServer())
        .post("/v1/objects/presign-upload")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .set("X-Donut-Sync-Client", "realtime-writer")
        .send({ key: targetKey, contentType: "application/json" })
        .expect(200);

      const startedAt = Date.now();
      const upload = await fetch((uploadPresign.body as PresignResponse).url, {
        method: "PUT",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });
      expect(upload.ok).toBe(true);

      const decoder = new TextDecoder();
      let received = "";
      const deadline = Date.now() + 1500;
      while (!received.includes(targetKey) && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader?.read(),
          new Promise<undefined>(
            (resolve) =>
              (timeout = setTimeout(() => resolve(undefined), remaining)),
          ),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!result) break;
        if (result?.done) break;
        if (result?.value) received += decoder.decode(result.value);
      }

      await reader?.cancel();
      abort.abort();
      expect(received).toContain(targetKey);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    });

    it("does not echo a completed upload to its source client", async () => {
      const address = (
        app.getHttpServer() as Server
      ).address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("Expected app to be listening on a TCP port");
      }

      const sourceId = "same-source-client";
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/objects/subscribe`,
        {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${TEST_SYNC_TOKEN}`,
            "X-Donut-Sync-Client": sourceId,
          },
        },
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const targetKey = `profiles/no-echo-${Date.now()}/manifest.json`;
      const uploadPresign = await request(app.getHttpServer())
        .post("/v1/objects/presign-upload")
        .set("Authorization", `Bearer ${TEST_SYNC_TOKEN}`)
        .set("X-Donut-Sync-Client", sourceId)
        .send({ key: targetKey, contentType: "application/json" })
        .expect(200);
      await fetch((uploadPresign.body as PresignResponse).url, {
        method: "PUT",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });

      const decoder = new TextDecoder();
      let received = "";
      const deadline = Date.now() + 300;
      while (Date.now() < deadline) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader?.read(),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(
              () => resolve(undefined),
              deadline - Date.now(),
            );
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!result) break;
        if (result.done) break;
        if (result.value) received += decoder.decode(result.value);
      }

      await reader?.cancel();
      expect(received).not.toContain(targetKey);

      const reconnect = await fetch(
        `http://127.0.0.1:${address.port}/v1/objects/subscribe`,
        {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${TEST_SYNC_TOKEN}`,
            "X-Donut-Sync-Client": sourceId,
          },
        },
      );
      const reconnectReader = reconnect.body?.getReader();
      let initial = "";
      const reconnectDeadline = Date.now() + 300;
      while (Date.now() < reconnectDeadline) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reconnectReader?.read(),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(
              () => resolve(undefined),
              reconnectDeadline - Date.now(),
            );
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!result || result.done) break;
        if (result.value) initial += decoder.decode(result.value);
      }
      await reconnectReader?.cancel();
      expect(initial).not.toContain(targetKey);
    });
  });
});
