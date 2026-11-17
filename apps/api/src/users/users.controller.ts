import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OutboxEventType, ProjectRole, UserRole, type Prisma, type User } from '@dailytasks/database';
import type { AuditEntryDto, CreatedUserDto, UserDto } from '@dailytasks/shared-types';
import { adminResetPasswordSchema, inviteUserSchema, updateUserSchema, userDepartmentsSchema, z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { AccessGate } from '../auth/access-gate';
import { IdentityService } from '../auth/identity.service';
import { AuthModule } from '../auth/auth.module';
import { audit } from '../common/audit';
import { badRequest, conflict, ErrorCode, forbidden, notFound } from '../common/errors';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';

type UserWithDepts = User & { departmentMemberships?: Array<{ isPrimary: boolean; department: { id: string; nameAr: string; nameEn: string } }> };

export const toUserDto = (u: UserWithDepts): UserDto => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  locale: u.locale === 'ar' ? 'ar' : 'en',
  isActive: u.isActive,
  createdAt: u.createdAt.toISOString(),
  mustChangePassword: u.mustChangePassword,
  ...(u.departmentMemberships
    ? { departments: u.departmentMemberships.map((m) => ({ id: m.department.id, nameAr: m.department.nameAr, nameEn: m.department.nameEn, isPrimary: m.isPrimary })) }
    : {}),
});

const deptInclude = { departmentMemberships: { where: { removedAt: null }, include: { department: true }, orderBy: { isPrimary: 'desc' } } } satisfies Prisma.UserInclude;

