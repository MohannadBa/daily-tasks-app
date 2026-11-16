import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ProjectRole } from '@dailytasks/database';
import type { CurrentUser as CurrentUserDto, LoginResponse } from '@dailytasks/shared-types';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, newPasswordSchema, refreshSchema, resetPasswordSchema, updateProfileSchema } from '@dailytasks/validation';
import { ApiZodBody, ZodValidationPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { AllowWhilePasswordChangeRequired, CurrentUser, Public } from './decorators';
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

  /** Always 202 (no account enumeration). 501 in local auth mode (no e-mail delivery). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/forgot-password')
  @HttpCode(202)
  @ApiZodBody(forgotPasswordSchema)
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.identity.forgotPassword(body.email);
    return { status: 'CODE_SENT_IF_ACCOUNT_EXISTS' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/reset-password')
  @HttpCode(204)
  @ApiZodBody(resetPasswordSchema)
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: { email: string; code: string; newPassword: string }) {
    await this.identity.confirmPasswordReset(body.email, body.code, body.newPassword);
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
  @AllowWhilePasswordChangeRequired()
  @Get('auth/me')
  me(@CurrentUser() user: AuthUser) {
    return this.currentUser(user.id);
  }

  @ApiBearerAuth()
  @AllowWhilePasswordChangeRequired()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/change-password')
  @HttpCode(204)
  @ApiZodBody(changePasswordSchema)
  async changePassword(@CurrentUser() user: AuthUser, @Req() req: { accessToken?: string }, @Body(new ZodValidationPipe(changePasswordSchema)) body: { currentPassword: string; newPassword: string }) {
    await this.identity.changePassword(user.id, req.accessToken ?? '', body.currentPassword, body.newPassword);
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
      include: {
        company: true,
        memberships: { where: { removedAt: null }, select: { projectId: true, role: true } },
        departmentMemberships: { where: { removedAt: null }, include: { department: true } },
      },
    });
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      locale: u.locale === 'ar' ? 'ar' : 'en',
      companyId: u.companyId,
      departments: u.departmentMemberships.map((m) => ({ id: m.department.id, nameAr: m.department.nameAr, nameEn: m.department.nameEn, isPrimary: m.isPrimary })),
      mustChangePassword: u.mustChangePassword,
      companyName: u.company.name,
      managedProjectIds: u.memberships.filter((m) => m.role === ProjectRole.MANAGER).map((m) => m.projectId),
      employeeProjectIds: u.memberships.filter((m) => m.role === ProjectRole.EMPLOYEE).map((m) => m.projectId),
    };
  }
}
