import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessModule } from './access/access.service';
import { AttachmentsModule } from './attachments/attachments.controller';
import { AuthModule } from './auth/auth.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { CompanyModule } from './company/company.controller';
import { ConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.controller';
import { HealthModule } from './health/health.controller';
import { NotificationsModule } from './notifications/notifications.controller';
import { OutboxModule } from './outbox/outbox.service';
import { PrismaModule } from './prisma/prisma.service';
import { ProjectsModule } from './projects/projects.controller';
import { RatingsModule } from './ratings/ratings.controller';
import { StorageModule } from './storage/storage.service';
import { TasksModule } from './tasks/tasks.controller';
import { UsersModule } from './users/users.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Generous global limit; auth endpoints set stricter per-route limits.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    StorageModule,
    OutboxModule,
    AccessModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    AttachmentsModule,
    TasksModule,
    RatingsModule,
    NotificationsModule,
    DashboardModule,
    CompanyModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
