import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@dailytasks/database';
import { cleanupAbandonedUploads, type ObjectStore } from '../src/attachments';
import { publishRealtime } from '../src/notifier';

const prisma = new PrismaClient();
beforeAll(() => prisma.$connect());
afterAll(() => prisma.$disconnect());

describe('abandoned upload cleanup (retention)', () => {
  it('deletes PENDING uploads older than 24 h (S3 object + row), keeps fresh and confirmed ones', async () => {
    const company = await prisma.company.create({ data: { name: 'Retention' } });
    const user = await prisma.user.create({ data: { companyId: company.id, email: `r-${Date.now()}@t.local`, name: 'U', role: 'PROJECT_MANAGER' } });
    const project = await prisma.project.create({ data: { companyId: company.id, name: 'P' } });
    const task = await prisma.task.create({ data: { projectId: project.id, assigneeId: user.id, createdById: user.id, title: 'T', deadline: new Date(Date.now() + 86400_000) } });
    const mk = (status: 'PENDING' | 'UPLOADED', ageHours: number) =>
      prisma.taskAttachment.create({
        data: {
          taskId: task.id, uploadedById: user.id, fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, status,
          storageKey: `t/${task.id}/${Math.random()}`, createdAt: new Date(Date.now() - ageHours * 3600_000),
        },
      });
    const stale = await mk('PENDING', 30);
    const fresh = await mk('PENDING', 2);
    const confirmed = await mk('UPLOADED', 100);
    const deleted: string[] = [];
    const store: ObjectStore = { delete: async (k) => void deleted.push(k) };

    expect(await cleanupAbandonedUploads(prisma, store)).toBeGreaterThanOrEqual(1);
    expect(deleted).toContain(stale.storageKey);
    expect(deleted).not.toContain(fresh.storageKey);
    expect(deleted).not.toContain(confirmed.storageKey);
    expect(await prisma.taskAttachment.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.taskAttachment.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await prisma.taskAttachment.findUnique({ where: { id: confirmed.id } })).not.toBeNull();
  });

  it('keeps the row when S3 deletion fails (retried next run)', async () => {
    const company = await prisma.company.create({ data: { name: 'Retention2' } });
    const user = await prisma.user.create({ data: { companyId: company.id, email: `r2-${Date.now()}@t.local`, name: 'U', role: 'PROJECT_MANAGER' } });
    const project = await prisma.project.create({ data: { companyId: company.id, name: 'P' } });
    const task = await prisma.task.create({ data: { projectId: project.id, assigneeId: user.id, createdById: user.id, title: 'T', deadline: new Date(Date.now() + 86400_000) } });
    const a = await prisma.taskAttachment.create({
      data: { taskId: task.id, uploadedById: user.id, fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 10, storageKey: `t/${Math.random()}`, createdAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await cleanupAbandonedUploads(prisma, { delete: async () => { throw new Error('s3 down'); } });
    expect(await prisma.taskAttachment.findUnique({ where: { id: a.id } })).not.toBeNull();
  });
});

describe('real-time publisher', () => {
  it('sends one NOTIFY per 100 recipients with ids/types only', async () => {
    const calls: string[] = [];
    const fake = { $executeRaw: vi.fn(async (_s: TemplateStringsArray, _channel: string, payload: string) => void calls.push(payload)) };
    const users = Array.from({ length: 250 }, (_, i) => `u${i}`);
    await publishRealtime(fake as unknown as PrismaClient, users, { kind: 'notification', type: 'TASK_COMPLETED', taskId: 't', projectId: 'p' });
    expect(calls).toHaveLength(3);
    const parsed = calls.map((c) => JSON.parse(c));
    expect(parsed.map((p) => p.users.length)).toEqual([100, 100, 50]);
    expect(parsed[0].event).toEqual({ kind: 'notification', type: 'TASK_COMPLETED', taskId: 't', projectId: 'p' });
    expect(Math.max(...calls.map((c) => Buffer.byteLength(c)))).toBeLessThan(8000); // NOTIFY limit
  });

  it('never throws (a missed live update must not fail notification processing)', async () => {
    const failing = { $executeRaw: async () => { throw new Error('db down'); } };
    await expect(publishRealtime(failing as unknown as PrismaClient, ['u1'], { kind: 'notification', type: 'TASK_ASSIGNED' })).resolves.toBeUndefined();
  });

  it('real NOTIFY round-trip through Postgres succeeds', async () => {
    await expect(publishRealtime(prisma, ['u1'], { kind: 'notification', type: 'TASK_ASSIGNED', taskId: 't' })).resolves.toBeUndefined();
  });
});

describe('Arabic-first defaults', () => {
  it('new users and companies default to Arabic and Asia/Riyadh', async () => {
    const company = await prisma.company.create({ data: { name: 'Defaults' } });
    const user = await prisma.user.create({ data: { companyId: company.id, email: `d-${Date.now()}@t.local`, name: 'D', role: 'EMPLOYEE' } });
    expect(company.timezone).toBe('Asia/Riyadh');
    expect(user.locale).toBe('ar');
  });
});
