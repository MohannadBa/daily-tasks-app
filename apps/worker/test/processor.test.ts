import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxEventType, PrismaClient, type QueueMessage } from '@dailytasks/database';
import { Notifier } from '../src/notifier';
import { OutboxRelay } from '../src/outbox-relay';
import { EventProcessor } from '../src/processor';
import { RecordingPushTransport } from '../src/push';
import { MemoryQueue } from '../src/queue';
import { computeDeadlineJobs, deadlineMessage, LocalDbScheduler } from '../src/scheduler';

const prisma = new PrismaClient();
let push: RecordingPushTransport;
let queue: MemoryQueue;
let scheduler: LocalDbScheduler;
let processor: EventProcessor;

let n = 0;
const u = () => `${Date.now()}-${n++}`;

async function world() {
  const company = await prisma.company.create({ data: { name: 'W', reminderOffsetsMinutes: [1440, 60] } });
  const mk = (name: string, role: 'PROJECT_MANAGER' | 'EMPLOYEE' | 'COMPANY_ADMIN') =>
    prisma.user.create({ data: { companyId: company.id, email: `${name}-${u()}@t.local`, name, role, locale: 'en' } });
  const manager = await mk('Manager', 'PROJECT_MANAGER');
  const manager2 = await mk('Manager2', 'PROJECT_MANAGER');
  const emp = await mk('Emp', 'EMPLOYEE');
  const emp2 = await mk('Emp2', 'EMPLOYEE');
  const project = await prisma.project.create({ data: { companyId: company.id, name: 'P' } });
  await prisma.projectMembership.createMany({
    data: [
      { projectId: project.id, userId: manager.id, role: 'MANAGER' },
      { projectId: project.id, userId: manager2.id, role: 'MANAGER' },
      { projectId: project.id, userId: emp.id, role: 'EMPLOYEE' },
      { projectId: project.id, userId: emp2.id, role: 'EMPLOYEE' },
    ],
  });
  const sub = (userId: string, platform: 'IOS' | 'ANDROID') =>
    prisma.pushSubscription.create({ data: { userId, endpoint: `https://fcm.googleapis.com/fcm/send/${u()}`, p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22), platform } });
  await sub(emp.id, 'IOS');
  await sub(emp.id, 'ANDROID');
  await sub(manager.id, 'IOS');
  const task = await prisma.task.create({
    data: { projectId: project.id, assigneeId: emp.id, createdById: manager.id, title: 'Fix door', deadline: new Date(Date.now() + 48 * 3600_000), scheduleVersion: 1 },
  });
  return { company, manager, manager2, emp, emp2, project, task };
}

const msg = (type: OutboxEventType, payload: object, dedupeKey: string): QueueMessage => ({
  id: u(),
  type,
  dedupeKey,
  occurredAt: new Date().toISOString(),
  payload,
});

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(() => {
  push = new RecordingPushTransport();
  queue = new MemoryQueue();
  scheduler = new LocalDbScheduler(prisma, queue);
  processor = new EventProcessor(prisma, new Notifier(prisma, push), scheduler);
});

