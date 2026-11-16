import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '@dailytasks/database';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Routes reachable while the user must still replace a temporary password. */
export const ALLOW_PASSWORD_CHANGE = 'allowPasswordChange';
export const AllowWhilePasswordChangeRequired = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

export const ROLES = 'roles';
/** Restrict an endpoint to the given company-level roles (checked by AuthGuard). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
