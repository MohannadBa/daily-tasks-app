import { NextResponse, type NextRequest } from 'next/server';

/** Redirect unauthenticated page requests to /login. API authorization is still enforced by the backend. */
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has('dt_refresh') || req.cookies.has('dt_access');
  const { pathname } = req.nextUrl;
  if (pathname === '/login') {
    return hasSession ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  }
  if (!hasSession) {
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!bff|session|_next|favicon.ico|icon.svg|health).*)'],
};
