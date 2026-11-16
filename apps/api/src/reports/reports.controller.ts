import { Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PRESIGNED_DOWNLOAD_TTL_SECONDS, REPORT_JOBS_PER_HOUR, REPORT_MAX_TASKS, REPORT_RETENTION_DAYS } from '@dailytasks/config';
import { computeCycle, OutboxEventType, Prisma, TaskStatus, UserRole, type ReportDataset, type ReportJob, type ReportTask } from '@dailytasks/database';
import type { ReportJobDto } from '@dailytasks/shared-types';
import { reportRequestSchema, type z } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { AppError, badRequest, ErrorCode, forbidden, notFound } from '../common/errors';
import { ApiZodBody, ZBody } from '../common/zod';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { taskTime } from '../workflow/time-ledger.service';

type ReportRequest = z.infer<typeof reportRequestSchema>;
const person = (u: { name: string; email: string } | null | undefined) => (u ? { name: u.name, email: u.email } : { name: '—' });

const reportTaskInclude = {
  project: { select: { name: true } },
  department: { select: { nameAr: true, nameEn: true } },
  assignee: { select: { name: true, email: true } },
  approver: { select: { name: true, email: true } },
  createdBy: { select: { name: true, email: true } },
  rating: true,
  cycles: { orderBy: { cycleNo: 'asc' }, include: { segments: true } },
  submissions: { orderBy: { createdAt: 'asc' }, include: { submittedBy: { select: { name: true } }, comment: { select: { body: true } } } },
  transfers: { orderBy: { requestedAt: 'asc' }, include: { from: { select: { name: true } }, to: { select: { name: true } } } },
  extensions: { orderBy: { createdAt: 'asc' }, include: { requestedBy: { select: { name: true } } } },
} satisfies Prisma.TaskInclude;
type ReportTaskRow = Prisma.TaskGetPayload<{ include: typeof reportTaskInclude }>;

