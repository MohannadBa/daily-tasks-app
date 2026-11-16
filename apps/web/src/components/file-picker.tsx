'use client';
import { Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import { ALLOWED_EXTENSIONS, MAX_FILE_BYTES, validateFile } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { useT } from '@/lib/i18n';

/** Multi-file picker with client-side type/size validation (the API validates again). */
export function FilePicker({ files, onChange, onError }: { files: File[]; onChange: (f: File[]) => void; onError: (msg: string | null) => void }) {
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
      <button type="button" onClick={() => ref.current?.click()} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-900">
        <Paperclip className="h-4 w-4" aria-hidden /> {t('Attach files')}
      </button>
      <span className="ms-2 text-xs text-slate-400">{t('Images, PDF, Office documents · up to {size} each', { size: formatBytes(MAX_FILE_BYTES) })}</span>
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-1.5 text-sm">
              <span className="truncate">
                {f.name} <span className="text-xs text-slate-400">({formatBytes(f.size)})</span>
              </span>
              <button type="button" aria-label={t('Remove {name}', { name: f.name })} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <X className="h-4 w-4 text-slate-400 hover:text-slate-700" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
