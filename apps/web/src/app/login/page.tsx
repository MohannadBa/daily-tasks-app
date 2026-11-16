'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
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
