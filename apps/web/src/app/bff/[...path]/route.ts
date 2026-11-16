import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, apiBase, clearSessionCookies, clientIpHeaders, isSameOrigin, REFRESH_COOKIE, refreshTokens, setSessionCookies } from '@/lib/server-session';

export const dynamic = 'force-dynamic';

/**
 * Backend-for-frontend proxy: /bff/<path> -> API /api/v1/<path>.
 * Adds the bearer token from the httpOnly cookie and transparently refreshes it once on 401.
 */
async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ message: 'Cross-origin request rejected' }, { status: 403 });
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p.includes('\\'))) return NextResponse.json({ message: 'Bad path' }, { status: 400 });
  const target = `${apiBase()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
  const jar = await cookies();

  const forward = (token?: string) =>
    fetch(target, {
      method: req.method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': req.headers.get('content-type') ?? 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...clientIpHeaders(req),
        ...(req.headers.get('accept-language') ? { 'Accept-Language': req.headers.get('accept-language')! } : {}),
        // The API labels push subscriptions by the browser's user agent (display/diagnostics only).
        ...(req.headers.get('user-agent') ? { 'User-Agent': req.headers.get('user-agent')!.slice(0, 512) } : {}),
      },
      body,
      cache: 'no-store',
    });

  let upstream = await forward(jar.get(ACCESS_COOKIE)?.value);
  let refreshed: Awaited<ReturnType<typeof refreshTokens>> = null;
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;
  if (upstream.status === 401 && refreshToken) {
    refreshed = await refreshTokens(refreshToken, clientIpHeaders(req));
    if (refreshed) upstream = await forward(refreshed.accessToken);
  }

  const res = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
  if (refreshed) setSessionCookies(res, refreshed);
  else if (upstream.status === 401) clearSessionCookies(res);
  return res;
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
