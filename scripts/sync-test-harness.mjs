#!/usr/bin/env node
/** Build the local-filesystem sync server and run the Rust protocol tests. */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const syncDirectory = path.join(rootDirectory, "donut-sync");
const dataDirectory = path.join(rootDirectory, ".cache", "sync-test", "data");
const syncPort = 3456;
const syncToken = "test-sync-token-0123456789abcdef";
const processes = [];

function log(message) {
  console.log(`[sync-harness] ${message}`);
}

async function buildServer() {
  log("Building donut-sync...");
  await rm(path.join(syncDirectory, "tsconfig.build.tsbuildinfo"), {
    force: true,
  });
  await rm(path.join(syncDirectory, "dist"), {
    recursive: true,
    force: true,
  });
  execSync("pnpm build", {
    cwd: syncDirectory,
    stdio: process.env.VERBOSE ? "inherit" : "ignore",
  });
  if (!existsSync(path.join(syncDirectory, "dist", "main.js"))) {
    throw new Error("donut-sync build did not produce dist/main.js");
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        http
          .get(url, (response) => {
            if (response.statusCode === 200) resolve();
            else reject(new Error(`Status ${response.statusCode}`));
          })
          .on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function startServer() {
  await rm(dataDirectory, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true });
  log(`Starting donut-sync on port ${syncPort}...`);
  const processHandle = spawn("node", ["dist/main.js"], {
    cwd: syncDirectory,
    env: {
      ...process.env,
      PORT: String(syncPort),
      SYNC_TOKEN: syncToken,
      STORAGE_DRIVER: "local",
      DATA_DIR: dataDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(processHandle);
  if (process.env.VERBOSE) {
    processHandle.stdout.on("data", (data) =>
      console.log(`[donut-sync] ${data.toString().trim()}`),
    );
    processHandle.stderr.on("data", (data) =>
      console.error(`[donut-sync] ${data.toString().trim()}`),
    );
  }
  await waitForHealth(`http://127.0.0.1:${syncPort}/readyz`, 30_000);
}

async function runTests() {
  log("Running Rust sync e2e tests...");
  return new Promise((resolve) => {
    const processHandle = spawn(
      "cargo",
      ["test", "--test", "sync_e2e", "--", "--test-threads=1"],
      {
        cwd: path.join(rootDirectory, "src-tauri"),
        env: {
          ...process.env,
          SYNC_SERVER_URL: `http://127.0.0.1:${syncPort}`,
          SYNC_TOKEN: syncToken,
        },
        stdio: "inherit",
      },
    );
    processHandle.on("close", (code) => resolve(code || 0));
  });
}

function cleanup() {
  for (const processHandle of processes) {
    try {
      if (os.platform() === "win32") {
        execSync(`taskkill /F /T /PID ${processHandle.pid}`, {
          stdio: "ignore",
        });
      } else {
        processHandle.kill("SIGTERM");
      }
    } catch {
      // The process already exited.
    }
  }
}

async function main() {
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    await buildServer();
    await startServer();
    const exitCode = await runTests();
    cleanup();
    process.exit(exitCode);
  } catch (error) {
    console.error(
      `[sync-harness] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    cleanup();
    process.exit(1);
  }
}

void main();
