/**
 * Validation of the operations mailbox that receives alarm e-mails (ALARM_EMAIL / -c alarmEmail).
 * The address is never hard-coded: it is optional until opening access, and placeholder or
 * documentation domains are refused so alarm delivery is never "enabled" to a mailbox nobody reads.
 * Returns an error message, or null when the address is acceptable.
 */
const RESERVED = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|local)$/i;

export function validAlarmEmail(email: string): string | null {
  const e = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return `alarmEmail "${e}" is not a valid e-mail address`;
  const domain = e.split('@')[1]!;
  if (RESERVED.test(domain)) return `alarmEmail uses a placeholder/reserved domain (${domain}); configure a real operations mailbox or leave it empty`;
  return null;
}
