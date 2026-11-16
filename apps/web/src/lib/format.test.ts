import { describe, expect, it } from 'vitest';
import { formatBytes, isoToLocalInput, localInputToIso, taskStatusDisplay } from './format';
import { validateFile, mimeFor } from './files';

describe('taskStatusDisplay', () => {
  it('shows overdue only for open tasks', () => {
    expect(taskStatusDisplay({ status: 'IN_PROGRESS', isOverdue: true, completedLate: null }).label).toBe('Overdue');
    expect(taskStatusDisplay({ status: 'COMPLETED', isOverdue: false, completedLate: false }).label).toBe('Completed');
    expect(taskStatusDisplay({ status: 'COMPLETED', isOverdue: false, completedLate: true }).label).toBe('Completed late');
    expect(taskStatusDisplay({ status: 'ASSIGNED', isOverdue: false, completedLate: null }).label).toBe('Assigned');
  });
});

describe('date helpers', () => {
  it('round-trips datetime-local values', () => {
    const iso = localInputToIso('2030-05-01T14:30');
    expect(isoToLocalInput(iso)).toBe('2030-05-01T14:30');
  });
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

describe('file validation', () => {
  it('rejects disallowed and oversized files', () => {
    expect(validateFile({ name: 'a.exe', size: 10 })).toMatch(/not an allowed/);
    expect(validateFile({ name: 'a.pdf', size: 30 * 1024 * 1024 })).toMatch(/larger/);
    expect(validateFile({ name: 'photo.JPG', size: 10 })).toBeNull();
    expect(mimeFor('report.docx')).toContain('wordprocessingml');
  });
});
