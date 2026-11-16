import { describe, expect, it } from 'vitest';
import {
  completeTaskSchema,
  createTaskSchema,
  decisionReasonSchema,
  documentUploadSchema,
  extensionDecisionSchema,
  extensionRequestSchema,
  inviteUserSchema,
  ratingSchema,
  rejectSubmissionSchema,
  reportRequestSchema,
  submitTaskSchema,
  transferDeclineSchema,
  transferRequestSchema,
  updateCompanySettingsSchema,
  uploadRequestSchema,
} from './index';

describe('completeTaskSchema', () => {
  it('rejects empty and whitespace-only completion comments', () => {
    expect(completeTaskSchema.safeParse({ comment: '' }).success).toBe(false);
    expect(completeTaskSchema.safeParse({ comment: '   ' }).success).toBe(false);
    expect(completeTaskSchema.safeParse({}).success).toBe(false);
  });
  it('accepts a comment with optional attachments', () => {
    const r = completeTaskSchema.parse({ comment: ' Done ' });
    expect(r.comment).toBe('Done');
    expect(r.attachmentIds).toEqual([]);
  });
});

describe('ratingSchema', () => {
  it.each([0, 6, 2.5, -1])('rejects %s stars', (stars) => {
    expect(ratingSchema.safeParse({ stars }).success).toBe(false);
  });
  it.each([1, 2, 3, 4, 5])('accepts %s stars', (stars) => {
    expect(ratingSchema.safeParse({ stars }).success).toBe(true);
  });
});

describe('uploadRequestSchema', () => {
  it('rejects disallowed content types', () => {
    expect(uploadRequestSchema.safeParse({ fileName: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 10 }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({ fileName: 'x.html', contentType: 'text/html', sizeBytes: 10 }).success).toBe(false);
  });
  it('rejects mismatched extensions', () => {
    expect(uploadRequestSchema.safeParse({ fileName: 'evil.exe', contentType: 'image/png', sizeBytes: 10 }).success).toBe(false);
  });
  it('rejects oversized files', () => {
    expect(uploadRequestSchema.safeParse({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 200 * 1024 * 1024 }).success).toBe(false);
  });
  it('accepts valid files', () => {
    expect(uploadRequestSchema.safeParse({ fileName: 'Photo.JPG', contentType: 'image/jpeg', sizeBytes: 1000 }).success).toBe(true);
  });
});

describe('createTaskSchema', () => {
  it('requires timezone-aware ISO deadlines', () => {
    const base = { projectId: crypto.randomUUID(), departmentId: crypto.randomUUID(), assigneeId: crypto.randomUUID(), title: 'T' };
    expect(createTaskSchema.safeParse({ ...base, deadline: '2030-01-01T10:00:00Z' }).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...base, deadline: 'tomorrow' }).success).toBe(false);
  });
  it('requires a department and defaults priority to MEDIUM', () => {
    const base = { projectId: crypto.randomUUID(), assigneeId: crypto.randomUUID(), title: 'T', deadline: '2030-01-01T10:00:00Z' };
    expect(createTaskSchema.safeParse(base).success).toBe(false);
    expect(createTaskSchema.parse({ ...base, departmentId: crypto.randomUUID() }).priority).toBe('MEDIUM');
    expect(createTaskSchema.safeParse({ ...base, departmentId: crypto.randomUUID(), priority: 'CRITICAL' }).success).toBe(false);
  });
});

describe('enterprise workflow schemas', () => {
  it('submission comment and rejection / return / decline reasons are mandatory', () => {
    expect(submitTaskSchema.safeParse({ comment: '   ' }).success).toBe(false);
    expect(submitTaskSchema.parse({ comment: ' done ' })).toEqual({ comment: 'done', attachmentIds: [] });
    expect(rejectSubmissionSchema.safeParse({}).success).toBe(false);
    expect(rejectSubmissionSchema.safeParse({ reason: ' ' }).success).toBe(false);
    expect(decisionReasonSchema.safeParse({ reason: 'fix labels' }).success).toBe(true);
    expect(transferDeclineSchema.safeParse({}).success).toBe(false);
    expect(transferRequestSchema.safeParse({ toUserId: crypto.randomUUID(), reason: '' }).success).toBe(false);
  });
  it('extension: minutes xor deadline, bounded; partial needs minutes; reject needs a note', () => {
    expect(extensionRequestSchema.safeParse({ requestedMinutes: 60, reason: 'rain' }).success).toBe(true);
    expect(extensionRequestSchema.safeParse({ requestedMinutes: 5, reason: 'rain' }).success).toBe(false);
    expect(extensionRequestSchema.safeParse({ requestedMinutes: 60, requestedDeadline: '2030-01-01T10:00:00Z', reason: 'x' }).success).toBe(false);
    expect(extensionRequestSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(extensionDecisionSchema.safeParse({ decision: 'PARTIAL' }).success).toBe(false);
    expect(extensionDecisionSchema.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(extensionDecisionSchema.safeParse({ decision: 'REJECT', note: 'no' }).success).toBe(true);
  });
  it('invited users need exactly one primary department', () => {
    const base = { email: 'a@b.co', name: 'A', role: 'EMPLOYEE' };
    const d = () => crypto.randomUUID();
    expect(inviteUserSchema.safeParse({ ...base, departments: [{ departmentId: d(), isPrimary: true }, { departmentId: d(), isPrimary: true }] }).success).toBe(false);
    expect(inviteUserSchema.safeParse({ ...base, departments: [{ departmentId: d() }] }).success).toBe(false);
    expect(inviteUserSchema.safeParse({ ...base, departments: [{ departmentId: d(), isPrimary: true }] }).success).toBe(true);
    expect(inviteUserSchema.safeParse({ ...base, role: 'COMPANY_ADMIN' }).success).toBe(false);
  });
  it('documents validate MIME type against the extension; reports cap the range', () => {
    const doc = { title: 'Plan', categoryId: crypto.randomUUID(), fileName: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 100 };
    expect(documentUploadSchema.safeParse(doc).success).toBe(true);
    expect(documentUploadSchema.safeParse({ ...doc, fileName: 'plan.exe' }).success).toBe(false);
    expect(documentUploadSchema.safeParse({ ...doc, fileName: '../plan.pdf' }).success).toBe(false);
    const r = { type: 'PROJECTS', projectIds: [crypto.randomUUID()], from: '2030-01-01T00:00:00Z' };
    expect(reportRequestSchema.safeParse({ ...r, to: '2030-06-01T00:00:00Z' }).success).toBe(true);
    expect(reportRequestSchema.safeParse({ ...r, to: '2031-06-01T00:00:00Z' }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ ...r, to: '2029-06-01T00:00:00Z' }).success).toBe(false);
  });
});

describe('updateCompanySettingsSchema', () => {
  it('dedupes and sorts reminder offsets descending', () => {
    expect(updateCompanySettingsSchema.parse({ reminderOffsetsMinutes: [60, 1440, 60] }).reminderOffsetsMinutes).toEqual([1440, 60]);
  });
});
