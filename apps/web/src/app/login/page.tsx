'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { PASSWORD_RULE } from '@/components/password-change';
import Link from 'next/link';
import { AuthLayout } from '@/components/auth-layout';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<{ session: string; email: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useT();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (challenge) {
      if (!PASSWORD_RULE.test(newPassword)) return setError(t('At least 8 characters with upper- and lower-case letters and a number.'));
      if (newPassword !== confirmPassword) return setError(t('The new passwords do not match.'));
    }
    setLoading(true);
    try {
      const res = challenge
        ? await fetch('/session/new-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...challenge, newPassword }) })
        : await fetch('/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? t('Sign in failed'));
      if (data.status === 'NEW_PASSWORD_REQUIRED') {
        setChallenge({ session: data.session, email: data.email });
        setPassword(''); // the temporary password is not kept around
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
        <>
          <div role="status" className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">
            <p className="font-medium">{t('Welcome! Choose your own password')}</p>
            <p className="mt-1">{t('You signed in with a temporary password. Replace it now; you will use the new password from now on.')}</p>
          </div>
          <Field label={t('Choose a new password')} hint={t('At least 8 characters with upper- and lower-case letters and a number.')}>
            <Input type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <Field label={t('Confirm new password')}>
            <Input type="password" autoComplete="new-password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </Field>
        </>
      )}
      {!challenge && (
        <div className="-mt-1 flex justify-end">
          <Link href="/forgot-password" className="py-1 text-sm font-medium text-brand-700 hover:text-brand-800">
            {t('Forgot password?')}
          </Link>
        </div>
      )}
      <Button type="submit" loading={loading} className="min-h-12 w-full text-base sm:text-sm">
        {t(challenge ? 'Set password & sign in' : 'Sign in')}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  const { t } = useT();
  return (
    <AuthLayout title={t('Sign in to Al-Rasiyat')} subtitle={t('Your tasks, replies and deadlines in one place')}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthLayout>
  );
}
