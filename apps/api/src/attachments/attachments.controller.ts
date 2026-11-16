import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { uploadRequestSchema, type z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { AttachmentsService } from './attachments.service';

@ApiTags('attachments')
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('tasks/:taskId/attachments/upload-url')
  @HttpCode(201)
  @ApiZodBody(uploadRequestSchema)
  requestUpload(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @ZBody(uploadRequestSchema) body: z.infer<typeof uploadRequestSchema>,
  ) {
    return this.attachments.requestUpload(user, taskId, body);
  }

  @Get('tasks/:taskId/attachments')
  list(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.attachments.listForTask(user, taskId);
  }

  @Post('attachments/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.confirm(user, id);
  }

  @Get('attachments/:id/download-url')
  downloadUrl(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.downloadUrl(user, id);
  }
}

@Module({ controllers: [AttachmentsController], providers: [AttachmentsService], exports: [AttachmentsService] })
export class AttachmentsModule {}
