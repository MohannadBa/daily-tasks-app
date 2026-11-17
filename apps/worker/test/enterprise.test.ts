import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxEventType, PrismaClient, type QueueMessage, type ReportDataset } from '@dailytasks/database';
import { cleanupAbandonedUploads, type ObjectStore } from '../src/attachments';
import { Notifier } from '../src/notifier';
import { EventProcessor } from '../src/processor';
import { RecordingPushTransport } from '../src/push';
import { MemoryQueue } from '../src/queue';
import { ChromiumPdfRenderer, cleanupExpiredReports, footerHtml, formatDate, formatDuration, historyLabel, processReport, renderReportHtml, type PdfRenderer } from '../src/reports';
import { deadlineMessage, LocalDbScheduler } from '../src/scheduler';
import { taskFields } from './fixtures';

const prisma = new PrismaClient();
const H = 3600_000;
let n = 0;
const u = () => `${Date.now()}-${n++}`;
const msg = (type: string, payload: object, dedupeKey: string): QueueMessage => ({ id: u(), type: type as OutboxEventType, dedupeKey, occurredAt: new Date().toISOString(), payload });

class MemStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  deleted: string[] = [];
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

async function world() {
  const company = await prisma.company.create({ data: { name: 'Ent', reminderOffsetsMinutes: [1440, 60] } });
  const mk = (name: string, role: 'PROJECT_MANAGER' | 'EMPLOYEE' | 'ADMIN', locale = 'en') =>
    prisma.user.create({ data: { companyId: company.id, email: `${name}-${u()}@t.local`, name, role, locale } });
  const manager = await mk('Manager', 'PROJECT_MANAGER');
  const emp = await mk('Emp', 'EMPLOYEE', 'ar');
  const emp2 = await mk('Emp2', 'EMPLOYEE');
  const project = await prisma.project.create({ data: { companyId: company.id, name: 'Tower' } });
  await prisma.projectMembership.createMany({
    data: [
      { projectId: project.id, userId: manager.id, role: 'MANAGER' },
      { projectId: project.id, userId: emp.id, role: 'EMPLOYEE' },
      { projectId: project.id, userId: emp2.id, role: 'EMPLOYEE' },
    ],
  });
  const deadline = new Date(Date.now() + 48 * H);
  const task = await prisma.task.create({
    data: { projectId: project.id, assigneeId: emp.id, createdById: manager.id, title: 'Pour slab', deadline, scheduleVersion: 1, ...(await taskFields(prisma, company.id, manager.id, deadline)) },
  });
  return { company, manager, emp, emp2, project, task };
}

let push: RecordingPushTransport;
let queue: MemoryQueue;
let processor: EventProcessor;
let notifier: Notifier;
beforeAll(async () => {
  await prisma.$connect();
  push = new RecordingPushTransport();
  queue = new MemoryQueue();
  notifier = new Notifier(prisma, push);
  processor = new EventProcessor(prisma, notifier, new LocalDbScheduler(prisma, queue));
});
afterAll(() => prisma.$disconnect());

