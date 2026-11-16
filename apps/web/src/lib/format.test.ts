import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, isoToLocalInput, localInputToIso, setFormatLocale, taskStatusDisplay } from './format';
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
  it('interprets typed times as Asia/Riyadh (UTC+3) regardless of the device timezone', () => {
    expect(localInputToIso('2030-05-01T14:30')).toBe('2030-05-01T11:30:00.000Z');
    expect(isoToLocalInput('2030-05-01T22:15:00.000Z')).toBe('2030-05-02T01:15'); // crosses midnight
    // Other zones still work (DST-aware), e.g. for future company settings.
    expect(localInputToIso('2030-07-01T12:00', 'Europe/London')).toBe('2030-07-01T11:00:00.000Z');
  });
  it('displays timestamps in Riyadh time', () => {
    setFormatLocale('en');
    expect(formatDateTime('2030-05-01T22:15:00.000Z')).toMatch(/May 2, 2030.*1:15/);
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
