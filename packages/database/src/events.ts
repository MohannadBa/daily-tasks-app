/**
 * Domain events written to the transactional outbox by the API and consumed by the worker.
 * Every message carries a stable `dedupeKey` so redelivery is idempotent end-to-end.
 */

export const OutboxEventType = {
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_UPDATED: 'TASK_UPDATED',
  TASK_REASSIGNED: 'TASK_REASSIGNED',
  TASK_COMMENT_ADDED: 'TASK_COMMENT_ADDED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_REOPENED: 'TASK_REOPENED',
  /** (Re)create deadline reminder/overdue schedules for a task at a given scheduleVersion. */
  TASK_SCHEDULE_SYNC: 'TASK_SCHEDULE_SYNC',
  /** Fired by EventBridge Scheduler / local scheduler when a reminder or deadline is reached. */
  TASK_DEADLINE_DUE: 'TASK_DEADLINE_DUE',
  /** User asked for a test push from the notification settings page. */
  PUSH_TEST: 'PUSH_TEST',
  // ---- Enterprise workflow notifications (payload: NotifyEventPayload with explicit recipients) ----
  TASK_SUBMITTED: 'TASK_SUBMITTED',
  TASK_SUBMISSION_FORWARDED: 'TASK_SUBMISSION_FORWARDED',
  TASK_APPROVED: 'TASK_APPROVED',
  TASK_REJECTED: 'TASK_REJECTED',
  TASK_RETURNED: 'TASK_RETURNED',
  TASK_TRANSFER_REQUESTED: 'TASK_TRANSFER_REQUESTED',
  TASK_TRANSFER_ACCEPTED: 'TASK_TRANSFER_ACCEPTED',
  TASK_TRANSFER_DECLINED: 'TASK_TRANSFER_DECLINED',
  TASK_EXTENSION_REQUESTED: 'TASK_EXTENSION_REQUESTED',
  TASK_EXTENSION_DECIDED: 'TASK_EXTENSION_DECIDED',
  DOCUMENT_REGISTERED: 'DOCUMENT_REGISTERED',
  USER_CREATED: 'USER_CREATED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /** Render a queued PDF report (payload: ReportRenderPayload). */
  REPORT_RENDER: 'REPORT_RENDER',
} as const;

/** Event types handled by the generic "notify explicit recipients" path in the worker. */
export const NOTIFY_EVENT_TYPES = [
  'TASK_SUBMITTED',
  'TASK_SUBMISSION_FORWARDED',
  'TASK_APPROVED',
  'TASK_REJECTED',
  'TASK_RETURNED',
  'TASK_TRANSFER_REQUESTED',
  'TASK_TRANSFER_ACCEPTED',
  'TASK_TRANSFER_DECLINED',
  'TASK_EXTENSION_REQUESTED',
  'TASK_EXTENSION_DECIDED',
  'DOCUMENT_REGISTERED',
  'USER_CREATED',
  'PASSWORD_CHANGE_REQUIRED',
] as const;

/**
 * Notification event with recipients decided inside the API transaction (who reviews, who is
 * responsible, ...). The worker re-checks that recipients are active before notifying.
 */
export interface NotifyEventPayload {
  taskId?: string;
  projectId?: string;
  actorId: string | null;
  recipients: string[];
  /** Short user-facing extra text (e.g. rejection reason), already trimmed. */
  vars?: { reason?: string; minutes?: number; name?: string };
  /** In-app link for non-task notifications. */
  url?: string;
}

export interface ReportRenderPayload {
  reportId: string;
}
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

export interface TaskEventPayload {
  taskId: string;
  projectId: string;
  actorId: string | null;
  /** Arbitrary extra details (e.g. previousAssigneeId, commentId, changed fields). */
  details?: Record<string, unknown>;
}

export interface PushTestPayload {
  userId: string;
}

export interface ScheduleSyncPayload {
  taskId: string;
  scheduleVersion: number;
}

export interface DeadlineDuePayload {
  taskId: string;
  scheduleVersion: number;
  /** "REMINDER" with offsetMinutes, or "OVERDUE" at the deadline itself. */
  kind: 'REMINDER' | 'OVERDUE';
  offsetMinutes: number;
}

/** Envelope placed on SQS. */
export interface QueueMessage<T = unknown> {
  id: string;
  type: OutboxEventType;
  dedupeKey: string;
  occurredAt: string;
  payload: T;
}

export function deadlineScheduleName(taskId: string, version: number, kind: 'REMINDER' | 'OVERDUE', offsetMinutes: number): string {
  // EventBridge schedule names: max 64 chars, [0-9a-zA-Z-_.]
  const k = kind === 'OVERDUE' ? 'od' : `r${offsetMinutes}`;
  return `t-${taskId}-v${version}-${k}`;
}
