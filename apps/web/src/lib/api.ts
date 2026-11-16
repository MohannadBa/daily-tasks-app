'use client';
import { createApiClient } from '@dailytasks/api-client';

/** Browser API client. Calls go through the same-origin /bff proxy, which attaches the session token. */
export const api = createApiClient({
  baseUrl: '/bff',
  onUnauthorized: async () => {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    return false;
  },
});

export async function logout() {
  await fetch('/session/logout', { method: 'POST' });
  window.location.href = '/login';
}
