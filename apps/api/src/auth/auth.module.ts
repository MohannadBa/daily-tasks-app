import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [TokenService, IdentityService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService, IdentityService],
})
export class AuthModule {}
