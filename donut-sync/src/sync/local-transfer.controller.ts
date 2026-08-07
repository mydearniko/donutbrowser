import { pipeline } from "node:stream/promises";
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { UserContext } from "../auth/user-context.interface.js";
import type {
  BulkDownloadRequestDto,
  BulkTransferResponseDto,
} from "./dto/sync.dto.js";
import { SyncService } from "./sync.service.js";

@Controller("v1/storage")
export class LocalTransferController {
  constructor(private readonly syncService: SyncService) {}

  private getUserContext(request: Request): UserContext {
    return (request as unknown as Record<string, unknown>).user as UserContext;
  }

  @Put("upload")
  async upload(
    @Query("ticket") ticket: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.syncService.acceptLocalUpload(ticket, request);
    response.status(204).end();
  }

  @Get("download")
  async download(
    @Query("ticket") ticket: string,
    @Res() response: Response,
  ): Promise<void> {
    const object = await this.syncService.resolveLocalDownload(ticket);
    response.setHeader("Content-Type", object.contentType);
    response.setHeader("Content-Length", object.size.toString());
    response.setHeader("Cache-Control", "private, no-store");
    await pipeline(object.stream, response);
  }

  @Put("upload-bundle")
  @UseGuards(AuthGuard)
  async uploadBundle(
    @Query("prefix") prefix: string,
    @Req() request: Request,
  ): Promise<BulkTransferResponseDto> {
    return this.syncService.acceptBulkUpload(
      prefix,
      request,
      this.getUserContext(request),
    );
  }

  @Post("download-bundle")
  @UseGuards(AuthGuard)
  async downloadBundle(
    @Body() dto: BulkDownloadRequestDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const archive = await this.syncService.createBulkDownload(
      dto,
      this.getUserContext(request),
    );
    response.setHeader("Content-Type", "application/gzip");
    response.setHeader("Cache-Control", "private, no-store");
    await pipeline(archive, response);
  }
}
