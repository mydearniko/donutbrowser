import type { INestApplication } from "@nestjs/common";
import express from "express";

/** Keep object upload bodies as streams; parse JSON only on control routes. */
export function configureHttp(app: INestApplication): void {
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.set("trust proxy", 1);
  server.use("/v1/objects", express.json({ limit: "50mb" }));
  server.use("/v1/locks", express.json({ limit: "32kb" }));
  server.use("/v1/internal", express.json({ limit: "1mb" }));
  server.use("/v1/storage/download-bundle", express.json({ limit: "2mb" }));
}
