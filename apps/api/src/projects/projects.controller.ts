import { BadRequestException, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectRole, ProjectStatus, TaskStatus, UserRole } from '@dailytasks/database';
import type { ProjectDto, ProjectMemberDto } from '@dailytasks/shared-types';
import { addMemberSchema, createProjectSchema, updateProjectSchema, type z } from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<ProjectDto[]> {
    const projects = await this.prisma.project.findMany({ where: this.access.projectScope(user), orderBy: [{ status: 'asc' }, { name: 'asc' }] });
    return Promise.all(projects.map((p) => this.toDto(user, p.id)));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.projectAccess(user, id);
    return this.toDto(user, id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiZodBody(createProjectSchema)
  async create(@CurrentUser() user: AuthUser, @ZBody(createProjectSchema) body: z.infer<typeof createProjectSchema>) {
    const p = await this.prisma.project.create({ data: { companyId: user.companyId, name: body.name, description: body.description ?? null } });
    return this.toDto(user, p.id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(updateProjectSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(updateProjectSchema) body: z.infer<typeof updateProjectSchema>) {
    await this.access.projectAccess(user, id);
    await this.prisma.project.update({
      where: { id },
      data: {
        ...body,
        ...(body.status ? { archivedAt: body.status === ProjectStatus.ARCHIVED ? new Date() : null } : {}),
      },
    });
    return this.toDto(user, id);
  }

  /** Managers and admins can list members; employees cannot browse colleagues. */
  @Get(':id/members')
  async members(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ProjectMemberDto[]> {
    await this.access.assertProjectManager(user, id);
    const rows = await this.prisma.projectMembership.findMany({
      where: { projectId: id, removedAt: null, user: { isActive: true } },
      include: { user: true },
      orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }],
    });
    return rows.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, joinedAt: m.updatedAt.toISOString() }));
  }

  @Post(':id/members')
  @Roles(UserRole.ADMIN)
  @ApiZodBody(addMemberSchema)
  async addMember(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(addMemberSchema) body: z.infer<typeof addMemberSchema>) {
    await this.access.projectAccess(user, id);
    const target = await this.prisma.user.findFirst({ where: { id: body.userId, companyId: user.companyId, isActive: true } });
    if (!target) throw new NotFoundException('User not found');
    if (body.role === ProjectRole.MANAGER && target.role === UserRole.EMPLOYEE) {
      throw new BadRequestException('Only project managers or admins can be assigned as project manager');
    }
    const m = await this.prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId: id, userId: body.userId } },
      update: { role: body.role, removedAt: null },
      create: { projectId: id, userId: body.userId, role: body.role },
      include: { user: true },
    });
    return { userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, joinedAt: m.updatedAt.toISOString() } satisfies ProjectMemberDto;
  }

  /**
   * Soft-removes a membership. Access is revoked immediately for future requests.
   * Open tasks assigned to the removed employee stay in the project for a manager to reassign.
   */
  @Delete(':id/members/:userId')
  @Roles(UserRole.ADMIN)
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.access.projectAccess(user, id);
    const res = await this.prisma.projectMembership.updateMany({ where: { projectId: id, userId, removedAt: null }, data: { removedAt: new Date() } });
    if (res.count === 0) throw new NotFoundException('Membership not found');
  }

  private async toDto(user: AuthUser, id: string): Promise<ProjectDto> {
    const [p, memberCount, openTaskCount, mine] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({ where: { id } }),
      this.prisma.projectMembership.count({ where: { projectId: id, removedAt: null } }),
      this.prisma.task.count({
        where: { AND: [{ projectId: id, status: { not: TaskStatus.COMPLETED } }, this.access.taskScope(user)] },
      }),
      this.prisma.projectMembership.findFirst({ where: { projectId: id, userId: user.id, removedAt: null } }),
    ]);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      myRole: mine?.role ?? null,
      memberCount,
      openTaskCount,
    };
  }
}

@Module({ controllers: [ProjectsController] })
export class ProjectsModule {}
