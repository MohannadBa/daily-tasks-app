import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, TaskStatus, UserRole } from '@dailytasks/database';
import type { DashboardDto } from '@dailytasks/shared-types';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RatingsModule } from '../ratings/ratings.controller';
import { RatingsService } from '../ratings/ratings.service';
import { overdueWhere, taskInclude, toTaskDto } from '../tasks/task.mapper';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly ratings: RatingsService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<DashboardDto> {
    const now = new Date();
    const isEmployee = user.role === UserRole.EMPLOYEE;
    // Employees: their own tasks. Managers/admins: tasks they created or approve (+ tasks assigned to them).
    const scope: Prisma.TaskWhereInput = isEmployee ? { ...this.access.taskScope(user), assigneeId: user.id } : this.access.taskScope(user);
    const base: Prisma.TaskWhereInput = { AND: [scope, { archivedAt: null }] };

    const in24h = new Date(now.getTime() + 24 * 3600_000);
    const [projects, active, completed, overdue, dueSoon, upcoming, activity] = await Promise.all([
      this.prisma.project.count({ where: { ...this.access.projectScope(user), status: 'ACTIVE' } }),
      this.prisma.task.count({ where: { AND: [base, { status: { not: TaskStatus.COMPLETED } }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: TaskStatus.COMPLETED }] } }),
      this.prisma.task.count({ where: { AND: [base, overdueWhere(now, this.prisma.task.fields.budgetMs)] } }),
      // Due soon = the running accountable clock reaches the budget within 24h (paused tasks are not "due").
      this.prisma.task.count({ where: { AND: [base, { status: { not: TaskStatus.COMPLETED }, effectiveDueAt: { gte: now, lte: in24h } }] } }),
      this.prisma.task.findMany({
        where: { AND: [base, { status: { not: TaskStatus.COMPLETED } }] },
        include: taskInclude,
        orderBy: { deadline: 'asc' },
        take: 8,
      }),
      // Employee-visible history only (rating audit lives elsewhere and is never included).
      this.prisma.taskHistory.findMany({
        where: { task: base },
        include: { actor: { select: { name: true } }, task: { select: { title: true, project: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const [inProgressTasks, pendingReviewTasks, toReview, rejectedSubmissions, incomingTransfers] = await Promise.all([
      this.prisma.task.count({ where: { AND: [base, { status: TaskStatus.IN_PROGRESS }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: TaskStatus.PENDING_REVIEW }] } }),
      this.prisma.taskSubmission.count({ where: { status: 'PENDING', reviewerId: user.id } }),
      this.prisma.task.count({
        where: { assigneeId: user.id, archivedAt: null, status: TaskStatus.IN_PROGRESS, submissions: { some: { submittedById: user.id, status: { in: ['REJECTED', 'RETURNED'] } } } },
      }),
      this.prisma.taskTransfer.count({ where: { toUserId: user.id, status: 'PENDING' } }),
    ]);

    let awaitingRating = 0;
    let performance: DashboardDto['performance'];
    let workload: DashboardDto['workload'];
    let admin: { employees?: number; departments?: number } = {};
    if (!isEmployee) {
      const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM "Task" t
        JOIN "Project" p ON p."id" = t."projectId"
        LEFT JOIN "TaskRating" r ON r."taskId" = t."id"
        WHERE p."companyId" = ${user.companyId}::uuid
          AND t."status" = 'COMPLETED' AND t."archivedAt" IS NULL
          AND (r."id" IS NULL OR r."updatedAt" < t."completedAt")
          AND t."assigneeId" <> ${user.id}::uuid
          AND (t."createdById" = ${user.id}::uuid OR t."approverId" = ${user.id}::uuid)
          AND (${user.role === UserRole.ADMIN} OR EXISTS (
            SELECT 1 FROM "ProjectMembership" m WHERE m."projectId" = t."projectId" AND m."userId" = ${user.id}::uuid AND m."role" = 'MANAGER' AND m."removedAt" IS NULL))`;
      awaitingRating = Number(rows[0]?.n ?? 0);
      performance = await this.ratings.employeeSummaries(user);
      // Workload: open / overdue / pending-review tasks per employee in scope (no rating data).
      const open = await this.prisma.task.findMany({
        where: { AND: [scope, { archivedAt: null, status: { not: TaskStatus.COMPLETED } }] },
        select: { assigneeId: true, status: true, id: true },
      });
      const overdueIds = new Set(
        (await this.prisma.task.findMany({ where: { AND: [scope, { archivedAt: null }, overdueWhere(now, this.prisma.task.fields.budgetMs)] }, select: { id: true } })).map((x) => x.id),
      );
      const agg = new Map<string, { open: number; overdue: number; pendingReview: number }>();
      for (const t of open) {
        if (t.assigneeId === user.id) continue; // my own assignments are not "team workload"
        const a = agg.get(t.assigneeId) ?? { open: 0, overdue: 0, pendingReview: 0 };
        a.open++;
        if (overdueIds.has(t.id)) a.overdue++;
        if (t.status === TaskStatus.PENDING_REVIEW) a.pendingReview++;
        agg.set(t.assigneeId, a);
      }
      const people = await this.prisma.user.findMany({ where: { id: { in: [...agg.keys()] } }, select: { id: true, name: true, email: true } });
      workload = people.map((p) => ({ employee: p, ...agg.get(p.id)! })).sort((a, b) => b.open - a.open);
      if (user.role === UserRole.ADMIN) {
        const [employees, departments] = await Promise.all([
          this.prisma.user.count({ where: { companyId: user.companyId, isActive: true, role: UserRole.EMPLOYEE } }),
          this.prisma.department.count({ where: { companyId: user.companyId, isActive: true } }),
        ]);
        admin = { employees, departments };
      }
    }

    return {
      role: user.role,
      totals: {
        projects,
        activeTasks: active,
        completedTasks: completed,
        overdueTasks: overdue,
        dueSoonTasks: dueSoon,
        awaitingRating,
        inProgressTasks,
        pendingReviewTasks,
        toReview,
        rejectedSubmissions,
        incomingTransfers,
        ...admin,
      },
      performance,
      workload,
      upcoming: upcoming.map((t) => toTaskDto(t, this.access.canSeeRating(user, t), now)),
      recentActivity: activity.map((h) => ({
        id: h.id,
        action: h.action,
        actorName: h.actor?.name ?? null,
        taskId: h.taskId,
        taskTitle: h.task.title,
        projectName: h.task.project.name,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }
}

@Module({ imports: [RatingsModule], controllers: [DashboardController] })
export class DashboardModule {}
