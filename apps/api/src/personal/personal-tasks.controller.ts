import { Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { ApiEnv } from '@dailytasks/config';
import type { PersonalTask, Prisma } from '@dailytasks/database';
import type { Paginated, PersonalTaskDto } from '@dailytasks/shared-types';
import { personalTaskCreateSchema, personalTaskListQuerySchema, personalTaskUpdateSchema, type z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { notFound } from '../common/errors';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { API_ENV } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AES-256-GCM field encryption for personal task content (D-12). Format: v1.<iv>.<tag>.<ciphertext>
 * (base64url). The key is derived from PERSONAL_DATA_KEY (Secrets Manager in AWS); database
 * readers — including admins with SQL access — see only ciphertext.
 */
@Injectable()
export class PersonalCrypto {
  private readonly key: Buffer;
  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.key = createHash('sha256').update(env.PERSONAL_DATA_KEY).digest();
  }

  encrypt(plain: string, ownerId: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(ownerId)); // ciphertext is bound to its owner (no row swapping)
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
  }

  decrypt(value: string, ownerId: string): string {
    const [v, iv, tag, data] = value.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(ownerId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }
}

/**
 * Personal tasks: strictly owner-only. No role (ADMIN included) can read another user's personal
 * tasks — every query is keyed by ownerId = caller, and foreign ids return 404. They are not
 * linked to projects, so they never appear in reports, dashboards, documents or notifications.
 */
@ApiTags('personal-tasks')
@ApiBearerAuth()
@Controller('me/personal-tasks')
export class PersonalTasksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: PersonalCrypto,
  ) {}

  private toDto(t: PersonalTask): PersonalTaskDto {
    return {
      id: t.id,
      title: this.crypto.decrypt(t.titleEnc, t.ownerId),
      notes: t.notesEnc ? this.crypto.decrypt(t.notesEnc, t.ownerId) : null,
      dueAt: t.dueAt?.toISOString() ?? null,
      priority: t.priority,
      status: t.status,
      completedAt: t.completedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private async own(user: AuthUser, id: string) {
    const t = await this.prisma.personalTask.findFirst({ where: { id, ownerId: user.id } });
    if (!t) throw notFound('Personal task not found');
    return t;
  }

  @Get()
  @ApiOperation({ summary: "The caller's own personal tasks (search happens after decryption)" })
  async list(@CurrentUser() user: AuthUser, @ZQuery(personalTaskListQuerySchema) q: z.infer<typeof personalTaskListQuerySchema>): Promise<Paginated<PersonalTaskDto>> {
    const where: Prisma.PersonalTaskWhereInput = { ownerId: user.id, ...(q.status ? { status: q.status } : {}) };
    const orderBy: Prisma.PersonalTaskOrderByWithRelationInput[] = [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }];
    if (q.q) {
      // Content is encrypted, so text search runs in memory over the owner's own rows (bounded).
      const needle = q.q.toLocaleLowerCase();
      const all = (await this.prisma.personalTask.findMany({ where, orderBy, take: 2000 })).map((t) => this.toDto(t));
      const hits = all.filter((t) => t.title.toLocaleLowerCase().includes(needle) || (t.notes ?? '').toLocaleLowerCase().includes(needle));
      return { items: hits.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: hits.length, page: q.page, pageSize: q.pageSize };
    }
    const [rows, total] = await Promise.all([
      this.prisma.personalTask.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.personalTask.count({ where }),
    ]);
    return { items: rows.map((t) => this.toDto(t)), total, page: q.page, pageSize: q.pageSize };
  }

  @Post()
  @ApiZodBody(personalTaskCreateSchema)
  async create(@CurrentUser() user: AuthUser, @ZBody(personalTaskCreateSchema) body: z.infer<typeof personalTaskCreateSchema>) {
    const t = await this.prisma.personalTask.create({
      data: {
        ownerId: user.id,
        titleEnc: this.crypto.encrypt(body.title, user.id),
        notesEnc: body.notes ? this.crypto.encrypt(body.notes, user.id) : null,
        dueAt: body.dueAt ?? null,
        priority: body.priority,
      },
    });
    return this.toDto(t);
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.toDto(await this.own(user, id));
  }

  @Patch(':id')
  @ApiZodBody(personalTaskUpdateSchema)
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(personalTaskUpdateSchema) body: z.infer<typeof personalTaskUpdateSchema>) {
    await this.own(user, id);
    const t = await this.prisma.personalTask.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { titleEnc: this.crypto.encrypt(body.title, user.id) } : {}),
        ...(body.notes !== undefined ? { notesEnc: body.notes ? this.crypto.encrypt(body.notes, user.id) : null } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      },
    });
    return this.toDto(t);
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.own(user, id);
    return this.toDto(await this.prisma.personalTask.update({ where: { id }, data: { status: 'DONE', completedAt: new Date() } }));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  async reopen(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.own(user, id);
    return this.toDto(await this.prisma.personalTask.update({ where: { id }, data: { status: 'OPEN', completedAt: null } }));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.prisma.personalTask.deleteMany({ where: { id, ownerId: user.id } });
    if (r.count !== 1) throw notFound('Personal task not found');
  }
}

@Module({ controllers: [PersonalTasksController], providers: [PersonalCrypto] })
export class PersonalTasksModule {}
