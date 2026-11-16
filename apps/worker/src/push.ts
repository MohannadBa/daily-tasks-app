import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { PrismaClient } from '@dailytasks/database';
import type { PushData } from '@dailytasks/shared-types';
import { errMsg, logger } from './logger';

export interface PushMessage {
  deviceId: string;
  token: string;
  title: string;
  body: string;
  data: PushData;
  badge?: number;
}

export interface PushSender {
  /** Sends and persists tickets. Must disable devices whose tokens are reported invalid. */
  send(messages: PushMessage[]): Promise<void>;
  /** Looks up receipts for older tickets (Expo reports some failures only via receipts). */
  checkReceipts(): Promise<void>;
}

/**
 * Expo Push Service sender. Expo relays to APNs (iOS) and FCM (Android).
 * Delivery timing is controlled by Apple/Google and is not guaranteed to be immediate.
 */
export class ExpoPushSender implements PushSender {
  private readonly expo: Expo;
  constructor(
    private readonly prisma: PrismaClient,
    accessToken?: string,
  ) {
    this.expo = new Expo({ accessToken: accessToken || undefined });
  }

  async send(messages: PushMessage[]) {
    const valid = messages.filter((m) => Expo.isExpoPushToken(m.token));
    const invalid = messages.filter((m) => !Expo.isExpoPushToken(m.token));
    if (invalid.length) await this.disable(invalid.map((m) => m.deviceId), 'malformed token');

    const expoMessages: ExpoPushMessage[] = valid.map((m) => ({
      to: m.token,
      title: m.title,
      body: m.body,
      data: m.data as unknown as Record<string, unknown>,
      sound: 'default',
      priority: 'high',
      channelId: 'tasks',
      badge: m.badge,
    }));
    const chunks = this.expo.chunkPushNotifications(expoMessages);
    let offset = 0;
    for (const chunk of chunks) {
      // Throws on network/5xx errors -> the SQS message is retried.
      const tickets: ExpoPushTicket[] = await this.expo.sendPushNotificationsAsync(chunk);
      const toDisable: string[] = [];
      const ticketRows: Array<{ ticketId: string; deviceInstallationId: string; notificationId: string }> = [];
      tickets.forEach((t, i) => {
        const msg = valid[offset + i]!;
        if (t.status === 'ok') ticketRows.push({ ticketId: t.id, deviceInstallationId: msg.deviceId, notificationId: msg.data.notificationId });
        else if (t.details?.error === 'DeviceNotRegistered') toDisable.push(msg.deviceId);
        else logger.warn('push ticket error', { error: t.details?.error, message: t.message });
      });
      offset += chunk.length;
      if (ticketRows.length) await this.prisma.pushTicket.createMany({ data: ticketRows, skipDuplicates: true });
      if (toDisable.length) await this.disable(toDisable, 'DeviceNotRegistered');
    }
  }

  async checkReceipts() {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const tickets = await this.prisma.pushTicket.findMany({ where: { checkedAt: null, createdAt: { lt: cutoff } }, take: 1000 });
    if (tickets.length === 0) return;
    const byTicket = new Map(tickets.map((t) => [t.ticketId, t]));
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(tickets.map((t) => t.ticketId))) {
      try {
        const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
        const toDisable: string[] = [];
        for (const [id, r] of Object.entries(receipts)) {
          if (r.status === 'error') {
            if (r.details?.error === 'DeviceNotRegistered') toDisable.push(byTicket.get(id)!.deviceInstallationId);
            else logger.warn('push receipt error', { error: r.details?.error, message: r.message });
          }
        }
        if (toDisable.length) await this.disable(toDisable, 'receipt DeviceNotRegistered');
        await this.prisma.pushTicket.updateMany({ where: { ticketId: { in: chunk } }, data: { checkedAt: new Date() } });
      } catch (e) {
        logger.warn('receipt check failed', { error: errMsg(e) });
      }
    }
    // Housekeeping: forget checked tickets after a day.
    await this.prisma.pushTicket.deleteMany({ where: { checkedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
  }

  private async disable(deviceIds: string[], reason: string) {
    await this.prisma.deviceInstallation.updateMany({ where: { id: { in: deviceIds } }, data: { disabledAt: new Date() } });
    logger.info('disabled push devices', { count: deviceIds.length, reason });
  }
}

/** No-op sender (PUSH_ENABLED=false) and test double. */
export class RecordingPushSender implements PushSender {
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]) {
    this.sent.push(...messages);
  }
  async checkReceipts() {}
}
