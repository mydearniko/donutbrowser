import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const TEST_SYNC_TOKEN = "test-sync-token-0123456789abcdef";
let testDataDirectory: string | null = null;

export async function configureTestEnv(): Promise<string> {
  testDataDirectory = await mkdtemp(path.join(tmpdir(), "donut-sync-test-"));
  process.env.SYNC_TOKEN = TEST_SYNC_TOKEN;
  process.env.STORAGE_DRIVER = "local";
  process.env.DATA_DIR = testDataDirectory;
  delete process.env.S3_ENDPOINT;
  return testDataDirectory;
}

export async function cleanupTestEnv(): Promise<void> {
  if (testDataDirectory) {
    await rm(testDataDirectory, { recursive: true, force: true });
    testDataDirectory = null;
  }
}
