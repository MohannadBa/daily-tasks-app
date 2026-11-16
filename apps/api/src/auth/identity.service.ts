import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AuthFlowType,
  ChallengeNameType,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import bcrypt from 'bcryptjs';
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
    if (this.env.AUTH_MODE !== 'cognito') throw new BadRequestException('Not supported in local auth mode');
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
      return await this.finishCognitoLogin(user.id, res.AuthenticationResult);
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

  /** Provision a login for a newly invited user. */
  async provisionUser(email: string, temporaryPassword?: string): Promise<{ passwordHash?: string }> {
    if (this.env.AUTH_MODE === 'local') {
      if (!temporaryPassword) throw new BadRequestException('temporaryPassword is required in local auth mode');
      return { passwordHash: await bcrypt.hash(temporaryPassword, 10) };
    }
    await this.cognito!.send(
      new AdminCreateUserCommand({
        UserPoolId: this.env.COGNITO_USER_POOL_ID!,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    return {};
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