describe('workflow notifications (explicit recipients)', () => {
  it('TASK_REJECTED reaches the submitter only, localized, with the reason, and is idempotent', async () => {
    const w = await world();
    const m = msg(
      OutboxEventType.TASK_REJECTED,
      { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id, recipients: [w.emp.id, w.manager.id], vars: { reason: 'صور ناقصة' } },
      `TASK_REJECTED:${u()}`,
    );
    await processor.handle(m);
    await processor.handle(m); // redelivery
    const rows = await prisma.notification.findMany({ where: { dedupeKey: m.dedupeKey } });
    expect(rows).toHaveLength(1); // actor (manager) excluded, duplicate suppressed
    expect(rows[0]!.userId).toBe(w.emp.id);
    expect(rows[0]!.title).toBe('تم رفض التسليم');
    expect(rows[0]!.body).toContain('صور ناقصة');
  });

  it('every new workflow type renders EN and AR text', async () => {
    const w = await world();
    const types = [
      'TASK_SUBMITTED',
      'TASK_SUBMISSION_FORWARDED',
      'TASK_APPROVED',
      'TASK_RETURNED',
      'TASK_TRANSFER_REQUESTED',
      'TASK_TRANSFER_ACCEPTED',
      'TASK_TRANSFER_DECLINED',
      'TASK_EXTENSION_REQUESTED',
      'TASK_EXTENSION_DECIDED',
      'DOCUMENT_REGISTERED',
    ];
    for (const type of types) {
      await processor.handle(msg(type, { taskId: w.task.id, projectId: w.project.id, actorId: w.manager.id, recipients: [w.emp.id, w.emp2.id], vars: { minutes: 120 } }, `${type}:${u()}`));
    }
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id } });
    expect(rows).toHaveLength(types.length * 2);
    for (const r of rows) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.body.length).toBeGreaterThan(0);
    }
    expect(rows.find((r) => r.type === 'TASK_EXTENSION_DECIDED' && r.userId === w.emp.id)!.body).toContain('ساعة');
  });

  it('non-task notifications (user created) link to their page', async () => {
    const w = await world();
    const m = msg(OutboxEventType.USER_CREATED, { actorId: w.manager.id, recipients: [w.emp2.id], vars: { name: 'New Person' }, url: '/users' }, `USER_CREATED:${u()}`);
    await prisma.pushSubscription.create({ data: { userId: w.emp2.id, endpoint: `https://fcm.googleapis.com/fcm/send/${u()}`, p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22), platform: 'ANDROID' } });
    await processor.handle(m);
    const row = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: m.dedupeKey } });
    expect(row.body).toContain('New Person');
    expect((row.data as { url: string }).url).toBe('/users');
    expect(push.sent.find((s) => s.payload.notificationId === row.id)?.payload.url).toBe('/users');
  });
});

describe('ledger-based deadlines', () => {
  it('a paused task (pending manager review) is never reported overdue', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.task.id }, data: { budgetMs: BigInt(H), chargedMs: BigInt(2 * H), clockRunningSince: null, effectiveDueAt: null } });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 }));
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(0);
  });

  it('wall-clock deadline passed but accountable time within budget (extension/pauses) → no overdue', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.task.id }, data: { deadline: new Date(Date.now() - H), budgetMs: BigInt(10 * H), chargedMs: BigInt(5 * H), clockRunningSince: new Date() } });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 1, kind: 'OVERDUE', offsetMinutes: 0 }));
    expect(await prisma.notification.count({ where: { taskId: w.task.id } })).toBe(0);
  });

  it('overdue fires once per cycle even across schedule versions, and includes the approver', async () => {
    const w = await world();
    await prisma.task.update({ where: { id: w.task.id }, data: { budgetMs: BigInt(H), chargedMs: BigInt(H + 1000), clockRunningSince: new Date(), scheduleVersion: 5 } });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 5, kind: 'OVERDUE', offsetMinutes: 0 }));
    await prisma.task.update({ where: { id: w.task.id }, data: { scheduleVersion: 6 } });
    await processor.handle(deadlineMessage({ taskId: w.task.id, scheduleVersion: 6, kind: 'OVERDUE', offsetMinutes: 0 }));
    const rows = await prisma.notification.findMany({ where: { taskId: w.task.id, type: 'TASK_OVERDUE' } });
    expect(rows.map((r) => r.userId).sort()).toEqual([w.emp.id, w.manager.id].sort());
  });

  it('schedule sync uses effectiveDueAt; paused tasks get no jobs', async () => {
    const w = await world();
    const due = new Date(Date.now() + 30 * H);
    await prisma.task.update({ where: { id: w.task.id }, data: { effectiveDueAt: due, scheduleVersion: 2 } });
    await processor.handle(msg(OutboxEventType.TASK_SCHEDULE_SYNC, { taskId: w.task.id, scheduleVersion: 2 }, u()));
    const ev = await prisma.scheduledEvent.findMany({ where: { name: { startsWith: `t-${w.task.id}-v2-` } }, orderBy: { runAt: 'asc' } });
    expect(ev.at(-1)!.runAt.toISOString()).toBe(due.toISOString());
    await prisma.task.update({ where: { id: w.task.id }, data: { effectiveDueAt: null, clockRunningSince: null, scheduleVersion: 3 } });
    await processor.handle(msg(OutboxEventType.TASK_SCHEDULE_SYNC, { taskId: w.task.id, scheduleVersion: 3 }, u()));
    expect(await prisma.scheduledEvent.count({ where: { name: { startsWith: `t-${w.task.id}-` }, firedAt: null } })).toBe(0);
  });
});

