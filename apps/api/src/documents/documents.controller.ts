import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES, INLINE_PREVIEW_TYPES, PRESIGNED_DOWNLOAD_TTL_SECONDS, PRESIGNED_UPLOAD_TTL_SECONDS } from '@dailytasks/config';
import { AttachmentStatus, OutboxEventType, ProjectRole, type Prisma } from '@dailytasks/database';
import type { DocumentCategoryDto, Paginated, ProjectDocumentDto } from '@dailytasks/shared-types';
import { documentListQuerySchema, documentUpdateSchema, documentUploadSchema, type z } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { audit } from '../common/audit';
import { badRequest, ErrorCode, forbidden, notFound } from '../common/errors';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const docInclude = {
  category: true,
  uploadedBy: { select: { id: true, name: true, email: true } },
  task: { select: { id: true, title: true } },
  department: { select: { id: true, nameAr: true, nameEn: true } },
  attachment: { select: { storageKey: true, status: true } },
} satisfies Prisma.ProjectDocumentInclude;
type DocRow = Prisma.ProjectDocumentGetPayload<{ include: typeof docInclude }>;


const toCategoryDto = (c: { id: string; code: string; nameAr: string; nameEn: string }): DocumentCategoryDto => ({ id: c.id, code: c.code, nameAr: c.nameAr, nameEn: c.nameEn });
const toDto = (d: DocRow): ProjectDocumentDto => ({
  id: d.id,
  projectId: d.projectId,
  title: d.title,
  description: d.description,
  category: toCategoryDto(d.category),
  source: d.source,
  visibility: d.visibility,
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  uploadedBy: d.uploadedBy,
  task: d.task,
  submissionId: d.submissionId,
  department: d.department,
  createdAt: d.createdAt.toISOString(),
});

