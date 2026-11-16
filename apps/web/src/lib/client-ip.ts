/**
 * Client IP to pass to the API, so per-IP limits (e.g. 10 logins/min) apply per user instead of
 * to the web server's own address. Behind the ALB the LAST X-Forwarded-For entry is the one the
 * ALB appended (the real client); earlier entries are client-controlled and ignored.
 * The API trusts exactly one proxy hop (`trust proxy` = 1).
 */
export function clientIpHeaders(req: Request): Record<string, string> {
  const xff = req.headers.get('x-forwarded-for');
  const ip = xff?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? { 'X-Forwarded-For': ip } : {};
}
