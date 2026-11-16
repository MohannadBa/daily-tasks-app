'use client';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { Button } from './ui';

/* --------------------------------- Toasts --------------------------------- */

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface FeedbackApi {
  toast: (message: string, tone?: ToastTone) => void;
  /** Resolves true when the user confirms. Use only for destructive or irreversible actions. */
  confirm: (opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

const toneStyle: Record<ToastTone, { cls: string; Icon: typeof CheckCircle2 }> = {
  success: { cls: 'border-success-200 bg-white text-slate-900', Icon: CheckCircle2 },
  error: { cls: 'border-danger-200 bg-white text-slate-900', Icon: XCircle },
  info: { cls: 'border-slate-200 bg-white text-slate-900', Icon: Info },
};
const iconCls: Record<ToastTone, string> = { success: 'text-success-600', error: 'text-danger-600', info: 'text-brand-600' };

interface ConfirmState {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );
  const confirm = useCallback<FeedbackApi['confirm']>((opts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })), []);

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      {/* Above the mobile tab bar; logical inset so it sits on the reading side in RTL and LTR. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pe-6">
        {toasts.map((t) => {
          const { cls, Icon } = toneStyle[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={clsx('dt-toast pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg shadow-slate-900/5', cls)}>
              <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', iconCls[t.tone])} aria-hidden />
              <p className="min-w-0 flex-1 break-words">{t.message}</p>
              <ToastClose onClick={() => dismiss(t.id)} />
            </div>
          );
        })}
      </div>
      {confirmState && (
        <ConfirmDialog
          state={confirmState}
          onClose={(v) => {
            confirmState.resolve(v);
            setConfirmState(null);
          }}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function ToastClose({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button type="button" onClick={onClick} aria-label={t('Close')} className="-m-1 rounded p-1 text-slate-400 hover:text-slate-700">
      <X className="h-4 w-4" aria-hidden />
    </button>
  );
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: (v: boolean) => void }) {
  const { t } = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="alertdialog" aria-modal="true" aria-labelledby="dt-confirm-title">
      <div className="absolute inset-0 bg-slate-900/40" onClick={() => onClose(false)} />
      <div className="dt-toast relative w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <div className="flex gap-3">
          {state.danger && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-50 text-danger-600">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <h2 id="dt-confirm-title" className="font-semibold text-slate-900">
              {state.title}
            </h2>
            {state.message && <p className="mt-1 text-sm text-slate-600">{state.message}</p>}
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onClose(false)}>
            {t('Cancel')}
          </Button>
          <Button ref={confirmRef} variant={state.danger ? 'danger' : 'primary'} onClick={() => onClose(true)}>
            {state.confirmLabel ?? t('Confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  // Outside the provider (isolated component tests): no-op toast, native confirm.
  return ctx ?? { toast: () => undefined, confirm: async (o) => window.confirm(o.title) };
}

/** Error -> user-facing message (API messages are already human readable). */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