const listQuery = z.object({
  role: z.enum(['ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']).optional(),
  departmentId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
});

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly outbox: OutboxService,
    private readonly gate: AccessGate,
  ) {}

  /** Admins see everyone; project managers see users so they can view project staff. */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
  async list(@CurrentUser() user: AuthUser, @ZQuery(listQuery) query: z.infer<typeof listQuery>) {
    const users = await this.prisma.user.findMany({
      where: {
        companyId: user.companyId,
        role: query.role,
        ...(query.departmentId ? { departmentMemberships: { some: { departmentId: query.departmentId, removedAt: null } } } : {}),
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }] } : {}),
      },
      include: deptInclude,
      orderBy: { name: 'asc' },
    });
    return users.map(toUserDto);
  }

  /**
   * Admin-only account provisioning (role guard + company scoping; only an ADMIN can create another
   * ADMIN). The login is created in the identity provider with a temporary password the user must
   * replace at first sign-in. The plaintext is never stored and is returned at most once (SHOW_ONCE).
   */
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiZodBody(inviteUserSchema)
  async invite(@CurrentUser() user: AuthUser, @ZBody(inviteUserSchema) body: z.infer<typeof inviteUserSchema>): Promise<CreatedUserDto> {
    // Acceptance mode: only allow-listed testers can be provisioned (no ordinary employees, no invitation e-mails).
    if (!this.gate.allows(body.email)) {
      throw forbidden('The system is in restricted acceptance mode: only allow-listed test accounts can be created.', ErrorCode.ACCESS_RESTRICTED);
    }
    const exists = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw conflict(ErrorCode.CONFLICT, 'A user with this email already exists');
    await this.validateDepartments(user.companyId, body.departments.map((d) => d.departmentId));
    if (body.role === UserRole.EMPLOYEE && body.departments.length === 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Employees need at least one department');
    const projectIds = body.projects.map((p) => p.projectId);
    if (projectIds.length) {
      const n = await this.prisma.project.count({ where: { id: { in: projectIds }, companyId: user.companyId } });
      if (n !== new Set(projectIds).size) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown project');
      if (body.role === UserRole.EMPLOYEE && body.projects.some((p) => p.role === 'MANAGER')) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Employees cannot manage projects');
    }
    // Default: EMAIL in Cognito (password never seen by us); local mode only supports SHOW_ONCE.
    const delivery = body.passwordDelivery ?? (body.temporaryPassword ? undefined : this.identity.defaultDelivery());
    const { passwordHash, reveal } = await this.identity.provisionUser(body.email, delivery, body.temporaryPassword);
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { companyId: user.companyId, email: body.email, name: body.name, role: body.role, locale: body.locale, passwordHash, mustChangePassword: true, createdById: user.id },
      });
      if (body.departments.length) await tx.departmentMembership.createMany({ data: body.departments.map((d) => ({ departmentId: d.departmentId, userId: u.id, isPrimary: d.isPrimary })) });
      if (body.projects.length) {
        await tx.projectMembership.createMany({ data: body.projects.map((p) => ({ projectId: p.projectId, userId: u.id, role: p.role as ProjectRole })) });
      }
      await audit(tx, user, 'USER_CREATED', 'USER', u.id, {
        role: body.role,
        departments: body.departments.map((d) => d.departmentId),
        projects: body.projects,
        passwordDelivery: delivery ?? 'ADMIN_CHOSEN',
      });
      const admins = await tx.user.findMany({ where: { companyId: user.companyId, role: UserRole.ADMIN, isActive: true }, select: { id: true } });
      await this.outbox.notify(
        tx,
        OutboxEventType.USER_CREATED,
        u.id,
        { actorId: user.id, recipients: admins.map((a) => a.id), vars: { name: u.name }, url: '/users' },
        `USER_CREATED:${u.id}`,
      );
      return tx.user.findUniqueOrThrow({ where: { id: u.id }, include: deptInclude });
    });
    return { ...toUserDto(created), ...(reveal ? { temporaryPassword: reveal } : {}) };
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId }, include: deptInclude });
    if (!u) throw notFound('User not found');
    return toUserDto(u);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(updateUserSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(updateUserSchema) body: z.infer<typeof updateUserSchema>) {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw notFound('User not found');
    if (id === user.id && (body.isActive === false || (body.role && body.role !== UserRole.ADMIN))) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'You cannot deactivate or demote yourself');
    }
    if (body.role === UserRole.EMPLOYEE && target.role !== UserRole.EMPLOYEE) {
      const managing = await this.prisma.projectMembership.count({ where: { userId: id, role: ProjectRole.MANAGER, removedAt: null } });
      if (managing > 0) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Remove this user as project manager before changing the role to EMPLOYEE');
    }
    const activeChanged = body.isActive !== undefined && body.isActive !== target.isActive;
    if (activeChanged) {
      await this.identity.setUserEnabled(target.email, body.isActive!);
      if (!body.isActive) await this.identity.signOutEverywhere(target.email);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: { ...body, ...(activeChanged ? { deactivatedAt: body.isActive ? null : new Date() } : {}) },
        include: deptInclude,
      });
      if (activeChanged) await audit(tx, user, body.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'USER', id, {});
      if (body.role && body.role !== target.role) await audit(tx, user, 'USER_ROLE_CHANGED', 'USER', id, { from: target.role, to: body.role });
      if (body.name && body.name !== target.name) await audit(tx, user, 'USER_UPDATED', 'USER', id, { fields: ['name'] });
      return u;
    });
    return toUserDto(updated);
  }

  /** Replaces the user's department assignment (exactly one primary). History is kept via removedAt + audit. */
  @Put(':id/departments')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(userDepartmentsSchema)
  async setDepartments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(userDepartmentsSchema) body: z.infer<typeof userDepartmentsSchema>) {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw notFound('User not found');
    await this.validateDepartments(user.companyId, body.departments.map((d) => d.departmentId));
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.departmentMembership.findMany({ where: { userId: id, removedAt: null } });
      const wanted = new Map(body.departments.map((d) => [d.departmentId, d.isPrimary]));
      const now = new Date();
      // Clear primaries first so the "one primary" partial unique index is never violated mid-way.
      await tx.departmentMembership.updateMany({ where: { userId: id, isPrimary: true }, data: { isPrimary: false } });
      await tx.departmentMembership.updateMany({ where: { userId: id, removedAt: null, departmentId: { notIn: [...wanted.keys()] } }, data: { removedAt: now } });
      for (const [departmentId, isPrimary] of wanted) {
        if (isPrimary) continue;
        await this.upsertDept(tx, departmentId, id, false);
      }
      for (const [departmentId, isPrimary] of wanted) if (isPrimary) await this.upsertDept(tx, departmentId, id, true);
      await audit(tx, user, 'USER_DEPARTMENTS_CHANGED', 'USER', id, {
        from: before.map((m) => ({ departmentId: m.departmentId, isPrimary: m.isPrimary })),
        to: body.departments,
      });
      return tx.user.findUniqueOrThrow({ where: { id }, include: deptInclude });
    });
    return toUserDto(updated);
  }

  private upsertDept(tx: Tx, departmentId: string, userId: string, isPrimary: boolean) {
    return tx.departmentMembership.upsert({
      where: { departmentId_userId: { departmentId, userId } },
      create: { departmentId, userId, isPrimary },
      update: { isPrimary, removedAt: null },
    });
  }

  /** Account audit trail (admin only). */
  @Get(':id/audit')
  @Roles(UserRole.ADMIN)
  async auditTrail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<AuditEntryDto[]> {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw notFound('User not found');
    const rows = await this.prisma.auditLog.findMany({ where: { companyId: user.companyId, entityType: 'USER', entityId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const actors = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true, email: true } })).map((a) => [a.id, a]),
    );
    return rows.map((r) => ({ id: r.id, action: r.action, actor: r.actorId ? (actors.get(r.actorId) ?? null) : null, metadata: r.metadata as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
  }

  /** Admin resets a user's password; the user must set a new one at next sign-in. */
  @Post(':id/reset-password')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  @ApiZodBody(adminResetPasswordSchema)
  async resetPassword(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(adminResetPasswordSchema) body: z.infer<typeof adminResetPasswordSchema>) {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw notFound('User not found');
    const delivery = body.passwordDelivery ?? (body.temporaryPassword ? undefined : this.identity.defaultDelivery());
    const r = await this.identity.adminResetPassword(target.email, delivery, body.temporaryPassword);
    // A reset is often a response to a suspected compromise: revoke every existing session (Cognito
    // refresh tokens). Access tokens left alive are refused by the guard while mustChangePassword is set.
    await this.identity.signOutEverywhere(target.email);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { mustChangePassword: true, ...(r.passwordHash ? { passwordHash: r.passwordHash } : {}) } });
      await audit(tx, user, 'PASSWORD_RESET', 'USER', id, { mode: r.mode, delivery: delivery ?? 'ADMIN_CHOSEN' });
      await this.outbox.notify(tx, OutboxEventType.PASSWORD_CHANGE_REQUIRED, id, { actorId: user.id, recipients: [id], url: '/settings' }, `PASSWORD_CHANGE_REQUIRED:${id}:${Date.now()}`);
    });
    return { mode: r.mode, ...(r.reveal ? { temporaryPassword: r.reveal } : {}) };
  }

  private async validateDepartments(companyId: string, ids: string[]) {
    if (!ids.length) return;
    const n = await this.prisma.department.count({ where: { id: { in: ids }, companyId, isActive: true } });
    if (n !== new Set(ids).size) throw badRequest(ErrorCode.DEPARTMENT_INACTIVE, 'Unknown or inactive department');
  }
}

@Module({ imports: [AuthModule], controllers: [UsersController] })
export class UsersModule {}
