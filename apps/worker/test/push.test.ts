import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
const ece = require('http_ece') as { decrypt(buf: Buffer, params: { version: string; privateKey: unknown; authSecret: string }): Buffer };
import { isAllowedPushEndpoint, parsePushHosts, PUSH_MAX_ATTEMPTS } from '@dailytasks/config';
import { OutboxEventType, PrismaClient, type QueueMessage } from '@dailytasks/database';
import type { PushPayload } from '@dailytasks/shared-types';
import { Notifier, pushMaintenance, RetryableDeliveryError } from '../src/notifier';
import { EventProcessor } from '../src/processor';
import { classifyStatus, DisabledPushTransport, RecordingPushTransport, WebPushTransport } from '../src/push';
import { MemoryQueue } from '../src/queue';
import { LocalDbScheduler } from '../src/scheduler';
import { overdueLedger, taskFields } from './fixtures';

const prisma = new PrismaClient();
let n = 0;
const u = () => `${Date.now()}-${n++}`;
const P256 = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);

async function world() {
  const company = await prisma.company.create({ data: { name: 'Push Co' } });
  const mk = (name: string, role: 'PROJECT_MANAGER' | 'EMPLOYEE') => prisma.user.create({ data: { companyId: company.id, email: `${name}-${u()}@t.local`, name, role, locale: 'en' } });
  const manager = await mk('Manager', 'PROJECT_MANAGER');
  const emp = await mk('Emp', 'EMPLOYEE');
  const project = await prisma.project.create({ data: { companyId: company.id, name: 'P' } });
  await prisma.projectMembership.createMany({
    data: [
      { projectId: project.id, userId: manager.id, role: 'MANAGER' },
      { projectId: project.id, userId: emp.id, role: 'EMPLOYEE' },
    ],
  });
  const task = await prisma.task.create({
    data: { projectId: project.id, assigneeId: emp.id, createdById: manager.id, title: 'Check fire exits', deadline: new Date(Date.now() + 48 * 3600_000), scheduleVersion: 1, ...(await taskFields(prisma, company.id, manager.id, new Date(Date.now() + 48 * 3600_000))) },
  });
  return { manager, emp, project, task };
}

const sub = (userId: string, extra: { endpoint?: string; isActive?: boolean; platform?: 'IOS' | 'ANDROID' } = {}) =>
  prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: extra.endpoint ?? `https://fcm.googleapis.com/fcm/send/${u()}`,
      p256dh: P256,
      auth: AUTH,
      platform: extra.platform ?? 'ANDROID',
      isActive: extra.isActive ?? true,
      deactivatedAt: extra.isActive === false ? new Date() : null,
    },
  });

const msg = (type: OutboxEventType, payload: object, dedupeKey: string): QueueMessage => ({ id: u(), type, dedupeKey, occurredAt: new Date().toISOString(), payload });
const assigned = (w: Awaited<ReturnType<typeof world>>, key = `TASK_ASSIGNED:${w.task.id}:${u()}`) =>
  msg(OutboxEventType.TASK_ASSIGNED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id }, key);

let push: RecordingPushTransport;
let processor: EventProcessor;
const build = (transport: ConstructorParameters<typeof Notifier>[1]) =>
  new EventProcessor(prisma, new Notifier(prisma, transport), new LocalDbScheduler(prisma, new MemoryQueue()));

beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());
beforeEach(() => {
  push = new RecordingPushTransport();
  processor = build(push);
});

