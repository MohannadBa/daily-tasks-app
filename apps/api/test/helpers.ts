import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ensureCompanyDefaults, PrismaClient, ProjectRole, UserRole } from '@dailytasks/database';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { API_ENV } from '../src/config/config.module';
import { TokenService } from '../src/auth/token.service';
import { configureApp } from '../src/main';
import { StorageService, type StoredObjectInfo } from '../src/storage/storage.service';

/** In-memory S3 replacement: "uploads" are simulated by calling put(). */
export class FakeStorage extends StorageService {
  objects = new Map<string, StoredObjectInfo>();
  async presignUpload(key: string, contentType: string) {
    return { url: `https://fake-s3.local/${key}?signed=1`, headers: { 'Content-Type': contentType } };
  }
  async presignDownload(key: string, _fileName?: string, _ttl?: number, inline = false) {
    return `https://fake-s3.local/${key}?download=1${inline ? '&inline=1' : ''}`;
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
  put(key: string, sizeBytes: number, contentType?: string) {
    this.objects.set(key, { sizeBytes, contentType });
  }
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  storage: FakeStorage;
  tokens: TokenService;
}

export async function createTestApp(): Promise<TestContext> {
  const storage = new FakeStorage();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(StorageService)
    .useValue(storage)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, app.get(API_ENV));
  await app.init();
  return { app, prisma: new PrismaClient(), storage, tokens: app.get(TokenService) };
}

let counter = 0;
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Builds an isolated company world for one test file. */
export async function seedWorld(prisma: PrismaClient) {
  const company = await prisma.company.create({ data: { name: `Co ${uid()}` } });
  const mk = (name: string, role: UserRole) =>
    prisma.user.create({ data: { companyId: company.id, email: `${name}-${uid()}@test.local`, name, role } });
  const admin = await mk('admin', UserRole.ADMIN);
  const managerA = await mk('managerA', UserRole.PROJECT_MANAGER);
  const managerB = await mk('managerB', UserRole.PROJECT_MANAGER);
  const emp1 = await mk('emp1', UserRole.EMPLOYEE);
  const emp2 = await mk('emp2', UserRole.EMPLOYEE);
  const emp3 = await mk('emp3', UserRole.EMPLOYEE);
  const projectA = await prisma.project.create({ data: { companyId: company.id, name: 'Project A' } });
  const projectB = await prisma.project.create({ data: { companyId: company.id, name: 'Project B' } });
  await prisma.projectMembership.createMany({
    data: [
      { projectId: projectA.id, userId: managerA.id, role: ProjectRole.MANAGER },
      { projectId: projectA.id, userId: emp1.id, role: ProjectRole.EMPLOYEE },
      { projectId: projectA.id, userId: emp2.id, role: ProjectRole.EMPLOYEE },
      { projectId: projectB.id, userId: managerB.id, role: ProjectRole.MANAGER },
      { projectId: projectB.id, userId: emp3.id, role: ProjectRole.EMPLOYEE },
    ],
  });
  // Departments (D-1/D-2): every employee in Project Management (primary); emp2 also in Engineering.
  await ensureCompanyDefaults(prisma, company.id);
  const dept = await prisma.department.findFirstOrThrow({ where: { companyId: company.id, code: 'PROJECT_MANAGEMENT' } });
  const dept2 = await prisma.department.findFirstOrThrow({ where: { companyId: company.id, code: 'ENGINEERING_OFFICES' } });
  await prisma.departmentMembership.createMany({
    data: [
      { departmentId: dept.id, userId: emp1.id, isPrimary: true },
      { departmentId: dept.id, userId: emp2.id, isPrimary: true },
      { departmentId: dept.id, userId: emp3.id, isPrimary: true },
      { departmentId: dept2.id, userId: emp2.id, isPrimary: false },
    ],
  });
  return { company, admin, managerA, managerB, emp1, emp2, emp3, projectA, projectB, dept, dept2 };
}

/** Adds a user to a department (tests creating extra employees). */
export const joinDepartment = (prisma: PrismaClient, departmentId: string, userId: string, isPrimary = true) =>
  prisma.departmentMembership.create({ data: { departmentId, userId, isPrimary } });

/**
 * Submits as the responsible employee, then approves as the task's approver.
 * Returns the task as the employee sees it.
 */
export async function submitAndApprove(ctx: TestContext, taskId: string, employeeId: string, comment = 'All done', attachmentIds: string[] = []) {
  const sub = await api(ctx, employeeId).post(`/tasks/${taskId}/submissions`, { comment, attachmentIds });
  if (sub.status !== 201) throw new Error(`submit failed ${sub.status} ${JSON.stringify(sub.body)}`);
  const task = await ctx.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  const ok = await api(ctx, task.approverId).post(`/submissions/${sub.body.id}/approve`, {});
  if (ok.status !== 200) throw new Error(`approve failed ${ok.status} ${JSON.stringify(ok.body)}`);
  return (await api(ctx, employeeId).get(`/tasks/${taskId}`)).body;
}

const HOUR = 3600_000;
/**
 * Moves the current cycle into the past so that `workedHours` of active work have elapsed against a
 * budget of `budgetHours` (only the open segment is touched; closed segments are immutable).
 */
export async function backdateCycle(prisma: PrismaClient, taskId: string, workedHours: number, budgetHours: number) {
  const now = Date.now();
  const cycle = await prisma.taskCycle.findFirstOrThrow({ where: { taskId }, orderBy: { cycleNo: 'desc' } });
  const start = new Date(now - workedHours * HOUR);
  await prisma.taskCycle.update({ where: { id: cycle.id }, data: { startedAt: start, approvedDeadline: new Date(start.getTime() + budgetHours * HOUR), originalDeadline: new Date(start.getTime() + budgetHours * HOUR) } });
  await prisma.taskTimeSegment.updateMany({ where: { cycleId: cycle.id, endedAt: null }, data: { startedAt: start } });
  await prisma.task.update({
    where: { id: taskId },
    data: { budgetMs: BigInt(budgetHours * HOUR), chargedMs: BigInt(0), clockRunningSince: start, effectiveDueAt: new Date(start.getTime() + budgetHours * HOUR), deadline: new Date(start.getTime() + budgetHours * HOUR) },
  });
}

export function api(ctx: TestContext, userId?: string) {
  const auth = userId ? { Authorization: `Bearer ${ctx.tokens.issueLocalTokens(userId).accessToken}` } : {};
  const agent = request(ctx.app.getHttpServer());
  const p = (path: string) => `/api/v1${path}`;
  return {
    get: (path: string) => agent.get(p(path)).set(auth),
    post: (path: string, body?: object) => agent.post(p(path)).set(auth).send(body ?? {}),
    patch: (path: string, body: object) => agent.patch(p(path)).set(auth).send(body),
    put: (path: string, body: object) => agent.put(p(path)).set(auth).send(body),
    delete: (path: string, body?: object) => agent.delete(p(path)).set(auth).send(body ?? {}),
  };
}

export const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
