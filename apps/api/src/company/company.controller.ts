import { Controller, Get, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TaskStatus, UserRole, type Company } from '@dailytasks/database';
import type { CompanySettingsDto } from '@dailytasks/shared-types';
import { updateCompanySettingsSchema, type z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';

const toDto = (c: Company): CompanySettingsDto => ({ id: c.id, name: c.name, timezone: c.timezone, reminderOffsetsMinutes: c.reminderOffsetsMinutes });

@ApiTags('company')
@ApiBearerAuth()
@Controller('company/settings')
export class CompanyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  @Get()
  @Roles(UserRole.COMPANY_ADMIN, UserRole.PROJECT_MANAGER)
  async get(@CurrentUser() user: AuthUser) {
    return toDto(await this.prisma.company.findUniqueOrThrow({ where: { id: user.companyId } }));
  }

  /** Changing reminder offsets re-schedules every open task (old schedules become stale versions). */
  @Patch()
  @Roles(UserRole.COMPANY_ADMIN)
  @ApiZodBody(updateCompanySettingsSchema)
  async update(@CurrentUser() user: AuthUser, @ZBody(updateCompanySettingsSchema) body: z.infer<typeof updateCompanySettingsSchema>) {
    const company = await this.prisma.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: user.companyId } });
      const c = await tx.company.update({ where: { id: user.companyId }, data: body });
      const offsetsChanged = body.reminderOffsetsMinutes && JSON.stringify(before.reminderOffsetsMinutes) !== JSON.stringify(c.reminderOffsetsMinutes);
      if (offsetsChanged) {
        const open = { project: { companyId: user.companyId }, status: { not: TaskStatus.COMPLETED }, archivedAt: null, deadline: { gt: new Date() } };
        await tx.task.updateMany({ where: open, data: { scheduleVersion: { increment: 1 } } });
        const tasks = await tx.task.findMany({ where: open, select: { id: true, scheduleVersion: true } });
        for (const t of tasks) await this.outbox.scheduleSync(tx, t.id, t.scheduleVersion);
      }
      return c;
    });
    return toDto(company);
  }
}

@Module({ controllers: [CompanyController] })
export class CompanyModule {}
