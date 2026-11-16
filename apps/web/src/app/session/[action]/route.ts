import { NextResponse, type NextRequest } from 'next/server';
import type { LoginResponse } from '@dailytasks/shared-types';
import { apiBase, clearSessionCookies, isSameOrigin, setSessionCookies } from '@/lib/server-session';

export const dynamic = 'force-dynamic';

/**
 * POST /session/login         { email, password }
 * POST /session/new-password  { email, session, newPassword }   (Cognito first login)
 * POST /session/logout
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ message: 'Cross-origin request rejected' }, { status: 403 });
  const { action } = await ctx.params;

  if (action === 'logout') {
    const res = new NextResponse(null, { status: 204 });
    clearSessionCookies(res);
    return res;
  }
  if (action !== 'login' && action !== 'new-password') return NextResponse.json({ message: 'Not found' }, { status: 404 });

  const upstream = await fetch(`${apiBase()}/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await req.text(),
    cache: 'no-store',
  });
  const data = (await upstream.json().catch(() => ({ message: 'Login failed' }))) as LoginResponse & { message?: string };
  if (!upstream.ok) return NextResponse.json({ message: data.message ?? 'Login failed' }, { status: upstream.status });
  if (data.status === 'NEW_PASSWORD_REQUIRED') return NextResponse.json(data);

  // Never return tokens to the browser.
  const res = NextResponse.json({ status: 'OK', user: data.user });
  setSessionCookies(res, data);
  return res;
}
