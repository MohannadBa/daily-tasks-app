import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectRole, TaskStatus } from '@dailytasks/database';
import type {
  EmployeePerformanceDetailDto,
  EmployeePerformanceSummaryDto,
  TaskRatingDto,
  TaskRatingRevisionDto,
} from '@dailytasks/shared-types';
import type { ratingSchema, z } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { overdueWhere } from '../tasks/task.mapper';

const summary = (u: { id: string; name: string; email: string }) => ({ id: u.id, name: u.name, email: u.email });
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ratings are private to company admins and authorized project managers.
 * Every method starts with an authorization check that rejects employees, and task-level
 * methods additionally require MANAGER/ADMIN access to the task's project.
 *
 * Average = sum(stars) / count(ratings) over ratings whose task is currently COMPLETED.
 * It is always computed from TaskRating rows; no average is stored.
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async getForTask(user: AuthUser, taskId: string): Promise<TaskRatingDto | null> {
    this.access.assertCanViewRatings(user);
    await this.access.assertTaskManager(user, taskId);
    const r = await this.prisma.taskRating.findUnique({ where: { taskId }, include: { employee: true, rater: true } });
    return r ? this.toDto(r) : null;
  }

  /** Create or edit the single rating of a completed task; every change is written to the audit trail. */
  async rate(user: AuthUser, taskId: string, input: z.infer<typeof ratingSchema>): Promise<TaskRatingDto> {
    this.access.assertCanViewRatings(user);
    const { task } = await this.access.assertTaskManager(user, taskId);
    if (task.status !== TaskStatus.COMPLETED) throw new BadRequestException('Only completed tasks can be rated');
    if (task.assigneeId === user.id) throw new ForbiddenException('You cannot rate your own task');
    const feedback = input.feedback?.trim() ? input.feedback.trim() : null;

    const rating = await this.prisma.$transaction(async (tx) => {
      // Row lock on the task serializes concurrent rate requests for the same task.
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
      const existing = await tx.taskRating.findUnique({ where: { taskId } });
      if (existing) {
        if (existing.stars === input.stars && existing.feedback === feedback) return existing;
        const updated = await tx.taskRating.update({ where: { id: existing.id }, data: { stars: input.stars, feedback, raterId: user.id } });
        await tx.taskRatingRevision.create({
          data: {
            ratingId: existing.id,
            changedById: user.id,
            previousStars: existing.stars,
            newStars: input.stars,
            previousFeedback: existing.feedback,
            newFeedback: feedback,
          },
        });
        return updated;
      }
      try {
        return await tx.taskRating.create({
          data: {
            taskId,
            employeeId: task.assigneeId,
            raterId: user.id,
            stars: input.stars,
            feedback,
            revisions: { create: { changedById: user.id, newStars: input.stars, newFeedback: feedback } },
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Task already rated');
        throw e;
      }
    });
    const full = await this.prisma.taskRating.findUniqueOrThrow({ where: { id: rating.id }, include: { employee: true, rater: true } });
    return this.toDto(full);
  }

  async employeeSummaries(user: AuthUser, projectId?: string): Promise<EmployeePerformanceSummaryDto[]> {
    this.access.assertCanViewRatings(user);
    const projectIds = await this.scopeProjectIds(user, projectId);
    const scope = this.taskScopeFor(user, projectIds);
    const employees = await this.prisma.user.findMany({
      where: {
        companyId: user.companyId,
        id: { not: user.id }, // nobody sees their own performance figures here
        memberships: { some: { role: ProjectRole.EMPLOYEE, removedAt: null, ...(projectIds ? { projectId: { in: projectIds } } : {}) } },
      },
      orderBy: { name: 'asc' },
    });
    return Promise.all(employees.map((e) => this.summaryFor(e, scope)));
  }

  async employeeDetail(user: AuthUser, employeeId: string, projectId?: string): Promise<EmployeePerformanceDetailDto> {
    this.access.assertCanViewRatings(user);
    const projectIds = await this.scopeProjectIds(user, projectId);
    if (employeeId === user.id) throw new NotFoundException('Employee not found'); // own ratings stay private
    const scope = this.taskScopeFor(user, projectIds);
    const employee = await this.prisma.user.findFirst({
      where: {
        id: employeeId,
        companyId: user.companyId,
        // Must be (or have been) an employee in one of the caller's projects.
        ...(projectIds ? { memberships: { some: { role: ProjectRole.EMPLOYEE, projectId: { in: projectIds } } } } : {}),
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const taskFilter: Prisma.TaskWhereInput = { AND: [{ status: TaskStatus.COMPLETED }, scope] };
    const [base, ratings, revisions] = await Promise.all([
      this.summaryFor(employee, scope),
      this.prisma.taskRating.findMany({
        where: { employeeId, task: taskFilter },
        include: { rater: true, task: { include: { project: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.taskRatingRevision.findMany({
        where: { rating: { employeeId, task: scope } },
        include: { changedBy: true, rating: { include: { task: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);
    const memberships = await this.prisma.projectMembership.findMany({
      where: { userId: employeeId, ...(projectIds ? { projectId: { in: projectIds } } : {}) },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { project: { name: 'asc' } },
    });
    return {
      ...base,
      projects: memberships.map((m) => ({ id: m.project.id, name: m.project.name, role: m.role, removed: m.removedAt !== null })),
      departments: (
        await this.prisma.departmentMembership.findMany({ where: { userId: employeeId, removedAt: null }, include: { department: true }, orderBy: { isPrimary: 'desc' } })
      ).map((m) => ({ id: m.department.id, nameAr: m.department.nameAr, nameEn: m.department.nameEn, isPrimary: m.isPrimary })),
      ratings: ratings.map((r) => ({
        taskId: r.taskId,
        taskTitle: r.task.title,
        projectId: r.task.projectId,
        projectName: r.task.project.name,
        stars: r.stars,
        feedback: r.feedback,
        ratedBy: summary(r.rater),
        completedAt: r.task.completedAt?.toISOString() ?? null,
        completedLate: r.task.completedLate,
        ratedAt: r.updatedAt.toISOString(),
      })),
      history: revisions.map(
        (v): TaskRatingRevisionDto => ({
          id: v.id,
          taskId: v.rating.taskId,
          taskTitle: v.rating.task.title,
          changedBy: summary(v.changedBy),
          previousStars: v.previousStars,
          newStars: v.newStars,
          previousFeedback: v.previousFeedback,
          newFeedback: v.newFeedback,
          createdAt: v.createdAt.toISOString(),
        }),
      ),
    };
  }

  /**
   * Tasks whose ratings/figures the caller may see: tasks they manage (created / approve), optionally
   * narrowed to projects. A manager never sees figures from another manager's tasks.
   */
  private taskScopeFor(user: AuthUser, projectIds: string[] | null): Prisma.TaskWhereInput {
    return { AND: [this.access.managedTaskScope(user), ...(projectIds ? [{ projectId: { in: projectIds } }] : [])] };
  }

  /** Average and counts for one employee over the given task scope. */
  async summaryFor(employee: { id: string; name: string; email: string }, inScope: Prisma.TaskWhereInput): Promise<EmployeePerformanceSummaryDto> {
    const now = new Date();
    const [agg, completed, open, overdue] = await Promise.all([
      this.prisma.taskRating.aggregate({
        where: { employeeId: employee.id, task: { AND: [{ status: TaskStatus.COMPLETED, assigneeId: employee.id }, inScope] } },
        _avg: { stars: true },
        _count: { _all: true },
      }),
      this.prisma.task.count({ where: { AND: [{ assigneeId: employee.id, status: TaskStatus.COMPLETED }, inScope] } }),
      this.prisma.task.count({ where: { AND: [{ assigneeId: employee.id, status: { not: TaskStatus.COMPLETED } }, inScope] } }),
      this.prisma.task.count({ where: { AND: [{ assigneeId: employee.id }, inScope, overdueWhere(now, this.prisma.task.fields.budgetMs)] } }),
    ]);
    return {
      employee: summary(employee),
      averageRating: agg._count._all > 0 && agg._avg.stars !== null ? round2(agg._avg.stars) : null,
      ratedTaskCount: agg._count._all,
      completedTaskCount: completed,
      openTaskCount: open,
      overdueTaskCount: overdue,
    };
  }

  /** null = all projects (admin without filter). Otherwise the list of projects the caller may see ratings for. */
  async scopeProjectIds(user: AuthUser, projectId?: string): Promise<string[] | null> {
    const managed = await this.access.managedProjectIds(user);
    if (projectId) {
      await this.access.assertProjectManager(user, projectId);
      return [projectId];
    }
    return managed;
  }

  private toDto(r: Prisma.TaskRatingGetPayload<{ include: { employee: true; rater: true } }>): TaskRatingDto {
    return {
      id: r.id,
      taskId: r.taskId,
      stars: r.stars,
      feedback: r.feedback,
      employee: summary(r.employee),
      ratedBy: summary(r.rater),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
