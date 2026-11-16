import { ForbiddenException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import { Prisma, ProjectRole, UserRole, type Task } from '@dailytasks/database';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export type ProjectAccess = 'ADMIN' | 'MANAGER' | 'EMPLOYEE';
export type TaskAccess = 'ADMIN' | 'MANAGER' | 'ASSIGNEE';

/**
 * Single source of truth for authorization decisions.
 *
 * Rules:
 *  - COMPANY_ADMIN: everything inside their company.
 *  - Project MANAGER (active membership): their projects, all tasks in them.
 *  - Project EMPLOYEE (active membership): the project itself and ONLY tasks assigned to them.
 *  - Removed memberships (removedAt != null) grant nothing.
 *
 * Unauthorized access to a specific resource returns 404 (not 403) so ids cannot be probed (IDOR).
 * Memberships are read from the DB on every call; nothing is cached in tokens.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  isAdmin(user: AuthUser) {
    return user.role === UserRole.COMPANY_ADMIN;
  }

  async activeMemberships(userId: string) {
    return this.prisma.projectMembership.findMany({
      where: { userId, removedAt: null },
      select: { projectId: true, role: true },
    });
  }

  /** Project ids the user manages, or null meaning "all company projects" for admins. */
  async managedProjectIds(user: AuthUser): Promise<string[] | null> {
    if (this.isAdmin(user)) return null;
    const rows = await this.prisma.projectMembership.findMany({
      where: { userId: user.id, role: ProjectRole.MANAGER, removedAt: null, project: { companyId: user.companyId } },
      select: { projectId: true },
    });
    return rows.map((r) => r.projectId);
  }

  async projectAccess(user: AuthUser, projectId: string): Promise<ProjectAccess> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, companyId: user.companyId }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
    if (this.isAdmin(user)) return 'ADMIN';
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId, userId: user.id, removedAt: null } });
    if (!m) throw new NotFoundException('Project not found');
    return m.role === ProjectRole.MANAGER ? 'MANAGER' : 'EMPLOYEE';
  }

  /** Requires ADMIN or active MANAGER membership. Employees of the project get 403, outsiders 404. */
  async assertProjectManager(user: AuthUser, projectId: string): Promise<ProjectAccess> {
    const access = await this.projectAccess(user, projectId);
    if (access === 'EMPLOYEE') throw new ForbiddenException('Manager access required');
    return access;
  }

  /** Prisma filter selecting the projects visible to the user. */
  projectScope(user: AuthUser): Prisma.ProjectWhereInput {
    if (this.isAdmin(user)) return { companyId: user.companyId };
    return { companyId: user.companyId, memberships: { some: { userId: user.id, removedAt: null } } };
  }

  /** Prisma filter selecting the tasks visible to the user. */
  taskScope(user: AuthUser): Prisma.TaskWhereInput {
    if (this.isAdmin(user)) return { project: { companyId: user.companyId } };
    return {
      project: { companyId: user.companyId },
      OR: [
        { project: { memberships: { some: { userId: user.id, role: ProjectRole.MANAGER, removedAt: null } } } },
        { assigneeId: user.id, project: { memberships: { some: { userId: user.id, removedAt: null } } } },
      ],
    };
  }

  /** Loads a task and determines the caller's relationship to it; 404 if none. */
  async taskAccess(user: AuthUser, taskId: string): Promise<{ task: Task; access: TaskAccess }> {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, project: { companyId: user.companyId } } });
    if (!task) throw new NotFoundException('Task not found');
    if (this.isAdmin(user)) return { task, access: 'ADMIN' };
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId: task.projectId, userId: user.id, removedAt: null } });
    if (m?.role === ProjectRole.MANAGER) return { task, access: 'MANAGER' };
    if (m && task.assigneeId === user.id) return { task, access: 'ASSIGNEE' };
    throw new NotFoundException('Task not found');
  }

  async assertTaskManager(user: AuthUser, taskId: string) {
    const r = await this.taskAccess(user, taskId);
    if (r.access === 'ASSIGNEE') throw new ForbiddenException('Manager access required');
    return r;
  }

  async assertTaskAssignee(user: AuthUser, taskId: string) {
    const r = await this.taskAccess(user, taskId);
    if (r.access !== 'ASSIGNEE') throw new ForbiddenException('Only the assigned employee can do this');
    return r;
  }

  /** Validates that a user is an active EMPLOYEE member of the project and an active account. */
  async assertAssignable(projectId: string, userId: string) {
    const m = await this.prisma.projectMembership.findFirst({
      where: { projectId, userId, role: ProjectRole.EMPLOYEE, removedAt: null, user: { isActive: true } },
    });
    if (!m) throw new ForbiddenException('Assignee must be an active employee of this project');
  }

  /** Ratings & performance data: admins and project managers only. Employees are always refused. */
  assertCanViewRatings(user: AuthUser) {
    if (user.role === UserRole.EMPLOYEE) throw new ForbiddenException('Not allowed');
  }
}

@Global()
@Module({ providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
