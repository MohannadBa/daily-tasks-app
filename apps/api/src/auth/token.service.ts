import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import jwt from 'jsonwebtoken';
import type { ApiEnv } from '@dailytasks/config';
import { API_ENV } from '../config/config.module';
import type { VerifiedToken } from './auth.types';

const ISSUER = 'dailytasks-local';

interface AccessVerifier {
  verify(token: string): Promise<{ sub: string }>;
  hydrate(): Promise<void>;
}

/**
 * Verifies bearer tokens. In cognito mode, access tokens are validated against the user pool JWKS
 * (signature, issuer, expiry, token_use=access, client_id). In local mode we sign/verify HS256 JWTs.
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);
  private cognitoVerifier?: AccessVerifier;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  onModuleInit() {
    if (this.env.AUTH_MODE === 'cognito') {
      this.cognitoVerifier = CognitoJwtVerifier.create({
        userPoolId: this.env.COGNITO_USER_POOL_ID!,
        tokenUse: 'access',
        clientId: this.env.COGNITO_CLIENT_ID!,
      }) as unknown as AccessVerifier;
      this.cognitoVerifier.hydrate().catch((e) => this.logger.warn(`Could not prefetch Cognito JWKS: ${(e as Error).message}`));
    }
  }

  async verifyAccessToken(token: string): Promise<VerifiedToken> {
    try {
      if (this.env.AUTH_MODE === 'cognito') {
        const payload = await this.cognitoVerifier!.verify(token);
        return { subject: payload.sub, mode: 'cognito' };
      }
      const payload = jwt.verify(token, this.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: ISSUER }) as jwt.JwtPayload;
      if (payload.typ !== 'access' || !payload.sub) throw new Error('wrong token type');
      return { subject: payload.sub, mode: 'local' };
    } catch {
      // Never log the token itself.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /* ---- local mode only ---- */

  issueLocalTokens(userId: string) {
    const secret = this.env.JWT_SECRET!;
    const accessToken = jwt.sign({ typ: 'access' }, secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
    });
    const refreshToken = jwt.sign({ typ: 'refresh' }, secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      expiresIn: this.env.JWT_REFRESH_TTL_SECONDS,
    });
    return { accessToken, refreshToken, expiresIn: this.env.JWT_ACCESS_TTL_SECONDS };
  }

  /** Short-lived challenge proving the password was correct while a change is required (local mode). */
  issuePasswordChallenge(userId: string): string {
    return jwt.sign({ typ: 'pwchange' }, this.env.JWT_SECRET!, { algorithm: 'HS256', subject: userId, issuer: ISSUER, expiresIn: 600 });
  }

  verifyPasswordChallenge(token: string): string {
    try {
      const payload = jwt.verify(token, this.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: ISSUER }) as jwt.JwtPayload;
      if (payload.typ !== 'pwchange' || !payload.sub) throw new Error('wrong token type');
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }

  verifyLocalRefreshToken(token: string): string {
    try {
      const payload = jwt.verify(token, this.env.JWT_SECRET!, { algorithms: ['HS256'], issuer: ISSUER }) as jwt.JwtPayload;
      if (payload.typ !== 'refresh' || !payload.sub) throw new Error('wrong token type');
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
