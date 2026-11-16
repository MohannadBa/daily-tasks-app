import { Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectRole, UserRole, type Department } from '@dailytasks/database';
import type { DepartmentDto, DepartmentMemberDto } from '@dailytasks/shared-types';
import { assignableQuerySchema, createDepartmentSchema, updateDepartmentSchema, z } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { audit } from '../common/audit';
import { conflict, ErrorCode, notFound } from '../common/errors';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

const toDto = (d: Department & { _count?: { memberships: number } }): DepartmentDto => ({
  id: d.id,
  code: d.code,
  nameAr: d.nameAr,
  nameEn: d.nameEn,
  isActive: d.isActive,
  sortOrder: d.sortOrder,
  memberCount: d._count?.memberships ?? 0,
});
const countActive = { _count: { select: { memberships: { where: { removedAt: null } } } } } as const;
const listQuery = z.object({ includeInactive: z.coerce.boolean().optional() });

@ApiTags('departments')
@ApiBearerAuth()
@Controller()
export class DepartmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Every signed-in user can read the department catalogue (names only). */
  @Get('departments')
  async list(@CurrentUser() user: AuthUser, @ZQuery(listQuery) q: z.infer<typeof listQuery>) {
    const rows = await this.prisma.department.findMany({
      where: { companyId: user.companyId, ...(q.includeInactive && user.role === UserRole.ADMIN ? {} : { isActive: true }) },
      include: countActive,
      orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
    });
    return rows.map(toDto);
  }

  @Post('departments')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(createDepartmentSchema)
  async create(@CurrentUser() user: AuthUser, @ZBody(createDepartmentSchema) body: z.infer<typeof createDepartmentSchema>) {
    const dup = await this.prisma.department.findFirst({ where: { companyId: user.companyId, OR: [{ code: body.code }, { nameAr: body.nameAr }] } });
    if (dup) throw conflict(ErrorCode.CONFLICT, 'A department with this code or name already exists');
    const d = await this.prisma.$transaction(async (tx) => {
      const created = await tx.department.create({ data: { companyId: user.companyId, ...body }, include: countActive });
      await audit(tx, user, 'DEPARTMENT_CREATED', 'DEPARTMENT', created.id, { code: body.code });
      return created;
    });
    return toDto(d);
  }

  /** Rename / reorder / activate / deactivate. Departments are never deleted (history references them). */
  @Patch('departments/:id')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(updateDepartmentSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(updateDepartmentSchema) body: z.infer<typeof updateDepartmentSchema>) {
    const d = await this.prisma.department.findFirst({ where: { id, companyId: user.companyId } });
    if (!d) throw notFound('Department not found');
    if (body.nameAr && body.nameAr !== d.nameAr) {
      const dup = await this.prisma.department.findFirst({ where: { companyId: user.companyId, nameAr: body.nameAr, id: { not: id } } });
      if (dup) throw conflict(ErrorCode.CONFLICT, 'A department with this name already exists');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.department.update({ where: { id }, data: body, include: countActive });
      await audit(tx, user, body.isActive === false ? 'DEPARTMENT_DEACTIVATED' : body.isActive === true ? 'DEPARTMENT_ACTIVATED' : 'DEPARTMENT_UPDATED', 'DEPARTMENT', id, {
        changes: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, { from: (d as Record<string, unknown>)[k], to: v }])),
      });
      return u;
    });
    return toDto(updated);
  }

  @Get('departments/:id/members')
  @Roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
  async members(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<DepartmentMemberDto[]> {
    const d = await this.prisma.department.findFirst({ where: { id, companyId: user.companyId } });
    if (!d) throw notFound('Department not found');
    const rows = await this.prisma.departmentMembership.findMany({ where: { departmentId: id, removedAt: null }, include: { user: true }, orderBy: { user: { name: 'asc' } } });
    return rows.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.user.role, isPrimary: m.isPrimary, isActive: m.user.isActive }));
  }

  /** Department membership history (admin). */
  @Get('departments/:id/history')
  @Roles(UserRole.ADMIN)
  async history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.prisma.department.findFirst({ where: { id, companyId: user.companyId } });
    if (!d) throw notFound('Department not found');
    const rows = await this.prisma.departmentMembership.findMany({ where: { departmentId: id }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((m) => ({ user: m.user, isPrimary: m.isPrimary, joinedAt: m.createdAt.toISOString(), removedAt: m.removedAt?.toISOString() ?? null }));
  }

  /**
   * Employees a manager may assign a task to in this department + project (D-2):
   * active EMPLOYEE, active member of the project and of the department.
   */
  @Get('departments/:id/assignable-employees')
  @Roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
  async assignable(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZQuery(assignableQuerySchema) q: z.infer<typeof assignableQuerySchema>) {
    await this.access.assertProjectManager(user, q.projectId);
    await this.access.assertDepartment(user, id);
    const rows = await this.prisma.user.findMany({
      where: {
        companyId: user.companyId,
        isActive: true,
        // Employees, and admins added to the project as employees, can be made responsible.
        role: { in: [UserRole.EMPLOYEE, UserRole.ADMIN] },
        id: { not: user.id },
        memberships: { some: { projectId: q.projectId, role: ProjectRole.EMPLOYEE, removedAt: null } },
        departmentMemberships: { some: { departmentId: id, removedAt: null } },
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    return rows;
  }
}

@Module({ controllers: [DepartmentsController] })
export class DepartmentsModule {}