const dataset = (overrides: Partial<ReportDataset> = {}): ReportDataset => ({
  version: 1,
  type: 'TASK',
  locale: 'ar',
  generatedAt: new Date().toISOString(),
  generatedBy: { name: 'مدير' },
  companyName: 'الراسيات',
  includesRatings: false,
  filters: [],
  subject: { name: 'صب الخرسانة' },
  summary: { total: 1, completed: 1, completedOnTime: 0, completedLate: 1, open: 0, overdueOpen: 0, pendingReview: 0, transfers: 1, extensions: 1, accountableMs: 28 * H },
  tasks: [
    {
      id: 't1',
      title: 'صب <الخرسانة>',
      project: 'برج',
      department: 'إدارة المشاريع',
      priority: 'HIGH',
      status: 'COMPLETED',
      assignee: { name: 'أحمد' },
      approver: { name: 'مدير' },
      createdBy: { name: 'مدير' },
      createdAt: new Date().toISOString(),
      originalDeadline: new Date().toISOString(),
      deadline: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      completedLate: true,
      budgetMs: 24 * H,
      accountableMs: 28 * H,
      overdueMs: 4 * H,
      cycles: [],
      submissions: [],
      transfers: [{ requestedAt: new Date().toISOString(), from: 'أحمد', to: 'سالم', reason: 'اختصاص', status: 'ACCEPTED', respondedAt: null, note: null }],
      extensions: [],
      comments: [{ at: new Date().toISOString(), author: 'أحمد', body: '<script>alert(1)</script>', attachments: ['a.pdf'] }],
    },
  ],
  truncated: false,
  ...overrides,
});

