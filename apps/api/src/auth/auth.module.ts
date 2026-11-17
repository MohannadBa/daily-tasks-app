import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AccessGate } from './access-gate';
import { AuthGuard } from './auth.guard';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [AccessGate, TokenService, IdentityService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AccessGate, TokenService, IdentityService],
})
export class AuthModule {}