describe('notification fan-out', () => {
  it('TASK_ASSIGNED notifies the assignee on every device', async () => {
    const w = await world();
    await processor.handle(msg(OutboxEventType.TASK_ASSIGNED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id }, `TASK_ASSIGNED:${w.task.id}`));
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(w.emp.id);
    expect(rows[0]!.pushedAt).not.toBeNull();
    expect(push.sent).toHaveLength(2);
    expect(push.sent[0]!.payload.url).toBe(`/tasks/${w.task.id}`);
  });

  it('11. duplicate events do not create duplicate notifications or pushes', async () => {
    const w = await world();
    const m = msg(OutboxEventType.TASK_ASSIGNED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id }, `TASK_ASSIGNED:${w.task.id}`);
    await processor.handle(m);
    await processor.handle(m);
    await processor.handle({ ...m, id: 'redelivered' });
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(1);
    expect(push.sent).toHaveLength(2);
  });

  it('TASK_COMPLETED notifies all managers once each and never the actor', async () => {
    const w = await world();
    // manager2 also an... extra duplicate membership path: recipients set dedupes.
    await processor.handle(msg(OutboxEventType.TASK_COMPLETED, { taskId: w.task.id, projectId: w.project.id, actorId: w.emp.id }, `TASK_COMPLETED:${w.task.id}:0`));
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id } });
    expect(rows.map((r) => r.userId).sort()).toEqual([w.manager.id, w.manager2.id].sort());
    expect(rows.every((r) => r.type === 'TASK_COMPLETED')).toBe(true);
  });

  it('employee comment notifies managers; manager comment notifies the assignee', async () => {
    const w = await world();
    await processor.handle(msg(OutboxEventType.TASK_COMMENT_ADDED, { taskId: w.task.id, projectId: w.project.id, actorId: w.emp.id, details: { byAssignee: true } }, 'C1'));
    await processor.handle(msg(OutboxEventType.TASK_COMMENT_ADDED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id, details: { byAssignee: false } }, 'C2'));
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id }, orderBy: { dedupeKey: 'asc' } });
    expect(rows.filter((r) => r.dedupeKey === 'C1').map((r) => r.userId).sort()).toEqual([w.manager.id, w.manager2.id].sort());
    expect(rows.filter((r) => r.dedupeKey === 'C2').map((r) => r.userId)).toEqual([w.emp.id]);
  });

  it('reassignment notifies new and previous assignee with different messages', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.task.id }, data: { assigneeId: w.emp2.id } });
    await processor.handle(
      msg(OutboxEventType.TASK_REASSIGNED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id, details: { previousAssigneeId: w.emp.id, newAssigneeId: w.emp2.id } }, 'R1'),
    );
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id } });
    const forOld = rows.find((r) => r.userId === w.emp.id)!;
    const forNew = rows.find((r) => r.userId === w.emp2.id)!;
    expect(forOld.title).not.toBe(forNew.title);
  });

  it('localizes notifications using the recipient locale', async () => {
    const w = await world();
    await prisma.user.update({ where: { id: w.emp.id }, data: { locale: 'ar' } });
    await processor.handle(msg(OutboxEventType.TASK_ASSIGNED, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id }, 'A-ar'));
    const row = await prisma.notification.findFirstOrThrow({ where: { taskId: w.task.id } });
    expect(row.title).toBe('مهمة جديدة');
  });
});

