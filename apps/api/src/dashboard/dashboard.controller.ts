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
import { taskInclude, toTaskDto } from '../tasks/task.mapper';

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
    const managed = await this.access.managedProjectIds(user);
    // Employees: their own tasks. Managers/admins: tasks of projects they manage.
    const scope: Prisma.TaskWhereInput = isEmployee
      ? { ...this.access.taskScope(user), assigneeId: user.id }
      : managed === null
        ? { project: { companyId: user.companyId } }
        : { projectId: { in: managed } };
    const base: Prisma.TaskWhereInput = { AND: [scope, { archivedAt: null }] };

    const [projects, active, completed, overdue, upcoming] = await Promise.all([
      this.prisma.project.count({ where: { ...this.access.projectScope(user), status: 'ACTIVE' } }),
      this.prisma.task.count({ where: { AND: [base, { status: { not: TaskStatus.COMPLETED } }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: TaskStatus.COMPLETED }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: { not: TaskStatus.COMPLETED }, deadline: { lt: now } }] } }),
      this.prisma.task.findMany({
        where: { AND: [base, { status: { not: TaskStatus.COMPLETED } }] },
        include: taskInclude,
        orderBy: { deadline: 'asc' },
        take: 8,
      }),
    ]);

    let awaitingRating = 0;
    let performance: DashboardDto['performance'];
    if (!isEmployee) {
      const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM "Task" t
        JOIN "Project" p ON p."id" = t."projectId"
        LEFT JOIN "TaskRating" r ON r."taskId" = t."id"
        WHERE p."companyId" = ${user.companyId}::uuid
          AND t."status" = 'COMPLETED' AND t."archivedAt" IS NULL
          AND (r."id" IS NULL OR r."updatedAt" < t."completedAt")
          AND (${managed === null} OR t."projectId" = ANY(${managed ?? []}::uuid[]))`;
      awaitingRating = Number(rows[0]?.n ?? 0);
      performance = await this.ratings.employeeSummaries(user);
    }

    return {
      role: user.role,
      totals: { projects, activeTasks: active, completedTasks: completed, overdueTasks: overdue, awaitingRating },
      performance,
      upcoming: upcoming.map((t) => toTaskDto(t, !isEmployee)),
    };
  }
}

@Module({ imports: [RatingsModule], controllers: [DashboardController] })
export class DashboardModule {}
