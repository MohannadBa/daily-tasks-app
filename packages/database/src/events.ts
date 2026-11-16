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
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

export interface TaskEventPayload {
  taskId: string;
  projectId: string;
  actorId: string | null;
  /** Arbitrary extra details (e.g. previousAssigneeId, commentId, changed fields). */
  details?: Record<string, unknown>;
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
