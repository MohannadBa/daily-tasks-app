import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ProjectRole } from '@dailytasks/database';
import type { CurrentUser as CurrentUserDto, LoginResponse } from '@dailytasks/shared-types';
import { loginSchema, newPasswordSchema, refreshSchema, updateProfileSchema } from '@dailytasks/validation';
import { ApiZodBody, ZodValidationPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public } from './decorators';
import { IdentityService, type LoginResult } from './identity.service';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  @HttpCode(200)
  @ApiZodBody(loginSchema)
  async login(@Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string }): Promise<LoginResponse> {
    return this.toResponse(await this.identity.login(body.email, body.password));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/new-password')
  @HttpCode(200)
  @ApiZodBody(newPasswordSchema)
  async newPassword(@Body(new ZodValidationPipe(newPasswordSchema)) body: { email: string; session: string; newPassword: string }) {
    return this.toResponse(await this.identity.completeNewPassword(body.email, body.session, body.newPassword));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('auth/refresh')
  @HttpCode(200)
  @ApiZodBody(refreshSchema)
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: { refreshToken: string }) {
    return this.identity.refresh(body.refreshToken);
  }

  @ApiBearerAuth()
  @Get('auth/me')
  me(@CurrentUser() user: AuthUser) {
    return this.currentUser(user.id);
  }

  @ApiBearerAuth()
  @ApiTags('profile')
  @Patch('me')
  @ApiZodBody(updateProfileSchema)
  async updateMe(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(updateProfileSchema)) body: { name?: string; locale?: string }) {
    await this.prisma.user.update({ where: { id: user.id }, data: body });
    return this.currentUser(user.id);
  }

  private async toResponse(result: LoginResult): Promise<LoginResponse> {
    if (result.status !== 'OK') return result;
    return { status: 'OK', ...result.tokens, user: await this.currentUser(result.userId) };
  }

  private async currentUser(userId: string): Promise<CurrentUserDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { company: true, memberships: { where: { removedAt: null }, select: { projectId: true, role: true } } },
    });
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      locale: u.locale === 'ar' ? 'ar' : 'en',
      companyId: u.companyId,
      companyName: u.company.name,
      managedProjectIds: u.memberships.filter((m) => m.role === ProjectRole.MANAGER).map((m) => m.projectId),
      employeeProjectIds: u.memberships.filter((m) => m.role === ProjectRole.EMPLOYEE).map((m) => m.projectId),
    };
  }
}
