import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import {
  type ProfileLockInfo,
  type ProfileLockRequest,
  type ProfileLockResult,
  ProfileLockService,
} from "./profile-lock.service.js";

@Controller("v1/locks")
@UseGuards(AuthGuard)
export class ProfileLockController {
  constructor(private readonly profileLocks: ProfileLockService) {}

  @Get()
  list(): Promise<ProfileLockInfo[]> {
    return this.profileLocks.list();
  }

  @Post(":profileId")
  @HttpCode(200)
  acquire(
    @Param("profileId") profileId: string,
    @Body() request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    return this.profileLocks.acquire(profileId, request);
  }

  @Post(":profileId/heartbeat")
  @HttpCode(200)
  heartbeat(
    @Param("profileId") profileId: string,
    @Body() request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    return this.profileLocks.heartbeat(profileId, request);
  }

  @Delete(":profileId")
  release(
    @Param("profileId") profileId: string,
    @Body() request: ProfileLockRequest,
  ): Promise<ProfileLockResult> {
    return this.profileLocks.release(profileId, request);
  }
}