describe('web push fan-out', () => {
  it('stores history, then pushes once to every active device of the recipient (multiple devices)', async () => {
    const w = await world();
    const iphone = await sub(w.emp.id, { platform: 'IOS', endpoint: `https://web.push.apple.com/${u()}` });
    const android = await sub(w.emp.id);
    await sub(w.emp.id, { isActive: false }); // never used
    await sub(w.manager.id); // actor: never notified
    await processor.handle(assigned(w));

    const notif = await prisma.notification.findFirstOrThrow({ where: { taskId: w.task.id } });
    expect(notif.userId).toBe(w.emp.id);
    expect(notif.pushedAt).not.toBeNull();
    expect(push.sent.map((s) => s.target.endpoint).sort()).toEqual([iphone.endpoint, android.endpoint].sort());
    const p: PushPayload = push.sent[0]!.payload;
    expect(p).toMatchObject({ v: 1, notificationId: notif.id, type: 'TASK_ASSIGNED', url: `/tasks/${w.task.id}`, taskId: w.task.id, tag: `n-${notif.id}`, badgeCount: 1 });
    expect(p.title).toBe('New task assigned');
    expect(push.sent[0]!.options).toMatchObject({ urgency: 'normal', topic: notif.id.replace(/-/g, '') });
    const deliveries = await prisma.pushDelivery.findMany({ where: { notificationId: notif.id } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'SENT' && d.statusCode === 201 && d.attempts === 1 && d.sentAt)).toBe(true);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: iphone.id } })).lastUsedAt).not.toBeNull();
  });

  it('duplicate events never create duplicate notifications, deliveries or pushes', async () => {
    const w = await world();
    await sub(w.emp.id);
    await sub(w.emp.id);
    const m = assigned(w, `TASK_ASSIGNED:${w.task.id}`);
    await processor.handle(m);
    await processor.handle(m);
    await processor.handle({ ...m, id: 'redelivered' });
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(1);
    expect(await prisma.pushDelivery.count({ where: { notification: { taskId: w.task.id } } })).toBe(2);
    expect(push.sent).toHaveLength(2);
  });

  it('410 Gone: delivery EXPIRED, subscription deactivated and not used again', async () => {
    const w = await world();
    const gone = await sub(w.emp.id);
    const ok = await sub(w.emp.id);
    push.script(gone.endpoint, { outcome: 'expired', statusCode: 410, error: 'Gone' });
    await processor.handle(assigned(w));
    const s = await prisma.pushSubscription.findUniqueOrThrow({ where: { id: gone.id } });
    expect(s.isActive).toBe(false);
    expect(s.deactivatedAt).not.toBeNull();
    expect(s.deactivationReason).toBe('push service returned 410');
    expect((await prisma.pushDelivery.findFirstOrThrow({ where: { subscriptionId: gone.id } })).status).toBe('EXPIRED');

    push.sent = [];
    await processor.handle(assigned(w)); // a new event
    expect(push.sent.map((x) => x.target.endpoint)).toEqual([ok.endpoint]);
  });

  it('transient failure: history kept, message retried, only the failed device is re-sent', async () => {
    const w = await world();
    const flaky = await sub(w.emp.id);
    const ok = await sub(w.emp.id);
    push.script(flaky.endpoint, { outcome: 'transient', statusCode: 503, error: 'Service Unavailable' }, { outcome: 'sent', statusCode: 201 });
    const m = assigned(w);

    await expect(processor.handle(m)).rejects.toBeInstanceOf(RetryableDeliveryError);
    const notif = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: m.dedupeKey } });
    expect(notif.pushedAt).toBeNull(); // stored before push, not finished
    const d1 = await prisma.pushDelivery.findFirstOrThrow({ where: { subscriptionId: flaky.id } });
    expect(d1).toMatchObject({ status: 'PENDING', attempts: 1, statusCode: 503 });

    push.sent = [];
    await processor.handle(m); // SQS redelivery
    expect(push.sent.map((x) => x.target.endpoint)).toEqual([flaky.endpoint]); // ok device not re-sent
    expect((await prisma.pushDelivery.findFirstOrThrow({ where: { subscriptionId: flaky.id } })).status).toBe('SENT');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notif.id } })).pushedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { dedupeKey: m.dedupeKey } })).toBe(1);
    void ok;
  });

  it(`gives up after ${PUSH_MAX_ATTEMPTS} transient attempts (FAILED) without blocking the event`, async () => {
    const w = await world();
    const down = await sub(w.emp.id);
    push.script(down.endpoint, { outcome: 'transient', statusCode: null, error: 'timeout' });
    const m = assigned(w);
    for (let i = 1; i < PUSH_MAX_ATTEMPTS; i++) await expect(processor.handle(m)).rejects.toBeInstanceOf(RetryableDeliveryError);
    await processor.handle(m); // last attempt: gives up, no throw
    const d = await prisma.pushDelivery.findFirstOrThrow({ where: { subscriptionId: down.id } });
    expect(d).toMatchObject({ status: 'FAILED', attempts: PUSH_MAX_ATTEMPTS, lastError: 'timeout' });
    const s = await prisma.pushSubscription.findUniqueOrThrow({ where: { id: down.id } });
    expect(s.isActive).toBe(true); // one bad message is not enough to drop a device
    expect(s.failureCount).toBe(1);
  });

  it('permanent failure (400/403/413) is not retried', async () => {
    const w = await world();
    const bad = await sub(w.emp.id);
    push.script(bad.endpoint, { outcome: 'failed', statusCode: 403, error: 'VAPID key mismatch' });
    await processor.handle(assigned(w));
    expect(push.sent).toHaveLength(1);
    expect((await prisma.pushDelivery.findFirstOrThrow({ where: { subscriptionId: bad.id } })).status).toBe('FAILED');
  });

  it('a transport exception is treated as transient (retry), history is still stored', async () => {
    const w = await world();
    await sub(w.emp.id);
    const throwing = { enabled: true, send: async () => { throw new Error('socket hang up'); } };
    const m = assigned(w);
    await expect(build(throwing).handle(m)).rejects.toBeInstanceOf(RetryableDeliveryError);
    expect(await prisma.notification.count({ where: { dedupeKey: m.dedupeKey } })).toBe(1);
  });

  it('push disabled: notification stored and marked processed, no deliveries', async () => {
    const w = await world();
    await sub(w.emp.id);
    const m = assigned(w);
    await build(new DisabledPushTransport()).handle(m);
    const notif = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: m.dedupeKey } });
    expect(notif.pushedAt).not.toBeNull();
    expect(await prisma.pushDelivery.count({ where: { notificationId: notif.id } })).toBe(0);
  });

  it('overdue alerts are high urgency and require interaction', async () => {
    const w = await world();
    await sub(w.emp.id);
    await prisma.task.update({ where: { id: w.task.id }, data: overdueLedger() });
    await processor.handle(msg(OutboxEventType.TASK_DEADLINE_DUE, { taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 }, `OD:${w.task.id}`));
    const toEmp = push.sent.find((s) => s.payload.type === 'TASK_OVERDUE');
    expect(toEmp?.options.urgency).toBe('high');
    expect(toEmp?.payload.requireInteraction).toBe(true);
  });

  it('PUSH_TEST reaches only the requesting user, localized, linking to the settings page', async () => {
    const w = await world();
    await prisma.user.update({ where: { id: w.emp.id }, data: { locale: 'ar' } });
    await sub(w.emp.id);
    await sub(w.manager.id);
    await processor.handle(msg(OutboxEventType.PUSH_TEST, { userId: w.emp.id }, `PUSH_TEST:${w.emp.id}:${u()}`));
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload).toMatchObject({ type: 'PUSH_TEST', url: '/settings/notifications', title: 'إشعار تجريبي' });
    expect(await prisma.notification.count({ where: { userId: w.emp.id, type: 'PUSH_TEST' } })).toBe(1);
  });

  it('maintenance deactivates subscriptions past their browser-reported expiry', async () => {
    const w = await world();
    const s = await sub(w.emp.id);
    await prisma.pushSubscription.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await pushMaintenance(prisma);
    const after = await prisma.pushSubscription.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.isActive).toBe(false);
    expect(after.deactivationReason).toBe('subscription expired');
  });
});