describe('PDF reports', () => {
  it('HTML is RTL Arabic, embeds fonts + logo, escapes content and hides ratings unless included', () => {
    const html = renderReportHtml(dataset());
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toMatch(/@font-face\{font-family:'Plex Arabic';font-weight:400/);
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).toContain('data:image/svg+xml;base64,');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('صب &lt;الخرسانة&gt;');
    expect(html).not.toContain('التقييم (سري)');
    expect(html).not.toMatch(/https?:\/\//); // self-contained
    const withRating = renderReportHtml(dataset({ includesRatings: true, tasks: [{ ...dataset().tasks[0]!, rating: { stars: 4, feedback: 'جيد' } }] }));
    expect(withRating).toContain('التقييم (سري)');
    expect(withRating).toContain('★★★★☆');
  });

  it('visual QA fixes: localized history, unbreakable bidi-isolated dates, RTL footer, page-break rules', () => {
    expect(historyLabel('EXTENSION_REQUESTED', 'ar')).toBe('طلب تمديد');
    expect(historyLabel('SUBMITTED', 'en')).toBe('Submitted for review');
    const html = renderReportHtml(dataset({ tasks: [{ ...dataset().tasks[0]!, history: [{ at: new Date().toISOString(), action: 'REJECTED', actor: 'مدير' }] }] }));
    expect(html).toContain('رفض التسليم');
    expect(html).not.toMatch(/>REJECTED</);
    const ar = formatDate('2026-11-17T10:19:00Z', 'ar');
    expect(ar.startsWith('⁧') && ar.endsWith('⁩')).toBe(true);
    expect(ar).not.toContain(' ');
    expect(formatDate('2026-11-17T10:19:00Z', 'en')).not.toMatch(/[ ⁧⁩]/);
    const f = footerHtml({ company: 'الراسيات', ref: 'f5a24c65', locale: 'ar' });
    expect(f).toContain('dir="rtl"');
    expect(f).toContain('<span dir="ltr">f5a24c65</span>');
    expect(f).toContain('صفحة <span class="pageNumber"></span> من <span class="totalPages"></span>');
    expect(footerHtml({ company: 'Al-Rasiyat', ref: 'x', locale: 'en' })).toContain('Page <span class="pageNumber"></span> of');
    expect(html).toContain('break-after:avoid');
    expect(renderReportHtml(dataset({ type: 'EMPLOYEE' }))).toContain('class="task compact"');
    expect(html).toContain('class="task"');
  });

  it('formats durations in both languages', () => {
    expect(formatDuration(28 * H, 'en')).toBe('1d 4h');
    expect(formatDuration(22 * H, 'ar')).toBe('22 ساعة');
  });

  it('render job: stores PDF in S3, marks READY, drops the dataset, notifies requester once', async () => {
    const w = await world();
    const job = await prisma.reportJob.create({
      data: { companyId: w.company.id, requestedById: w.manager.id, type: 'TASK', params: {}, dataset: dataset() as never, expiresAt: new Date(Date.now() + 86400_000) },
    });
    const store = new MemStore();
    const fake: PdfRenderer = { render: async (html) => Buffer.from(`%PDF-1.7 ${html.length}`) };
    const p = new EventProcessor(prisma, notifier, new LocalDbScheduler(prisma, queue), (id) => processReport(prisma, store, fake, notifier, id));
    await p.handle(msg(OutboxEventType.REPORT_RENDER, { reportId: job.id }, `REPORT_RENDER:${job.id}`));
    await p.handle(msg(OutboxEventType.REPORT_RENDER, { reportId: job.id }, `REPORT_RENDER:${job.id}`)); // redelivery: no-op
    const after = await prisma.reportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('READY');
    expect(after.dataset).toBeNull();
    expect(after.storageKey).toBe(`reports/${w.company.id}/${job.id}.pdf`);
    expect(store.objects.get(after.storageKey!)!.contentType).toBe('application/pdf');
    expect(await prisma.notification.count({ where: { userId: w.manager.id, type: 'REPORT_READY' } })).toBe(1);
  });

  it('render failure marks FAILED and rethrows (SQS retry); a retry can succeed', async () => {
    const w = await world();
    const job = await prisma.reportJob.create({
      data: { companyId: w.company.id, requestedById: w.manager.id, type: 'TASK', params: {}, dataset: dataset() as never, expiresAt: new Date(Date.now() + 86400_000) },
    });
    const store = new MemStore();
    await expect(processReport(prisma, store, { render: async () => Promise.reject(new Error('chromium crashed')) }, notifier, job.id)).rejects.toThrow('chromium crashed');
    expect((await prisma.reportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    await processReport(prisma, store, { render: async () => Buffer.from('%PDF') }, notifier, job.id);
    expect((await prisma.reportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('READY');
  });

  it('expired reports are deleted (object + row)', async () => {
    const w = await world();
    const job = await prisma.reportJob.create({
      data: { companyId: w.company.id, requestedById: w.manager.id, type: 'TASK', params: {}, status: 'READY', storageKey: `reports/x/${u()}.pdf`, expiresAt: new Date(Date.now() - 1000) },
    });
    const store = new MemStore();
    expect(await cleanupExpiredReports(prisma, store)).toBeGreaterThanOrEqual(1);
    expect(store.deleted).toContain(job.storageKey);
    expect(await prisma.reportJob.findUnique({ where: { id: job.id } })).toBeNull();
  });

  const chrome = [process.env.CHROMIUM_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
  it.skipIf(!chrome)('real Chromium renders a valid Arabic PDF', async () => {
    const pdf = await new ChromiumPdfRenderer(chrome, 60_000).render(renderReportHtml(dataset()), { company: 'الراسيات', ref: 'abc12345', locale: 'ar' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
  }, 90_000);
});

describe('documents retention', () => {
  it('removes unconfirmed manual document uploads older than 24h', async () => {
    const w = await world();
    const cat = await prisma.documentCategory.create({ data: { companyId: w.company.id, code: `C${n++}`, nameAr: 'عام', nameEn: 'General' } });
    const doc = await prisma.projectDocument.create({
      data: {
        projectId: w.project.id,
        categoryId: cat.id,
        title: 'Drawing',
        source: 'MANUAL',
        visibility: 'PROJECT_MEMBERS',
        storageKey: `projects/${w.project.id}/documents/${u()}`,
        fileName: 'd.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        status: 'PENDING',
        uploadedById: w.manager.id,
        createdAt: new Date(Date.now() - 30 * H),
      },
    });
    const store = new MemStore();
    await cleanupAbandonedUploads(prisma, store);
    expect(store.deleted).toContain(doc.storageKey);
    expect(await prisma.projectDocument.findUnique({ where: { id: doc.id } })).toBeNull();
  });
});
