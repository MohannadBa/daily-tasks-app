import type { TaskDto } from '@dailytasks/shared-types';

/**
 * Application timezone. Timestamps are stored and transported as UTC (ISO 8601); everything shown
 * to users — and every date/time a user types — is in Riyadh time, regardless of the device's zone.
 */
export const APP_TIMEZONE = 'Asia/Riyadh';

// Arabic uses the Gregorian calendar explicitly (plain "ar-SA" would default to Hijri).
let intlLocale: string | undefined;
export function setFormatLocale(locale: 'en' | 'ar') {
  intlLocale = locale === 'ar' ? 'ar-u-ca-gregory' : 'en';
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: APP_TIMEZONE }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeZone: APP_TIMEZONE }).format(new Date(iso));
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' });
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  return rtf.format(Math.round(diff / 86400_000), 'day');
}

/** Duration such as "1d 4h" / "1 يوم 4 س" (accountable time, budgets, extensions). */
export function formatDuration(ms: number): string {
  const mins = Math.round(Math.max(0, ms) / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const ar = intlLocale?.startsWith('ar');
  const u = ar ? { d: ' يوم', h: ' س', m: ' د' } : { d: 'd', h: 'h', m: 'm' };
  const parts = [d && `${d}${u.d}`, h && `${h}${u.h}`, (m || (!d && !h)) && `${m}${u.m}`].filter(Boolean);
  return parts.join(' ');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Offset (ms) of `timeZone` from UTC at the given instant (handles DST zones generically). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** "YYYY-MM-DDTHH:mm" typed in <input type="datetime-local"> (Riyadh wall time) -> UTC ISO string. */
export function localInputToIso(value: string, timeZone = APP_TIMEZONE): string {
  const [date, time = '00:00'] = value.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  // Two passes resolve the offset correctly around DST transitions.
  let utc = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  utc = wallAsUtc - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc).toISOString();
}

/** UTC ISO -> "YYYY-MM-DDTHH:mm" Riyadh wall time for <input type="datetime-local">. */
export function isoToLocalInput(iso: string, timeZone = APP_TIMEZONE): string {
  const d = new Date(new Date(iso).getTime() + zoneOffsetMs(new Date(iso), timeZone));
  return d.toISOString().slice(0, 16);
}

export type TaskTone = 'blue' | 'amber' | 'green' | 'red' | 'gray';

export function taskStatusDisplay(t: Pick<TaskDto, 'status' | 'isOverdue' | 'completedLate'>): { label: string; tone: TaskTone } {
  if (t.status === 'COMPLETED') return t.completedLate ? { label: 'Completed late', tone: 'amber' } : { label: 'Completed', tone: 'green' };
  if (t.status === 'PENDING_REVIEW') return { label: 'Pending approval', tone: 'amber' };
  if (t.isOverdue) return { label: 'Overdue', tone: 'red' };
  if (t.status === 'IN_PROGRESS') return { label: 'In progress', tone: 'blue' };
  return { label: 'Assigned', tone: 'gray' };
}
