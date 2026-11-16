import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma, ProjectRole, UserRole, type Task } from '@dailytasks/database';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, ErrorCode, forbidden, notFound } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export type ProjectAccess = 'ADMIN' | 'MANAGER' | 'EMPLOYEE';
/**
 * ADMIN / MANAGER: full task management. ASSIGNEE: the current responsible employee.
 * PARTICIPANT: an employee in the task's transfer chain (delegator or former delegate) or the
 * target of a pending transfer — may view and act on their own chain steps only.
 */
export type TaskAccess = 'ADMIN' | 'MANAGER' | 'ASSIGNEE' | 'PARTICIPANT';

/**
 * Single source of truth for authorization decisions.
 *
 * Task visibility (company rule — every role):
 *  - A task is MANAGED by its creator and its approver. Project managers must still be an active
 *    MANAGER of the task's project; admins need no membership. Managers of the same project do NOT
 *    see each other's tasks, and the ADMIN role does not grant company-wide task visibility.
 *  - The responsible person (assignee — an employee, or an admin a manager assigned the task to)
 *    and transfer participants see the task while they are active members of its project.
 *  - Ratings of a task are visible only to the people managing it, never to its assignee.
 * Administration (accounts, departments, projects) remains company-wide for ADMIN.
 *  - Removed memberships (removedAt != null) grant nothing. Department membership alone never
 *    grants task visibility.
 *
 * Unauthorized access to a specific resource returns 404 (not 403) so ids cannot be probed (IDOR).
 * Memberships are read from the DB on every call; nothing is cached in tokens.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  isAdmin(user: AuthUser) {
    return user.role === UserRole.ADMIN;
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
    if (!project) throw notFound('Project not found');
    if (this.isAdmin(user)) return 'ADMIN';
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId, userId: user.id, removedAt: null } });
    if (!m) throw notFound('Project not found');
    return m.role === ProjectRole.MANAGER ? 'MANAGER' : 'EMPLOYEE';
  }

  /** Requires ADMIN or active MANAGER membership. Employees of the project get 403, outsiders 404. */
  async assertProjectManager(user: AuthUser, projectId: string): Promise<ProjectAccess> {
    const access = await this.projectAccess(user, projectId);
    if (access === 'EMPLOYEE') throw forbidden('Manager access required');
    return access;
  }

  /** Prisma filter selecting the projects visible to the user. */
  projectScope(user: AuthUser): Prisma.ProjectWhereInput {
    if (this.isAdmin(user)) return { companyId: user.companyId };
    return { companyId: user.companyId, memberships: { some: { userId: user.id, removedAt: null } } };
  }

  /**
   * Tasks the user MANAGES: created by them or awaiting/under their approval. PMs must still manage
   * the project; admins need no membership. Employees manage nothing.
   */
  managedTaskScope(user: AuthUser): Prisma.TaskWhereInput {
    if (user.role === UserRole.EMPLOYEE) return { id: { in: [] } };
    const mine: Prisma.TaskWhereInput = { OR: [{ createdById: user.id }, { approverId: user.id }] };
    if (this.isAdmin(user)) return { AND: [{ project: { companyId: user.companyId } }, mine] };
    return { AND: [{ project: { companyId: user.companyId, memberships: { some: { userId: user.id, role: ProjectRole.MANAGER, removedAt: null } } } }, mine] };
  }

  /** True when the user manages this task (see managedTaskScope) — used for rating visibility too. */
  async managesTask(user: AuthUser, task: Pick<Task, 'createdById' | 'approverId' | 'projectId'>): Promise<boolean> {
    if (user.role === UserRole.EMPLOYEE) return false;
    if (task.createdById !== user.id && task.approverId !== user.id) return false;
    if (this.isAdmin(user)) return true;
    const m = await this.prisma.projectMembership.count({ where: { projectId: task.projectId, userId: user.id, role: ProjectRole.MANAGER, removedAt: null } });
    return m > 0;
  }

  /** Synchronous check on a task already loaded within the caller's scope (lists). */
  canSeeRating(user: AuthUser, task: Pick<Task, 'createdById' | 'approverId' | 'assigneeId'>): boolean {
    return user.role !== UserRole.EMPLOYEE && task.assigneeId !== user.id && (task.createdById === user.id || task.approverId === user.id);
  }

  /** Prisma filter selecting the tasks visible to the user. */
  taskScope(user: AuthUser): Prisma.TaskWhereInput {
    const member = { project: { memberships: { some: { userId: user.id, removedAt: null } } } };
    return {
      project: { companyId: user.companyId },
      OR: [
        this.managedTaskScope(user),
        { assigneeId: user.id, ...member },
        // Transfer participants (delegators, delegates, pending recipients).
        {
          ...member,
          transfers: { some: { status: { in: ['ACCEPTED', 'PENDING'] }, OR: [{ fromUserId: user.id }, { toUserId: user.id }] } },
        },
      ],
    };
  }

  /** Loads a task and determines the caller's relationship to it; 404 if none. */
  async taskAccess(user: AuthUser, taskId: string): Promise<{ task: Task; access: TaskAccess }> {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, project: { companyId: user.companyId } } });
    if (!task) throw notFound('Task not found');
    if (await this.managesTask(user, task)) return { task, access: this.isAdmin(user) ? 'ADMIN' : 'MANAGER' };
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId: task.projectId, userId: user.id, removedAt: null } });
    if (m && task.assigneeId === user.id) return { task, access: 'ASSIGNEE' };
    if (m) {
      const involved = await this.prisma.taskTransfer.count({
        where: { taskId, status: { in: ['ACCEPTED', 'PENDING'] }, OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      });
      if (involved > 0) return { task, access: 'PARTICIPANT' };
    }
    throw notFound('Task not found');
  }

  async assertTaskManager(user: AuthUser, taskId: string) {
    const r = await this.taskAccess(user, taskId);
    if (r.access === 'ASSIGNEE' || r.access === 'PARTICIPANT') throw forbidden('Manager access required');
    return r;
  }

  async assertTaskAssignee(user: AuthUser, taskId: string) {
    const r = await this.taskAccess(user, taskId);
    if (r.access !== 'ASSIGNEE') throw forbidden('Only the responsible employee can do this');
    return r;
  }

  /**
   * The responsible person must be an active employee — or an admin added to the project as an
   * employee — of the project (and of the department when given). Project managers cannot be assignees.
   */
  async assertAssignable(projectId: string, userId: string, departmentId?: string | null) {
    const m = await this.prisma.projectMembership.findFirst({
      where: { projectId, userId, role: ProjectRole.EMPLOYEE, removedAt: null, user: { isActive: true, role: { in: [UserRole.EMPLOYEE, UserRole.ADMIN] } } },
    });
    if (!m) throw forbidden('Assignee must be an active employee of this project', ErrorCode.ASSIGNEE_NOT_ELIGIBLE);
    if (departmentId) {
      const d = await this.prisma.departmentMembership.findFirst({ where: { departmentId, userId, removedAt: null } });
      if (!d) throw badRequest(ErrorCode.ASSIGNEE_NOT_ELIGIBLE, 'Assignee must belong to the selected department');
    }
  }

  /** Department must exist in the caller's company; `requireActive` for new assignments. */
  async assertDepartment(user: AuthUser, departmentId: string, requireActive = true) {
    const d = await this.prisma.department.findFirst({ where: { id: departmentId, companyId: user.companyId } });
    if (!d) throw notFound('Department not found');
    if (requireActive && !d.isActive) throw badRequest(ErrorCode.DEPARTMENT_INACTIVE, 'Department is inactive');
    return d;
  }

  /** Approver must be an active ADMIN or an active MANAGER member of the task's project. */
  async assertValidApprover(companyId: string, projectId: string, approverId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: approverId, companyId, isActive: true } });
    if (!u) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Approver not found');
    if (u.role === UserRole.ADMIN) return;
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId, userId: approverId, role: ProjectRole.MANAGER, removedAt: null } });
    if (!m) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Approver must be an admin or a manager of the project');
  }

  /** Ratings & performance data: admins and project managers only. Employees are always refused. */
  assertCanViewRatings(user: AuthUser) {
    if (user.role === UserRole.EMPLOYEE) throw forbidden('Not allowed');
  }

}

@Global()
@Module({ providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
