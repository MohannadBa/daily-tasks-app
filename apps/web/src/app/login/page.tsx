'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<{ session: string; email: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useT();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = challenge
        ? await fetch('/session/new-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...challenge, newPassword }) })
        : await fetch('/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? t('Sign in failed'));
      if (data.status === 'NEW_PASSWORD_REQUIRED') {
        setChallenge({ session: data.session, email: data.email });
        return;
      }
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <ErrorBox error={error} />}
      {!challenge ? (
        <>
          <Field label={t('Email')}>
            <Input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('Password')}>
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label={t('Choose a new password')} hint={t('At least 8 characters with upper, lower case and a number.')}>
          <Input type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </Field>
      )}
      <Button type="submit" loading={loading} className="min-h-12 w-full text-base sm:text-sm">
        {t(challenge ? 'Set password & sign in' : 'Sign in')}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  const { t, locale, setLocale } = useT();
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 pb-[env(safe-area-inset-bottom)] pt-[calc(4rem+env(safe-area-inset-top))] sm:pt-0">
      <button
        onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
        className="absolute end-4 top-[calc(1rem+env(safe-area-inset-top))] min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
      >
        {locale === 'ar' ? 'English' : 'العربية'}
      </button>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/icon.svg" alt="" className="mx-auto mb-3 h-14 w-14 rounded-2xl shadow-sm" />
          <h1 className="text-2xl font-semibold text-slate-900">{t('Sign in to DailyTasks')}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('Your tasks, replies and deadlines in one place')}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