describe('deadline scheduling', () => {
  it('computes reminders 24h and 1h before, plus overdue at the deadline; skips past reminders', () => {
    const deadline = new Date('2030-01-02T12:00:00Z');
    const jobs = computeDeadlineJobs({ id: 't', deadline, scheduleVersion: 3 }, [1440, 60], new Date('2030-01-01T00:00:00Z'));
    expect(jobs.map((j) => [j.payload.kind, j.payload.offsetMinutes, j.runAt.toISOString()])).toEqual([
      ['REMINDER', 1440, '2030-01-01T12:00:00.000Z'],
      ['REMINDER', 60, '2030-01-02T11:00:00.000Z'],
      ['OVERDUE', 0, '2030-01-02T12:00:00.000Z'],
    ]);
    const late = computeDeadlineJobs({ id: 't', deadline, scheduleVersion: 3 }, [1440, 60], new Date('2030-01-02T11:30:00Z'));
    expect(late.map((j) => j.payload.kind)).toEqual(['OVERDUE']);
  });

  it('12. deadline changes invalidate old schedules', async () => {
    const w = await world();
    await processor.handle(msg(OutboxEventType.TASK_SCHEDULE_SYNC, { taskId: w.task.id, scheduleVersion: 1 }, 'S1'));
    expect(await prisma.scheduledEvent.count({ where: { name: { startsWith: `t-${w.task.id}-v1-` } } })).toBe(3);

    // Deadline moved: version 2
    await prisma.task.update({ where: { id: w.task.id }, data: { deadline: new Date(Date.now() + 72 * 3600_000), scheduleVersion: 2 } });
    await processor.handle(msg(OutboxEventType.TASK_SCHEDULE_SYNC, { taskId: w.task.id, scheduleVersion: 2 }, 'S2'));
    expect(await prisma.scheduledEvent.count({ where: { name: { startsWith: `t-${w.task.id}-v1-` } } })).toBe(0);
    expect(await prisma.scheduledEvent.count({ where: { name: { startsWith: `t-${w.task.id}-v2-` } } })).toBe(3);

    // A late-arriving sync for the old version is ignored
    await processor.handle(msg(OutboxEventType.TASK_SCHEDULE_SYNC, { taskId: w.task.id, scheduleVersion: 1 }, 'S1-late'));
    expect(await prisma.scheduledEvent.count({ where: { name: { startsWith: `t-${w.task.id}-v1-` } } })).toBe(0);

    // An old-version deadline event that already fired (e.g. from EventBridge) is ignored
    await prisma.task.update({ where: { id: w.task.id }, data: { deadline: new Date(Date.now() - 1000) } });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 }));
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(0);
  });

  it('13. completed tasks are never marked overdue, even if the event is processed late', async () => {
    const w = await world();
    const deadline = new Date(Date.now() - 60_000); // deadline already passed when the event is processed
    await prisma.task.update({
      where: { id: w.task.id },
      data: { deadline, status: 'COMPLETED', completedAt: new Date(deadline.getTime() - 3600_000), completedLate: false },
    });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 }));
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(0);
    const t = await prisma.task.findUniqueOrThrow({ where: { id: w.task.id } });
    expect(t.completedLate).toBe(false);
  });

  it('open overdue tasks notify assignee and managers exactly once', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.task.id }, data: { deadline: new Date(Date.now() - 1000) } });
    const m = deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 });
    await processor.handle(m);
    await processor.handle(m);
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id } });
    expect(rows.map((r) => r.userId).sort()).toEqual([w.emp.id, w.manager.id, w.manager2.id].sort());
    expect(rows.every((r) => r.type === 'TASK_OVERDUE')).toBe(true);
  });

  it('reminder goes to the assignee with the offset in the text', async () => {
    const w = await world();
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'REMINDER', offsetMinutes: 60 }));
    const row = await prisma.notification.findFirstOrThrow({ where: { taskId: w.task.id } });
    expect(row.type).toBe('TASK_DEADLINE_APPROACHING');
    expect(row.body).toContain('1 hour');
  });

  it('local scheduler fires due events onto the queue exactly once', async () => {
    const w = await world();
    await scheduler.replace(w.task.id, [{ runAt: new Date(Date.now() - 1000), payload: { taskId: w.task.id, scheduleVersion: 1, kind: 'REMINDER', offsetMinutes: 60 } }]);
    expect(await scheduler.fireDue()).toBeGreaterThanOrEqual(1);
    const fired = queue.messages.filter((m) => (m.payload as { taskId: string }).taskId === w.task.id);
    expect(fired).toHaveLength(1);
    await scheduler.fireDue();
    expect(queue.messages.filter((m) => (m.payload as { taskId: string }).taskId === w.task.id)).toHaveLength(1);
  });
});

describe('outbox relay', () => {
  it('publishes pending events once and retries failures with backoff', async () => {
    const w = await world();
    await prisma.outboxEvent.create({ data: { type: 'TASK_ASSIGNED', aggregateId: w.task.id, payload: { taskId: w.task.id }, dedupeKey: `ob-${u()}` } });
    const relay = new OutboxRelay(prisma, queue);
    await relay.relayBatch();
    expect(queue.messages.some((m) => (m.payload as { taskId: string }).taskId === w.task.id)).toBe(true);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: w.task.id, status: 'PENDING' } })).toBe(0);

    const failing = new OutboxRelay(prisma, { send: async () => { throw new Error('sqs down'); }, receive: async () => [], ack: async () => {} });
    const ev = await prisma.outboxEvent.create({ data: { type: 'TASK_UPDATED', aggregateId: w.task.id, payload: {}, dedupeKey: `ob-${u()}` } });
    await failing.relayBatch();
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after.status).toBe('PENDING');
    expect(after.attempts).toBe(1);
    expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastError).toContain('sqs down');
  });
});
