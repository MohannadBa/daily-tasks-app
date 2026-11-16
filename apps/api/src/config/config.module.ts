import { Global, Module } from '@nestjs/common';
import { apiEnvSchema, loadEnv, type ApiEnv } from '@dailytasks/config';

export const API_ENV = Symbol('API_ENV');

@Global()
@Module({
  providers: [{ provide: API_ENV, useFactory: (): ApiEnv => loadEnv(apiEnvSchema) }],
  exports: [API_ENV],
})
export class ConfigModule {}
