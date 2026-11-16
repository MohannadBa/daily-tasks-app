import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { REALTIME_CHANNEL, type RealtimeEnvelope } from '@dailytasks/shared-types';
import { api, createTestApp, inHours, seedWorld, type TestContext } from './helpers';
import { RealtimeService } from '../src/realtime/realtime.service';

/**
 * Features added for the production release: dashboard insights, task sorting, employee
 * memberships, password recovery, and real-time WebSocket updates (auth, origin, isolation, expiry).
 */
describe('platform features', () => {
  let ctx: TestContext;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  let port: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    w = await seedWorld(ctx.prisma);
    await new Promise<void>((r) => ctx.app.getHttpServer().listen(0, '127.0.0.1', r));
    port = (ctx.app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });

  const mkTask = (title: string, deadline: string, assigneeId = w.emp1.id) =>
    api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectA.id, assigneeId, title, deadline }).expect(201).then((r) => r.body);

  describe('dashboard', () => {
    it('counts tasks due within 24 h and shows recent activity scoped to the caller', async () => {
      const soon = await mkTask(`Due soon ${Date.now()}`, inHours(5));
      await mkTask(`Later ${Date.now()}`, inHours(72));
      const other = await mkTask(`Other employee ${Date.now()}`, inHours(3), w.emp2.id);

      const emp = await api(ctx, w.emp1.id).get('/dashboard').expect(200);
      expect(emp.body.totals.dueSoonTasks).toBeGreaterThanOrEqual(1);
      const empTaskIds = emp.body.recentActivity.map((a: { taskId: string }) => a.taskId);
      expect(empTaskIds).toContain(soon.id);
      expect(empTaskIds).not.toContain(other.id); // never another employee's activity
      expect(emp.body.recentActivity[0]).toMatchObject({ action: expect.any(String), taskTitle: expect.any(String), projectName: 'Project A' });
      expect(JSON.stringify(emp.body)).not.toMatch(/"stars"|"feedback"|averageRating/); // no rating data for employees

      const mgr = await api(ctx, w.managerA.id).get('/dashboard').expect(200);
      expect(mgr.body.recentActivity.map((a: { taskId: string }) => a.taskId)).toEqual(expect.arrayContaining([soon.id, other.id]));
      // Manager of another project sees none of Project A's activity.
      const b = await api(ctx, w.managerB.id).get('/dashboard').expect(200);
      expect(b.body.recentActivity.map((a: { taskId: string }) => a.taskId)).not.toContain(soon.id);
    });
  });

  describe('task sorting', () => {
    it('sorts by deadline both ways, newest and title; rejects unknown sorts', async () => {
      const tag = `Sort${Date.now()}`;
      await mkTask(`${tag} B`, inHours(30));
      await mkTask(`${tag} A`, inHours(50));
      await mkTask(`${tag} C`, inHours(10));
      const titles = async (sort: string) =>
        (await api(ctx, w.managerA.id).get(`/tasks?q=${tag}&sort=${sort}`).expect(200)).body.items.map((t: { title: string }) => t.title.slice(-1)).join('');
      expect(await titles('deadline')).toBe('CBA');
      expect(await titles('-deadline')).toBe('ABC');
      expect(await titles('title')).toBe('ABC');
      expect(await titles('-created')).toBe('CAB');
      expect((await api(ctx, w.managerA.id).get('/tasks?sort=password')).status).toBe(400);
    });
  });

  describe('employee detail', () => {
    it('lists project memberships visible to the manager', async () => {
      const r = await api(ctx, w.managerA.id).get(`/performance/employees/${w.emp1.id}`).expect(200);
      expect(r.body.projects).toEqual([{ id: w.projectA.id, name: 'Project A', role: 'EMPLOYEE', removed: false }]);
      // Employees can never open performance pages (ratings are private).
      expect((await api(ctx, w.emp1.id).get(`/performance/employees/${w.emp1.id}`)).status).toBe(403);
    });
  });

  describe('password recovery', () => {
    it('self-service reset is unavailable in local auth mode (501) and validates input', async () => {
      expect((await api(ctx).post('/auth/forgot-password', { email: w.emp1.email })).status).toBe(501);
      expect((await api(ctx).post('/auth/forgot-password', { email: 'not-an-email' })).status).toBe(400);
      expect((await api(ctx).post('/auth/reset-password', { email: w.emp1.email, code: '12', newPassword: 'Weakpass1' })).status).toBe(400);
    });

    it('admin can reset a password (local mode: temporary password); others cannot', async () => {
      const target = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `reset-${Date.now()}@test.local`, name: 'Reset Me', role: 'EMPLOYEE' } });
      expect((await api(ctx, w.managerA.id).post(`/users/${target.id}/reset-password`, { temporaryPassword: 'Temp12345' })).status).toBe(403);
      expect((await api(ctx, w.admin.id).post(`/users/${target.id}/reset-password`, {})).status).toBe(400);
      const r = await api(ctx, w.admin.id).post(`/users/${target.id}/reset-password`, { temporaryPassword: 'Temp12345' }).expect(200);
      expect(r.body).toEqual({ mode: 'temporary' });
      const login = await api(ctx).post('/auth/login', { email: target.email, password: 'Temp12345' });
      expect(login.status).toBe(200);
    });
  });

  describe('real-time WebSocket', () => {
    const url = () => `ws://127.0.0.1:${port}/api/v1/realtime`;
    const tokenFor = (userId: string) => ctx.tokens.issueLocalTokens(userId).accessToken;

    function connect(headers: Record<string, string>) {
      return new Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(url(), { headers });
        const messages: unknown[] = [];
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('message', (d) => messages.push(JSON.parse(String(d))));
        ws.on('open', () => resolve({ ws, messages, closed }));
        ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
        ws.on('error', (e) => reject(e));
      });
    }
    const waitFor = async (cond: () => boolean, ms = 4000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const publish = (envelope: RealtimeEnvelope) => ctx.prisma.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(envelope)})`;

    it('rejects missing/invalid tokens and foreign origins', async () => {
      await expect(connect({})).rejects.toMatchObject({ status: 401 });
      await expect(connect({ Cookie: 'dt_access=garbage' })).rejects.toMatchObject({ status: 401 });
      await expect(connect({ Cookie: `dt_access=${tokenFor(w.emp1.id)}`, Origin: 'https://evil.example.com' })).rejects.toMatchObject({ status: 403 });
      const inactive = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `off-${Date.now()}@test.local`, name: 'Off', role: 'EMPLOYEE', isActive: false } });
      await expect(connect({ Cookie: `dt_access=${tokenFor(inactive.id)}` })).rejects.toMatchObject({ status: 401 });
    });

    it('authenticates with the session cookie and delivers events only to the addressed users (across instances via NOTIFY)', async () => {
      const a = await connect({ Cookie: `dt_access=${tokenFor(w.emp1.id)}` });
      const b = await connect({ Authorization: `Bearer ${tokenFor(w.emp2.id)}` });
      await waitFor(() => a.messages.length > 0 && b.messages.length > 0);
      expect(a.messages[0]).toMatchObject({ type: 'hello', userId: w.emp1.id });

      await publish({ users: [w.emp1.id], event: { kind: 'notification', type: 'TASK_ASSIGNED', taskId: 't1', projectId: 'p1' } });
      await waitFor(() => a.messages.length === 2);
      expect(a.messages[1]).toEqual({ type: 'event', event: { kind: 'notification', type: 'TASK_ASSIGNED', taskId: 't1', projectId: 'p1' } });
      await new Promise((r) => setTimeout(r, 200));
      expect(b.messages).toHaveLength(1); // emp2 got nothing

      a.ws.close();
      b.ws.close();
      await Promise.all([a.closed, b.closed]);
      await waitFor(() => ctx.app.get(RealtimeService).connectionCount === 0); // cleanup on close
    });

    it('a real business event reaches the assignee live (worker publishes after creating the notification)', async () => {
      // The worker is not running in this test; emulate exactly what Notifier.publishRealtime sends.
      const s = await connect({ Cookie: `dt_access=${tokenFor(w.emp1.id)}` });
      await waitFor(() => s.messages.length === 1);
      const task = await mkTask(`Live ${Date.now()}`, inHours(20));
      await publish({ users: [w.emp1.id], event: { kind: 'notification', type: 'TASK_ASSIGNED', taskId: task.id, projectId: w.projectA.id } });
      await waitFor(() => s.messages.length === 2);
      expect((s.messages[1] as { event: { taskId: string } }).event.taskId).toBe(task.id);
      s.ws.close();
    });

    it('closes the socket with 4401 + reauth when the access token expires', async () => {
      const short = jwt.sign({ typ: 'access' }, process.env.JWT_SECRET!, { subject: w.emp1.id, issuer: 'dailytasks-local', expiresIn: 2 });
      const s = await connect({ Cookie: `dt_access=${short}` });
      const code = await s.closed;
      expect(code).toBe(4401);
      expect(s.messages.at(-1)).toEqual({ type: 'reauth' });
    }, 10_000);

    it('ignores non-realtime upgrade paths', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/other`, { headers: { Cookie: `dt_access=${tokenFor(w.emp1.id)}` } });
      const outcome = await new Promise<string>((r) => {
        ws.on('open', () => r('open'));
        ws.on('error', () => r('error'));
        ws.on('unexpected-response', () => r('rejected'));
      });
      expect(outcome).not.toBe('open');
      ws.terminate();
    });
  });
});
