import { BadRequestException, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Module, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { isAllowedPushEndpoint, parsePushHosts, type ApiEnv } from '@dailytasks/config';
import { OutboxEventType, PushPlatform, type PushTestPayload } from '@dailytasks/database';
import type { PushStatusDto, PushSubscriptionDto } from '@dailytasks/shared-types';
import { pushSubscribeSchema, pushUnsubscribeSchema, z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { API_ENV } from '../config/config.module';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';

/** Platform of the browser that created the subscription (for display and diagnostics only). */
export function detectPushPlatform(ua: string | undefined): PushPlatform {
  if (!ua) return PushPlatform.OTHER;
  if (/iPhone|iPad|iPod/i.test(ua)) return PushPlatform.IOS;
  if (/Android/i.test(ua)) return PushPlatform.ANDROID;
  if (/Windows|Macintosh|Mac OS X|Linux|CrOS/i.test(ua)) return PushPlatform.DESKTOP;
  return PushPlatform.OTHER;
}

/** "Safari on iPhone", "Chrome on Android", ... */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'Unknown browser';
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari/.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'unknown OS';
  return `${browser} on ${os}`;
}

const TEST_PUSH_PER_MINUTE = 3;

/** Stable, non-reversible identifier for an endpoint (the endpoint itself is a capability URL). */
export const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

@Injectable()
export class PushService {
  private readonly hosts: string[];
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {
    this.hosts = parsePushHosts(env.WEB_PUSH_ALLOWED_HOSTS);
  }

  get enabled() {
    return !!this.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  }

  get publicKey(): string | null {
    return this.env.WEB_PUSH_VAPID_PUBLIC_KEY || null;
  }

  /**
   * Creates or refreshes the caller's subscription. The owner is always the authenticated user:
   * if the same browser endpoint was registered by someone else (shared device, previous login),
   * it is re-bound to the current user, so the previous user stops receiving pushes on it.
   */
  async subscribe(user: AuthUser, body: z.infer<typeof pushSubscribeSchema>, userAgent: string | undefined) {
    if (!this.enabled) throw new BadRequestException('Push notifications are not configured on this server');
    if (!isAllowedPushEndpoint(body.endpoint, this.hosts, this.env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS)) {
      throw new BadRequestException('Unsupported push service endpoint');
    }
    const ua = userAgent?.slice(0, 512);
    const data = {
      userId: user.id,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: ua ?? null,
      platform: detectPushPlatform(ua),
      expiresAt: body.expirationTime ? new Date(body.expirationTime) : null,
      isActive: true,
      failureCount: 0,
      deactivatedAt: null,
      deactivationReason: null,
    };
    const sub = await this.prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: data,
      create: { endpoint: body.endpoint, ...data },
    });
    return { id: sub.id, endpointHash: endpointHash(sub.endpoint) };
  }

  /** Removes one of the caller's subscriptions. Other users' rows are never touched (no information leak). */
  async unsubscribe(user: AuthUser, body: z.infer<typeof pushUnsubscribeSchema>) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId: user.id, ...(body.id ? { id: body.id } : { endpoint: body.endpoint }) },
    });
  }

  async status(user: AuthUser): Promise<PushStatusDto> {
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: user.id },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: { deliveries: { orderBy: { updatedAt: 'desc' }, take: 1 } },
    });
    const subscriptions: PushSubscriptionDto[] = subs.map((s) => {
      const d = s.deliveries[0];
      return {
        id: s.id,
        platform: s.platform,
        device: describeDevice(s.userAgent),
        isActive: s.isActive,
        endpointHash: endpointHash(s.endpoint),
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        deactivationReason: s.deactivationReason,
        lastDelivery: d ? { status: d.status, statusCode: d.statusCode, at: d.updatedAt.toISOString() } : null,
      };
    });
    return { enabled: this.enabled, vapidPublicKey: this.publicKey, subscriptions };
  }

  /**
   * Queues a test push to all of the caller's active subscriptions via the outbox (never sent from
   * the request path). A 202 means "queued", not "delivered".
   */
  async test(user: AuthUser) {
    if (!this.enabled) throw new BadRequestException('Push notifications are not configured on this server');
    const active = await this.prisma.pushSubscription.count({ where: { userId: user.id, isActive: true } });
    if (active === 0) throw new BadRequestException('No active push subscription. Enable notifications on this device first.');
    // Per-user limit (the BFF proxies every user from one IP, so IP throttling is not enough).
    const recent = await this.prisma.outboxEvent.count({
      where: { type: OutboxEventType.PUSH_TEST, aggregateId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recent >= TEST_PUSH_PER_MINUTE) throw new HttpException('Too many test notifications. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    const payload: PushTestPayload = { userId: user.id };
    await this.prisma.$transaction((tx) => this.outbox.enqueue(tx, OutboxEventType.PUSH_TEST, user.id, payload, `PUSH_TEST:${user.id}:${randomUUID()}`));
    return { queued: true, subscriptions: active };
  }
}

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Public VAPID key for PushManager.subscribe({ applicationServerKey }). Safe to expose. */
  @Public()
  @Get('vapid-public-key')
  @ApiOperation({ summary: 'VAPID public key (null when push is not configured)' })
  vapidPublicKey() {
    return { enabled: this.push.enabled, publicKey: this.push.publicKey };
  }

  @Post('subscribe')
  @HttpCode(201)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(pushSubscribeSchema)
  subscribe(@CurrentUser() user: AuthUser, @ZBody(pushSubscribeSchema) body: z.infer<typeof pushSubscribeSchema>, @Req() req: Request) {
    return this.push.subscribe(user, body, req.headers['user-agent']);
  }

  @Delete('unsubscribe')
  @HttpCode(204)
  @ApiZodBody(pushUnsubscribeSchema)
  async unsubscribe(@CurrentUser() user: AuthUser, @ZBody(pushUnsubscribeSchema) body: z.infer<typeof pushUnsubscribeSchema>) {
    await this.push.unsubscribe(user, body);
  }

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.push.status(user);
  }

  @Post('test')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a test push to all of my devices (202 = queued, not delivered)' })
  test(@CurrentUser() user: AuthUser) {
    return this.push.test(user);
  }
}

@Module({ controllers: [PushController], providers: [PushService] })
export class PushModule {}
