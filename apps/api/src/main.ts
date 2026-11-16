import 'reflect-metadata';
import { ConsoleLogger, Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ensureDatabaseUrl, type ApiEnv } from '@dailytasks/config';
import { AppModule } from './app.module';
import { API_ENV } from './config/config.module';

export const API_PREFIX = 'api/v1';

/** Shared app configuration (used by main and by integration tests). */
export function configureApp(app: INestApplication, env: ApiEnv) {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: true });
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.set('trust proxy', 1);
  http.disable('x-powered-by');
}

async function bootstrap() {
  ensureDatabaseUrl();
  // Structured JSON logs in production (CloudWatch metric filters / Logs Insights); readable text locally.
  const logger = process.env.NODE_ENV === 'production' ? new ConsoleLogger({ json: true, colors: false }) : undefined;
  const app = await NestFactory.create(AppModule, { bufferLogs: false, ...(logger ? { logger } : {}) });
  const env = app.get<ApiEnv>(API_ENV);
  configureApp(app, env);

  if (env.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('DailyTasks API')
        .setDescription('Company task management REST API')
        .setVersion('1.0.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API listening on :${env.PORT} (auth=${env.AUTH_MODE})`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap().catch((err) => {
    // Print only the message: env validation errors never include secret values.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