describe('endpoint allow-list (SSRF protection)', () => {
  const hosts = parsePushHosts(undefined);
  it('accepts the major browser push services over https', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QGx',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])
      expect(isAllowedPushEndpoint(e, hosts)).toBe(true);
  });
  it('rejects other hosts, look-alikes, http, credentials and internal addresses', () => {
    for (const e of [
      'https://evil.example.com/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.com/x',
      'https://evilfcm.googleapis.com.attacker.io/x',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/x',
      'http://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'not a url',
    ])
      expect(isAllowedPushEndpoint(e, hosts)).toBe(false);
    expect(isAllowedPushEndpoint('http://127.0.0.1:9/x', ['127.0.0.1'], false)).toBe(false);
    expect(isAllowedPushEndpoint('http://127.0.0.1:9/x', ['127.0.0.1'], true)).toBe(true);
  });
  it('classifies push service responses', () => {
    expect([201, 202, 404, 410, 400, 403, 413, 429, 500, 503].map(classifyStatus)).toEqual([
      'sent', 'sent', 'expired', 'expired', 'failed', 'failed', 'failed', 'transient', 'transient', 'transient',
    ]);
  });
});

/**
 * Real WebPushTransport against a local fake push service: proves VAPID auth headers and RFC 8291
 * aes128gcm encryption by decrypting with the "browser's" private key — the same thing a real
 * browser does. (It does not prove an OS displayed anything; see docs/PWA.md real-device checklist.)
 */
