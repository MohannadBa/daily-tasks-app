import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@dailytasks/config';
import { API_ENV } from '../config/config.module';

/**
 * Launch gate for the restricted acceptance phase (ACCESS_MODE=restricted).
 * Only allow-listed e-mail addresses may sign in, refresh tokens, call authenticated endpoints,
 * open the real-time socket or be provisioned by an admin. Everyone else gets the same generic
 * 401 as an unknown/disabled account (no hint that the system is in acceptance mode).
 * Opening access = redeploy with ACCESS_MODE=open (docs/PRODUCTION_PLAN.md).
 */
@Injectable()
export class AccessGate {
  private readonly allow: ReadonlySet<string> | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.allow =
      env.ACCESS_MODE === 'restricted'
        ? new Set(env.ACCESS_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
        : null;
    // Count only — never log the addresses.
    if (this.allow) new Logger('AccessGate').warn(`ACCESS_MODE=restricted: ${this.allow.size} allow-listed account(s)`);
  }

  get restricted(): boolean {
    return this.allow !== null;
  }

  allows(email: string | null | undefined): boolean {
    if (!this.allow) return true;
    return !!email && this.allow.has(email.trim().toLowerCase());
  }
}
