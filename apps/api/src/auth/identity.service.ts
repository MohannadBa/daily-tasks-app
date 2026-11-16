import { BadRequestException, Inject, Injectable, Logger, NotImplementedException, UnauthorizedException } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AuthFlowType,
  ChallengeNameType,
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import type { ApiEnv } from '@dailytasks/config';
import type { AuthTokens } from '@dailytasks/shared-types';
import { API_ENV } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';

export type LoginResult =
  | { status: 'OK'; userId: string; tokens: AuthTokens }
  | { status: 'NEW_PASSWORD_REQUIRED'; session: string; email: string };

/**
 * Identity provider abstraction.
 *  - cognito: credentials are checked by Cognito (USER_PASSWORD_AUTH on a public app client);
 *    users are provisioned with AdminCreateUser (Cognito e-mails the temporary password).
 *  - local:   bcrypt hashes in Postgres; development and automated tests only.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly cognito?: CognitoIdentityProviderClient;
  /** Used when the e-mail is unknown so response timing does not reveal account existence. */
  private readonly dummyHash = bcrypt.hashSync('dummy-password-for-timing', 10);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {
    if (env.AUTH_MODE === 'cognito') this.cognito = new CognitoIdentityProviderClient({ region: env.AWS_REGION });
  }

  get mode() {
    return this.env.AUTH_MODE;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (this.env.AUTH_MODE === 'local') {
      const ok = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);
      if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid email or password');
      // Temporary password: no tokens until a new password is chosen (same contract as Cognito).
      if (user.mustChangePassword) return { status: 'NEW_PASSWORD_REQUIRED', session: this.tokens.issuePasswordChallenge(user.id), email: user.email };
      await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return { status: 'OK', userId: user.id, tokens: this.tokens.issueLocalTokens(user.id) };
    }

    if (!user || !user.isActive) throw new UnauthorizedException('Invalid email or password');
    try {
      const res = await this.cognito!.send(
        new InitiateAuthCommand({
          AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
          ClientId: this.env.COGNITO_CLIENT_ID!,
          AuthParameters: { USERNAME: email, PASSWORD: password },
        }),
      );
      if (res.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED) {
        return { status: 'NEW_PASSWORD_REQUIRED', session: res.Session!, email };
      }
      return await this.finishCognitoLogin(user.id, res.AuthenticationResult);
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.warn(`Cognito login failed: ${(e as Error).name}`);
      throw new UnauthorizedException('Invalid email or password');
    }
  }

  async completeNewPassword(email: string, session: string, newPassword: string): Promise<LoginResult> {
    if (this.env.AUTH_MODE === 'local') {
      const userId = this.tokens.verifyPasswordChallenge(session);
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.isActive || user.email !== email || !user.mustChangePassword) throw new UnauthorizedException('Invalid session');
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false, passwordChangedAt: new Date(), lastLoginAt: new Date() },
      });
      await this.audit(user.companyId, user.id, 'PASSWORD_CHANGED', user.id, { firstLogin: true });
      return { status: 'OK', userId: user.id, tokens: this.tokens.issueLocalTokens(user.id) };
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid session');
    try {
      const res = await this.cognito!.send(
        new RespondToAuthChallengeCommand({
          ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED,
          ClientId: this.env.COGNITO_CLIENT_ID!,
          Session: session,
          ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
        }),
      );
      const done = await this.finishCognitoLogin(user.id, res.AuthenticationResult);
      await this.prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: false, passwordChangedAt: new Date() } });
      await this.audit(user.companyId, user.id, 'PASSWORD_CHANGED', user.id, { firstLogin: true });
      return done;
    } catch (e) {
      this.logger.warn(`Cognito new-password challenge failed: ${(e as Error).name}`);
      throw new BadRequestException('Could not set new password');
    }
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    if (this.env.AUTH_MODE === 'local') {
      const userId = this.tokens.verifyLocalRefreshToken(refreshToken);
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user?.isActive) throw new UnauthorizedException('Account disabled');
      return this.tokens.issueLocalTokens(user.id);
    }
    try {
      const res = await this.cognito!.send(
        new InitiateAuthCommand({
          AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
          ClientId: this.env.COGNITO_CLIENT_ID!,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
      const r = res.AuthenticationResult!;
      // Cognito does not rotate refresh tokens unless rotation is enabled; keep the existing one.
      return { accessToken: r.AccessToken!, refreshToken: r.RefreshToken ?? refreshToken, expiresIn: r.ExpiresIn ?? 3600 };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Self-service password recovery (Cognito e-mails a code). Always resolves for unknown or
   * inactive e-mails too, so the response never reveals whether an account exists.
   * Local auth mode has no e-mail delivery: an administrator resets the password instead.
   */
  async forgotPassword(email: string): Promise<void> {
    if (this.env.AUTH_MODE !== 'cognito') throw new NotImplementedException('Password reset by e-mail is not available on this server. Ask an administrator to reset your password.');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.isActive) return;
    try {
      await this.cognito!.send(new ForgotPasswordCommand({ ClientId: this.env.COGNITO_CLIENT_ID!, Username: email }));
    } catch (e) {
      // Do not leak account state (e.g. UserNotFound, NotAuthorized for unconfirmed users).
      this.logger.warn(`Cognito forgot-password failed: ${(e as Error).name}`);
    }
  }

  async confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void> {
    if (this.env.AUTH_MODE !== 'cognito') throw new NotImplementedException('Password reset by e-mail is not available on this server.');
    try {
      await this.cognito!.send(new ConfirmForgotPasswordCommand({ ClientId: this.env.COGNITO_CLIENT_ID!, Username: email, ConfirmationCode: code, Password: newPassword }));
    } catch (e) {
      const name = (e as Error).name;
      this.logger.warn(`Cognito confirm-forgot-password failed: ${name}`);
      if (name === 'InvalidPasswordException') throw new BadRequestException('The new password does not meet the password policy');
      throw new BadRequestException('Invalid or expired code');
    }
  }

  /**
   * Administrator resets a user's password; the user must choose a new one at next sign-in.
   *  - Cognito + EMAIL: Cognito e-mails a reset code (AdminResetUserPassword).
   *  - Cognito + SHOW_ONCE: a generated temporary password (AdminSetUserPassword, Permanent=false).
   *  - Local: admin-provided or generated temporary password, hashed; mustChangePassword = true.
   * The plaintext is returned only for SHOW_ONCE (or never, when the admin chose it).
   */
  async adminResetPassword(email: string, delivery: 'EMAIL' | 'SHOW_ONCE' | undefined, temporaryPassword?: string): Promise<{ passwordHash?: string; mode: 'email' | 'temporary'; reveal?: string }> {
    if (this.env.AUTH_MODE === 'local') {
      if (delivery === 'EMAIL') throw new BadRequestException('E-mail delivery is not available in local auth mode; use SHOW_ONCE');
      const pwd = temporaryPassword ?? generateTemporaryPassword();
      return { passwordHash: await bcrypt.hash(pwd, 10), mode: 'temporary', reveal: temporaryPassword ? undefined : pwd };
    }
    if (delivery === 'SHOW_ONCE' || temporaryPassword) {
      const pwd = temporaryPassword ?? generateTemporaryPassword();
      await this.cognito!.send(new AdminSetUserPasswordCommand({ UserPoolId: this.env.COGNITO_USER_POOL_ID!, Username: email, Password: pwd, Permanent: false }));
      return { mode: 'temporary', reveal: temporaryPassword ? undefined : pwd };
    }
    await this.cognito!.send(new AdminResetUserPasswordCommand({ UserPoolId: this.env.COGNITO_USER_POOL_ID!, Username: email }));
    return { mode: 'email' };
  }

  /**
   * Provision a login for a new user. Cognito EMAIL (default): Cognito generates and e-mails the
   * temporary password — our system never sees it. SHOW_ONCE: we generate it, suppress the e-mail
   * and return it exactly once. Local mode: hashed; returned once unless the admin chose it.
   */
  async provisionUser(email: string, delivery: 'EMAIL' | 'SHOW_ONCE' | undefined, temporaryPassword?: string): Promise<{ passwordHash?: string; reveal?: string }> {
    if (this.env.AUTH_MODE === 'local') {
      if (delivery === 'EMAIL') throw new BadRequestException('E-mail delivery is not available in local auth mode; use SHOW_ONCE');
      const pwd = temporaryPassword ?? generateTemporaryPassword();
      return { passwordHash: await bcrypt.hash(pwd, 10), reveal: temporaryPassword ? undefined : pwd };
    }
    const showOnce = delivery === 'SHOW_ONCE' || !!temporaryPassword;
    const pwd = showOnce ? (temporaryPassword ?? generateTemporaryPassword()) : undefined;
    await this.cognito!.send(
      new AdminCreateUserCommand({
        UserPoolId: this.env.COGNITO_USER_POOL_ID!,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        ...(showOnce ? { TemporaryPassword: pwd, MessageAction: 'SUPPRESS' as const } : { DesiredDeliveryMediums: ['EMAIL' as const] }),
      }),
    );
    return { reveal: showOnce && !temporaryPassword ? pwd : undefined };
  }

  /** Cognito e-mails the temporary password by default; local mode can only show it once. */
  defaultDelivery(): 'EMAIL' | 'SHOW_ONCE' {
    return this.env.AUTH_MODE === 'cognito' ? 'EMAIL' : 'SHOW_ONCE';
  }

  /** Authenticated password change (both modes). */
  async changePassword(userId: string, accessToken: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (this.env.AUTH_MODE === 'local') {
      if (!(await bcrypt.compare(currentPassword, user.passwordHash ?? this.dummyHash))) throw new BadRequestException('Current password is incorrect');
      await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false, passwordChangedAt: new Date() } });
    } else {
      try {
        await this.cognito!.send(new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: currentPassword, ProposedPassword: newPassword }));
      } catch (e) {
        this.logger.warn(`Cognito change-password failed: ${(e as Error).name}`);
        throw new BadRequestException('Could not change the password');
      }
      await this.prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false, passwordChangedAt: new Date() } });
    }
    await this.audit(user.companyId, userId, 'PASSWORD_CHANGED', userId, {});
  }

  /** Revokes all sessions (deactivation). Local refresh tokens are re-checked against isActive. */
  async signOutEverywhere(email: string) {
    if (this.env.AUTH_MODE !== 'cognito') return;
    await this.cognito!.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.env.COGNITO_USER_POOL_ID!, Username: email }));
  }

  private audit(companyId: string, actorId: string | null, action: string, entityId: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({ data: { companyId, actorId, action, entityType: 'USER', entityId, metadata: metadata as object } });
  }

  async setUserEnabled(email: string, enabled: boolean) {
    if (this.env.AUTH_MODE !== 'cognito') return;
    const input = { UserPoolId: this.env.COGNITO_USER_POOL_ID!, Username: email };
    await this.cognito!.send(enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
  }

  private async finishCognitoLogin(userId: string, result?: AuthenticationResultType): Promise<LoginResult> {
    if (!result?.AccessToken) throw new UnauthorizedException('Login failed');
    const verified = await this.tokens.verifyAccessToken(result.AccessToken);
    // Link the Cognito identity to our user row on first login.
    await this.prisma.user.update({ where: { id: userId }, data: { cognitoSub: verified.subject, lastLoginAt: new Date() } });
    return {
      status: 'OK',
      userId,
      tokens: { accessToken: result.AccessToken, refreshToken: result.RefreshToken!, expiresIn: result.ExpiresIn ?? 3600 },
    };
  }
}

/**
 * Cryptographically random temporary password satisfying the Cognito policy
 * (≥ 8 chars, upper, lower, digit). 16 chars from an unambiguous alphabet.
 */
export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const all = upper + lower + digit;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(upper), pick(lower), pick(digit), ...Array.from({ length: 13 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
