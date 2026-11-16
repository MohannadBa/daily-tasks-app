import { Body, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { NotificationDto, Paginated } from '@dailytasks/shared-types';
import { notificationListQuerySchema, registerDeviceSchema, z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZBody, ZodValidationPipe, ZQuery } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Users only ever see their own notifications. */
  @Get('notifications')
  async list(@CurrentUser() user: AuthUser, @ZQuery(notificationListQuerySchema) q: z.infer<typeof notificationListQuerySchema>): Promise<Paginated<NotificationDto>> {
    const where = { userId: user.id, ...(q.unreadOnly ? { readAt: null } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.notification.count({ where }),
    ]);
    return {
      items: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        taskId: n.taskId,
        projectId: n.projectId,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() user: AuthUser) {
    return { count: await this.prisma.notification.count({ where: { userId: user.id, readAt: null } }) };
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() user: AuthUser) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
    if (res.count === 0) throw new NotFoundException('Notification not found');
  }

  /**
   * Registers (or moves) an Expo push token to the current user. A token belongs to one device;
   * if another user previously logged in on that device, the token is re-bound to the new user.
   */
  @Post('devices')
  @HttpCode(200)
  @ApiZodBody(registerDeviceSchema)
  async registerDevice(@CurrentUser() user: AuthUser, @ZBody(registerDeviceSchema) body: z.infer<typeof registerDeviceSchema>) {
    const d = await this.prisma.deviceInstallation.upsert({
      where: { expoPushToken: body.expoPushToken },
      update: { userId: user.id, platform: body.platform, deviceName: body.deviceName ?? null, locale: body.locale ?? user.locale, lastSeenAt: new Date(), disabledAt: null },
      create: { userId: user.id, expoPushToken: body.expoPushToken, platform: body.platform, deviceName: body.deviceName ?? null, locale: body.locale ?? user.locale },
    });
    return { id: d.id };
  }

  /** Called on logout so the device stops receiving this user's pushes. */
  @Delete('devices')
  @HttpCode(204)
  async unregisterDevice(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(z.object({ expoPushToken: z.string().min(1) }))) body: { expoPushToken: string }) {
    await this.prisma.deviceInstallation.deleteMany({ where: { expoPushToken: body.expoPushToken, userId: user.id } });
  }
}

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
