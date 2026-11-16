'use client';
import { Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import { ALLOWED_EXTENSIONS, MAX_FILE_BYTES, validateFile } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { useT } from '@/lib/i18n';

/** Multi-file picker with client-side type/size validation (the API validates again). */
export function FilePicker({ files, onChange, onError, progress, disabled }: { files: File[]; onChange: (f: File[]) => void; onError: (msg: string | null) => void; progress?: number[]; disabled?: boolean }) {
  const { t } = useT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          const bad = picked.map(validateFile).find(Boolean);
          onError(bad ?? null);
          onChange([...files, ...picked.filter((f) => !validateFile(f))].slice(0, 10));
          e.target.value = '';
        }}
      />
      <button type="button" disabled={disabled} onClick={() => ref.current?.click()} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-900 lg:min-h-0">
        <Paperclip className="h-4 w-4" aria-hidden /> {t('Attach files')}
      </button>
      <span className="block text-xs text-slate-400 sm:ms-2 sm:inline">{t('Images, PDF, Office documents · up to {size} each', { size: formatBytes(MAX_FILE_BYTES) })}</span>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative overflow-hidden rounded-md bg-slate-50 text-sm">
              {progress?.[i] !== undefined && (
                <span className="absolute inset-y-0 start-0 bg-brand-100 transition-[width] duration-200" style={{ width: `${Math.round(progress[i]! * 100)}%` }} aria-hidden />
              )}
              <span className="relative flex items-center justify-between gap-2 py-1 ps-3 pe-1">
              <span className="min-w-0 truncate">
                {f.name} <span className="text-xs text-slate-500">({formatBytes(f.size)})</span>
                {progress?.[i] !== undefined && (
                  <span className="ms-2 text-xs font-medium tabular-nums text-brand-700" role="progressbar" aria-valuenow={Math.round(progress[i]! * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={t('Uploading {name}', { name: f.name })}>
                    {Math.round(progress[i]! * 100)}%
                  </span>
                )}
              </span>
              <button type="button" disabled={disabled} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-40" aria-label={t('Remove {name}', { name: f.name })} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <X className="h-4 w-4 text-slate-400 hover:text-slate-700" />
              </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
