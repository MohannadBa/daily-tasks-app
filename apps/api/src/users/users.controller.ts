import { BadRequestException, Controller, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProjectRole, UserRole, type User } from '@dailytasks/database';
import type { UserDto } from '@dailytasks/shared-types';
import { adminResetPasswordSchema, inviteUserSchema, updateUserSchema, z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { IdentityService } from '../auth/identity.service';
import { AuthModule } from '../auth/auth.module';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  locale: u.locale === 'ar' ? 'ar' : 'en',
  isActive: u.isActive,
  createdAt: u.createdAt.toISOString(),
});

const listQuery = z.object({ role: z.enum(['COMPANY_ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']).optional(), q: z.string().trim().max(120).optional() });

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
  ) {}

  /** Admins see everyone; project managers see users so they can view project staff. */
  @Get()
  @Roles(UserRole.COMPANY_ADMIN, UserRole.PROJECT_MANAGER)
  async list(@CurrentUser() user: AuthUser, @ZQuery(listQuery) query: z.infer<typeof listQuery>) {
    const users = await this.prisma.user.findMany({
      where: {
        companyId: user.companyId,
        role: query.role,
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return users.map(toUserDto);
  }

  @Post()
  @Roles(UserRole.COMPANY_ADMIN)
  @ApiZodBody(inviteUserSchema)
  async invite(@CurrentUser() user: AuthUser, @ZBody(inviteUserSchema) body: z.infer<typeof inviteUserSchema>) {
    const exists = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new BadRequestException('A user with this email already exists');
    const { passwordHash } = await this.identity.provisionUser(body.email, body.temporaryPassword);
    const created = await this.prisma.user.create({
      data: { companyId: user.companyId, email: body.email, name: body.name, role: body.role, locale: body.locale, passwordHash },
    });
    return toUserDto(created);
  }

  @Patch(':id')
  @Roles(UserRole.COMPANY_ADMIN)
  @ApiZodBody(updateUserSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(updateUserSchema) body: z.infer<typeof updateUserSchema>) {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw new NotFoundException('User not found');
    if (id === user.id && (body.isActive === false || (body.role && body.role !== UserRole.COMPANY_ADMIN))) {
      throw new BadRequestException('You cannot deactivate or demote yourself');
    }
    if (body.role === UserRole.EMPLOYEE && target.role !== UserRole.EMPLOYEE) {
      const managing = await this.prisma.projectMembership.count({ where: { userId: id, role: ProjectRole.MANAGER, removedAt: null } });
      if (managing > 0) throw new BadRequestException('Remove this user as project manager before changing the role to EMPLOYEE');
    }
    if (body.isActive !== undefined && body.isActive !== target.isActive) await this.identity.setUserEnabled(target.email, body.isActive);
    const updated = await this.prisma.user.update({ where: { id }, data: body });
    return toUserDto(updated);
  }

  /** Admin resets a user's password (Cognito: e-mailed code; local mode: temporary password). */
  @Post(':id/reset-password')
  @Roles(UserRole.COMPANY_ADMIN)
  @HttpCode(200)
  @ApiZodBody(adminResetPasswordSchema)
  async resetPassword(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(adminResetPasswordSchema) body: z.infer<typeof adminResetPasswordSchema>) {
    const target = await this.prisma.user.findFirst({ where: { id, companyId: user.companyId } });
    if (!target) throw new NotFoundException('User not found');
    const r = await this.identity.adminResetPassword(target.email, body.temporaryPassword);
    if (r.passwordHash) await this.prisma.user.update({ where: { id }, data: { passwordHash: r.passwordHash } });
    return { mode: r.mode };
  }
}

@Module({ imports: [AuthModule], controllers: [UsersController] })
export class UsersModule {}
