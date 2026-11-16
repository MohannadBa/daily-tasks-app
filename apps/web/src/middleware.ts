import { NextResponse, type NextRequest } from 'next/server';

/** Redirect unauthenticated page requests to /login. API authorization is still enforced by the backend. */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has('dt_refresh') || req.cookies.has('dt_access');
  const { pathname } = req.nextUrl;
  // Password recovery must work while signed out.
  if (pathname === '/forgot-password') return NextResponse.next();
  if (pathname === '/login') {
    return hasSession ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  }
  if (!hasSession) {
    const url = new URL('/login', req.url);
    // Keep deep links (e.g. /tasks/<id>?tab=x from a notification) across the login round-trip.
    const target = pathname + req.nextUrl.search;
    if (target !== '/') url.searchParams.set('next', target);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Public assets: API proxy, auth, Next internals, health, and the PWA files (manifest, service worker,
  // offline shell, icons) — these must load without a session (install, offline, login screen).
  matcher: ['/((?!bff|session|_next|health|favicon|icon.svg|icons/|brand/|apple-touch-icon|manifest.webmanifest|sw.js|offline.html).*)'],
};
