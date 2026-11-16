import clsx from 'clsx';

/**
 * Official Al-Rasiyat mark (vector trace of the supplied logo, brand gold #C0903D).
 * `lockup` adds the "ALRASIYAT" line set in letter-spaced type, as in the official logo.
 */
export function Logo({ size = 40, lockup = false, className }: { size?: number; lockup?: boolean; className?: string }) {
  const height = Math.round((size * 1070) / 1380);
  return (
    <span className={clsx('inline-flex flex-col items-center', className)} role="img" aria-label="الراسيات · Al-Rasiyat">
      <img src="/brand/logo-mark.svg" width={size} height={height} alt="" aria-hidden className="select-none" draggable={false} />
      {lockup && (
        <span dir="ltr" className="mt-2 font-medium uppercase text-brand-500" style={{ fontSize: Math.max(9, size / 11), letterSpacing: '0.42em', marginInlineStart: '0.42em' }} aria-hidden>
          Alrasiyat
        </span>
      )}
    </span>
  );
}