describe('WebPushTransport (real encryption + VAPID against a fake push service)', () => {
  const vapid = webpush.generateVAPIDKeys();
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const authSecret = randomBytes(16).toString('base64url');
  let server: Server;
  let base = '';
  let nextStatus = 201;
  const received: Array<{ req: IncomingMessage; body: Buffer }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ req, body: Buffer.concat(chunks) });
        res.writeHead(nextStatus).end(nextStatus === 410 ? 'push subscription has unsubscribed or expired.' : '');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const transport = () =>
    new WebPushTransport({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.com', allowedHosts: ['127.0.0.1'], allowInsecure: true, timeoutMs: 5000 });
  const target = (path = '/push/abc') => ({ endpoint: `${base}${path}`, p256dh: browser.getPublicKey().toString('base64url'), auth: authSecret });
  const payload: PushPayload = { v: 1, notificationId: 'n1', type: 'TASK_ASSIGNED', title: 'مهمة جديدة', body: 'Fix door · HQ', url: '/tasks/t1', taskId: 't1', badgeCount: 3, tag: 'n-n1' };

  it('sends an encrypted payload the browser can decrypt, with valid VAPID headers', async () => {
    nextStatus = 201;
    const r = await transport().send(target(), payload, { urgency: 'high', topic: 'abc123' });
    expect(r).toEqual({ outcome: 'sent', statusCode: 201, error: undefined });
    const { req, body } = received.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers.ttl).toBe(String(24 * 3600));
    expect(req.headers.urgency).toBe('high');
    expect(req.headers.topic).toBe('abc123');

    // Authorization: vapid t=<JWT>, k=<public key>
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(req.headers.authorization));
    expect(m).not.toBeNull();
    expect(m![2]).toBe(vapid.publicKey);
    const [h, c, sig] = m![1]!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims.aud).toBe(base);
    expect(claims.sub).toBe('mailto:ops@example.com');
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);

    // The body is opaque ciphertext; only the subscription's private key + auth secret decrypt it.
    expect(body.toString()).not.toContain('Fix door');
    const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: browser, authSecret });
    expect(JSON.parse(plain.toString('utf8'))).toEqual(payload);
  });

  it('maps 410 to expired and network errors to transient', async () => {
    nextStatus = 410;
    expect((await transport().send(target(), payload, { urgency: 'normal' })).outcome).toBe('expired');
    const dead = { ...target(), endpoint: 'http://127.0.0.1:1/push' };
    expect((await transport().send(dead, payload, { urgency: 'normal' })).outcome).toBe('transient');
  });

  it('never contacts a host outside the allow-list', async () => {
    const before = received.length;
    const r = await new WebPushTransport({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:a@b.c', allowedHosts: ['fcm.googleapis.com'], allowInsecure: true, timeoutMs: 1000 }).send(
      target(),
      payload,
      { urgency: 'normal' },
    );
    expect(r).toMatchObject({ outcome: 'failed', error: 'endpoint host not allowed' });
    expect(received.length).toBe(before);
  });

  it('rejects malformed subscription keys as a permanent failure', async () => {
    const r = await transport().send({ ...target(), p256dh: 'AAAA' }, payload, { urgency: 'normal' });
    expect(r.outcome).toBe('failed');
  });
});