/**
 * Project Documents Center. Visibility (enforced in every query, never in the client):
 *  - ADMIN / project MANAGER: every non-archived document of the project.
 *  - project EMPLOYEE: PROJECT_MEMBERS documents only.
 *  - anyone else: 404.
 * Task-sourced documents reuse the attachment's S3 object (no duplicate copy).
 * Personal tasks never produce documents (separate model, no relation).
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller()
export class DocumentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Manual documents: managers see all, members see "everyone" ones. Approved task deliverables kept
   * "managers only" are visible only to the people managing that task (its creator / approver), so a
   * manager never sees deliverables of another manager's tasks.
   */
  private async visibility(user: AuthUser, projectId: string): Promise<{ manager: boolean; where: Prisma.ProjectDocumentWhereInput }> {
    const access = await this.access.projectAccess(user, projectId); // 404 for non-members
    const manager = access !== 'EMPLOYEE';
    return {
      manager,
      where: {
        projectId,
        archivedAt: null,
        status: AttachmentStatus.UPLOADED,
        OR: [
          { visibility: 'PROJECT_MEMBERS' },
          ...(manager ? [{ source: 'MANUAL' as const, visibility: 'MANAGERS_ONLY' as const }] : []),
          { source: 'TASK_SUBMISSION' as const, visibility: 'MANAGERS_ONLY' as const, task: this.access.managedTaskScope(user) },
        ],
      },
    };
  }

  @Get('document-categories')
  async categories(@CurrentUser() user: AuthUser): Promise<DocumentCategoryDto[]> {
    const rows = await this.prisma.documentCategory.findMany({ where: { companyId: user.companyId, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }] });
    return rows.map(toCategoryDto);
  }

  @Get('projects/:projectId/documents')
  @ApiOperation({ summary: 'Search/filter project documents (paginated)' })
  async list(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @ZQuery(documentListQuerySchema) q: z.infer<typeof documentListQuerySchema>,
  ): Promise<Paginated<ProjectDocumentDto>> {
    const { where: base } = await this.visibility(user, projectId);
    const and: Prisma.ProjectDocumentWhereInput[] = [base];
    if (q.categoryId) and.push({ categoryId: q.categoryId });
    if (q.source) and.push({ source: q.source });
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.taskId) and.push({ taskId: q.taskId });
    if (q.uploadedById) and.push({ uploadedById: q.uploadedById });
    if (q.from) and.push({ createdAt: { gte: q.from } });
    if (q.to) and.push({ createdAt: { lte: q.to } });
    if (q.q) {
      and.push({
        OR: [
          { title: { contains: q.q, mode: 'insensitive' } },
          { description: { contains: q.q, mode: 'insensitive' } },
          { fileName: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    }
    const orderBy: Prisma.ProjectDocumentOrderByWithRelationInput[] = [
      q.sort === 'title' ? { title: 'asc' } : { createdAt: q.sort === 'created' ? 'asc' : 'desc' },
      { id: 'asc' },
    ];
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.projectDocument.findMany({ where, include: docInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.projectDocument.count({ where }),
    ]);
    return { items: rows.map(toDto), total, page: q.page, pageSize: q.pageSize };
  }

  /** Manual upload step 1 (managers/admins): PENDING row + pre-signed PUT (type + size signed). */
  @Post('projects/:projectId/documents/upload-url')
  @ApiZodBody(documentUploadSchema)
  async uploadUrl(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @ZBody(documentUploadSchema) body: z.infer<typeof documentUploadSchema>) {
    const { manager } = await this.visibility(user, projectId);
    if (!manager) throw forbidden('Only project managers can upload documents');
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    if (project.status !== 'ACTIVE') throw badRequest(ErrorCode.INVALID_STATE, 'Project is archived');
    const category = await this.prisma.documentCategory.findFirst({ where: { id: body.categoryId, companyId: user.companyId, isActive: true } });
    if (!category) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown category');
    const storageKey = `projects/${projectId}/documents/${randomUUID()}`;
    const doc = await this.prisma.projectDocument.create({
      data: {
        projectId,
        categoryId: category.id,
        title: body.title,
        description: body.description ?? null,
        source: 'MANUAL',
        visibility: body.visibility,
        storageKey,
        fileName: body.fileName,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        status: AttachmentStatus.PENDING,
        uploadedById: user.id,
      },
    });
    const { url, headers } = await this.storage.presignUpload(storageKey, body.contentType, body.sizeBytes, PRESIGNED_UPLOAD_TTL_SECONDS);
    return { documentId: doc.id, uploadUrl: url, method: 'PUT' as const, headers, expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS };
  }

  /** Manual upload step 3: HeadObject must match the declared size before the document is listed. */
  @Post('documents/:id/confirm')
  @HttpCode(200)
  async confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ProjectDocumentDto> {
    const doc = await this.prisma.projectDocument.findUnique({ where: { id } });
    if (!doc || doc.uploadedById !== user.id || doc.source !== 'MANUAL') throw notFound('Document not found');
    await this.visibility(user, doc.projectId);
    if (doc.status === AttachmentStatus.PENDING) {
      const head = await this.storage.head(doc.storageKey!);
      if (!head) throw badRequest(ErrorCode.INVALID_STATE, 'File has not been uploaded yet');
      if (head.sizeBytes !== doc.sizeBytes || head.sizeBytes > ATTACHMENT_MAX_BYTES) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Uploaded file size mismatch');
      await this.prisma.$transaction(async (tx) => {
        const r = await tx.projectDocument.updateMany({ where: { id, status: AttachmentStatus.PENDING }, data: { status: AttachmentStatus.UPLOADED } });
        if (r.count !== 1) return;
        await audit(tx, user, 'DOCUMENT_UPLOADED', 'DOCUMENT', id, { projectId: doc.projectId, fileName: doc.fileName });
        const recipients = (
          await tx.projectMembership.findMany({
            where: { projectId: doc.projectId, removedAt: null, ...(doc.visibility === 'MANAGERS_ONLY' ? { role: ProjectRole.MANAGER } : {}) },
            select: { userId: true },
          })
        ).map((m) => m.userId);
        await this.outbox.notify(
          tx,
          OutboxEventType.DOCUMENT_REGISTERED,
          id,
          { projectId: doc.projectId, actorId: user.id, recipients, vars: { name: doc.title }, url: `/projects/${doc.projectId}/documents` },
          `DOCUMENT_REGISTERED:${id}`,
        );
      });
    }
    return toDto(await this.prisma.projectDocument.findUniqueOrThrow({ where: { id }, include: docInclude }));
  }

  private async loadVisible(user: AuthUser, id: string) {
    const doc = await this.prisma.projectDocument.findUnique({ where: { id }, include: docInclude });
    if (!doc) throw notFound('Document not found');
    const v = await this.visibility(user, doc.projectId).catch(() => {
      throw notFound('Document not found');
    });
    const visible = await this.prisma.projectDocument.count({ where: { AND: [{ id }, v.where] } });
    if (!visible) throw notFound('Document not found'); // IDOR-safe
    return { doc, manager: v.manager };
  }

  @Get('documents/:id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return toDto((await this.loadVisible(user, id)).doc);
  }

  /** Short-lived pre-signed GET, issued only after the visibility check. */
  @Get('documents/:id/download-url')
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('preview') preview?: string) {
    const { doc } = await this.loadVisible(user, id);
    const inline = preview === 'true' && INLINE_PREVIEW_TYPES.includes(doc.contentType);
    const key = doc.source === 'MANUAL' ? doc.storageKey : doc.attachment?.status === AttachmentStatus.UPLOADED ? doc.attachment.storageKey : null;
    if (!key) throw notFound('Document not found');
    const url = await this.storage.presignDownload(key, doc.fileName, PRESIGNED_DOWNLOAD_TTL_SECONDS, inline);
    return { url, expiresIn: PRESIGNED_DOWNLOAD_TTL_SECONDS, inline };
  }

  @Patch('documents/:id')
  @ApiZodBody(documentUpdateSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(documentUpdateSchema) body: z.infer<typeof documentUpdateSchema>) {
    const { doc, manager } = await this.loadVisible(user, id);
    if (!manager) throw forbidden('Only project managers can edit documents');
    if (body.categoryId) {
      const c = await this.prisma.documentCategory.findFirst({ where: { id: body.categoryId, companyId: user.companyId, isActive: true } });
      if (!c) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown category');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.projectDocument.update({ where: { id }, data: body, include: docInclude });
      await audit(tx, user, 'DOCUMENT_UPDATED', 'DOCUMENT', id, {
        changes: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, { from: (doc as unknown as Record<string, unknown>)[k], to: v }])),
      });
      return u;
    });
    return toDto(updated);
  }

  /** Soft archive (the S3 object of task-sourced documents still backs the task attachment). */
  @Post('documents/:id/archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { manager } = await this.loadVisible(user, id);
    if (!manager) throw forbidden('Only project managers can archive documents');
    await this.prisma.$transaction(async (tx) => {
      await tx.projectDocument.update({ where: { id }, data: { archivedAt: new Date(), archivedById: user.id } });
      await audit(tx, user, 'DOCUMENT_ARCHIVED', 'DOCUMENT', id, {});
    });
  }
}

@Module({ controllers: [DocumentsController] })
export class DocumentsModule {}
