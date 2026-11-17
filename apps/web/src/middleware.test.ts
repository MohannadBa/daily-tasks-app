import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { middleware } from './middleware';

// Unit level only: here NextResponse.redirect still holds the absolute URL. The Next.js server turns
// same-origin redirects into a relative Location — proven against the real server by
// e2e/https-redirects.spec.ts (the property that keeps redirects on https behind CloudFront).
const req = (path: string, cookie?: string) => new NextRequest(`http://localhost:3001${path}`, { headers: cookie ? { cookie } : {} });
const target = (res: Response) => {
  const loc = res.headers.get('location');
  return loc ? new URL(loc).pathname + new URL(loc).search : null;
};

describe('middleware redirects', () => {
  it('signed-out deep link → /login with the target preserved', () => {
    const res = middleware(req('/tasks/123?tab=files'));
    expect(res.status).toBe(307);
    expect(target(res)).toBe('/login?next=%2Ftasks%2F123%3Ftab%3Dfiles');
  });

  it('signed-out root → /login without a next parameter; signed-in user on /login → /', () => {
    expect(target(middleware(req('/')))).toBe('/login');
    expect(target(middleware(req('/login', 'dt_refresh=x')))).toBe('/');
  });

  it('the redirect keeps the request origin (never another scheme or host)', () => {
    const loc = new URL(middleware(req('/tasks')).headers.get('location')!);
    expect(loc.origin).toBe('http://localhost:3001');
  });

  it('no redirect for signed-in pages and the public recovery page', () => {
    expect(middleware(req('/tasks', 'dt_access=x')).headers.get('location')).toBeNull();
    expect(middleware(req('/forgot-password')).headers.get('location')).toBeNull();
  });
});
