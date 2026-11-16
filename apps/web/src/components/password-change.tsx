'use client';
import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, logout } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { errorText } from './feedback';
import { Logo } from './logo';
import { Button, ErrorBox, Field, Input } from './ui';

export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

/**
 * Change-password form. Values live only in component state (never in browser storage or logs)
 * and are cleared after submission.
 */
export function ChangePasswordForm({ onDone, submitLabel = 'Change password' }: { onDone: () => void; submitLabel?: string }) {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!PASSWORD_RULE.test(next)) return setError(t('At least 8 characters with upper- and lower-case letters and a number.'));
    if (next !== confirm) return setError(t('The new passwords do not match.'));
    if (next === current) return setError(t('Choose a password different from the current one.'));
    setSaving(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="space-y-4" onSubmit={submit} autoComplete="on">
      <ErrorBox error={error} />
      <Field label={t('Current (temporary) password')}>
        <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={t('New password')} hint={t('At least 8 characters with upper- and lower-case letters and a number.')}>
        <Input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={t('Confirm new password')}>
        <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" loading={saving} className="w-full">
        {t(submitLabel)}
      </Button>
    </form>
  );
}

/** Blocks the app until a temporary password is replaced (the API refuses other routes meanwhile). */
export function ForcedPasswordChange() {
  const { t } = useT();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--color-surface,#f7f5f2)] px-4 py-10">
      <div className="dt-fade-in w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={56} />
          <span className="mt-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <KeyRound className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-3 text-xl font-semibold text-slate-900">{t('Choose your own password')}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('Your account uses a temporary password. Set a new one to continue.')}</p>
        </div>
        <ChangePasswordForm onDone={() => window.location.replace('/')} submitLabel="Save and continue" />
        <button onClick={() => void logout()} className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-800">
          {t('Sign out')}
        </button>
      </div>
    </div>
  );
}
