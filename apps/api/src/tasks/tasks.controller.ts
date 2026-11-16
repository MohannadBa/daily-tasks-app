import { Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveSubmissionSchema,
  changeApproverSchema,
  completeTaskSchema,
  createCommentSchema,
  createTaskSchema,
  decisionReasonSchema,
  extensionDecisionSchema,
  extensionRequestSchema,
  forwardSubmissionSchema,
  reassignTaskSchema,
  rejectSubmissionSchema,
  reopenTaskSchema,
  submitTaskSchema,
  taskListQuerySchema,
  transferDeclineSchema,
  transferRequestSchema,
  transferResponseSchema,
  updateTaskSchema,
  type z,
} from '@dailytasks/validation';
import { TimeLedgerService } from '../workflow/time-ledger.service';
import { WorkflowService } from '../workflow/workflow.service';
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
  constructor(
    private readonly tasks: TasksService,
    private readonly workflow: WorkflowService,
  ) {}

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

  /** Deprecated alias of POST /tasks/:id/submissions (completion now requires approval). Returns the task. */
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ deprecated: true, summary: 'Submit completion for approval (legacy alias)' })
  @ApiZodBody(completeTaskSchema)
  async complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(completeTaskSchema) body: z.infer<typeof completeTaskSchema>) {
    await this.workflow.submit(user, id, { comment: body.comment, attachmentIds: body.attachmentIds });
    return this.tasks.get(user, id);
  }

  @Post(':id/submissions')
  @ApiOperation({ summary: 'Submit completion (comment required) for review' })
  @ApiZodBody(submitTaskSchema)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(submitTaskSchema) body: z.infer<typeof submitTaskSchema>) {
    return this.workflow.submit(user, id, body);
  }

  @Get(':id/submissions')
  submissions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.listSubmissions(user, id);
  }

  @Post(':id/transfers')
  @ApiOperation({ summary: 'Transfer the task to an eligible colleague (reason required; recipient must accept)' })
  @ApiZodBody(transferRequestSchema)
  transfer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(transferRequestSchema) body: z.infer<typeof transferRequestSchema>) {
    return this.workflow.requestTransfer(user, id, body);
  }

  @Get(':id/transfer-candidates')
  @ApiOperation({ summary: 'Eligible colleagues for a transfer (responsible employee only)' })
  transferCandidates(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.transferCandidates(user, id);
  }

  @Get(':id/transfers')
  transfers(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.listTransfers(user, id);
  }

  @Post(':id/extensions')
  @ApiOperation({ summary: 'Request a deadline extension (reason required)' })
  @ApiZodBody(extensionRequestSchema)
  requestExtension(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(extensionRequestSchema) body: z.infer<typeof extensionRequestSchema>) {
    return this.workflow.requestExtension(user, id, body);
  }

  @Get(':id/extensions')
  extensions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.listExtensions(user, id);
  }

  @Get(':id/time')
  @ApiOperation({ summary: 'Time ledger of every cycle (accountable time, segments, per-employee)' })
  time(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.tasks.timeLedger(user, id);
  }

  @Patch(':id/approver')
  @ApiZodBody(changeApproverSchema)
  changeApprover(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(changeApproverSchema) body: z.infer<typeof changeApproverSchema>) {
    return this.tasks.changeApprover(user, id, body.approverId);
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

/** Decisions on individual submissions, transfers and extension requests. */
@ApiTags('workflow')
@ApiBearerAuth()
@Controller()
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Post('submissions/:id/forward')
  @HttpCode(200)
  @ApiZodBody(forwardSubmissionSchema)
  forward(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(forwardSubmissionSchema) body: z.infer<typeof forwardSubmissionSchema>) {
    return this.workflow.forward(user, id, body);
  }

  @Post('submissions/:id/return')
  @HttpCode(200)
  @ApiZodBody(decisionReasonSchema)
  returnToDelegate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(decisionReasonSchema) body: z.infer<typeof decisionReasonSchema>) {
    return this.workflow.returnToDelegate(user, id, body.reason);
  }

  @Post('submissions/:id/approve')
  @HttpCode(200)
  @ApiZodBody(approveSubmissionSchema)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(approveSubmissionSchema) body: z.infer<typeof approveSubmissionSchema>) {
    return this.workflow.approve(user, id, body);
  }

  @Post('submissions/:id/reject')
  @HttpCode(200)
  @ApiZodBody(rejectSubmissionSchema)
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(rejectSubmissionSchema) body: z.infer<typeof rejectSubmissionSchema>) {
    return this.workflow.reject(user, id, body);
  }

  @Post('submissions/:id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.withdraw(user, id);
  }

  @Post('transfers/:id/accept')
  @HttpCode(200)
  @ApiZodBody(transferResponseSchema)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(transferResponseSchema) body: z.infer<typeof transferResponseSchema>) {
    return this.workflow.acceptTransfer(user, id, body.note);
  }

  @Post('transfers/:id/decline')
  @HttpCode(200)
  @ApiZodBody(transferDeclineSchema)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(transferDeclineSchema) body: z.infer<typeof transferDeclineSchema>) {
    return this.workflow.declineOrCancelTransfer(user, id, 'DECLINE', body.reason);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @ApiZodBody(transferResponseSchema)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(transferResponseSchema) body: z.infer<typeof transferResponseSchema>) {
    return this.workflow.declineOrCancelTransfer(user, id, 'CANCEL', body.note);
  }

  @Get('me/transfers')
  incoming(@CurrentUser() user: AuthUser) {
    return this.workflow.incomingTransfers(user);
  }

  @Get('me/reviews')
  @ApiOperation({ summary: 'Completion review inbox (pending submissions addressed to me)' })
  reviews(@CurrentUser() user: AuthUser) {
    return this.workflow.reviewInbox(user);
  }

  @Post('extensions/:id/decide')
  @HttpCode(200)
  @ApiZodBody(extensionDecisionSchema)
  decide(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id, @ZBody(extensionDecisionSchema) body: z.infer<typeof extensionDecisionSchema>) {
    return this.workflow.decideExtension(user, id, body);
  }

  @Post('extensions/:id/cancel')
  @HttpCode(200)
  cancelExtension(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: Id) {
    return this.workflow.cancelExtension(user, id);
  }
}

@Module({
  imports: [AttachmentsModule],
  controllers: [TasksController, WorkflowController],
  providers: [TasksService, WorkflowService, TimeLedgerService],
  exports: [TasksService, WorkflowService, TimeLedgerService],
})
export class TasksModule {}
