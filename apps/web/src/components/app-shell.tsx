'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  BarChart3,
  Bell,
  ChevronRight,
  ClipboardList,
  Download,
  FolderKanban,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, logout } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useInstallState } from '@/lib/pwa';
import { InstallBanner } from './install-app';
import { MeProvider, useMe } from './providers';
import { Spinner } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  return <MeProvider fallback={<Spinner />}>{() => <Shell>{children}</Shell>}</MeProvider>;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

const roleLabel = { COMPANY_ADMIN: 'Admin', PROJECT_MANAGER: 'Project manager', EMPLOYEE: 'Employee' } as const;

/** Parent route for the mobile back button when there is no in-app history (e.g. opened from a deep link). */
function parentOf(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  if (parts[0] === 'tasks' && parts[2] === 'edit') return `/tasks/${parts[1]}`;
  return `/${parts[0]}`;
}

function BadgeCount({ n, className }: { n?: number; className?: string }) {
  if (!n) return null;
  return <span className={clsx('min-w-[1.25rem] rounded-full bg-red-500 px-1.5 text-center text-[11px] font-semibold leading-5 text-white', className)}>{n > 99 ? '99+' : n}</span>;
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const { standalone } = useInstallState();
  const [moreOpen, setMoreOpen] = useState(false);
  const isAdmin = me.role === 'COMPANY_ADMIN';
  const isManager = isAdmin || me.managedProjectIds.length > 0;
  const unread = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.notifications.unreadCount(), refetchInterval: 30_000 });
  const unreadCount = unread.data?.count;

  const switchLanguage = () => {
    const next = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    // Keep the profile in sync so notifications use the same language.
    void api.auth.updateProfile({ locale: next }).catch(() => undefined);
  };

  // Track in-app history (for the back button) and close the sheet on navigation.
  const stack = useRef<string[]>([]);
  useEffect(() => {
    const s = stack.current;
    if (s.length > 1 && s[s.length - 2] === pathname) s.pop(); // went back
    else if (s[s.length - 1] !== pathname) s.push(pathname);
    setMoreOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [moreOpen]);

  const active = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  const primary: NavItem[] = [
    { href: '/', label: t('Home'), icon: LayoutDashboard },
    { href: '/tasks', label: t(isManager ? 'Tasks' : 'My tasks'), icon: ClipboardList },
    { href: '/projects', label: t('Projects'), icon: FolderKanban },
    { href: '/notifications', label: t('Alerts'), icon: Bell, badge: unreadCount },
  ];
  const secondary: NavItem[] = [
    ...(isManager ? [{ href: '/employees', label: t('Employees'), icon: BarChart3 }] : []),
    ...(isAdmin ? [{ href: '/users', label: t('Team'), icon: Users }] : []),
    { href: '/settings', label: t('Profile & settings'), icon: Settings },
  ];
  const desktopNav: NavItem[] = [
    { href: '/', label: t('Dashboard'), icon: LayoutDashboard },
    { href: '/projects', label: t('Projects'), icon: FolderKanban },
    { href: '/tasks', label: t(isManager ? 'Tasks' : 'My tasks'), icon: ClipboardList },
    ...secondary.filter((n) => n.href !== '/settings'),
    { href: '/notifications', label: t('Notifications'), icon: Bell, badge: unreadCount },
    { href: '/settings', label: t('Settings'), icon: Settings },
  ];

  const sectionTitle =
    [...desktopNav, ...secondary].filter((n) => n.href !== '/' && active(n.href)).sort((a, b) => b.href.length - a.href.length)[0]?.label ?? 'DailyTasks';
  const parent = parentOf(pathname);
  const goBack = () => {
    // The installed app has no browser back button. Go back only within this app session;
    // when the screen was opened directly (deep link / notification), go to its parent screen.
    if (stack.current.length > 1) router.back();
    else if (parent) router.push(parent);
  };

  const moreActive = secondary.some((n) => active(n.href));

  return (
    <div className="min-h-dvh lg:flex">
      {/* ---------- Desktop sidebar ---------- */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-e border-slate-200 bg-white lg:block">
        <nav className="flex h-full flex-col">
          <div className="flex items-center gap-2 px-5 py-5">
            <img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">DailyTasks</p>
              <p className="truncate text-xs text-slate-500">{me.companyName}</p>
            </div>
          </div>
          <ul className="flex-1 space-y-0.5 overflow-y-auto px-3">
            {desktopNav.map(({ href, label, icon: Icon, badge }) => (
              <li key={href}>
                <Link
                  href={href}
                  className={clsx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                    active(href) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="flex-1">{label}</span>
                  <BadgeCount n={badge} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-200 p-4">
            <p className="truncate text-sm font-medium text-slate-900">{me.name}</p>
            <p className="truncate text-xs text-slate-500">{t(roleLabel[me.role])}</p>
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
      </aside>

      {/* ---------- Mobile top app bar ---------- */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur lg:hidden">
        <div className="flex h-14 items-center gap-1 ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))]">
          {parent ? (
            <button onClick={goBack} aria-label={t('Back')} className="flex h-11 w-11 items-center justify-center rounded-full text-slate-700 active:bg-slate-100">
              <ArrowLeft className="h-5 w-5 rtl:-scale-x-100" aria-hidden />
            </button>
          ) : (
            <span className="flex h-11 w-11 items-center justify-center">
              <img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg" />
            </span>
          )}
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-base font-semibold text-slate-900">{pathname === '/' ? 'DailyTasks' : sectionTitle}</p>
            {pathname === '/' && <p className="-mt-0.5 truncate text-xs text-slate-500">{me.companyName}</p>}
          </div>
          <button onClick={switchLanguage} className="h-11 rounded-full px-3 text-sm font-medium text-slate-600 active:bg-slate-100" aria-label={t('Change language')}>
            {locale === 'ar' ? 'EN' : 'ع'}
          </button>
        </div>
      </header>

      <main
        className={clsx(
          'mx-auto w-full min-w-0 max-w-6xl flex-1 py-4 lg:px-8 lg:py-8',
          'ps-[max(1rem,env(safe-area-inset-left))] pe-[max(1rem,env(safe-area-inset-right))]',
          // Room for the bottom tab bar (+ home indicator) on phones.
          'pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-8',
        )}
      >
        {pathname === '/' && (
          <div className="lg:hidden">
            <InstallBanner />
          </div>
        )}
        {children}
      </main>

      {/* ---------- Mobile bottom tab bar ---------- */}
      <nav
        aria-label={t('Main')}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]">
          {primary.map(({ href, label, icon: Icon, badge }) => {
            const on = active(href);
            return (
              <li key={href} className="flex-1">
                <Link href={href} aria-current={on ? 'page' : undefined} className={clsx('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium', on ? 'text-brand-700' : 'text-slate-500')}>
                  <span className="relative">
                    <Icon className={clsx('h-6 w-6', on && 'stroke-[2.25]')} aria-hidden />
                    <BadgeCount n={badge} className="absolute -top-1.5 start-3.5" />
                  </span>
                  <span className="max-w-full truncate px-1">{label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={clsx('flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium', moreActive ? 'text-brand-700' : 'text-slate-500')}
            >
              <Menu className="h-6 w-6" aria-hidden />
              <span>{t('More')}</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* ---------- Mobile "More" sheet ---------- */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('More')}>
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl">
            <div className="flex items-center justify-between px-4 pb-2 pt-3">
              <span className="mx-auto h-1.5 w-10 rounded-full bg-slate-200" aria-hidden />
            </div>
            <div className="flex items-center gap-3 px-5 pb-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base font-semibold text-brand-700">{me.name.trim().charAt(0).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-900">{me.name}</p>
                <p className="truncate text-sm text-slate-500">
                  {t(roleLabel[me.role])} · {me.companyName}
                </p>
              </div>
              <button onClick={() => setMoreOpen(false)} aria-label={t('Close menu')} className="-me-2 flex h-11 w-11 items-center justify-center rounded-full text-slate-500 active:bg-slate-100">
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <ul className="mx-3 overflow-hidden rounded-xl border border-slate-200">
              {secondary.map(({ href, label, icon: Icon }) => (
                <li key={href} className="border-b border-slate-100 last:border-b-0">
                  <Link href={href} className={clsx('flex min-h-[3.25rem] items-center gap-3 px-4 text-[15px]', active(href) ? 'text-brand-700' : 'text-slate-800', 'active:bg-slate-50')}>
                    <Icon className="h-5 w-5 text-slate-400" aria-hidden />
                    <span className="flex-1">{label}</span>
                    <ChevronRight className="h-4 w-4 text-slate-300 rtl:-scale-x-100" aria-hidden />
                  </Link>
                </li>
              ))}
              {!standalone && (
                <li className="border-b border-slate-100 last:border-b-0">
                  <Link href="/settings#install" className="flex min-h-[3.25rem] items-center gap-3 px-4 text-[15px] text-slate-800 active:bg-slate-50">
                    <Download className="h-5 w-5 text-slate-400" aria-hidden />
                    <span className="flex-1">{t('Install the app')}</span>
                    <ChevronRight className="h-4 w-4 text-slate-300 rtl:-scale-x-100" aria-hidden />
                  </Link>
                </li>
              )}
            </ul>
            <ul className="mx-3 mt-3 overflow-hidden rounded-xl border border-slate-200">
              <li className="border-b border-slate-100">
                <button onClick={switchLanguage} className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 text-start text-[15px] text-slate-800 active:bg-slate-50">
                  <Languages className="h-5 w-5 text-slate-400" aria-hidden />
                  <span className="flex-1">{t('Language')}</span>
                  <span className="text-sm text-slate-500">{locale === 'ar' ? 'العربية' : 'English'}</span>
                </button>
              </li>
              <li>
                <button onClick={() => void logout()} className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 text-start text-[15px] text-red-600 active:bg-red-50">
                  <LogOut className="h-5 w-5 rtl:-scale-x-100" aria-hidden />
                  <span className="flex-1">{t('Sign out')}</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
