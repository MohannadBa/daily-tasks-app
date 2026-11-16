'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { IMAGE_PREVIEW_TYPES, openAttachment, openDocument } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { useT } from '@/lib/i18n';

export type PreviewSource = 'attachment' | 'document';
export interface PreviewImage {
  id: string;
  name: string;
  contentType: string;
  sizeBytes?: number;
}

export const isPreviewableImage = (contentType: string) => IMAGE_PREVIEW_TYPES.includes(contentType);

/**
 * Short-lived inline URL for an image (issued only after the server's access check). Pre-signed
 * URLs live 5 minutes, so the cached URL is refreshed after 4.
 */
function usePreviewUrl(source: PreviewSource, id: string, enabled = true) {
  return useQuery({
    queryKey: ['image-preview', source, id],
    queryFn: async () => (source === 'attachment' ? api.attachments.downloadUrl(id, true) : api.documents.downloadUrl(id, true)),
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
    enabled,
    retry: 1,
  });
}

/** Full-size in-app viewer with keyboard navigation between the images of the same list. */
function Lightbox({ source, images, index, onIndex, onClose }: { source: PreviewSource; images: PreviewImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t, dir } = useT();
  const img = images[index]!;
  const q = usePreviewUrl(source, img.id);
  const many = images.length > 1;
  const prev = useCallback(() => onIndex((index - 1 + images.length) % images.length), [index, images.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % images.length), [index, images.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Arrow keys follow reading direction (RTL: left = next).
      if (many && e.key === 'ArrowRight') (dir === 'rtl' ? prev : next)();
      if (many && e.key === 'ArrowLeft') (dir === 'rtl' ? next : prev)();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, many, prev, next, dir]);
  // Portal to <body>: an animated (transformed) ancestor would otherwise clip a position:fixed overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/95" role="dialog" aria-modal="true" aria-label={img.name}>
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 text-white">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {img.name}
          {many && <span className="ms-2 text-white/60">{t('{i} of {n}', { i: index + 1, n: images.length })}</span>}
        </p>
        <button
          onClick={() => void (source === 'attachment' ? openAttachment(img.id) : openDocument(img.id))}
          aria-label={t('Download')}
          className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10"
        >
          <Download className="h-5 w-5" aria-hidden />
        </button>
        <button onClick={onClose} aria-label={t('Close')} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10">
          <X className="h-6 w-6" aria-hidden />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onClick={onClose}>
        {q.data?.url ? (
          <img src={q.data.url} alt={img.name} className="dt-fade-in max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
        ) : q.isError ? (
          <p className="flex items-center gap-2 text-sm text-white/80">
            <ImageOff className="h-5 w-5" aria-hidden /> {t('Preview is not available for this file type.')}
          </p>
        ) : (
          <span className="dt-skeleton h-64 w-64 rounded-lg opacity-30" aria-label={t('Loading…')} />
        )}
        {many && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                prev();
              }}
              aria-label={t('Previous')}
              className="absolute start-2 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
            >
              <ChevronLeft className="h-6 w-6 rtl:-scale-x-100" aria-hidden />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                next();
              }}
              aria-label={t('Next')}
              className="absolute end-2 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
            >
              <ChevronRight className="h-6 w-6 rtl:-scale-x-100" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** One small square thumbnail; loads only when scrolled into view (native lazy loading). */
const SIZES = {
  icon: 'h-12 w-12',
  thumb: 'h-24 w-24 sm:h-28 sm:w-28',
  cover: 'h-36 w-full sm:h-40',
} as const;

export function ImageThumb({ source, image, onOpen, size = 'thumb', className }: { source: PreviewSource; image: PreviewImage; onOpen: () => void; size?: keyof typeof SIZES; className?: string }) {
  const { t } = useT();
  const q = usePreviewUrl(source, image.id);
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={image.sizeBytes ? `${image.name} · ${formatBytes(image.sizeBytes)}` : image.name}
      aria-label={t('Preview {name}', { name: image.name })}
      className={clsx(
        'group relative block shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 transition hover:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        SIZES[size],
        className,
      )}
    >
      {q.data?.url && !broken ? (
        <img src={q.data.url} alt={image.name} loading="lazy" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" />
      ) : q.isError || broken ? (
        <span className="flex h-full w-full items-center justify-center text-slate-400">
          <ImageOff className="h-6 w-6" aria-hidden />
        </span>
      ) : (
        <span className="dt-skeleton block h-full w-full" aria-hidden />
      )}
    </button>
  );
}

/** Grid of thumbnails with a shared lightbox (click to enlarge, arrows to browse). */
export function ImageGallery({ source, images, className }: { source: PreviewSource; images: PreviewImage[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <ul className={clsx('flex flex-wrap gap-2', className)}>
        {images.map((img, i) => (
          <li key={img.id}>
            <ImageThumb source={source} image={img} onOpen={() => setOpen(i)} />
          </li>
        ))}
      </ul>
      {open !== null && <Lightbox source={source} images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}
