/**
 * Number of trusted proxies in front of the web server (CLIENT_IP_PROXY_HOPS, 1–3, default 1):
 *   1 = ALB only (custom-domain layout): the LAST X-Forwarded-For entry is the client (appended by the ALB).
 *   2 = CloudFront → ALB (no custom domain): CloudFront appends the viewer IP, then the ALB appends
 *       CloudFront's address, so the client is the SECOND-TO-LAST entry.
 * Entries further left are client-controlled and ignored. Must match the API's TRUST_PROXY_HOPS.
 */
export function proxyHops(value = process.env.CLIENT_IP_PROXY_HOPS): number {
  const n = Number(value ?? '1');
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1;
}

/**
 * Client IP to pass to the API, so per-IP limits (e.g. 10 logins/min) apply per user instead of
 * to the web server's own address. When the header has fewer entries than trusted hops, nothing is
 * forwarded (never trust a client-supplied value).
 */
export function clientIpHeaders(req: Request, hops = proxyHops()): Record<string, string> {
  const xff = req.headers.get('x-forwarded-for');
  const entries = xff?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const ip = entries.length >= hops ? entries.at(-hops) : undefined;
  return ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? { 'X-Forwarded-For': ip } : {};
}
