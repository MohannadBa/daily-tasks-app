'use client';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { Logo } from './logo';

/** Shared frame for sign-in / password recovery: brand panel on desktop, logo above the form on phones. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { t, locale, setLocale } = useT();
  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden border-e border-brand-100 bg-brand-50 p-10 lg:flex">
        <Logo size={150} lockup />
        <div className="max-w-sm">
          <p className="text-2xl font-semibold leading-snug text-slate-900">{t('Every task, reply and deadline — in one place.')}</p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('Assign work, follow progress and get notified the moment something changes.')}</p>
        </div>
        <p className="text-xs text-slate-500">© {new Date().getFullYear()} {t('Al-Rasiyat')}</p>
      </aside>
      <main className="relative flex flex-1 items-center justify-center px-4 pb-[env(safe-area-inset-bottom)] pt-[calc(4.5rem+env(safe-area-inset-top))] lg:pt-0">
        <button
          onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
          className="absolute end-4 top-[calc(1rem+env(safe-area-inset-top))] min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand-300 hover:bg-brand-50"
        >
          {locale === 'ar' ? 'English' : 'العربية'}
        </button>
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center lg:items-start lg:text-start">
            <Logo size={96} lockup className="mb-5 lg:hidden" />
            <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <div className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(33,31,28,0.04)] sm:p-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
