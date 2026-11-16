import 'server-only';
import type { AuthTokens } from '@dailytasks/shared-types';
import type { NextResponse } from 'next/server';

export const ACCESS_COOKIE = 'dt_access';
export const REFRESH_COOKIE = 'dt_refresh';

export const apiBase = () => process.env.API_INTERNAL_URL ?? 'http://localhost:3000/api/v1';
const secure = () => (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';

/** Tokens are stored only in httpOnly cookies; browser JavaScript never sees them. */
export function setSessionCookies(res: NextResponse, tokens: AuthTokens) {
  const base = { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/' };
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: Math.max(60, tokens.expiresIn - 30) });
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: 30 * 24 * 3600 });
}

export function clearSessionCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 });
}

export async function refreshTokens(refreshToken: string, extraHeaders: Record<string, string> = {}): Promise<AuthTokens | null> {
  const res = await fetch(`${apiBase()}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthTokens;
}

export { clientIpHeaders } from './client-ip';

/** Basic CSRF defence for cookie-authenticated mutations: the Origin must match this host. */
export function isSameOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
