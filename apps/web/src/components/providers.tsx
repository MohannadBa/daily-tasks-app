'use client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CurrentUser } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { I18nProvider, LOCALE_COOKIE, useT, type Locale } from '@/lib/i18n';

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
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

const MeContext = createContext<CurrentUser | null>(null);

export function MeProvider({ children, fallback }: { children: (me: CurrentUser) => ReactNode; fallback: ReactNode }) {
  const { data } = useQuery({ queryKey: ['me'], queryFn: () => api.auth.me(), staleTime: 60_000 });
  const { setLocale } = useT();
  // First visit on this browser: adopt the language saved in the user's profile.
  useEffect(() => {
    if (data && !document.cookie.includes(`${LOCALE_COOKIE}=`)) setLocale(data.locale);
  }, [data, setLocale]);
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
