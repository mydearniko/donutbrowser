import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { AppService } from "./app.service.js";
import { SyncService } from "./sync/sync.service.js";

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly syncService: SyncService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get("health")
  getHealth(): { status: string } {
    return { status: "ok" };
  }

  @Get("readyz")
  async getReadiness(): Promise<{
    status: string;
    storage: boolean;
    driver: "local" | "s3";
  }> {
    const storageReady = await this.syncService.checkStorageConnectivity();
    if (!storageReady) {
      throw new HttpException(
        {
          status: "not ready",
          storage: false,
          driver: this.syncService.getStorageDriver(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: "ready",
      storage: true,
      driver: this.syncService.getStorageDriver(),
    };
  }
}
