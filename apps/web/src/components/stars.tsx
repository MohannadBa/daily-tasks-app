'use client';
import clsx from 'clsx';
import { Star } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/lib/i18n';

/** Read-only star display. */
export function Stars({ value, size = 16 }: { value: number | null; size?: number }) {
  const { t } = useT();
  if (value === null) return <span className="text-sm text-slate-400">{t('Not rated')}</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value.toFixed(2).replace(/\.?0+$/, '')} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, value - (i - 1)));
        return (
          <span key={i} className="relative inline-block" style={{ width: size, height: size }}>
            <Star className="absolute inset-0 text-slate-300" style={{ width: size, height: size }} aria-hidden />
            <span className="absolute inset-y-0 start-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star className="fill-brand-500 text-brand-500" style={{ width: size, height: size }} aria-hidden />
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Accessible 1-5 star input (radio group semantics, keyboard friendly). */
export function StarInput({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div role="radiogroup" aria-label="Rating" className="inline-flex gap-1" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={`${i} star${i > 1 ? 's' : ''}`}
          disabled={disabled}
          onMouseEnter={() => setHover(i)}
          onClick={() => onChange(i)}
          className="rounded p-1 focus:outline-none sm:p-0.5 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Star className={clsx('h-9 w-9 transition sm:h-7 sm:w-7', i <= shown ? 'fill-brand-500 text-brand-500' : 'text-slate-300')} aria-hidden />
        </button>
      ))}
    </div>
  );
}
