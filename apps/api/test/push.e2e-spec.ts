import { createHash } from 'node:crypto';
import request from 'supertest';
import { api, createTestApp, seedWorld, type TestContext } from './helpers';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

let n = 0;
const subscription = (host = 'https://fcm.googleapis.com/fcm/send/') => ({
  endpoint: `${host}${Date.now()}-${n++}`,
  expirationTime: null,
  keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'y'.repeat(22) },
});

describe('web push subscriptions', () => {
  let ctx: TestContext;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  beforeAll(async () => {
    ctx = await createTestApp();
    w = await seedWorld(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });

  const post = (userId: string, path: string, body: object, ua?: string) => {
    const r = api(ctx, userId).post(path, body);
    return ua ? r.set('User-Agent', ua) : r;
  };

  it('serves the VAPID public key without authentication (never the private key)', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY });
  });

  it('requires authentication for subscription management', async () => {
    const server = request(ctx.app.getHttpServer());
    expect((await server.post('/api/v1/push/subscribe').send(subscription())).status).toBe(401);
    expect((await server.get('/api/v1/push/status')).status).toBe(401);
    expect((await server.post('/api/v1/push/test')).status).toBe(401);
    expect((await server.delete('/api/v1/push/unsubscribe').send({ endpoint: 'x' })).status).toBe(401);
  });

  it('stores the subscription for the authenticated user (ignores any userId in the body), platform from UA', async () => {
    const s = subscription();
    const res = await post(w.emp1.id, '/push/subscribe', { ...s, userId: w.emp2.id }, IPHONE_UA);
    expect(res.status).toBe(201);
    const row = await ctx.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: s.endpoint } });
    expect(row).toMatchObject({ userId: w.emp1.id, platform: 'IOS', isActive: true, p256dh: s.keys.p256dh, auth: s.keys.auth });
    expect(res.body.endpointHash).toBe(createHash('sha256').update(s.endpoint).digest('hex').slice(0, 16));
  });

  it('validates the payload and the push service host (SSRF)', async () => {
    const bad = [
      { ...subscription(), keys: { p256dh: 'short', auth: 'y'.repeat(22) } },
      { ...subscription(), keys: { p256dh: `B${'x'.repeat(86)}`, auth: 'not base64url!!!!!!!!!' } },
      { ...subscription(), endpoint: 'not-a-url' },
      { keys: subscription().keys },
      subscription('https://evil.example.com/'),
      subscription('http://fcm.googleapis.com/fcm/send/'),
      subscription('http://169.254.169.254/latest/'),
      subscription('https://fcm.googleapis.com.attacker.io/'),
    ];
    for (const body of bad) expect((await post(w.emp1.id, '/push/subscribe', body)).status).toBe(400);
    for (const host of ['https://web.push.apple.com/', 'https://updates.push.services.mozilla.com/wpush/v2/', 'https://wns2-par02p.notify.windows.com/w/?token='])
      expect((await post(w.emp1.id, '/push/subscribe', subscription(host))).status).toBe(201);
  });

  it('supports multiple devices per user and never duplicates an endpoint', async () => {
    const before = await ctx.prisma.pushSubscription.count({ where: { userId: w.emp2.id } });
    const a = subscription();
    const b = subscription('https://web.push.apple.com/');
    await post(w.emp2.id, '/push/subscribe', a, ANDROID_UA).expect(201);
    await post(w.emp2.id, '/push/subscribe', b, IPHONE_UA).expect(201);
    await post(w.emp2.id, '/push/subscribe', a, ANDROID_UA).expect(201); // refresh, same endpoint
    expect(await ctx.prisma.pushSubscription.count({ where: { userId: w.emp2.id } })).toBe(before + 2);
    expect(await ctx.prisma.pushSubscription.count({ where: { endpoint: a.endpoint } })).toBe(1);
  });

  it('a browser endpoint moves to the user who is signed in now (shared device)', async () => {
    const s = subscription();
    await post(w.emp1.id, '/push/subscribe', s).expect(201);
    await post(w.emp3.id, '/push/subscribe', s).expect(201);
    const rows = await ctx.prisma.pushSubscription.findMany({ where: { endpoint: s.endpoint } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(w.emp3.id);
  });

  it('re-subscribing reactivates an expired subscription and updates its keys', async () => {
    const s = subscription();
    await post(w.emp1.id, '/push/subscribe', s).expect(201);
    await ctx.prisma.pushSubscription.update({ where: { endpoint: s.endpoint }, data: { isActive: false, deactivatedAt: new Date(), deactivationReason: 'push service returned 410', failureCount: 3 } });
    const fresh = { ...s, keys: { p256dh: `B${'z'.repeat(86)}`, auth: 'q'.repeat(22) } };
    await post(w.emp1.id, '/push/subscribe', fresh).expect(201);
    const row = await ctx.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: s.endpoint } });
    expect(row).toMatchObject({ isActive: true, deactivatedAt: null, deactivationReason: null, failureCount: 0, p256dh: fresh.keys.p256dh });
  });

  it('status lists only my subscriptions and never exposes endpoints or keys', async () => {
    const mine = subscription();
    await post(w.managerA.id, '/push/subscribe', mine, ANDROID_UA).expect(201);
    await post(w.managerB.id, '/push/subscribe', subscription(), IPHONE_UA).expect(201);
    const res = await api(ctx, w.managerA.id).get('/push/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.vapidPublicKey).toBe(process.env.WEB_PUSH_VAPID_PUBLIC_KEY);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0]).toMatchObject({ platform: 'ANDROID', device: 'Chrome on Android', isActive: true, lastDelivery: null });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(mine.endpoint);
    expect(json).not.toContain(mine.keys.p256dh);
    expect(json).not.toContain(mine.keys.auth);
  });

  it('unsubscribe removes only my own subscription (by endpoint or id)', async () => {
    const s1 = subscription();
    const s2 = subscription();
    await post(w.emp1.id, '/push/subscribe', s1).expect(201);
    const r2 = await post(w.emp2.id, '/push/subscribe', s2).expect(201);
    // Someone else's id / endpoint: no-op, no information leak.
    await api(ctx, w.emp1.id).delete('/push/unsubscribe', { id: r2.body.id }).expect(204);
    await api(ctx, w.emp1.id).delete('/push/unsubscribe', { endpoint: s2.endpoint }).expect(204);
    expect(await ctx.prisma.pushSubscription.count({ where: { endpoint: s2.endpoint } })).toBe(1);
    await api(ctx, w.emp1.id).delete('/push/unsubscribe', { endpoint: s1.endpoint }).expect(204);
    expect(await ctx.prisma.pushSubscription.count({ where: { endpoint: s1.endpoint } })).toBe(0);
    await api(ctx, w.emp2.id).delete('/push/unsubscribe', { id: r2.body.id }).expect(204);
    expect(await ctx.prisma.pushSubscription.count({ where: { endpoint: s2.endpoint } })).toBe(0);
    expect((await api(ctx, w.emp1.id).delete('/push/unsubscribe', {})).status).toBe(400);
  });

  it('test push goes through the outbox (202 = queued), needs an active subscription, is rate limited per user', async () => {
    const user = w.admin.id;
    expect((await api(ctx, user).post('/push/test')).status).toBe(400); // nothing subscribed
    await post(user, '/push/subscribe', subscription()).expect(201);
    const res = await api(ctx, user).post('/push/test');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, subscriptions: 1 });
    const events = await ctx.prisma.outboxEvent.findMany({ where: { type: 'PUSH_TEST', aggregateId: user } });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ userId: user });
    await api(ctx, user).post('/push/test').expect(202);
    await api(ctx, user).post('/push/test').expect(202);
    expect((await api(ctx, user).post('/push/test')).status).toBe(429);
  });

  it('push subscriptions are deleted with the user', async () => {
    const s = subscription();
    await post(w.emp3.id, '/push/subscribe', s).expect(201);
    const tmp = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `tmp-${Date.now()}@test.local`, name: 'tmp', role: 'EMPLOYEE' } });
    await post(tmp.id, '/push/subscribe', subscription()).expect(201);
    await ctx.prisma.user.delete({ where: { id: tmp.id } });
    expect(await ctx.prisma.pushSubscription.count({ where: { userId: tmp.id } })).toBe(0);
  });
});