/**
 * Builds authorized report datasets and queues rendering (worker: HTML → PDF with headless
 * Chromium, RTL Arabic, embedded fonts). Authorization and rating gating happen here, at request
 * time; the worker never queries business data, so a report can never contain more than the
 * requester was allowed to see.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
  ) {}

  async request(user: AuthUser, input: ReportRequest): Promise<ReportJobDto> {
    const since = new Date(Date.now() - 3600_000);
    const recent = await this.prisma.reportJob.count({ where: { requestedById: user.id, createdAt: { gte: since } } });
    if (recent >= REPORT_JOBS_PER_HOUR) throw new AppError(429, ErrorCode.RATE_LIMITED, 'Too many reports requested; try again later');

    const dataset = await this.build(user, input);
    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.reportJob.create({
        data: {
          companyId: user.companyId,
          requestedById: user.id,
          type: input.type,
          params: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue,
          includesRatings: dataset.includesRatings,
          locale: input.locale,
          dataset: dataset as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + REPORT_RETENTION_DAYS * 86_400_000),
        },
      });
      await this.outbox.enqueue(tx, OutboxEventType.REPORT_RENDER, j.id, { reportId: j.id }, `REPORT_RENDER:${j.id}`);
      return j;
    });
    return toJobDto(job);
  }

  async get(user: AuthUser, id: string): Promise<ReportJobDto> {
    return toJobDto(await this.own(user, id));
  }

  async mine(user: AuthUser): Promise<ReportJobDto[]> {
    const rows = await this.prisma.reportJob.findMany({ where: { requestedById: user.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toJobDto);
  }

  async downloadUrl(user: AuthUser, id: string) {
    const job = await this.own(user, id);
    if (job.status !== 'READY' || !job.storageKey) throw badRequest(ErrorCode.INVALID_STATE, 'Report is not ready');
    const url = await this.storage.presignDownload(job.storageKey, `report-${job.type.toLowerCase()}-${job.id.slice(0, 8)}.pdf`, PRESIGNED_DOWNLOAD_TTL_SECONDS);
    return { url, expiresIn: PRESIGNED_DOWNLOAD_TTL_SECONDS };
  }

  /** Reports are private to their requester (no sharing by id). */
  private async own(user: AuthUser, id: string): Promise<ReportJob> {
    const job = await this.prisma.reportJob.findFirst({ where: { id, requestedById: user.id, companyId: user.companyId, expiresAt: { gt: new Date() } } });
    if (!job) throw notFound('Report not found');
    return job;
  }

  /* ------------------------------ datasets ------------------------------ */

  async build(user: AuthUser, input: ReportRequest): Promise<ReportDataset> {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { company: true } });
    const base = {
      version: 1 as const,
      type: input.type,
      locale: input.locale,
      generatedAt: new Date().toISOString(),
      generatedBy: person(me),
      companyName: me.company.name,
    };

    if (input.type === 'TASK') {
      const { task, access } = await this.access.taskAccess(user, input.taskId); // 404 when not visible
      const includesRatings = (access === 'ADMIN' || access === 'MANAGER') && this.access.canSeeRating(user, task);
      const row = await this.prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: reportTaskInclude });
      const detailed = await this.taskDetail(task.id);
      const t = { ...this.toReportTask(row, includesRatings, await this.nameMap([row])), ...detailed };
      return { ...base, includesRatings, filters: [], subject: { name: row.title, detail: row.project.name }, summary: this.summarize([t], includesRatings ? [row] : null), tasks: [t], truncated: false };
    }

    // Aggregate reports: managers (own projects) and admins only; employees may report on themselves.
    const managed = await this.access.managedProjectIds(user); // null = all (admin)
    let projectIds: string[] | null;
    let subject: ReportDataset['subject'];
    // Never more than the requester may see: the task scope (managed / assigned / transfer) always applies.
    const where: Prisma.TaskWhereInput[] = [this.access.taskScope(user), { archivedAt: null }, { createdAt: { lte: input.to } }, { OR: [{ completedAt: null }, { completedAt: { gte: input.from } }] }];

    if (input.type === 'EMPLOYEE') {
      const target = await this.prisma.user.findFirst({ where: { id: input.userId, companyId: user.companyId }, include: { departmentMemberships: { where: { removedAt: null }, include: { department: true } } } });
      if (!target) throw notFound('User not found');
      const self = target.id === user.id;
      if (user.role === UserRole.EMPLOYEE && !self) throw notFound('User not found');
      projectIds = input.projectIds?.length ? input.projectIds : managed;
      if (user.role === UserRole.EMPLOYEE) projectIds = null; // own tasks only, any project they worked on
      // Tasks the employee is accountable for, or worked on via a transfer.
      where.push({ OR: [{ assigneeId: target.id }, { transfers: { some: { toUserId: target.id, status: 'ACCEPTED' } } }, { segments: { some: { chargedToUserId: target.id } } }] });
      subject = { name: target.name, email: target.email, detail: target.departmentMemberships.map((m) => (input.locale === 'ar' ? m.department.nameAr : m.department.nameEn)).join('، ') };
    } else {
      if (user.role === UserRole.EMPLOYEE) throw forbidden('Managers only');
      projectIds = input.projectIds;
      const projects = await this.prisma.project.findMany({ where: { id: { in: projectIds }, companyId: user.companyId }, select: { id: true, name: true } });
      if (projects.length !== new Set(projectIds).size) throw notFound('Project not found');
      subject = { name: projects.map((p) => p.name).join('، ') };
    }
    if (projectIds && managed) {
      const outside = projectIds.filter((p) => !managed.includes(p));
      if (outside.length) throw notFound('Project not found'); // never reveal other projects
    }
    if (managed && !projectIds && user.role !== UserRole.EMPLOYEE) projectIds = managed;
    if (projectIds) where.push({ projectId: { in: projectIds } });
    if (input.departmentId) where.push({ departmentId: input.departmentId });
    if (input.status?.length) where.push({ status: { in: input.status as TaskStatus[] } });
    if (input.priority?.length) where.push({ priority: { in: input.priority } });
    if (input.timeliness === 'LATE') where.push({ status: TaskStatus.COMPLETED, completedLate: true });
    if (input.timeliness === 'ON_TIME') where.push({ status: TaskStatus.COMPLETED, completedLate: false });

    const rows = await this.prisma.task.findMany({ where: { AND: where }, include: reportTaskInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: REPORT_MAX_TASKS + 1 });
    const truncated = rows.length > REPORT_MAX_TASKS;
    const used = rows.slice(0, REPORT_MAX_TASKS);
    // Ratings only for projects the requester manages (or admin); never for employees.
    // Ratings only when the requester manages every included task (and none is their own).
    const includesRatings = user.role !== UserRole.EMPLOYEE && used.every((r) => this.access.canSeeRating(user, r));
    const names = await this.nameMap(used);
    const tasks = used.map((r) => this.toReportTask(r, includesRatings, names));
    const filters = [
      { key: 'from', value: input.from.toISOString() },
      { key: 'to', value: input.to.toISOString() },
      ...(input.status?.length ? [{ key: 'status', value: input.status.join(', ') }] : []),
      ...(input.priority?.length ? [{ key: 'priority', value: input.priority.join(', ') }] : []),
      ...(input.timeliness !== 'ALL' ? [{ key: 'timeliness', value: input.timeliness }] : []),
    ];
    return { ...base, includesRatings, filters, subject, summary: this.summarize(tasks, includesRatings ? used : null), tasks, truncated };
  }

  /** Names of everyone referenced by id in the rows (reviewers, deciders, charged employees). */
  private async nameMap(rows: ReportTaskRow[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const r of rows) {
      for (const c of r.cycles) for (const sg of c.segments) if (sg.chargedToUserId) ids.add(sg.chargedToUserId);
      for (const sb of r.submissions) for (const id of [sb.reviewerId, sb.decidedById]) if (id) ids.add(id);
      for (const x of r.extensions) if (x.decidedById) ids.add(x.decidedById);
    }
    const users = await this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toReportTask(r: ReportTaskRow, includesRatings: boolean, names: Map<string, string>): ReportTask {
    const now = new Date();
    const nm = (id: string | null) => (id ? (names.get(id) ?? '—') : null);
    const time = taskTime(r, r.cycles.at(-1) ?? null, now);
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      project: r.project.name,
      department: r.department ? `${r.department.nameAr} · ${r.department.nameEn}` : null,
      priority: r.priority,
      status: r.status,
      assignee: person(r.assignee),
      approver: person(r.approver),
      createdBy: person(r.createdBy),
      createdAt: r.createdAt.toISOString(),
      originalDeadline: r.originalDeadline.toISOString(),
      deadline: r.deadline.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      completedLate: r.completedLate,
      budgetMs: time.budgetMs,
      accountableMs: time.accountableMs,
      overdueMs: time.overdueMs,
      cycles: r.cycles.map((c) => {
        const comp = computeCycle(
          c.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt, charged: s.charged, chargedToUserId: s.chargedToUserId, responsibleUserId: s.responsibleUserId })),
          Math.max(0, c.approvedDeadline.getTime() - c.startedAt.getTime()),
          c.completedAt ?? now,
        );
        return {
          cycleNo: c.cycleNo,
          startedAt: c.startedAt.toISOString(),
          originalDeadline: c.originalDeadline.toISOString(),
          approvedDeadline: c.approvedDeadline.toISOString(),
          budgetMs: comp.budgetMs,
          accountableMs: c.accountableMs != null ? Number(c.accountableMs) : comp.accountableMs,
          lateMs: c.lateMs != null ? Number(c.lateMs) : comp.overdueMs,
          completedAt: c.completedAt?.toISOString() ?? null,
          completedLate: c.completedLate,
          reopenReason: c.reopenReason,
          perEmployee: Object.entries(comp.perUser).map(([id, v]) => ({ name: names.get(id) ?? '—', chargedMs: v.chargedMs, lateMs: v.lateMs })),
        };
      }),
      submissions: r.submissions.map((s) => ({
        createdAt: s.createdAt.toISOString(),
        by: s.submittedBy.name,
        stage: s.stage,
        status: s.status,
        reviewer: nm(s.reviewerId)!,
        decidedBy: nm(s.decidedById),
        decidedAt: s.decidedAt?.toISOString() ?? null,
        reason: s.decisionReason,
        comment: s.comment.body,
      })),
      transfers: r.transfers.map((t) => ({ requestedAt: t.requestedAt.toISOString(), from: t.from.name, to: t.to.name, reason: t.reason, status: t.status, respondedAt: t.respondedAt?.toISOString() ?? null, note: t.responseNote })),
      extensions: r.extensions.map((x) => ({
        createdAt: x.createdAt.toISOString(),
        by: x.requestedBy.name,
        reason: x.reason,
        requestedMinutes: x.requestedMinutes,
        status: x.status,
        grantedMinutes: x.grantedMinutes,
        previousDeadline: x.previousDeadline.toISOString(),
        newDeadline: x.newDeadline?.toISOString() ?? null,
        decidedBy: nm(x.decidedById),
        note: x.decisionNote,
      })),
      ...(includesRatings ? { rating: r.rating && r.status === TaskStatus.COMPLETED ? { stars: r.rating.stars, feedback: r.rating.feedback } : null } : {}),
    };
  }

  /** History, comments (with attachment names) and attachments for a single-task report. */
  private async taskDetail(taskId: string): Promise<Pick<ReportTask, 'history' | 'comments' | 'attachments'>> {
    const [history, comments, attachments] = await Promise.all([
      this.prisma.taskHistory.findMany({ where: { taskId }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.taskComment.findMany({ where: { taskId }, include: { author: { select: { name: true } }, attachments: { where: { status: 'UPLOADED' }, select: { fileName: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.taskAttachment.findMany({ where: { taskId, status: 'UPLOADED' }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    return {
      history: history.map((h) => ({ at: h.createdAt.toISOString(), action: h.action, actor: h.actor?.name ?? null })),
      comments: comments.map((c) => ({ at: c.createdAt.toISOString(), author: c.author.name, body: c.body, attachments: c.attachments.map((a) => a.fileName) })),
      attachments: attachments.map((a) => ({ fileName: a.fileName, sizeBytes: a.sizeBytes, uploadedBy: a.uploadedBy.name })),
    };
  }

  private summarize(tasks: ReportTask[], ratedRows: ReportTaskRow[] | null): ReportDataset['summary'] {
    const completed = tasks.filter((t) => t.status === 'COMPLETED');
    const ratings = ratedRows?.filter((r) => r.status === TaskStatus.COMPLETED && r.rating).map((r) => r.rating!.stars) ?? [];
    return {
      total: tasks.length,
      completed: completed.length,
      completedOnTime: completed.filter((t) => t.completedLate === false).length,
      completedLate: completed.filter((t) => t.completedLate === true).length,
      open: tasks.filter((t) => t.status !== 'COMPLETED').length,
      overdueOpen: tasks.filter((t) => t.status !== 'COMPLETED' && t.overdueMs > 0).length,
      pendingReview: tasks.filter((t) => t.status === 'PENDING_REVIEW').length,
      transfers: tasks.reduce((n, t) => n + t.transfers.length, 0),
      extensions: tasks.reduce((n, t) => n + t.extensions.length, 0),
      accountableMs: tasks.reduce((n, t) => n + t.accountableMs, 0),
      ...(ratedRows ? { averageRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null } : {}),
    };
  }
}

const toJobDto = (j: ReportJob): ReportJobDto => ({
  id: j.id,
  type: j.type,
  status: j.status,
  params: j.params as Record<string, unknown>,
  includesRatings: j.includesRatings,
  locale: j.locale === 'en' ? 'en' : 'ar',
  sizeBytes: j.sizeBytes,
  error: j.error,
  createdAt: j.createdAt.toISOString(),
  completedAt: j.completedAt?.toISOString() ?? null,
  expiresAt: j.expiresAt.toISOString(),
});

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('reports')
  @ApiOperation({ summary: 'Queue a PDF report (TASK, EMPLOYEE or PROJECTS). Poll GET /reports/:id.' })
  @ApiZodBody(reportRequestSchema)
  request(@CurrentUser() user: AuthUser, @ZBody(reportRequestSchema) body: ReportRequest) {
    return this.reports.request(user, body);
  }

  @Get('me/reports')
  mine(@CurrentUser() user: AuthUser) {
    return this.reports.mine(user);
  }

  @Get('reports/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(user, id);
  }

  @Get('reports/:id/download-url')
  download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.downloadUrl(user, id);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
