import { Module } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import { InternalController } from "./internal.controller.js";
import { LocalTransferController } from "./local-transfer.controller.js";
import { ProfileLockController } from "./profile-lock.controller.js";
import { ProfileLockService } from "./profile-lock.service.js";
import { SyncController } from "./sync.controller.js";
import { SyncService } from "./sync.service.js";

@Module({
  controllers: [
    SyncController,
    InternalController,
    LocalTransferController,
    ProfileLockController,
  ],
  providers: [SyncService, ProfileLockService, AuthGuard],
  exports: [SyncService],
})
export class SyncModule {}
