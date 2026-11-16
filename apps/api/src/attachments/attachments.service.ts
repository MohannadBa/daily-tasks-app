import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES, INLINE_PREVIEW_TYPES, PRESIGNED_DOWNLOAD_TTL_SECONDS, PRESIGNED_UPLOAD_TTL_SECONDS } from '@dailytasks/config';
import { AttachmentStatus, OutboxEventType, TaskStatus, type TaskAttachment, type User } from '@dailytasks/database';
import type { AttachmentDto, DownloadUrlResponse, UploadUrlResponse } from '@dailytasks/shared-types';
import type { UploadRequestInput } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export const toAttachmentDto = (a: TaskAttachment & { uploadedBy: User }): AttachmentDto => ({
  id: a.id,
  fileName: a.fileName,
  contentType: a.contentType,
  sizeBytes: a.sizeBytes,
  uploadedBy: { id: a.uploadedBy.id, name: a.uploadedBy.name, email: a.uploadedBy.email },
  commentId: a.commentId,
  createdAt: a.createdAt.toISOString(),
});

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
  ) {}

  /** Step 1: validate and create a PENDING attachment with a random, non-guessable key. */
  async requestUpload(user: AuthUser, taskId: string, input: Required<UploadRequestInput>): Promise<UploadUrlResponse> {
    const { task, access } = await this.access.taskAccess(user, taskId);
    if (task.archivedAt) throw new BadRequestException('Task is archived');
    const storageKey = `tasks/${task.id}/${randomUUID()}`;
    const att = await this.prisma.taskAttachment.create({
      data: {
        taskId: task.id,
        // Manager files are task instructions; worker files are linked to a comment/submission later.
        kind: access === 'ADMIN' || access === 'MANAGER' ? 'INSTRUCTION' : 'COMMENT',
        uploadedById: user.id,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        storageKey,
      },
    });
    const { url, headers } = await this.storage.presignUpload(storageKey, input.contentType, input.sizeBytes, PRESIGNED_UPLOAD_TTL_SECONDS);
    return { attachmentId: att.id, uploadUrl: url, method: 'PUT', headers, expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS };
  }

  /** Step 3: verify the object really exists in S3 with the declared size before accepting it. */
  async confirm(user: AuthUser, attachmentId: string): Promise<AttachmentDto> {
    const att = await this.prisma.taskAttachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.uploadedById !== user.id) throw new NotFoundException('Attachment not found');
    const { task, access } = await this.access.taskAccess(user, att.taskId);
    if (att.status === AttachmentStatus.PENDING) {
      const head = await this.storage.head(att.storageKey);
      if (!head) throw new BadRequestException('File has not been uploaded yet');
      if (head.sizeBytes !== att.sizeBytes || head.sizeBytes > ATTACHMENT_MAX_BYTES) throw new BadRequestException('Uploaded file size mismatch');
      await this.prisma.$transaction(async (tx) => {
        await tx.taskAttachment.update({ where: { id: att.id }, data: { status: AttachmentStatus.UPLOADED, uploadedAt: new Date() } });
        // Manager instruction files are task-level; employee files are linked when they comment/complete.
        if (access === 'ADMIN' || access === 'MANAGER') {
          await tx.taskHistory.create({ data: { taskId: task.id, actorId: user.id, action: 'ATTACHMENT_ADDED', metadata: { attachmentId: att.id, fileName: att.fileName } } });
          if (task.status !== TaskStatus.COMPLETED) {
            await this.outbox.taskEvent(
              tx,
              OutboxEventType.TASK_UPDATED,
              { taskId: task.id, projectId: task.projectId, actorId: user.id, details: { change: 'attachment', fileName: att.fileName } },
              `TASK_UPDATED:attachment:${att.id}`,
            );
          }
        }
      });
    }
    const fresh = await this.prisma.taskAttachment.findUniqueOrThrow({ where: { id: att.id }, include: { uploadedBy: true } });
    return toAttachmentDto(fresh);
  }

  async downloadUrl(user: AuthUser, attachmentId: string, preview = false): Promise<DownloadUrlResponse & { inline: boolean }> {
    const att = await this.prisma.taskAttachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.status !== AttachmentStatus.UPLOADED) throw new NotFoundException('Attachment not found');
    await this.access.taskAccess(user, att.taskId); // 404 if the caller cannot see the task
    // Inline only for safe, renderable types (images/PDF); never HTML/SVG/text.
    const inline = preview && INLINE_PREVIEW_TYPES.includes(att.contentType);
    const url = await this.storage.presignDownload(att.storageKey, att.fileName, PRESIGNED_DOWNLOAD_TTL_SECONDS, inline);
    return { url, expiresIn: PRESIGNED_DOWNLOAD_TTL_SECONDS, inline };
  }

  /** All visible uploaded attachments of a task (task-level + linked to comments). */
  async listForTask(user: AuthUser, taskId: string): Promise<AttachmentDto[]> {
    const { task } = await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.taskAttachment.findMany({
      where: {
        taskId,
        status: AttachmentStatus.UPLOADED,
        OR: [{ commentId: { not: null } }, { uploadedById: { not: task.assigneeId } }, { uploadedById: user.id }],
      },
      include: { uploadedBy: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAttachmentDto);
  }

  /**
   * Links uploaded attachments to a comment inside the caller's transaction.
   * Each id must belong to this task, be uploaded by the author, be UPLOADED and not yet linked.
   */
  async linkToComment(tx: Tx, userId: string, taskId: string, commentId: string, attachmentIds: string[]) {
    if (attachmentIds.length === 0) return;
    const unique = Array.from(new Set(attachmentIds));
    const res = await tx.taskAttachment.updateMany({
      where: { id: { in: unique }, taskId, uploadedById: userId, status: AttachmentStatus.UPLOADED, commentId: null },
      data: { commentId },
    });
    if (res.count !== unique.length) throw new ForbiddenException('One or more attachments are invalid or not uploaded');
  }
}
