import { api, createTestApp, inHours, seedWorld, type TestContext } from './helpers';

/**
 * End-to-end API tests against a real Postgres database.
 * Numbered comments map to the "critical scenarios" list in docs/TESTING.md.
 */
describe('Tasks, ratings and authorization (API)', () => {
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

  async function createTask(managerId = w.managerA.id, assigneeId = w.emp1.id, projectId = w.projectA.id, title = 'Install lights') {
    const res = await api(ctx, managerId).post('/tasks', { projectId, assigneeId, title, description: 'desc', deadline: inHours(48) });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string };
  }

  async function completeTask(taskId: string, userId = w.emp1.id) {
    const res = await api(ctx, userId).post(`/tasks/${taskId}/complete`, { comment: 'All done' });
    expect(res.status).toBe(200);
    return res.body;
  }

  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      expect((await api(ctx).get('/tasks')).status).toBe(401);
    });
    it('rejects deactivated users', async () => {
      const u = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `gone-${Date.now()}@t.local`, name: 'Gone', role: 'EMPLOYEE', isActive: false } });
      expect((await api(ctx, u.id).get('/auth/me')).status).toBe(401);
    });
    it('/auth/me returns project roles', async () => {
      const res = await api(ctx, w.managerA.id).get('/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.managedProjectIds).toEqual([w.projectA.id]);
    });
  });

  describe('task lifecycle', () => {
    it('creates a task, writes history and outbox events atomically', async () => {
      const t = await createTask();
      expect(t.status).toBe('ASSIGNED');
      const outbox = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: t.id } });
      expect(outbox.map((o) => o.type).sort()).toEqual(['TASK_ASSIGNED', 'TASK_SCHEDULE_SYNC']);
      const history = await ctx.prisma.taskHistory.findMany({ where: { taskId: t.id } });
      expect(history.map((h) => h.action)).toEqual(['CREATED']);
    });

    it('rejects assigning to someone who is not an employee of the project', async () => {
      const res = await api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectA.id, assigneeId: w.emp3.id, title: 'x', deadline: inHours(5) });
      expect(res.status).toBe(403);
    });

    it('rejects past deadlines', async () => {
      const res = await api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectA.id, assigneeId: w.emp1.id, title: 'x', deadline: inHours(-5) });
      expect(res.status).toBe(400);
    });

    it('9. rejects empty completion comments', async () => {
      const t = await createTask();
      for (const comment of ['', '   ', undefined]) {
        const res = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/complete`, { comment });
        expect(res.status).toBe(400);
      }
      const fresh = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(fresh.status).toBe('ASSIGNED');
    });

    it('completes immediately, records on-time completion, and cannot complete twice', async () => {
      const t = await createTask();
      const done = await completeTask(t.id);
      expect(done.status).toBe('COMPLETED');
      expect(done.completedLate).toBe(false);
      expect(done.isOverdue).toBe(false);
      expect(done.rating).toBeUndefined(); // employees never receive rating data
      const again = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/complete`, { comment: 'again' });
      expect(again.status).toBe(409);
      const comments = await api(ctx, w.emp1.id).get(`/tasks/${t.id}/comments`);
      expect(comments.body).toHaveLength(1);
      expect(comments.body[0].isCompletionNote).toBe(true);
    });

    it('retains late-completion information', async () => {
      const t = await createTask();
      await ctx.prisma.task.update({ where: { id: t.id }, data: { deadline: new Date(Date.now() - 3600_000) } });
      const done = await completeTask(t.id);
      expect(done.completedLate).toBe(true);
    });

    it('employee comment moves task to IN_PROGRESS and notifies managers via outbox', async () => {
      const t = await createTask();
      const res = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/comments`, { body: 'Started work' });
      expect(res.status).toBe(201);
      const task = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(task.status).toBe('IN_PROGRESS');
      expect(await ctx.prisma.outboxEvent.count({ where: { aggregateId: t.id, type: 'TASK_COMMENT_ADDED' } })).toBe(1);
    });

    it('manager can reopen; reopening is recorded with previous completion facts', async () => {
      const t = await createTask();
      await completeTask(t.id);
      const res = await api(ctx, w.managerA.id).post(`/tasks/${t.id}/reopen`, { reason: 'Missing photos' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ASSIGNED');
      expect(res.body.reopenCount).toBe(1);
      const history = await api(ctx, w.emp1.id).get(`/tasks/${t.id}/history`);
      const reopened = history.body.find((h: { action: string }) => h.action === 'REOPENED');
      expect(reopened.metadata.reason).toBe('Missing photos');
      expect(reopened.metadata.previousCompletedLate).toBe(false);
      expect(await ctx.prisma.taskComment.count({ where: { taskId: t.id } })).toBe(1); // preserved
    });

    it('12. deadline change bumps the schedule version and enqueues a new schedule sync', async () => {
      const t = await createTask();
      const before = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      const res = await api(ctx, w.managerA.id).patch(`/tasks/${t.id}`, { deadline: inHours(72) });
      expect(res.status).toBe(200);
      const after = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.scheduleVersion).toBe(before.scheduleVersion + 1);
      const syncs = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: t.id, type: 'TASK_SCHEDULE_SYNC' } });
      expect(syncs.map((s) => (s.payload as { scheduleVersion: number }).scheduleVersion).sort()).toEqual([1, 2]);
    });

    it('reassign moves access to the new employee', async () => {
      const t = await createTask();
      const res = await api(ctx, w.managerA.id).post(`/tasks/${t.id}/reassign`, { assigneeId: w.emp2.id });
      expect(res.status).toBe(200);
      expect((await api(ctx, w.emp1.id).get(`/tasks/${t.id}`)).status).toBe(404);
      expect((await api(ctx, w.emp2.id).get(`/tasks/${t.id}`)).status).toBe(200);
    });
  });

  describe('authorization', () => {
    it('1. employee cannot see another employee\'s tasks', async () => {
      const t = await createTask(w.managerA.id, w.emp2.id);
      expect((await api(ctx, w.emp1.id).get(`/tasks/${t.id}`)).status).toBe(404);
      expect((await api(ctx, w.emp1.id).get(`/tasks/${t.id}/comments`)).status).toBe(404);
      expect((await api(ctx, w.emp1.id).post(`/tasks/${t.id}/comments`, { body: 'hi' })).status).toBe(404);
      const list = await api(ctx, w.emp1.id).get('/tasks?pageSize=100');
      expect(list.body.items.every((i: { assignee: { id: string } }) => i.assignee.id === w.emp1.id)).toBe(true);
    });

    it('2. employee cannot access another project', async () => {
      expect((await api(ctx, w.emp1.id).get(`/projects/${w.projectB.id}`)).status).toBe(404);
      const tB = await createTask(w.managerB.id, w.emp3.id, w.projectB.id);
      expect((await api(ctx, w.emp1.id).get(`/tasks/${tB.id}`)).status).toBe(404);
      const projects = await api(ctx, w.emp1.id).get('/projects');
      expect(projects.body.map((p: { id: string }) => p.id)).toEqual([w.projectA.id]);
    });

    it('employees cannot list project members or create tasks', async () => {
      expect((await api(ctx, w.emp1.id).get(`/projects/${w.projectA.id}/members`)).status).toBe(403);
      const res = await api(ctx, w.emp1.id).post('/tasks', { projectId: w.projectA.id, assigneeId: w.emp2.id, title: 'x', deadline: inHours(5) });
      expect(res.status).toBe(403);
    });

    it('3. manager cannot access an unauthorized project', async () => {
      expect((await api(ctx, w.managerA.id).get(`/projects/${w.projectB.id}`)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).get(`/projects/${w.projectB.id}/members`)).status).toBe(404);
      const tB = await createTask(w.managerB.id, w.emp3.id, w.projectB.id);
      expect((await api(ctx, w.managerA.id).get(`/tasks/${tB.id}`)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).patch(`/tasks/${tB.id}`, { title: 'hijack' })).status).toBe(404);
      const create = await api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectB.id, assigneeId: w.emp3.id, title: 'x', deadline: inHours(5) });
      expect(create.status).toBe(404);
    });

    it('only the assignee can complete; managers cannot complete on their behalf', async () => {
      const t = await createTask();
      expect((await api(ctx, w.managerA.id).post(`/tasks/${t.id}/complete`, { comment: 'x' })).status).toBe(403);
    });

    it('admin sees all company tasks; non-admins cannot manage users', async () => {
      const tB = await createTask(w.managerB.id, w.emp3.id, w.projectB.id);
      expect((await api(ctx, w.admin.id).get(`/tasks/${tB.id}`)).status).toBe(200);
      expect((await api(ctx, w.managerA.id).post('/users', { email: 'x@y.z', name: 'x', role: 'EMPLOYEE', temporaryPassword: 'Abcdefg1' })).status).toBe(403);
    });

    it('15. removing a project membership prevents future access', async () => {
      const extra = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `extra-${Date.now()}@t.local`, name: 'Extra', role: 'EMPLOYEE' } });
      await api(ctx, w.admin.id).post(`/projects/${w.projectA.id}/members`, { userId: extra.id, role: 'EMPLOYEE' }).expect(201);
      const t = await createTask(w.managerA.id, extra.id);
      expect((await api(ctx, extra.id).get(`/tasks/${t.id}`)).status).toBe(200);
      await api(ctx, w.admin.id).delete(`/projects/${w.projectA.id}/members/${extra.id}`).expect(204);
      expect((await api(ctx, extra.id).get(`/tasks/${t.id}`)).status).toBe(404);
      expect((await api(ctx, extra.id).get(`/projects/${w.projectA.id}`)).status).toBe(404);
      expect((await api(ctx, extra.id).get('/tasks')).body.total).toBe(0);
      expect((await api(ctx, extra.id).post(`/tasks/${t.id}/complete`, { comment: 'sneaky' })).status).toBe(404);
    });

    it('rejects malformed ids', async () => {
      expect((await api(ctx, w.emp1.id).get('/tasks/not-a-uuid')).status).toBe(400);
    });
  });

  describe('attachments', () => {
    it('10. rejects invalid file types and sizes', async () => {
      const t = await createTask();
      const e = api(ctx, w.emp1.id);
      expect((await e.post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'virus.exe', contentType: 'application/x-msdownload', sizeBytes: 100 })).status).toBe(400);
      expect((await e.post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'fake.exe', contentType: 'image/png', sizeBytes: 100 })).status).toBe(400);
      expect((await e.post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'page.html', contentType: 'text/html', sizeBytes: 100 })).status).toBe(400);
      expect((await e.post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: 500 * 1024 * 1024 })).status).toBe(400);
    });

    it('upload -> confirm -> attach to completion -> authorized download only', async () => {
      const t = await createTask();
      const e = api(ctx, w.emp1.id);
      const up = await e.post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 1234 });
      expect(up.status).toBe(201);
      const att = await ctx.prisma.taskAttachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
      expect(att.storageKey).not.toContain('photo'); // random key, no user-controlled name

      // confirm before upload fails
      expect((await e.post(`/attachments/${att.id}/confirm`)).status).toBe(400);
      // size mismatch fails
      ctx.storage.put(att.storageKey, 99999);
      expect((await e.post(`/attachments/${att.id}/confirm`)).status).toBe(400);
      ctx.storage.put(att.storageKey, 1234, 'image/jpeg');
      expect((await e.post(`/attachments/${att.id}/confirm`)).status).toBe(200);

      const done = await e.post(`/tasks/${t.id}/complete`, { comment: 'Photos attached', attachmentIds: [att.id] });
      expect(done.status).toBe(200);
      const comments = await api(ctx, w.managerA.id).get(`/tasks/${t.id}/comments`);
      expect(comments.body[0].attachments).toHaveLength(1);

      expect((await api(ctx, w.managerA.id).get(`/attachments/${att.id}/download-url`)).status).toBe(200);
      expect((await api(ctx, w.emp2.id).get(`/attachments/${att.id}/download-url`)).status).toBe(404);
      expect((await api(ctx, w.managerB.id).get(`/attachments/${att.id}/download-url`)).status).toBe(404);
    });

    it('cannot link another user\'s attachment', async () => {
      const t = await createTask();
      const up = await api(ctx, w.managerA.id).post(`/tasks/${t.id}/attachments/upload-url`, { fileName: 'spec.pdf', contentType: 'application/pdf', sizeBytes: 10 });
      const att = await ctx.prisma.taskAttachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
      ctx.storage.put(att.storageKey, 10);
      await api(ctx, w.managerA.id).post(`/attachments/${att.id}/confirm`).expect(200);
      const res = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/comments`, { body: 'mine', attachmentIds: [att.id] });
      expect(res.status).toBe(403);
      // But the manager instruction file is visible to the employee on the task
      const detail = await api(ctx, w.emp1.id).get(`/tasks/${t.id}`);
      expect(detail.body.attachments.map((a: { id: string }) => a.id)).toEqual([att.id]);
    });
  });

  describe('ratings & privacy', () => {
    it('7. only completed tasks can be rated', async () => {
      const t = await createTask();
      expect((await api(ctx, w.managerA.id).put(`/tasks/${t.id}/rating`, { stars: 4 })).status).toBe(400);
    });

    it('rejects stars outside 1..5', async () => {
      const t = await createTask();
      await completeTask(t.id);
      for (const stars of [0, 6, 3.5]) expect((await api(ctx, w.managerA.id).put(`/tasks/${t.id}/rating`, { stars })).status).toBe(400);
    });

    it('4/5. employees cannot rate themselves or access any rating endpoint or feedback', async () => {
      const t = await createTask();
      await completeTask(t.id);
      await api(ctx, w.managerA.id).put(`/tasks/${t.id}/rating`, { stars: 4, feedback: 'secret feedback' }).expect(200);
      const e = api(ctx, w.emp1.id);
      expect((await e.put(`/tasks/${t.id}/rating`, { stars: 5 })).status).toBe(403);
      expect((await e.get(`/tasks/${t.id}/rating`)).status).toBe(403);
      expect((await e.get('/performance/employees')).status).toBe(403);
      expect((await e.get(`/performance/employees/${w.emp1.id}`)).status).toBe(403);
      // No rating data leaks through other endpoints
      const detail = await e.get(`/tasks/${t.id}`);
      expect(detail.body.rating).toBeUndefined();
      expect(JSON.stringify(detail.body)).not.toContain('secret feedback');
      const list = await e.get('/tasks?view=completed');
      expect(JSON.stringify(list.body)).not.toContain('"stars"');
      const history = await e.get(`/tasks/${t.id}/history`);
      expect(JSON.stringify(history.body)).not.toContain('secret feedback');
      const dash = await e.get('/dashboard');
      expect(dash.body.performance).toBeUndefined();
      expect(JSON.stringify(dash.body)).not.toContain('averageRating');
    });

    it('6. manager cannot rate tasks from unauthorized projects', async () => {
      const tB = await createTask(w.managerB.id, w.emp3.id, w.projectB.id);
      await completeTask(tB.id, w.emp3.id);
      expect((await api(ctx, w.managerA.id).put(`/tasks/${tB.id}/rating`, { stars: 1 })).status).toBe(404);
      expect((await api(ctx, w.managerA.id).get(`/performance/employees/${w.emp3.id}`)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).get(`/performance/employees?projectId=${w.projectB.id}`)).status).toBe(404);
    });

    it('8. one rating per task; edits are audited', async () => {
      const t = await createTask();
      await completeTask(t.id);
      const m = api(ctx, w.managerA.id);
      const [a, b] = await Promise.all([m.put(`/tasks/${t.id}/rating`, { stars: 3 }), m.put(`/tasks/${t.id}/rating`, { stars: 4 })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await ctx.prisma.taskRating.count({ where: { taskId: t.id } })).toBe(1);
      await m.put(`/tasks/${t.id}/rating`, { stars: 5, feedback: 'Great' }).expect(200);
      const revisions = await ctx.prisma.taskRatingRevision.findMany({ where: { rating: { taskId: t.id } }, orderBy: { createdAt: 'asc' } });
      expect(revisions.length).toBe(3);
      expect(revisions[0]!.previousStars).toBeNull();
      expect(revisions[2]!.newStars).toBe(5);
      // DB constraint is the last line of defence
      await expect(ctx.prisma.taskRating.create({ data: { taskId: t.id, employeeId: w.emp1.id, raterId: w.managerA.id, stars: 2 } })).rejects.toThrow();
    });

    it('14. averages are computed from valid ratings of completed tasks only', async () => {
      const emp = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `avg-${Date.now()}@t.local`, name: 'Avg', role: 'EMPLOYEE' } });
      await ctx.prisma.projectMembership.create({ data: { projectId: w.projectA.id, userId: emp.id, role: 'EMPLOYEE' } });
      const m = api(ctx, w.managerA.id);
      const stars = [5, 4, 2];
      const ids: string[] = [];
      for (const s of stars) {
        const t = await createTask(w.managerA.id, emp.id);
        await completeTask(t.id, emp.id);
        await m.put(`/tasks/${t.id}/rating`, { stars: s }).expect(200);
        ids.push(t.id);
      }
      // A completed-but-unrated task and an open task do not count.
      const unrated = await createTask(w.managerA.id, emp.id);
      await completeTask(unrated.id, emp.id);
      await createTask(w.managerA.id, emp.id);

      let perf = await m.get(`/performance/employees/${emp.id}`);
      expect(perf.status).toBe(200);
      expect(perf.body.averageRating).toBeCloseTo(11 / 3, 2);
      expect(perf.body.ratedTaskCount).toBe(3);
      expect(perf.body.completedTaskCount).toBe(4);
      expect(perf.body.ratings).toHaveLength(3);
      expect(perf.body.history).toHaveLength(3);

      // Reopened task's rating no longer counts until it is completed again.
      await m.post(`/tasks/${ids[2]}/reopen`, { reason: 'redo' }).expect(200);
      perf = await m.get(`/performance/employees/${emp.id}`);
      expect(perf.body.averageRating).toBeCloseTo(4.5, 2);
      expect(perf.body.ratedTaskCount).toBe(2);

      // Admin sees the same numbers; awaiting-rating view includes the unrated one.
      const adminPerf = await api(ctx, w.admin.id).get(`/performance/employees/${emp.id}`);
      expect(adminPerf.body.averageRating).toBeCloseTo(4.5, 2);
      const awaiting = await m.get(`/tasks?view=awaiting_rating&assigneeId=${emp.id}`);
      expect(awaiting.body.items.map((i: { id: string }) => i.id)).toContain(unrated.id);
    });
  });

  describe('notifications', () => {
    it('users only see and mark their own notifications', async () => {
      const n = await ctx.prisma.notification.create({
        data: { userId: w.emp1.id, type: 'TASK_ASSIGNED', title: 't', body: 'b', dedupeKey: `k-${Date.now()}` },
      });
      expect((await api(ctx, w.emp2.id).post(`/notifications/${n.id}/read`)).status).toBe(404);
      expect((await api(ctx, w.emp1.id).post(`/notifications/${n.id}/read`)).status).toBe(204);
      const list = await api(ctx, w.emp2.id).get('/notifications');
      expect(list.body.items.find((i: { id: string }) => i.id === n.id)).toBeUndefined();
    });
  });

  describe('dashboard', () => {
    it('manager dashboard includes totals and performance; scoped to managed projects', async () => {
      const res = await api(ctx, w.managerA.id).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.body.totals.projects).toBe(1);
      expect(Array.isArray(res.body.performance)).toBe(true);
      expect(res.body.performance.map((p: { employee: { id: string } }) => p.employee.id)).not.toContain(w.emp3.id);
    });
  });
});
