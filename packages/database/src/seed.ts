/**
 * Idempotent development seed. Creates one company, an admin, two managers, four employees,
 * two projects with memberships and a handful of tasks in every state.
 *
 * Refuses to run when NODE_ENV=production unless SEED_ALLOW_PRODUCTION=true.
 * All demo accounts share the password in SEED_DEMO_PASSWORD (default: Password123!).
 */
import { PrismaClient, ProjectRole, TaskStatus, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';

const users = [
  { email: 'admin@dailytasks.local', name: 'Amal Admin', role: UserRole.COMPANY_ADMIN, locale: 'en' },
  { email: 'manager1@dailytasks.local', name: 'Mona Manager', role: UserRole.PROJECT_MANAGER, locale: 'en' },
  { email: 'manager2@dailytasks.local', name: 'Khalid Manager', role: UserRole.PROJECT_MANAGER, locale: 'ar' },
  { email: 'employee1@dailytasks.local', name: 'Omar Employee', role: UserRole.EMPLOYEE, locale: 'ar' },
  { email: 'employee2@dailytasks.local', name: 'Sara Employee', role: UserRole.EMPLOYEE, locale: 'en' },
  { email: 'employee3@dailytasks.local', name: 'Yousef Employee', role: UserRole.EMPLOYEE, locale: 'en' },
  { email: 'employee4@dailytasks.local', name: 'Lina Employee', role: UserRole.EMPLOYEE, locale: 'en' },
];

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    console.info('Skipping demo seed in production.');
    return;
  }
  const password = process.env.SEED_DEMO_PASSWORD || 'Password123!';
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.company.upsert({
    where: { id: COMPANY_ID },
    update: {},
    create: { id: COMPANY_ID, name: 'Acme Contracting', timezone: 'Asia/Riyadh' },
  });

  const byEmail: Record<string, string> = {};
  for (const u of users) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, companyId: COMPANY_ID, passwordHash },
    });
    byEmail[u.email] = row.id;
  }

  const existing = await prisma.project.count({ where: { companyId: COMPANY_ID } });
  if (existing > 0) {
    console.info('Seed data already present; users ensured.');
    return;
  }

  const tower = await prisma.project.create({
    data: { companyId: COMPANY_ID, name: 'Riyadh Office Tower', description: 'Fit-out of floors 3-7.' },
  });
  const mall = await prisma.project.create({
    data: { companyId: COMPANY_ID, name: 'Jeddah Mall Renovation', description: 'Retail units refurbishment.' },
  });

  const m = (projectId: string, email: string, role: ProjectRole) => ({ projectId, userId: byEmail[email]!, role });
  await prisma.projectMembership.createMany({
    data: [
      m(tower.id, 'manager1@dailytasks.local', ProjectRole.MANAGER),
      m(tower.id, 'employee1@dailytasks.local', ProjectRole.EMPLOYEE),
      m(tower.id, 'employee2@dailytasks.local', ProjectRole.EMPLOYEE),
      m(tower.id, 'employee3@dailytasks.local', ProjectRole.EMPLOYEE),
      m(mall.id, 'manager2@dailytasks.local', ProjectRole.MANAGER),
      m(mall.id, 'manager1@dailytasks.local', ProjectRole.MANAGER),
      m(mall.id, 'employee3@dailytasks.local', ProjectRole.EMPLOYEE),
      m(mall.id, 'employee4@dailytasks.local', ProjectRole.EMPLOYEE),
    ],
  });

  const hour = 3600 * 1000;
  const now = Date.now();
  const mgr1 = byEmail['manager1@dailytasks.local']!;
  const mgr2 = byEmail['manager2@dailytasks.local']!;

  const tasks: Array<{
    projectId: string;
    assignee: string;
    creator: string;
    title: string;
    description: string;
    deadline: number;
    status: TaskStatus;
    completedAt?: number;
    rating?: number;
    note?: string;
  }> = [
    { projectId: tower.id, assignee: 'employee1@dailytasks.local', creator: mgr1, title: 'Install floor 3 lighting', description: 'Install LED panels per drawing E-301.', deadline: now + 30 * hour, status: TaskStatus.ASSIGNED },
    { projectId: tower.id, assignee: 'employee2@dailytasks.local', creator: mgr1, title: 'Paint meeting rooms', description: 'Two coats, colour RAL 9010.', deadline: now + 2 * hour, status: TaskStatus.IN_PROGRESS },
    { projectId: tower.id, assignee: 'employee1@dailytasks.local', creator: mgr1, title: 'Fire extinguisher inspection', description: 'Check and tag all extinguishers on floor 4.', deadline: now - 5 * hour, status: TaskStatus.IN_PROGRESS },
    { projectId: tower.id, assignee: 'employee2@dailytasks.local', creator: mgr1, title: 'Replace ceiling tiles', description: 'Damaged tiles in corridor B.', deadline: now - 48 * hour, status: TaskStatus.COMPLETED, completedAt: now - 50 * hour, rating: 5, note: 'Excellent, ahead of schedule.' },
    { projectId: tower.id, assignee: 'employee3@dailytasks.local', creator: mgr1, title: 'HVAC filter change', description: 'Replace filters in AHU-2.', deadline: now - 72 * hour, status: TaskStatus.COMPLETED, completedAt: now - 60 * hour, rating: 3, note: 'Completed late.' },
    { projectId: tower.id, assignee: 'employee1@dailytasks.local', creator: mgr1, title: 'Clean site entrance', description: 'Remove debris from entrance area.', deadline: now - 24 * hour, status: TaskStatus.COMPLETED, completedAt: now - 26 * hour },
    { projectId: mall.id, assignee: 'employee4@dailytasks.local', creator: mgr2, title: 'Shop 12 signage', description: 'Mount new signage frame.', deadline: now + 72 * hour, status: TaskStatus.ASSIGNED },
    { projectId: mall.id, assignee: 'employee3@dailytasks.local', creator: mgr2, title: 'Escalator safety check', description: 'Coordinate with vendor for inspection.', deadline: now - 10 * hour, status: TaskStatus.COMPLETED, completedAt: now - 12 * hour, rating: 4 },
  ];

  for (const t of tasks) {
    const assigneeId = byEmail[t.assignee]!;
    const completedAt = t.completedAt ? new Date(t.completedAt) : null;
    const deadline = new Date(t.deadline);
    const task = await prisma.task.create({
      data: {
        projectId: t.projectId,
        assigneeId,
        createdById: t.creator,
        title: t.title,
        description: t.description,
        deadline,
        status: t.status,
        startedAt: t.status !== TaskStatus.ASSIGNED ? new Date(now - 80 * hour) : null,
        completedAt,
        completedLate: completedAt ? completedAt > deadline : null,
        history: { create: [{ action: 'CREATED', actorId: t.creator, metadata: { assigneeId } }] },
      },
    });
    if (completedAt) {
      await prisma.taskComment.create({
        data: { taskId: task.id, authorId: assigneeId, body: 'Work finished, photos on site.', isCompletionNote: true, createdAt: completedAt },
      });
      await prisma.taskHistory.create({
        data: { taskId: task.id, actorId: assigneeId, action: 'COMPLETED', metadata: { completedLate: completedAt > deadline }, createdAt: completedAt },
      });
    }
    if (t.rating) {
      await prisma.taskRating.create({
        data: {
          taskId: task.id,
          employeeId: assigneeId,
          raterId: t.creator,
          stars: t.rating,
          feedback: t.note ?? null,
          revisions: { create: { changedById: t.creator, newStars: t.rating, newFeedback: t.note ?? null } },
        },
      });
    }
  }
  console.info(`Seeded demo company with ${users.length} users, 2 projects and ${tasks.length} tasks.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
