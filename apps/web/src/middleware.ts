import { NextResponse, type NextRequest } from 'next/server';

/**
 * Same-site redirect. The Next.js server rewrites a redirect whose origin equals the request's into a
 * RELATIVE `Location` (`/login?next=…`), so behind CloudFront → VPC origin (where the app sees http)
 * the browser stays on the https page it came from — no http:// URL reaches the HTTPS-only distribution.
 * Do not change the scheme or host here: a different origin disables that rewrite and would expose the
 * internal bind address. Proven against the real server by e2e/workflow.spec.ts ("relative Location").
 */
function redirectTo(req: NextRequest, path: string, params?: Record<string, string>): NextResponse {
  const url = new URL(path, req.url);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/** Redirect unauthenticated page requests to /login. API authorization is still enforced by the backend. */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has('dt_refresh') || req.cookies.has('dt_access');
  const { pathname } = req.nextUrl;
  // Password recovery must work while signed out.
  if (pathname === '/forgot-password') return NextResponse.next();
  if (pathname === '/login') {
    return hasSession ? redirectTo(req, '/') : NextResponse.next();
  }
  if (!hasSession) {
    // Keep deep links (e.g. /tasks/<id>?tab=x from a notification) across the login round-trip.
    const target = pathname + req.nextUrl.search;
    return redirectTo(req, '/login', target !== '/' ? { next: target } : undefined);
  }
  return NextResponse.next();
}

export const config = {
  // Public assets: API proxy, auth, Next internals, health, and the PWA files (manifest, service worker,
  // offline shell, icons) — these must load without a session (install, offline, login screen).
  matcher: ['/((?!bff|session|_next|health|favicon|icon.svg|icons/|brand/|apple-touch-icon|manifest.webmanifest|sw.js|offline.html).*)'],
};
