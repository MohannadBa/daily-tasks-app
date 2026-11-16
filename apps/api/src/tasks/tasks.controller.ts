import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  completeTaskSchema,
  createCommentSchema,
  createTaskSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
  type z,
} from '@dailytasks/validation';
import { AttachmentsModule } from '../attachments/attachments.controller';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { TasksService } from './tasks.service';

type Id = string;

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @ZQuery(taskListQuerySchema) q: z.infer<typeof taskListQuerySchema>) {
    return this.tasks.list(user, q);
  }

  @Post()
  @ApiZodBody(createTaskSchema)
  create(@CurrentUser() user: AuthUser, @ZBody(createTaskSchema) body: z.infer<typeof createTaskSchema>) {
    return this.tasks.create(user, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.tasks.get(user, id);
  }

  @Patch(':id')
  @ApiZodBody(updateTaskSchema)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(updateTaskSchema) body: z.infer<typeof updateTaskSchema>) {
    return this.tasks.update(user, id, body);
  }

  @Post(':id/reassign')
  @HttpCode(200)
  @ApiZodBody(reassignTaskSchema)
  reassign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(reassignTaskSchema) body: z.infer<typeof reassignTaskSchema>) {
    return this.tasks.reassign(user, id, body.assigneeId);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.tasks.start(user, id);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiZodBody(completeTaskSchema)
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(completeTaskSchema) body: z.infer<typeof completeTaskSchema>) {
    return this.tasks.complete(user, id, body);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @ApiZodBody(reopenTaskSchema)
  reopen(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(reopenTaskSchema) body: z.infer<typeof reopenTaskSchema>) {
    return this.tasks.reopen(user, id, body);
  }

  @Get(':id/comments')
  comments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.tasks.comments(user, id);
  }

  @Post(':id/comments')
  @ApiZodBody(createCommentSchema)
  addComment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(createCommentSchema) body: z.infer<typeof createCommentSchema>) {
    return this.tasks.addComment(user, id, body);
  }

  @Get(':id/history')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.tasks.history(user, id);
  }
}

@Module({ imports: [AttachmentsModule], controllers: [TasksController], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}
