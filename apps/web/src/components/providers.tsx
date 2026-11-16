'use client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CurrentUser } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { I18nProvider, LOCALE_COOKIE, useT, type Locale } from '@/lib/i18n';
import { syncPushSubscription } from '@/lib/push';
import { PwaInit } from '@/lib/pwa';
import { FeedbackProvider } from './feedback';

export function Providers({ children, locale }: { children: ReactNode; locale: Locale }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: (count, err) => count < 2 && !(err as { status?: number }).status },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <PwaInit />
      <ServiceWorkerMessages />
      <I18nProvider initialLocale={locale}>
        <FeedbackProvider>{children}</FeedbackProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

/**
 * Messages from the service worker:
 *  - dt:push      a push arrived -> refresh notification list / unread badge now
 *  - dt:navigate  a notification was tapped while the app is open -> client-side navigation (acked)
 */
function ServiceWorkerMessages() {
  const qc = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string } | null;
      if (data?.type === 'dt:push') void qc.invalidateQueries({ queryKey: ['notifications'] });
      if (data?.type === 'dt:navigate' && typeof data.path === 'string' && data.path.startsWith('/') && !data.path.startsWith('//')) {
        router.push(data.path);
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        e.ports[0]?.postMessage('ok');
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [qc, router]);
  return null;
}

const MeContext = createContext<CurrentUser | null>(null);

export function MeProvider({ children, fallback }: { children: (me: CurrentUser) => ReactNode; fallback: ReactNode }) {
  const { data } = useQuery({ queryKey: ['me'], queryFn: () => api.auth.me(), staleTime: 60_000 });
  const { setLocale } = useT();
  // First visit on this browser: adopt the language saved in the user's profile.
  useEffect(() => {
    if (data && !document.cookie.includes(`${LOCALE_COOKIE}=`)) setLocale(data.locale);
  }, [data, setLocale]);
  // Signed in: re-register this browser's existing push subscription (never prompts).
  const userId = data?.id;
  useEffect(() => {
    if (userId) void syncPushSubscription();
  }, [userId]);
  if (!data) return <>{fallback}</>;
  return <MeContext.Provider value={data}>{children(data)}</MeContext.Provider>;
}

export function useMe(): CurrentUser {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside MeProvider');
  return me;
}

/** True for admins and users who manage at least one project. */
export function useIsManager() {
  const me = useMe();
  return me.role === 'COMPANY_ADMIN' || me.managedProjectIds.length > 0;
}
