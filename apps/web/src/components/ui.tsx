'use client';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import type { ComponentPropsWithRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TaskTone } from '@/lib/format';
import { useT } from '@/lib/i18n';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-55',
        // Touch targets: >=40px (sm) / 44px (md) on phones, compact on desktop.
        size === 'sm' ? 'min-h-10 px-3 py-1.5 text-sm lg:min-h-0' : 'min-h-11 px-4 py-2 text-[15px] sm:text-sm lg:min-h-0',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-800 hover:border-brand-300 hover:bg-brand-50 active:bg-brand-100',
        variant === 'danger' && 'bg-danger-600 text-white hover:bg-danger-700',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 active:bg-slate-200',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = 'primary' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' }) {
  return (
    <Link
      href={href}
      className={clsx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-[15px] font-medium transition sm:text-sm lg:min-h-0',
        variant === 'primary' ? 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800' : 'border border-slate-300 bg-white text-slate-800 hover:border-brand-300 hover:bg-brand-50',
      )}
    >
      {children}
    </Link>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('min-w-0 rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[0_1px_2px_rgba(33,31,28,0.04)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

const tones: Record<TaskTone, string> = {
  blue: 'bg-info-50 text-info-700 ring-info-200',
  amber: 'bg-warning-50 text-warning-700 ring-warning-200',
  green: 'bg-success-50 text-success-700 ring-success-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
};

export function Badge({ tone = 'gray', children }: { tone?: TaskTone; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone])}>{children}</span>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-slate-500">{hint}</span>}
      {error && <span className="block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputCls =
  // text-base (16px) on phones stops iOS Safari zooming into focused fields; min-h for touch.
  'block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:bg-slate-50 sm:text-sm min-h-11 lg:min-h-0';

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={4} {...p} className={clsx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={clsx(inputCls, p.className)} />;

export function Spinner({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {label ?? t('Loading…')}
    </div>
  );
}

/** Shimmering placeholder while data loads (keeps layout stable instead of a spinner). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={clsx('dt-skeleton block rounded-md', className)} />;
}

/** Card-shaped list placeholder. */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  const { t } = useT();
  return (
    <div role="status" aria-label={t('Loading…')} className={clsx('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
      {msg}
    </div>
  );
}

export function Empty({ title, children, icon: Icon }: { title: string; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center">
      {Icon && (
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      )}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 sm:mb-6 sm:gap-4">
      <div className="min-w-0">
        <h1 className="break-words text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: string }> }) {
  return (
    <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 [scrollbar-width:none] sm:mx-0 sm:px-0" role="tablist">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={clsx(
            '-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium lg:min-h-0',
            value === i.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