describe('VAPID configuration guards', () => {
  const base = { DATABASE_URL: 'postgresql://x', S3_BUCKET: 'b', SQS_EVENTS_QUEUE_URL: 'http://q', AWS_REGION: 'me-central-1' };
  it('production refuses the committed local-development key and insecure endpoints', async () => {
    const { workerEnvSchema, apiEnvSchema, DEV_VAPID_PUBLIC_KEY } = await import('@dailytasks/config');
    const worker = workerEnvSchema.safeParse({ ...base, NODE_ENV: 'production', WEB_PUSH_VAPID_PUBLIC_KEY: DEV_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY: 'x', WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: 'true' });
    expect(worker.success).toBe(false);
    expect(worker.error!.issues.map((i) => i.path[0])).toEqual(expect.arrayContaining(['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_ALLOW_INSECURE_ENDPOINTS']));
    const api = apiEnvSchema.safeParse({ ...base, NODE_ENV: 'production', AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'p', COGNITO_CLIENT_ID: 'c', WEB_PUSH_VAPID_PUBLIC_KEY: DEV_VAPID_PUBLIC_KEY });
    expect(api.success).toBe(false);
  });
  it('requires the private key when a public key is set, and a mailto:/https: subject', async () => {
    const { workerEnvSchema } = await import('@dailytasks/config');
    expect(workerEnvSchema.safeParse({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: 'pub' }).success).toBe(false);
    expect(workerEnvSchema.safeParse({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: 'pub', WEB_PUSH_VAPID_PRIVATE_KEY: 'priv', WEB_PUSH_SUBJECT: 'ops@example.com' }).success).toBe(false);
    expect(workerEnvSchema.safeParse({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: 'pub', WEB_PUSH_VAPID_PRIVATE_KEY: 'priv', WEB_PUSH_SUBJECT: 'https://tasks.example.com' }).success).toBe(true);
  });
});

describe('VAPID env aliases', () => {
  it('accepts VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT; WEB_PUSH_* wins when both are set', async () => {
    const { loadEnv, workerEnvSchema } = await import('@dailytasks/config');
    const base = { DATABASE_URL: 'postgresql://x', S3_BUCKET: 'b', SQS_EVENTS_QUEUE_URL: 'http://q' };
    const a = loadEnv(workerEnvSchema, { ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:ops@example.com' });
    expect([a.WEB_PUSH_VAPID_PUBLIC_KEY, a.WEB_PUSH_VAPID_PRIVATE_KEY, a.WEB_PUSH_SUBJECT]).toEqual(['pub', 'priv', 'mailto:ops@example.com']);
    const b = loadEnv(workerEnvSchema, { ...base, VAPID_PUBLIC_KEY: 'alias', WEB_PUSH_VAPID_PUBLIC_KEY: 'canonical', WEB_PUSH_VAPID_PRIVATE_KEY: 'p' });
    expect(b.WEB_PUSH_VAPID_PUBLIC_KEY).toBe('canonical');
  });
});
