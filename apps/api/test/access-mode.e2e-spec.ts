import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import WebSocket from 'ws';
import { PrismaClient } from '@dailytasks/database';
import { api, createTestApp, seedWorld, type TestContext } from './helpers';

/**
 * Restricted acceptance mode (ACCESS_MODE=restricted): only allow-listed accounts can use the
 * system or be provisioned; everyone else is indistinguishable from an unknown/disabled account.
 */
describe('restricted acceptance mode (launch gate)', () => {
  let ctx: TestContext;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  let port: number;
  const PASSWORD = 'Accept1234';
  const TESTER = () => `tester-${w.company.id.slice(0, 8)}@test.local`;

  beforeAll(async () => {
    const seed = new PrismaClient();
    w = await seedWorld(seed);
    const hash = await bcrypt.hash(PASSWORD, 10);
    await seed.user.updateMany({ where: { id: { in: [w.admin.id, w.managerA.id, w.emp1.id] } }, data: { passwordHash: hash } });
    await seed.$disconnect();
    // Allow-list: the admin, managerA (upper-case on purpose: matching is case-insensitive) and a future tester.
    ctx = await createTestApp({ ACCESS_MODE: 'restricted', ACCESS_ALLOWLIST: `${w.admin.email}, ${w.managerA.email.toUpperCase()},${TESTER()}` });
    await ctx.app.listen(0, '127.0.0.1');
    port = (ctx.app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.prisma.$disconnect();
  });

  it('allow-listed accounts sign in; others get the same generic 401 as a wrong password', async () => {
    expect((await api(ctx).post('/auth/login', { email: w.admin.email, password: PASSWORD })).body.status).toBe('OK');
    // managerA is allow-listed in upper case: matching is case-insensitive.
    expect((await api(ctx, w.managerA.id).get('/auth/me')).status).toBe(200);
    const blocked = await api(ctx).post('/auth/login', { email: w.emp1.email, password: PASSWORD });
    const wrong = await api(ctx).post('/auth/login', { email: w.admin.email, password: 'Wrong-pass1' });
    expect(blocked.status).toBe(401);
    expect(blocked.body).toEqual(wrong.body); // no hint about acceptance mode
  });

  it('existing tokens of non-allow-listed users are refused on every endpoint and on refresh', async () => {
    expect((await api(ctx, w.emp1.id).get('/auth/me')).status).toBe(401);
    expect((await api(ctx, w.emp1.id).get('/tasks')).status).toBe(401);
    expect((await api(ctx, w.admin.id).get('/auth/me')).status).toBe(200);
    const refresh = ctx.tokens.issueLocalTokens(w.emp1.id).refreshToken;
    expect((await api(ctx).post('/auth/refresh', { refreshToken: refresh })).status).toBe(401);
  });

  it('admins can provision only allow-listed accounts (ordinary employees cannot be onboarded)', async () => {
    const body = { name: 'Someone', role: 'EMPLOYEE', departments: [{ departmentId: w.dept.id, isPrimary: true }] };
    const refused = await api(ctx, w.admin.id).post('/users', { ...body, email: `employee-${Date.now()}@test.local` });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_RESTRICTED');
    const ok = await api(ctx, w.admin.id).post('/users', { ...body, email: TESTER() });
    expect(ok.status).toBe(201);
    // Still admin-only, also in acceptance mode.
    expect((await api(ctx, w.managerA.id).post('/users', { ...body, email: TESTER() })).status).toBe(403);
  });

  it('the real-time socket refuses non-allow-listed users', async () => {
    const connect = (userId: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`, { headers: { Cookie: `dt_access=${ctx.tokens.issueLocalTokens(userId).accessToken}` } });
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
    expect(await connect(w.emp1.id)).toBe(401);
    expect(await connect(w.admin.id)).toBe(101);
  });

  it('public endpoints stay minimal: health and the push public key only; admin routes need a token', async () => {
    expect((await api(ctx).get('/users')).status).toBe(401);
    expect((await api(ctx).get('/departments')).status).toBe(401);
    const pub = await api(ctx).get('/push/vapid-public-key');
    expect(pub.status).toBe(200);
    // HSTS for this host only (no includeSubDomains / preload on the shared CloudFront domain).
    expect(pub.headers['strict-transport-security']).toBe('max-age=31536000');
  });
});
