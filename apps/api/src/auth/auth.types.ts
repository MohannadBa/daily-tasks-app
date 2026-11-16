import type { UserRole } from '@dailytasks/database';

/** The authenticated principal attached to every request by AuthGuard. */
export interface AuthUser {
  id: string;
  companyId: string;
  email: string;
  name: string;
  role: UserRole;
  locale: string;
}

export interface VerifiedToken {
  /** Local mode: our user id. Cognito mode: the Cognito sub. */
  subject: string;
  mode: 'local' | 'cognito';
}
