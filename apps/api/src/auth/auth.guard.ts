import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@dailytasks/database';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { ALLOW_PASSWORD_CHANGE, IS_PUBLIC, ROLES } from './decorators';
import { ErrorCode, forbidden } from '../common/errors';
import { TokenService } from './token.service';

/**
 * Global guard: every endpoint requires a valid bearer token unless marked @Public().
 * The user row is re-loaded on every request so deactivation takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const verified = await this.tokens.verifyAccessToken(header.slice(7).trim());

    const user = await this.prisma.user.findUnique({
      where: verified.mode === 'local' ? { id: verified.subject } : { cognitoSub: verified.subject },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Account not found or disabled');

    const principal: AuthUser = {
      id: user.id,
      companyId: user.companyId,
      email: user.email,
      name: user.name,
      role: user.role,
      locale: user.locale,
    };
    req.user = principal;
    req.accessToken = header.slice(7).trim();

    // Temporary password still in place: everything except the change-password flow is refused.
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) {
      throw forbidden('You must change your temporary password first', ErrorCode.PASSWORD_CHANGE_REQUIRED);
    }

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
