import type { TaskDto } from '@dailytasks/shared-types';

// Arabic uses the Gregorian calendar explicitly (plain "ar-SA" would default to Hijri).
let intlLocale: string | undefined;
export function setFormatLocale(locale: 'en' | 'ar') {
  intlLocale = locale === 'ar' ? 'ar-u-ca-gregory' : 'en';
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' });
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  return rtf.format(Math.round(diff / 86400_000), 'day');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Converts a value from <input type="datetime-local"> (local time) to an ISO string with offset. */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

/** ISO -> value usable by <input type="datetime-local"> in the browser's local time. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type TaskTone = 'blue' | 'amber' | 'green' | 'red' | 'gray';

export function taskStatusDisplay(t: Pick<TaskDto, 'status' | 'isOverdue' | 'completedLate'>): { label: string; tone: TaskTone } {
  if (t.status === 'COMPLETED') return t.completedLate ? { label: 'Completed late', tone: 'amber' } : { label: 'Completed', tone: 'green' };
  if (t.isOverdue) return { label: 'Overdue', tone: 'red' };
  if (t.status === 'IN_PROGRESS') return { label: 'In progress', tone: 'blue' };
  return { label: 'Assigned', tone: 'gray' };
}
