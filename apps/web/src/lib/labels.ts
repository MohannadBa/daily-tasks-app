import type { DepartmentDto, ExtensionStatus, SegmentKind, SubmissionStatus, TaskPriority, TransferStatus } from '@dailytasks/shared-types';
import type { TaskTone } from './format';

/** English phrases (translated with t()) + tones for workflow enums. */
export const submissionStatus: Record<SubmissionStatus, { label: string; tone: TaskTone }> = {
  PENDING: { label: 'Awaiting decision', tone: 'amber' },
  FORWARDED: { label: 'Forwarded', tone: 'blue' },
  APPROVED: { label: 'Approved', tone: 'green' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  RETURNED: { label: 'Returned', tone: 'red' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'gray' },
};

export const transferStatus: Record<TransferStatus, { label: string; tone: TaskTone }> = {
  PENDING: { label: 'Awaiting response', tone: 'amber' },
  ACCEPTED: { label: 'Accepted', tone: 'green' },
  DECLINED: { label: 'Declined', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
};

export const extensionStatus: Record<ExtensionStatus, { label: string; tone: TaskTone }> = {
  PENDING: { label: 'Awaiting decision', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  PARTIALLY_APPROVED: { label: 'Partially approved', tone: 'blue' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
};

export const segmentLabel: Record<SegmentKind, string> = {
  ACTIVE_WORK: 'Active work',
  TRANSFER_PENDING: 'Transfer pending',
  DELEGATOR_REVIEW: 'Colleague review',
  PENDING_REVIEW: 'Manager review (paused)',
  APPROVED_REVIEW: 'Approved review (excluded)',
  REJECTED_REVIEW: 'Rejected review (charged)',
};

export const priorityTone: Record<TaskPriority, TaskTone> = { LOW: 'gray', MEDIUM: 'blue', HIGH: 'amber', URGENT: 'red' };

export const deptName = (d: Pick<DepartmentDto, 'nameAr' | 'nameEn'> | null | undefined, locale: string) => (d ? (locale === 'ar' ? d.nameAr : d.nameEn) : '—');
