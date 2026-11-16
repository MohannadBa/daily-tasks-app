import { api, createTestApp, inHours, joinDepartment, seedWorld, submitAndApprove, type TestContext } from './helpers';

const H = 3600_000;

/**
 * Enterprise workflow: departments, approval workflow, time accounting, transfers, extensions,
 * documents, personal tasks, reports, admin provisioning. Real Postgres (constraints + triggers).
 */
describe('Enterprise platform (API)', () => {
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

  const createTask = async (opts: { assigneeId?: string; managerId?: string; projectId?: string; deadlineHours?: number; departmentId?: string; priority?: string } = {}) => {
    const res = await api(ctx, opts.managerId ?? w.managerA.id).post('/tasks', {
      projectId: opts.projectId ?? w.projectA.id,
      departmentId: opts.departmentId ?? w.dept.id,
      assigneeId: opts.assigneeId ?? w.emp1.id,
      title: `Task ${Date.now()}`,
      deadline: inHours(opts.deadlineHours ?? 24),
      priority: opts.priority,
    });
    if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; status: string; approver: { id: string }; department: { id: string }; priority: string };
  };
  const submit = (taskId: string, userId: string, comment = 'Done, see notes', attachmentIds: string[] = []) => api(ctx, userId).post(`/tasks/${taskId}/submissions`, { comment, attachmentIds });
  const detail = async (taskId: string, userId: string) => (await api(ctx, userId).get(`/tasks/${taskId}`)).body;
  const openSegment = (taskId: string) => ctx.prisma.taskTimeSegment.findFirstOrThrow({ where: { taskId, endedAt: null } });
  /** Back-dates the open segment so it appears to have started `hours` ago (open segments are mutable). */
  const ageOpenSegment = async (taskId: string, hours: number) => {
    const s = await openSegment(taskId);
    await ctx.prisma.taskTimeSegment.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - hours * H) } });
  };
  /** Starts the cycle `hours` ago with a budget of `budgetHours`, all spent in the open ACTIVE_WORK segment. */
  const startCycleAgo = async (taskId: string, hours: number, budgetHours: number) => {
    const c = await ctx.prisma.taskCycle.findFirstOrThrow({ where: { taskId } });
    const start = new Date(Date.now() - hours * H);
    await ctx.prisma.taskCycle.update({ where: { id: c.id }, data: { startedAt: start, approvedDeadline: new Date(start.getTime() + budgetHours * H), originalDeadline: new Date(start.getTime() + budgetHours * H) } });
    await ageOpenSegment(taskId, hours);
  };
  const time = async (taskId: string, userId = w.managerA.id) => (await api(ctx, userId).get(`/tasks/${taskId}/time`)).body.cycles as Array<{
    accountableMs: number;
    budgetMs: number;
    overdueMs: number;
    completedLate: boolean | null;
    perEmployee: Array<{ user: { id: string }; chargedMs: number; lateMs: number }>;
    segments: Array<{ kind: string; charged: boolean }>;
  }>;
  const near = (actual: number, expectedHours: number) => expect(Math.abs(actual - expectedHours * H)).toBeLessThan(2 * 60_000);

  /* ============================== departments ============================== */

  describe('departments', () => {
    it('seeds 7 departments; everyone can list; only admins manage; duplicates rejected; audited', async () => {
      const list = await api(ctx, w.emp1.id).get('/departments').expect(200);
      expect(list.body).toHaveLength(7);
      expect(list.body.map((d: { code: string }) => d.code)).toContain('PROJECT_MANAGEMENT');
      expect((await api(ctx, w.managerA.id).post('/departments', { code: 'LEGAL', nameAr: 'القانونية', nameEn: 'Legal' })).status).toBe(403);
      const created = await api(ctx, w.admin.id).post('/departments', { code: 'LEGAL', nameAr: 'القانونية', nameEn: 'Legal' }).expect(201);
      expect((await api(ctx, w.admin.id).post('/departments', { code: 'LEGAL', nameAr: 'أخرى', nameEn: 'Other' })).status).toBe(409);
      await api(ctx, w.admin.id).patch(`/departments/${created.body.id}`, { isActive: false }).expect(200);
      expect((await api(ctx, w.emp1.id).get('/departments')).body.map((d: { id: string }) => d.id)).not.toContain(created.body.id);
      const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: created.body.id } });
      expect(audit.map((a) => a.action).sort()).toEqual(['DEPARTMENT_CREATED', 'DEPARTMENT_DEACTIVATED']);
    });

    it('task creation requires an active department the assignee belongs to; preserves department, priority and assigning manager', async () => {
      const inactive = await ctx.prisma.department.create({ data: { companyId: w.company.id, code: 'OLD_DEPT', nameAr: 'قديمة', nameEn: 'Old', isActive: false } });
      await joinDepartment(ctx.prisma, inactive.id, w.emp1.id, false);
      expect((await api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectA.id, departmentId: inactive.id, assigneeId: w.emp1.id, title: 'x', deadline: inHours(5) })).status).toBe(400);
      // emp2 is in Engineering; emp1 is not.
      expect((await api(ctx, w.managerA.id).post('/tasks', { projectId: w.projectA.id, departmentId: w.dept2.id, assigneeId: w.emp1.id, title: 'x', deadline: inHours(5) })).body.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
      const t = await createTask({ assigneeId: w.emp2.id, departmentId: w.dept2.id, priority: 'URGENT' });
      expect(t.department.id).toBe(w.dept2.id);
      expect(t.priority).toBe('URGENT');
      expect(t.approver.id).toBe(w.managerA.id);
      const filtered = await api(ctx, w.managerA.id).get(`/tasks?departmentId=${w.dept2.id}&priority=URGENT`).expect(200);
      expect(filtered.body.items.map((i: { id: string }) => i.id)).toEqual([t.id]);
    });

    it('assignable employees = project ∩ department; department reassignment keeps one primary and an audit trail', async () => {
      const r = await api(ctx, w.managerA.id).get(`/departments/${w.dept2.id}/assignable-employees?projectId=${w.projectA.id}`).expect(200);
      expect(r.body.map((u: { id: string }) => u.id)).toEqual([w.emp2.id]);
      expect((await api(ctx, w.managerA.id).get(`/departments/${w.dept2.id}/assignable-employees?projectId=${w.projectB.id}`)).status).toBe(404);
      expect((await api(ctx, w.emp1.id).get(`/departments/${w.dept2.id}/assignable-employees?projectId=${w.projectA.id}`)).status).toBe(403);

      const u = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `dept-${Date.now()}@t.local`, name: 'Movable', role: 'EMPLOYEE' } });
      expect((await api(ctx, w.admin.id).put(`/users/${u.id}/departments`, { departments: [{ departmentId: w.dept.id, isPrimary: true }, { departmentId: w.dept2.id, isPrimary: true }] })).status).toBe(400);
      await api(ctx, w.admin.id).put(`/users/${u.id}/departments`, { departments: [{ departmentId: w.dept.id, isPrimary: true }] }).expect(200);
      const moved = await api(ctx, w.admin.id).put(`/users/${u.id}/departments`, { departments: [{ departmentId: w.dept.id }, { departmentId: w.dept2.id, isPrimary: true }] }).expect(200);
      expect(moved.body.departments).toEqual([expect.objectContaining({ id: w.dept2.id, isPrimary: true }), expect.objectContaining({ id: w.dept.id, isPrimary: false })]);
      await api(ctx, w.admin.id).put(`/users/${u.id}/departments`, { departments: [{ departmentId: w.dept2.id, isPrimary: true }] }).expect(200);
      const history = await api(ctx, w.admin.id).get(`/departments/${w.dept.id}/history`).expect(200);
      expect(history.body.find((h: { user: { id: string } }) => h.user.id === u.id).removedAt).not.toBeNull();
      expect((await api(ctx, w.admin.id).get(`/users/${u.id}/audit`)).body.filter((a: { action: string }) => a.action === 'USER_DEPARTMENTS_CHANGED')).toHaveLength(3);
    });
  });

  /* ============================ approval workflow ============================ */

  describe('approval workflow', () => {
    it('submission requires a comment, pauses for review and never completes without approval', async () => {
      const t = await createTask();
      expect((await submit(t.id, w.emp1.id, '   ')).status).toBe(400);
      const s = await submit(t.id, w.emp1.id);
      expect(s.status).toBe(201);
      expect(s.body).toMatchObject({ stage: 'MANAGER', status: 'PENDING', reviewer: { id: w.managerA.id } });
      const d = await detail(t.id, w.emp1.id);
      expect(d.status).toBe('PENDING_REVIEW');
      expect(d.time.paused).toBe(true);
      expect(d.permissions).toMatchObject({ canApprove: false, canWithdraw: true, canSubmit: false });
      expect((await detail(t.id, w.managerA.id)).permissions.canApprove).toBe(true);
      expect((await submit(t.id, w.emp1.id)).status).toBe(409); // one pending submission
      // Only the approver: the employee, a delegate, another project's manager cannot decide.
      expect((await api(ctx, w.emp1.id).post(`/submissions/${s.body.id}/approve`, {})).status).toBe(403);
      expect((await api(ctx, w.managerB.id).post(`/submissions/${s.body.id}/approve`, {})).status).toBe(404);
      expect((await api(ctx, w.emp2.id).post(`/submissions/${s.body.id}/approve`, {})).status).toBe(404);
      expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('PENDING_REVIEW');
      // The submission is immutable once decided (DB trigger), and the decision is single-shot.
      const [a, b] = await Promise.all([api(ctx, w.managerA.id).post(`/submissions/${s.body.id}/approve`, {}), api(ctx, w.managerA.id).post(`/submissions/${s.body.id}/approve`, {})]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      await expect(ctx.prisma.taskSubmission.update({ where: { id: s.body.id }, data: { decisionReason: 'tampered' } })).rejects.toThrow();
      expect((await detail(t.id, w.emp1.id)).status).toBe('COMPLETED');
    });

    it('rejection requires a reason, returns the task to IN_PROGRESS and keeps every submission', async () => {
      const t = await createTask();
      const s1 = (await submit(t.id, w.emp1.id, 'first try')).body;
      expect((await api(ctx, w.managerA.id).post(`/submissions/${s1.id}/reject`, { reason: ' ' })).status).toBe(400);
      const rej = await api(ctx, w.managerA.id).post(`/submissions/${s1.id}/reject`, { reason: 'Photos missing' }).expect(200);
      expect(rej.body).toMatchObject({ status: 'REJECTED', decisionReason: 'Photos missing' });
      expect((await detail(t.id, w.emp1.id)).status).toBe('IN_PROGRESS');
      const s2 = (await submit(t.id, w.emp1.id, 'second try with photos')).body;
      await api(ctx, w.managerA.id).post(`/submissions/${s2.id}/approve`, { note: 'Good' }).expect(200);
      const subs = await api(ctx, w.emp1.id).get(`/tasks/${t.id}/submissions`).expect(200);
      expect(subs.body.map((x: { status: string }) => x.status)).toEqual(['APPROVED', 'REJECTED']);
      const outbox = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: t.id, type: { in: ['TASK_SUBMITTED', 'TASK_REJECTED', 'TASK_APPROVED'] } } });
      expect(outbox.map((o) => o.type).sort()).toEqual(['TASK_APPROVED', 'TASK_REJECTED', 'TASK_SUBMITTED', 'TASK_SUBMITTED']);
      const rejected = outbox.find((o) => o.type === 'TASK_REJECTED')!.payload as { recipients: string[]; vars: { reason: string } };
      expect(rejected.recipients).toEqual([w.emp1.id]);
      expect(rejected.vars.reason).toBe('Photos missing');
    });

    it('withdrawal before a decision returns the task to the employee', async () => {
      const t = await createTask();
      const s = (await submit(t.id, w.emp1.id)).body;
      expect((await api(ctx, w.managerA.id).post(`/submissions/${s.id}/withdraw`)).status).toBe(403);
      await api(ctx, w.emp1.id).post(`/submissions/${s.id}/withdraw`).expect(200);
      expect((await detail(t.id, w.emp1.id)).status).toBe('IN_PROGRESS');
    });

    it('admin break-glass works only on tasks the admin manages; a reason is required and audited', async () => {
      // Admin creates a task and hands approval to manager A; he still manages it (creator).
      const t = await createTask({ managerId: w.admin.id });
      await api(ctx, w.admin.id).patch(`/tasks/${t.id}/approver`, { approverId: w.managerA.id }).expect(200);
      const s = (await submit(t.id, w.emp1.id)).body;
      expect((await api(ctx, w.admin.id).post(`/submissions/${s.id}/approve`, {})).status).toBe(400);
      const ok = await api(ctx, w.admin.id).post(`/submissions/${s.id}/approve`, { adminReason: 'Manager on leave' }).expect(200);
      expect(ok.body.decidedAsAdmin).toBe(true);
      const h = await ctx.prisma.taskHistory.findFirstOrThrow({ where: { taskId: t.id, action: 'APPROVED' } });
      expect((h.metadata as { decidedAsAdmin: boolean }).decidedAsAdmin).toBe(true);

      // A manager's own task is invisible to the admin: no break-glass, no approver change.
      const t2 = await createTask();
      const s2 = (await submit(t2.id, w.emp1.id)).body;
      expect((await api(ctx, w.admin.id).post(`/submissions/${s2.id}/approve`, { adminReason: 'x' })).status).toBe(404);
      expect((await api(ctx, w.admin.id).patch(`/tasks/${t2.id}/approver`, { approverId: w.admin.id })).status).toBe(404);
      expect((await api(ctx, w.managerA.id).patch(`/tasks/${t2.id}/approver`, { approverId: w.admin.id })).status).toBe(403);
      const t3 = await createTask({ managerId: w.admin.id });
      expect((await api(ctx, w.admin.id).patch(`/tasks/${t3.id}/approver`, { approverId: w.managerB.id })).status).toBe(400); // not a manager of project A
    });

    it('reassignment is blocked while a submission is pending', async () => {
      const t = await createTask();
      await submit(t.id, w.emp1.id);
      expect((await api(ctx, w.managerA.id).post(`/tasks/${t.id}/reassign`, { assigneeId: w.emp2.id })).status).toBe(409);
    });
  });

  /* ============================== time accounting ============================== */

  describe('time accounting', () => {
    it('Example 1: 22h work + 8h review approved = 22h accountable (on time against 24h)', async () => {
      const t = await createTask();
      await startCycleAgo(t.id, 22, 24);
      const s = (await submit(t.id, w.emp1.id)).body;
      await ageOpenSegment(t.id, 8); // the manager took 8 hours
      await api(ctx, w.managerA.id).post(`/submissions/${s.id}/approve`, {}).expect(200);
      const [c] = await time(t.id);
      near(c!.accountableMs, 22);
      expect(c!.completedLate).toBe(false);
      expect(c!.segments.map((x) => [x.kind, x.charged])).toEqual([
        ['ACTIVE_WORK', true],
        ['APPROVED_REVIEW', false],
      ]);
      expect((await detail(t.id, w.emp1.id)).completedLate).toBe(false);
    });

    it('Example 2: 22h work + 6h review rejected = 28h accountable; approved later it is late', async () => {
      const t = await createTask();
      await startCycleAgo(t.id, 22, 24);
      const s = (await submit(t.id, w.emp1.id)).body;
      await ageOpenSegment(t.id, 6);
      await api(ctx, w.managerA.id).post(`/submissions/${s.id}/reject`, { reason: 'Incomplete' }).expect(200);
      let [c] = await time(t.id);
      near(c!.accountableMs, 28);
      expect(c!.overdueMs).toBeGreaterThan(3.9 * H);
      const d = await detail(t.id, w.emp1.id);
      expect(d.isOverdue).toBe(true);
      expect(d.time.overdue).toBe(true);
      const overdue = await api(ctx, w.managerA.id).get('/tasks?view=overdue&pageSize=100').expect(200);
      expect(overdue.body.items.map((i: { id: string }) => i.id)).toContain(t.id);
      const s2 = (await submit(t.id, w.emp1.id)).body;
      await api(ctx, w.managerA.id).post(`/submissions/${s2.id}/approve`, {}).expect(200);
      [c] = await time(t.id);
      near(c!.accountableMs, 28);
      expect(c!.completedLate).toBe(true);
      near(c!.perEmployee.find((p) => p.user.id === w.emp1.id)!.chargedMs, 28);
    });

    it('an approved deadline in the wall-clock past is not overdue while the clock is paused for review', async () => {
      const t = await createTask({ deadlineHours: 1 });
      await startCycleAgo(t.id, 0.5, 1);
      await submit(t.id, w.emp1.id);
      await ageOpenSegment(t.id, 5); // waiting 5h on the manager, wall deadline long gone
      const d = await detail(t.id, w.emp1.id);
      expect(d.time.paused).toBe(true);
      expect(d.isOverdue).toBe(false);
    });

    it('reopening starts a new cycle; previous cycle snapshot is preserved', async () => {
      const t = await createTask();
      await submitAndApprove(ctx, t.id, w.emp1.id);
      await api(ctx, w.managerA.id).post(`/tasks/${t.id}/reopen`, { reason: 'Client changes', deadline: inHours(10) }).expect(200);
      const cycles = await time(t.id);
      expect(cycles).toHaveLength(2);
      expect(cycles[0]!.completedLate).toBe(false);
      near(cycles[1]!.budgetMs, 10);
    });
  });

  /* ================================ transfers ================================ */

  describe('transfers & delegation chain', () => {
    let emp4: { id: string };
    let emp5: { id: string };
    beforeAll(async () => {
      for (const name of ['emp4', 'emp5']) {
        const u = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `${name}-${Date.now()}@t.local`, name, role: 'EMPLOYEE' } });
        await ctx.prisma.projectMembership.create({ data: { projectId: w.projectA.id, userId: u.id, role: 'EMPLOYEE' } });
        await joinDepartment(ctx.prisma, w.dept.id, u.id);
        if (name === 'emp4') emp4 = u;
        else emp5 = u;
      }
    });

    it('A → B (accept) → B submits → A forwards → manager approves; time charged per employee; original deadline kept', async () => {
      const t = await createTask();
      const original = (await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } })).originalDeadline;
      expect((await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: '' })).status).toBe(400);
      const tr = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'Needs electrical skills' }).expect(201);
      expect(tr.body).toMatchObject({ status: 'PENDING', depth: 1, from: { id: w.emp1.id }, to: { id: w.emp2.id } });
      expect((await api(ctx, w.emp2.id).get('/me/transfers')).body.map((x: { id: string }) => x.id)).toContain(tr.body.id);
      expect((await api(ctx, w.emp1.id).post(`/transfers/${tr.body.id}/accept`)).status).toBe(403); // only the recipient
      await api(ctx, w.emp2.id).post(`/transfers/${tr.body.id}/accept`, {}).expect(200);
      let d = await detail(t.id, w.emp2.id);
      expect(d.assignee.id).toBe(w.emp2.id);
      expect((await api(ctx, w.emp1.id).get(`/tasks/${t.id}`)).status).toBe(200); // A stays a participant

      const s = await submit(t.id, w.emp2.id, 'Wiring done');
      expect(s.body).toMatchObject({ stage: 'DELEGATOR', reviewer: { id: w.emp1.id } });
      expect((await api(ctx, w.managerA.id).post(`/submissions/${s.body.id}/approve`, {})).status).toBe(403); // awaits the delegator first
      expect((await api(ctx, w.emp2.id).post(`/submissions/${s.body.id}/forward`, {})).status).toBe(403);
      const f = await api(ctx, w.emp1.id).post(`/submissions/${s.body.id}/forward`, { note: 'Checked' }).expect(200);
      expect(f.body).toMatchObject({ stage: 'MANAGER', reviewer: { id: w.managerA.id }, submittedBy: { id: w.emp1.id }, forwardedFromId: s.body.id });
      // B cannot approve the work it did, nor can A.
      expect((await api(ctx, w.emp1.id).post(`/submissions/${f.body.id}/approve`, {})).status).toBe(403);
      await api(ctx, w.managerA.id).post(`/submissions/${f.body.id}/approve`, {}).expect(200);
      d = await detail(t.id, w.managerA.id);
      expect(d.status).toBe('COMPLETED');
      expect(d.assignee.id).toBe(w.emp1.id); // accountable employee (rating subject) is A
      expect(new Date(d.originalDeadline).getTime()).toBe(original.getTime());
      const [c] = await time(t.id);
      expect(c!.perEmployee.map((p) => p.user.id).sort()).toEqual([w.emp1.id, w.emp2.id].sort());
      const hist = (await api(ctx, w.emp1.id).get(`/tasks/${t.id}/history`)).body.map((h: { action: string }) => h.action);
      expect(hist).toEqual(expect.arrayContaining(['TRANSFER_REQUESTED', 'TRANSFER_ACCEPTED', 'SUBMITTED', 'FORWARDED', 'APPROVED']));
      const notifications = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: t.id, type: { in: ['TASK_TRANSFER_REQUESTED', 'TASK_TRANSFER_ACCEPTED', 'TASK_SUBMITTED', 'TASK_SUBMISSION_FORWARDED'] } } });
      expect(notifications).toHaveLength(4);
    });

    it('delegator can return work (reason required) and manager rejection of forwarded work goes back to A', async () => {
      const t = await createTask();
      const tr = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'help' })).body;
      await api(ctx, w.emp2.id).post(`/transfers/${tr.id}/accept`, {}).expect(200);
      const s = (await submit(t.id, w.emp2.id)).body;
      expect((await api(ctx, w.emp1.id).post(`/submissions/${s.id}/return`, {})).status).toBe(400);
      await api(ctx, w.emp1.id).post(`/submissions/${s.id}/return`, { reason: 'Label the cables' }).expect(200);
      expect((await detail(t.id, w.emp2.id)).assignee.id).toBe(w.emp2.id);
      const s2 = (await submit(t.id, w.emp2.id)).body;
      const f = (await api(ctx, w.emp1.id).post(`/submissions/${s2.id}/forward`, {})).body;
      await api(ctx, w.managerA.id).post(`/submissions/${f.id}/reject`, { reason: 'Wrong panel' }).expect(200);
      const d = await detail(t.id, w.emp1.id);
      expect(d.status).toBe('IN_PROGRESS');
      expect(d.assignee.id).toBe(w.emp1.id);
      // A can delegate again to B (new chain, A → B → A pattern).
      const again = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'Fix the panel' });
      expect(again.status).toBe(201);
    });

    it('protects the chain: no circular transfers, no approver, project+department only, max depth 3', async () => {
      const t = await createTask();
      const hop = async (from: string, to: string) => {
        const r = await api(ctx, from).post(`/tasks/${t.id}/transfers`, { toUserId: to, reason: 'delegating' });
        if (r.status === 201) await api(ctx, to).post(`/transfers/${r.body.id}/accept`, {}).expect(200);
        return r;
      };
      const candidates = (await api(ctx, w.emp1.id).get(`/tasks/${t.id}/transfer-candidates`).expect(200)).body.map((u: { id: string }) => u.id);
      expect(candidates.sort()).toEqual([w.emp2.id, emp4.id, emp5.id].sort());
      expect((await api(ctx, w.emp2.id).get(`/tasks/${t.id}/transfer-candidates`)).status).toBe(404);
      expect((await hop(w.emp1.id, w.emp1.id)).status).toBe(409); // self
      expect((await hop(w.emp1.id, w.managerA.id)).status).toBe(409); // approver / not an employee
      expect((await hop(w.emp1.id, w.emp3.id)).status).toBe(409); // not in project A
      expect((await hop(w.emp1.id, w.emp2.id)).status).toBe(201);
      const circular = await hop(w.emp2.id, w.emp1.id);
      expect(circular.status).toBe(409);
      expect(circular.body.code).toBe('TRANSFER_CHAIN_INVALID');
      expect((await hop(w.emp2.id, emp4.id)).status).toBe(201);
      expect((await hop(emp4.id, emp5.id)).status).toBe(201);
      const tooDeep = await api(ctx, emp5.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'x' });
      expect(tooDeep.status).toBe(409);
      // Non-holders cannot transfer.
      expect((await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: emp4.id, reason: 'x' })).status).toBe(403);
    });

    it('decline keeps responsibility with the requester; requester can cancel; reason is mandatory on decline', async () => {
      const t = await createTask();
      const tr = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'help' })).body;
      expect((await submit(t.id, w.emp1.id)).status).toBe(409); // transfer pending
      expect((await api(ctx, w.emp2.id).post(`/transfers/${tr.id}/decline`, {})).status).toBe(400);
      await api(ctx, w.emp2.id).post(`/transfers/${tr.id}/decline`, { reason: 'Overloaded' }).expect(200);
      expect((await detail(t.id, w.emp1.id)).assignee.id).toBe(w.emp1.id);
      const tr2 = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'again' })).body;
      await api(ctx, w.emp1.id).post(`/transfers/${tr2.id}/cancel`, {}).expect(200);
      // The recipient of a cancelled transfer no longer sees the task at all (IDOR-safe 404).
      expect((await api(ctx, w.emp2.id).post(`/transfers/${tr2.id}/accept`, {})).status).toBe(404);
      const decl = await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: t.id, type: 'TASK_TRANSFER_DECLINED' } });
      expect((decl.payload as { recipients: string[] }).recipients).toEqual([w.emp1.id]);
    });
  });

  /* =============================== extensions =============================== */

  describe('deadline extensions', () => {
    it('full, partial and rejected decisions; original deadline preserved; reminders rescheduled', async () => {
      const t = await createTask({ deadlineHours: 24 });
      const before = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect((await api(ctx, w.emp1.id).post(`/tasks/${t.id}/extensions`, { requestedMinutes: 120, reason: '' })).status).toBe(400);
      const x1 = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/extensions`, { requestedMinutes: 240, reason: 'Material delay' }).expect(201)).body;
      expect((await api(ctx, w.emp1.id).post(`/tasks/${t.id}/extensions`, { requestedMinutes: 60, reason: 'x' })).status).toBe(409);
      expect((await api(ctx, w.emp1.id).post(`/extensions/${x1.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
      expect((await api(ctx, w.managerB.id).post(`/extensions/${x1.id}/decide`, { decision: 'APPROVE' })).status).toBe(404);
      const partial = await api(ctx, w.managerA.id).post(`/extensions/${x1.id}/decide`, { decision: 'PARTIAL', grantedMinutes: 120 }).expect(200);
      expect(partial.body).toMatchObject({ status: 'PARTIALLY_APPROVED', grantedMinutes: 120 });
      let after = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.deadline.getTime() - before.deadline.getTime()).toBe(120 * 60_000);
      expect(after.originalDeadline.getTime()).toBe(before.originalDeadline.getTime());
      expect(after.scheduleVersion).toBeGreaterThan(before.scheduleVersion);
      expect(Number(after.budgetMs) - Number(before.budgetMs)).toBe(120 * 60_000);
      const syncs = await ctx.prisma.outboxEvent.count({ where: { aggregateId: t.id, type: 'TASK_SCHEDULE_SYNC' } });
      expect(syncs).toBeGreaterThanOrEqual(2);

      const x2 = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/extensions`, { requestedMinutes: 60, reason: 'Inspection' }).expect(201)).body;
      expect((await api(ctx, w.managerA.id).post(`/extensions/${x2.id}/decide`, { decision: 'REJECT' })).status).toBe(400); // note required
      await api(ctx, w.managerA.id).post(`/extensions/${x2.id}/decide`, { decision: 'REJECT', note: 'Not justified' }).expect(200);
      const x3 = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/extensions`, { requestedMinutes: 30, reason: 'Rain' }).expect(201)).body;
      await api(ctx, w.managerA.id).post(`/extensions/${x3.id}/decide`, { decision: 'APPROVE' }).expect(200);
      after = await ctx.prisma.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.deadline.getTime() - before.deadline.getTime()).toBe(150 * 60_000);
      const list = (await api(ctx, w.emp1.id).get(`/tasks/${t.id}/extensions`)).body;
      expect(list.map((x: { status: string }) => x.status)).toEqual(['APPROVED', 'REJECTED', 'PARTIALLY_APPROVED']);
      const d = await detail(t.id, w.emp1.id);
      expect(new Date(d.originalDeadline).getTime()).toBe(before.originalDeadline.getTime());
    });
  });

  /* ================================ documents ================================ */

  describe('project documents', () => {
    const upload = async (userId: string, taskId: string, name = 'report.pdf') => {
      const up = await api(ctx, userId).post(`/tasks/${taskId}/attachments/upload-url`, { fileName: name, contentType: 'application/pdf', sizeBytes: 2048 }).expect(201);
      const att = await ctx.prisma.taskAttachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
      ctx.storage.put(att.storageKey, 2048, 'application/pdf');
      await api(ctx, userId).post(`/attachments/${att.id}/confirm`).expect(200);
      return att;
    };

    it('approval auto-registers submission files once (same S3 object), managers-only by default', async () => {
      const t = await createTask();
      const att = await upload(w.emp1.id, t.id);
      const s = (await submit(t.id, w.emp1.id, 'Signed report', [att.id])).body;
      // Not registered before approval.
      expect((await api(ctx, w.managerA.id).get(`/projects/${w.projectA.id}/documents?taskId=${t.id}`)).body.total).toBe(0);
      await api(ctx, w.managerA.id).post(`/submissions/${s.id}/approve`, {}).expect(200);
      const docs = await api(ctx, w.managerA.id).get(`/projects/${w.projectA.id}/documents?taskId=${t.id}`).expect(200);
      expect(docs.body.total).toBe(1);
      const doc = docs.body.items[0];
      expect(doc).toMatchObject({ source: 'TASK_SUBMISSION', visibility: 'MANAGERS_ONLY', fileName: 'report.pdf', submissionId: s.id, category: { code: 'COMPLETION' } });
      const row = await ctx.prisma.projectDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row.attachmentId).toBe(att.id);
      expect(row.storageKey).toBeNull(); // no copy
      const dl = await api(ctx, w.managerA.id).get(`/documents/${doc.id}/download-url`).expect(200);
      expect(dl.body.url).toContain(att.storageKey);
      // Employees (even the uploader) and other projects' managers cannot see managers-only documents.
      expect((await api(ctx, w.emp1.id).get(`/documents/${doc.id}/download-url`)).status).toBe(404);
      expect((await api(ctx, w.managerB.id).get(`/documents/${doc.id}`)).status).toBe(404);
      expect((await api(ctx, w.emp1.id).get(`/projects/${w.projectA.id}/documents?taskId=${t.id}`)).body.total).toBe(0);
      // No duplicates even if registration were retried.
      await expect(ctx.prisma.projectDocument.create({ data: { ...row, id: undefined } as never })).rejects.toThrow();
      const reg = await ctx.prisma.taskHistory.findFirstOrThrow({ where: { taskId: t.id, action: 'DOCUMENT_REGISTERED' } });
      expect((reg.metadata as { count: number }).count).toBe(1);
      // The approving manager is the actor, so no self-notification is queued.
      expect(await ctx.prisma.outboxEvent.count({ where: { aggregateId: t.id, type: 'DOCUMENT_REGISTERED' } })).toBe(0);
    });

    it('manual uploads: managers only, MIME/size validated, HeadObject-confirmed, searchable, archivable', async () => {
      const cats = (await api(ctx, w.emp1.id).get('/document-categories').expect(200)).body;
      const drawings = cats.find((c: { code: string }) => c.code === 'DRAWINGS');
      const body = { title: 'Ground floor plan', categoryId: drawings.id, fileName: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 4096, visibility: 'PROJECT_MEMBERS' };
      expect((await api(ctx, w.emp1.id).post(`/projects/${w.projectA.id}/documents/upload-url`, body)).status).toBe(403);
      expect((await api(ctx, w.managerB.id).post(`/projects/${w.projectA.id}/documents/upload-url`, body)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).post(`/projects/${w.projectA.id}/documents/upload-url`, { ...body, fileName: 'x.exe', contentType: 'application/x-msdownload' })).status).toBe(400);
      expect((await api(ctx, w.managerA.id).post(`/projects/${w.projectA.id}/documents/upload-url`, { ...body, sizeBytes: 500 * 1024 * 1024 })).status).toBe(400);
      const up = await api(ctx, w.managerA.id).post(`/projects/${w.projectA.id}/documents/upload-url`, body).expect(201);
      // Not listed until confirmed; confirm requires the object with the declared size.
      expect((await api(ctx, w.emp1.id).get(`/documents/${up.body.documentId}`)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).post(`/documents/${up.body.documentId}/confirm`)).status).toBe(400);
      const row = await ctx.prisma.projectDocument.findUniqueOrThrow({ where: { id: up.body.documentId } });
      ctx.storage.put(row.storageKey!, 4096, 'application/pdf');
      await api(ctx, w.managerA.id).post(`/documents/${row.id}/confirm`).expect(200);
      const search = await api(ctx, w.emp1.id).get(`/projects/${w.projectA.id}/documents?q=ground&categoryId=${drawings.id}`).expect(200);
      expect(search.body.items.map((d: { id: string }) => d.id)).toEqual([row.id]);
      expect((await api(ctx, w.emp1.id).get(`/documents/${row.id}/download-url`)).status).toBe(200);
      expect((await api(ctx, w.emp3.id).get(`/documents/${row.id}/download-url`)).status).toBe(404); // other project
      expect((await api(ctx, w.emp1.id).patch(`/documents/${row.id}`, { title: 'x' })).status).toBe(403);
      await api(ctx, w.managerA.id).patch(`/documents/${row.id}`, { visibility: 'MANAGERS_ONLY' }).expect(200);
      expect((await api(ctx, w.emp1.id).get(`/documents/${row.id}`)).status).toBe(404);
      await api(ctx, w.managerA.id).post(`/documents/${row.id}/archive`).expect(204);
      expect((await api(ctx, w.managerA.id).get(`/documents/${row.id}`)).status).toBe(404);
      expect((await ctx.prisma.auditLog.findMany({ where: { entityId: row.id } })).map((a) => a.action).sort()).toEqual(['DOCUMENT_ARCHIVED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED']);
    });
  });

  /* ============================== personal tasks ============================== */

  describe('personal tasks', () => {
    it('owner-only (admins included), encrypted at rest, excluded from tasks/dashboards/reports', async () => {
      const mine = await api(ctx, w.emp1.id).post('/me/personal-tasks', { title: 'Call the dentist', notes: 'Private note', priority: 'HIGH' }).expect(201);
      expect(mine.body).toMatchObject({ title: 'Call the dentist', notes: 'Private note', status: 'OPEN' });
      const row = await ctx.prisma.personalTask.findUniqueOrThrow({ where: { id: mine.body.id } });
      expect(row.titleEnc).not.toContain('dentist');
      expect(row.notesEnc).not.toContain('Private');
      for (const other of [w.emp2.id, w.managerA.id, w.admin.id]) {
        expect((await api(ctx, other).get(`/me/personal-tasks/${mine.body.id}`)).status).toBe(404);
        expect((await api(ctx, other).patch(`/me/personal-tasks/${mine.body.id}`, { title: 'hijack' })).status).toBe(404);
        expect((await api(ctx, other).delete(`/me/personal-tasks/${mine.body.id}`)).status).toBe(404);
        expect((await api(ctx, other).post(`/me/personal-tasks/${mine.body.id}/complete`)).status).toBe(404);
        expect(JSON.stringify((await api(ctx, other).get('/me/personal-tasks')).body)).not.toContain('dentist');
      }
      // Ciphertext moved to another owner does not decrypt (bound to the owner).
      const stolen = await ctx.prisma.personalTask.create({ data: { ownerId: w.emp2.id, titleEnc: row.titleEnc } });
      expect((await api(ctx, w.emp2.id).get(`/me/personal-tasks/${stolen.id}`)).status).toBe(500);
      await ctx.prisma.personalTask.delete({ where: { id: stolen.id } });

      const search = await api(ctx, w.emp1.id).get('/me/personal-tasks?q=DENTIST').expect(200);
      expect(search.body.items.map((t: { id: string }) => t.id)).toContain(mine.body.id);
      await api(ctx, w.emp1.id).post(`/me/personal-tasks/${mine.body.id}/complete`).expect(200);
      expect(JSON.stringify((await api(ctx, w.emp1.id).get('/tasks?pageSize=100')).body)).not.toContain('dentist');
      expect(JSON.stringify((await api(ctx, w.emp1.id).get('/dashboard')).body)).not.toContain('dentist');
      expect((await api(ctx, w.emp1.id).get(`/tasks/${mine.body.id}`)).status).toBe(404);
      await api(ctx, w.emp1.id).delete(`/me/personal-tasks/${mine.body.id}`).expect(204);
    });
  });

  /* ================================= reports ================================= */

  describe('reports', () => {
    it('task report: authorized dataset queued for the worker; ratings only for managers', async () => {
      const t = await createTask();
      await submitAndApprove(ctx, t.id, w.emp1.id);
      await api(ctx, w.managerA.id).put(`/tasks/${t.id}/rating`, { stars: 4, feedback: 'confidential remark' }).expect(200);

      const mgr = await api(ctx, w.managerA.id).post('/reports', { type: 'TASK', taskId: t.id }).expect(201);
      expect(mgr.body).toMatchObject({ status: 'QUEUED', includesRatings: true, type: 'TASK' });
      const job = await ctx.prisma.reportJob.findUniqueOrThrow({ where: { id: mgr.body.id } });
      expect(JSON.stringify(job.dataset)).toContain('confidential remark');
      expect(await ctx.prisma.outboxEvent.count({ where: { aggregateId: job.id, type: 'REPORT_RENDER' } })).toBe(1);

      const emp = await api(ctx, w.emp1.id).post('/reports', { type: 'TASK', taskId: t.id }).expect(201);
      expect(emp.body.includesRatings).toBe(false);
      const empJob = await ctx.prisma.reportJob.findUniqueOrThrow({ where: { id: emp.body.id } });
      expect(JSON.stringify(empJob.dataset)).not.toMatch(/confidential remark|"stars"|averageRating/);
      const ds = empJob.dataset as { tasks: Array<{ submissions: unknown[]; history: unknown[]; comments: unknown[] }> };
      expect(ds.tasks[0]!.submissions).toHaveLength(1);
      expect(ds.tasks[0]!.history!.length).toBeGreaterThan(0);

      // Reports are private to the requester; other users cannot read or download them.
      expect((await api(ctx, w.emp1.id).get(`/reports/${mgr.body.id}`)).status).toBe(404);
      expect((await api(ctx, w.admin.id).get(`/reports/${mgr.body.id}`)).status).toBe(404);
      expect((await api(ctx, w.managerA.id).get(`/reports/${mgr.body.id}/download-url`)).status).toBe(400); // not ready yet
      await ctx.prisma.reportJob.update({ where: { id: job.id }, data: { status: 'READY', storageKey: `reports/${w.company.id}/${job.id}.pdf` } });
      expect((await api(ctx, w.managerA.id).get(`/reports/${mgr.body.id}/download-url`)).status).toBe(200);
      // Not visible tasks → 404.
      expect((await api(ctx, w.emp2.id).post('/reports', { type: 'TASK', taskId: t.id })).status).toBe(404);
    });

    it('employee & projects reports are scoped to what the requester may see', async () => {
      const range = { from: new Date(Date.now() - 30 * 86400_000).toISOString(), to: inHours(1) };
      expect((await api(ctx, w.emp1.id).post('/reports', { type: 'EMPLOYEE', userId: w.emp2.id, ...range })).status).toBe(404);
      const self = await api(ctx, w.emp1.id).post('/reports', { type: 'EMPLOYEE', userId: w.emp1.id, ...range }).expect(201);
      expect(self.body.includesRatings).toBe(false);
      expect((await api(ctx, w.emp1.id).post('/reports', { type: 'PROJECTS', projectIds: [w.projectA.id], ...range })).status).toBe(403);
      expect((await api(ctx, w.managerA.id).post('/reports', { type: 'PROJECTS', projectIds: [w.projectB.id], ...range })).status).toBe(404);
      expect((await api(ctx, w.managerA.id).post('/reports', { type: 'EMPLOYEE', userId: w.emp3.id, projectIds: [w.projectB.id], ...range })).status).toBe(404);
      const proj = await api(ctx, w.managerA.id).post('/reports', { type: 'PROJECTS', projectIds: [w.projectA.id], status: ['COMPLETED'], ...range }).expect(201);
      const ds = (await ctx.prisma.reportJob.findUniqueOrThrow({ where: { id: proj.body.id } })).dataset as { tasks: Array<{ status: string; project: string }>; summary: { total: number } };
      expect(ds.tasks.length).toBeGreaterThan(0);
      expect(ds.tasks.every((t) => t.status === 'COMPLETED' && t.project === 'Project A')).toBe(true);
      expect((await api(ctx, w.managerA.id).post('/reports', { type: 'PROJECTS', projectIds: [w.projectA.id], from: range.to, to: range.from })).status).toBe(400);
      const mine = await api(ctx, w.managerA.id).get('/me/reports').expect(200);
      expect(mine.body.map((r: { id: string }) => r.id)).toContain(proj.body.id);
    });

    it('rate-limits report generation per user', async () => {
      const t = await createTask();
      const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: w.managerB.id } });
      await ctx.prisma.reportJob.createMany({
        data: Array.from({ length: 20 }, () => ({ companyId: w.company.id, requestedById: u.id, type: 'TASK' as const, params: {}, expiresAt: new Date(Date.now() + 86400_000) })),
      });
      const tB = await createTask({ managerId: w.managerB.id, projectId: w.projectB.id, assigneeId: w.emp3.id });
      expect((await api(ctx, w.managerB.id).post('/reports', { type: 'TASK', taskId: tB.id })).status).toBe(429);
      expect(t.id).toBeTruthy();
    });
  });

  /* =========================== admin provisioning =========================== */

  describe('admin user provisioning', () => {
    it('only admins create accounts; temporary password shown once, hashed, change forced; audited without secrets', async () => {
      const email = `new-${Date.now()}@t.local`;
      const body = { email, name: 'New Hire', role: 'EMPLOYEE', departments: [{ departmentId: w.dept.id, isPrimary: true }], projects: [{ projectId: w.projectA.id, role: 'EMPLOYEE' }] };
      expect((await api(ctx, w.managerA.id).post('/users', body)).status).toBe(403);
      expect((await api(ctx, w.emp1.id).post('/users', { ...body, role: 'ADMIN' })).status).toBe(403);
      expect((await api(ctx, w.admin.id).post('/users', { ...body, departments: [] })).status).toBe(400); // employees need a department
      expect((await api(ctx, w.admin.id).post('/users', { ...body, passwordDelivery: 'EMAIL' })).status).toBe(400); // local mode: no e-mail delivery

      const created = await api(ctx, w.admin.id).post('/users', body).expect(201);
      const temp = created.body.temporaryPassword as string;
      expect(temp).toMatch(/^[A-Za-z2-9]{16}$/);
      expect(created.body).toMatchObject({ mustChangePassword: true, departments: [expect.objectContaining({ id: w.dept.id, isPrimary: true })] });
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(row.createdById).toBe(w.admin.id);
      // Never again in any normal response.
      expect(JSON.stringify((await api(ctx, w.admin.id).get(`/users/${row.id}`)).body)).not.toContain(temp);
      expect(JSON.stringify((await api(ctx, w.admin.id).get('/users')).body)).not.toContain(temp);
      const audit = (await api(ctx, w.admin.id).get(`/users/${row.id}/audit`).expect(200)).body;
      expect(audit[0].action).toBe('USER_CREATED');
      expect(JSON.stringify(audit)).not.toContain(temp);
      expect(JSON.stringify(await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: row.id } }))).not.toContain(temp);
      expect((await api(ctx, w.admin.id).post('/users', body)).status).toBe(409);

      // First login → forced change; tokens are only issued after the change.
      const login = await api(ctx).post('/auth/login', { email, password: temp }).expect(200);
      expect(login.body.status).toBe('NEW_PASSWORD_REQUIRED');
      // Even with a token (e.g. issued before a reset) the API refuses work until the password changes.
      const blocked = await api(ctx, row.id).get('/tasks');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await api(ctx, row.id).get('/auth/me')).body.mustChangePassword).toBe(true);
      await api(ctx).post('/auth/new-password', { email, session: 'forged', newPassword: 'Another123' }).expect(401);
      const done = await api(ctx).post('/auth/new-password', { email, session: login.body.session, newPassword: 'Another123' }).expect(200);
      expect(done.body.user.mustChangePassword).toBe(false);
      expect(done.body.user.departments[0].id).toBe(w.dept.id);
      await api(ctx, row.id).get('/tasks').expect(200);
      // Session tokens are single-purpose: the challenge cannot be replayed.
      expect((await api(ctx).post('/auth/new-password', { email, session: login.body.session, newPassword: 'Third1234' })).status).toBe(401);
      // Change password (authenticated).
      expect((await api(ctx, row.id).post('/auth/change-password', { currentPassword: 'wrong', newPassword: 'Fourth1234' })).status).toBe(400);
      await api(ctx, row.id).post('/auth/change-password', { currentPassword: 'Another123', newPassword: 'Fourth1234' }).expect(204);
      expect((await api(ctx).post('/auth/login', { email, password: 'Fourth1234' })).body.status).toBe('OK');

      // Deactivation: immediate loss of access, audited.
      await api(ctx, w.admin.id).patch(`/users/${row.id}`, { isActive: false }).expect(200);
      expect((await api(ctx, row.id).get('/auth/me')).status).toBe(401);
      expect((await api(ctx).post('/auth/login', { email, password: 'Fourth1234' })).status).toBe(401);
      expect((await api(ctx, w.admin.id).get(`/users/${row.id}/audit`)).body.map((a: { action: string }) => a.action)).toEqual(
        expect.arrayContaining(['USER_CREATED', 'PASSWORD_CHANGED', 'USER_DEACTIVATED']),
      );
    });

    it('cross-company and unknown references are rejected', async () => {
      const other = await ctx.prisma.company.create({ data: { name: `Other ${Date.now()}` } });
      const foreignDept = await ctx.prisma.department.create({ data: { companyId: other.id, code: 'X_DEPT', nameAr: 'س', nameEn: 'X' } });
      const r = await api(ctx, w.admin.id).post('/users', { email: `x-${Date.now()}@t.local`, name: 'X', role: 'EMPLOYEE', departments: [{ departmentId: foreignDept.id, isPrimary: true }] });
      expect(r.status).toBe(400);
      const foreignUser = await ctx.prisma.user.create({ data: { companyId: other.id, email: `fu-${Date.now()}@t.local`, name: 'FU', role: 'EMPLOYEE' } });
      expect((await api(ctx, w.admin.id).get(`/users/${foreignUser.id}`)).status).toBe(404);
      expect((await api(ctx, w.admin.id).put(`/users/${foreignUser.id}/departments`, { departments: [{ departmentId: w.dept.id, isPrimary: true }] })).status).toBe(404);
    });
  });

  /* ======================== task visibility by role ======================== */

  describe('task visibility: creator/approver + assignee only', () => {
    let managerA2: { id: string };
    beforeAll(async () => {
      // A second manager of the same project.
      managerA2 = await ctx.prisma.user.create({ data: { companyId: w.company.id, email: `mgrA2-${Date.now()}@t.local`, name: 'Manager A2', role: 'PROJECT_MANAGER' } });
      await ctx.prisma.projectMembership.create({ data: { projectId: w.projectA.id, userId: managerA2.id, role: 'MANAGER' } });
      // The admin is added to project A as an employee (and to a department) so managers can assign him tasks.
      await ctx.prisma.projectMembership.create({ data: { projectId: w.projectA.id, userId: w.admin.id, role: 'EMPLOYEE' } });
      await joinDepartment(ctx.prisma, w.dept.id, w.admin.id);
    });

    it("managers of the same project do not see each other's tasks, ratings, deliverables or report rows", async () => {
      const mine = await createTask();
      const theirs = await createTask({ managerId: managerA2.id });
      expect((await api(ctx, w.managerA.id).get(`/tasks/${theirs.id}`)).status).toBe(404);
      expect((await api(ctx, managerA2.id).get(`/tasks/${mine.id}`)).status).toBe(404);
      expect((await api(ctx, managerA2.id).get(`/tasks/${theirs.id}`)).status).toBe(200);
      const listA = (await api(ctx, w.managerA.id).get(`/tasks?projectId=${w.projectA.id}&pageSize=100`)).body.items.map((i: { id: string }) => i.id);
      expect(listA).toContain(mine.id);
      expect(listA).not.toContain(theirs.id);
      // Actions on the other manager's task are refused the same way.
      expect((await api(ctx, w.managerA.id).patch(`/tasks/${theirs.id}`, { title: 'hijack' })).status).toBe(404);

      // Approved + rated by A2: invisible to A in performance, documents and reports.
      const up = await api(ctx, w.emp1.id).post(`/tasks/${theirs.id}/attachments/upload-url`, { fileName: 'a2.pdf', contentType: 'application/pdf', sizeBytes: 64 }).expect(201);
      const att = await ctx.prisma.taskAttachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
      ctx.storage.put(att.storageKey, 64, 'application/pdf');
      await api(ctx, w.emp1.id).post(`/attachments/${att.id}/confirm`).expect(200);
      await submitAndApprove(ctx, theirs.id, w.emp1.id, 'done', [att.id]);
      await api(ctx, managerA2.id).put(`/tasks/${theirs.id}/rating`, { stars: 2, feedback: 'A2 private feedback' }).expect(200);
      expect((await api(ctx, w.managerA.id).put(`/tasks/${theirs.id}/rating`, { stars: 5 })).status).toBe(404);
      const perfA = (await api(ctx, w.managerA.id).get(`/performance/employees/${w.emp1.id}`)).body;
      expect(JSON.stringify(perfA)).not.toContain('A2 private feedback');
      const perfA2 = (await api(ctx, managerA2.id).get(`/performance/employees/${w.emp1.id}`)).body;
      expect(perfA2.ratings.map((r: { taskId: string }) => r.taskId)).toEqual([theirs.id]);
      const docsA = (await api(ctx, w.managerA.id).get(`/projects/${w.projectA.id}/documents?taskId=${theirs.id}`)).body;
      expect(docsA.total).toBe(0);
      expect((await api(ctx, managerA2.id).get(`/projects/${w.projectA.id}/documents?taskId=${theirs.id}`)).body.total).toBe(1);
      const range = { from: new Date(Date.now() - 86400_000).toISOString(), to: inHours(1) };
      const rep = await api(ctx, w.managerA.id).post('/reports', { type: 'PROJECTS', projectIds: [w.projectA.id], ...range }).expect(201);
      const ds = (await ctx.prisma.reportJob.findUniqueOrThrow({ where: { id: rep.body.id } })).dataset as { tasks: Array<{ id: string }> };
      expect(ds.tasks.map((x) => x.id)).not.toContain(theirs.id);
      expect(JSON.stringify(ds)).not.toContain('A2 private feedback');
      // Notifications about deliverables go to the task's own managers only.
      const reg = await ctx.prisma.outboxEvent.findMany({ where: { aggregateId: theirs.id, type: 'DOCUMENT_REGISTERED' } });
      for (const r of reg) expect((r.payload as { recipients: string[] }).recipients).not.toContain(w.managerA.id);
      // Dashboards and project counters only count managed tasks.
      const dashA2 = (await api(ctx, managerA2.id).get('/dashboard')).body;
      expect(dashA2.totals.completedTasks).toBe(1);
      const projA2 = (await api(ctx, managerA2.id).get(`/projects/${w.projectA.id}`)).body;
      expect(projA2.openTaskCount).toBe(0);
    });

    it('the admin sees only tasks he created or that a manager assigned to him — and never his own rating', async () => {
      // A manager can pick the admin (project employee + department) as the responsible person.
      const eligible = (await api(ctx, w.managerA.id).get(`/departments/${w.dept.id}/assignable-employees?projectId=${w.projectA.id}`)).body.map((u: { id: string }) => u.id);
      expect(eligible).toContain(w.admin.id);
      const forAdmin = await createTask({ assigneeId: w.admin.id });
      const byAdmin = await createTask({ managerId: w.admin.id });
      const other = await createTask();
      const otherB = await createTask({ managerId: w.managerB.id, projectId: w.projectB.id, assigneeId: w.emp3.id });

      const list = (await api(ctx, w.admin.id).get('/tasks?pageSize=100')).body.items as Array<{ id: string; createdBy: { id: string }; approver: { id: string }; assignee: { id: string } }>;
      const ids = list.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([forAdmin.id, byAdmin.id]));
      expect(ids).not.toContain(other.id);
      expect(ids).not.toContain(otherB.id);
      expect(list.every((i) => i.createdBy.id === w.admin.id || i.approver.id === w.admin.id || i.assignee.id === w.admin.id)).toBe(true);
      expect((await api(ctx, w.admin.id).get(`/tasks/${other.id}`)).status).toBe(404);
      expect((await api(ctx, w.admin.id).get(`/tasks/${otherB.id}`)).status).toBe(404);

      // He works on his assigned task like an employee; the manager approves and rates it.
      const d = (await api(ctx, w.admin.id).get(`/tasks/${forAdmin.id}`)).body;
      expect(d.permissions).toMatchObject({ canSubmit: true, canEdit: false, canApprove: false, canRate: false, canTransfer: true });
      await submitAndApprove(ctx, forAdmin.id, w.admin.id);
      await api(ctx, w.managerA.id).put(`/tasks/${forAdmin.id}/rating`, { stars: 3, feedback: 'admin task feedback' }).expect(200);
      const seen = (await api(ctx, w.admin.id).get(`/tasks/${forAdmin.id}`)).body;
      expect(seen.rating).toBeUndefined();
      expect(JSON.stringify((await api(ctx, w.admin.id).get('/tasks?view=completed&pageSize=100')).body)).not.toContain('admin task feedback');
      expect((await api(ctx, w.admin.id).get(`/tasks/${forAdmin.id}/rating`)).status).toBe(403);
      expect((await api(ctx, w.admin.id).get(`/performance/employees/${w.admin.id}`)).status).toBe(404);
      expect((await api(ctx, w.admin.id).get('/performance/employees')).body.map((p: { employee: { id: string } }) => p.employee.id)).not.toContain(w.admin.id);
      const rep = await api(ctx, w.admin.id).post('/reports', { type: 'TASK', taskId: forAdmin.id }).expect(201);
      expect(rep.body.includesRatings).toBe(false);

      // Nobody can be the responsible person of a task they create or approve.
      const self = await api(ctx, w.admin.id).post('/tasks', { projectId: w.projectA.id, departmentId: w.dept.id, assigneeId: w.admin.id, title: 'self', deadline: inHours(5) });
      expect(self.status).toBe(400);
      expect(self.body.code).toBe('ASSIGNEE_NOT_ELIGIBLE');

      // Account administration stays company-wide.
      expect((await api(ctx, w.admin.id).get('/users')).status).toBe(200);
      expect((await api(ctx, w.admin.id).get('/projects')).body.length).toBeGreaterThanOrEqual(2);
    });
  });

  /* ========================== frontend read models ========================== */

  describe('frontend read models', () => {
    it('review inbox lists only submissions addressed to me, with task context and no rating data', async () => {
      const t = await createTask();
      const s = (await submit(t.id, w.emp1.id, 'ready for review')).body;
      const mine = (await api(ctx, w.managerA.id).get('/me/reviews').expect(200)).body as Array<{ submission: { id: string }; task: { id: string; time: { paused: boolean }; rating?: unknown } }>;
      const row = mine.find((r) => r.submission.id === s.id)!;
      expect(row.task.id).toBe(t.id);
      expect(row.task.time.paused).toBe(true);
      expect(row.task).not.toHaveProperty('rating');
      expect((await api(ctx, w.managerB.id).get('/me/reviews').expect(200)).body.map((r: { submission: { id: string } }) => r.submission.id)).not.toContain(s.id);
      expect((await api(ctx, w.emp1.id).get('/me/reviews').expect(200)).body).toEqual([]);
      // The admin has no company-wide inbox: only submissions addressed to him.
      expect((await api(ctx, w.admin.id).get('/me/reviews')).body.map((r: { submission: { id: string } }) => r.submission.id)).not.toContain(s.id);
      expect((await api(ctx, w.admin.id).get('/me/reviews?all=true')).body.map((r: { submission: { id: string } }) => r.submission.id)).not.toContain(s.id);
    });

    it('"rejected" view and dashboard counters reflect sent-back work; time ledger reports per-kind totals and provisional state', async () => {
      const t = await createTask();
      await startCycleAgo(t.id, 3, 24);
      const s = (await submit(t.id, w.emp1.id)).body;
      await ageOpenSegment(t.id, 2);
      let [c] = (await api(ctx, w.emp1.id).get(`/tasks/${t.id}/time`)).body.cycles;
      expect(c.provisional).toBe(true);
      near(c.totals.pendingReviewMs, 2);
      near(c.totals.activeWorkMs, 3);
      const before = (await api(ctx, w.emp1.id).get('/dashboard')).body.totals;
      await api(ctx, w.managerA.id).post(`/submissions/${s.id}/reject`, { reason: 'redo' }).expect(200);
      [c] = (await api(ctx, w.emp1.id).get(`/tasks/${t.id}/time`)).body.cycles;
      expect(c.provisional).toBe(false);
      near(c.totals.rejectedReviewMs, 2);
      expect(c.totals.pendingReviewMs).toBe(0);
      expect(c.totals.completionMs).toBeNull();
      const rejected = (await api(ctx, w.emp1.id).get('/tasks?view=rejected&pageSize=100')).body.items.map((i: { id: string }) => i.id);
      expect(rejected).toContain(t.id);
      expect((await api(ctx, w.emp2.id).get('/tasks?view=rejected&pageSize=100')).body.items.map((i: { id: string }) => i.id)).not.toContain(t.id);
      const after = (await api(ctx, w.emp1.id).get('/dashboard')).body.totals;
      expect(after.rejectedSubmissions).toBe(before.rejectedSubmissions + 1);
      expect(after).not.toHaveProperty('employees');
      // Resubmitting clears it from the "sent back" view.
      await submit(t.id, w.emp1.id);
      expect((await api(ctx, w.emp1.id).get('/tasks?view=rejected&pageSize=100')).body.items.map((i: { id: string }) => i.id)).not.toContain(t.id);
    });

    it('dashboards: admin totals, manager workload and to-review count, no rating data for employees', async () => {
      const admin = (await api(ctx, w.admin.id).get('/dashboard').expect(200)).body;
      expect(admin.totals.employees).toBeGreaterThanOrEqual(3);
      expect(admin.totals.departments).toBeGreaterThanOrEqual(7);
      const mgr = (await api(ctx, w.managerA.id).get('/dashboard').expect(200)).body;
      expect(mgr.totals).toHaveProperty('toReview');
      expect(mgr.totals).not.toHaveProperty('employees');
      expect(Array.isArray(mgr.workload)).toBe(true);
      expect(mgr.workload.map((x: { employee: { id: string } }) => x.employee.id)).not.toContain(w.emp3.id); // project B only
      expect(JSON.stringify(mgr.workload)).not.toMatch(/stars|feedback|averageRating/);
      const emp = (await api(ctx, w.emp1.id).get('/dashboard').expect(200)).body;
      expect(emp.workload).toBeUndefined();
      expect(emp.totals).toHaveProperty('incomingTransfers');
    });

    it('incoming transfers carry the task title; employee profile lists departments', async () => {
      const t = await createTask();
      const tr = (await api(ctx, w.emp1.id).post(`/tasks/${t.id}/transfers`, { toUserId: w.emp2.id, reason: 'help' })).body;
      const incoming = (await api(ctx, w.emp2.id).get('/me/transfers')).body.find((x: { id: string }) => x.id === tr.id);
      expect(incoming.task).toMatchObject({ id: t.id, projectName: 'Project A' });
      await api(ctx, w.emp1.id).post(`/transfers/${tr.id}/cancel`, {}).expect(200);
      const prof = (await api(ctx, w.managerA.id).get(`/performance/employees/${w.emp2.id}`).expect(200)).body;
      expect(prof.departments.map((d: { id: string }) => d.id).sort()).toEqual([w.dept.id, w.dept2.id].sort());
    });

    it('attachment preview URLs are inline only for images/PDF, still access-checked', async () => {
      const t = await createTask();
      const att = async (fileName: string, contentType: string) => {
        const up = await api(ctx, w.emp1.id).post(`/tasks/${t.id}/attachments/upload-url`, { fileName, contentType, sizeBytes: 32 }).expect(201);
        const row = await ctx.prisma.taskAttachment.findUniqueOrThrow({ where: { id: up.body.attachmentId } });
        ctx.storage.put(row.storageKey, 32, contentType);
        await api(ctx, w.emp1.id).post(`/attachments/${row.id}/confirm`).expect(200);
        return row.id;
      };
      const png = await att('site.png', 'image/png');
      const txt = await att('notes.txt', 'text/plain');
      const p = (await api(ctx, w.managerA.id).get(`/attachments/${png}/download-url?preview=true`).expect(200)).body;
      expect(p).toMatchObject({ inline: true });
      expect(p.url).toContain('inline=1');
      const q = (await api(ctx, w.managerA.id).get(`/attachments/${txt}/download-url?preview=true`).expect(200)).body;
      expect(q.inline).toBe(false); // text/HTML-like content is never rendered inline
      expect(q.url).not.toContain('inline=1');
      expect((await api(ctx, w.managerA.id).get(`/attachments/${png}/download-url`)).body.inline).toBe(false);
      expect((await api(ctx, w.emp2.id).get(`/attachments/${png}/download-url?preview=true`)).status).toBe(404);
      expect((await api(ctx, w.managerB.id).get(`/attachments/${png}/download-url?preview=true`)).status).toBe(404);
    });

    it('document preview URLs are inline only for images/PDF; other types always download', async () => {
      const cats = (await api(ctx, w.managerA.id).get('/document-categories')).body;
      const mk = async (fileName: string, contentType: string) => {
        const up = await api(ctx, w.managerA.id)
          .post(`/projects/${w.projectA.id}/documents/upload-url`, { title: fileName, categoryId: cats[0].id, fileName, contentType, sizeBytes: 64 })
          .expect(201);
        const row = await ctx.prisma.projectDocument.findUniqueOrThrow({ where: { id: up.body.documentId } });
        ctx.storage.put(row.storageKey!, 64, contentType);
        await api(ctx, w.managerA.id).post(`/documents/${row.id}/confirm`).expect(200);
        return row.id;
      };
      const pdf = await mk('a.pdf', 'application/pdf');
      const docx = await mk('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const p1 = (await api(ctx, w.managerA.id).get(`/documents/${pdf}/download-url?preview=true`)).body;
      expect(p1.inline).toBe(true);
      expect(p1.url).toContain('inline=1');
      const p2 = (await api(ctx, w.managerA.id).get(`/documents/${docx}/download-url?preview=true`)).body;
      expect(p2.inline).toBe(false);
      expect(p2.url).not.toContain('inline=1');
      expect((await api(ctx, w.managerA.id).get(`/documents/${pdf}/download-url`)).body.inline).toBe(false);
    });
  });

  it('consistent error shape with machine-readable codes', async () => {
    const r = await api(ctx, w.emp1.id).get('/tasks/00000000-0000-4000-8000-000000000000');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: expect.any(String) });
    const v = await api(ctx, w.managerA.id).post('/tasks', {});
    expect(v.status).toBe(400);
    expect(v.body.code).toBe('VALIDATION_FAILED');
  });
});
