'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bell, BarChart3, ClipboardList, FolderKanban, LayoutDashboard, LogOut, Menu, Settings, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, logout } from '@/lib/api';
import { MeProvider, useMe } from './providers';
import { Spinner } from './ui';
import { useT } from '@/lib/i18n';

export function AppShell({ children }: { children: ReactNode }) {
  return <MeProvider fallback={<Spinner />}>{() => <Shell>{children}</Shell>}</MeProvider>;
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const { t, locale, setLocale } = useT();
  const switchLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    // Keep the profile in sync so push notifications use the same language.
    void api.auth.updateProfile({ locale: next }).catch(() => undefined);
  };
  const [open, setOpen] = useState(false);
  const isAdmin = me.role === 'COMPANY_ADMIN';
  const isManager = isAdmin || me.managedProjectIds.length > 0;
  const unread = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.notifications.unreadCount(), refetchInterval: 30_000 });

  const nav = [
    { href: '/', label: t('Dashboard'), icon: LayoutDashboard, show: true },
    { href: '/projects', label: t('Projects'), icon: FolderKanban, show: true },
    { href: '/tasks', label: t(isManager ? 'Tasks' : 'My tasks'), icon: ClipboardList, show: true },
    { href: '/employees', label: t('Employees'), icon: BarChart3, show: isManager },
    { href: '/users', label: t('Team'), icon: Users, show: isAdmin },
    { href: '/notifications', label: t('Notifications'), icon: Bell, show: true, badge: unread.data?.count },
    { href: '/settings', label: t('Settings'), icon: Settings, show: true },
  ].filter((n) => n.show);

  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const sidebar = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">DT</div>
        <div>
          <p className="text-sm font-semibold text-slate-900">DailyTasks</p>
          <p className="text-xs text-slate-500">{me.companyName}</p>
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 px-3">
        {nav.map(({ href, label, icon: Icon, badge }) => (
          <li key={href}>
            <Link
              href={href}
              onClick={() => setOpen(false)}
              className={clsx(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                active(href) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span className="flex-1">{label}</span>
              {!!badge && <span className="rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white">{badge > 99 ? '99+' : badge}</span>}
            </Link>
          </li>
        ))}
      </ul>
      <div className="border-t border-slate-200 p-4">
        <p className="truncate text-sm font-medium text-slate-900">{me.name}</p>
        <p className="truncate text-xs text-slate-500">{t(me.role === 'COMPANY_ADMIN' ? 'Admin' : me.role === 'PROJECT_MANAGER' ? 'Project manager' : 'Employee')}</p>
        <div className="mt-3 flex items-center justify-between">
          <button onClick={() => void logout()} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900">
            <LogOut className="h-4 w-4 rtl:-scale-x-100" aria-hidden /> {t('Sign out')}
          </button>
          <button onClick={switchLanguage} className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
            {locale === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 border-e border-slate-200 bg-white lg:block">{sidebar}</aside>
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <span className="font-semibold">DailyTasks</span>
        <button aria-label={t('Open menu')} onClick={() => setOpen(true)}>
          <Menu className="h-6 w-6" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 bg-white shadow-xl">
            <button aria-label={t('Close menu')} className="absolute end-3 top-4" onClick={() => setOpen(false)}>
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
