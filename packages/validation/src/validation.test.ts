import { describe, expect, it } from 'vitest';
import { completeTaskSchema, ratingSchema, uploadRequestSchema, createTaskSchema, updateCompanySettingsSchema } from './index';

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
    const base = { projectId: crypto.randomUUID(), assigneeId: crypto.randomUUID(), title: 'T' };
    expect(createTaskSchema.safeParse({ ...base, deadline: '2030-01-01T10:00:00Z' }).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...base, deadline: 'tomorrow' }).success).toBe(false);
  });
});

describe('updateCompanySettingsSchema', () => {
  it('dedupes and sorts reminder offsets descending', () => {
    expect(updateCompanySettingsSchema.parse({ reminderOffsetsMinutes: [60, 1440, 60] }).reminderOffsetsMinutes).toEqual([1440, 60]);
  });
});
