'use client';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { useFeedback } from '@/components/feedback';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';

async function post(path: string, body: object) {
  const res = await fetch(`/bff/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  const msg = Array.isArray(data.message) ? data.message.join(' · ') : data.message;
  throw Object.assign(new Error(msg ?? 'Request failed'), { status: res.status });
}

/** Self-service password recovery (Cognito e-mails a verification code). */
export default function ForgotPasswordPage() {
  const { t } = useT();
  const router = useRouter();
  const { toast } = useFeedback();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (step === 'email') {
        await post('forgot-password', { email });
        setStep('code');
      } else {
        await post('reset-password', { email, code, newPassword: password });
        toast(t('Password changed. Sign in with your new password.'));
        router.replace('/login');
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 501 ? t('Password reset by e-mail is not available on this server. Ask an administrator to reset your password.') : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title={t('Reset your password')} subtitle={t(step === 'email' ? 'We will e-mail you a verification code.' : 'Enter the code from the e-mail and choose a new password.')}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox error={error} />}
        {step === 'email' ? (
          <Field label={t('Email')}>
            <Input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        ) : (
          <>
            <p className="flex items-start gap-2 rounded-lg bg-success-50 px-3 py-2.5 text-sm text-success-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t('If an account exists for {email}, a code is on its way.', { email })}
            </p>
            <Field label={t('Verification code')}>
              <Input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label={t('New password')} hint={t('At least 8 characters with upper, lower case and a number.')}>
              <Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        )}
        <Button type="submit" loading={loading} className="min-h-12 w-full text-base sm:text-sm">
          {t(step === 'email' ? 'Send code' : 'Change password')}
        </Button>
        <p className="text-center text-sm">
          <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
            {t('Back to sign in')}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
